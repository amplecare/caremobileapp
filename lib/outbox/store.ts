import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

import type { JobType, OutboxJob } from './policy';

/**
 * SQLite persistence for the outbox.
 *
 * SQLite is the source of truth for the UI; the server is where it eventually
 * agrees. Every mutation a carer makes writes the optimistic local change and
 * its outbox job in ONE transaction, so the two can never disagree — the app
 * cannot show a saved note that has no job to deliver it, or a job for a note
 * that was never written.
 *
 * The database survives app kill, force-quit and reboot. Nothing here has a
 * TTL: a job waits a week if that is how long the carer is without signal.
 */

const DB_NAME = 'amplecare.db';

let db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync(DB_NAME);
  await migrate(db);
  return db;
}

/**
 * Schema.
 *
 * `user_version` drives migrations — the standard SQLite mechanism, so we can
 * add tables in later stages without a migration library.
 *
 * WAL is on because a drain running in the background must not block the UI
 * thread reading the schedule.
 */
async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync('PRAGMA journal_mode = WAL;');

  const row = await database.getFirstAsync<{ user_version: number }>(
    'PRAGMA user_version;',
  );
  const version = row?.user_version ?? 0;

  if (version < 1) {
    await database.execAsync(`
      CREATE TABLE IF NOT EXISTS outbox (
        id             TEXT PRIMARY KEY NOT NULL,
        type           TEXT NOT NULL,
        stream_key     TEXT NOT NULL,
        payload        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'queued',
        attempts       INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        created_at     INTEGER NOT NULL,
        last_error     TEXT
      );

      -- Drains read by stream and creation order on every pass.
      CREATE INDEX IF NOT EXISTS idx_outbox_stream ON outbox(stream_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

      -- Read-through cache of the carer's schedule so TODAY paints instantly
      -- from disk, before any network call.
      CREATE TABLE IF NOT EXISTS visits (
        id             TEXT PRIMARY KEY NOT NULL,
        client_name    TEXT NOT NULL,
        address        TEXT,
        visit_type     TEXT,
        scheduled_start TEXT NOT NULL,
        scheduled_end   TEXT NOT NULL,
        status         TEXT NOT NULL,
        synced_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_visits_start ON visits(scheduled_start);

      PRAGMA user_version = 1;
    `);
  }
}

/** Row shape as SQLite returns it. */
interface OutboxRow {
  id: string;
  type: string;
  stream_key: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  last_error: string | null;
}

const toJob = (r: OutboxRow): OutboxJob => ({
  id: r.id,
  type: r.type as JobType,
  streamKey: r.stream_key,
  payload: r.payload,
  status: r.status as OutboxJob['status'],
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at,
  lastError: r.last_error,
});

/**
 * Queues a mutation.
 *
 * The returned id is the **idempotency key**. It is generated here, on the
 * device, before the first attempt — which is what makes a retry after a
 * network timeout safe. If the first request actually reached the server and
 * only the response was lost, the server recognises the key and returns the
 * original result instead of creating a second visit record.
 *
 * `localWrite` runs inside the same transaction as the job insert. Pass the
 * optimistic UI update here so the two are atomic.
 */
export async function enqueue(
  type: JobType,
  streamKey: string,
  payload: unknown,
  localWrite?: (tx: SQLite.SQLiteDatabase) => Promise<void>,
): Promise<string> {
  const database = await getDb();
  const id = Crypto.randomUUID();
  const now = Date.now();

  await database.withTransactionAsync(async () => {
    if (localWrite) await localWrite(database);
    await database.runAsync(
      `INSERT INTO outbox (id, type, stream_key, payload, status, attempts, next_attempt_at, created_at, last_error)
       VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, NULL)`,
      id,
      type,
      streamKey,
      JSON.stringify(payload),
      now,
    );
  });

  return id;
}

/** Everything still owed to the server, oldest first. */
export async function allJobs(): Promise<OutboxJob[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<OutboxRow>(
    'SELECT * FROM outbox ORDER BY created_at ASC',
  );
  return rows.map(toJob);
}

export async function markSending(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync("UPDATE outbox SET status = 'sending' WHERE id = ?", id);
}

/** Applies a policy transition. `done` removes the row; nothing else does. */
export async function applyTransition(
  id: string,
  t: { status: string; attempts: number; nextAttemptAt: number | null; lastError: string | null; done: boolean },
): Promise<void> {
  const database = await getDb();
  if (t.done) {
    await database.runAsync('DELETE FROM outbox WHERE id = ?', id);
    return;
  }
  await database.runAsync(
    'UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?',
    t.status,
    t.attempts,
    t.nextAttemptAt,
    t.lastError,
    id,
  );
}

/**
 * Clears a `sending` flag left behind by a crash or force-quit.
 *
 * Without this, a job interrupted mid-flight would be stuck as `sending`
 * forever and its whole stream — the rest of that visit — would never drain.
 * Called once on app start.
 */
export async function recoverInterrupted(): Promise<number> {
  const database = await getDb();
  const result = await database.runAsync(
    "UPDATE outbox SET status = 'queued' WHERE status = 'sending'",
  );
  return result.changes ?? 0;
}

/** Manual retry from the "needs attention" list. Resets the attempt budget. */
export async function retryJob(id: string): Promise<void> {
  const database = await getDb();
  await database.runAsync(
    "UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ?",
    id,
  );
}
