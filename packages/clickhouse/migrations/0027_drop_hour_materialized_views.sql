-- ADR-0079, D2 / step 4: the hour rollups stop being written.
--
-- Step 3 moved every read to the fifteen-minute family, so since then these
-- eight views have written eight tables nobody reads -- roughly a third of the
-- insert work of ingest, measured in step 1 as a p50 of 66 ms rising to 90 ms
-- when the 15m family was added beside the hour one. D2's order was "beside
-- first, instead later", and this is the "instead": the views go, and the hour
-- grain stops costing anything.
--
-- **The `*_1h` tables stay.** They are frozen history, not garbage:
--
--   * a self-host upgrading across this migration proves its 15m backfill by
--     comparing each family against its hour twin (`backfill-15m`, README
--     "Backfilling the 15m family"), and against the per-hour sum of the
--     quarters for the session rollup. Drop the tables here and the only
--     equality gate the upgrade has disappears with them.
--   * the deletion workflow's targets do not change (docs snapshot 05, D-210).
--     A site erased tomorrow must still be erased from rows written yesterday.
--
-- Dropping the tables is a later, separate patch, after the release that
-- carries this one has been in the field long enough that no install still
-- needs the comparison. `docs/OPEN-THREADS.md` carries that thread.
--
-- `_1d` is untouched: the day family is read directly for every UTC day and
-- week, and its views keep firing.
--
-- Two writers are retired in the same step and they are NOT here, because they
-- are worker code rather than DDL: the session finalizer and the revenue
-- attribution job stop writing `session_rollups_1h` and `revenue_1h`. Their
-- unit unions lose `'1h'`, so the compiler -- not this file -- is what proves
-- nothing writes them any more.
--
-- Reversal, if the hour grain is ever wanted back: re-apply the
-- `CREATE MATERIALIZED VIEW` halves of 0006-0012 and 0021 as a new migration,
-- then replay the gap from `events_raw`, which is kept forever and is the
-- source every one of these views reads. Nothing here loses data.

DROP VIEW IF EXISTS metrics_1h_mv;

DROP VIEW IF EXISTS pages_1h_mv;

DROP VIEW IF EXISTS sources_1h_mv;

DROP VIEW IF EXISTS geography_1h_mv;

DROP VIEW IF EXISTS devices_1h_mv;

DROP VIEW IF EXISTS custom_events_1h_mv;

DROP VIEW IF EXISTS performance_1h_mv;

DROP VIEW IF EXISTS custom_event_samples_1h_mv;
