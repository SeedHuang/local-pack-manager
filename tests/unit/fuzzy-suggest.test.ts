import { describe, expect, it } from 'vitest'
import { suggestCommand } from '../../src/cli.js'

describe('suggestCommand（S12 spec §4.6：Damerau-Levenshtein ≤3）', () => {
  it('lnik → link（transposition，距离 2）', () => {
    expect(suggestCommand('lnik', ['link', 'unlink', 'status'])).toEqual(['link'])
  })
  it('staus → status（距离 1）', () => {
    expect(suggestCommand('staus', ['link', 'unlink', 'status'])).toEqual(['status'])
  })
  it('unlnk → unlink（距离 1）', () => {
    expect(suggestCommand('unlnk', ['link', 'unlink', 'status'])).toEqual(['unlink'])
  })
  it('阈值 ≤3 命中（linnnk → link，距离 2）', () => {
    expect(suggestCommand('linnnk', ['link', 'unlink', 'status'])).toEqual(['link'])
  })
  it('距离 >3 → []（zzzzzz 对所有命令距离 ≥6）', () => {
    expect(suggestCommand('zzzzzz', ['link', 'unlink', 'status'])).toEqual([])
  })
  it('并列同距离全列（savv → save、savvy 距离各 1）', () => {
    expect(suggestCommand('savv', ['save', 'savvy'])).toEqual(['save', 'savvy'])
  })
  it('candidates 缺省 = 全部注册命令名（COMMANDS 11 个）', () => {
    expect(suggestCommand('lnik')).toContain('link')
  })
})
