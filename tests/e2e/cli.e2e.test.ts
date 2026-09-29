import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os, { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from './helpers.js'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const COMMAND_NAMES = [
  'use', 'link', 'unlink', 'status', 'repair',
  'save', 'preset', 'forget', 'dir', 'init', 'uninit',
]

// 工作目录用临时目录（spec §7.3）；S1 stub 不读工作区，任意存在目录皆可
const cwd = os.tmpdir()

describe('lpm CLI e2e', () => {
  it('--version：exit 0，stdout 为纯 semver 且与 package.json 一致', async () => {
    const r = await runCli(['--version'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(pkg.version)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('--help：exit 0，列出全部 11 个命令', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.exitCode).toBe(0)
    for (const name of COMMAND_NAMES) {
      expect(r.stdout).toContain(name)
    }
  })

  it('无参数：exit 0，stdout 含 help/Usage', async () => {
    const r = await runCli([], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage/i)
  })

  it('lpm lnik（未知命令）：exit ≠ 0，stderr 非空且含中文建议', async () => {
    const r = await runCli(['lnik'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(r.stderr).toContain('最接近的命令：link')
  })

  it('lpm staus（未知命令错拼）：stderr 含最接近的命令：status', async () => {
    const r = await runCli(['staus'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('最接近的命令：status')
  })
})

// S3 e2e（spec §7.3）：临时目录含 package.json（findWorkspaceRoot 单包 fallback 根即临时目录自身）；
// spawn 即非 TTY——§6.4 非 TTY 冲突拒绝分支恰好在此实证，confirm 路径不进 e2e（unit 层 mock 覆盖）
describe('lpm use e2e（S3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-use-'))
    made.push(dir)
    const full = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  it('用例 17：use pnpm → exit 0，config 写入 pnpm', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'pnpm'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('已设定包管理器：pnpm')
    expect(JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8'))).toMatchObject({
      packageManager: 'pnpm',
    })
  })

  it('用例 18：裸 use → 检测展示，config 未创建', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('检测到包管理器：pnpm')
    expect(r.stdout).toContain('如需固化设定')
    expect(existsSync(join(dir, 'lpm.config.json'))).toBe(false)
  })

  it('用例 19：裸 use 多 lockfile → 歧义退出 1（§6.1）', async () => {
    const dir = makeProject({ 'package-lock.json': '', 'yarn.lock': '' })
    const r = await runCli(['use'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('歧义')
    expect(r.stderr).toContain('lpm use')
  })

  it('用例 20：use npm 冲突（非 TTY）→ 退出 1，config 未创建（§6.4）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'npm'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('冲突')
    expect(r.stderr).toContain('无法交互确认')
    expect(existsSync(join(dir, 'lpm.config.json'))).toBe(false)
  })

  it('用例 21：use yarn（yarn.lock 头部 __metadata）→ config 写入 yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '__metadata:\nversion: "8"\n' })
    const r = await runCli(['use', 'yarn'], dir)
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).packageManager).toBe(
      'yarn-berry',
    )
  })

  it('用例 22：use abc → commander choices 拒绝，exit ≠ 0', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'abc'], dir)
    expect(r.exitCode).not.toBe(0)
  })
})

describe('lpm link e2e（S6 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-link-e2e-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  const WS_FILES = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
  }

  it('E2E-1 dry-run：输出执行计划且项目 byte 级零变化（config/state/pkg/gitignore 均不产生）', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link', '--dry-run', join(ws, '..', 'no-such-lib')], ws)
    expect(r.exitCode).not.toBe(0) // lib 不存在 → 前置检查报错（dry-run 也要求参数有效，K3）
    // 正常 dry-run：临时 lib
    const lib = join(ws, '..', 'lpm-e2e-lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), '', 'utf8')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const r2 = await runCli(['link', '--dry-run', lib], ws)
    expect(r2.exitCode).toBe(0)
    expect(r2.stdout).toContain('dry-run 执行计划')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).not.toContain('link:')
  })

  it('E2E-2 无参数：提示用法 + exit 1', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('lpm link <名字|路径>')
  })

  it('E2E-3 未注册名：#12 文案 + exit 1', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link', 'ghost'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('未知注册名/路径不存在')
  })

  it('E2E-4 已链接路径（预置 state）：跳过 + 零变化 + exit 0', async () => {
    const ws = makeProject(WS_FILES)
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(
      join(ws, '.lpm', 'state.json'),
      JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }),
      'utf8',
    )
    // 路径分支 key=name 预读需要 lib 存在
    const lib = join(ws, '..', 'lpm-e2e-lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    const r = await runCli(['link', lib], ws)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('已链接：@t/lib')
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })

  it('E2E-5 --help link 行无「（计划 S6）」后缀；既有 11 例回归不变', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('把依赖切到本地目录联调')
    expect(r.stdout).not.toContain('把依赖切到本地目录联调（计划 S6）')
  })
})

