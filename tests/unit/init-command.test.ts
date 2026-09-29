import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(), isCancel: vi.fn(() => false),
}))

import { confirm } from '@clack/prompts'
import { runInit, runUninit } from '../../src/commands/init.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  // 还原 isTTY 默认（非 TTY）
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  process.exitCode = undefined
})
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})

const CONFIG_TS = 'export default defineConfig({\n  antd: {},\n})\n'

// 宿主 + workspace 一体化 fixture：dir 为 workspace 根，apps/web 为宿主
function makeHost(extraLibs: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-cmd-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }), 'utf8')
  const web = join(dir, 'apps', 'web')
  mkdirSync(join(web, 'config'), { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'web', dependencies: { antd: '^5.0.0' } }), 'utf8')
  writeFileSync(join(web, 'config', 'config.ts'), CONFIG_TS, 'utf8')
  const libDir = join(dir, 'libs', 'mylib')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, 'package.json'), JSON.stringify({ name: '@t/mylib', peerDependencies: { antd: '*' } }), 'utf8')
  writeFileSync(join(dir, 'lpm.config.json'), JSON.stringify({ version: 1, libs: { '@t/mylib': 'libs/mylib', ...extraLibs } }), 'utf8')
  return web
}
function hostConfig(web: string): string { return join(web, 'config', 'config.ts') }
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('runInit（spec §3.2/§4.6）', () => {
  it('dry-run：首行 + + 行 + 宿主配置 byte 级零写盘 + exit 0', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('init dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.stdout()).toContain('+ ')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('TTY + confirm=true → 写盘 + 完成提示', async () => {
    const web = makeHost()
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    expect(await runInit(web)).toBe(0)
    expect(readFileSync(hostConfig(web), 'utf8')).toContain('/* lpm-inject:start */')
    expect(cap.stdout()).toContain('已注入 utoopack 适配片段')
  })
  it('TTY + confirm=false → 已取消 + 零写盘 + exit 1', async () => {
    const web = makeHost()
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(false)
    const cfg = hostConfig(web)
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('非 TTY：I5 文案 + exit 1 + 零 clack 调用', async () => {
    const web = makeHost()
    const cap = captureOut()
    expect(await runInit(web)).toBe(1)
    expect(cap.stderr()).toContain('需交互确认注入/摘除计划')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('无已注册 lib → 提示 + 零写盘 + exit 0', async () => {
    const web = makeHost()
    writeFileSync(join(web, '..', '..', 'lpm.config.json'), JSON.stringify({ version: 1, libs: {} }), 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('当前没有任何已注册的 lib')
  })
  it('已注入 → I6 + 零写盘', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('宿主配置已注入 lpm 片段')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('root 跨盘符 → I3（lib 指向与 tmp 盘符不同的对侧盘）', async () => {
    const web = makeHost()
    const tmpDrive = tmpdir().charAt(0).toUpperCase()
    const otherDrive = tmpDrive === 'C' ? 'D' : 'C'
    writeFileSync(join(web, '..', '..', 'lpm.config.json'), JSON.stringify({ version: 1, libs: { '@t/x': `${otherDrive}:/elsewhere` } }), 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('无法计算 utoopack.root')
  })
})

describe('runUninit（spec §3.3/§4.6）', () => {
  it('dry-run 未注入 → I7 + 零写盘 + exit 1', async () => {
    const web = makeHost()
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('未检测到 lpm 注入片段')
  })
  it('dry-run 已注入 → - 行 + 零写盘 + exit 0', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('- ')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('TTY + confirm=true → 摘除还原 + 提示', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    // 无尾逗号宿主（byte 恒等前提，spec §8 自决 1）：注入后 antd 行尾的逗号是 lpm 补的，摘除时连同删除 → 还原原版
    const original = 'export default defineConfig({\n  antd: {}\n})\n'
    writeFileSync(cfg, 'export default defineConfig({\n  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */\n})\n', 'utf8')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    expect(await runUninit(web)).toBe(0)
    expect(readFileSync(cfg, 'utf8')).toBe(original)
    expect(cap.stdout()).toContain('已摘除 utoopack 适配片段')
  })
  it('不完整标记 → I8 + 零写盘', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('不完整的 lpm 注入标记')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
})
