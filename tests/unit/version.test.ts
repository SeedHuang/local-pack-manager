import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LPM_VERSION } from '../../src/version.js'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

describe('版本同源', () => {
  it('LPM_VERSION === package.json.version 且为 semver', () => {
    expect(LPM_VERSION).toBe(pkg.version)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
