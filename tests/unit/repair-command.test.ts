import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(async () => true), select: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false) }))
// 包一层 mapProtocol（默认走真实实现）——供 REP-19 单点注入 ProtocolPathError（跨盘符场景）
vi.mock('../../src/core/rewriter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/rewriter.js')>()
  return { ...actual, mapProtocol: vi.fn(actual.mapProtocol) }
})
import { execa } from 'execa'
import { confirm, isCancel, select, text } from '@clack/prompts'
import { mapProtocol, ProtocolPathError } from '../../src/core/rewriter.js'
import { runRepair } from '../../src/commands/repair.js'

const dirs: string[] = []
function makeWs(files: Record<string, string> = {}, state?: object, registered = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-rp-'))
  dirs.push(dir)
  const full: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: registered ? { '@t/lib': 'lpm-lib' } : {} }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    'apps/web/node_modules/@t/lib/index.js': '',
    ...files,
  }
  for (const [n, c] of Object.entries(full)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  if (state !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify(state), 'utf8')
  }
  return dir
}

const ST = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }

function stubTty(value: boolean | undefined): void { Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true }) }
function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { chunks.push(String(c)); return true })
  return fn().then(
    (code) => { spy.mockRestore(); return { code, out: chunks.join('') } },
    (e) => { spy.mockRestore(); throw e },
  )
}
function argsOf(call: unknown[]): string[] { const a = call[1]; return Array.isArray(a) ? (a as string[]) : [] }
/** 真实漂移形态：manifest 被还原，node_modules 仍是指向 lib 的 junction */
function makeDriftJunction(ws: string): void {
  rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
  mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
  symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
}
afterEach(() => {
  vi.mocked(execa).mockReset()
  vi.mocked(confirm).mockReset()
  vi.mocked(confirm).mockResolvedValue(true as never) // 复位实现（mockClear 不还原 mockResolvedValue）
  vi.mocked(select).mockReset()
  vi.mocked(isCancel).mockReturnValue(false)
  stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('repair 无异常与 dry-run', () => {
  it('REP-1：无异常 → 「无异常，无需修复」exit 0，不进入交互、零子进程', async () => {
    const ws = makeWs()
    const { code, out } = await capture(() => runRepair({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('无异常，无需修复')
    expect(execa).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('REP-2：--dry-run → 打印计划明细、零写盘零子进程', async () => {
    const ws = makeWs({}, ST)
    const { code, out } = await capture(() => runRepair({ dryRun: true }, ws))
    expect(code).toBe(0)
    expect(out).toContain('link:../../lpm-lib')
    expect(execa).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'last-run.json'))).toBe(false)
  })
})

describe('漂移族三支（裁决 14/15）', () => {
  it('REP-3：声明值 == original → 直接恢复链接 + install 恰一次 + 档案不动', async () => {
    const ws = makeWs({}, ST)
    makeDriftJunction(ws)
    stubTty(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('link:../../lpm-lib')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^1.0.0')
  })
  it('REP-4：声明值 ≠ original（手改过）→ 二选一「保留当前值」→ 新 original 落盘', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, ST)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('keep-current' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('link:../../lpm-lib')
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^2.0.0')
  })
  it('REP-5：注册缺失的漂移 → 不入计划、降级提示、零子进程', async () => {
    const ws = makeWs({}, ST, false)
    const { code, out } = await capture(() => runRepair({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('注册缺失')
    expect(out).not.toContain('无异常，无需修复')
    expect(execa).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
})

describe('孤儿族（裁决 6/16）', () => {
  it('REP-6：兄弟声明有正式版本号 → 自动采用（不再让用户重填）→ 恢复 + install', async () => {
    const ws = makeWs({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^1.0.0' } }),
    }, undefined, false)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('restore-registry' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('REP-7：纳入管理但 lib 目录不存在 → 方向菜单不出现②（adopt）', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../no-such-lib' } }),
    }, undefined, false)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('restore-registry' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    const direction = vi.mocked(select).mock.calls
      .map((c) => c[0] as { options?: Array<{ value: string }> })
      .find((a) => (a.options ?? []).some((o) => o.value === 'restore-registry'))
    expect(direction).toBeDefined()
    expect((direction?.options ?? []).some((o) => o.value === 'adopt')).toBe(false)
  })
  it('REP-13：孤儿「纳入管理」→ 注册 upsert + 补档案条目 + 链接未生效则 install', async () => {
    const ws = makeWs({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^1.0.0' } }),
    }, undefined, false)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('adopt' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBe('lpm-lib')
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^1.0.0')
    expect(execa).toHaveBeenCalled() // 目录探测非 link-to-lib → 并入 install
  })
})

describe('写序、计数与交互闸门', () => {
  it('REP-8：install 失败 → 档案零改动（崩溃安全）', async () => {
    const ws = makeWs({}, ST)
    stubTty(true)
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('boom'), { exitCode: 1, stderr: 'ERR' }))
    const r = await runRepair({}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^1.0.0')
    // 失败留痕：已发生的声明改写入 changes，且档案动作零次（档案未动）
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    expect(trace.result).toBe('failed')
    expect(trace.changes.some((c: { action: string }) => c.action === 'rewrite-manifest')).toBe(true)
    expect(trace.changes.some((c: { action: string }) => c.action === 'delete-entry' || c.action === 'write-state' || c.action === 'upsert-registration')).toBe(false)
    expect(trace.installs).toHaveLength(1)
    expect(trace.installs[0]).toMatchObject({ ok: false, exitCode: 1 })
  })
  it('REP-9：非 TTY 且有待修项 → RepairInteractionError exit 1', async () => {
    const ws = makeWs({}, ST)
    stubTty(false)
    const errs: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { errs.push(String(c)); return true })
    let r: number
    try { r = await runRepair({}, ws) } finally { spy.mockRestore() }
    expect(r!).toBe(1)
    expect(errs.join('')).toContain('需交互确认修复计划')
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('REP-21：非 TTY + 孤儿（需方向选择）→ exit 1、不画菜单、stderr 含契约文案（最终评审 ①）', async () => {
    const ws = makeWs({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^1.0.0' } }),
    }, undefined, false)
    stubTty(false)
    const errs: string[] = []
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { errs.push(String(c)); return true })
    let r = 0
    let out = ''
    try { const res = await capture(() => runRepair({}, ws)); r = res.code; out = res.out } finally { errSpy.mockRestore() }
    expect(r).toBe(1)
    expect(errs.join('')).toContain('需交互确认修复计划')
    // 不画菜单：非交互模式下不得残留任何方向/来源选择的特征文案（旧实现会画半张 TUI 后 exit 13）
    expect(out).not.toContain('选择处理方式')
    expect(out).not.toContain('纳入 lpm 管理')
    expect(out).not.toContain('恢复正式版本')
    expect(select).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('link:../../lpm-lib')
  })
  it('REP-22：非 TTY + 手改漂移（声明 ≠ 档案原值）→ exit 1、不画菜单、stderr 含契约文案（最终评审 ①）', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, ST)
    stubTty(false)
    const errs: string[] = []
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { errs.push(String(c)); return true })
    let r = 0
    let out = ''
    try { const res = await capture(() => runRepair({}, ws)); r = res.code; out = res.out } finally { errSpy.mockRestore() }
    expect(r).toBe(1)
    expect(errs.join('')).toContain('需交互确认修复计划')
    expect(out).not.toContain('选择处理方式')
    expect(out).not.toContain('保留当前值')
    expect(select).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^2.0.0')
  })
  it('REP-10：确认取消（isCancel）→ 项目零写盘 exit 1，但已写入失败留痕', async () => {
    const ws = makeWs({}, ST)
    stubTty(true)
    vi.mocked(confirm).mockResolvedValue(false as never)
    vi.mocked(isCancel).mockReturnValue(true as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'last-run.json'))).toBe(true)
  })
  it('REP-11：确认默认值为 false（防误按回车执行不可逆动作）', async () => {
    const ws = makeWs({}, ST)
    stubTty(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runRepair({}, ws)
    expect(vi.mocked(confirm)).toHaveBeenCalledTimes(1)
    const cfgArg = vi.mocked(confirm).mock.calls[0][0] as { initialValue?: boolean }
    expect(cfgArg.initialValue).toBe(false)
  })
  it('REP-12：多族并发 → install 恰一次、复验后至多一次 --force', async () => {
    const ws = makeWs({
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib', '@t/two': 'lpm-two' } }),
      'lpm-two/package.json': JSON.stringify({ name: '@t/two' }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib', '@t/two': '^1.0.0' } }),
    }, {
      version: 1,
      links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
        '@t/two': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
      },
    })
    stubTty(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    const calls = vi.mocked(execa).mock.calls
    const installs = calls.filter((c) => argsOf(c)[0] === 'install' && !argsOf(c).includes('--force'))
    const forces = calls.filter((c) => argsOf(c).includes('--force'))
    expect(installs).toHaveLength(1) // 多族并发 → install 恰一次
    expect(forces.length).toBeLessThanOrEqual(1) // 至多一次 --force
    expect(forces.length).toBe(1) // 本 fixture 复验必失败 → 恰一次
  })
})

describe('多成员同时采纳同一孤儿库（Important ①：档案按键合并）', () => {
  it('REP-14：两个成员目录都选「纳入管理」→ 档案 original 同时保留两个文件键与原值', async () => {
    const ws = makeWs({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^1.0.0' } }),
    }, undefined, false)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('adopt' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBe('lpm-lib')
    const orig = JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8')).links['@t/lib'].original
    // 修复前：整体赋值 → 只有一个文件的原值进档案；修复后：两个文件键与原值都在
    expect(orig['apps/web/package.json']).toBe('^1.0.0')
    expect(orig['apps/server/package.json']).toBe('^1.0.0')
  })
})

describe('失效记录 / 损坏条目（spec §7 六族全矩阵）', () => {
  it('REP-15：stale-record 整条删除 → 计划与留痕 detail 均含被删原值、state 清空', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web' }) }, ST)
    stubTty(true)
    const { code, out } = await capture(() => runRepair({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('^1.0.0') // 裁决 17 保险②：计划原样展示被删记录原值
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false) // 唯一条目整条删除 → state 清空
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    const del = trace.changes.find((c: { action: string }) => c.action === 'delete-entry')
    expect(del).toBeDefined()
    expect(del.detail).toContain('^1.0.0') // 裁决 17 保险③：留痕 detail 含被删原值
    expect(execa).not.toHaveBeenCalled()
  })
  it('REP-16：stale-record 文件级出局 → 只删该文件那条记录、其余保留', async () => {
    const st2 = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/gone/package.json': '^3.0.0' }, linkedAt: 'x' } } }
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }) }, st2)
    makeDriftJunction(ws)
    stubTty(true)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    const orig = JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8')).links['@t/lib'].original
    expect(orig['apps/web/package.json']).toBe('^1.0.0') // 有效记录保留
    expect(Object.hasOwn(orig, 'apps/gone/package.json')).toBe(false) // 失效记录出局
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    const del = trace.changes.find((c: { action: string }) => c.action === 'delete-entry')
    expect(del.detail).toContain('apps/gone/package.json')
    expect(del.detail).toContain('^3.0.0')
    expect(execa).not.toHaveBeenCalled()
  })
  it('REP-17：corrupt → 删条目 + 提示重跑 + 留痕 detail 含被删原值（Minor ③ 不显示空 {}）', async () => {
    const bad = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '' }, linkedAt: 'x' } } }
    const ws = makeWs({}, bad)
    stubTty(true)
    const { code, out } = await capture(() => runRepair({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('重跑 lpm repair')
    expect(out).toContain('apps/web/package.json') // Minor ③：改为序列化 st.links[key] 原始值
    expect(out).not.toContain('原记录将丢失：{}')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    const del = trace.changes.find((c: { action: string }) => c.action === 'delete-entry')
    expect(del.detail).toContain('apps/web/package.json')
  })
})

describe('孤儿多兄弟值不一致 / 漂移提示分文案 / 跨盘符', () => {
  it('REP-18：多个兄弟声明值不一致 → 不采用、降级到下一级来源', async () => {
    const ws = makeWs({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      'apps/a/package.json': JSON.stringify({ name: 'a', dependencies: { '@t/lib': '^1.0.0' } }),
      'apps/b/package.json': JSON.stringify({ name: 'b', dependencies: { '@t/lib': '^2.0.0' } }),
    }, undefined, false)
    stubTty(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    vi.mocked(select).mockResolvedValueOnce('manual' as never).mockResolvedValueOnce('restore-registry' as never)
    vi.mocked(text).mockResolvedValue('^1.0.0' as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    // 降级证据：弹出了「选择原始 range 来源」菜单（采用了兄弟值则不会走到第二级来源）
    const sourceMenu = vi.mocked(select).mock.calls
      .map((c) => c[0] as { message?: string })
      .find((a) => /选择原始 range 来源/.test(a.message ?? ''))
    expect(sourceMenu).toBeDefined()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('REP-20：注册在但库目录已不存在（libReal=null）→ 提示「目录不存在或不可解析」且指向 lpm link', async () => {
    const ws = makeWs({}, ST)
    rmSync(join(ws, 'lpm-lib'), { recursive: true, force: true })
    const { code, out } = await capture(() => runRepair({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('目录不存在或不可解析')
    expect(out).toContain('lpm link')
    expect(out).not.toContain('无异常，无需修复')
    expect(execa).not.toHaveBeenCalled()
  })
  it('REP-19：漂移修复时 mapProtocol 跨盘符 → ProtocolPathError exit 1 且透传既有文案', async () => {
    const ws = makeWs({}, ST)
    stubTty(true)
    vi.mocked(mapProtocol).mockImplementationOnce(() => {
      throw new ProtocolPathError('C:/lib', 'D:/web', '无法生成相对路径（跨盘符？）：libDir=C:/lib manifestDir=D:/web')
    })
    const errs: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { errs.push(String(c)); return true })
    let r: number
    try { r = await runRepair({}, ws) } finally { spy.mockRestore() }
    expect(r!).toBe(1)
    expect(errs.join('')).toContain('无法生成相对路径（跨盘符？）')
    expect(execa).not.toHaveBeenCalled()
  })
})
