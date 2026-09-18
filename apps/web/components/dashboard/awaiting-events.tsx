"use client";

import { Alert02Icon, CheckmarkCircle02Icon } from "hugeicons-react";
import { AnimatePresence, motion } from "motion/react";
import { useParams } from "next/navigation";
import * as React from "react";
import { InstallOptions } from "@/components/dashboard/install-options";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SquircleSurface } from "@/components/ui/squircle-card";
import {
  LIVE_API,
  keys as apiKeys,
  presentError,
  resolveSiteSlugCached,
  sites,
  trackerSnippet,
  type SiteSummary,
} from "@/lib/api";
import {
  allowableDomain,
  newestSighting,
  sightingHost,
  sightingKind,
  type TagSighting,
  cleanDomain,
} from "@/lib/site-domain";

/**
 * What a site that has never received an event says, instead of nothing.
 *
 * A dashboard of zeros is ambiguous in the worst way: it reads the same as a
 * quiet week, and the two want opposite things from the reader. The first one
 * has a cause and a fix, and the board should name both.
 *
 * It is a badge beside the heading rather than a strip across the top: the
 * state is one most sites leave within a minute, and a strip would push every
 * card down and could only afford one sentence for two different people
 * (nothing installed, and installed but idle). The badge costs no layout, says
 * the state in two words, and puts the rest behind a click — where there is
 * room to show the install itself rather than link to it.
 *
 * The signal is `first_event_at` (ADR-0027), the same one onboarding's verify
 * watches and the getting-started checklist binds its install row to. It is
 * *ever*, not *lately*: once an event has landed this is gone for good, so a
 * site with real history and an empty range is never told to check its
 * install. That is why it reads the site rather than an analytics query, whose
 * empty answer cannot tell an uninstalled tracker from a quiet afternoon.
 *
 * It never renders against the built-in mock data (`LIVE_API` off), where the
 * numbers are samples and "waiting for events" would be a lie about a board
 * full of them.
 */

/** Slow on purpose: someone is pasting a snippet, not watching a stopwatch. */
const POLL_MS = 15_000;
/**
 * About five minutes of polling, then it stops and the badge simply stays. A
 * tab left open overnight is not a reason to keep asking, and a reload is the
 * honest way to re-check.
 */
const POLL_TRIES = 20;

const SPRING = { type: "spring", stiffness: 550, damping: 38 } as const;

/** The dashboard's own pill. */
const PILL =
  "flex cursor-pointer items-center gap-2 rounded-full bg-card py-1 pl-2.5 pr-3 text-xs font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Has this site ever received an event, and what does it need if not.
 *
 * `awaiting` is `null` until the first read lands, and the difference matters
 * to both callers: the badge must not flash before it knows, and the gate must
 * not blank a working board while it finds out.
 */
function useAwaitingEvents() {
  const params = useParams<{ site?: string }>();
  const slug = params.site ? decodeURIComponent(params.site) : "";

  /** `null` while unknown: the badge must not flash before the read lands. */
  const [site, setSite] = React.useState<SiteSummary | null>(null);
  const [awaiting, setAwaiting] = React.useState<boolean | null>(null);
  const [publicToken, setPublicToken] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!LIVE_API || slug === "") return;
    let cancelled = false;
    let tries = 0;
    let timer: number | undefined;

    const probe = async () => {
      try {
        const { site_id } = await resolveSiteSlugCached(slug);
        const found = await sites.get(site_id);
        if (cancelled) return;
        setSite(found);
        const landed = found.first_event_at !== null;
        setAwaiting(!landed);
        if (landed) return;
      } catch {
        // A failed read says nothing about the install, so it shows nothing.
        if (cancelled) return;
        setAwaiting(false);
      }
      tries += 1;
      if (tries < POLL_TRIES)
        timer = window.setTimeout(() => void probe(), POLL_MS);
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [slug]);

  /**
   * The site key, fetched when the badge appears rather than when the modal
   * opens. `InstallOptions` prints the key and the snippet built from it, and
   * neither is worth showing half-written: a blank key in a code block reads
   * as a broken install rather than as a pending request. Only sites with no
   * events ever ask for it, and they are exactly the sites whose owner is
   * about to want it.
   */
  const siteId = site?.site_id;
  React.useEffect(() => {
    if (awaiting !== true || siteId === undefined) return;
    let cancelled = false;
    apiKeys.list(siteId).then(
      (page) => {
        if (cancelled) return;
        const key = page.items.find(
          (entry) => entry.type === "tracking_write" && entry.public_token
        );
        setPublicToken(key?.public_token ?? null);
      },
      () => {
        // Without a key the modal shows everything except the snippet.
      }
    );
    return () => {
      cancelled = true;
    };
  }, [awaiting, siteId]);

  return { awaiting, publicToken, site };
}

