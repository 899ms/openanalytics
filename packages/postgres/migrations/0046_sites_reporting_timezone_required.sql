-- Every site carries a reporting timezone (ADR-0079, D5 amendment; step 5c).
--
-- Rollout note: a backfill and a tightening, forward-only (migrations
-- 0001-0045 are never edited -- D-214). Two UPDATEs then two ALTERs, in one
-- transaction with the rest of the stream. It is safe to re-run: the second
-- pass matches no rows, because after the first there is no NULL left to find.
--
-- ## Why the column stops being nullable
--
-- 0039 made `sites.reporting_timezone` nullable with no default, and the note
-- there is still the right reading of what NULL meant *then*: the column was an
-- override on the share board and the widgets only, so "the owner has never
-- chosen" had somewhere to fall back to -- the reader's own clock -- and a
-- stored 'UTC' would have been indistinguishable from an owner who genuinely
-- chose UTC.
--
-- ADR-0079 D5 moved the column under the whole product: the private dashboard,
-- the share board and every widget now cut their days on it. Against that, NULL
-- is no longer an absence with a meaning; it is a site whose two readers see two
-- different weeks and call the difference a bug (Rahul, 2026-09-04: every site
-- has a zone, and a reader who wants their own switches to it from the header
-- pill -- which is a view, not a stored setting).
--
-- ADR-0026 decision 3 keeps its force where it was written: `users.timezone`
-- stays nullable, because a *person* who has chosen nothing is a real state that
-- the browser's own clock answers. This migration is about the site column only.
--
-- ## Where the backfilled value comes from
--
-- The owner's own account zone (`users.timezone`, ADR-0026), which onboarding
-- has asked for since M10 -- so for all but a handful of sites the value being
-- written here is one the owner picked themselves, for themselves, on the
-- machine they read the dashboard on.
--
-- Measured against production on 2026-09-05, read-only: **267 rows in `sites`**
-- -- 28 active, 145 suspended, 94 deleted tombstones -- of which 10 carry a zone
-- and 257 do not. Of those 257, **244 have an owner with an account zone** and
-- **13 do not**.
--
-- Those 13 get 'UTC' (Rahul, 2026-09-04: no further mechanism -- a site whose
-- owner never named a clock anywhere has nothing better to be defaulted to, and
-- Settings -> General is one field away). 'UTC' is also the column default from
-- here on, so a row inserted by a path that does not name a zone is a site the
-- owner can see and change rather than a site with no clock at all.
--
-- **Every row, not only the live ones.** There is no status filter here and
-- there must not be: `SET NOT NULL` is checked against the whole table, so a
-- deleted tombstone or a suspended site with a NULL zone would abort the ALTER.
-- A tombstone gaining a timezone column value is inert -- nothing reads it --
-- and a suspended site that is later unsuspended finds a clock already set.
--
-- ## What is deliberately NOT touched
--
-- `config_version` is not bumped. It is the tracker/ingest config generation,
-- and the collector has never heard of a reporting timezone (the same reason
-- `updateSiteSettings` does not bump it when an owner sets this field by hand).
-- Bumping it here would invalidate every tracker's cached config for every live
-- site at once, for a read-side presentation choice.
--
-- `updated_at` is not touched either, for the same reason and one more: it is
-- the column an owner reads as "when did somebody last change my settings", and
-- a platform backfill is not somebody.
--
-- The `sites_reporting_timezone_format` CHECK from 0039 is left exactly as it
-- is. Its `IS NULL OR ...` branch becomes unreachable under the NOT NULL below,
-- which is a dead branch and not a wrong one; rewriting a correct constraint to
-- delete an arm that can no longer be taken is churn on the one guard that stops
-- a direct SQL write planting an offset zone.

-- The owner's account zone, for every site that has no zone of its own. Joined
-- through `owner_user_id` rather than through `site_members`: a site has exactly
-- one billing owner and several members, and "whose clock is this site on" has
-- to have one answer.
UPDATE sites s
   SET reporting_timezone = u.timezone
  FROM users u
 WHERE u.id = s.owner_user_id
   AND s.reporting_timezone IS NULL
   AND u.timezone IS NOT NULL;

-- The remainder: an owner who named no clock anywhere.
UPDATE sites
   SET reporting_timezone = 'UTC'
 WHERE reporting_timezone IS NULL;

-- WHY THIS LINE EXISTS, AND WHAT HAPPENS WITHOUT IT
--
-- `sites_ownership_invariant` (migration 0006) is a CONSTRAINT TRIGGER on this
-- table, `AFTER INSERT OR UPDATE`, `DEFERRABLE INITIALLY DEFERRED`. So the two
-- UPDATEs above queue one trigger event per row they touch, and the queue is not
-- drained until COMMIT. Postgres refuses to `ALTER TABLE` a table with pending
-- trigger events:
--
--   ERROR: cannot ALTER TABLE "sites" because it has pending trigger events
--
-- The runner wraps a whole migration file in one transaction
-- (`applyOne` in `packages/postgres/src/migrate.ts`), so the UPDATEs and the
-- ALTER below are in that transaction together and the failure is certain — on
-- any database with sites in it. It does NOT reproduce on an empty one: no rows
-- match, so nothing is queued, which is exactly why the bootstrap test applied
-- this file cleanly and the backfill test did not.
--
-- Flushing the queue here runs those invariant checks now instead of at COMMIT.
-- That is the same check at an earlier instant, not a weaker one: a violation
-- still aborts the migration, and this file only writes one text column and so
-- cannot create one.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE sites
  ALTER COLUMN reporting_timezone SET DEFAULT 'UTC',
  ALTER COLUMN reporting_timezone SET NOT NULL;
