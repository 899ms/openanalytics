"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useAnalyticsInterval } from "@/components/dashboard/interval-context";
import { Skeleton } from "@/components/ui/skeleton";
import { TimezoneSelect } from "@/components/ui/timezone-select";

/**
 * The clock a board reports in, worn in its header: the zone every window on
 * the page is cut in, and the way to look at the same site on another one.
 *
 * Written for the public share board, and on the private dashboard's overview
 * too since ADR-0079 D5: the two answer the same question the same way, the
 * site's reporting zone by default, a reader's own pick on top. On the
 * private side it is header-mounted beside the site switcher, the way the
 * share board wears it beside the site's identity, desktop only, and on the
 * overview alone (Abbas, 2026-09-03): that is the one private screen whose
 * windows are cut in this clock, and a clock over a screen with no windows
 * would be naming nothing. It is a *view*, not a setting: the pick lasts the
 * visit and writes nothing. The site's own clock is changed in Settings →
 * General, where changing it changes it for everybody.
 *
 * The shared `TimezoneSelect` in its header dress — country-aware search
 * included, so "US" or "Türkiye" finds a clock without IANA spelling.
 *
 * Rendered only after hydration: its value can default through the viewer's
 * browser zone, which the server cannot know — a server-rendered value would
 * be the host's clock and a hydration mismatch.
 */

/** Never fires: `useSyncExternalStore` only needs it to read the snapshot. */
const hydrationSubscribe = () => () => {};

/**
 * Where the dashboard header holds the overview's clock.
 *
 * The header is rendered by the dashboard layout, above every page and
 * outside any page's `IntervalProvider`, so it cannot read the clock itself.
 * It offers this slot instead, and the one page whose windows are cut in that
 * clock paints the pill into it (`HeaderTimezonePill`). Empty on every other
 * page, and the slot hides itself while empty.
 */
export const HEADER_CLOCK_SLOT_ID = "dashboard-header-clock";

const readSlot = () => document.getElementById(HEADER_CLOCK_SLOT_ID);
const readSlotServer = () => null;

/**
 * The overview's clock, painted into the header's slot from inside the page's
 * own provider.
 *
 * A portal rather than a store, because everything the pill needs, the
 * resolved zone, the pick and whether the site's clock is known yet, already
 * lives on the provider this is rendered under; lifting that state to the
 * layout would have given it a second owner. The slot is looked up through
 * `useSyncExternalStore` for the same reason the pill itself waits for
 * hydration: the server has no document, so the portal opens on the client's
 * first pass after it, and the element is stable from then on because the
 * header outlives every page under it.
 */
export function HeaderTimezonePill() {
  const { timezone, setTimezone, zonePending } = useAnalyticsInterval();
  const slot = React.useSyncExternalStore(
    hydrationSubscribe,
    readSlot,
    readSlotServer
  );
  if (slot === null) return null;
  return createPortal(
    <TimezonePill onPick={setTimezone} pending={zonePending} value={timezone} />,
    slot
  );
}

export function TimezonePill({
  value,
  onPick,
  pending = false,
}: {
  value: string;
  onPick: (zone: string) => void;
  /**
   * True while the board's clock is still being resolved. `value` is a real
   * zone throughout — the chain always answers — but while the site's own is
   * unknown it is a stand-in, and a pill that says "Europe/Istanbul" and then
   * says "Asia/Kolkata" a moment later has told the reader something untrue
   * about the numbers they were looking at. A placeholder says the honest
   * thing, and the panels are holding for the same answer anyway.
   */
  pending?: boolean;
}) {
  const hydrated = React.useSyncExternalStore(
    hydrationSubscribe,
    () => true,
    () => false
  );
  if (!hydrated) return null;

  return (
    <div className="hidden min-w-0 sm:block">
      {pending ? (
        // Trigger-sized, so settling swaps a word in rather than moving the
        // header around it.
        <Skeleton className="h-7 w-28 rounded-full" />
      ) : (
        <TimezoneSelect
          ariaLabel="Timezone the dashboard reports in"
          onPick={(zone) => {
            // No `nullLabel` is offered, so `null` cannot arrive; the guard
            // is for the type, not a case.
            if (zone !== null) onPick(zone);
          }}
          value={value}
          variant="header"
        />
      )}
    </div>
  );
}
