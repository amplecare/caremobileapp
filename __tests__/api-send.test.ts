/**
 * Sender tests.
 *
 * A fake Supabase client records what each job type writes, so the column
 * mapping and the tenancy rules are checked without a network or a database.
 */

import { createSender, supportedJobTypes, type SendContext } from '../lib/api/send';
import type { JobType, OutboxJob } from '../lib/outbox/policy';

const ORG = 'org-1';
const CARER = 'carer-1';   // carers.id
const USER = 'user-1';     // users.id

interface Call {
  table: string;
  op: 'insert' | 'update';
  values: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

/** Minimal stand-in for the bits of the Supabase builder `send` touches. */
function fakeSupabase(error: unknown = null) {
  const calls: Call[] = [];

  const builder = (table: string) => ({
    insert(values: Record<string, unknown>) {
      calls.push({ table, op: 'insert', values, filters: [] });
      return Promise.resolve({ error });
    },
    update(values: Record<string, unknown>) {
      const call: Call = { table, op: 'update', values, filters: [] };
      calls.push(call);
      const chain = {
        eq(col: string, val: unknown) {
          call.filters.push([col, val]);
          return chain;
        },
        then: (resolve: (v: unknown) => void) => resolve({ error }),
      };
      return chain;
    },
  });

  return { calls, client: { from: builder } };
}

function ctxFor(error: unknown = null): { ctx: SendContext; calls: Call[] } {
  const { calls, client } = fakeSupabase(error);
  return {
    ctx: { supabase: client as never, organisationId: ORG, userId: USER, carerId: CARER },
    calls,
  };
}

function job(type: JobType, payload: unknown, id = 'job-uuid-1'): OutboxJob {
  return {
    id,
    type,
    streamKey: 'visit-1',
    payload: JSON.stringify(payload),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: null,
    createdAt: 1_760_000_000_000,
    lastError: null,
  };
}

describe('coverage', () => {
  test('every job type the outbox can queue has a handler', () => {
    const queueable: JobType[] = [
      'visit.check_in', 'visit.check_out', 'visit.task_toggle', 'visit.note',
      'visit.photo', 'medication.record', 'incident.create', 'message.send',
      'availability.update',
    ];
    for (const t of queueable) expect(supportedJobTypes).toContain(t);
  });
});

describe('tenancy and identity', () => {
  /**
   * A device is not a trusted source of tenancy. If the payload could set
   * organisation_id, a tampered build could write into another agency's
   * records — the exact thing RLS exists to prevent.
   */
  test('organisation_id comes from the session, never the payload', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(
      job('visit.note', { visitId: 'v1', text: 'ok', organisation_id: 'EVIL-ORG' }),
    );
    expect(calls[0]!.values.organisation_id).toBe(ORG);
  });

  test('carer_id comes from the session too', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'ok', carer_id: 'EVIL' }));
    expect(calls[0]!.values.carer_id).toBe(CARER);
  });

  /** The job id as primary key is what makes a retry safe. */
  test('inserts use the job id as the primary key', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'ok' }, 'the-key'));
    expect(calls[0]!.values.id).toBe('the-key');
  });
});

describe('column mapping', () => {
  test('a care note writes note_text, not "text"', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'Doris slept well' }));

    expect(calls[0]!.table).toBe('visit_notes');
    expect(calls[0]!.values.note_text).toBe('Doris slept well');
    expect(calls[0]!.values.visit_id).toBe('v1');
  });

  test('check-in updates the visit and is scoped to the org', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(
      job('visit.check_in', { visitId: 'v1', at: '2026-08-18T09:15:00Z', lat: 53.4, lng: -2.2, distanceM: 35 }),
    );

    const call = calls[0]!;
    expect(call.table).toBe('visits');
    expect(call.op).toBe('update');
    expect(call.values.status).toBe('in_progress');
    expect(call.values.actual_start).toBe('2026-08-18T09:15:00Z');
    expect(call.values.check_in_lat).toBe(53.4);
    expect(call.values.distance_from_client).toBe(35);
    expect(call.filters).toContainEqual(['organisation_id', ORG]);
  });

  /**
   * Check-in is an UPDATE, so there is no key collision to make a retry safe.
   * The status guard does that job instead: a late retry cannot drag a visit
   * the carer has already checked out of back to in_progress.
   */
  test('check-in only applies to a still-scheduled visit', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.check_in', { visitId: 'v1', at: 'now' }));
    expect(calls[0]!.filters).toContainEqual(['status', 'scheduled']);
  });

  test('check-out completes the visit', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.check_out', { visitId: 'v1', at: '2026-08-18T10:00:00Z' }));
    expect(calls[0]!.values.status).toBe('completed');
    expect(calls[0]!.values.actual_end).toBe('2026-08-18T10:00:00Z');
  });

  test('a medication record carries its outcome and refusal reason', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(
      job('medication.record', {
        medicationId: 'm1', visitId: 'v1', outcome: 'refused',
        at: '2026-08-18T09:30:00Z', refusalReason: 'Client asleep',
      }),
    );

    expect(calls[0]!.table).toBe('medication_administrations');
    expect(calls[0]!.values.outcome).toBe('refused');
    expect(calls[0]!.values.refusal_reason).toBe('Client asleep');
    // users.id, not carers.id — administered_by references users.
    expect(calls[0]!.values.administered_by).toBe(USER);
  });

  test('an incident opens as safeguarding when flagged', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(
      job('incident.create', {
        serviceUserId: 'su1', category: 'fall',
        description: 'Found on floor', isSafeguarding: true,
      }),
    );

    expect(calls[0]!.values.is_safeguarding).toBe(true);
    expect(calls[0]!.values.status).toBe('open');
    expect(calls[0]!.values.reported_by).toBe(USER);
  });

  test('optional fields become null rather than undefined', async () => {
    const { ctx, calls } = ctxFor();
    await createSender(ctx)(job('visit.check_out', { visitId: 'v1', at: 'now' }));
    expect(calls[0]!.values.check_out_lat).toBeNull();
  });
});

describe('outcomes', () => {
  test('no error is success', async () => {
    const { ctx } = ctxFor(null);
    expect(await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'x' }))).toEqual({
      kind: 'success',
    });
  });

  test('a duplicate key is success — the first attempt already landed', async () => {
    const { ctx } = ctxFor({ code: '23505', message: 'duplicate' });
    expect(
      (await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'x' }))).kind,
    ).toBe('success');
  });

  test('a server error is retryable', async () => {
    const { ctx } = ctxFor({ status: 503, message: 'unavailable' });
    expect(
      (await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'x' }))).kind,
    ).toBe('retryable');
  });

  test('a thrown transport error is retryable, never fatal', async () => {
    const ctx: SendContext = {
      supabase: {
        from: () => {
          throw new Error('Network request failed');
        },
      } as never,
      organisationId: ORG,
      userId: USER,
      carerId: CARER,
    };
    const outcome = await createSender(ctx)(job('visit.note', { visitId: 'v1', text: 'x' }));
    expect(outcome.kind).toBe('retryable');
  });

  /** A newer build queued something this version cannot send. */
  test('an unknown job type is permanent, not an infinite retry', async () => {
    const { ctx } = ctxFor();
    const outcome = await createSender(ctx)(job('nonsense.type' as JobType, {}));
    expect(outcome.kind).toBe('permanent');
  });

  test('a corrupt payload is permanent rather than retried forever', async () => {
    const { ctx } = ctxFor();
    const bad = { ...job('visit.note', {}), payload: '{not json' };
    expect((await createSender(ctx)(bad)).kind).toBe('permanent');
  });
});
