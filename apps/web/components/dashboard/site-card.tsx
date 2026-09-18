"use client";

import { ArrowRight01Icon as ChevronRight } from "hugeicons-react";
import Link from "next/link";
import * as React from "react";
import { SiteMark } from "@/components/dashboard/site-favicon";
import { Sparkline } from "@/components/dither-kit/sparkline";
import { Button } from "@/components/ui/button";
import { SquircleSurface } from "@/components/ui/squircle-card";
import type { SiteListItem, SiteRole, SiteStatus } from "@/lib/api";
import { monotoneSampler } from "@/lib/poster/overview-poster";
import { cn } from "@/lib/utils";

/**
 * Site card in the overview-card anatomy: squircle frame with the site's
 * mark and name in the top strip, and on the inset grey panel the site's
 * all-time figures, the shape of its traffic, and its domain and role.
 *
 * Figures first, on the numbers `GET /v1/sites` carries (ADR-0080):
 * `all_time` visitors, pageviews and revenue, and a `sparkline` of weekly
 * unique visitors. Nothing is fetched per card; the list read is the whole
 * source, and it is cached about five minutes server-side, so the card never
 * claims to be live.
 *
 * **`null` is not zero.** `all_time` and `sparkline` are `null` together when
 * the figures were not computed for this response (the gateway did not
 * answer, a suspended site); then the card shows no figures at all and the
 * dot keeps saying what the status says. Zero is a measurement: a site whose
 * `first_event_at` is `null` arrives with zeros and an empty sparkline, and
 * that is the waiting state, amber and still.
 *
 * **Revenue is a figure only for an owner of a site with a provider
 * connected**; everywhere else it is `null`, and the card prints two figures
 * rather than a dash. Amounts are minor units of the site's reporting
 * currency and are scaled by the currency's own exponent, never `/ 100`.
 *
 * The sparkline is weekly unique visitors, oldest first, at most forty
 * points, the last one the current, still filling, week. It starts where the
 * site's data starts, so a short series is a young site, not a gap. Its
 * points sum to more than `all_time.visitors` (weekly uniques against an
 * all-time merge), and that is correct. Weeks are UTC ISO weeks, not the
 * site's reporting zone, which is why the line carries no dates and no
 * tooltip (ADR-0080 D3).
 */

const STATUS: Record<SiteStatus, { dot: string; label: string; pulse: boolean }> =
  {
    active: { dot: "bg-success", label: "Active", pulse: true },
    suspended: {
      dot: "bg-destructive",
      label: "Billing blocked",
      pulse: false,
    },
    deleting: { dot: "bg-muted-foreground/50", label: "Deleting", pulse: false },
    deleted: { dot: "bg-muted-foreground/50", label: "Deleted", pulse: false },
  };

/**
 * An active site that has never been seen by the pipeline. `first_event_at`
 * is the install-verified signal (ADR-0027): required-and-nullable, filled
 * once per site ever, so `null` states plainly that no event has ever
 * arrived. Amber and still, because a green pulse would claim traffic that
 * does not exist. Its figures are real zeros and its sparkline is empty.
 */
const WAITING = { dot: "bg-warning", label: "Waiting for data", pulse: false };

const ROLE: Record<SiteRole, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Viewer",
};

/* Figures ---------------------------------------------------------------- */

const COMPACT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 12.4K, 1.2M: the card has no room for the commas. */
function compact(value: number): string {
  return COMPACT.format(value);
}

/**
 * $8.1K, ¥1.2M: money in the same compaction, from minor units.
 *
 * The exponent is asked of `Intl` on a plain currency formatter, the way
 * `formatMoney` (currencies.ts) asks it: JPY has no minor unit and KWD has
 * three, so `minor / 100` would be wrong for both. A compact formatter cannot
 * answer that question, its fraction digits are the display's, so two
 * formatters it is. A code the runtime does not know falls back to the bare
 * number and the code rather than throwing the card away.
 */
function compactMoney(minor: number, currency: string): string {
  try {
    const digits =
      new Intl.NumberFormat("en", { style: "currency", currency })
        .resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(minor / 10 ** digits);
  } catch {
    return `${compact(minor)} ${currency}`;
  }
}

/** The series on the poster's own curve, dense enough for the kit's fill. */
function densify(series: readonly number[], per = 4): number[] {
  if (series.length < 2) return [...series];
  const sample = monotoneSampler(series);
  const last = series.length - 1;
  const count = last * per + 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(sample((i / (count - 1)) * last));
  return out;
}

/** A figure with its label. */
function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className="text-lg font-medium tabular-nums tracking-tight text-foreground">
        {value}
      </span>
      <span className="text-sm font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * The weekly visitors line, on the kit's dither with a low glow. Every card's
 * line is the house blue: a hue of each site's own made the grid read as a
 * colour chart rather than as one product.
 */
function Spark({ series }: { series: readonly number[] }) {
  const data = React.useMemo(() => densify(series), [series]);
  // One week is a point, not a line; the floor stands in until there are two.
  if (data.length < 2) return <Baseline />;
  return (
    <div className="relative mt-1 h-9">
      <Sparkline
        bloom="low"
        className="h-full w-full"
        color="blue"
        data={data}
        variant="gradient"
      />
    </div>
  );
}

