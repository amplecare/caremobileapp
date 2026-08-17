import type { SendOutcome } from '../outbox/policy';

/**
 * Turns whatever the server (or the network stack) returned into one of four
 * outcomes the outbox understands.
 *
 * This is small and boring and it is the most dangerous code in the app. Every
 * misclassification has a cost:
 *
 *   retryable misread as permanent → a carer's note is abandoned after one
 *     blip and never sent. Silent data loss.
 *   permanent misread as retryable → five pointless retries on a payload the
 *     server will never accept, burning battery and mobile data.
 *   conflict misread as either      → the agency's edit or the carer's edit is
 *     destroyed without anyone being told.
 *
 * The default, when we genuinely cannot tell, is **retryable**. Keeping work
 * and trying again is always recoverable; discarding it is not.
 */

/** Shape shared by PostgREST errors and fetch failures. */
export interface ApiFailure {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * PostgREST error codes worth special handling.
 *  23505 unique_violation — the idempotency key already landed, so the work is
 *        already done. Treated as SUCCESS, not failure: the first attempt got
 *        through and only its response was lost.
 *  23503 foreign_key_violation — the parent row is gone (visit deleted by the
 *        agency). Retrying cannot fix it.
 *  42501 insufficient_privilege — RLS refused. Also unfixable by retrying.
 */
const DUPLICATE = '23505';
const FK_VIOLATION = '23503';
const RLS_DENIED = '42501';

export function classify(failure: ApiFailure | null | undefined): SendOutcome {
  if (!failure) return { kind: 'success' };

  const message = failure.message ?? 'Unknown error';
  const { status, code } = failure;

  // The request already succeeded once; the response just never arrived.
  // This is precisely what the idempotency key exists to make safe.
  if (code === DUPLICATE) return { kind: 'success' };

  if (code === FK_VIOLATION || code === RLS_DENIED) {
    return { kind: 'permanent', error: message };
  }

  // 409 is the server telling us the row moved under us. Never auto-resolve:
  // last-write-wins would silently destroy one side of a care record.
  if (status === 409 || code === 'PGRST116') {
    return { kind: 'conflict', error: message };
  }

  if (typeof status === 'number') {
    // 401/403 usually mean an expired token. The session refresh runs
    // separately, so this is worth another attempt shortly.
    if (status === 401 || status === 403) return { kind: 'retryable', error: message };

    // 408 timeout and 429 rate-limit are explicitly "come back later".
    if (status === 408 || status === 429) return { kind: 'retryable', error: message };

    // Everything else in 4xx is the client's fault and will not improve.
    if (status >= 400 && status < 500) return { kind: 'permanent', error: message };

    // 5xx is the server having a bad day.
    if (status >= 500) return { kind: 'retryable', error: message };
  }

  // No status at all means the request never reached a server — DNS failure,
  // aeroplane mode, a dead cell. Always worth retrying.
  return { kind: 'retryable', error: message };
}
