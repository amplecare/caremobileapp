/**
 * Every SQL statement the outbox uses, in one place.
 *
 * Extracted from `store.ts` so the exact same strings can be executed against
 * a real SQLite database in Node during tests. Mocking `expo-sqlite` would
 * only prove that the mock behaves like the mock; running the real DDL and the
 * real statements proves the schema is valid, the transaction actually rolls
 * back, and the crash-recovery UPDATE matches the rows it is supposed to.
 *
 * Nothing here imports Expo, so it is safe in any environment.
 */

/** Bumped whenever DDL changes; drives `PRAGMA user_version` migrations. */
export const SCHEMA_VERSION = 2;

export const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS outbox (
    id              TEXT PRIMARY KEY NOT NULL,
    type            TEXT NOT NULL,
    stream_key      TEXT NOT NULL,
    payload         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    created_at      INTEGER NOT NULL,
    last_error      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_stream ON outbox(stream_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

  CREATE TABLE IF NOT EXISTS visits (
    id              TEXT PRIMARY KEY NOT NULL,
    client_name     TEXT NOT NULL,
    address         TEXT,
    visit_type      TEXT,
    scheduled_start TEXT NOT NULL,
    scheduled_end   TEXT NOT NULL,
    status          TEXT NOT NULL,
    synced_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_visits_start ON visits(scheduled_start);
`;

/**
 * Care-note drafts.
 *
 * Separate from the outbox on purpose. An outbox job is work the carer has
 * COMMITTED to — they pressed save and it is going to the agency. A draft is
 * half a sentence typed while the kettle boils, and it must survive a
 * force-quit, a flat battery or a slammed car door without ever being sent
 * anywhere.
 *
 * One row per visit, overwritten on every keystroke. Cheap: SQLite handles
 * thousands of small writes a second, and losing a carer's account of a fall
 * because we debounced too aggressively is not a trade worth making.
 */
export const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS note_drafts (
    visit_id   TEXT PRIMARY KEY NOT NULL,
    body       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export const SQL = {
  insertJob: `
    INSERT INTO outbox (id, type, stream_key, payload, status, attempts, next_attempt_at, created_at, last_error)
    VALUES (?, ?, ?, ?, 'queued', 0, NULL, ?, NULL)
  `,

  allJobs: 'SELECT * FROM outbox ORDER BY created_at ASC',

  markSending: "UPDATE outbox SET status = 'sending' WHERE id = ?",

  deleteJob: 'DELETE FROM outbox WHERE id = ?',

  updateJob: `
    UPDATE outbox
       SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
     WHERE id = ?
  `,

  /**
   * Clears `sending` rows left behind by a force-quit or crash.
   *
   * Without this a job interrupted mid-flight stays `sending` forever, and
   * because ordering skips any stream with a job in flight, that visit's
   * entire queue would stall permanently.
   */
  recoverInterrupted: "UPDATE outbox SET status = 'queued' WHERE status = 'sending'",

  /** Manual retry from the "needs attention" list — resets the budget. */
  retryJob: `
    UPDATE outbox
       SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL
     WHERE id = ?
  `,

  upsertVisit: `
    INSERT INTO visits (id, client_name, address, visit_type, scheduled_start, scheduled_end, status, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      client_name     = excluded.client_name,
      address         = excluded.address,
      visit_type      = excluded.visit_type,
      scheduled_start = excluded.scheduled_start,
      scheduled_end   = excluded.scheduled_end,
      status          = excluded.status,
      synced_at       = excluded.synced_at
  `,

  visitsForDay: `
    SELECT * FROM visits
     WHERE scheduled_start >= ? AND scheduled_start <= ?
     ORDER BY scheduled_start ASC
  `,

  setVisitStatus: 'UPDATE visits SET status = ? WHERE id = ?',

  /** Overwrites the draft for a visit. Called on every keystroke. */
  saveDraft: `
    INSERT INTO note_drafts (visit_id, body, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(visit_id) DO UPDATE SET
      body       = excluded.body,
      updated_at = excluded.updated_at
  `,

  getDraft: 'SELECT body, updated_at FROM note_drafts WHERE visit_id = ?',

  /**
   * Removed only once the note is safely in the outbox — never on navigating
   * away, never on a timer.
   */
  deleteDraft: 'DELETE FROM note_drafts WHERE visit_id = ?',

  /** Anything still half-written, so TODAY can nudge: "unfinished note". */
  pendingDrafts: `
    SELECT visit_id, body, updated_at FROM note_drafts
     WHERE TRIM(body) <> ''
     ORDER BY updated_at DESC
  `,
} as const;
