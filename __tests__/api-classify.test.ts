/**
 * Error classification tests.
 *
 * Small, boring, and the most dangerous code in the app: every
 * misclassification either loses a carer's work or destroys one side of a care
 * record. Each test names the real failure it guards against.
 */

import { classify } from '../lib/api/classify';

describe('classify', () => {
  test('no failure is success', () => {
    expect(classify(null)).toEqual({ kind: 'success' });
    expect(classify(undefined)).toEqual({ kind: 'success' });
  });

  /**
   * The idempotency key doing its job. The first attempt reached the server
   * and only the response was lost; the retry hits the unique constraint. That
   * is success, not failure — treating it as an error would leave the job
   * queued forever, retrying work that is already done.
   */
  test('a duplicate key means the work already landed — success', () => {
    expect(classify({ code: '23505', message: 'duplicate key' })).toEqual({
      kind: 'success',
    });
  });

  describe('never retried — retrying cannot help', () => {
    test('the parent visit was deleted by the agency', () => {
      expect(classify({ code: '23503', message: 'FK violation' }).kind).toBe('permanent');
    });

    test('RLS refused the write', () => {
      expect(classify({ code: '42501', message: 'insufficient privilege' }).kind).toBe(
        'permanent',
      );
    });

    test('a malformed payload the server will never accept', () => {
      expect(classify({ status: 400, message: 'bad request' }).kind).toBe('permanent');
      expect(classify({ status: 422, message: 'unprocessable' }).kind).toBe('permanent');
    });

    test('a 404 on the endpoint', () => {
      expect(classify({ status: 404, message: 'not found' }).kind).toBe('permanent');
    });
  });

  describe('always retried — the work is still good', () => {
    test('server errors', () => {
      for (const status of [500, 502, 503, 504]) {
        expect(classify({ status, message: 'server error' }).kind).toBe('retryable');
      }
    });

    /**
     * An expired token is the single most common cause of a 401 in a
     * long-lived mobile session. Discarding a care note because the refresh
     * had not run yet would be indefensible.
     */
    test('auth failures, which are usually just an expired token', () => {
      expect(classify({ status: 401, message: 'JWT expired' }).kind).toBe('retryable');
      expect(classify({ status: 403, message: 'forbidden' }).kind).toBe('retryable');
    });

    test('explicit come-back-later responses', () => {
      expect(classify({ status: 408, message: 'timeout' }).kind).toBe('retryable');
      expect(classify({ status: 429, message: 'rate limited' }).kind).toBe('retryable');
    });

    test('the request never reached a server at all', () => {
      expect(classify({ message: 'Network request failed' }).kind).toBe('retryable');
    });
  });

  /**
   * Last-write-wins is wrong for a care record. If the agency edited the visit
   * while the carer was offline, silently overwriting either version destroys
   * evidence, so a conflict parks for a human.
   */
  describe('conflicts park for a human', () => {
    test('a 409 from the server', () => {
      expect(classify({ status: 409, message: 'row changed' })).toEqual({
        kind: 'conflict',
        error: 'row changed',
      });
    });

    test('PostgREST PGRST116', () => {
      expect(classify({ code: 'PGRST116', message: 'no rows' }).kind).toBe('conflict');
    });
  });

  describe('safety net', () => {
    /** When we cannot tell, keep the work. Retrying is recoverable; binning is not. */
    test('an unrecognised failure defaults to retryable', () => {
      expect(classify({ message: 'something odd' }).kind).toBe('retryable');
      expect(classify({}).kind).toBe('retryable');
    });

    test('the message always survives for the carer-facing error list', () => {
      const outcome = classify({ status: 500, message: 'upstream exploded' });
      expect(outcome.kind !== 'success' && outcome.error).toBe('upstream exploded');
    });

    test('a missing message never produces undefined in the UI', () => {
      const outcome = classify({ status: 500 });
      expect(outcome.kind !== 'success' && outcome.error).toBe('Unknown error');
    });

    /** A PostgREST code must win over a misleading HTTP status. */
    test('an error code takes precedence over the status', () => {
      expect(classify({ status: 400, code: '23505', message: 'dup' }).kind).toBe('success');
    });
  });
});
