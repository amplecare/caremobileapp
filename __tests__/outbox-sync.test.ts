/**
 * Drain loop tests.
 *
 * Uses a fake in-memory store and a scripted `send`, so every awkward
 * real-world sequence — losing signal mid-drain, the transport throwing, two
 * triggers firing at once — is reproducible in milliseconds.
 */

import { createSyncRunner, drainOnce, drainUntilIdle, type DrainDeps } from '../lib/outbox/sync';
import type { JobTransition, OutboxJob, SendOutcome } from '../lib/outbox/policy';

const NOW = 1_760_000_000_000;

function makeJob(over: Partial<OutboxJob> = {}): OutboxJob {
  return {
    id: 'j1',
    type: 'visit.note',
    streamKey: 'visit-1',
    payload: '{}',
    status: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: NOW - 1000,
    lastError: null,
    ...over,
  };
}

/** Minimal store that behaves like the SQLite one. */
function fakeStore(initial: OutboxJob[]) {
  let jobs = [...initial];
  return {
    jobs: () => jobs,
    loadJobs: async () => [...jobs],
    markSending: async (id: string) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, status: 'sending' as const } : j));
    },
    applyTransition: async (id: string, t: JobTransition) => {
      jobs = t.done
        ? jobs.filter((j) => j.id !== id)
        : jobs.map((j) =>
            j.id === id
              ? {
                  ...j,
                  status: t.status as OutboxJob['status'],
                  attempts: t.attempts,
                  nextAttemptAt: t.nextAttemptAt,
                  lastError: t.lastError,
                }
              : j,
          );
    },
  };
}

function deps(store: ReturnType<typeof fakeStore>, over: Partial<DrainDeps> = {}): DrainDeps {
  return {
    loadJobs: store.loadJobs,
    markSending: store.markSending,
    applyTransition: store.applyTransition,
    send: async () => ({ kind: 'success' }),
    isOnline: () => true,
    now: () => NOW,
    ...over,
  };
}

describe('drainOnce', () => {
  test('offline does nothing at all — no attempts, no state change', async () => {
    const store = fakeStore([makeJob()]);
    const r = await drainOnce(deps(store, { isOnline: () => false }));

    expect(r.attempted).toBe(0);
    expect(store.jobs()).toHaveLength(1);
  });

  test('a successful send removes the job', async () => {
    const store = fakeStore([makeJob()]);
    const r = await drainOnce(deps(store));

    expect(r.succeeded).toBe(1);
    expect(store.jobs()).toHaveLength(0);
  });

  test('a retryable failure keeps the job and schedules a backoff', async () => {
    const store = fakeStore([makeJob()]);
    await drainOnce(deps(store, { send: async () => ({ kind: 'retryable', error: '503' }) }));

    const [job] = store.jobs();
    expect(job!.attempts).toBe(1);
    expect(job!.nextAttemptAt).toBe(NOW + 2_000);
    expect(job!.status).toBe('queued');
  });

  /**
   * A thrown error means the request failed, never that the server rejected
   * the data — so it must not be treated as permanent and discarded.
   */
  test('a transport exception is treated as retryable, not fatal', async () => {
    const store = fakeStore([makeJob()]);
    await drainOnce(
      deps(store, {
        send: async () => {
          throw new Error('Network request failed');
        },
      }),
    );

    const [job] = store.jobs();
    expect(job).toBeDefined();
    expect(job!.status).toBe('queued');
    expect(job!.lastError).toBe('Network request failed');
  });

  test('a conflict parks the job for a human', async () => {
    const store = fakeStore([makeJob()]);
    await drainOnce(
      deps(store, { send: async () => ({ kind: 'conflict', error: 'row changed' }) }),
    );

    expect(store.jobs()[0]!.status).toBe('blocked');
  });

  /** Walking into a lift mid-drain must not burn retries on doomed requests. */
  test('losing signal mid-batch stops the drain immediately', async () => {
    const store = fakeStore([
      makeJob({ id: 'a', streamKey: 's1', createdAt: NOW - 3000 }),
      makeJob({ id: 'b', streamKey: 's2', createdAt: NOW - 2000 }),
      makeJob({ id: 'c', streamKey: 's3', createdAt: NOW - 1000 }),
    ]);

    let online = true;
    const r = await drainOnce(
      deps(store, {
        isOnline: () => online,
        send: async () => {
          online = false; // signal drops after the first request
          return { kind: 'success' };
        },
      }),
    );

    expect(r.attempted).toBe(1);
    expect(store.jobs()).toHaveLength(2); // the other two are untouched
  });

  test('jobs are sent sequentially, never in parallel', async () => {
    const store = fakeStore([
      makeJob({ id: 'a', streamKey: 's1', createdAt: NOW - 2000 }),
      makeJob({ id: 'b', streamKey: 's2', createdAt: NOW - 1000 }),
    ]);

    let concurrent = 0;
    let maxConcurrent = 0;

    await drainOnce(
      deps(store, {
        send: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 1));
          concurrent -= 1;
          return { kind: 'success' };
        },
      }),
    );

    expect(maxConcurrent).toBe(1);
  });

  test('ordering holds: a check-out waits for its check-in', async () => {
    const store = fakeStore([
      makeJob({ id: 'out', type: 'visit.check_out', createdAt: NOW - 1000 }),
      makeJob({ id: 'in', type: 'visit.check_in', createdAt: NOW - 5000 }),
    ]);

    const sent: string[] = [];
    await drainOnce(
      deps(store, {
        send: async (job) => {
          sent.push(job.id);
          return { kind: 'success' };
        },
      }),
    );

    expect(sent).toEqual(['in']); // same stream — only one per pass
  });

  test('reports hasMore when a batch limit leaves work behind', async () => {
    const store = fakeStore(
      Array.from({ length: 5 }, (_, i) =>
        makeJob({ id: `j${i}`, streamKey: `s${i}`, createdAt: NOW - i }),
      ),
    );

    const r = await drainOnce(
      deps(store, { batchSize: 2, send: async () => ({ kind: 'retryable', error: 'x' }) }),
    );

    expect(r.attempted).toBe(2);
    expect(r.hasMore).toBe(true);
  });
});

