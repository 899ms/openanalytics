"use client";

import * as React from "react";
import type { SiteSummary } from "@/lib/api";

/**
 * The site every `/dashboard/[site]` screen is about, read once.
 *
 * `SiteLifecycleGate` already fetches this summary on every screen under the
 * segment — it has to, since `deleting` and `suspended` replace the screen —
 * so the answer is published here rather than fetched a second time by
 * whoever else needs a fact from it. Today that is the interval provider,
 * which needs `reporting_timezone` before it can cut a single window
 * (ADR-0079 D5).
 *
 * `phase` is the part callers cannot do without: "no zone yet" and "no zone
 * configured" are different answers, and a screen that treats the first as the
 * second cuts its first range in the wrong clock and refetches every panel a
 * moment later.
 */
export type SiteSummaryState = {
  /**
   * Re-reads the site behind this screen.
   *
   * Settings → General writes `reporting_timezone`, and the gate that holds
   * this read sits in a layout that outlives the walk from settings back to
   * the overview — so nothing else would ever refetch it, and the panels
   * would go on cutting their windows in the zone the site no longer uses
   * (ADR-0079 D5). Off the site segment there is nothing to re-read and this
   * does nothing.
   */
  readonly reload: () => void;
} & (
  | { readonly phase: "loading"; readonly site: null }
  | { readonly phase: "settled"; readonly site: SiteSummary | null }
);

/** Off the segment there is no site and never will be — settled, and empty. */
const NO_SITE: SiteSummaryState = {
  phase: "settled",
  site: null,
  reload: () => {},
};

const SiteSummaryContext = React.createContext<SiteSummaryState>(NO_SITE);

export function SiteSummaryProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: SiteSummaryState;
}) {
  return (
    <SiteSummaryContext.Provider value={value}>
      {children}
    </SiteSummaryContext.Provider>
  );
}

/**
 * The screen's site. Outside the site segment — settings panels reused on the
 * account screens, the sites grid — this answers "settled, and there is no
 * site", so a caller never waits for something nobody is fetching.
 */
export function useSiteSummary(): SiteSummaryState {
  return React.useContext(SiteSummaryContext);
}
