import { describe, expect, it } from 'vitest'
import { rewriteSamples } from './rewriter-samples.js'
import {
  findDepEntries,
  mapProtocol,
  ProtocolPathError,
  restoreDepValue,
  rewriteDepValue,
} from '../../src/core/rewriter.js'

describe('mapProtocol（S5 spec §4.4）', () => {
  it('用例 1：四 pm 协议映射（S3 spec §8 定版）', () => {
    expect(mapProtocol('pnpm', 'C:\\repo\\lib', 'C:\\app')).toBe('link:../repo/lib')
    expect(mapProtocol('yarn-classic', 'C:\\repo\\lib', 'C:\\app')).toBe('link:../repo/lib')
    expect(mapProtocol('yarn-berry', 'C:\\repo\\lib', 'C:\\app')).toBe('portal:../repo/lib')
    expect(mapProtocol('npm', 'C:\\repo\\lib', 'C:\\app')).toBe('file:../repo/lib')
  })

  it('用例 2：相对换算基准 = manifest 所在目录；反斜杠输入 → 正斜杠输出', () => {
    expect(mapProtocol('pnpm', 'C:\\app\\libs\\lib', 'C:\\app')).toBe('link:./libs/lib')
    expect(mapProtocol('pnpm', 'C:\\libs\\lib', 'C:\\app\\packages\\web')).toBe('link:../../../libs/lib')
    expect(mapProtocol('npm', 'C:/libs/lib', 'C:\\app')).toBe('file:../libs/lib')
  })

  it('用例 3：同目录 → "./"（步骤 3 空串规则）', () => {
    expect(mapProtocol('pnpm', 'C:\\app', 'C:\\app')).toBe('link:./')
    expect(mapProtocol('npm', 'C:\\app', 'C:\\app')).toBe('file:./')
  })

  it('用例 4：Windows 跨盘符 → ProtocolPathError（message 含两路径，计划期修订 5）', () => {
    let err: unknown
    try {
      mapProtocol('pnpm', 'D:\\libs\\lib', 'C:\\app')
      expect.unreachable('应抛出 ProtocolPathError')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProtocolPathError)
    const perr = err as ProtocolPathError
    expect(perr.libDirAbs).toBe('D:\\libs\\lib')
    expect(perr.manifestDirAbs).toBe('C:\\app')
    expect(perr.message).toContain('D:\\libs\\lib')
    expect(perr.message).toContain('C:\\app')
    expect(perr.name).toBe('ProtocolPathError')
  })
})

