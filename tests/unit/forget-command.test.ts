import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadWorkspace } from '../../src/core/workspace.js'
import { multiselect, text, confirm, note, isCancel } from '@clack/prompts'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), text: vi.fn(), confirm: vi.fn(), note: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { runForget } from '../../src/commands/forget.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** workspace：apps/web 依赖 @t/lib；libs 由各用例 registerLib 显式写 */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-fg-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    ...files,
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
}
function registerLib(ws: string, key: string, rel: string): void {
  const p = join(ws, 'lpm.config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as { libs: Record<string, string> }
  cfg.libs[key] = rel
  writeFileSync(p, JSON.stringify(cfg), 'utf8')
}
function readLibs(ws: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { libs: Record<string, string> }).libs
}
function stubTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true })
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}
beforeEach(() => { vi.clearAllMocks() })

describe('lpm forget 直通（S11）', () => {
  it('FG-1 名字删除：正常 → libs 键消失、其它键保留、文案逐字', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(cap.out.join('')).toContain('已移除注册：@t/a，以后想再联调需重新带路径注册')
  })

  it('FG-2 路径删除：相对路径 → 反查命中', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const cap = captureOut()
    const code = await runForget(['libs/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-3 路径删除：目录不存在也能删（反查不 stat 的钉）', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/gone')   // libs/gone 目录不存在
    const code = await runForget(['libs/gone'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
  })

  it('FG-4 两路混用（名字 + 路径）→ 一并删', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const code = await runForget(['@t/a', 'libs/b'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
  })

  it('FG-5 多 target 去重（名字 + 指向同一注册的路径）→ 只提示一次', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const cap = captureOut()
    const code = await runForget(['@t/a', 'libs/a'], ws)
    expect(code).toBe(0)
    const lines = cap.out.join('').split('\n').filter((l) => l.includes('已移除注册：@t/a'))
    expect(lines).toHaveLength(1)
  })

  it('FG-6 已链接拦截：key ∈ state.links → 报错 + config byte 级零写盘', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }) })
    registerLib(ws, '@t/a', 'libs/a')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('先 lpm unlink @t/a')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-7 名字不存在 → 报错 + 列出可用 + 零写盘', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/nope'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('注册不存在：@t/nope')
    expect(cap.err.join('')).toContain('已注册：@t/a')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-8 无注册 → 专属文案', async () => {
    const ws = makeWs()
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('当前没有任何已注册的 lib')
  })

  it('FG-9 删空保留 libs: {}（回归钉：移除字段会让 readProjectConfig 抛错）', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { libs: Record<string, string> }
    expect(cfg.libs).toEqual({})
  })

  it('FG-10 预设提示不洗：key 在某预设 → 提示行出现 + 预设 byte 级不变', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' }, presets: { 前端: ['@t/a', '@t/b'] } }) })
    const beforeCfg = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('⚠️ @t/a 仍在预设 前端 里（已失效）')
    // 删除后 config 只应改 libs，presets 原样
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { presets: Record<string, string[]> }
    expect(cfg.presets['前端']).toEqual(['@t/a', '@t/b'])
    expect(beforeCfg).toContain('前端')
  })

  it('FG-11 预设提示按预设聚合：一个预设含多个被删 key → 只提示一次', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' }, presets: { 前端: ['@t/a', '@t/b'] } }) })
    const cap = captureOut()
    const code = await runForget(['@t/a', '@t/b'], ws)
    expect(code).toBe(0)
    const lines = cap.out.join('').split('\n').filter((l) => l.includes('仍在预设 前端 里'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('@t/a、@t/b')
  })

  it('FG-12 损坏注册值条目 → 可删（修脏路径）', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 123, '@t/b': 'libs/b' } }) })
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
  })

  it('FG-13 读-改-写：config 含未知字段 → 删除后未知字段保留', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' }, future: 1 }) })
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { future: number }
    expect(cfg.future).toBe(1)
  })

  it('FG-14 多 target 全校验通过才写盘：合法 + 已链接混合 → 整批停零写盘', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/b': { original: {}, linkedAt: 'x' } } }) })
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a', '@t/b'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('先 lpm unlink @t/b')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-15 无参数非 TTY → 提示 + exit 1 + 零 clack 调用', async () => {
    const ws = makeWs()
    stubTty(false)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm forget <名字|路径>')
    expect(multiselect).not.toHaveBeenCalled()   // 零 clack 调用（S8 exit-13 事故同族回归钉）
  })
})

describe('lpm forget 交互（S11）', () => {
  async function setupInteractive(files: Record<string, string> = {}): Promise<{ ws: string; home: string }> {
    stubTty(true)
    const home = mkdtempSync(join(tmpdir(), 'lpm-fg-home-'))
    dirs.push(home)
    osMock.home = home
    mkdirSync(join(home, '.lpm'), { recursive: true })
    const ws = makeWs(files)
    return { ws, home }
  }

  it('FG-16 子界面：多选删 → 二次确认 → 文件更新 + 逐行提示', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(note).toHaveBeenCalled()
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-17 子界面：[已链接] 项勾选 → 剔除提示、其余照常', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' } }), '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a', '@t/b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })   // 已链接的 @t/a 被剔除，@t/b 被删
    expect(cap.out.join('')).toContain('⚠️ @t/a 当前已链接。先 lpm unlink @t/a')
    expect(cap.out.join('')).toContain('已移除注册：@t/b')
  })

  it('FG-18 子界面：按路径删除 → 命中并入', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__forget_path__'] as never)
    vi.mocked(text).mockResolvedValueOnce('libs/a' as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-19 子界面：按路径删除 → 未命中 → 提示不并入', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__forget_path__'] as never)
    vi.mocked(text).mockResolvedValueOnce('libs/nope' as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('未找到与 libs/nope 匹配的已注册 lib')
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })   // 未命中 → 删除集合空 → 不写盘
  })

  it('FG-20 子界面：二次确认答否 → 已取消 + 零写盘', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('已取消')
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })
  })

  it('FG-21 子界面：空删除集合 → 未选择任何注册 + 不弹二次确认', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('未选择任何注册')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('FG-22 子界面：取消 → 已取消 + 返回', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('FG-23 子界面空态（无注册）→ 提示 + 返回 0 + 不弹菜单', async () => {
    const { ws } = await setupInteractive()
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何已注册的 lib')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('FG-24 子界面：[注册值损坏] 项可删（修脏路径）', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 123, '@t/b': 'libs/b' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })
})
