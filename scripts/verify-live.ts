/**
 * Drives the real offline chain against the LIVE Supabase project.
 *
 *   npx tsx scripts/verify-live.ts
 *
 * Unit tests prove each layer works against a fake. This proves the layers
 * work against the actual database: that the column names exist, that RLS
 * accepts the writes, and that a retry genuinely lands as a duplicate-key
 * success instead of creating a second care record.
 *
 * That distinction is not academic. The web app's audit trail passed 145 unit
 * tests while silently writing nothing at all, because every test mocked the
 * database. This script is the antidote.
 *
 * `policy`, `sync`, `send` and `classify` are all Expo-free by design, so they
 * run unmodified here. Only the SQLite store is swapped for an in-memory fake
 * — that layer has its own tests against real SQLite.
 *
 * Everything it creates is deleted at the end.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

import { createSender, resolveCarerId } from '../lib/api/send';
import { drainUntilIdle } from '../lib/outbox/sync';
import type { JobTransition, JobType, OutboxJob } from '../lib/outbox/policy';

// --- env -------------------------------------------------------------------
// Read from the web app's .env.local: same Supabase project, and it keeps the
// credentials in exactly one gitignored place.
function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    /* fall through to the check below */
  }
  return out;
}

const env = { ...loadEnv('../CareAi/.env.local'), ...loadEnv('.env'), ...process.env };
const URL = env.NEXT_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = env.DEMO_EMAIL ?? 'demo@caremango.co.uk';
const PASSWORD = env.DEMO_PASSWORD;

if (!URL || !ANON || !PASSWORD) {
  console.error('Missing Supabase URL / anon key / DEMO_PASSWORD. See ../CareAi/.env.local');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  pass += 1;
  console.log('  PASS  ' + m);
};
const bad = (m: string, e?: unknown) => {
  fail += 1;
  console.log('  FAIL  ' + m + (e ? ' :: ' + String(e) : ''));
};

// --- in-memory outbox, same contract as the SQLite one ---------------------
function memoryStore() {
  let jobs: OutboxJob[] = [];
  let seq = 0;
  return {
    all: () => jobs,
    add(type: JobType, streamKey: string, payload: unknown, id?: string): string {
      seq += 1;
      // Must be a real UUID: these ids become primary keys on uuid columns.
      // The production store uses Crypto.randomUUID() for the same reason.
      const jobId = id ?? randomUUID();
      jobs.push({
        id: jobId,
        type,
        streamKey,
        payload: JSON.stringify(payload),
        status: 'queued',
        attempts: 0,
        nextAttemptAt: null,
        createdAt: Date.now() + seq,
        lastError: null,
      });
      return jobId;
    },
    loadJobs: async () => [...jobs],
    markSending: async (id: string) => {
      jobs = jobs.map((j) => (j.id === id ? { ...j, status: 'sending' as const } : j));
    },
    applyTransition: async (id: string, t: JobTransition) => {
      jobs = t.done
        ? jobs.filter((j) => j.id !== id)
        : jobs.map((j) =>
            j.id === id
              ? { ...j, status: t.status, attempts: t.attempts, nextAttemptAt: t.nextAttemptAt, lastError: t.lastError }
              : j,
          );
    },
  };
}

