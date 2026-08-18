import type { SupabaseClient } from '@supabase/supabase-js';

import type { JobType, OutboxJob, SendOutcome } from '../outbox/policy';
import { classify, type ApiFailure } from './classify';

/**
 * Turns a queued outbox job into the API call that delivers it.
 *
 * The last link in the offline chain: policy decides *when* to send, the drain
 * loop decides *what*, and this decides *how*.
 *
 * Two rules hold for every handler here:
 *
 *   1. `organisation_id` is NEVER taken from the payload. It comes from the
 *      caller's session. A device is not a trusted source of tenancy — if it
 *      were, a tampered app could write into another agency's records.
 *   2. Every insert carries the job's `id` as its primary key. That is what
 *      makes a retry after a lost response safe: the second attempt collides
 *      on the key, PostgREST returns 23505, and `classify` reads that as
 *      success rather than creating a duplicate care record.
 *
 * Column names below are taken from the live schema, not from memory —
 * `visit_notes.note_text`, `medication_administrations.outcome`, and so on.
 */

/**
 * Two identities, and they are NOT interchangeable.
 *
 * The schema separates the login from the employment record:
 *   users  — the auth identity. `administered_by`, `reported_by`,
 *            `witnessed_by`, `sender_id` all reference this.
 *   carers — the employment record, joined by `carers.user_id`. Every
 *            `carer_id` column in the schema references THIS, not users.
 *
 * Sending a users.id where a carers.id belongs is a foreign-key violation on
 * the very first care note. Live verification caught exactly that; unit tests
 * against a fake client never could.
 */
export interface SendContext {
  supabase: SupabaseClient;
  organisationId: string;
  /** `users.id` — the signed-in auth identity. */
  userId: string;
  /** `carers.id` — the employment record. Resolve once via `resolveCarerId`. */
  carerId: string;
}

/**
 * Looks up the `carers` row for a signed-in user.
 *
 * Called once after sign-in and cached for the session: it never changes while
 * a carer is logged in, and the offline queue must not depend on a lookup that
 * needs the network.
 *
 * Returns null for a user with no carer record — an office-only coordinator,
 * for instance. The UI should refuse to queue carer-scoped work in that case
 * rather than let the job fail at the database.
 */