describe('drainUntilIdle', () => {
  test('empties a multi-stream queue across passes', async () => {
    const store = fakeStore(
      Array.from({ length: 7 }, (_, i) =>
        makeJob({ id: `j${i}`, streamKey: `s${i}`, createdAt: NOW - i }),
      ),
    );

    const r = await drainUntilIdle(deps(store, { batchSize: 2 }));

    expect(r.succeeded).toBe(7);
    expect(store.jobs()).toHaveLength(0);
  });

  test('drains a single stream in order, one job per pass', async () => {
    const store = fakeStore([
      makeJob({ id: 'a', createdAt: NOW - 3000 }),
      makeJob({ id: 'b', createdAt: NOW - 2000 }),
      makeJob({ id: 'c', createdAt: NOW - 1000 }),
    ]);

    const sent: string[] = [];
    await drainUntilIdle(
      deps(store, {
        send: async (job) => {
          sent.push(job.id);
          return { kind: 'success' };
        },
      }),
    );

    expect(sent).toEqual(['a', 'b', 'c']);
  });

  /** The failure mode that makes carers uninstall an app. */
  test('a permanently failing job cannot spin the loop forever', async () => {
    const store = fakeStore([makeJob()]);
    let calls = 0;

    await drainUntilIdle(
      deps(store, {
        send: async () => {
          calls += 1;
          return { kind: 'retryable', error: 'always fails' };
        },
        // Time never advances, so backoff never elapses.
        now: () => NOW,
      }),
    );

    expect(calls).toBeLessThanOrEqual(20);
  });
});

describe('createSyncRunner', () => {
  /**
   * Reconnecting fires several triggers at once — NetInfo reports a change
   * while the app also returns to the foreground. Two drains racing would read
   * the same rows and send the same job twice.
   */
  test('overlapping triggers join one drain instead of racing', async () => {
    const store = fakeStore([makeJob()]);
    let sends = 0;

    const runner = createSyncRunner(
      deps(store, {
        send: async () => {
          sends += 1;
          await new Promise((r) => setTimeout(r, 5));
          return { kind: 'success' };
        },
      }),
    );

    await Promise.all([runner.run(), runner.run(), runner.run()]);

    expect(sends).toBe(1);
  });

  test('reports whether a drain is in progress', async () => {
    const store = fakeStore([makeJob()]);
    const runner = createSyncRunner(deps(store));

    expect(runner.isRunning).toBe(false);
    const p = runner.run();
    expect(runner.isRunning).toBe(true);
    await p;
    expect(runner.isRunning).toBe(false);
  });

  test('a later trigger starts a fresh drain once the first finished', async () => {
    const store = fakeStore([makeJob({ id: 'a' })]);
    const runner = createSyncRunner(deps(store));

    await runner.run();
    expect(store.jobs()).toHaveLength(0);

    store.jobs().push(makeJob({ id: 'b', streamKey: 's2' }));
    await runner.run();
    expect(runner.isRunning).toBe(false);
  });
});