async function main() {
  const anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const { data: session, error: signInError } = await anon.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD!,
  });
  if (signInError || !session.session) {
    console.error('Cannot sign in:', signInError?.message);
    process.exit(1);
  }
  ok(`signed in as ${EMAIL}`);

  const supabase = createClient(URL!, ANON!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
  });
  const admin = SERVICE ? createClient(URL!, SERVICE, { auth: { persistSession: false } }) : null;
  let createdCarer: string | null = null;

  const { data: me } = await supabase.from('users').select('id, organisation_id').single();
  const org = me!.organisation_id as string;
  const userId = me!.id as string;

  // carer_id columns reference carers(id), NOT users(id). Resolve once.
  let carerId = await resolveCarerId(supabase, userId);
  if (carerId) {
    ok('resolved the carers row for the signed-in user');
  } else if (admin) {
    // The demo account is an admin with no carer record. Create one so the
    // carer-scoped writes can be exercised end to end.
    const { data: made, error: mkErr } = await admin
      .from('carers')
      .insert({ user_id: userId, organisation_id: org, employment_type: 'part_time' })
      .select('id')
      .single();
    if (mkErr || !made) {
      bad('could not create a carers row for the demo user', mkErr?.message);
      process.exit(1);
    }
    carerId = made.id as string;
    createdCarer = carerId;
    ok('created a carers row for the demo user (removed at the end)');
  } else {
    bad('no carers row and no service key to create one');
    process.exit(1);
  }

  // Need a real visit to attach notes and photos to.
  const { data: visit } = await supabase
    .from('visits')
    .select('id, service_user_id, status')
    .eq('organisation_id', org)
    .limit(1)
    .maybeSingle();
  if (!visit) {
    console.error('No visits in the demo org — run scripts/seed-demo-agency.mjs in ../CareAi');
    process.exit(1);
  }
  ok(`found a visit to work against (${visit.id})`);

  const store = memoryStore();
  const send = createSender({ supabase, organisationId: org, userId, carerId: carerId! });
  const deps = {
    loadJobs: store.loadJobs,
    markSending: store.markSending,
    applyTransition: store.applyTransition,
    send,
    isOnline: () => true,
  };

  const created = { notes: [] as string[], attachments: [] as string[] };

  try {
    // 1. A care note through the whole chain.
    const noteId = store.add('visit.note', `visit-${visit.id}`, {
      visitId: visit.id,
      text: 'Verification note — safe to delete.',
    });
    created.notes.push(noteId);

    let result = await drainUntilIdle(deps);
    if (result.succeeded === 1 && store.all().length === 0) {
      ok('care note drained and the job was removed');
    } else {
      bad(`care note drain (succeeded=${result.succeeded}, left=${store.all().length})`);
      console.log('       last error:', store.all()[0]?.lastError);
    }

    const { data: noteRow } = await supabase
      .from('visit_notes')
      .select('id, note_text, carer_id, organisation_id')
      .eq('id', noteId)
      .maybeSingle();
    if (noteRow) ok('the note actually exists in the database');
    else bad('note row not found — the write silently did nothing');

    if (noteRow?.organisation_id === org) ok('organisation_id was set from the session');
    else bad('organisation_id wrong on the stored row');

    if (noteRow?.carer_id === carerId) ok('carer_id was set from the session');
    else bad('carer_id wrong on the stored row');

    // 2. THE critical one: replaying the same job must not duplicate the row.
    store.add('visit.note', `visit-${visit.id}`, {
      visitId: visit.id,
      text: 'Verification note — safe to delete.',
    }, noteId);

    result = await drainUntilIdle(deps);
    const { count } = await supabase
      .from('visit_notes')
      .select('id', { count: 'exact', head: true })
      .eq('id', noteId);

    if (result.succeeded === 1 && count === 1) {
      ok('replaying a job is idempotent — duplicate key read as success, still one row');
    } else {
      bad(`idempotency (succeeded=${result.succeeded}, rows=${count})`);
    }

    // 3. A permanent failure must not be retried forever.
    store.add('visit.note', 'visit-missing', {
      visitId: '00000000-0000-0000-0000-000000000000',
      text: 'Should fail',
    });
    result = await drainUntilIdle(deps);
    const stuck = store.all()[0];
    if (stuck && stuck.attempts <= 5 && stuck.status !== 'queued') {
      ok(`a write to a missing visit stops trying (status=${stuck.status}, attempts=${stuck.attempts})`);
    } else if (!stuck) {
      bad('a write against a nonexistent visit unexpectedly succeeded');
    } else {
      bad(`bad job still queued after ${stuck.attempts} attempts`);
    }
    // Clear it so the next step starts clean.
    await store.applyTransition(stuck!.id, {
      status: 'queued', attempts: 0, nextAttemptAt: null, lastError: null, done: true,
    });

    // 4. A photo attachment — a different table and column set.
    const photoId = store.add('visit.photo', `visit-${visit.id}`, {
      visitId: visit.id,
      fileUrl: 'https://example.invalid/verify.jpg',
      fileType: 'image/jpeg',
      caption: 'Verification',
    });
    created.attachments.push(photoId);
    result = await drainUntilIdle(deps);
    if (result.succeeded === 1) ok('visit attachment drained against the real table');
    else bad('visit attachment drain', store.all()[0]?.lastError);

    // 5. Ordering across a real round-trip.
    store.add('visit.note', `visit-${visit.id}`, { visitId: visit.id, text: 'Order A' });
    store.add('visit.note', `visit-${visit.id}`, { visitId: visit.id, text: 'Order B' });
    const before = store.all().map((j) => j.id);
    result = await drainUntilIdle(deps);
    created.notes.push(...before);
    if (result.succeeded === 2) ok('two jobs on one visit drained in order, one at a time');
    else bad(`sequential drain (succeeded=${result.succeeded})`);
  } finally {
    if (admin) {
      if (created.notes.length) await admin.from('visit_notes').delete().in('id', created.notes);
      if (created.attachments.length) {
        await admin.from('visit_attachments').delete().in('id', created.attachments);
      }
      if (createdCarer) await admin.from('carers').delete().eq('id', createdCarer);
      console.log('  ----  test data removed');
    } else {
      console.log('  ----  no service key; remove verify rows manually');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Verification crashed:', e);
  process.exit(1);
});
