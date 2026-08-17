/**
 * Outbox policy — the decisions, with no database and no network.
 *
 * Every rule about *when* a queued job may be sent, in what order, and when to
 * stop trying lives here as a pure function. The SQLite and HTTP layers call
 * into it. That split exists so this logic can be tested exhaustively on a
 * laptop: it is the part that, if wrong, silently loses a carer's work.
 *
 * The rules encode hard-won constraints from the plan:
 *   - FIFO per client, so a check-out can never overtake its check-in
 *   - idempotency keys, so a retry after a timeout cannot duplicate a record
 *   - exponential backoff, so a flapping connection does not hammer the API
 *   - jobs NEVER expire — a note waits a week if it must
 */

/** Every mutation a carer can make offline. */
export type JobType =
  | 'visit.check_in'
  | 'visit.check_out'
  | 'visit.task_toggle'
  | 'visit.note'
  | 'visit.photo'
  | 'medication.record'
  | 'incident.create'
  | 'message.send'
  | 'availability.update';

export type JobStatus = 'queued' | 'sending' | 'failed' | 'blocked';

export interface OutboxJob {
  /** Client-generated UUID. Doubles as the idempotency key. */
  id: string;
  type: JobType;
  /** Groups jobs that must stay in order relative to each other. */
  streamKey: string;
  payload: string;
  status: JobStatus;
  attempts: number;
  /** Epoch ms. Null means "eligible now". */
  nextAttemptAt: number | null;
  /** Device clock at creation. Server records its own receipt time. */
  createdAt: number;
  lastError: string | null;
}

/**
 * Attempts before a job stops retrying automatically and is surfaced to the
 * carer as "needs attention".
 *
 * It is NOT deleted at this point, and never is. Failing loudly and keeping
 * the data is the only acceptable outcome for a clinical record.
 */
export const MAX_ATTEMPTS = 5;

/** 2s, 8s, 30s, 2m, 8m — then stop and ask a human. */
const BACKOFF_SCHEDULE_MS = [2_000, 8_000, 30_000, 120_000, 480_000];

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Deterministic rather than jittered: a single device is not a thundering
 * herd, and predictable timing is far easier to reason about when a carer
 * rings the office asking why something has not arrived.
 */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const i = Math.min(attempts, BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[i]!;
}

/** True when this job may be attempted right now. */
export function isEligible(job: OutboxJob, now: number, online: boolean): boolean {
  if (!online) return false;
  if (job.status === 'sending') return false;
  // `blocked` means a conflict a human must resolve; retrying would not help.
  if (job.status === 'blocked') return false;
  if (job.attempts >= MAX_ATTEMPTS) return false;
  if (job.nextAttemptAt !== null && job.nextAttemptAt > now) return false;
  return true;
}

/**
 * Picks the jobs to send, in order.
 *
 * The ordering rule is the important part. Jobs are grouped by `streamKey`
 * (normally the visit id) and **only the oldest eligible job per stream is
 * returned**. Two jobs from the same visit are never in flight at once, so a
 * check-out cannot arrive before its check-in even if the first request is
 * slow. Different visits proceed in parallel — a stuck photo upload for one
 * client must not hold up another client's medication record.
 */
export function selectBatch(
  jobs: OutboxJob[],
  now: number,
  online: boolean,
  limit = 10,
): OutboxJob[] {
  const oldestPerStream = new Map<string, OutboxJob>();

  for (const job of jobs) {
    // A stream with anything in flight is skipped entirely, even if a later
    // job in it is eligible — that is what preserves order.
    if (job.status === 'sending') {
      oldestPerStream.set(job.streamKey, job);
      continue;
    }
    const held = oldestPerStream.get(job.streamKey);
    if (held && (held.status === 'sending' || held.createdAt <= job.createdAt)) continue;
    oldestPerStream.set(job.streamKey, job);
  }

  return [...oldestPerStream.values()]
    .filter((job) => isEligible(job, now, online))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit);
}

/** What the server said, reduced to what the queue needs to know. */
export type SendOutcome =
  | { kind: 'success' }
  /** 5xx, timeout, DNS failure — worth trying again. */
  | { kind: 'retryable'; error: string }
  /** 4xx that will never succeed — bad payload, deleted parent row. */
  | { kind: 'permanent'; error: string }
  /** The server row changed underneath us. A human must decide. */
  | { kind: 'conflict'; error: string };

export interface JobTransition {
  status: JobStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  /** True when the job is finished and its row can be removed. */
  done: boolean;
}

/**
 * The state machine. Given a job and what happened, what does it become?
 *
 * Conflicts deliberately do NOT retry and do NOT delete. Last-write-wins is
 * wrong for care records: if the agency edited the same visit while the carer
 * was offline, silently overwriting either version destroys evidence. The job
 * parks as `blocked` and surfaces for a human to resolve.
 */
export function applyOutcome(
  job: OutboxJob,
  outcome: SendOutcome,
  now: number,
): JobTransition {
  const attempts = job.attempts + 1;

  switch (outcome.kind) {
    case 'success':
      return { status: 'queued', attempts, nextAttemptAt: null, lastError: null, done: true };

    case 'conflict':
      return {
        status: 'blocked',
        attempts,
        nextAttemptAt: null,
        lastError: outcome.error,
        done: false,
      };

    case 'permanent':
      return {
        status: 'failed',
        attempts: MAX_ATTEMPTS,
        nextAttemptAt: null,
        lastError: outcome.error,
        done: false,
      };

    case 'retryable': {
      const exhausted = attempts >= MAX_ATTEMPTS;
      return {
        status: exhausted ? 'failed' : 'queued',
        attempts,
        nextAttemptAt: exhausted ? null : now + backoffMs(attempts),
        lastError: outcome.error,
        done: false,
      };
    }
  }
}

/** What the SyncBadge shows. Derived, never stored. */
export function summarise(jobs: OutboxJob[]): {
  state: 'synced' | 'pending' | 'failed';
  count: number;
} {
  const needsAttention = jobs.filter(
    (j) => j.status === 'failed' || j.status === 'blocked',
  ).length;
  if (needsAttention > 0) return { state: 'failed', count: needsAttention };
  if (jobs.length > 0) return { state: 'pending', count: jobs.length };
  return { state: 'synced', count: 0 };
}
