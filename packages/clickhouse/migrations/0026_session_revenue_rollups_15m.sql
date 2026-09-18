-- The fifteen-minute grain for the two SWAP rollups (ADR-0079, D1, second row).
--
-- 0025 gave a fifteen-minute twin to the eight additive families. Those are
-- materialized views: ClickHouse fills them itself from events_raw, and the
-- migration was the whole story once the backfill had run. These two are not.
-- `session_rollups_*` is written by the worker's session finalizer and
-- `revenue_*` by the revenue attribution job, each with the same
-- recompute-compare-swap discipline: read the current generation of every
-- affected bucket, recompute it from the versioned facts, and insert at a
-- higher generation only where the answer actually moved. So this migration
-- creates two tables and NO materialized view, and the rows arrive when the
-- worker on the matching image writes them.
--
-- Two consequences follow from "the worker writes these", and both are deploy
-- steps rather than SQL:
--
-- 1. `oa_ingest` needs INSERT **and** SELECT on both new tables, and that grant
--    lives only in the ClickHouse entrypoint's users.d XML. users.d is rendered
--    at container start, so the grant appears only after a container RECREATE.
--    A `docker compose restart` re-runs the entrypoint with the container's
--    ORIGINAL environment and the new lines never land. SELECT is not optional
--    padding: the compare-before-write step reads the stored generation first,
--    and without it every pass would rewrite a rolling month of identical rows
--    at a new generation, forever.
-- 2. There is no view to backfill from, so history is not free. The session
--    rollups are filled by an explicit backfill (`backfill-15m --sessions`,
--    README "Backfilling the session 15m rollups") and the revenue rollups by
--    pulling each site's existing re-roll cursor back to its oldest fact, which
--    the ordinary attribution job then walks forward in month chunks. Neither
--    is part of this file.
--
-- The DDL of each table is its hour twin's DDL verbatim -- same columns, same
-- ReplacingMergeTree(generation), same PARTITION BY and ORDER BY, same
-- deduplication window. That sameness is what makes the equality the backfill
-- asserts meaningful: an hour bucket must equal the sum of its four quarters,
-- measure for measure, and every measure here is a plain sum or count, so the
-- composition is exact rather than approximate.
--
-- ORDER BY stays (site_id, bucket_start) with no unit column, for the reason
-- 0014 and 0018 give: the grain is the table, not a dimension inside it.
--
-- non_replicated_deduplication_window is mandatory on every MergeTree-family
-- table (ADR-0005). The bootstrap test enforces it, and the swap insert's
-- content-derived token is silently ignored without it.
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.

-- The session finalizer's fifteen-minute swap target (0014's twin).
CREATE TABLE IF NOT EXISTS session_rollups_15m
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  -- The finalizer's monotonic swap generation. Reader takes argMax over it per
  -- (site_id, bucket_start), and ReplacingMergeTree keeps the highest.
  generation                 UInt64,

  sessions                   UInt64,
  engaged_sessions           UInt64,
  bounced_sessions           UInt64,
  pageviews                  UInt64,
  -- Totals, so average duration is a sum divided by a sum at read, never a stored
  -- average and never a mean of per-message durations (§10).
  total_session_duration_ms  UInt64,
  total_active_duration_ms   UInt64,

  computed_at                DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000;

-- The revenue attribution job's fifteen-minute swap target (0018's twin).
CREATE TABLE IF NOT EXISTS revenue_15m
(
  site_id                   UUID,
  bucket_start              DateTime('UTC'),
  -- The rollup step's swap generation, minted from the per-site counter in
  -- `revenue_attribution_state`. Readers take argMax over it per
  -- (site_id, bucket_start), and ReplacingMergeTree keeps the highest.
  generation                UInt64,

  -- Gross of every non-failed charge occurring in this bucket, reporting
  -- currency, minor units. A refunded charge is here in full -- see the sign rule.
  charge_gross_minor        Int64,
  -- Magnitude of refunds occurring in this bucket. Positive. The sign is applied
  -- by the net identity, not stored.
  refund_minor              Int64,
  -- Magnitudes of dispute money movement, split so a dashboard can show
  -- "withheld" separately from "returned to us" rather than only their
  -- difference. A won dispute contributes to BOTH -- the funds were withdrawn
  -- and then reinstated, and collapsing that to zero would hide that it happened.
  dispute_withdrawn_minor   Int64,
  dispute_reinstated_minor  Int64,
  -- Provider fees, signed by the movement they belong to, so `net` closes.
  -- Charge-only in practice -- see the note in the sign rule above.
  fee_minor                 Int64,
  -- The single additive answer: charges minus refunds minus withdrawn plus
  -- reinstated minus fees.
  net_minor                 Int64,

  charge_count              UInt64,
  refund_count              UInt64,
  dispute_count             UInt64,
  -- Facts in this bucket with no usable exchange rate. They are in NO money
  -- column and in NO kind count above. Their original-currency totals are read
  -- from the facts by the summary endpoint.
  unconverted_count         UInt64,

  computed_at               DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(generation)
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start)
SETTINGS non_replicated_deduplication_window = 1000;
