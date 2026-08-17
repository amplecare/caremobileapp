import type { JobTransition, OutboxJob, SendOutcome } from './policy';
import { applyOutcome, selectBatch, summarise } from './policy';

/**
 * The drain loop — what turns a queue into delivered work.
 *
 * Everything it touches is injected. That is not ceremony: the alternative is
 * orchestration logic that can only be exercised on a physical phone with the
 * wifi switched off at the right moment, which means in practice it is never
 * exercised at all. Here the whole thing runs in Jest in milliseconds.
 *
 * `startSync` at the bottom wires the real SQLite and network implementations.
 */

export interface DrainDeps {
  loadJobs: () => Promise<OutboxJob[]>;
  markSending: (id: string) => Promise<void>;
  applyTransition: (id: string, t: JobTransition) => Promise<void>;
  /** Performs the actual API call. Must classify its own failures. */
  send: (job: OutboxJob) => Promise<SendOutcome>;
  isOnline: () => boolean;
  now?: () => number;
  batchSize?: number;
}

export interface DrainResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** True when eligible work remains — the caller should drain again. */
  hasMore: boolean;
}

/**
 * One pass over the queue.
 *
 * Jobs in a batch are sent SEQUENTIALLY, not with `Promise.all`. Parallelism
 * would be faster and wrong: `selectBatch` guarantees at most one job per
 * visit, but a carer on a 2G connection in a stairwell is better served by one
 * request completing than by six timing out together. Sequential also means a
 * mid-drain app suspension leaves at most one job in `sending`.
 */
export async function drainOnce(deps: DrainDeps): Promise<DrainResult> {
  const now = deps.now ?? Date.now;
  const result: DrainResult = { attempted: 0, succeeded: 0, failed: 0, hasMore: false };

  if (!deps.isOnline()) return result;

  const jobs = await deps.loadJobs();
  const batch = selectBatch(jobs, now(), true, deps.batchSize ?? 10);

  for (const job of batch) {
    // Re-check connectivity between jobs. A carer walking into a lift should
    // not burn four retry attempts on requests that cannot possibly land.
    if (!deps.isOnline()) break;

    await deps.markSending(job.id);
    result.attempted += 1;

    let outcome: SendOutcome;
    try {
      outcome = await deps.send(job);
    } catch (error) {
      // An exception from the transport is always retryable — a thrown error
      // tells us the request failed, never that the server rejected the data.
      outcome = {
        kind: 'retryable',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const transition = applyOutcome(job, outcome, now());
    await deps.applyTransition(job.id, transition);

    if (transition.done) result.succeeded += 1;
    else result.failed += 1;
  }

  // Anything left that could go now means the caller should come straight
  // back — a batch limit should not leave work sitting for a whole interval.
  const remaining = await deps.loadJobs();
  result.hasMore = selectBatch(remaining, now(), deps.isOnline(), 1).length > 0;

  return result;
}

/**
 * Drains repeatedly until nothing is eligible.
 *
 * Bounded by `maxPasses` so a job that somehow stays eligible after a failure
 * cannot spin the loop forever and flatten the battery — the exact failure
 * mode that makes carers uninstall an app.
 */
export async function drainUntilIdle(
  deps: DrainDeps,
  maxPasses = 20,
): Promise<DrainResult> {
  const total: DrainResult = { attempted: 0, succeeded: 0, failed: 0, hasMore: false };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const r = await drainOnce(deps);
    total.attempted += r.attempted;
    total.succeeded += r.succeeded;
    total.failed += r.failed;
    total.hasMore = r.hasMore;

    if (r.attempted === 0 || !r.hasMore) break;
  }

  return total;
}

/**
 * Guards against overlapping drains.
 *
 * Reconnecting often fires several triggers at once — NetInfo reports a state
 * change while the app simultaneously returns to the foreground. Two drains
 * racing would read the same rows before either marked them `sending`, and
 * send the same job twice. Idempotency keys make that survivable rather than
 * corrupting, but it still wastes a carer's data allowance.
 */
export function createSyncRunner(deps: DrainDeps) {
  let inFlight: Promise<DrainResult> | null = null;

  return {
    /** Runs a drain, or joins the one already running. */
    run(): Promise<DrainResult> {
      if (inFlight) return inFlight;
      inFlight = drainUntilIdle(deps).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get isRunning(): boolean {
      return inFlight !== null;
    },
  };
}

/** Convenience re-export so UI imports one module, not three. */
export { summarise };
