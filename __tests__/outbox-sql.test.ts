/**
 * @jest-environment node
 */

/**
 * Outbox persistence, executed against a REAL SQLite database.
 *
 * Uses Node's built-in `node:sqlite` with an in-memory database, running the
 * exact DDL and statements `store.ts` ships to the device. Mocking
 * `expo-sqlite` would only prove the mock behaves like the mock — it would not
 * catch a typo in the schema, a transaction that fails to roll back, or a
 * recovery UPDATE that matches the wrong rows.
 *
 * These are the guarantees that stop a carer's work disappearing, so they are
 * tested against the real engine.
 */

import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_V1, SQL } from '../lib/outbox/sql';

const NOW = 1_760_000_000_000;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_V1);
  return db;
}

function insert(
  db: DatabaseSync,
  id: string,
  over: { type?: string; stream?: string; createdAt?: number } = {},
) {
  db.prepare(SQL.insertJob).run(
    id,
    over.type ?? 'visit.note',
    over.stream ?? 'visit-1',
    '{"text":"note"}',
    over.createdAt ?? NOW,
  );
}

const rows = (db: DatabaseSync) => db.prepare(SQL.allJobs).all() as Array<Record<string, unknown>>;

describe('schema', () => {
  test('the DDL we ship is valid SQLite and creates both tables', () => {
    const db = freshDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    expect(names).toContain('outbox');
    expect(names).toContain('visits');
    db.close();
  });

  test('re-running the DDL is safe (IF NOT EXISTS everywhere)', () => {
    const db = freshDb();
    insert(db, 'j1');
    expect(() => db.exec(SCHEMA_V1)).not.toThrow();
    expect(rows(db)).toHaveLength(1); // data survives a repeat migration
    db.close();
  });

  test('the indexes the drain relies on exist', () => {
    const db = freshDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    expect(idx).toContain('idx_outbox_stream');
    expect(idx).toContain('idx_outbox_status');
    db.close();
  });
});

describe('enqueue', () => {
  test('a queued job starts with no attempts and is eligible immediately', () => {
    const db = freshDb();
    insert(db, 'j1');

    const [job] = rows(db);
    expect(job!.status).toBe('queued');
    expect(job!.attempts).toBe(0);
    expect(job!.next_attempt_at).toBeNull();
    db.close();
  });

  /** The id IS the idempotency key, so a duplicate must be impossible. */
  test('the same id cannot be inserted twice', () => {
    const db = freshDb();
    insert(db, 'j1');
    expect(() => insert(db, 'j1')).toThrow();
    expect(rows(db)).toHaveLength(1);
    db.close();
  });

  test('jobs come back oldest first', () => {
    const db = freshDb();
    insert(db, 'newer', { createdAt: NOW });
    insert(db, 'older', { createdAt: NOW - 5000 });

    expect(rows(db).map((r) => r.id)).toEqual(['older', 'newer']);
    db.close();
  });
});

