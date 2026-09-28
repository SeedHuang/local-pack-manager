import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  select: vi.fn(), groupMultiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { select, groupMultiselect, confirm, text, isCancel } from '@clack/prompts'
import { runLink } from '../../src/commands/link.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** workspace：apps/web 依赖 @t/lib；**cfg.libs 默认为空**（注册由各用例用 registerLib 显式做） */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-li-'))
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
/** lib：真实存在的包目录（name 可指定——零命中剔除用例需要「存在但无人依赖」的库） */
function makeLib(name = '@t/lib'): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  mkdirSync(lib, { recursive: true })
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name, main: './index.js', scripts: { 'build:watch': 'echo watch' } }), 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
}
/** 把「绝对 lib 路径」写进 ws 的 lpm.config.json（键 = 包名，值 = 相对根的路径） */
function registerLib(ws: string, key: string, libAbs: string): void {
  const p = join(ws, 'lpm.config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as { version: 1; packageManager?: string; libs: Record<string, string> }
  cfg.libs[key] = relative(ws, libAbs).replaceAll('\\', '/')
  writeFileSync(p, JSON.stringify(cfg), 'utf8')
}
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-home-'))
  dirs.push(home)
  osMock.home = home
  mkdirSync(join(home, '.lpm'), { recursive: true })
  return home
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}

beforeEach(() => {
  osMock.home = ''
  vi.clearAllMocks()
  vi.mocked(isCancel).mockReturnValue(false)
})

