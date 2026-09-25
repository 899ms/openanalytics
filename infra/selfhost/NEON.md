# Deploying OpenAnalytics with Neon

[Neon](https://neon.com) is the managed Postgres we recommend for a self-hosted
OpenAnalytics, and the one the hosted service at getopen.so runs its own control
plane on. This guide moves **Postgres only** off your host: ClickHouse and the
two Valkeys stay where they are, in the same `docker compose` stack.

It is a change of four environment variables and one line in `.env`. It assumes
the normal install in [`/SELF-HOSTING.md`](../../SELF-HOSTING.md) — read that
first; everything here is a difference from it.

What you gain: Postgres backups and point-in-time restore become Neon's job, and
one of the two stateful volumes on your server disappears. What does not change:
ClickHouse (the events) is still on your disk and still yours to back up, and
upgrading OpenAnalytics is still `./upgrade.sh`.

## 1. Create the database

In the [Neon console](https://console.neon.tech), create a project:

- **Region: the one nearest your server.** Every api request and every worker
  tick is a round trip to Postgres, so distance is added to all of them.
- **The Postgres version Neon offers by default is fine.** The bundled
  `postgres` service runs 17; the schema was built and upgraded on Neon's
  Postgres 18 as well. What the version does decide is which `pg_dump` you can
  use against it — see [Backups](#running-it).

The default database (`neondb`) and role (`neondb_owner`) are fine. Nothing needs
creating inside it: the `migrate` container builds the schema on first start.

## 2. Copy the direct connection string

Open **Connect** on the project dashboard and **switch "Connection pooling"
off**. The string you want has no `-pooler` in its host:

```text
postgresql://neondb_owner:<password>@ep-example-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

Use it as copied. Both query parameters work with the driver OpenAnalytics uses.

**Why not the pooled one.** Neon's pooler is PgBouncer in transaction mode:
several clients share one server connection, and session state does not reset
between them.

- The migration runner holds a session-level advisory lock for the length of a
  run, so that two starts can never migrate at once. Through the pooler that
  lock belongs to whichever server connection it happened to run on, which is
  not a lock.
- A `SET` from any client sticks to the shared connection and is inherited by
  the next one. The hosted service learned this in production: one diagnostic
  script ran `SET default_transaction_read_only = on` through the pooler, and
  the worker's writes began failing on the connections it had poisoned.

A pooler is also not needed. The api, the collector and the worker each keep one
connection pool of at most ten, so the whole install uses about thirty
connections at peak, well inside what a direct Neon endpoint accepts.

## 3. Generate the configuration

Exactly as in [SELF-HOSTING.md § 2](../../SELF-HOSTING.md#2-generate-the-configuration):

```sh
cd infra/selfhost
./generate-secrets.sh --domain example.com --email you@example.com --with-geoip
```

It writes a local Postgres password into `env/postgres.env` and into four URLs.
The next step replaces those URLs. `env/postgres.env` is then unused, and
harmless.

## 4. Point the four URLs at Neon

| File                | Variable                 |
| ------------------- | ------------------------ |
| `env/api.env`       | `DATABASE_URL`           |
| `env/collector.env` | `DATABASE_URL`           |
| `env/worker.env`    | `DATABASE_URL`           |
| `env/migrate.env`   | `POSTGRES_MIGRATION_URL` |

The same string in all four. Edit them by hand, or:

```sh
NEON_URL='postgresql://neondb_owner:<password>@ep-example-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
esc=$(printf '%s' "$NEON_URL" | sed 's/[&#\\]/\\&/g')
sed -i "s#^DATABASE_URL=.*#DATABASE_URL=$esc#" env/api.env env/collector.env env/worker.env
sed -i "s#^POSTGRES_MIGRATION_URL=.*#POSTGRES_MIGRATION_URL=$esc#" env/migrate.env
grep -c neon.tech env/api.env env/collector.env env/worker.env env/migrate.env   # 1 in each
```

The `esc` line matters: a Neon URL contains `&`, which `sed` would otherwise
replace with the text it matched.

## 5. Take `postgres` out of the stack

Add one line to `.env`:

```sh
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.neon.yml' >> .env
```

[`docker-compose.neon.yml`](docker-compose.neon.yml) moves the `postgres`
service behind a profile and stops `migrate` waiting for it. Put it in `.env`
rather than passing `-f` on the command line: `-f` stops compose from reading
`docker-compose.override.yml`, which holds your signing keys, and `.env` is also
what `upgrade.sh`, `snapshot.sh` and `rollback.sh` read.

Check it took effect. `postgres` must not be in the list:

```sh
docker compose config --services
```

It needs Docker Compose 2.24.4 or newer (`docker compose version`).

## 6. Bring it up

```sh
docker compose pull
docker compose up -d
docker compose logs -f migrate     # "migrate_finished" ... "applied":46 on an empty database
docker compose ps                  # no oa-postgres; everything else healthy
```

Then continue with [SELF-HOSTING.md § 4, Claim it](../../SELF-HOSTING.md#4-claim-it).
The Neon console's **Tables** view now shows the schema (`sites`, `users`,
`schema_migrations`, …).

## Running it

**Backups.** The `pg_dump` line in SELF-HOSTING.md's Backups section talks to
the local container and does not apply. Neon keeps your database's history, and
restoring to a point in time is a console action on the branch. For a copy that
is also off Neon, `pg_dump` works from any machine — but only one whose major
version is **at least the server's**. An older one refuses outright
(`aborting because of server version mismatch`), and the one inside the bundled
`postgres` image is 17. Running it from the image that matches your Neon
database avoids the question:

```sh
docker run --rm postgres:18-alpine pg_dump "$NEON_URL" | gzip > oa-pg-$(date +%F).sql.gz
```

(`18` for a Postgres 18 project; `SELECT version()` in Neon's SQL editor says
which you have.)

ClickHouse still needs the backup SELF-HOSTING.md describes; nothing about it
changed.

**Upgrades.** `./upgrade.sh` works as documented (v0.7.0 → v0.8.0 was run on
Neon this way). Its snapshot holds ClickHouse
and the configuration only, because Postgres is not on this host to copy, and
it prints the instant the stack stopped:

```text
snapshot: Postgres is not part of this stack — it is NOT in this snapshot
          nothing writes to it from now until the stack starts again;
          to go back, restore your provider's Postgres to 2026-09-25T18:40:12Z
```

Nothing writes to Postgres between that instant and the upgraded stack starting,
so that timestamp is the matching point for Postgres. `./rollback.sh` restores
ClickHouse and the configuration, then **stops with the stack down** and tells
you to restore the Neon branch to that timestamp before starting it. Starting
earlier would run the old images against the new schema. Your Neon plan's
restore window has to reach back that far; if you are unsure it will, create a
branch in the console just before upgrading.

**Expect the compute to stay active.** The worker queries Postgres continuously
(the job queue, the outbox, its heartbeat), so an OpenAnalytics database is
rarely idle long enough to scale to zero. Size your Neon plan for a compute that
runs all the time.

**Coolify and Dokploy.** This guide is written for the Docker Compose install.
The platform compose files spell the Postgres URL inline rather than in
`env/*.env`, so the same four variables have to change in the platform's
editor, and the `postgres` service has to be removed there. We have not walked
that path end to end yet.

## Moving an existing install to Neon

If you already run OpenAnalytics with the bundled Postgres, copy the data
across, then follow steps 4–6. The stack is down for as long as the copy takes;
for a control-plane database that is usually seconds to a few minutes.

```sh
cd infra/selfhost
docker compose stop api collector worker realtime gateway web

# Dumped by the local server's own pg_dump and restored with its psql, in one
# pipe. A dump restores into the same or a newer major version, so this works
# into Neon's Postgres 17 or 18 alike.
docker compose exec -T postgres pg_dump -U openanalytics --no-owner --no-privileges openanalytics \
  | docker compose exec -T postgres psql "$NEON_URL" -v ON_ERROR_STOP=1 -q
```

`--no-owner --no-privileges` because the objects are owned by `openanalytics`
locally and by `neondb_owner` on Neon. `ON_ERROR_STOP` so that a failure stops
the copy instead of leaving a half-restored database that looks complete. The
one `set_config` row it prints is the dump's own preamble, not an error.

Then stop the local Postgres, so nothing can write to the copy you are leaving:

```sh
docker compose stop postgres
```

Then steps 4 and 5, and `docker compose up -d`. The `migrate` container finds
every migration already applied and changes nothing (`"applied":0 … "already_applied":46`).

Keep the old `pg-data` volume until you have signed in and seen your sites. It
is outside the stack from then on, so `docker compose down -v` does not remove
it either; `docker volume rm openanalytics_pg-data` does, and is the one step
here that cannot be undone.
