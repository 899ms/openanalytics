-- The fifteen-minute rollup family (ADR-0079, D1).
--
-- Rollout note: creates only -- the backfill is a separate explicit step
-- (README, "Backfilling the 15m family"), run with the worker stopped
-- (ADR-0079 D3). Nothing existing is altered, dropped or recreated: eight new
-- AggregatingMergeTree targets and eight new materialized views, each reading
-- straight from events_raw exactly as its hour twin does (0006 argues the
-- direct-from-raw rule for the whole family, 0005 the visitor identity).
--
-- Why fifteen minutes. Every rollup buckets on occurred_at at UTC boundaries,
-- and a non-UTC day is composed at read time from the hour rollup with
-- toStartOfDay(bucket_start, tz). That composition needs every UTC bucket to
-- fall wholly inside one local day, which a one-hour bucket cannot do for a
-- zone whose offset is not a whole number of hours (Asia/Kolkata +05:30,
-- Asia/Kathmandu +05:45, Australia/Eucla +08:45, Pacific/Chatham +12:45). Every
-- IANA offset in force since 1972 is a multiple of fifteen minutes, so a
-- fifteen-minute bucket composes a correct local day for all of them, and the
-- hour grain's refusal (RESOLUTION_NOT_AVAILABLE, ADR-0011) becomes a
-- consequence of the atom the storage happened to choose rather than a fact
-- about what can be served. The read path does not change in this migration
-- (ADR-0079 D2 -- the hour tables stay and keep serving) -- this is the storage
-- half only, and it has to exist and be proven equal before anything reads it.
--
-- The DDL of each table is its hour twin's DDL verbatim, bucket expression
-- aside: same columns, same engine, same PARTITION BY and ORDER BY, same WHERE
-- on the view. That sameness is load-bearing for the equality the backfill and
-- tests/migration/clickhouse-rollups.test.ts assert: a local day composed from
-- these rows must equal the same day composed from the hour rows, family by
-- family, because uniq states merge associatively and every other measure is a
-- plain sum.
--
-- A materialized view aggregates only what is inserted after it exists, so a
-- freshly created 15m table is empty for every event already in events_raw.
-- The backfill fills that history from events_raw with the same SELECT each
-- view runs, month partition by month partition, with the worker stopped so the
-- boundary between "backfilled" and "seen by the view" is exact and no event is
-- counted twice or missed (ADR-0079 D3).
--
-- Note on style: no comment in a migration file may contain a semicolon. The
-- runner splits statements on the semicolon before it strips comments
-- (splitStatements in packages/clickhouse), so one inside a comment cuts a
-- statement in half.

-- metrics: the overview and timeseries rollup, all event types (0006).
CREATE TABLE IF NOT EXISTS metrics_15m
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_type)
-- Mandatory on every dependent target, not only on the raw table (ADR-0005).
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_15m_mv TO metrics_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  type                                                    AS event_type,
  count()                                                 AS events,
  countIf(billable = 1)                                   AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
GROUP BY site_id, bucket_start, event_type;

-- pages (0007).
CREATE TABLE IF NOT EXISTS pages_15m
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  page_path    String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, page_path)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS pages_15m_mv TO pages_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  page_path,
  count()                                                 AS views,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, page_path;

-- sources (0008).
CREATE TABLE IF NOT EXISTS sources_15m
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  referrer_domain LowCardinality(String),
  utm_source      LowCardinality(String),
  utm_medium      LowCardinality(String),
  utm_campaign    LowCardinality(String),
  views           SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS sources_15m_mv TO sources_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  referrer_domain,
  utm_source,
  utm_medium,
  utm_campaign,
  count()                                                 AS views,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, referrer_domain, utm_source, utm_medium, utm_campaign;

-- geography (0009).
CREATE TABLE IF NOT EXISTS geography_15m
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  country      LowCardinality(String),
  city         String,
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, country, city)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS geography_15m_mv TO geography_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  country,
  city,
  count()                                                 AS views,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, country, city;