describe('lpm unlink e2e（S7 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-unlink-e2e-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  const WS_FILES = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib/lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }),
  }
  const STATE_ONE = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }

  it('E2E-6 dry-run：计划输出恢复明细 + install/复验行 + 项目 byte 级零变化', async () => {
    const ws = makeProject({ ...WS_FILES, '.lpm/state.json': JSON.stringify(STATE_ONE) })
    const before = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runCli(['unlink', '--dry-run', '@t/lib'], ws)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('dry-run 执行计划')
    expect(r.stdout).toContain('恢复 apps/web/package.json')
    expect(r.stdout).toContain('dependencies.@t/lib：link:../lpm-lib → ^1.0.0')
    expect(r.stdout).toContain('install：pnpm install --no-frozen-lockfile')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })

  it('E2E-7 未链接名字：跳过 exit 0（spawn 即非 TTY 不触发交互）', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['unlink', 'ghost'], ws)
    expect(r.exitCode).toBe(0)
  })

  it('E2E-8 --all 空 state：无已链接项 exit 0', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['unlink', '--all'], ws)
    expect(r.exitCode).toBe(0)
  })

  it('E2E-9 --all 与 targets 互斥：exit 1', async () => {
    const ws = makeProject({ ...WS_FILES, '.lpm/state.json': JSON.stringify(STATE_ONE) })
    const r = await runCli(['unlink', '--all', '@t/lib'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('互斥')
  })

  it('E2E-10 --help unlink 行无「（计划 S7）」后缀', async () => {
    const r = await runCli(['--help'], os.tmpdir())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('恢复 registry 版本') // registry.ts unlink summary 实值
    expect(r.stdout).not.toContain('恢复 registry 版本（计划 S7）')
  })
})

// S8 e2e（spec §7.3）：status 只读诊断——真实用例替换原「lpm status（stub）」断言
// （计划给出的 mkFixture() 在本文件不存在；按本文件既有惯例自建 makeProject fixture）
describe('lpm status e2e（S8 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-status-e2e-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  const WS_FILES = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
  }

  it('E2E-ST1：lpm status --json 在 fixture 上输出结构化全量', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['status', '--json'], ws)
    expect(r.exitCode).toBe(0)
    const j = JSON.parse(r.stdout)
    expect(j.version).toBe(1)
    expect(Array.isArray(j.entries)).toBe(true)
  })
  it('E2E-ST2：--help status 行无「（计划 S8）」后缀', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.stdout).not.toContain('三方核对链接状态（计划 S8）')
  })
})

// S8 e2e（spec §7.3）：repair 六族自修复——spawn 即非 TTY，仅覆盖早退与 dry-run（交互路径由 unit mock 覆盖）
describe('lpm repair e2e（S8 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-repair-e2e-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  const WS_FILES = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
  }
  const STATE_ONE = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }

  it('E2E-RP1：lpm repair --dry-run 计划明细 + 项目 byte 级零变化', async () => {
    const ws = makeProject({ ...WS_FILES, '.lpm/state.json': JSON.stringify(STATE_ONE) })
    const pkgBefore = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const cfgBefore = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const r = await runCli(['repair', '--dry-run'], ws)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('dry-run 执行计划')
    expect(r.stdout).toContain('link:')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(pkgBefore)
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(cfgBefore)
    expect(existsSync(join(ws, '.lpm', 'last-run.json'))).toBe(false)
  })
  it('E2E-RP2：无异常时 lpm repair 早退 exit 0（不交互）', async () => {
    const r = await runCli(['repair'], makeProject(WS_FILES))
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('无异常，无需修复')
  })
  it('E2E-RP3：--help repair 行无「（计划 S8）」后缀', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.stdout).toContain('修复漂移与孤儿状态')
    expect(r.stdout).not.toContain('修复漂移与孤儿状态（计划 S8）')
  })
})

