import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), confirm: vi.fn(), isCancel: vi.fn(() => false),
}))

import { multiselect, confirm, isCancel } from '@clack/prompts'
import { PresetError, readPresets, runPreset, runSave } from '../../src/commands/preset.js'
import type { ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })
beforeEach(() => { vi.clearAllMocks() })

describe('readPresets 守卫（spec §4.7）', () => {
  it('PRE-1：cfg=null / 无 presets → 空视图', () => {
    const empty = { raw: {}, entries: {}, corrupt: [] }
    expect(readPresets(null)).toEqual(empty)
    expect(readPresets({ version: 1, libs: {} })).toEqual(empty)
  })

  it('PRE-2：presets 为数组 / null / 标量 → 抛 PresetError（不吞）', () => {
    const mk = (p: unknown): ProjectLpmConfig => ({ version: 1, libs: {}, presets: p } as unknown as ProjectLpmConfig)
    expect(() => readPresets(mk([]))).toThrow(PresetError)
    expect(() => readPresets(mk(null))).toThrow(PresetError)
    expect(() => readPresets(mk(5))).toThrow(PresetError)
  })

  it('PRE-3：值非「字符串数组」→ 进 corrupt、不进 entries；raw 原样保留', () => {
    const cfg = { version: 1, libs: {}, presets: { good: ['@t/lib'], bad: 42, mixed: ['@t/a', 7], obj: { a: 1 } } } as unknown as ProjectLpmConfig
    const v = readPresets(cfg)
    expect(v.entries).toEqual({ good: ['@t/lib'] })
    expect([...v.corrupt].sort()).toEqual(['bad', 'mixed', 'obj'])
    expect(v.raw.bad).toBe(42)
    expect(v.raw.good).toEqual(['@t/lib'])
  })

  it('PRE-4：空数组属合法条目', () => {
    const cfg = { version: 1, libs: {}, presets: { empty: [] } } as unknown as ProjectLpmConfig
    expect(readPresets(cfg).entries).toEqual({ empty: [] })
    expect(readPresets(cfg).corrupt).toEqual([])
  })
})

// ── S10 T2：runSave fixture + 用例（spec §4.8）──
function makeProj(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-pre-'))
  dirs.push(dir)
  const base: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
  for (const [n, c] of Object.entries(base)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}
function entry(): Record<string, unknown> {
  return { original: { 'package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' }
}
function writeStateFile(dir: string, keys: string[]): void {
  const links: Record<string, unknown> = {}
  for (const k of keys) links[k] = entry()
  mkdirSync(join(dir, '.lpm'), { recursive: true })
  writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify({ version: 1, links }), 'utf8')
}
function cfgOf(dir: string): { libs: Record<string, string>; presets?: Record<string, string[]> } {
  return JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8'))
}
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('runSave（spec §4.8）', () => {
  it('SV-1：正常 → 名单 = state.links 的 keys 且按 .sort() 排序 + 打印', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/b', '@t/a'])
    const cap = captureOut()
    expect(await runSave('前端', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ 前端: ['@t/a', '@t/b'] })
    expect(cap.stdout()).toContain('已保存预设：前端（2 项：@t/a、@t/b）')
  })

  it('SV-2：无 state.json / links 为空 → 报错 exit 1，且不写 presets', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    const cap = captureOut()
    expect(await runSave('x', dir)).toBe(1)
    expect(cap.stderr()).toContain('当前没有任何已链接的库')
    expect(cfgOf(dir).presets).toBeUndefined()
  })

  it('SV-3：撞名 → 报错 + lpm.config.json byte 级不变', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { 前端: ['@t/a'] } }) })
    writeStateFile(dir, ['@t/b'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runSave('前端', dir)).toBe(1)
    expect(cap.stderr()).toContain('预设名已存在：前端')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('SV-4：名非法（空 / 全空白 / 含空格）→ 报错 exit 1', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    const cap = captureOut()
    for (const bad of ['', '   ', 'a b']) {
      expect(await runSave(bad, dir)).toBe(1)
    }
    expect(cap.stderr()).toContain('不能包含空白字符')
  })

  it('SV-5：读-改-写 —— 已有其它预设与损坏条目都保留', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { other: ['@t/x'], broken: 42 } }) })
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('新', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ other: ['@t/x'], broken: 42, 新: ['@t/a'] })
  })

  it('SV-6：无 lpm.config.json → 创建且 libs 为 {}', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('x', dir)).toBe(0)
    expect(cfgOf(dir)).toEqual({ version: 1, libs: {}, presets: { x: ['@t/a'] } })
  })

  it('SV-7：预设名含 CJK 能存', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('中文预-设', dir)).toBe(0)
    expect(cfgOf(dir).presets?.['中文预-设']).toEqual(['@t/a'])
  })

  it('SV-8：state.links 的键不在 cfg.libs 也**照样存**（不静默丢数据；配对用例 = T4 的 LC-8 报错半边）', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/a', '@t/gone'])
    expect(await runSave('p', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ p: ['@t/a', '@t/gone'] })   // 存原样；日后 `link --preset p` 会以「不在注册表」报错（LC-8）
  })
})

