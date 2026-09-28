import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  select: vi.fn(), multiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { multiselect, select, confirm, text, isCancel } from '@clack/prompts'
import { collectLinkedItems, runUnlink } from '../../src/commands/unlink.js'
import { loadWorkspace } from '../../src/core/workspace.js'
import type { LinkState, ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-ui-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n  - 'apps/server'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': '../../lpm-lib' } }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
    'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
    ...files,
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
}
const cfgOf = (libs: Record<string, string> = { '@t/lib': '../../lpm-lib' }): ProjectLpmConfig => ({ version: 1, libs })

function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-home-'))
  dirs.push(home)
  osMock.home = home
  mkdirSync(join(home, '.lpm'), { recursive: true })
  return home
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}

beforeEach(() => {
  osMock.home = ''
  vi.clearAllMocks()
  vi.mocked(isCancel).mockReturnValue(false)
})

describe('collectLinkedItems', () => {
  it('UI-1：列表 = state.links 键；restoreTo = original 值去重', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.key)).toEqual(['@t/lib'])
    expect(items[0].restoreTo).toEqual(['^1.0.0'])
    expect(items[0].linkedMembers).toEqual(['apps/web', 'apps/server'])
  })
  it('UI-2：多文件异值 → restoreTo 并列保留', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^2.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items[0].restoreTo).toEqual(['^1.0.0', '^2.0.0'])
  })
  it('UI-3：[漂移] 标记 = state 有条目但声明已回到正式版本号', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }) })
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items[0].drifted).toBe(true)
  })
  it('UI-4：损坏条目 → corrupt=true 且不崩（读取守卫）', async () => {
    const ws = makeWs()
    const st = { version: 1, links: { '@t/lib': null, '@t/two': { original: {} } } } as unknown as LinkState
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.corrupt)).toEqual([true, true])
    expect(items[0].restoreTo).toEqual([])
  })
  it('UI-5：state 无条目 → 空数组', async () => {
    const ws = makeWs()
    expect(await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), null)).toEqual([])
  })
  it('UI-6：列表顺序 = state.links 键顺序', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: {
      '@t/two': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
      '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
    } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.key)).toEqual(['@t/two', '@t/lib'])
  })
})

