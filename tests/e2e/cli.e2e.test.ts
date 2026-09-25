import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
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
