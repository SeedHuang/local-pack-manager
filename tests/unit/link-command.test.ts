import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { select, text, isCancel } from '@clack/prompts'
import { runLink } from '../../src/commands/link.js'

const dirs: string[] = []

/** workspace：pnpm-workspace（apps/web 依赖 @t/lib ^1.0.0）+ config（packageManager=pnpm）+ lockfile */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-link-'))
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

/** lib：sibling 于 ws（同盘），name=@t/lib，main 可解析，node_modules 非空，build:watch 有 */
function makeLib(withWatch = true): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  mkdirSync(lib, { recursive: true }) // 任务书工厂修正：join 出的 'lib' 子目录需先建（原笔误致 ENOENT）
  const manifest: Record<string, unknown> = { name: '@t/lib', main: './index.js' }
  if (withWatch) (manifest as { scripts: object }).scripts = { 'build:watch': 'echo watch' }
  writeFileSync(join(lib, 'package.json'), JSON.stringify(manifest), 'utf8')
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
}

function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
function captureOut() {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
    clear: (): void => { out.mockClear(); err.mockClear() }, // 同一 it 内多次 captureOut 共享进程级 spy（calls 累积），需手动清零（T4-26）
  }
}
function cfgOf(ws: string): { libs: Record<string, string> } {
  return JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8'))
}
function stateOf(ws: string): { links: Record<string, { original: Record<string, string>; linkedAt: string }> } | null {
  const p = join(ws, '.lpm', 'state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const relPkg = (root: string, dir: string) => join(root, dir, 'package.json')
const relPathOf = (root: string, abs: string): string => relative(root, abs).replaceAll('\\', '/')

beforeEach(() => {
  vi.mocked(execa).mockImplementation((async (cmd: unknown, args: unknown[]) => {
    if (cmd === 'git') {
      const op = (args as string[])[0]
      if (op === 'rev-parse') return { stdout: dirs[0] ?? '' } as never // 仓库根 ≈ 第一临时目录（测试内仅验证调用形态）
      if (op === 'show') {
        // git show HEAD:<path> → 返回预置 HEAD 版 manifest 文本（依赖项为 registry range）
        return { stdout: JSON.stringify({ name: 'x', dependencies: { '@t/lib': '^0.9.0' } }) } as never
      }
      return { stdout: '' } as never
    }
    return { exitCode: 0 } as never // install 成功
  }) as never)
  vi.mocked(isCancel).mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('A. 参数与入口', () => {
  it('T4-1 无参数 → 用法提示 + exit 1', async () => {
    const cap = captureOut()
    expect(await runLink([], {})).toBe(1)
    expect(cap.stdout()).toContain('lpm link <名字|路径>')
  })
  it('T4-2 未注册名 → #12 文案 + exit 1', async () => {
    const ws = makeWs()
    const cap = captureOut()
    expect(await runLink(['nope'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('未知注册名/路径不存在')
    expect(cap.stderr()).toContain('已注册')
  })
  it('T4-3 注册名命中：全链成功（config 幂等不重写 mtime）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPathOf(ws, lib) } }))
    const before = statSync(join(ws, 'lpm.config.json')).mtimeMs
    const cap = captureOut()
    expect(await runLink(['@t/lib'], {}, ws)).toBe(0)
    expect(statSync(join(ws, 'lpm.config.json')).mtimeMs).toBe(before) // 同值 upsert 不写（D2）
    expect(cap.stdout()).toContain('链接完成')
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toContain('"link:')
    const st = stateOf(ws)
    expect(st?.links['@t/lib']?.original).toBeTruthy()
    expect(new Date(st?.links['@t/lib']?.linkedAt ?? '').toISOString()).toBe(st?.links['@t/lib']?.linkedAt) // ISO 8601
  })
  it('T4-4 libs 值非串 → #12', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { broken: 42 } }) })
    const cap = captureOut()
    expect(await runLink(['broken'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('注册值损坏')
  })
  it('T4-5 未注册 scoped 名 → #12 双提示（非 dir-missing 误导，A3）', async () => {
    const ws = makeWs()
    const cap = captureOut()
    expect(await runLink(['@other/pkg'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('已注册')
    expect(cap.stderr()).toContain('先注册')
  })
  it('T4-6 路径分支全链：config 写入 key=lib name + 正斜杠相对路径', async () => {
    const ws = makeWs()
    const lib = makeLib()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBe(relPathOf(ws, lib))
    const st = stateOf(ws)
    expect(Object.keys(st?.links['@t/lib']?.original ?? {})).toEqual(['apps/web/package.json']) // G1：相对根 + /package.json（任务书注释字面；原行 relPathOf(ws, 'apps/web') 误传相对实参）
  })
  it('T4-7 detected PM 提示行（config 无 packageManager → lockfile 推断 pnpm）', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    const lib = makeLib()
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('检测到包管理器：pnpm')
  })
  it('T4-31 Object.prototype 未污染：lpm link constructor → 未知注册名（OCR O6）', async () => {
    const ws = makeWs()
    const cap = captureOut()
    expect(await runLink(['constructor'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('未知注册名/路径不存在')
    expect(cap.stderr()).not.toContain('注册值损坏')
  })
})

describe('A4/B4 交互', () => {
  it('T4-8 PMAmbiguous 透传 exit 1', async () => {
    const ws = makeWs({
      'package-lock.json': '',
      'lpm.config.json': JSON.stringify({ version: 1, libs: {} }), // 去掉 packageManager → 推断 → 双 lockfile 歧义
    })
    const cap = captureOut()
    expect(await runLink(['@t/lib'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('多个 lockfile')
  })
  it('T4-9 B4 形态 B：monorepo lib → select 选成员 → 链接成员', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-mono-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib', main: './index.js', scripts: {} }), 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/index.js'), '', 'utf8')
    mkdirSync(join(mono, 'pkgs/inner/node_modules'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/node_modules/.keep'), '', 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue(join(mono, 'pkgs/inner'))
    expect(await runLink([mono], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBe(relPathOf(ws, join(mono, 'pkgs/inner')))
  })
  it('T4-10 B4 非 TTY → #13', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-mono-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib' }), 'utf8')
    const cap = captureOut()
    expect(await runLink([mono], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('monorepo 根')
    expect(cap.stderr()).toContain('无法交互')
  })
  it('T4-11 B4 形态 A（根无 package.json + pnpm-workspace.yaml）→ listWorkspaceMembers 让选', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-monoa-'))
    dirs.push(mono)
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pnpm-workspace.yaml'), "packages:\n  - 'pkgs/*'\n", 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/index.js'), '', 'utf8')
    mkdirSync(join(mono, 'pkgs/inner/node_modules'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/node_modules/.keep'), '', 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue(join(mono, 'pkgs/inner'))
    expect(await runLink([mono], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBeTruthy()
  })
  it('T4-12 B4 select 取消 → exit 1「已取消」', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-monoc-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib' }), 'utf8')
    stubTty(true)
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runLink([mono], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('已取消')
  })
})

describe('E. 幂等与非 lpm', () => {
  it('T4-13 幂等跳过：state 有条目 → 不 checkLib/install，state/pkg byte 原样', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const relPath = relPathOf(ws, lib)
    writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPath } }))
    const pkgPath = relPkg(ws, 'apps/web')
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    const stateJson = JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: new Date(0).toISOString() } } })
    writeFileSync(join(stateDir, 'state.json'), stateJson, 'utf8')
    const pkgBefore = readFileSync(pkgPath, 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已链接')
    expect(execa).not.toHaveBeenCalled()                       // 零子进程（含 install）
    expect(readFileSync(pkgPath, 'utf8')).toBe(pkgBefore)      // pkg 零改写
    expect(readFileSync(join(stateDir, 'state.json'), 'utf8')).toBe(stateJson) // state byte 原样（C1）
  })
  it('T4-14 批量混入：[已链接 A, 新 B] → A 跳过 B 链接，install 恰一次', async () => {
    const ws = makeWs()
    const libA = makeLib()
    const relA = relPathOf(ws, libA)
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    mkdirSync(libBDir, { recursive: true }) // 'lib' 子目录需先建（同 makeLib 工厂修正）
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    // web：A 已链接（pkg 处于 link 形态，跳过不改写）+ 新依赖 B（registry range 待改写）
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere', '@t/libb': '^2.0.0' } }), 'utf8')
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: new Date(0).toISOString() } } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([libA, libBDir], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已链接：@t/lib')
    expect((stateOf(ws)?.links['@t/libb'] ?? null)).toBeTruthy()
    const installCalls = vi.mocked(execa).mock.calls.filter((c) => c[0] !== 'git')
    expect(installCalls).toHaveLength(1) // 单次 install（E6c）
    const finalPkg = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    expect(finalPkg).toContain('"link:')  // 两处改写共存（链式，E5）
    expect(finalPkg.match(/"link:/g)?.length).toBe(2)
  })
  it('T4-15 全部已链接 → 零 install 零写盘 exit 0', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, links: { '@t/lib': { original: {}, linkedAt: new Date(0).toISOString() } } }), 'utf8')
    vi.mocked(execa).mockClear()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false) // I3 全跳过不写 last
  })
  it('T4-16 非 lpm TTY：git HEAD 通道 → original 记录 HEAD 值', async () => {
    const ws = makeWs()
    const lib = makeLib()
    // web 当前值手动改为本地协议（模拟用户手动 link）
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('head')
    expect(await runLink([lib], {}, ws)).toBe(0)
    const st = stateOf(ws)
    expect(Object.values(st?.links['@t/lib']?.original ?? {})).toContain('^0.9.0') // git show mock 的 HEAD 值
  })
  it('T4-17 非 lpm 手动输入本地协议 → 拒绝重提示，3 次后放弃（F12）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('manual')
    vi.mocked(text).mockResolvedValue('link:../oops')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0) // 3 次耗尽 → 放弃 → exit 0
    expect(cap.stderr()).toContain('不应为本地协议值')
    expect(stateOf(ws)).toBeNull() // 未落 state
  })
  it('T4-18 非 lpm 放弃 → config 注册保留 + state/pkg 零写 + exit 0（F11 语义）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('abandon')
    const pkgBefore = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已放弃')
    expect(cap.stdout()).toContain('注册已保留')
    expect(cfgOf(ws).libs['@t/lib']).toBeTruthy() // 注册保留（D5 在前）
    expect(stateOf(ws)).toBeNull()
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toBe(pkgBefore)
  })
  it('T4-19 非 lpm 非 TTY → #14 exit 1', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('非 lpm 管理的本地链接')
  })
  it('T4-20 O5 零命中 → 「先 pnpm add」exit 1（LinkTargetError）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { other: '^1.0.0' } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('不在任何成员依赖中')
    expect(cap.stderr()).toContain('pnpm add')
  })
  it('T4-32 同 manifest 多段命中：改写两段、计数不虚增、明细不重复（OCR O7）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' }, devDependencies: { '@t/lib': '^1.0.0' } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    const pkg = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    expect(pkg.match(/"link:/g)?.length).toBe(2)
    const out = cap.stdout()
    expect(out).toContain('2 处声明改写')
    expect(out).not.toContain('已链接跳过') // unchanged 零虚增
    const lines = out.split('\n').filter((l) => l.includes('dependencies.@t/lib') || l.includes('devDependencies.@t/lib'))
    expect(lines).toHaveLength(2) // 两段各一行，无重复
  })
})

describe('E6/last/watch/dry-run/O4', () => {
  it('T4-21 同文件多 target 链式改写：两处 link: 共存无覆盖（F1）', async () => {
    const ws = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    mkdirSync(libBDir, { recursive: true }) // 'lib' 子目录需先建（同 makeLib 工厂修正）
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    expect(await runLink([libA, libBDir], {}, ws)).toBe(0)
    const pkg = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    expect(pkg.match(/"link:/g)?.length).toBe(2)
    expect(pkg).toContain('@t/lib')
    expect(pkg).toContain('@t/libb')
  })
  it('T4-22 落盘顺序不变量：install 被调用时 state+pkg 均已写入（计划期修订 7）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    let stateAtInstall: string | null = null
    let pkgAtInstall: string | null = null
    vi.mocked(execa).mockImplementation((async (cmd: unknown) => {
      if (cmd !== 'git') {
        stateAtInstall = existsSync(join(ws, '.lpm', 'state.json')) ? readFileSync(join(ws, '.lpm', 'state.json'), 'utf8') : null
        pkgAtInstall = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
      }
      return { exitCode: 0 } as never
    }) as never)
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(stateAtInstall).toContain('"@t/lib"')
    expect(pkgAtInstall).toContain('"link:')
  })
  it('T4-23a last：targets=2 → names=操作后全集；T4-23b targets=1 → 不写', async () => {
    const ws2 = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    mkdirSync(libBDir, { recursive: true }) // 'lib' 子目录需先建（同 makeLib 工厂修正）
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws2, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    expect(await runLink([libA, libBDir], {}, ws2)).toBe(0)
    const last = JSON.parse(readFileSync(join(ws2, '.lpm', 'last.json'), 'utf8'))
    expect(last.names.sort()).toEqual(['@t/lib', '@t/libb'])

    const ws1 = makeWs()
    const lib1 = makeLib()
    expect(await runLink([lib1], {}, ws1)).toBe(0)
    expect(existsSync(join(ws1, '.lpm', 'last.json'))).toBe(false)
  })
  it('T4-24 watch：spawn 参数正确 + dry-run 不拉起', async () => {
    const ws = makeWs()
    const lib = makeLib()
    vi.mocked(execa).mockClear()
    expect(await runLink([lib], { watch: true }, ws)).toBe(0)
    const watchCall = vi.mocked(execa).mock.calls.find((c) => (c[1] as string[])?.[0] === 'run')
    expect(watchCall?.[0]).toBe('npm') // lib 无 lockfile → 回退 npm（§2 裁决 2）
    expect(watchCall?.[1]).toEqual(['run', 'build:watch'])

    const wsD = makeWs()
    const libD = makeLib()
    vi.mocked(execa).mockClear()
    expect(await runLink([libD], { watch: true, dryRun: true }, wsD)).toBe(0)
    expect(vi.mocked(execa).mock.calls.filter((c) => c[0] !== 'git')).toHaveLength(0) // dry-run 零子进程
  })
  it('T4-25 dry-run 零写盘 + 计划内容（config/state/pkg/last/gitignore 全不变）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const snapshot = (): string => readdirSync(ws).sort().map((f) => `${f}:${existsSync(join(ws, f)) ? statSync(join(ws, f)).mtimeMs : ''}`).join('|')
    const before = snapshot()
    const cap = captureOut()
    expect(await runLink([lib], { dryRun: true }, ws)).toBe(0)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).not.toContain('link:')
    expect(cap.stdout()).toContain('dry-run 执行计划')
    expect(cap.stdout()).toContain('install --no-frozen-lockfile')
    expect(cap.stdout()).toContain('@t/lib')
  })
  it('T4-26 O4 输出形态（J1）：changedKeys 逐条 + 防误 commit 尾行 + dry-run 一致性（§7.4 #7）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    const out = cap.stdout()
    expect(out).toContain('dependencies.@t/lib：^1.0.0 → link:')
    expect(out).toContain('请勿提交')
    // dry-run 一致性：另一同构 ws 先 dry-run 后真实，改写明细一致
    const ws2 = makeWs()
    const lib2 = makeLib()
    const cap2 = captureOut()
    cap2.clear() // 清掉第一个场景累积的 calls（共享 spy），planOut 仅含 ws2 dry-run 输出
    await runLink([lib2], { dryRun: true }, ws2)
    const planOut = cap2.stdout()
    expect(await runLink([lib2], {}, ws2)).toBe(0)
    const realPkg = readFileSync(relPkg(ws2, 'apps/web'), 'utf8')
    const m = planOut.match(/dependencies\.@t\/lib：(\S+) → (\S+)/)
    expect(m).not.toBeNull()
    expect(realPkg).toContain(`"${m?.[2]}"`)
  })
  it('T4-27 install 失败 → exit 1 + state 保留 + 逃生门文案（#16）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    vi.mocked(execa).mockImplementation((async (cmd: unknown) => {
      if (cmd !== 'git') throw { exitCode: 1, stderr: 'ERR_PNPM' }
      return { stdout: '' } as never
    }) as never)
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('install 失败')
    expect(cap.stderr()).toContain('state 已保留')
    expect(stateOf(ws)?.links['@t/lib']).toBeTruthy() // state 未回滚（E6c 失败语义）
  })

  it('T4-28 git HEAD 通道不可用 → ①禁用并列原因（spec §7.2 #11）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(execa).mockImplementation((async (cmd: unknown) => {
      if (cmd === 'git') throw new Error('git not found') // rev-parse 失败 → ①不可用
      return { exitCode: 0 } as never
    }) as never)
    vi.mocked(select).mockImplementation((async (o: { options: Array<{ value: string; label: string }> }) => {
      expect(o.options.some((x) => x.value === 'head')).toBe(false) // OCR O2：不可用时不提供该选项
      return 'manual'
    }) as never)
    vi.mocked(text).mockResolvedValue('^0.9.0')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stderr()).toContain('git HEAD 通道不可用')
    expect(Object.values(stateOf(ws)?.links['@t/lib']?.original ?? {})).toContain('^0.9.0')
  })

  it('T4-29 watch spawn 失败 → 警告 + 退出码不变（H7 / spec §7.2 #19）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(join(lib, 'pnpm-lock.yaml'), '') // lib PM → pnpm
    vi.mocked(execa).mockImplementation((async (cmd: unknown, args: unknown[]) => {
      if ((args as string[])?.[0] === 'run') throw new Error('spawn ENOENT') // build:watch spawn 失败
      return { exitCode: 0 } as never
    }) as never)
    const cap = captureOut()
    expect(await runLink([lib], { watch: true }, ws)).toBe(0) // 退出码不变（链接已成功）
    expect(cap.stderr()).toContain('build:watch 异常退出')
  })

  it('T4-23c last 写失败 → 警告 + 退出码不变（spec §7.2 #18）', async () => {
    const ws2 = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    mkdirSync(libBDir, { recursive: true }) // 'lib' 子目录需先建（同 makeLib 工厂修正）
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws2, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    mkdirSync(join(ws2, '.lpm', 'last.json'), { recursive: true }) // last.json 为目录 → rename 失败
    const cap = captureOut()
    expect(await runLink([libA, libBDir], {}, ws2)).toBe(0)
    expect(cap.stderr()).toContain('last.json 写入失败')
  })

  it('T4-33 dry-run 计划展示可执行名而非逻辑 id（OCR 残余①）', async () => {
    const ws = makeWs({
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'yarn-berry', libs: {} }),
      'yarn.lock': '__metadata:\n',
    })
    const lib = makeLib()
    const cap = captureOut()
    expect(await runLink([lib], { dryRun: true }, ws)).toBe(0)
    const out = cap.stdout()
    expect(out).toContain('yarn install --no-immutable')
    expect(out).not.toContain('yarn-berry install')
  })
})

describe('S6 留观补测（N-7/M-4）', () => {
  it('N7-22：§7.2 #22 批量遇错即停——good+bad 混批 → exit 1 零写盘', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const before = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    const r = await runLink([lib, join(ws, 'no-such-dir')], {}, ws)
    expect(r).toBe(1)
    expect(stateOf(ws)).toBeNull() // 聚合在内存——遇错即停零写盘
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toBe(before)
  })
  it('N7-13：§7.2 #13 同 key 去重——注册名 + 同 lib 路径 → 跳过合计含去重 1 处', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(
      join(ws, 'lpm.config.json'),
      JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPathOf(ws, lib) } }),
      'utf8',
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const out = captureOut()
    const r = await runLink(['@t/lib', lib], {}, ws)
    expect(r).toBe(0)
    expect(out.stdout()).toContain('已链接跳过：1 处') // dedupSkipped 计入 J2
    out.clear()
  })
  it('N7-20：§7.2 #20 --watch dry-run → watch 行断言', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const out = captureOut()
    const r = await runLink([lib], { watch: true, dryRun: true }, ws)
    expect(r).toBe(0)
    expect(out.stdout()).toContain('watch：拉起')
    expect(out.stdout()).toContain('run build:watch')
    out.clear()
  })
})