describe('link 交互入口', () => {
  it('LI-1：非 TTY 无参数 → 提示 + exit 1，且零菜单调用', async () => {
    const ws = makeWs(); makeLib()
    stubTty(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm link')
    expect(select).not.toHaveBeenCalled()
    expect(groupMultiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('LI-2：空态向导 → 输路径 → 隐形注册并执行', async () => {
    const lib = makeLib()
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('path')          // 向导：输路径
    vi.mocked(text).mockResolvedValueOnce(lib)               // 手输路径
    vi.mocked(confirm).mockResolvedValueOnce(true)           // 闸门：确认
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBeDefined()
  })

  it('LI-3：空态向导 → 加扫描目录 → 写入用户级 config 并重扫', async () => {
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const ws = makeWs()   // libs 为空 → 空态
    stubTty(true); const home = makeHome()
    vi.mocked(select).mockResolvedValueOnce('scan').mockResolvedValueOnce('quit')
    vi.mocked(text).mockResolvedValueOnce(scan)
    captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')).scanDirs).toContain(scan)
  })

  it('LI-4：空态向导 → 退出 → exit 0', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('quit')
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(JSON.stringify(vi.mocked(select).mock.calls[0]?.[0])).toContain('还没有注册任何 lib')
  })

  it('LI-5：主列表选中 → 预览 → 确认「是」→ 执行', async () => {
    const lib = makeLib()
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(cap.out.join('')).toContain('改写 apps/web/package.json:')
    expect(cap.out.join('')).toContain('链接完成：1 个 lib')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('LI-6：确认答否 → 已取消 + exit 1 + 零写盘（含未注册「扫描发现」项不落 config）', async () => {
    // 用 LI-16 的「扫描发现」配方：候选来自扫描目录、未注册 → 若在闸门之前写盘则 libs 会被 upsert
    const ws = makeWs()                                   // libs 为空
    const home = makeHome()
    const scanRoot = mkdtempSync(join(tmpdir(), 'lpm-scan-'))
    dirs.push(scanRoot)
    const lib = join(scanRoot, 'lib')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scanRoot] }), 'utf8')
    stubTty(true)
    vi.mocked(groupMultiselect).mockResolvedValueOnce([lib])   // 扫描发现项的 value = 库目录绝对路径
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(execa).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
    // Fix 1 回归钉：闸门之前零写盘——答否后 lpm.config.json 的 libs 仍为空对象
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs).toEqual({})
  })

  it('LI-7：Ctrl+C（isCancel）→ 已取消 + exit 1', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce([])
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('LI-8：空选中提交 → 未选择任何库 + exit 1', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('LI-9：勾选全为 [已链接] → 预览 + 无待执行变更 + confirm 零调用 + exit 0', async () => {
    const lib = makeLib()
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('LI-10：零命中项前置剔除，不连累同批其它项', async () => {
    const lib = makeLib()                 // 真实存在且在 apps/web 依赖中
    const none = makeLib('@t/none')       // 真实存在，但无人依赖 —— 触发零命中剔除
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    registerLib(ws, '@t/none', none)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib', '@t/none'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('未在任何成员依赖中，已跳过')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
  })

  it('LI-11：注册值损坏项被剔除 + 提示（dry-run 空分支同直通形态）', async () => {
    const cfgBad = JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/bad': 42 } })
    makeLib()
    const ws = makeWs({ 'lpm.config.json': cfgBad })
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/bad'])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('注册值损坏，已跳过')
    // Fix 3 回归钉：dry-run 下「前置剔除即空」必须是直通同形、**行首无缩进**的单行——回退修复即变红
    // （原断言 endsWith('无待执行变更\n') 是假钉：缩进版 '  无待执行变更\n' 同样满足；故此处锚定行首）
    const ws2 = makeWs({ 'lpm.config.json': cfgBad })
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/bad'])
    cap.out.length = 0
    expect(await runLink([], { dryRun: true }, ws2)).toBe(0)
    expect(cap.out.join('')).toMatch(/(^|\n)无待执行变更\n$/u)
    expect(cap.out.join('')).not.toContain('执行计划预览：')
  })

  it('LI-12：无目标 + --dry-run → dry-run 计划 + 零写盘零子进程 + exit 0', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], { dryRun: true }, ws)).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(execa).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('LI-13：--watch 透传 → 预览里出现 watch 行', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], { dryRun: true, watch: true }, ws)).toBe(0)
    expect(cap.out.join('')).toContain('watch：拉起')
  })

  it('LI-14：「其他…」被勾选 → 提交后弹 text 并并入 targets', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)   // 有已注册项 → 主列表出现（不进空态向导）
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__other__'])
    vi.mocked(text).mockResolvedValueOnce(lib)
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(text).toHaveBeenCalledTimes(1)          // 只来自「其他…」的输入通道
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
  })

  it('LI-15：三态弹问在 confirm 之前（统一前置判定的顺序断言）', async () => {
    const lib = makeLib()
    const ws = makeWs({
      // 声明值已是「非 lpm 管理的本地链接」→ 触发三态弹问（E4）
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }),
    })
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValue('abandon')       // 三态选「放弃」
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    await runLink([], {}, ws)
    expect(select).toHaveBeenCalled()
    const selOrder = vi.mocked(select).mock.invocationCallOrder[0]
    const gmOrder = vi.mocked(groupMultiselect).mock.invocationCallOrder[0]
    expect(gmOrder).toBeLessThan(selOrder)               // 先选库，再进行前置判定
    expect(confirm).not.toHaveBeenCalled()               // 放弃 → 计划为空 → 不进入确认
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('LI-16：勾选「扫描发现」项 → 以路径隐形注册并成功链接（T4 评审 Important-1 的回归钉）', async () => {
    const ws = makeWs()                                   // libs 为空：候选只能来自扫描发现
    const home = makeHome()
    const scanRoot = mkdtempSync(join(tmpdir(), 'lpm-scan-'))
    dirs.push(scanRoot)
    const lib = join(scanRoot, 'lib')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scanRoot] }), 'utf8')
    stubTty(true)
    vi.mocked(groupMultiselect).mockResolvedValueOnce([lib])   // 扫描发现项的 value = 库目录绝对路径
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(JSON.stringify(vi.mocked(groupMultiselect).mock.calls[0]?.[0])).toContain('[未注册]')   // 该组确实出现
    // 读回交给 groupMultiselect 的 options —— 钉死「扫描发现」项的 value 是**库路径**（不是包名）。
    // 若生产代码把 link.ts 的 value 从 d.dirAbs 退回 d.key，此断言立即变红（回归钉）。
    const arg = vi.mocked(groupMultiselect).mock.calls[0]?.[0] as {
      options: Record<string, Array<{ value: string; label: string }>>
    }
    const discovered = Object.values(arg.options).flat().find((o) => o.value !== '\u0000__other__')
    expect(discovered?.value).toBe(lib)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBeDefined()   // 隐形注册
  })

  it('LI-20：无参数 + --dry-run + 空计划 → 走 dry-run 形态（无预览首行）（最终评审 Important-1 的回归钉）', async () => {
    const lib = makeLib()
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])   // 全为 [已链接] → 计划为空
    const cap = captureOut()
    expect(await runLink([], { dryRun: true }, ws)).toBe(0)
    // 构建阶段会先打既有的「已链接：…，跳过」行；故只钉计划区域：
    expect(cap.out.join('')).not.toContain('执行计划预览：')          // 不得是预览形态
    expect(cap.out.join('').endsWith('无待执行变更\n')).toBe(true)    // 且末行是无缩进单行（dry-run 形态）
    expect(confirm).not.toHaveBeenCalled()
  })

  it('LI-22：扫描发现组补 ★（被成员依赖声明者带星——spec §4.5 与已注册组同规则）', async () => {
    const ws = makeWs()                                   // libs 为空：候选只能来自扫描发现
    const home = makeHome()
    const scanRoot = mkdtempSync(join(tmpdir(), 'lpm-scan-'))
    dirs.push(scanRoot)
    const lib = join(scanRoot, 'lib')                     // name=@t/lib：被 apps/web 依赖声明 → hitMembers 非空
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scanRoot] }), 'utf8')
    stubTty(true)
    vi.mocked(groupMultiselect).mockResolvedValueOnce([])   // 空选中：只读交给它的 options，不进执行
    const cap = captureOut()
    await runLink([], {}, ws)
    const arg = vi.mocked(groupMultiselect).mock.calls[0]?.[0] as {
      options: Record<string, Array<{ value: string; label: string }>>
    }
    const discovered = Object.values(arg.options).flat().find((o) => o.value === lib)
    // Fix 4 回归钉：命中成员者 label 必须带 ★（若退回 `${d.key}  [未注册]` 此处立即为 undefined→变红）
    expect(discovered?.label).toContain('★')
    expect(cap.out.join('')).toContain('未选择任何库')
  })
})

