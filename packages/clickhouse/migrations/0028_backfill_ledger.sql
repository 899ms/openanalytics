-- A ledger of the history fills that are not migrations (ADR-0079, v0.7.0 prework).
--
-- 0025 and 0026 created the fifteen-minute rollups, and their history arrives by
-- three separate steps that are not DDL: the additive backfill
-- (`backfill-15m`), the session backfill (`backfill-15m --sessions`) and the
-- revenue re-roll seed (`seed-15m-reroll`). Since the gap-fill rework each of
-- them is state-seeking -- it fills whatever (site, quarter-hour) the target is
-- missing and does nothing when nothing is missing -- so none of them READS
-- this table to decide anything. A lost or truncated ledger changes no fill.
--
-- What it is for is evidence:
--
--   * an operator, or a support thread, can see when each fill last wrote and
--     what range it covered, without reading the migrate container's log
--   * the later migration that drops the frozen `*_1h` tables (v0.8, ADR-0079
--     step 4 follow-up) needs to know the 15m history was filled before it
--     removes the tables that history was proven against
--
-- One row per fill, keyed by `name`:
--
--   rollups_15m          the eight additive families of 0025
--   session_rollups_15m  the session half of 0026
--   revenue_15m_reroll   the revenue half of 0026 (a re-roll cursor seed)
--
-- `detail` is the fill's own report as JSON (range, rows, sites, the seam note).
-- ReplacingMergeTree(completed_at) keeps the newest report per name, so a later
-- fill that found a gap supersedes the earlier one and a no-op run does not
-- write at all (the fill commands only record a run that wrote something, or
-- the first run that found nothing to write).
--
-- The migration itself writes no row. On a self-hosted install a row here must
-- mean "a fill ran on THIS database", and a migration that seeded one would say
-- that about every fresh install that never needed a fill. The hosted
-- deployment, whose fills ran before this table existed, gets its rows as an
-- explicit deploy step.
--
-- non_replicated_deduplication_window is mandatory on every MergeTree-family
-- table (ADR-0005), and the bootstrap test enforces it.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments.

CREATE TABLE IF NOT EXISTS backfill_ledger
(
  name          String,
  completed_at  DateTime64(3, 'UTC'),
  detail        String
)
ENGINE = ReplacingMergeTree(completed_at)
ORDER BY name
SETTINGS non_replicated_deduplication_window = 1000;
