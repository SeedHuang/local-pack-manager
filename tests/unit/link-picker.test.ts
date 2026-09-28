import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLinkCandidates, parsePathInput, PathInputError } from '../../src/commands/link.js'
import { loadWorkspace } from '../../src/core/workspace.js'
import type { LinkState, ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function mkTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lpm-pick-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return root
}

describe('parsePathInput', () => {
  it('PP-1：绝对路径单目标', () => { expect(parsePathInput('D:\\Seed\\lib')).toEqual(['D:\\Seed\\lib']) })
  it('PP-2：相对路径多目标（空白分隔）', () => { expect(parsePathInput('../lib ../other')).toEqual(['../lib', '../other']) })
  it('PP-3：双引号含空格', () => { expect(parsePathInput('"D:\\My Lib\\core"')).toEqual(['D:\\My Lib\\core']) })
  it('PP-4：单引号含空格', () => { expect(parsePathInput("'../my lib'")).toEqual(['../my lib']) })
  it('PP-5：引号与裸串混排', () => { expect(parsePathInput('a "b c" d')).toEqual(['a', 'b c', 'd']) })
  it('PP-6：未闭合引号抛错', () => { expect(() => parsePathInput('"未闭合')).toThrow(PathInputError) })
  it('PP-7：空串 / 全空白抛错', () => { expect(() => parsePathInput('')).toThrow(PathInputError); expect(() => parsePathInput('   ')).toThrow(PathInputError) })
  it('PP-8：空引号抛错', () => { expect(() => parsePathInput('""')).toThrow(PathInputError) })
})

describe('collectLinkCandidates', () => {
  /** ws：apps/web 与 apps/server 声明 @t/lib；apps/web 另声明 @t/two */
  function wsFiles(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'package.json': JSON.stringify({ name: 'ws-root', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n  - 'apps/server'\n",
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/two': '^1.0.0' } }),
      'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': '^1.0.0' } }),
      ...extra,
    }
  }

  it('PC-1：★ 按命中成员数降序，并列按注册顺序', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/two': '../two', '@t/lib': '../lib', '@t/none': '../none' } }
    const { registered } = await collectLinkCandidates(root, ws, cfg, null, [])
    expect(registered.map((c) => c.key)).toEqual(['@t/lib', '@t/two', '@t/none'])
    // hitMembers 的元素顺序由 findDependents/成员枚举序决定——spec §4.9/§8 未定义该顺序，且无消费者依赖它（交互层只用 .length）
    // → 断言用无序比较（Ruling R3-1：T3 实现者上报，brief 原断言假定书写序，实测为成员枚举序）
    expect([...registered[0].hitMembers].sort()).toEqual(['apps/server/package.json', 'apps/web/package.json'])
    expect(registered[2].hitMembers).toEqual([])
  })
  it('PC-2：[已链接] 标记来自 state', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const { registered } = await collectLinkCandidates(root, ws, cfg, st, [])
    expect(registered[0].linked).toBe(true)
  })
  it('PC-3：注册值非字符串 → cfgIntact=false，不抛错', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg = { version: 1, libs: { '@t/bad': 42 } } as unknown as ProjectLpmConfig
    const { registered } = await collectLinkCandidates(root, ws, cfg, null, [])
    expect(registered[0]).toMatchObject({ key: '@t/bad', cfgIntact: false, hitMembers: [] })
  })
  it('PC-4：links[key] 为 null / 原型链成员脏值不崩', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const st = { version: 1, links: { '@t/lib': null, constructor: {} } } as unknown as LinkState
    const { registered } = await collectLinkCandidates(root, ws, cfg, st, [])
    expect(registered[0].linked).toBe(true)
  })
  it('PC-5：扫描发现只认直接子目录里 name 非空的包', async () => {
    const scan = mkTree({
      'lib-a/package.json': JSON.stringify({ name: '@t/found' }),
      'lib-b/package.json': JSON.stringify({ name: '' }),
      'lib-c/notpkg.txt': '',
      'node_modules/x/package.json': JSON.stringify({ name: '@t/nm' }),
      '.hidden/package.json': JSON.stringify({ name: '@t/hidden' }),
    })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered } = await collectLinkCandidates(root, ws, null, null, [scan])
    expect(discovered.map((d) => d.key)).toEqual(['@t/found'])
  })
  it('PC-6：已注册键不进发现组；被成员依赖声明的库不被排除（第 4 轮评审修正的回归钉）', async () => {
    const scan = mkTree({
      'lib-a/package.json': JSON.stringify({ name: '@t/lib' }),
      'lib-b/package.json': JSON.stringify({ name: '@t/found' }),
    })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const { discovered } = await collectLinkCandidates(root, ws, cfg, null, [scan])
    expect(discovered.map((d) => d.key)).toEqual(['@t/found'])
  })
  it('PC-7：discovered 项也带 hitMembers（零命中标记与前置剔除同规则）', async () => {
    const scan = mkTree({ 'lib-a/package.json': JSON.stringify({ name: '@t/lib' }) })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered } = await collectLinkCandidates(root, ws, null, null, [scan])
    expect(discovered[0].hitMembers.length).toBeGreaterThan(0)
  })
  it('PC-8：scanDirs 不存在 → 提示但不中断', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered, scanNotes } = await collectLinkCandidates(root, ws, null, null, [join(root, 'no-such-dir')])
    expect(discovered).toEqual([])
    expect(scanNotes[0]).toContain('跳过不可读的扫描目录')
  })
  it('PC-9：scanDirs 元素非字符串 → 提示并跳过', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { scanNotes } = await collectLinkCandidates(root, ws, null, null, [42 as unknown as string])
    expect(scanNotes[0]).toContain('非字符串')
  })
  it('PC-10：scanDirs 为空 → discovered 为空数组', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    expect((await collectLinkCandidates(root, ws, null, null, [])).discovered).toEqual([])
  })
  it('PC-11：discovered 按命中成员数降序（命中者在前）——Fix 4 回归钉', async () => {
    // 两个扫描目录各放一个库：先扫到的 @t/none 零命中、后扫到的 @t/lib 被两成员依赖。
    // 修复前 discovered 保持扫描序 ['@t/none','@t/lib']；排序修复后命中者置顶。
    const scanNone = mkTree({ 'aa-none/package.json': JSON.stringify({ name: '@t/none' }) })
    const scanHit = mkTree({ 'zz-lib/package.json': JSON.stringify({ name: '@t/lib' }) })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered } = await collectLinkCandidates(root, ws, null, null, [scanNone, scanHit])
    expect(discovered.map((d) => d.key)).toEqual(['@t/lib', '@t/none'])
    expect(discovered[0].hitMembers.length).toBeGreaterThan(0)
    expect(discovered[1].hitMembers.length).toBe(0)
  })
})
