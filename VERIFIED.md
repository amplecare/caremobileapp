# Verification log

What has actually been proven, and how. Kept because "the tests pass" and
"it works" are different claims — twice on this project a fully green test
suite sat on top of something that silently did nothing.

## Verified on a real device — 19 Aug 2026

CCMendel ran the app on a physical iPhone via Expo Go (SDK 54) and confirmed
the TODAY screen renders correctly: fonts load, layout holds, hierarchy reads.

This closed the last unverified layer. Until this point every claim about the
UI was inference from a passing bundle.

## Verified against the live database

`npx tsx scripts/verify-live.ts` — 11/11. Signs in as a real user, drives the
full offline chain, and asserts the writes land:

- a care note queued offline reaches Supabase
- organisation_id and carer_id come from the session, not the payload
- replaying a job is idempotent (duplicate key reads as success, one row)
- a write to a missing visit stops retrying instead of looping
- two jobs on one visit drain in order, one at a time

It creates a `carers` row for the demo user if none exists, and removes
everything it made.

## Verified by test suite

151 tests, no live DB required:

| Area | Tests | What it protects |
| --- | --- | --- |
| Outbox policy | 27 | Ordering, backoff, conflicts, nothing discarded |
| Drain loop | 15 | Sequential sends, signal loss mid-drain, no double-drain |
| SQLite persistence | 16 | Real DDL, transaction rollback, crash recovery |
| Error classification | 16 | Retryable vs permanent vs conflict |
| Sender | 17 | Column mapping, tenancy, idempotency keys |
| Location rules | 29 | Distance maths, never blocking the carer |
| Care-note rules | 28 | Validation, concern scan, no false positives |
| Draft persistence | 8 | Never lose a word |

## Still unverified

- **eMAR, incidents, messaging** — not built yet (stages 5–6)
- **Background behaviour** — app suspended mid-drain, then resumed
- **Battery across a full shift** — the thing that decides adoption
- **A real carer using it** — the only test that finally matters