describe('rewriteDepValue 行为契约（S5 spec §4.4）', () => {
  it('用例 5：零命中 → content 原样双空（含空串/纯空白 manifestSource，F7）', () => {
    const src = '{\n  "name": "app",\n  "dependencies": {\n    "other": "1.0.0"\n  }\n}\n'
    expect(rewriteDepValue(src, 'lib', 'link:../lib')).toEqual({
      content: src,
      changedKeys: [],
      unchangedKeys: [],
    })
    expect(rewriteDepValue('', 'lib', 'link:../lib')).toEqual({
      content: '',
      changedKeys: [],
      unchangedKeys: [],
    })
    expect(rewriteDepValue('  \n\t', 'lib', 'link:../lib')).toEqual({
      content: '  \n\t',
      changedKeys: [],
      unchangedKeys: [],
    })
  })

  it('用例 6：命中点 value 非字符串字面量 → 视为未命中不动', () => {
    const src = '{\n  "dependencies": {\n    "lib": null,\n    "also": {}\n  }\n}'
    const r = rewriteDepValue(src, 'lib', 'link:../lib')
    expect(r.content).toBe(src)
    expect(r.changedKeys).toEqual([])
    expect(r.unchangedKeys).toEqual([])
  })

  it('用例 7：字符串感知守护——scripts 值内 "dependencies"/花括号字样不误判段', () => {
    const src = [
      '{',
      '  "scripts": {',
      '    "build": "echo \\"{ dependencies: { \\"lib\\": \\"1.0.0\\" } }\\"",',
      '  },',
      '  "dependencies": {',
      '    "lib": "^2.0.0"',
      '  }',
      '}',
      '',
    ].join('\n')
    const r = rewriteDepValue(src, 'lib', 'link:../lib')
    expect(r.changedKeys).toEqual(['dependencies.lib'])
    // byte 级：仅真实依赖段 value 变化——把新值字面量还原回去应逐字节等于原文
    expect(r.content.replace('"link:../lib"', '"^2.0.0"')).toBe(src)
    expect(r.content).toContain('echo \\"{ dependencies: { \\"lib\\": \\"1.0.0\\" } }\\"')
  })

  it('用例 11：仅 peer 命中 → content 原样双空；混合命中 peer 值原样（spec §4.4，SDD 勘误增补）', () => {
    const peerOnly = '{\n  "name": "app",\n  "peerDependencies": {\n    "lib": "^1.0.0"\n  }\n}\n'
    expect(rewriteDepValue(peerOnly, 'lib', 'link:../lib')).toEqual({
      content: peerOnly,
      changedKeys: [],
      unchangedKeys: [],
    })
    const mixed = '{\n  "dependencies": {\n    "lib": "^1.0.0"\n  },\n  "peerDependencies": {\n    "lib": "^2.0.0"\n  }\n}\n'
    const rm = rewriteDepValue(mixed, 'lib', 'link:../lib')
    expect(rm.changedKeys).toEqual(['dependencies.lib'])
    expect(rm.content).toContain('"lib": "^2.0.0"')
    expect(rm.content).toContain('"lib": "link:../lib"')
  })
})

describe('findDepEntries（S5 spec §4.4，裁定①）', () => {
  it('用例 8：四段全命中 → 规范段序输出（与文档顺序无关，计划期修订 1）', () => {
    const src = [
      '{',
      '  "peerDependencies": { "lib": "*" },',
      '  "devDependencies": { "lib": "^1.0.0" },',
      '  "optionalDependencies": { "lib": "^2.0.0" },',
      '  "dependencies": { "lib": "^3.0.0" }',
      '}',
    ].join('\n')
    expect(findDepEntries(src, 'lib')).toEqual([
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
  })

  it('用例 9：仅 peer 命中 / 零命中', () => {
    expect(findDepEntries('{"peerDependencies": {"lib": "*"}}', 'lib')).toEqual(['peerDependencies'])
    expect(findDepEntries('{"dependencies": {"other": "1.0.0"}}', 'lib')).toEqual([])
  })

  it('用例 10：重复段 → 去重（F3 同族）', () => {
    const src = '{"dependencies": {"lib": "1.0.0"}, "name": "app", "dependencies": {"lib": "2.0.0"}}'
    expect(findDepEntries(src, 'lib')).toEqual(['dependencies'])
  })
})

describe('golden 样本矩阵（S5 spec §4.5 #1–#14）', () => {
  for (const s of rewriteSamples) {
    it(`golden ${s.name}`, () => {
      const r = rewriteDepValue(s.source, s.pkgName, s.targetValue)
      expect(r.content).toBe(s.expectedContent)
      expect(r.changedKeys).toEqual(s.changedKeys)
      expect(r.unchangedKeys).toEqual(s.unchangedKeys)
    })
  }

  it('golden BOM 首字节保留断言（0xFEFF，#4/#4b）', () => {
    for (const s of rewriteSamples.filter((x) => x.name.includes('BOM'))) {
      expect(rewriteDepValue(s.source, s.pkgName, s.targetValue).content.charCodeAt(0)).toBe(0xfeff)
    }
  })

  it('golden restore roundtrip：byte 级还原（F10 标记样本除外）', () => {
    for (const s of rewriteSamples) {
      if (s.skipRoundtrip) continue
      const r = rewriteDepValue(s.source, s.pkgName, s.targetValue)
      const back = restoreDepValue(r.content, s.pkgName, s.originalValue)
      expect(back.content).toBe(s.source)
    }
  })
})
