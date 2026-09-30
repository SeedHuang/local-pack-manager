import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoInitAfterLink, autoUninitAfterUnlinkAll, locateHostConfigInWs } from '../../src/commands/init.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  process.exitCode = undefined
})

// 无尾逗号宿主——S13 §8 自决 1：byte 往返恒等仅在「宿主无尾逗号」fixture 上断言
const CONFIG_TS = 'export default defineConfig({\n  antd: {}\n})\n'

/**
 * workspace 根 fixture：root 有 package.json + pnpm-workspace.yaml + lpm.config.json，
 * apps/web 为 umi 宿主（config/config.ts），libs/mylib 为已注册 lib（peer: antd）。
 * link/unlink 在 workspace 根运行——模拟真实场景：宿主在成员子包而非根。
 */
function makeWs(libs: Record<string, string> = { '@t/mylib': 'libs/mylib' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-auto-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }), 'utf8')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'libs/*'\n", 'utf8')
  const web = join(dir, 'apps', 'web')
  mkdirSync(join(web, 'config'), { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'web', dependencies: { antd: '^5.0.0' } }), 'utf8')
  writeFileSync(join(web, 'config', 'config.ts'), CONFIG_TS, 'utf8')
  // 宿主 node_modules 里的 peer（alias 计算需要探测到实际存在）
  mkdirSync(join(web, 'node_modules', 'antd'), { recursive: true })
  writeFileSync(join(web, 'node_modules', 'antd', 'package.json'), JSON.stringify({ name: 'antd' }), 'utf8')
  const lib = join(dir, 'libs', 'mylib')
  mkdirSync(lib, { recursive: true })
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/mylib', peerDependencies: { antd: '*' } }), 'utf8')
  writeFileSync(join(dir, 'lpm.config.json'), JSON.stringify({ version: 1, libs }), 'utf8')
  return dir
}
function webConfig(root: string): string { return join(root, 'apps', 'web', 'config', 'config.ts') }
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('locateHostConfigInWs（workspace 级宿主定位）', () => {
  it('宿主在成员子包（apps/web）→ 命中 config/config.ts 且返回宿主目录', async () => {
    const root = makeWs()
    const host = await locateHostConfigInWs(root)
    expect(host).not.toBeNull()
    expect(host?.hostPath).toBe(webConfig(root))
    expect(host?.dir).toBe(join(root, 'apps', 'web'))
  })
  it('无任何成员含 umi 配置 → null', async () => {
    const root = makeWs()
    rmSync(join(root, 'apps', 'web', 'config'), { recursive: true, force: true })
    expect(await locateHostConfigInWs(root)).toBeNull()
  })
})

describe('autoInitAfterLink（link 后自动注入）', () => {
  it('宿主 + 未注入 → 注入成功 + 完成提示含 uninit 逃生门', async () => {
    const root = makeWs()
    const cap = captureOut()
    const r = await autoInitAfterLink(root)
    expect(r.injected).toBe(true)
    expect(r.hostPath).toBe(webConfig(root))
    const after = readFileSync(webConfig(root), 'utf8')
    expect(after).toContain('/* lpm-inject:start */')
    expect(after).toContain("root: '")
    expect(after).toContain("antd: '")
    expect(cap.stdout()).toContain('已自动注入 utoopack 适配片段')
    expect(cap.stdout()).toContain('如需还原配置（摘除注入片段），运行 lpm uninit。')
  })
  it('已注入 → 幂等跳过（不二次注入）', async () => {
    const root = makeWs()
    await autoInitAfterLink(root)
    const once = readFileSync(webConfig(root), 'utf8')
    const cap = captureOut()
    const r = await autoInitAfterLink(root)
    expect(r.injected).toBe(false)
    expect(r.reason).toBe('already-injected')
    expect(readFileSync(webConfig(root), 'utf8')).toBe(once)
  })
  it('宿主已有 utoopack/alias 键 → 注入 + 合并提示（uninit 可还原）', async () => {
    const root = makeWs()
    writeFileSync(webConfig(root), 'export default defineConfig({\n  antd: {},\n  utoopack: {},\n})\n', 'utf8')
    const cap = captureOut()
    const r = await autoInitAfterLink(root)
    expect(r.injected).toBe(true)
    expect(cap.stdout()).toContain('检测到宿主已有 utoopack/alias 配置，已合并进宿主键；uninit 后可还原')
  })
  it('非 umi 项目（无宿主）→ 跳过，reason=no-umi-host', async () => {
    const root = makeWs()
    rmSync(join(root, 'apps', 'web', 'config'), { recursive: true, force: true })
    const r = await autoInitAfterLink(root)
    expect(r.injected).toBe(false)
    expect(r.reason).toBe('no-umi-host')
  })
  it('无已注册 lib → 跳过，reason=no-libs', async () => {
    const root = makeWs({})
    const r = await autoInitAfterLink(root)
    expect(r.injected).toBe(false)
    expect(r.reason).toBe('no-libs')
  })
})

describe('autoUninitAfterUnlinkAll（unlink 全部断开后自动摘除）', () => {
  it('已注入 → 摘除还原 + 完成提示', async () => {
    const root = makeWs()
    await autoInitAfterLink(root)
    const injected = readFileSync(webConfig(root), 'utf8')
    expect(injected).toContain('/* lpm-inject:start */')
    const cap = captureOut()
    const r = await autoUninitAfterUnlinkAll(root)
    expect(r.removed).toBe(true)
    expect(readFileSync(webConfig(root), 'utf8')).toBe(CONFIG_TS)
    expect(cap.stdout()).toContain('已自动摘除 utoopack 适配片段')
  })
  it('未注入 → 跳过，reason=not-injected', async () => {
    const root = makeWs()
    const r = await autoUninitAfterUnlinkAll(root)
    expect(r.removed).toBe(false)
    expect(r.reason).toBe('not-injected')
  })
  it('不完整标记（有 start 无 end）→ 绝不自动摘除（I8 铁律）+ stderr 提示', async () => {
    const root = makeWs()
    writeFileSync(webConfig(root), 'export default defineConfig({\n  antd: {},\n  /* lpm-inject:start */\n})\n', 'utf8')
    const before = readFileSync(webConfig(root), 'utf8')
    const cap = captureOut()
    const r = await autoUninitAfterUnlinkAll(root)
    expect(r.removed).toBe(false)
    expect(r.reason).toBe('incomplete-marker')
    expect(readFileSync(webConfig(root), 'utf8')).toBe(before)
    expect(cap.stderr()).toContain('不完整的 lpm 注入标记')
  })
  it('非 umi 项目 → 跳过', async () => {
    const root = makeWs()
    rmSync(join(root, 'apps', 'web', 'config'), { recursive: true, force: true })
    const r = await autoUninitAfterUnlinkAll(root)
    expect(r.removed).toBe(false)
    expect(r.reason).toBe('no-umi-host')
  })
})
