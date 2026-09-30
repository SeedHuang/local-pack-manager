import { describe, expect, it } from 'vitest'
import { decideUpgrade } from '../../src/core/upgrade.js'

describe('decideUpgrade（spec §6 矩阵）', () => {
  it('exact：落后 / 已满足 / latest 更旧（防御）', () => {
    expect(decideUpgrade('1.0.0', '1.2.0')).toEqual({ kind: 'behind', next: '1.2.0' })
    expect(decideUpgrade('1.2.0', '1.2.0')).toEqual({ kind: 'current' })
    expect(decideUpgrade('1.2.0', '1.1.0')).toEqual({ kind: 'current' })
  })
  it('^：范围内已满足；跨大版本落后并保留前缀', () => {
    expect(decideUpgrade('^1.0.0', '1.2.0')).toEqual({ kind: 'current' })
    expect(decideUpgrade('^1.0.0', '2.0.0')).toEqual({ kind: 'behind', next: '^2.0.0' })
    expect(decideUpgrade('^1.0.0', '1.0.0')).toEqual({ kind: 'current' })
  })
  it('~：范围内已满足；落后保留前缀', () => {
    expect(decideUpgrade('~1.0.0', '1.0.9')).toEqual({ kind: 'current' })
    expect(decideUpgrade('~1.0.0', '1.1.0')).toEqual({ kind: 'behind', next: '~1.1.0' })
  })
  it('跨大版本 exact：behind（确认流程覆盖，不特判）', () => {
    expect(decideUpgrade('1.0.0', '2.0.0')).toEqual({ kind: 'behind', next: '2.0.0' })
  })
  it('skip：本地协议 / workspace:npm 前缀 / 无法解析', () => {
    expect(decideUpgrade('link:../x', '1.2.0')).toEqual({ kind: 'skip', reason: 'local-protocol' })
    expect(decideUpgrade('file:./x', '1.2.0')).toEqual({ kind: 'skip', reason: 'local-protocol' })
    expect(decideUpgrade('portal:../x', '1.2.0')).toEqual({ kind: 'skip', reason: 'local-protocol' })
    expect(decideUpgrade('workspace:*', '1.2.0')).toEqual({ kind: 'skip', reason: 'workspace-protocol' })
    expect(decideUpgrade('npm:foo@^1', '1.2.0')).toEqual({ kind: 'skip', reason: 'workspace-protocol' })
    expect(decideUpgrade('latest', '1.2.0')).toEqual({ kind: 'skip', reason: 'unparseable' })
    expect(decideUpgrade('', '1.2.0')).toEqual({ kind: 'skip', reason: 'unparseable' })
  })
  it('skip：复杂形态无法推导新值（多条件 / 1.0.x）', () => {
    expect(decideUpgrade('>=1.0.0 <2.0.0', '2.0.0')).toEqual({ kind: 'skip', reason: 'unsupported-shape' })
    expect(decideUpgrade('1.0.x', '1.2.0')).toEqual({ kind: 'skip', reason: 'unsupported-shape' })
  })
  it('多条件 range 已覆盖最新 → current（不跳过）', () => {
    expect(decideUpgrade('>=1.0.0 <2.0.0', '1.2.0')).toEqual({ kind: 'current' })
  })
  it('* → current（validRange 通过且满足一切）', () => {
    expect(decideUpgrade('*', '1.2.0')).toEqual({ kind: 'current' })
  })
  it('边界：0.x', () => {
    expect(decideUpgrade('0.0.0', '0.0.1')).toEqual({ kind: 'behind', next: '0.0.1' })
    expect(decideUpgrade('0.0.1', '0.0.0')).toEqual({ kind: 'current' })
  })
})