// S8 验收 6 端到端（spec §7 / PRD §13 行 383）：漂移被 status 报出、repair 给出计划且不碰项目文件。
// 漂移形态 = 手动 `git checkout package.json` 的等价形态：档案（.lpm/state.json）记着链接时的原 range，
// 而 apps/web/package.json 的声明已被改回 registry range（两者都是 ^1.0.0）。install 不在 e2e 真跑
// （本仓库零真实 install 惯例）——真实修复路径由 unit（REP-3，install 走 mock）覆盖。
describe('lpm 验收 6 e2e（S8 spec §7）', () => {
  const made: string[] = []
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  interface StatusFixtureOpts { drifted?: boolean }
  /** 最小 workspace：根清单 + pnpm workspace（apps/*）+ 通讯录注册 @t/lib → lpm-lib + lib 与成员清单 + node_modules/@t/lib 实体 */
  function mkStatusFixture(opts: StatusFixtureOpts = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-acc6-e2e-'))
    made.push(dir)
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'ws-root', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib' } }),
      'lpm-lib/package.json': JSON.stringify({ name: '@t/lib' }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    }
    for (const [n, c] of Object.entries(files)) {
      const p = join(dir, n)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, c, 'utf8')
    }
    // node_modules/@t/lib 为实体目录（PM 安装的 registry 版本）——直接 mkdir，非 junction，故不涉
    // 「junction 需父目录先存在」的 Windows 陷阱（若将来改 junction，须先 mkdir node_modules/@t）
    mkdirSync(join(dir, 'apps/web/node_modules/@t/lib'), { recursive: true })
    writeFileSync(join(dir, 'apps/web/node_modules/@t/lib/index.js'), '', 'utf8')
    if (opts.drifted === true) {
      // 漂移形态：档案记着链接前该文件的原值（root 相对路径键）
      mkdirSync(join(dir, '.lpm'), { recursive: true })
      writeFileSync(
        join(dir, '.lpm', 'state.json'),
        JSON.stringify({
          version: 1,
          links: {
            '@t/lib': {
              original: { 'apps/web/package.json': '^1.0.0' },
              linkedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        }),
        'utf8',
      )
    }
    return dir
  }

  /** 该目录下所有文件的「相对路径（正斜杠）→ 内容」映射，用于 byte 级零变化断言 */
  function snapshotManifests(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (abs: string): void => {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        const child = join(abs, e.name)
        if (e.isDirectory()) walk(child)
        else out[relative(dir, child).replaceAll('\\', '/')] = readFileSync(child, 'utf8')
      }
    }
    walk(dir)
    return out
  }

  it('E2E-ACC6：漂移被 status 报出、repair 计划给出目标链接值、项目文件 byte 级不变', async () => {
    const ws = mkStatusFixture({ drifted: true })
    const before = snapshotManifests(ws)

    // ① status --json：@t/lib 应命中 drifted（档案记着 + 声明是正式版本号）
    const s1 = await runCli(['status', '--json'], ws)
    expect(s1.exitCode).toBe(0)
    const j = JSON.parse(s1.stdout)
    const entry = (j.entries as Array<{ key: string; issues: string[] }>).find((e) => e.key === '@t/lib')
    expect(entry?.issues).toContain('drifted')

    // ② repair --dry-run：计划里出现目标链接值（apps/web → ../../lpm-lib）
    const plan = await runCli(['repair', '--dry-run'], ws)
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toContain('link:../../lpm-lib')

    // ③ 只读一致性：status 与 repair --dry-run 都不得改动项目文件
    expect(snapshotManifests(ws)).toEqual(before)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
})

// S9 e2e（spec §4.10）：无参数 + 非真终端（spawn 即非 TTY）→ 一行提示 + exit 1，且不得出现菜单残片
describe('lpm link / unlink 无参数 e2e（S9）', () => {
  it('E2E-S9-1：lpm link 无参数（非 TTY）→ exit 1 + 提示直通用法 + 无菜单残片', async () => {
    const r = await runCli(['link'], os.tmpdir())
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]')
    expect(r.stdout).not.toContain('◆')   // clack 菜单符号，出现即为「卡死前糊出的半张菜单」
    expect(r.stdout).not.toContain('│')
  })
  it('E2E-S9-2：lpm unlink 无参数（非 TTY）→ exit 1 + 提示直通用法 + 无菜单残片', async () => {
    const r = await runCli(['unlink'], os.tmpdir())
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm unlink <名字|路径>... [--all] [--dry-run]')
    expect(r.stdout).not.toContain('◆')
    expect(r.stdout).not.toContain('│')
  })
})

// S10：`lpm save` 错误路径（需要 workspace fixture——`findWorkspaceRoot` 在裸目录会先报错）
describe('lpm save e2e（S10）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-save-'))
    made.push(dir)
    const full: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) writeFileSync(join(dir, name), content, 'utf8')
    return dir
  }
  afterEach(() => { while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true }) })

  it('E2E-S10-5：save 无已链接 → exit 1 + 提示', async () => {
    const dir = makeProject()
    const r = await runCli(['save', 'x'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('当前没有任何已链接的库')
  })

  it('E2E-S10-4：preset 非 TTY → exit 1 + 提示 + 无菜单残片', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    const r = await runCli(['preset'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm preset rm <名>')
    expect(r.stdout).not.toContain('已删除预设')
  })

  it('E2E-S10-1：link --last 无记录 → exit 1 + 提示（且不含 lpm save 字样）', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--last'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('没有上次链接的记录')
    expect(r.stderr).not.toContain('lpm save')
  })

  it('E2E-S10-2：link --preset nope → exit 1 + 提示', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--preset', 'nope'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('预设不存在：nope')
  })

  it('E2E-S10-3：link --all --last → exit 1 + 互斥提示', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--all', '--last'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('三者互斥')
  })

  it('E2E-S12-1：save --dry-run → exit 0 + 计划文本 + config 零写盘（冒烟）', async () => {
    const dir = makeProject({
      'lpm.config.json': JSON.stringify({ version: 1, libs: {} }),
    })
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(
      join(dir, '.lpm', 'state.json'),
      JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }),
      'utf8',
    )
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const r = await runCli(['save', 'x', '--dry-run'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })
})

