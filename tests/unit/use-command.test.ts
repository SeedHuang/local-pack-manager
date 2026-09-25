import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}))

import { confirm, isCancel } from '@clack/prompts'
import { runUse } from '../../src/commands/use.js'

// use 命令内部 findWorkspaceRoot(cwd)：临时目录必含 package.json（单包 fallback 根即临时目录自身，S2 §4.4.5）
const dirs: string[] = []
function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-use-'))
  dirs.push(dir)
  const full = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
  for (const [name, content] of Object.entries(full)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}
function cfgFile(dir: string): string {
  return join(dir, 'lpm.config.json')
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
  }
}

beforeEach(() => {
  vi.mocked(confirm).mockReset()
  vi.mocked(isCancel).mockReset()
  vi.mocked(isCancel).mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('显式 lpm use <pm>（spec §4.5）', () => {
  it('用例 10a：config 缺失 → 新建并写入（pnpm）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const cap = captureOut()
    const code = await runUse('pnpm', dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('已设定包管理器：pnpm')
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8'))).toMatchObject({
      version: 1,
      packageManager: 'pnpm',
      libs: {},
    })
  })

  it('用例 10b：use yarn + __metadata → 写入 yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '__metadata:\n' })
    const code = await runUse('yarn', dir)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('yarn-berry')
  })

  it('用例 10c：use yarn 无细分证据 → 写入 yarn-classic', async () => {
    const dir = makeProject({ 'yarn.lock': '# yarn lockfile v1\n' })
    await runUse('yarn', dir)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('yarn-classic')
  })

  it('用例 11：幂等——已设定同值不写（mtime 不变，§6.6）', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    })
    const before = statSync(cfgFile(dir)).mtimeMs
    const cap = captureOut()
    const code = await runUse('pnpm', dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('包管理器已设定为 pnpm')
    expect(statSync(cfgFile(dir)).mtimeMs).toBe(before)
  })
  it('用例 11b：显式 use + config 非对象 → 退出 1 且不写（§6.5，OCR 修复 M2/M1）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '', 'lpm.config.json': '[]' })
    const cap = captureOut()
    const code = await runUse('pnpm', dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('应为 JSON 对象')
    expect(cap.stderr()).toContain('可抛弃重建')
    expect(readFileSync(cfgFile(dir), 'utf8')).toBe('[]')
  })
})

describe('冲突（B2，spec §4.5 步骤 3–4 / §6.3–6.4）', () => {
  it('用例 12a：TTY + confirm 拒绝 → 未变更退出 0，不写', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(true)
    vi.mocked(confirm).mockResolvedValue(false)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(0)
    expect(cap.stderr()).toContain('冲突')
    expect(cap.stdout()).toContain('已取消，未变更')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })

  it('用例 12b：TTY + confirm 同意 → 写入并回显冲突继续', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(true)
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('npm')
    expect(cap.stdout()).toContain('冲突，已按你的选择继续')
  })

  it('用例 12c：非 TTY → 报错退出 1，不写（§6.4）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(undefined)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('无法交互确认')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })
})

describe('裸 lpm use（spec §4.5）', () => {
  it('用例 13a：已有设定 → 仅显示设定，不跑检测', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'npm', libs: {} }),
    })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('当前设定：npm')
    expect(cap.stdout()).not.toContain('检测到包管理器')
  })

  it('用例 13b：无设定检测成功 → 显示依据，不落盘（§9.1 仅显式写入）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('检测到包管理器：pnpm')
    expect(cap.stdout()).toContain('pnpm-lock.yaml')
    expect(cap.stdout()).toContain('如需固化设定')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })

  it('用例 13c：歧义 → 错误退出 1（§6.1）', async () => {
    const dir = makeProject({ 'package-lock.json': '', 'yarn.lock': '' })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('歧义')
    expect(cap.stderr()).toContain('lpm use')
  })

  it('用例 13d：无证据 → 错误退出 1（§6.2）', async () => {
    const dir = makeProject()
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('无法推断包管理器')
  })

  it('用例 13e：cwd 不存在 → WorkspaceNotFoundError 接住，退出 1（§6.9）', async () => {
    const cap = captureOut()
    const code = await runUse('pnpm', join(tmpdir(), 'lpm-no-such-dir-x9z7'))
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('路径不存在')
  })

  it('用例 13f：config 坏 JSON → LpmConfigParseError 文案退出 1（§6.5，OCR 修复 M2）', async () => {
    const dir = makeProject({ 'lpm.config.json': '{oops' })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('不是合法 JSON')
    expect(cap.stderr()).toContain('可抛弃重建')
  })
})