export async function resolveCarerId(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('carers')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

/** Payload shapes, one per job type. Parsed from the job's JSON payload. */
export interface Payloads {
  'visit.check_in': { visitId: string; at: string; lat?: number; lng?: number; distanceM?: number; reason?: string };
  'visit.check_out': { visitId: string; at: string; lat?: number; lng?: number };
  'visit.task_toggle': { visitId: string; taskId: string; completed: boolean; notes?: string; at: string };
  'visit.note': { visitId: string; text: string; transcribed?: boolean; concerns?: string[] };
  'visit.photo': { visitId: string; fileUrl: string; fileType: string; caption?: string };
  'medication.record': { medicationId: string; visitId: string; outcome: string; at: string; scheduledTime?: string; refusalReason?: string; notes?: string; witnessedBy?: string };
  'incident.create': { serviceUserId: string; category: string; description: string; isSafeguarding?: boolean; immediateAction?: string };
  'message.send': { body: string; visitId?: string };
  'availability.update': { dayOfWeek: string; startTime: string; endTime: string; effectiveFrom: string };
}

type Handler = (
  ctx: SendContext,
  job: OutboxJob,
  payload: Record<string, unknown>,
) => Promise<{ error: ApiFailure | null }>;

const handlers: Record<JobType, Handler> = {
  /**
   * Check-in updates the existing visit rather than inserting, so there is no
   * id collision to rely on. It is naturally idempotent instead: writing the
   * same `actual_start` twice is harmless, and the guard below stops a late
   * retry from resurrecting a visit the carer has already checked out of.
   */
  'visit.check_in': async (ctx, _job, p) => {
    const { error } = await ctx.supabase
      .from('visits')
      .update({
        actual_start: p.at as string,
        status: 'in_progress',
        check_in_lat: (p.lat as number) ?? null,
        check_in_lng: (p.lng as number) ?? null,
        distance_from_client: (p.distanceM as number) ?? null,
      })
      .eq('id', p.visitId as string)
      .eq('organisation_id', ctx.organisationId)
      .eq('status', 'scheduled');
    return { error };
  },

  'visit.check_out': async (ctx, _job, p) => {
    const { error } = await ctx.supabase
      .from('visits')
      .update({
        actual_end: p.at as string,
        status: 'completed',
        check_out_lat: (p.lat as number) ?? null,
        check_out_lng: (p.lng as number) ?? null,
      })
      .eq('id', p.visitId as string)
      .eq('organisation_id', ctx.organisationId);
    return { error };
  },

  'visit.task_toggle': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('visit_task_completions').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      visit_id: p.visitId as string,
      task_id: p.taskId as string,
      completed: Boolean(p.completed),
      notes: (p.notes as string) ?? null,
      completed_at: p.at as string,
    });
    return { error };
  },

  'visit.note': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('visit_notes').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      visit_id: p.visitId as string,
      carer_id: ctx.carerId,
      note_text: p.text as string,
      ai_transcribed: Boolean(p.transcribed),
      concerns: (p.concerns as string[]) ?? [],
    });
    return { error };
  },

  'visit.photo': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('visit_attachments').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      visit_id: p.visitId as string,
      carer_id: ctx.carerId,
      file_url: p.fileUrl as string,
      file_type: p.fileType as string,
      caption: (p.caption as string) ?? null,
    });
    return { error };
  },

  'medication.record': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('medication_administrations').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      medication_id: p.medicationId as string,
      visit_id: p.visitId as string,
      administered_at: p.at as string,
      scheduled_time: (p.scheduledTime as string) ?? null,
      administered_by: ctx.userId,
      outcome: p.outcome as string,
      refusal_reason: (p.refusalReason as string) ?? null,
      notes: (p.notes as string) ?? null,
      witnessed_by: (p.witnessedBy as string) ?? null,
    });
    return { error };
  },

  'incident.create': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('incidents').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      service_user_id: p.serviceUserId as string,
      reported_by: ctx.userId,
      category: p.category as string,
      description: p.description as string,
      is_safeguarding: Boolean(p.isSafeguarding),
      immediate_action: (p.immediateAction as string) ?? null,
      status: 'open',
    });
    return { error };
  },

  'message.send': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('family_messages').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      sender_id: ctx.userId,
      body: p.body as string,
    });
    return { error };
  },

  'availability.update': async (ctx, job, p) => {
    const { error } = await ctx.supabase.from('carer_availability').insert({
      id: job.id,
      organisation_id: ctx.organisationId,
      carer_id: ctx.carerId,
      day_of_week: p.dayOfWeek as string,
      start_time: p.startTime as string,
      end_time: p.endTime as string,
      effective_from: p.effectiveFrom as string,
    });
    return { error };
  },
};

/**
 * Sends one job. Plugs straight into `DrainDeps.send`.
 *
 * Never throws: the drain loop treats an exception as retryable, which is the
 * right default, but returning a classified outcome gives better decisions —
 * a 400 should stop immediately rather than burn five attempts.
 */
export function createSender(ctx: SendContext) {
  return async function send(job: OutboxJob): Promise<SendOutcome> {
    const handler = handlers[job.type];
    if (!handler) {
      // An unknown type means a newer app version queued something this build
      // cannot send. Permanent: retrying will never teach it the handler.
      return { kind: 'permanent', error: `No handler for job type "${job.type}"` };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(job.payload) as Record<string, unknown>;
    } catch {
      return { kind: 'permanent', error: 'Job payload is not valid JSON' };
    }

    try {
      const { error } = await handler(ctx, job, payload);
      return classify(error);
    } catch (error) {
      return {
        kind: 'retryable',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

/** Exposed for tests and for the "unsupported job" guard in the UI. */
export const supportedJobTypes = Object.keys(handlers) as JobType[];
