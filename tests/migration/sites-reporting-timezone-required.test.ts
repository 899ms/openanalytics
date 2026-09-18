import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDatabase, createPool, createSiteWithOwner, newId } from '@openanalytics/postgres'
import type { Database } from '@openanalytics/postgres'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PRODUCT_MIGRATIONS_DIR, applyPostgresStreams } from '../support/postgres-streams.ts'

/**
 * Migration 0046 — every site carries a reporting timezone (ADR-0079 D5; Rahul,
 * 2026-09-04).
 *
 * A backfill runs once, against a database nobody can rehearse on, and the way
 * this one fails is silent: take the wrong source and 244 sites start cutting
 * their days on a clock their owner never chose, on every surface at once. So it
 * is proven the only way that means anything — by seeding the three cases it has
 * to tell apart and executing the migration's own SQL, read from the file,
 * against them.
 *
 * The stream has already applied that file once (as a no-op on an empty
 * database), so the column arrives here NOT NULL. The `DROP NOT NULL` below puts
 * the table back into the shape production is in *before* the migration runs;
 * without it there would be no NULL left to back-fill and the test would prove
 * nothing. The file's own trailing `ALTER`s then re-establish the constraint,
 * which is the second half of what is asserted.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('sites.reporting_timezone becomes required (migration 0046)', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `tzreq_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let migrationSql: string

  /** A user with, or without, an account timezone of their own (ADR-0026). */
  const newUser = async (timezone: string | null): Promise<string> => {
    const userId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified, timezone) VALUES ($1, 'U', $2, true, $3)`,
      [userId, `${userId}@example.com`, timezone],
    )
    return userId
  }

  const newSite = async (input: {
    ownerTimezone: string | null
    siteTimezone: string | null
  }): Promise<string> => {
    const ownerUserId = await newUser(input.ownerTimezone)
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'Shop',
      ownerUserId,
    })
    await pool.query(`UPDATE sites SET reporting_timezone = $2 WHERE id = $1`, [
      siteId,
      input.siteTimezone,
    ])
    return siteId
  }

  const zoneOf = async (siteId: string): Promise<string | null> => {
    const { rows } = await pool.query<{ reporting_timezone: string | null }>(
      `SELECT reporting_timezone FROM sites WHERE id = $1`,
      [siteId],
    )
    return rows[0]?.reporting_timezone ?? null
  }

  const versionOf = async (siteId: string): Promise<number> => {
    const { rows } = await pool.query<{ config_version: number }>(
      `SELECT config_version FROM sites WHERE id = $1`,
      [siteId],
    )
    return Number(rows[0]?.config_version)
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()
    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })
    pool = createPool(scoped)
    db = createDatabase(pool)
    migrationSql = await readFile(
      join(PRODUCT_MIGRATIONS_DIR, '0046_sites_reporting_timezone_required.sql'),
      'utf8',
    )
  })

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  it('takes the owner’s account zone, falls back to UTC, and leaves a chosen zone alone', async () => {
    // Back to the pre-0046 shape, which is what the live database looks like the
    // moment before this file runs.
    await pool.query(
      `ALTER TABLE sites
         ALTER COLUMN reporting_timezone DROP NOT NULL,
         ALTER COLUMN reporting_timezone DROP DEFAULT`,
    )

    // The three cases production has (measured 2026-09-05): 244 sites whose
    // owner chose an account zone, 13 whose owner chose none, 10 that already
    // carry a zone of their own.
    const fromOwner = await newSite({ ownerTimezone: 'Asia/Kolkata', siteTimezone: null })
    const noZoneAnywhere = await newSite({ ownerTimezone: null, siteTimezone: null })
    const alreadySet = await newSite({
      ownerTimezone: 'Asia/Kolkata',
      siteTimezone: 'Europe/Berlin',
    })

    expect(await zoneOf(fromOwner)).toBeNull()
    expect(await zoneOf(noZoneAnywhere)).toBeNull()
    const versionsBefore = [
      await versionOf(fromOwner),
      await versionOf(noZoneAnywhere),
      await versionOf(alreadySet),
    ]

    await pool.query(migrationSql)

    // The owner's own clock, which is the value they picked for themselves in
    // onboarding — not a platform guess.
    expect(await zoneOf(fromOwner)).toBe('Asia/Kolkata')
    // Nobody named a clock anywhere: UTC, and visible in Settings → General.
    expect(await zoneOf(noZoneAnywhere)).toBe('UTC')
    // A site that already had one is untouched, including when the owner's
    // account zone says something else — the site's own setting is the answer.
    expect(await zoneOf(alreadySet)).toBe('Europe/Berlin')

    // `config_version` is the tracker/ingest config generation and the collector
    // has never heard of a reporting timezone. Bumping it here would invalidate
    // every tracker's cached config, for every live site, for a read-side
    // presentation choice.
    expect([
      await versionOf(fromOwner),
      await versionOf(noZoneAnywhere),
      await versionOf(alreadySet),
    ]).toEqual(versionsBefore)
  })

  it('leaves the column NOT NULL with a UTC default, and re-runs as a no-op', async () => {
    // The tightening is the point of the migration, not a side effect: a site
    // created afterwards by a path that names no zone still has one.
    const created = await newSite({ ownerTimezone: 'Asia/Kolkata', siteTimezone: 'Europe/Berlin' })
    await expect(
      pool.query(`UPDATE sites SET reporting_timezone = NULL WHERE id = $1`, [created]),
    ).rejects.toMatchObject({ column: 'reporting_timezone' })

    const { rows } = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'sites' AND column_name = 'reporting_timezone'`,
      [schemaName],
    )
    expect(rows[0]?.is_nullable).toBe('NO')
    expect(rows[0]?.column_default).toContain('UTC')

    // The rollout note claims a second pass matches no rows. Run it and see.
    await pool.query(migrationSql)
    expect(await zoneOf(created)).toBe('Europe/Berlin')
  })
})
