/**
 * Outbox policy tests.
 *
 * This is the code that decides whether a carer's work reaches the agency, so
 * it is tested harder than anything else in the app. Each test names the real
 * situation it protects against.
 */

import {
  MAX_ATTEMPTS,
  applyOutcome,
  backoffMs,
  isEligible,
  selectBatch,
  summarise,
  type OutboxJob,
} from '../lib/outbox/policy';

const NOW = 1_760_000_000_000;

function job(over: Partial<OutboxJob> = {}): OutboxJob {
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

describe('backoffMs', () => {
  test('first retry is quick, later ones back off', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(8_000);
    expect(backoffMs(3)).toBe(30_000);
    expect(backoffMs(4)).toBe(120_000);
    expect(backoffMs(5)).toBe(480_000);
  });

  test('never waits before the first attempt', () => {
    expect(backoffMs(0)).toBe(0);
  });

  test('clamps beyond the schedule rather than growing forever', () => {
    expect(backoffMs(99)).toBe(480_000);
  });
});

describe('isEligible', () => {
  test('offline blocks everything — the queue simply waits', () => {
    expect(isEligible(job(), NOW, false)).toBe(false);
  });

  test('a fresh job is eligible the moment there is signal', () => {
    expect(isEligible(job(), NOW, true)).toBe(true);
  });

  test('a job already in flight is not picked up twice', () => {
    expect(isEligible(job({ status: 'sending' }), NOW, true)).toBe(false);
  });

  test('a job still in backoff waits', () => {
    expect(isEligible(job({ nextAttemptAt: NOW + 5_000 }), NOW, true)).toBe(false);
  });

  test('backoff expiry makes it eligible again', () => {
    expect(isEligible(job({ nextAttemptAt: NOW - 1 }), NOW, true)).toBe(true);
  });

  test('a conflict is never auto-retried — a human must decide', () => {
    expect(isEligible(job({ status: 'blocked' }), NOW, true)).toBe(false);
  });

  test('an exhausted job stops trying', () => {
    expect(isEligible(job({ attempts: MAX_ATTEMPTS }), NOW, true)).toBe(false);
  });
});

describe('selectBatch — ordering', () => {
  /**
   * THE critical guarantee. If a check-out overtook its check-in, the visit
   * record would be nonsense and the agency would see a completed visit that
   * never started.
   */
  test('only the oldest job per visit is sent at a time', () => {
    const checkIn = job({ id: 'in', type: 'visit.check_in', createdAt: NOW - 5000 });
    const checkOut = job({ id: 'out', type: 'visit.check_out', createdAt: NOW - 1000 });

    const batch = selectBatch([checkOut, checkIn], NOW, true);

    expect(batch.map((j) => j.id)).toEqual(['in']);
  });

  test('a stream with a job in flight is skipped entirely', () => {
    const inFlight = job({ id: 'in', status: 'sending', createdAt: NOW - 5000 });
    const waiting = job({ id: 'out', createdAt: NOW - 1000 });

    expect(selectBatch([inFlight, waiting], NOW, true)).toEqual([]);
  });

  test('different visits proceed in parallel', () => {
    const a = job({ id: 'a', streamKey: 'visit-1', createdAt: NOW - 3000 });
    const b = job({ id: 'b', streamKey: 'visit-2', createdAt: NOW - 2000 });

    expect(selectBatch([a, b], NOW, true).map((j) => j.id).sort()).toEqual(['a', 'b']);
  });

  test('a stuck photo for one client cannot block another client', () => {
    const stuckPhoto = job({ id: 'photo', streamKey: 'visit-1', status: 'sending' });
    const urgentMed = job({ id: 'med', type: 'medication.record', streamKey: 'visit-9' });

    expect(selectBatch([stuckPhoto, urgentMed], NOW, true).map((j) => j.id)).toEqual(['med']);
  });

  test('oldest work goes first across streams', () => {
    const older = job({ id: 'older', streamKey: 's1', createdAt: NOW - 9000 });
    const newer = job({ id: 'newer', streamKey: 's2', createdAt: NOW - 1000 });

    expect(selectBatch([newer, older], NOW, true).map((j) => j.id)).toEqual(['older', 'newer']);
  });

  test('offline yields nothing at all', () => {
    expect(selectBatch([job(), job({ id: 'j2', streamKey: 's2' })], NOW, false)).toEqual([]);
  });

  test('respects the batch limit', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      job({ id: `j${i}`, streamKey: `s${i}`, createdAt: NOW - i }),
    );
    expect(selectBatch(many, NOW, true, 10)).toHaveLength(10);
  });
});

describe('applyOutcome', () => {
  test('success marks the job done so its row can go', () => {
    const t = applyOutcome(job(), { kind: 'success' }, NOW);
    expect(t.done).toBe(true);
    expect(t.lastError).toBeNull();
  });

  test('a retryable failure schedules a backoff and keeps the work', () => {
    const t = applyOutcome(job(), { kind: 'retryable', error: 'timeout' }, NOW);
    expect(t.status).toBe('queued');
    expect(t.attempts).toBe(1);
    expect(t.nextAttemptAt).toBe(NOW + 2_000);
    expect(t.done).toBe(false);
  });

  test('the last retryable failure surfaces to the carer but keeps the data', () => {
    const t = applyOutcome(
      job({ attempts: MAX_ATTEMPTS - 1 }),
      { kind: 'retryable', error: 'timeout' },
      NOW,
    );
    expect(t.status).toBe('failed');
    expect(t.done).toBe(false); // never discarded
  });

  test('a permanent failure stops immediately without burning retries', () => {
    const t = applyOutcome(job(), { kind: 'permanent', error: '400 bad payload' }, NOW);
    expect(t.status).toBe('failed');
    expect(t.nextAttemptAt).toBeNull();
    expect(t.done).toBe(false);
  });

  /**
   * Last-write-wins is wrong for care records. If the agency edited the visit
   * while the carer was offline, silently overwriting either side destroys
   * evidence.
   */
  test('a conflict parks for a human and is never auto-resolved', () => {
    const t = applyOutcome(job(), { kind: 'conflict', error: 'row changed' }, NOW);
    expect(t.status).toBe('blocked');
    expect(t.nextAttemptAt).toBeNull();
    expect(t.done).toBe(false);
    expect(t.lastError).toBe('row changed');
  });

  test('no outcome except success ever discards the job', () => {
    for (const outcome of [
      { kind: 'retryable', error: 'e' },
      { kind: 'permanent', error: 'e' },
      { kind: 'conflict', error: 'e' },
    ] as const) {
      expect(applyOutcome(job(), outcome, NOW).done).toBe(false);
    }
  });
});

describe('summarise — what the carer sees', () => {
  test('an empty queue reads "all sent"', () => {
    expect(summarise([])).toEqual({ state: 'synced', count: 0 });
  });

  test('queued work reads as waiting, not as an error', () => {
    expect(summarise([job(), job({ id: 'j2' })])).toEqual({ state: 'pending', count: 2 });
  });

  test('anything failed or blocked takes precedence over a large pending count', () => {
    const jobs = [job(), job({ id: 'j2' }), job({ id: 'j3', status: 'failed' })];
    expect(summarise(jobs)).toEqual({ state: 'failed', count: 1 });
  });

  test('blocked conflicts count as needing attention', () => {
    expect(summarise([job({ status: 'blocked' })])).toEqual({ state: 'failed', count: 1 });
  });
});