// S11 e2e（spec §6）：forget 需真实 workspace fixture（判定位置在 findWorkspaceRoot 之后）；
// dir 纯用户级但 e2e helper 不隔离 HOME——只测不写盘的面（非 TTY / 用法错误），写路径全归 unit（mock homedir）
describe('lpm forget e2e（S11）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-forget-'))
    made.push(dir)
    const full: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => { while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true }) })

  it('E2E-S11-1：forget 非 TTY 无参数 → exit 1 + 提示 + 无菜单残片', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }) })
    const r = await runCli(['forget'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm forget <名字|路径>')
    expect(r.stdout).not.toContain('已移除注册')
  })

  it('E2E-S11-2：forget 不存在 → exit 1 + 注册不存在', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }) })
    const r = await runCli(['forget', 'nope'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('注册不存在：nope')
  })

  it('E2E-S11-3：forget 已链接 → exit 1 + 先 unlink 提示', async () => {
    const dir = makeProject({
      'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }),
    })
    const r = await runCli(['forget', '@t/a'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('先 lpm unlink @t/a')
  })
})

describe('lpm dir e2e（S11）', () => {
  it('E2E-S11-4：dir 非 TTY 无参数 → exit 1 + 提示 + 无菜单残片（不写真实 ~/.lpm）', async () => {
    const r = await runCli(['dir'])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm dir add <路径>')
    expect(r.stdout).not.toContain('已移除扫描目录')
  })

  it('E2E-S11-5：dir 非法子命令 → exit 1 + 用法串（不写盘）', async () => {
    const r = await runCli(['dir', 'bogus'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('下一步：lpm dir add')  // S12 D4 统一模板：描述行「用法错误。」+ 下一步行含用法串
  })
})