-- devices (0010).
CREATE TABLE IF NOT EXISTS devices_15m
(
  site_id      UUID,
  bucket_start DateTime('UTC'),
  device_type  LowCardinality(String),
  browser      LowCardinality(String),
  os           LowCardinality(String),
  views        SimpleAggregateFunction(sum, UInt64),
  visitors     AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, device_type, browser, os)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS devices_15m_mv TO devices_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  device_type,
  browser,
  os,
  count()                                                 AS views,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
WHERE type = 'page_view'
GROUP BY site_id, bucket_start, device_type, browser, os;

-- custom events (0011).
CREATE TABLE IF NOT EXISTS custom_events_15m
(
  site_id         UUID,
  bucket_start    DateTime('UTC'),
  event_name      String,
  event_type      LowCardinality(String),
  events          SimpleAggregateFunction(sum, UInt64),
  billable_events SimpleAggregateFunction(sum, UInt64),
  visitors        AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_events_15m_mv TO custom_events_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  name                                                    AS event_name,
  type                                                    AS event_type,
  count()                                                 AS events,
  countIf(billable = 1)                                   AS billable_events,
  uniqState(if(user_id != '', user_id, anonymous_id))     AS visitors
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type;

-- performance (0012). The t-digest params in the column type and in the State
-- call must match, as they do in the hour twin.
CREATE TABLE IF NOT EXISTS performance_15m
(
  site_id                    UUID,
  bucket_start               DateTime('UTC'),
  metric                     LowCardinality(String),
  device_type                LowCardinality(String),
  samples                    SimpleAggregateFunction(sum, UInt64),
  value_sum                  SimpleAggregateFunction(sum, Float64),
  value_quantiles            AggregateFunction(quantilesTDigest(0.5, 0.75, 0.9, 0.95, 0.99), Float64),
  good_samples               SimpleAggregateFunction(sum, UInt64),
  needs_improvement_samples  SimpleAggregateFunction(sum, UInt64),
  poor_samples               SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, metric, device_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS performance_15m_mv TO performance_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC'))  AS bucket_start,
  JSONExtractString(properties, 'oa_metric')               AS metric,
  device_type,
  count()                                                  AS samples,
  sum(JSONExtractFloat(properties, 'oa_value'))            AS value_sum,
  quantilesTDigestState(0.5, 0.75, 0.9, 0.95, 0.99)(JSONExtractFloat(properties, 'oa_value')) AS value_quantiles,
  countIf(JSONExtractString(properties, 'oa_rating') = 'good')              AS good_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'needs-improvement') AS needs_improvement_samples,
  countIf(JSONExtractString(properties, 'oa_rating') = 'poor')              AS poor_samples
FROM events_raw
WHERE type = 'web_vital' AND metric != ''
GROUP BY site_id, bucket_start, metric, device_type;

-- custom event samples (0021): what a custom-events row may say beyond a
-- count. Same WHERE and GROUP BY as custom_events_15m_mv.
CREATE TABLE IF NOT EXISTS custom_event_samples_15m
(
  site_id           UUID,
  bucket_start      DateTime('UTC'),
  event_name        String,
  event_type        LowCardinality(String),
  events            SimpleAggregateFunction(sum, UInt64),
  last_seen_at      SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  sample_page_path  AggregateFunction(argMax, String, DateTime64(3, 'UTC')),
  sample_properties AggregateFunction(argMax, String, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_start)
ORDER BY (site_id, bucket_start, event_name, event_type)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW IF NOT EXISTS custom_event_samples_15m_mv TO custom_event_samples_15m AS
SELECT
  site_id,
  toStartOfFifteenMinutes(toDateTime(occurred_at, 'UTC')) AS bucket_start,
  name                                                    AS event_name,
  type                                                    AS event_type,
  count()                                                 AS events,
  max(occurred_at)                                        AS last_seen_at,
  argMaxState(page_path, occurred_at)                     AS sample_page_path,
  argMaxState(properties, occurred_at)                    AS sample_properties
FROM events_raw
WHERE name != ''
GROUP BY site_id, bucket_start, event_name, event_type
