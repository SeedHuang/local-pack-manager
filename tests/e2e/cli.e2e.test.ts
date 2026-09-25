import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
