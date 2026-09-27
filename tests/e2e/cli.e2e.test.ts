import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('lpm status（stub）：exit 0，stderr 含尚未实现与 S8', async () => {
    const r = await runCli(['status'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('尚未实现')
    expect(r.stderr).toContain('S8')
  })

  it('lpm lnik（未知命令）：exit ≠ 0，stderr 非空', async () => {
    const r = await runCli(['lnik'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
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