/**
 * The badge beside the overview's heading.
 */
export function AwaitingEventsBadge() {
  const { awaiting, publicToken, site } = useAwaitingEvents();
  const [open, setOpen] = React.useState(false);
  // Read on every poll tick, so the pill changes the moment a tag loads
  // somewhere, whether or not anybody opens the modal.
  const sighting = newestSighting(site);

  if (awaiting !== true) return null;

  return (
    <>
      <motion.button
        animate={{ opacity: 1, scale: 1 }}
        className={PILL}
        initial={{ opacity: 0, scale: 0.96 }}
        onClick={() => setOpen(true)}
        transition={SPRING}
        type="button"
      >
        <Spinner className="size-3 text-muted-foreground" />
        <span>Waiting for events</span>
        {sighting === null ? null : (
          <>
            <span aria-hidden="true" className="h-3 w-px bg-border" />
            <SightingMark sighting={sighting} />
          </>
        )}
        <span aria-hidden="true" className="h-3 w-px bg-border" />
        <span className="text-muted-foreground">See more</span>
      </motion.button>

      <AnimatePresence>
        {open ? (
          <InstallHelpModal
            onClose={() => setOpen(false)}
            publicToken={publicToken}
            site={site}
          />
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * What Realtime and Funnels show before a single event has arrived.
 *
 * Both screens are honest but useless in that state, and each is useless in
 * its own way: Realtime draws an empty room that looks exactly like a quiet
 * minute, and Funnels invites someone to define a funnel over pages the
 * product has never seen, which can only ever compute zeros. Neither is a
 * failure and neither deserves an error, so this is a waiting room rather than
 * a wall: it says what has not happened yet, what will happen when it does,
 * and offers the same install panel the overview's badge does.
 *
 * The board renders while the answer is unknown. Sites that have events are
 * every site after the first minute, and making all of them wait for a read
 * they will pass would be the wrong trade for the few seconds this catches.
 */
export function FirstEventGate({
  children,
  surface,
}: {
  children: React.ReactNode;
  surface: "realtime" | "funnels";
}) {
  const { awaiting, publicToken, site } = useAwaitingEvents();
  const [open, setOpen] = React.useState(false);

  if (awaiting !== true) return <>{children}</>;

  const host = cleanDomain(site?.domains[0] ?? "") ?? "your site";
  // The second install signal (ADR-0081 D3): where the tag has been seen
  // fetching its configuration, which exists exactly when `first_event_at`
  // cannot. It rides the same poll, so a sighting that lands mid-wait replaces
  // the generic line at the next tick without anything else changing.
  const sighting = newestSighting(site);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
      >
        <Spinner className="size-5 text-muted-foreground" />
      </span>
      {/* The heading is the same in every shape; only the sentence under it
          knows anything, so the live region is this block rather than the
          page: a poll that learns something announces one sentence. */}
      <div aria-live="polite">
        <h2 className="text-base font-medium tracking-tight">
          Waiting for the first event
        </h2>
        {sighting === null ? (
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
            Nothing has reached us from{" "}
            <span className="font-medium text-foreground">{host}</span> yet.
            Check that the tracker is installed
            {surface === "realtime"
              ? "; the moment an event lands, everyone on your site shows up here as they arrive."
              : "; once events start arriving, you can build funnels from the pages and events they bring."}
          </p>
        ) : (
          <GateSighting site={site} sighting={sighting} />
        )}
      </div>
      <Button onClick={() => setOpen(true)} size="sm" variant="secondary">
        Check the install
      </Button>

      <AnimatePresence>
        {open ? (
          <InstallHelpModal
            onClose={() => setOpen(false)}
            publicToken={publicToken}
            site={site}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * What the gate says once the collector has seen the tag (ADR-0081, D4).
 *
 * Three sentences, and the difference between them is the whole point of the
 * sighting: the tag is on a page that counts, the tag is on the developer's own
 * machine, or the tag is on a host this site's allowlist excludes. The last of
 * those is one press from fixed, and until now it was indistinguishable from
 * "you have not installed anything" — the same waiting screen, for days.
 *
 * It keeps the gate's typography exactly: one muted paragraph under the
 * heading, the host in the foreground weight, and anything actionable below it
 * rather than inside the sentence.
 *
 * `allowed` is never recomputed here. It is the collector's verdict from the
 * moment of the sighting, so this screen cannot tell somebody their origin
 * counts while the ingest gate refuses it.
 */
function GateSighting({
  compact = false,
  site,
  sighting,
}: {
  /**
   * The install modal's typography rather than the gate's: the same three
   * sentences, in the size the panel around them uses. The overview is the
   * screen most people are on while they wait, and the badge's modal is the
   * only waiting copy it shows, so it must know what the gate knows
   * (ADR-0081, D4).
   */
  compact?: boolean;
  site: SiteSummary | null;
  sighting: TagSighting;
}) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  /**
   * The allowlist has the host now, and the sighting does not know yet.
   *
   * `allowed` is decided by the collector when the tag fetches configuration,
   * which happens on the next page load — so the poll keeps returning the old
   * verdict until the person reloads their site. Saying "added, now reload" is
   * the only honest thing between those two moments; the alternative is a
   * screen that looks unchanged after a successful press.
   */
  const [added, setAdded] = React.useState(false);

  const host = sightingHost(sighting.origin) ?? "";
  const kind = sightingKind(sighting);
  // A site may carry several domains; the first is the one its own screens
  // show, and it is the one whose traffic the reader is waiting for.
  const firstDomain = cleanDomain(site?.domains[0] ?? "") ?? "your domain";
  const domain = allowableDomain(sighting.origin);

  const allow = () => {
    if (busy || site === null || domain === null) return;
    setBusy(true);
    setFailed(null);
    // A replace-set PATCH: the list sent is the list stored, so the existing
    // domains travel with it. Deduped because an allowlist that carries the
    // same host twice is a write nobody meant to make.
    const domains = site.domains.includes(domain)
      ? site.domains
      : [...site.domains, domain];
    sites.update(site.site_id, { domains }).then(
      () => {
        setBusy(false);
        setAdded(true);
      },
      (raised: unknown) => {
        setBusy(false);
        setFailed(presentError(raised).body);
      }
    );
  };

  // A callout, not a sentence in the running copy: the first live test read
  // the console line at once and walked straight past the same words set in
  // muted grey. The refused shapes are warnings — the tag is installed and
  // nothing will ever count from here — and the allowed one is the good news
  // the wait was for, so each wears the colour the rest of the product uses
  // for that.
  const tone = SIGHTING_TONE[kind === "allowed" ? "allowed" : "refused"];
  const Icon = kind === "allowed" ? CheckmarkCircle02Icon : Alert02Icon;
  const line = compact
    ? `text-xs leading-5 ${tone.text}`
    : `text-sm leading-6 ${tone.text}`;
  const strong = "font-semibold";

  let body: React.ReactNode;
  if (kind === "allowed") {
    body = (
      <p className={line}>
        The tag has loaded on <span className={strong}>{host}</span>. The first
        event is on its way, usually within seconds.
      </p>
    );
  } else if (kind === "local") {
    body = (
      <p className={line}>
        The tag has loaded on <span className={strong}>{host}</span>. Visits
        from a local host aren&apos;t counted while the site has an allowed
        domain, and localhost can&apos;t be added. Open the site at{" "}
        <span className={strong}>{firstDomain}</span> to see data.
      </p>
    );
  } else {
    body = (
      <>
        <p className={line}>
          {added ? (
            <>
              <span className={strong}>{host}</span> is on this site&apos;s
              allowed domains now.
            </>
          ) : (
            <>
              The tag has loaded on <span className={strong}>{host}</span>,
              which isn&apos;t on this site&apos;s allowed domains.
            </>
          )}
        </p>
        {added || domain === null ? null : (
          <Button
            className="mt-2.5"
            disabled={busy}
            loading={busy}
            onClick={allow}
            size="sm"
            variant="secondary"
          >
            Allow this domain
          </Button>
        )}
        {domain === null ? null : (
          // The collector decides `allowed` when the tag fetches its
          // configuration, and the browser keeps that response for five
          // minutes (`max-age=300`; the tracker's own cache matches), so a
          // reload inside that window can still carry the old list. "Once"
          // would promise a reload the cache may ignore.
          <p className={`mt-1.5 text-xs leading-4 ${tone.text}`}>
            Then reload your site. The tag picks the change up within about
            five minutes.
          </p>
        )}
        {failed === null ? null : (
          <p className="mt-1.5 text-xs text-destructive-foreground">
            {failed}
          </p>
        )}
      </>
    );
  }

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-left ${tone.bg} ${
        compact ? "" : "mx-auto mt-3 w-full max-w-sm"
      }`}
      role="status"
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${tone.text}`}
      />
      <div className="flex min-w-0 flex-col items-start">{body}</div>
    </div>
  );
}

/**
 * The two colours a sighting can wear, from the product's own tokens: the
 * warning pair the usage panel uses when collection has stopped, and the
 * success pair the onboarding tick uses. A refused sighting *is* collection
 * that has stopped before it started.
 */
const SIGHTING_TONE = {
  allowed: { bg: "bg-success/10", text: "text-success-foreground" },
  refused: { bg: "bg-warning/10", text: "text-warning-foreground" },
} as const;

/**
 * The badge's own word about the sighting, so the overview says it without
 * the modal being opened: one icon and the host, in the sighting's colour,
 * between "Waiting for events" and "See more".
 */
function SightingMark({ sighting }: { sighting: TagSighting }) {
  const host = sightingHost(sighting.origin) ?? "";
  const tone = SIGHTING_TONE[sighting.allowed ? "allowed" : "refused"];
  const Icon = sighting.allowed ? CheckmarkCircle02Icon : Alert02Icon;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${tone.text}`}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="max-w-36 truncate">{host}</span>
    </span>
  );
}

/**
 * The badge's other half: onboarding's install step, in onboarding's card,
 * over the dashboard.
 *
 * Deliberately the same frame — grey shell, header strip, white inset, footer
 * strip — and deliberately the same component inside it (`InstallOptions`, the
 * CLI and snippet tabs). Somebody who reaches this modal has already met that
 * panel once, minutes earlier, and a second, differently-shaped account of the
 * same install would read as a different instruction rather than the same one
 * repeated.
 *
 * The two sentences at the top are the two people who arrive here: one has not
 * installed anything, the other has and is looking at zeros. The strip this
 * replaced had to serve both in one line and served neither well.
 *
 * The key arrives as a prop, already fetched: see the badge.
 */
function InstallHelpModal({
  onClose,
  publicToken,
  site,
}: {
  onClose: () => void;
  publicToken: string | null;
  site: SiteSummary | null;
}) {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A site may carry several domains; the first is the one its own screens
  // show, and it is the one whose traffic the reader is waiting for.
  const host = cleanDomain(site?.domains[0] ?? "") ?? "your site";
  // Refreshed by the badge's poll behind this modal, so a tag that loads
  // while the panel is open shows up at the next tick.
  const sighting = newestSighting(site);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/40"
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        initial={{ opacity: 0 }}
        onClick={onClose}
      />

      <motion.div
        animate={{ opacity: 1, scale: 1, y: 0 }}
        aria-label="Waiting for your first event"
        aria-modal="true"
        className="relative w-full max-w-md"
        exit={{ opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }}
        initial={{ opacity: 0, scale: 0.94, y: -6 }}
        role="dialog"
        transition={SPRING}
      >
        {/* The shadow lives on this unclipped wrapper — a squircle clip-path
            cannot clip a box shadow, and carrying it on the surface leaks grey
            past the bottom corners. */}
        <div className="rounded-[26px] shadow-[0_1px_2px_rgba(0,0,0,0.06),0_24px_60px_rgba(0,0,0,0.18)] sm:rounded-[50px]">
          <SquircleSurface className="flex flex-col rounded-[26px] border border-border bg-[#f6f6f6] p-1 [--card-clip-handle:2.25px] [--card-clip-radius:14px] sm:rounded-[50px] sm:[--card-clip-handle:3px] sm:[--card-clip-radius:20px]">
            <div className="flex h-9 items-center justify-between pl-3.5 pr-3">
              <span className="text-sm font-medium text-foreground/80">
                No events yet
              </span>
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>

            <SquircleSurface className="flex flex-col gap-3 rounded-[22px] border border-border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:12px] sm:rounded-[44px] sm:[--card-clip-radius:17px]">
              {sighting === null ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  Nothing has reached us from{" "}
                  <span className="font-medium text-foreground">{host}</span>{" "}
                  yet. If the tracker is not installed, the two ways to do it
                  are below. If it is, open your site and browse for a few
                  seconds: the first pageview lands within seconds of it.
                </p>
              ) : (
                <div aria-live="polite">
                  <GateSighting compact site={site} sighting={sighting} />
                </div>
              )}

              {publicToken === null ? (
                // The rare case: clicked before the key landed, or a site
                // whose key list refused. The panel's own shape, held.
                <div
                  aria-hidden="true"
                  className="h-49 animate-pulse rounded-xl bg-secondary/50"
                />
              ) : (
                <InstallOptions
                  host={host}
                  publicToken={publicToken}
                  snippet={trackerSnippet(publicToken)}
                />
              )}
            </SquircleSurface>

            <div className="flex h-12 items-center justify-end gap-2 pb-1 pl-3.5 pr-1 pt-1">
              <Button onClick={onClose} size="xs" variant="secondary">
                Close
              </Button>
              <Button
                render={
                  <a href="/docs/install" rel="noreferrer" target="_blank" />
                }
                size="xs"
              >
                Read the docs
              </Button>
            </div>
          </SquircleSurface>
        </div>
      </motion.div>
    </div>
  );
}