describe('unlink 交互入口', () => {
  function wsLinked(): string {
    return makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
  }

  it('UI-7：非 TTY 无参数 → 提示 + exit 1，零菜单调用', async () => {
    const ws = wsLinked(); stubTty(false)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm unlink')
    expect(multiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('UI-8：无已链接项 → 三去向提示 + exit 0', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: {} }) })
    stubTty(true); makeHome()
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('当前没有已链接的库')
    expect(cap.out.join('')).toContain('lpm forget')
    expect(cap.out.join('')).toContain('待 S11 上线')
  })

  it('UI-9：列表多选 → 预览 → 确认「是」→ 执行（恢复 + install + 删 state）', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })

  it('UI-10：确认答否 → 已取消 + exit 1 + 零写盘', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('UI-11：Ctrl+C → 已取消 + exit 1', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('UI-12：空选中提交 → 未选择任何库 + exit 1', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('UI-13：corrupt 项前置剔除，不连累同批其它项', async () => {
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
        '@t/bad': null,
      } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib', '@t/bad'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('记录损坏，已跳过')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('UI-14：按路径取消 → 已在链接列表并入；未在则提示且流程继续', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__path__'])
    vi.mocked(text).mockResolvedValueOnce('@t/lib ../../not-linked')   // 前者已注册且在链接列表；后者不在
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('当前未处于链接状态')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('UI-15：计划为空 → 无待执行变更 + confirm 零调用 + exit 0', async () => {
    // 偏差（相对 brief 字面 fixture）：brief 用 state original = apps/web/package.json（^1.0.0），
    // 但 makeWs 默认把 apps/web 声明为 link:../../lpm-lib → 该 fixture 实际产出「恢复」计划（非空）。
    // 计划为空的判据（aggregated 空 **且** pendingDelete 空）只有在「original 指向的文件不存在」时成立
    // （全文件缺失 → 条目保留、不进待删集，spec §8 自决 5）。故此处把 state 指向缺失文件以真正走到空分支。
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('UI-16：无目标 + --dry-run → dry-run 计划整段逐字 + 零写盘零子进程 + exit 0', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runUnlink([], { dryRun: true }, ws)).toBe(0)
    // 「dry-run 逐字兼容」是硬约束，而 unlink 的 dry-run 整块此前只有 toContain 级断言（T5 实现者上报的缺口）
    // → 这里固化为**整段黄金断言**（内容取自改造前的 dry-run 打印块，逐行核对过）
    expect(cap.out.join('')).toBe(
      'dry-run 执行计划（不落任何盘、不执行任何子进程）：\n'
      + '  恢复 apps/web/package.json:\n'
      + '    dependencies.@t/lib：link:../../lpm-lib → ^1.0.0\n'
      + '  恢复 apps/server/package.json:\n'
      + '    dependencies.@t/lib：link:../../lpm-lib → ^1.0.0\n'
      + '  state：清空——last 记 ["@t/lib"] → 删 state 文件\n'
      + '  install：pnpm install --no-frozen-lockfile（workspace 根）\n'
      + '  复验：node_modules 实际指向（残留/缺失将 pnpm install --force 重建）\n',
    )
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('UI-17：列表 label 含恢复去向与 [漂移] 标记', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    await runUnlink([], {}, ws)
    const labels = JSON.stringify(vi.mocked(multiselect).mock.calls[0]?.[0])
    expect(labels).toContain('apps/web')
    expect(labels).toContain('^1.0.0')
    expect(labels).toContain('[漂移]')
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('UI-18：写序——恢复文件先于 install；state 删除在 install 成功之后（崩溃安全顺序）', async () => {
    // 补齐 brief 缺失的第 12 例（plan 声明 UI-7…UI-18 共 12 例，但 Step 1 代码块止于 UI-17）；
    // 契约取自 spec §6「预览 → 确认 → 执行（写序：文件恢复在前、state 删除在后、install 成功才删 state）」
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    let pkgAtInstall = ''
    let stateExistsAtInstall = false
    vi.mocked(execa).mockImplementation((async () => {
      // install 被调用的那一刻：声明应已恢复、state 应仍在（尚未删）
      pkgAtInstall = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
      stateExistsAtInstall = existsSync(join(ws, '.lpm', 'state.json'))
      return { exitCode: 0 } as never
    }) as never)
    captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(pkgAtInstall).toContain('^1.0.0')                        // 恢复先于 install
    expect(stateExistsAtInstall).toBe(true)                         // state 删除在 install 成功之后
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)  // 最终已删
  })

  it('UI-19：全部冲突放弃 → 空计划只打印一行「无待执行变更」+ 不确认 + exit 0（T6 评审 Minor-2 的回归钉）', async () => {
    // state 记着 original ^1.0.0，而声明已被手改成 ^2.0.0 → 触发冲突二选一；select 取消 → 该 key 放弃
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(isCancel).mockReturnValueOnce(false).mockReturnValueOnce(true)   // 第一次（multiselect 结果）不取消；第二次（冲突 select）取消
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.out.join('').match(/无待执行变更/g)?.length).toBe(1)            // 修复前为 2（视图 + 入口各一次）
  })

  it('UI-20：无参数 + --dry-run + 空计划 → 走 dry-run 首行（最终评审 Important-1 的回归钉）', async () => {
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runUnlink([], { dryRun: true }, ws)).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.out.join('')).not.toContain('执行计划预览：')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('UI-21：按路径取消时以真实 cwd 解析相对路径（子目录命中）', async () => {
    const ws = makeWs({
      // 库目录位于子目录：只有按 cwd=apps/web 解析 './lib-x' 才能命中（用 rootDir 解析会落到 ws/lib-x，不存在）
      'apps/web/lib-x/package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }),
      'apps/web/lib-x/index.js': 'export = 1;\n',
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__path__'])
    vi.mocked(text).mockResolvedValueOnce('./lib-x')
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const cap = captureOut()
    expect(await runUnlink([], {}, join(ws, 'apps/web'))).toBe(1)   // cwd = 子目录
    expect(cap.out.join('')).toContain('已取消')
    // Fix 2 回归钉：若仍以 rootDir 解析，'./lib-x' 解析失败 → 打印「当前未处于链接状态」
    expect(cap.out.join('')).not.toContain('当前未处于链接状态')
  })

  it('UI-22：按路径取消 → monorepo 让选取消必须中止（catch 不得吞 LinkCancelledError）', async () => {
    const ws = makeWs({
      // lib 路径 = 无 package.json 的 pnpm monorepo 根（有 pnpm-workspace.yaml + 成员包）→ 走 pickMember
      'mono/pnpm-workspace.yaml': "packages:\n  - 'libs/a'\n",
      'mono/libs/a/package.json': JSON.stringify({ name: '@t/lib' }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__path__'])
    vi.mocked(text).mockResolvedValueOnce('./mono')
    vi.mocked(select).mockResolvedValueOnce('@t/lib' as never)   // 值不重要——isCancel 队列判定为取消
    // isCancel 队列：#1 multiselect 结果 false；#2 text 结果 false；#3 pickMember 的 select 结果 true（取消）
    vi.mocked(isCancel).mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('') + cap.err.join('')).toContain('已取消')
    // Fix 5 回归钉：被吞掉时会打印「当前未处于链接状态」并继续（而非中止）
    expect(cap.out.join('')).not.toContain('当前未处于链接状态')
  })

  it('UI-23：确认语的「N 个文件」只数真正会改写的文件（幂等条目不计）', async () => {
    const ws = makeWs({
      // @t/lib：声明为 link: → 会被恢复（changedCount>0）
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
      // @t/two：声明值 === original → 幂等跳过（changedCount===0，但 aggregated 仍含该文件条目）
      'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/two': '^2.0.0' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
        '@t/two': { original: { 'apps/server/package.json': '^2.0.0' }, linkedAt: 'x' },
      } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib', '@t/two'])
    vi.mocked(confirm).mockResolvedValueOnce(false)
    captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    const msg = (vi.mocked(confirm).mock.calls[0]?.[0] as { message: string }).message
    // Fix 6 回归钉：旧代码用 plan.aggregated.size（=2，含幂等条目）→ 会写「恢复 2 个文件」
    expect(msg).toContain('恢复 1 个文件')
  })
})
