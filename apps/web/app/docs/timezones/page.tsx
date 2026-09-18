import {
  DocArticle,
  DocLink,
  DocNote,
  DocSection,
  DocTable,
} from "@/components/docs/doc-prose";
import { docPage, docsMetadata } from "@/lib/docs";

const page = docPage("timezones");
export const metadata = docsMetadata(page);

export default function TimezonesDocsPage() {
  return (
    <DocArticle page={page}>
      <DocSection title="One clock per site, and a reader's own view">
        <p>
          Every site has exactly one reporting timezone, and everything about
          the site is counted on it. A reader can look at the same numbers on
          another clock without changing anything.
        </p>
        <DocTable
          head={["Clock", "Set where", "Governs"]}
          rows={[
            [
              "The site's reporting timezone",
              "Site Settings, General tab",
              "Every reading of the site: the dashboard, widgets, the public share page, and the answers the MCP server and the assistant give. Every site has one. A site created from the dashboard starts on the timezone of the browser that created it, one created through the API starts on UTC, and an owner or admin can change it at any time.",
            ],
            [
              "A reader's pick",
              "The timezone button in the dashboard header, or on the share page",
              "That reader's view only: the same data, cut on their clock. It is remembered for the tab and writes nothing, so nobody else's view moves.",
            ],
            [
              "Your account timezone",
              "Account, Preferences",
              "A fallback only, for the moment before a site's own timezone has loaded. It does not override the site's clock.",
            ],
          ]}
        />
      </DocSection>

      <DocSection title="Why the site owns the clock">
        <p>
          Today, this week and this month have to mean the same thing to
          everyone who reads a site, or two teammates comparing numbers are
          comparing different days. So the site declares its clock once, and
          widgets and share links, which cannot ask their reader anything, use
          it too. A reader who wants their own day can still switch the view
          from the header, with a picker that searches by country, city or
          timezone name.
        </p>
      </DocSection>

      <DocSection title="Every timezone works">
        <p>
          Any IANA timezone can be a reporting timezone, including the ones
          whose offset is not a whole hour, such as India (+05:30) and Nepal
          (+05:45). Days are assembled from fifteen-minute buckets, so a local
          midnight at half past or quarter to the hour is cut exactly, and
          daylight saving days come out 23 or 25 hours long, as they are.
        </p>
      </DocSection>

      <DocSection title="One clock that never moves">
        <DocNote>
          The anonymous visitor identifier rotates at UTC midnight
          everywhere, deliberately: letting a site pick the rotation clock
          would split visitors at local midnight and make sites comparable
          by their timezone choice. Reporting clocks change how numbers are
          bucketed, never how people are counted. Details under{" "}
          <DocLink slug="privacy">Privacy and consent</DocLink>.
        </DocNote>
      </DocSection>
    </DocArticle>
  );
}
