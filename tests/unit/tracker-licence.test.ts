import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `apps/tracker` is MIT while everything around it is AGPL-3.0 (README, "License
 * and trademark"). The
 * split lives in three files that nothing else reads — a LICENSE, a manifest
 * field and the banner the build script prepends — so this is the one place
 * that notices when one of them drifts from the other two.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8')

describe('the tracker licence', () => {
  it('ships an MIT LICENSE naming the copyright holder', () => {
    const licence = read('apps', 'tracker', 'LICENSE')
    expect(licence.startsWith('MIT License\n')).toBe(true)
    expect(licence).toContain('Copyright (c) 2026 OpenLabs LLC')
    expect(licence).toContain('Permission is hereby granted, free of charge')
  })

  it('declares MIT in its manifest while the workspace root stays AGPL', () => {
    const tracker = JSON.parse(read('apps', 'tracker', 'package.json')) as { license?: string }
    const root = JSON.parse(read('package.json')) as { license?: string }
    expect(tracker.license).toBe('MIT')
    expect(root.license).toBe('AGPL-3.0-only')
  })

  it('opens the served bundle with a licence line that survives minifiers', () => {
    // The build script is not importable (it builds on import), so its banner
    // is read as text. `/*!` is the marker minifiers keep.
    const script = read('scripts', 'build-tracker.mjs')
    const banner = /export const TRACKER_BANNER =\s*'([^']+)'/.exec(script)?.[1]
    expect(banner).toBeDefined()
    expect(banner?.startsWith('/*!')).toBe(true)
    expect(banner).toContain('MIT')
    expect(banner).toContain('apps/tracker/LICENSE')
    expect(script).toContain('banner: { js: TRACKER_BANNER }')
  })
})
