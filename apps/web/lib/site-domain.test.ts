import { describe, expect, it } from "vitest"

import {
  allowableDomain,
  cleanDomain,
  isLocalHost,
  newestSighting,
  sightingHost,
  sightingKind,
  type TagSighting,
} from "./site-domain"

/**
 * The rules the two waiting screens share about a sighting (ADR-0081, D4).
 *
 * Lives beside the module and runs under the `web` vitest project, which is
 * the one place a test of `apps/web` code can be typechecked the way the app
 * is compiled (see the project"s note in `vitest.config.ts`).
 */

const row = (
  origin: string,
  allowed: boolean,
  seen_at = "2026-09-14T10:00:00.000Z",
): TagSighting => ({
  origin,
  seen_at,
  allowed,
})

describe("cleanDomain", () => {
  it("takes a bare hostname with at least one dot, lowercased", () => {
    expect(cleanDomain("Example.com")).toBe("example.com")
    expect(cleanDomain("https://www.example.com/path?q=1")).toBe("www.example.com")
    expect(cleanDomain("example.com.")).toBe("example.com")
  })

  it("refuses a single label, so localhost can never be listed", () => {
    expect(cleanDomain("localhost")).toBeNull()
    expect(cleanDomain("intranet")).toBeNull()
    expect(cleanDomain("")).toBeNull()
  })

  it("refuses a port and a leading or trailing hyphen", () => {
    expect(cleanDomain("example.com:3000")).toBeNull()
    expect(cleanDomain("-bad.example.com")).toBeNull()
    expect(cleanDomain("bad-.example.com")).toBeNull()
  })
})

describe("isLocalHost", () => {
  it.each(["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "::1", "[::1]"])(
    "treats %s as the developer machine",
    (host) => {
      expect(isLocalHost(host)).toBe(true)
    },
  )

  it.each(["example.com", "localhost.example.com", "notlocalhost", "127.0.0.2", "10.0.0.5"])(
    "does not treat %s as local",
    (host) => {
      expect(isLocalHost(host)).toBe(false)
    },
  )
})

describe("sightingHost", () => {
  it("prints the host with its port, which is what the address bar shows", () => {
    expect(sightingHost("http://localhost:3000")).toBe("localhost:3000")
    expect(sightingHost("https://my-app.vercel.app")).toBe("my-app.vercel.app")
    expect(sightingHost("http://[::1]:5173")).toBe("[::1]:5173")
  })

  it("has nothing to print for a request that carried no Origin, or garbage", () => {
    expect(sightingHost("(none)")).toBeNull()
    expect(sightingHost("not an origin")).toBeNull()
    expect(sightingHost("")).toBeNull()
  })
})

describe("newestSighting", () => {
  it("is null for a field that was not computed, and for an empty list", () => {
    expect(newestSighting(undefined)).toBeNull()
    expect(newestSighting(null)).toBeNull()
    expect(newestSighting({})).toBeNull()
    expect(newestSighting({ tag_sightings: null })).toBeNull()
    expect(newestSighting({ tag_sightings: [] })).toBeNull()
  })

  it("takes the head of the list, which the contract sends newest first", () => {
    const newest = row("http://localhost:3000", false, "2026-09-14T10:05:00.000Z")
    const older = row("https://example.com", true, "2026-09-14T10:00:00.000Z")
    expect(newestSighting({ tag_sightings: [newest, older] })).toBe(newest)
  })

  it("steps over a nameless row so a curl cannot hide a browser", () => {
    const curl = row("(none)", false, "2026-09-14T10:05:00.000Z")
    const browser = row("http://localhost:3000", false, "2026-09-14T10:00:00.000Z")
    expect(newestSighting({ tag_sightings: [curl, browser] })).toBe(browser)
    expect(newestSighting({ tag_sightings: [curl] })).toBeNull()
  })
})

describe("sightingKind", () => {
  it("never recomputes allowed: the row says so, the kind agrees", () => {
    expect(sightingKind(row("http://localhost:3000", true))).toBe("allowed")
    expect(sightingKind(row("https://example.com", true))).toBe("allowed")
  })

  it("splits a refused sighting by whether anything can be done about it", () => {
    expect(sightingKind(row("http://localhost:3000", false))).toBe("local")
    expect(sightingKind(row("http://app.localhost:8080", false))).toBe("local")
    expect(sightingKind(row("http://[::1]:5173", false))).toBe("local")
    expect(sightingKind(row("https://my-app-git-main.vercel.app", false))).toBe("foreign")
    expect(sightingKind(row("(none)", false))).toBe("foreign")
  })
})

describe("allowableDomain", () => {
  it("is the hostname without its port, cleaned the way the PATCH will clean it", () => {
    expect(allowableDomain("https://my-app-git-main.vercel.app")).toBe("my-app-git-main.vercel.app")
    expect(allowableDomain("http://Preview.Example.com:3000")).toBe("preview.example.com")
  })

  it("is null for a local host, a single label, or nothing to parse", () => {
    expect(allowableDomain("http://localhost:3000")).toBeNull()
    expect(allowableDomain("http://127.0.0.1:8080")).toBeNull()
    expect(allowableDomain("http://intranet")).toBeNull()
    expect(allowableDomain("(none)")).toBeNull()
  })
})
