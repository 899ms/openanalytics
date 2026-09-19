-- ADR-0079 step 4, completed (v0.8.0): the hour rollup TABLES go.
--
-- Migration 0027 dropped the eight hour views and kept their tables, for two
-- reasons it named. Both are gone now:
--
--   * the 15m backfill's equality gate compared each family against its hour
--     twin. It now compares against `events_raw` itself -- the table every view
--     reads, which is never behind. (The hour twin WAS behind: 0027 froze it,
--     so any event delivered after 0027 -- a queue backlog drained during the
--     upgrade -- sat in the 15m rows and not in the reference, and the gate
--     reported a failed fill over data that was right.)
--   * the deletion workflow named these tables as targets. It stops naming
--     them in the same release (`packages/domain/src/deletion.ts`, 44 -> 34
--     ClickHouse targets), which is the only order that works: a target naming
--     a table that no longer exists fails every deletion, and the rows a target
--     would purge leave with the table.
--
-- Ten tables: the eight view targets of 0006-0012 and 0021, plus the two swap
-- targets of 0014 and 0018 that the worker stopped writing in the same step
-- (`'1h'` left both unit unions). Nothing reads any of them: step 3 moved every
-- read to the fifteen-minute family, and the compiler has refused a write since
-- step 4.
--
-- The `_1d` family stays. It is read directly for every UTC day and week, and
-- its views keep firing.
--
-- `IF EXISTS` so an install that never had one of them (none should, but a
-- hand-dropped table is not a reason to stop the stack) passes. An install
-- skipping 0.7.0 applies 0025-0029 in one run: the 15m family is created by
-- 0025/0026 and filled from `events_raw` by the migrate container after the
-- migrations, and nothing in that fill looks at an hour table any more, so
-- dropping them first is safe.
--
-- Reversal, if the hour grain is ever wanted back: this migration deletes
-- data, so it is not reversed by running an older image. Re-create the tables
-- and views from 0006-0012, 0014, 0018 and 0021 as a new migration and replay
-- from `events_raw` (views) and the session facts / revenue facts (swaps), all
-- of which are kept. A self-hosted install restores the pre-upgrade backup
-- instead (`./rollback.sh`).

DROP TABLE IF EXISTS metrics_1h;

DROP TABLE IF EXISTS pages_1h;

DROP TABLE IF EXISTS sources_1h;

DROP TABLE IF EXISTS geography_1h;

DROP TABLE IF EXISTS devices_1h;

DROP TABLE IF EXISTS custom_events_1h;

DROP TABLE IF EXISTS performance_1h;

DROP TABLE IF EXISTS custom_event_samples_1h;

DROP TABLE IF EXISTS session_rollups_1h;

DROP TABLE IF EXISTS revenue_1h;
