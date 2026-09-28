import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), select: vi.fn(), isCancel: vi.fn(() => false) }))
import { runStatus } from '../../src/commands/status.js'

const dirs: string[] = []
function makeWs(files: Record<string, string> = {}, state?: object, registered = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-st-'))
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
function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { chunks.push(String(c)); return true })
  return fn().then((code) => { spy.mockRestore(); return { code, out: chunks.join('') } })
}
afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('status 判定族', () => {
  it('ST-1：正常（注册 + 未链接 + registry + 实体）→ ok，默认输出折叠为汇总', async () => {
    const ws = makeWs()
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('1 正常')
    expect(out).not.toContain('⚠️')
  })
  it('ST-2：漂移（档案记着 + 声明被改回 registry）→ issues 含 drifted，退出码 0', async () => {
    const ws = makeWs({}, ST)
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('漂移')
    expect(out).toContain('lpm repair')
  })
  it('ST-3：装了没生效（档案 + link: + 目录为实体）→ issues 含 install-ineffective', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }) }, ST)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('装了没生效')
  })
  it('ST-4：孤儿（未注册未记档 + 声明为 link:）→ 被集合3纳入且 issues 含 orphan', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }) }, undefined, false)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('孤儿')
  })
  it('ST-5：残留链接（注册 + registry + 目录为链接）→ issues 含 stale-link', async () => {
    const ws = makeWs()
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('残留链接')
  })
  it('ST-6：失效记录（档案键指向不存在文件）→ issues 含 stale-record', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: 'x' } } })
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('失效记录')
  })
  it('ST-7：记录损坏（original 为空对象）→ issues 含 corrupt，且不抛错中断', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: {}, linkedAt: 'x' } } })
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('记录损坏')
  })
  it('ST-8：--json 输出全量（含正常项）+ 汇总口径 ok+issue=total', async () => {
    const ws = makeWs({}, ST)
    // 计划原文此例直接 makeWs({}, ST)，但默认 fixture 的 node_modules/@t/lib 是实体目录，
    // probeNodeModules 必然返回 entity，断言 'link-to-lib' 不可能成立（计划期 fixture 与断言互斥）。
    // 按断言原值修正 fixture：改成指向 lpm-lib 的 junction（同 ST-5 手法），使 nm 真为 link-to-lib。
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const { out } = await capture(() => runStatus({ json: true }, ws))
    const j = JSON.parse(out)
    expect(j.version).toBe(1)
    expect(j.summary.ok + j.summary.issue).toBe(j.summary.total)
    expect(j.entries[0].issues).toContain('drifted')
    expect(j.entries[0].files[0].nm.status).toBe('link-to-lib')
    expect(j.entries[0].files[0].nm.realTarget).toBeTruthy()
    expect(j.entries[0].files[0].nm.realTarget).not.toContain('\\')
    expect(out).not.toMatch(/\u001b\[/)
  })
  it('ST-9：workspace 不存在 → exit 1（无法核对）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-st-'))
    dirs.push(dir)
    const { code } = await capture(() => runStatus({}, dir))
    expect(code).toBe(1)
  })
  it('ST-10：多段命中值不一致 → 代表值取规范段序首段，并输出异值警告', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' }, devDependencies: { '@t/lib': '^1.0.0' } }),
    }, ST)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('多段命中值异')
  })
  it('ST-11：档案条目值为 null → 归 corrupt 族如实报告，不崩溃（exit 0）', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': null } })
    const plain = await capture(() => runStatus({}, ws))
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('记录损坏')
    const { code, out } = await capture(() => runStatus({ json: true }, ws))
    expect(code).toBe(0)
    const j = JSON.parse(out)
    expect(j.entries[0].issues).toContain('corrupt')
  })
  it('ST-12：成员清单为坏 JSON → exit 1（透传清单解析失败文案，不崩溃）', async () => {
    const ws = makeWs({ 'apps/web/package.json': '{ 坏 JSON' })
    const errs: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { errs.push(String(c)); return true })
    let code: number
    try { code = await runStatus({}, ws) } finally { spy.mockRestore() }
    expect(code!).toBe(1)
    expect(errs.join('')).toContain('清单解析失败')
  })
  it('ST-13：已记录 + 裸相对路径声明（../lpm-lib）→ install-ineffective，不误判 drifted（最终评审 ②）', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '../lpm-lib' } }) }, ST)
    const { code, out } = await capture(() => runStatus({ json: true }, ws))
    expect(code).toBe(0)
    const j = JSON.parse(out)
    const e = (j.entries as Array<{ key: string; issues: string[] }>).find((x) => x.key === '@t/lib')
    expect(e?.issues).toContain('install-ineffective')
    expect(e?.issues).not.toContain('drifted')
  })
  it('ST-14：declared == 档案原值的漂移 → 中性建议（含两条路）+ note（最终评审 ③）', async () => {
    const ws = makeWs({}, ST) // 声明 ^1.0.0 == 档案原值 ^1.0.0 → 疑似 unlink 未完成，不可只报「漂移 → lpm repair」
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('漂移')
    expect(out).toContain('lpm unlink')
    expect(out).toContain('lpm repair')
    expect(out).toContain('可能为 unlink 未完成的残留')
  })
  it('ST-15：declared ≠ 档案原值的漂移 → 建议不含「重跑 lpm unlink」（最终评审 ③）', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, ST)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('漂移')
    expect(out).toContain('lpm repair')
    expect(out).not.toContain('lpm unlink')
  })
  it('ST-16：成员声明名为 constructor（值为 link:）→ 不被当作已注册库（registered=false）且不崩溃（§7 原型链守卫）', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', constructor: 'link:../../lpm-lib' } }),
    })
    const { code, out } = await capture(() => runStatus({ json: true }, ws))
    expect(code).toBe(0)
    const j = JSON.parse(out)
    const e = (j.entries as Array<{ key: string; registered: boolean }>).find((x) => x.key === 'constructor')
    expect(e).toBeDefined()
    expect(e?.registered).toBe(false)
  })
})