/** What stands where the line would: a dotted floor, nothing to draw yet. */
function Baseline() {
  return (
    <div className="relative mt-1 h-9">
      <div className="absolute inset-x-0 bottom-1 border-b border-dotted border-muted-foreground/30" />
    </div>
  );
}

/* The card ---------------------------------------------------------------- */

export function SiteCard({ site }: { site: SiteListItem }) {
  const waiting = site.status === "active" && site.first_event_at === null;
  const status = waiting ? WAITING : STATUS[site.status];
  const [primaryDomain, ...otherDomains] = site.domains;
  // Both are null together when the figures were not computed for this
  // response; read defensively all the same, an older list shape has neither.
  const totals = waiting ? null : (site.all_time ?? null);
  const sparkline = waiting ? null : (site.sparkline ?? null);

  return (
    <SquircleSurface
      className={cn(
        "group relative flex flex-col rounded-[24px] border border-border p-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:13px] sm:rounded-[30px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:17px]",
        "transition-colors duration-300 active:scale-[0.99]"
      )}
    >
      {/* top strip — status dot, the site's mark and name, then the chevron
          or, for a site with no data yet, the way to fix that */}
      <div className="flex items-center justify-between gap-3 pb-1.5 pl-3.5 pr-3 pt-1">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              status.dot,
              status.pulse && "bp-pulse",
            )}
          />
          {/* the fastest way to recognise a card is the icon the site puts
              in a browser tab */}
          <SiteMark
            className="size-4 rounded-[5px]"
            domain={primaryDomain}
            name={site.name}
          />
          {/* The card's link is the site name, stretched over the whole card
              by a pseudo-element — so the install shortcut below can be a
              real link of its own instead of a button nested inside one.
              `z-10` matters: the inset panel underneath is `relative`, and
              without it the overlay would sit below the panel and only the
              top strip would be clickable. */}
          <Link
            className="truncate text-sm font-medium text-foreground/80 outline-none before:absolute before:inset-0 before:z-10 before:rounded-[24px] focus-visible:before:ring-2 focus-visible:before:ring-ring sm:before:rounded-[30px]"
            // URLs carry the public slug, never the internal site_id.
            href={`/dashboard/${encodeURIComponent(site.slug)}`}
          >
            {site.name}
          </Link>
        </span>
        {/* Only for someone who can act on it: the install screen reads the
            site key, which needs `credentials:manage` — a viewer following
            this would land on a 403. Their dot still says amber. */}
        {waiting && site.role !== "viewer" ? (
          // Above the stretched overlay (z-20), so this is the one spot on
          // the card that goes somewhere else.
          <Button
            className="relative z-20 shrink-0 text-warning-foreground hover:bg-warning/10 hover:text-warning-foreground"
            render={
              <Link
                href={`/dashboard/${encodeURIComponent(site.slug)}/settings?tab=installation`}
              >
                See installation
              </Link>
            }
            size="xs"
            variant="ghost"
          />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-primary" />
        )}
      </div>

      {/* inset panel — the figures and their line, or what honestly stands
          in for them, then the domain and the role as a footer */}
      <SquircleSurface className="flex-1 overflow-hidden rounded-[20px] border border-border bg-[#f6f6f6] shadow-[0_1px_2px_rgba(0,0,0,0.06)] [--card-clip-radius:11px] sm:rounded-[26px] sm:[--card-clip-handle:2.5px] sm:[--card-clip-radius:14px]">
        {waiting ? (
          <div className="flex h-12 items-center px-4 pt-3">
            <span className="text-xs text-warning-foreground">
              Waiting for the first event
            </span>
          </div>
        ) : totals === null ? (
          // No figures in this response: the site's identity holds the
          // space, and nothing here reads as a number.
          <div className="flex h-12 items-center px-4 pt-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {primaryDomain ?? "No domain set"}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {site.slug}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-6 px-4 pt-3">
            <Figure label="Visitors" value={compact(totals.visitors)} />
            <Figure label="Pageviews" value={compact(totals.pageviews)} />
            {totals.revenue !== null ? (
              <Figure
                label="Revenue"
                value={compactMoney(
                  totals.revenue.net_minor,
                  totals.revenue.currency
                )}
              />
            ) : null}
          </div>
        )}

        {sparkline !== null ? (
          <Spark series={sparkline} />
        ) : (
          <Baseline />
        )}

        <div className="flex items-baseline justify-between gap-2 px-4 pb-3 pt-1 text-xs">
          <span className="truncate text-muted-foreground">
            {primaryDomain
              ? otherDomains.length > 0
                ? `${primaryDomain} +${otherDomains.length}`
                : primaryDomain
              : // An empty allowlist is not "unknown": the collector reads
                // it as "accept any origin", so saying nothing would mislead.
                "Accepts any origin"}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {ROLE[site.role]}
            {site.is_billing_owner ? " · Billing" : ""} · {status.label}
          </span>
        </div>
      </SquircleSurface>
    </SquircleSurface>
  );
}
