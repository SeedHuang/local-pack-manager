import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../src/commands/registry.js'

const EXPECTED = [
  'use', 'link', 'unlink', 'status', 'repair',
  'save', 'preset', 'forget', 'dir', 'init', 'uninit',
]

describe('命令注册表', () => {
  it('覆盖 PRD §7 全集 11 个，无重复，顺序固定', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(EXPECTED)
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(11)
  })

  it('每项含中文 summary', () => {
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
    }
  })
})
