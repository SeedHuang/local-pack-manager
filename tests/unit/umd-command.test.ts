import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// remote 模块整体 mock（vi.hoisted 供工厂引用同一实例）
const { RemoteQueryError, queryLatestVersion } = vi.hoisted(() => {
  class RemoteQueryError extends Error {
    constructor(public pkgName: string, message: string) { super(message); this.name = 'RemoteQueryError' }
  }
  return { RemoteQueryError, queryLatestVersion: vi.fn() }
})
vi.mock('../../src/core/remote.js', () => ({ RemoteQueryError, queryLatestVersion }))
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), isCancel: vi.fn(() => false) }))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { confirm } from '@clack/prompts'
import { runUmd } from '../../src/commands/umd.js'

const dirs: string[] = []
/** workspace：apps/web + packages/server 双成员；config libs 由参数传入 */
function makeWs(libs: Record<string, string> = {}, opts: { linked?: string[]; webDeclared?: string; serverDeclared?: string } = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-umd-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n  - 'packages/server'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': opts.webDeclared ?? '1.0.0' } }),
    'packages/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': opts.serverDeclared ?? '^1.0.0' } }),
  }
  if ((opts.linked ?? []).length > 0) {
    const links: Record<string, unknown> = {}
    for (const k of opts.linked ?? []) links[k] = { original: {}, linkedAt: new Date().toISOString() }
    base['.lpm/state.json'] = JSON.stringify({ version: 1, links })
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
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
    clear: () => { out.mockClear(); err.mockClear() },
  }
}
beforeEach(() => {
  vi.mocked(execa).mockReset()
  vi.mocked(queryLatestVersion).mockReset()
  vi.mocked(confirm).mockReset()
  vi.mocked(confirm).mockResolvedValue(true as never)
})
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('runUmd 编排（spec §6 umd-command 面）', () => {
  it('无 lib（config 缺失）→ 提示先注册 + exit 0 + 零查询零写盘', async () => {
    stubTty(true)
    const ws = makeWs()
    rmSync(join(ws, 'lpm.config.json'))
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(0)
    expect(cap.stdout()).toContain('先 lpm link')
    expect(queryLatestVersion).not.toHaveBeenCalled()
  })
  it('正在联调的库 → 整库跳过；只处理远程', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { linked: ['@t/lib'], webDeclared: 'link:../lib' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(0)
    expect(cap.stdout()).toContain('没有需要更新的依赖')
    expect(queryLatestVersion).not.toHaveBeenCalled() // 联调库不查询
  })
  it('落后候选 + session memory：同库两成员只 confirm 一次，改写两处', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '' } as never) // install 成功
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(0)
    expect(confirm).toHaveBeenCalledTimes(1) // 每库一次
    expect(cap.stdout()).toContain('更新完成')
    expect(cap.stdout()).toContain('1.0.0 → 1.2.0')
    // 改写落盘两处
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('1.2.0')
    expect(JSON.parse(readFileSync(join(ws, 'packages/server/package.json'), 'utf8')).dependencies['@t/lib']).toBe('1.2.0')
  })
  it('--yes：零 confirm 调用，直接执行', async () => {
    stubTty(false)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '^0.5.0', serverDeclared: '^0.5.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('0.6.0')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '' } as never)
    const cap = captureOut()
    expect(await runUmd({ yes: true }, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.stdout()).toContain('^0.5.0 → ^0.6.0')
  })
  it('--dry-run：打印计划 + 零写盘 + 零 install + exit 0', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    const cap = captureOut()
    expect(await runUmd({ dryRun: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('dry-run 执行计划')
    expect(cap.stdout()).toContain('1.0.0 → 1.2.0')
    expect(execa).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('1.0.0')
  })
  it('非 TTY 且无 --yes → UmdInteractionError + exit 1', async () => {
    stubTty(false)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(1)
    expect(cap.stderr()).toContain('改用 lpm umd --yes')
  })
  it('确认被否（confirm=false）→ 未更新任何依赖 + exit 0', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    vi.mocked(confirm).mockResolvedValue(false as never)
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(0)
    expect(cap.stdout()).toContain('未更新任何依赖')
    expect(execa).not.toHaveBeenCalled()
  })
  it('同文件同包多段判定不一致（behind+current）→ 整文件跳过 + 零改写', async () => {
    stubTty(true)
    // server 用 ^1.0.0（current，非候选）；web 手动改成混合段
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '^1.0.0' })
    // 让 web 同时出现在 dependencies(1.0.0) 与 devDependencies(^1.0.0)
    const webPkg = join(ws, 'apps/web/package.json')
    writeFileSync(webPkg, JSON.stringify({
      name: 'web',
      dependencies: { '@t/lib': '1.0.0' },
      devDependencies: { '@t/lib': '^1.0.0' },
    }), 'utf8')
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已整体跳过')
    expect(cap.stdout()).toContain('没有需要更新的依赖')
  })
  it('单库查询失败 → 警告跳过该库，其它库继续', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib', '@t/lib2': '../libs/lib2' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    // web 与 server 都额外声明 @t/lib2（1.0.0）——让它成为可升级候选
    writeFileSync(join(ws, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '1.0.0', '@t/lib2': '1.0.0' } }), 'utf8')
    writeFileSync(join(ws, 'packages/server/package.json'), JSON.stringify({ name: 'server', dependencies: { '@t/lib': '1.0.0', '@t/lib2': '1.0.0' } }), 'utf8')
    vi.mocked(queryLatestVersion)
      .mockRejectedValueOnce(new RemoteQueryError('@t/lib', 'npm view 失败'))
      .mockResolvedValueOnce('3.0.0')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '' } as never)
    const cap = captureOut()
    expect(await runUmd({ yes: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('查询 @t/lib 远程版本失败，已跳过该库')
    expect(cap.stdout()).toContain('1.0.0 → 3.0.0')
  })
  it('install 失败 → InstallError 建议「重跑 install 命令」且不含 link 向默认文案', async () => {
    stubTty(true)
    const ws = makeWs({ '@t/lib': '../libs/lib' }, { webDeclared: '1.0.0', serverDeclared: '1.0.0' })
    vi.mocked(queryLatestVersion).mockResolvedValue('1.2.0')
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'ETARGET' })
    const cap = captureOut()
    expect(await runUmd({}, ws)).toBe(1)
    expect(cap.stderr()).toContain('install 失败')
    expect(cap.stderr()).toContain('pnpm install --no-frozen-lockfile')
    expect(cap.stderr()).not.toContain('重跑 lpm link')
  })
})