describe('transaction atomicity', () => {
  /**
   * THE guarantee behind the whole design: the optimistic local write and its
   * outbox job are one transaction. If they could diverge, the app would show
   * a saved note with no job to deliver it — silently losing a carer's work
   * while telling them it was fine.
   */
  test('a failure part-way through rolls back BOTH the local write and the job', () => {
    const db = freshDb();

    expect(() => {
      db.exec('BEGIN');
      db.prepare(SQL.upsertVisit).run(
        'v1', 'Doris Fenwick', '22 Bury New Road', 'personal_care',
        '2026-08-18T09:15:00Z', '2026-08-18T10:00:00Z', 'in_progress', NOW,
      );
      insert(db, 'j1');
      // Same primary key again — blows up mid-transaction.
      insert(db, 'j1');
      db.exec('COMMIT');
    }).toThrow();

    db.exec('ROLLBACK');

    expect(rows(db)).toHaveLength(0);
    expect(db.prepare('SELECT * FROM visits').all()).toHaveLength(0);
    db.close();
  });

  test('a clean transaction commits both together', () => {
    const db = freshDb();

    db.exec('BEGIN');
    db.prepare(SQL.upsertVisit).run(
      'v1', 'Doris Fenwick', '22 Bury New Road', 'personal_care',
      '2026-08-18T09:15:00Z', '2026-08-18T10:00:00Z', 'completed', NOW,
    );
    insert(db, 'j1', { type: 'visit.check_out' });
    db.exec('COMMIT');

    expect(rows(db)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM visits').all()).toHaveLength(1);
    db.close();
  });
});

describe('transitions', () => {
  test('success deletes the row', () => {
    const db = freshDb();
    insert(db, 'j1');
    db.prepare(SQL.deleteJob).run('j1');
    expect(rows(db)).toHaveLength(0);
    db.close();
  });

  test('a retryable failure records the backoff and keeps the payload', () => {
    const db = freshDb();
    insert(db, 'j1');
    db.prepare(SQL.updateJob).run('queued', 1, NOW + 2000, 'timeout', 'j1');

    const [job] = rows(db);
    expect(job!.attempts).toBe(1);
    expect(job!.next_attempt_at).toBe(NOW + 2000);
    expect(job!.last_error).toBe('timeout');
    expect(job!.payload).toBe('{"text":"note"}'); // the work is still there
    db.close();
  });

  test('a manual retry resets the attempt budget and clears the error', () => {
    const db = freshDb();
    insert(db, 'j1');
    db.prepare(SQL.updateJob).run('failed', 5, null, 'gave up', 'j1');

    db.prepare(SQL.retryJob).run('j1');

    const [job] = rows(db);
    expect(job!.status).toBe('queued');
    expect(job!.attempts).toBe(0);
    expect(job!.last_error).toBeNull();
    db.close();
  });
});

describe('crash recovery', () => {
  /**
   * A force-quit mid-send leaves a job flagged `sending`. Because ordering
   * skips any stream with a job in flight, that visit's entire queue would
   * stall forever — the carer's later notes for that client never send, with
   * no error shown.
   */
  test('interrupted sends are returned to the queue on next launch', () => {
    const db = freshDb();
    insert(db, 'j1');
    db.prepare(SQL.markSending).run('j1');
    expect(rows(db)[0]!.status).toBe('sending');

    const result = db.prepare(SQL.recoverInterrupted).run();

    expect(result.changes).toBe(1);
    expect(rows(db)[0]!.status).toBe('queued');
    db.close();
  });

  test('recovery leaves queued, failed and blocked jobs alone', () => {
    const db = freshDb();
    insert(db, 'queued', { stream: 's1' });
    insert(db, 'failed', { stream: 's2' });
    insert(db, 'blocked', { stream: 's3' });
    insert(db, 'sending', { stream: 's4' });
    db.prepare(SQL.updateJob).run('failed', 5, null, 'e', 'failed');
    db.prepare(SQL.updateJob).run('blocked', 1, null, 'conflict', 'blocked');
    db.prepare(SQL.markSending).run('sending');

    db.prepare(SQL.recoverInterrupted).run();

    const byId = Object.fromEntries(rows(db).map((r) => [r.id, r.status]));
    expect(byId).toEqual({
      queued: 'queued',
      failed: 'failed',
      blocked: 'blocked',
      sending: 'queued', // only this one was touched
    });
    db.close();
  });

  test('recovery on a clean queue changes nothing', () => {
    const db = freshDb();
    insert(db, 'j1');
    expect(db.prepare(SQL.recoverInterrupted).run().changes).toBe(0);
    db.close();
  });
});

describe('visit cache', () => {
  test('re-syncing a visit updates in place rather than duplicating', () => {
    const db = freshDb();
    const args = [
      'v1', 'Doris Fenwick', '22 Bury New Road', 'personal_care',
      '2026-08-18T09:15:00Z', '2026-08-18T10:00:00Z',
    ];
    db.prepare(SQL.upsertVisit).run(...args, 'scheduled', NOW);
    db.prepare(SQL.upsertVisit).run(...args, 'completed', NOW + 60_000);

    const all = db.prepare('SELECT * FROM visits').all() as Array<Record<string, unknown>>;
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('completed');
    db.close();
  });

  test("today's visits come back in time order", () => {
    const db = freshDb();
    const mk = (id: string, start: string) =>
      db.prepare(SQL.upsertVisit).run(id, 'X', null, 'personal_care', start, start, 'scheduled', NOW);

    mk('late', '2026-08-18T16:00:00Z');
    mk('early', '2026-08-18T08:00:00Z');
    mk('tomorrow', '2026-08-19T08:00:00Z');

    const today = db
      .prepare(SQL.visitsForDay)
      .all('2026-08-18T00:00:00Z', '2026-08-18T23:59:59Z') as Array<{ id: string }>;

    expect(today.map((v) => v.id)).toEqual(['early', 'late']);
    db.close();
  });
});