// ── S10 T3：runPreset（rm 直通 + 无参数交互菜单，spec §4.9）──
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

describe('lpm preset rm（直通，spec §4.9）', () => {
  it('PR-1：正常 → 该键消失、其它键保留', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'], b: ['@t/b'] } }) })
    const cap = captureOut()
    expect(await runPreset(['rm', 'a'], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ b: ['@t/b'] })
    expect(cap.stdout()).toContain('已删除预设：a')
  })

  it('PR-2：删最后一个 → presets 字段整体移除', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    expect(await runPreset(['rm', 'a'], dir)).toBe(0)
    expect('presets' in cfgOf(dir)).toBe(false)
    expect(cfgOf(dir).libs).toEqual({})
  })

  it('PR-3：名不存在 → 报错 + 列出可用预设', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'], b: ['@t/b'] } }) })
    const cap = captureOut()
    expect(await runPreset(['rm', 'nope'], dir)).toBe(1)
    expect(cap.stderr()).toContain('预设不存在：nope')
    expect(cap.stderr()).toContain('a、b')
  })

  it('PR-4：没有 lpm.config.json → 报错（不崩）', async () => {
    const dir = makeProj()
    const cap = captureOut()
    expect(await runPreset(['rm', 'a'], dir)).toBe(1)
    expect(cap.stderr()).toContain('没有 lpm.config.json')
  })

  it('PR-5：删损坏条目 → 成功（修复路径）', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { broken: 42, ok: ['@t/a'] } }) })
    expect(await runPreset(['rm', 'broken'], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ ok: ['@t/a'] })
  })

  it('PR-6：子命令非法 / rm 缺名 / 多余参数 → 用法错误 exit 1', async () => {
    const dir = makeProj()
    const cap = captureOut()
    for (const args of [['foo'], ['rm'], ['rm', 'a', 'b'], ['rm', 'a', 'b', 'c']]) {
      expect(await runPreset(args, dir)).toBe(1)
    }
    expect(cap.stderr()).toContain('下一步：lpm preset')
  })
})

describe('lpm preset（无参数交互菜单，spec §4.9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isCancel).mockReturnValue(false)
  })

  it('PR-7：非 TTY → 一行提示 + exit 1 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(false)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('当前不是交互终端；直通用法：lpm preset rm <名>')
    expect(multiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('PR-8：无任何预设 → 告知 + exit 0 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    stubTty(true)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    expect(cap.stdout()).toContain('还没有任何预设')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('PR-9：多选删除 → 二次确认 → 文件更新 + 逐行提示', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a', '@t/b'], b: ['@t/c'], c: ['@t/d'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['a', 'b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ c: ['@t/d'] })
    expect(cap.stdout()).toContain('已删除预设：a')
    expect(cap.stdout()).toContain('已删除预设：b')
    // 选项 label 内联名单（spec §8 自决 6）
    const opts = (vi.mocked(multiselect).mock.calls[0]![0] as { options: Array<{ label: string }> }).options
    expect(opts.map((o) => o.label)).toContain('a（2 项：@t/a、@t/b）')
  })

  it('PR-10：空选中 → 未选择任何预设 + exit 1 + 文件不变', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('未选择任何预设')
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('PR-11：答否 → 已取消 + exit 1 + byte 级零写盘', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('PR-12：isCancel → 已取消 + exit 1', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce('__cancel__' as never)
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
  })

  it('PR-13：损坏条目 label 含 [损坏] 且可被选中删除', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { broken: 42, ok: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['broken'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    const opts = (vi.mocked(multiselect).mock.calls[0]![0] as { options: Array<{ value: string; label: string }> }).options
    expect(opts.find((o) => o.value === 'broken')?.label).toContain('[损坏]')
    expect(cfgOf(dir).presets).toEqual({ ok: ['@t/a'] })
  })
})

// ── S12 T4：save / preset rm --dry-run（spec §4.4/§4.5）──
describe('save / preset rm --dry-run（S12 spec §4.4/§4.5）', () => {
  it('S12-PR-DR1：save --dry-run → 计划文本 + config byte 级零写盘 + exit 0', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/b', '@t/a'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runSave('前端', dir, { dryRun: true })
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.stdout()).toContain('将保存预设：前端（2 项：@t/a、@t/b）')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR2：save --dry-run 撞名 → 照样报错 + 零写盘', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { 前端: ['@t/a'] } }) })
    writeStateFile(dir, ['@t/b'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runSave('前端', dir, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('预设名已存在')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR3：preset rm --dry-run → 计划文本 + 零写盘 + exit 0', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/lib'], b: ['@t/x'] } }) })
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runPreset(['rm', 'a'], dir, { dryRun: true })
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('将删除预设：a')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR4：preset 无参数 + --dry-run → 拒绝 + exit 1 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/lib'] } }) })
    const cap = captureOut()
    const code = await runPreset([], dir, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('--dry-run 仅直通模式适用')
    expect(multiselect).not.toHaveBeenCalled()
  })
})