function writeLast(ws: string, names: string[]): void {
  mkdirSync(join(ws, '.lpm'), { recursive: true })
  writeFileSync(join(ws, '.lpm', 'last.json'), JSON.stringify({ version: 1, names }), 'utf8')
}
function shortcutOpts(): Array<{ value: string; label: string; hint?: string }> {
  const arg = vi.mocked(groupMultiselect).mock.calls[0]![0] as { options: Record<string, Array<{ value: string; label: string; hint?: string }>> }
  return arg.options['快捷'] ?? []
}

describe('link 主列表「快捷」组（spec §4.10）', () => {
  it('VI-1：有注册 + 有 last → 两项都在；勾「全部已注册」→ 展开全部注册键', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    writeLast(ws, ['@t/a'])
    stubTty(true); makeHome()
    const ALL = '\u0000__all_registered__'
    vi.mocked(groupMultiselect).mockResolvedValueOnce([ALL] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(shortcutOpts().map((o) => o.value)).toEqual([ALL, '\u0000__last__'])
    expect(shortcutOpts()[0]!.label).toContain('全部已注册（2）')
    expect(shortcutOpts()[1]!.label).toContain('上次链接的（1）')
    expect(cap.out.join('')).toContain('执行计划预览：')
    const pkg = JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8'))
    expect(pkg.dependencies['@t/a']).toContain('link:')
    expect(pkg.dependencies['@t/b']).toContain('link:')
  })

  it('VI-2：无 last.json → 「上次链接的」不出现，仅「全部已注册」', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(shortcutOpts().map((o) => o.label)).toEqual(['全部已注册（1）'])
  })

  it('VI-3：N 的口径 = 渲染期长度（不过滤失效名字）', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(shortcutOpts()[1]!.label).toContain('上次链接的（2）')
  })

  it('VI-4：勾「上次链接的」含失效名字 → 逐行剔除提示 + 其余照常 + 不报错', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('⚠️ @t/gone 已不在注册表，已跳过')
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/a']).toContain('link:')
  })

  it('VI-5：虚拟项触发的 last 刷新（展开后仅 1 个也刷新）', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    // 判别力（T6 评审 Important-1）：初始 last 含一个「将在展开期被剔除」的 @t/gone——
    // 无 forceLastWrite 传导时 targets 过滤后 =1 < 2 不刷新，终态会是 ['@t/a','@t/gone']；传导后才收敛为 ['@t/a']
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/a'])
  })

  it('VI-6：无注册且无 last（空态）→ 不进主列表、无「快捷」组', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('quit')
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(groupMultiselect).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalled()   // 走的是空态向导，不是主列表
  })

  it('VI-7：有「扫描发现」但无注册、无 last → 主列表仍出现，但无「快捷」组', async () => {
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(join(scan, 'lib-x'), { recursive: true })
    writeFileSync(join(scan, 'lib-x', 'package.json'), JSON.stringify({ name: '@t/found' }), 'utf8')
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true)
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scan] }), 'utf8')
    vi.mocked(groupMultiselect).mockResolvedValueOnce([] as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)              // 空选中 → exit 1
    const arg = vi.mocked(groupMultiselect).mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(arg.options['快捷']).toBeUndefined()
    expect(arg.options['扫描发现（1）']).toBeDefined()
  })

  it('VI-8：交互勾选 ≥ 2 个普通项 → last 刷新（S10 只补断言，代码未改）', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a', '@t/b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    const last = JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')) as { names: string[] }
    expect([...last.names].sort()).toEqual(['@t/a', '@t/b'])
  })

  it('VI-9：虚拟项 + 手勾普通项混选 → 去重后只链一次', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    writeLast(ws, ['@t/a'])
    stubTty(true); makeHome()
    // 同时勾「全部已注册」「上次链接的」与重复的普通项 @t/a
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__all_registered__', '@t/a', '\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)                                  // install 恰一次
    const out = cap.out.join('')
    expect(out.match(/改写 apps\/web\/package\.json:/g)?.length).toBe(1)     // 同一 manifest 只列一段
    expect(out).not.toContain('已链接跳过：')                                // 去重后不该出现「已链接跳过」
  })

  it('VI-10：虚拟项「全部命中已链接、跳过」→ 空计划也把 last 对齐全集（spec §4.6 表 #3）', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    writeLast(ws, ['@t/a'])   // 顺带建出 .lpm/ 目录
    // state 预置：@t/a 与 @t/b 都已链接 → 勾「上次链接的」展开后只有 @t/a，已链接 → 全跳过、计划为空
    writeFileSync(join(ws, '.lpm', 'state.json'), JSON.stringify({ version: 1, links: {
      '@t/a': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      '@t/b': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
    } }), 'utf8')
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()                                   // 空计划不进确认
    expect(cap.out.join('')).toContain('无待执行变更')
    // 判别力（最终评审 Important-1）：不加修复时交互空计划分支不写 last，终态仍是 ['@t/a']，此断言必红
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/a', '@t/b'])
  })

  it('VI-11：虚拟项展开后全 corrupt 前置剔除 → keep 空也把 last 刷到 links 全集（OCR #3 回归钉）', async () => {
    // 注册值损坏（libs['@t/bad']=42，非字符串）：损坏条目仍计入 registered → 「快捷」组的「上次链接的」出现
    const ws = makeWs({
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/bad': 42 } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: {
        '@t/x': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } }),
    })
    writeLast(ws, ['@t/bad'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(shortcutOpts().map((o) => o.value)).toContain('\u0000__last__')    // 「上次链接的」确已出现
    expect(cap.out.join('')).toContain('⚠️ @t/bad 注册值损坏，已跳过')          // 前置剔除确实发生
    expect(cap.out.join('')).toContain('无待执行变更')                          // keep 空 → 早退分支
    // 判别力：不修时该分支在 buildLinkPlan 之前 return，不写 last → 终态仍是 ['@t/bad']；修复后刷新到 links 全集 ['@t/x']
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/x'])
  })
})
