import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), groupMultiselect: vi.fn(), multiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { runLink } from '../../src/commands/link.js'
import { runUnlink } from '../../src/commands/unlink.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeLib(name: string): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lc-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
  // scripts.build:watch 必需：checkLib 在 dry-run 也校验 watch script（--watch 用例 LC-12）
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name, main: './index.js', scripts: { 'build:watch': 'echo watch' } }), 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
}

/** ws + N 个真实 lib：全部已注册（cfg.libs）且被 apps/web 声明 */
function setup(shortNames: string[] = ['a', 'b']): { ws: string; paths: Record<string, string> } {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-lc-'))
  dirs.push(ws)
  const deps: Record<string, string> = {}
  const libs: Record<string, string> = {}
  const paths: Record<string, string> = {}
  for (const s of shortNames) {
    const key = `@t/${s}`
    const lib = makeLib(key)
    deps[key] = '^1.0.0'
    libs[key] = relative(ws, lib).replaceAll('\\', '/')
    paths[key] = lib
  }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: deps }),
  }
  for (const [n, c] of Object.entries(files)) {
    const p = join(ws, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return { ws, paths }
}
function writeCfg(ws: string, cfg: Record<string, unknown>): void {
  writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify(cfg), 'utf8')
}
function writeLastFile(ws: string, names: unknown[]): void {
  mkdirSync(join(ws, '.lpm'), { recursive: true })
  writeFileSync(join(ws, '.lpm', 'last.json'), JSON.stringify({ version: 1, names }), 'utf8')
}
function depsOf(ws: string): Record<string, string> {
  return JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies
}
function cfgOf(ws: string): { libs: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8'))
}
/** 项目 byte 级快照（cfg + manifest）——用于「零写盘」断言 */
function snapshot(ws: string): string {
  return ['lpm.config.json', 'apps/web/package.json'].map((f) => readFileSync(join(ws, f), 'utf8')).join('\u0000')
}
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('link 集合级直通（spec §4.4 / §4.5）', () => {
  it('LC-1：--all 展开全部已注册 → 全部替换为 link: + install 恰一次', async () => {
    const { ws } = setup(['a', 'b'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(0)
    const deps = depsOf(ws)
    expect(deps['@t/a']).toContain('link:')
    expect(deps['@t/b']).toContain('link:')
    expect(execa).toHaveBeenCalledTimes(1)
  })

  it('LC-2：--last 展开 last.json 的 names', async () => {
    const { ws } = setup(['a', 'b'])
    writeLastFile(ws, ['@t/b'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(0)
    const deps = depsOf(ws)
    expect(deps['@t/b']).toContain('link:')
    expect(deps['@t/a']).toBe('^1.0.0')
  })

  it('LC-3：--preset 正常展开', async () => {
    const { ws } = setup(['a', 'b'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { 前端: ['@t/a'] } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { preset: '前端' }, ws)).toBe(0)
    expect(depsOf(ws)['@t/a']).toContain('link:')
    expect(depsOf(ws)['@t/b']).toBe('^1.0.0')
  })

  it('LC-4：--last 无记录 / names 为空 → 报错 exit 1 + 零写盘，且提示不含 lpm save', async () => {
    for (const withFile of [false, true]) {
      const { ws } = setup(['a'])
      if (withFile) writeLastFile(ws, [])
      const before = snapshot(ws)
      const cap = captureOut()
      expect(await runLink([], { last: true }, ws)).toBe(1)
      expect(cap.stderr()).toContain('没有上次链接的记录')
      expect(cap.stderr()).not.toContain('lpm save')
      expect(snapshot(ws)).toBe(before)
      expect(execa).not.toHaveBeenCalled()
    }
  })

  it('LC-5：--all 无已注册 → 报错 exit 1', async () => {
    const { ws } = setup([])
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('当前没有任何已注册的 lib')
  })

  it('LC-6：--preset 不存在 → 报错 + 列出可用预设', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { 前端: ['@t/a'], 后端: ['@t/b'] } })
    const cap = captureOut()
    expect(await runLink([], { preset: 'nope' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('预设不存在：nope')
    expect(cap.stderr()).toContain('前端、后端')
  })

  it('LC-7：--preset 损坏 / 空数组 → 报错 exit 1', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { bad: 42, empty: [] } })
    const cap = captureOut()
    expect(await runLink([], { preset: 'bad' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('内容损坏')
    expect(await runLink([], { preset: 'empty' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('是空的')
  })

  it('LC-8：失效名字（2 失效 + 1 正常）→ 一次性列出 + byte 级零变化 + 零子进程', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { p: ['@t/a', '@t/gone1', '@t/gone2'] } })
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { preset: 'p' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('@t/gone1')
    expect(cap.stderr()).toContain('@t/gone2')
    expect(cap.stderr()).toContain('lpm preset rm p')
    expect(snapshot(ws)).toBe(before)          // 一个都不链、且任何写盘之前中止
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-9：注册值损坏 → 展开期报错 exit 1 + 零写盘', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: { ...cfgOf(ws).libs, '@t/bad': 42 } })
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('注册值损坏')
    expect(snapshot(ws)).toBe(before)
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-10：互斥与参数校验 → 各自 exit 1 + 零写盘零子进程', async () => {
    const { ws } = setup(['a'])
    const cases: Array<{ targets: string[]; opts: Record<string, unknown> }> = [
      { targets: [], opts: { last: true, all: true } },
      { targets: [], opts: { all: true, preset: 'p' } },
      { targets: ['@t/a'], opts: { all: true } },
      { targets: [], opts: { preset: '' } },
    ]
    for (const c of cases) {
      const before = snapshot(ws)
      const cap = captureOut()
      expect(await runLink(c.targets, c.opts, ws)).toBe(1)
      expect(cap.stderr()).toMatch(/互斥|不能与|需要一个预设名/)
      expect(snapshot(ws)).toBe(before)
      expect(execa).not.toHaveBeenCalled()
    }
  })

  it('LC-11：--all --dry-run → 首行逐字 + 零写盘零子进程', async () => {
    const { ws } = setup(['a'])
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { all: true, dryRun: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(snapshot(ws)).toBe(before)
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-12：--all --watch → watch 行出现', async () => {
    const { ws } = setup(['a'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], { all: true, watch: true, dryRun: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('watch：')
  })

  it('LC-13：--last 的 names 含非字符串 → 报错指出该元素、不崩', async () => {
    const { ws } = setup(['a'])
    writeLastFile(ws, ['@t/a', 7])
    const cap = captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('7')
  })
})

function stateKeys(ws: string): string[] | null {
  const p = join(ws, '.lpm', 'state.json')
  if (!existsSync(p)) return null
  return Object.keys(JSON.parse(readFileSync(p, 'utf8')).links)
}
function stateOf(ws: string): { links: Record<string, { original: Record<string, string> }> } {
  return JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8'))
}
function lastNames(ws: string): string[] | null {
  const p = join(ws, '.lpm', 'last.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')).names
}

describe('last.json 刷新口径（spec §4.6）', () => {
  it('LC-14：集合级操作展开后仅 1 个名字 → 也刷新 last（forceLastWrite）', async () => {
    const { ws } = setup(['a', 'b'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { solo: ['@t/a'] } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { preset: 'solo' }, ws)).toBe(0)
    expect(lastNames(ws)).toEqual(['@t/a'])
  })

  it('LC-15：集合级操作全部命中「已链接、跳过」→ 仍把 last 对齐到当前全集', async () => {
    const { ws } = setup(['a', 'b'])
    // 先手动造出：state 已有 @t/a 与 @t/b（全已链接），而 last 只记了 @t/a
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(join(ws, '.lpm', 'state.json'), JSON.stringify({ version: 1, links: {
      '@t/a': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      '@t/b': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
    } }), 'utf8')
    writeLastFile(ws, ['@t/a'])
    captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(0)   // 展开 [@t/a]，已链接 → 计划为空
    expect(execa).not.toHaveBeenCalled()                    // 确实全跳过
    expect([...(lastNames(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b'])
  })

  it('LC-16：非预检类的中途失败（零命中依赖）→ LinkTargetError 整批停，且此前合法项的 upsert 已落盘', async () => {
    const { ws } = setup(['a'])                             // 只有 @t/a 被 apps/web 声明
    const orphan = makeLib('@t/orphan')                     // 注册了但无人依赖
    // 判别力（最终评审 Important-2）：@t/a 的注册值故意写成「归一化等价但字符串不同」的 'libs/./a'，
    // 指向真实目录 ws/libs/a（checkLib 照常通过）；toRel 产出 'libs/a' ≠ 'libs/./a' → isNew=true →
    // 计划期 upsert 写盘发生在 @t/orphan 抛 LinkTargetError 之前。原 fixture 用 setup 生成的归一化相对路径
    // （与 toRel 输出逐字符相同）→ isNew 恒 false → 计划期零 config 写盘，upsert 落盘根本没被钉住。
    mkdirSync(join(ws, 'libs', 'a', 'node_modules'), { recursive: true })
    writeFileSync(join(ws, 'libs', 'a', 'node_modules', '.keep'), '', 'utf8')
    writeFileSync(join(ws, 'libs', 'a', 'package.json'), JSON.stringify({ name: '@t/a', main: './index.js' }), 'utf8')
    writeFileSync(join(ws, 'libs', 'a', 'index.js'), 'export = 1;\n', 'utf8')
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/./a', '@t/orphan': relative(ws, orphan).replaceAll('\\', '/') } })
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('不在任何成员依赖中')
    // 增强：@t/a 的 upsert 已被归一化落盘（'libs/./a' → 'libs/a'）——证明计划期已写且失败后未回滚
    expect(cfgOf(ws).libs['@t/a']).toBe('libs/a')
    expect(cfgOf(ws).libs['@t/orphan']).toBeDefined()      // 与 S6 直通同口径：不回滚
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-17：PRD §13 验收 5 闭环 —— link --all → unlink --all → link --last', async () => {
    const { ws } = setup(['a', 'b', 'c'])
    const beforeLink = { ...depsOf(ws) }                          // 最初声明值
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(0)
    expect([...(stateKeys(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    expect([...(lastNames(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    const orig1 = stateOf(ws).links['@t/a']!.original              // 第一轮落档的 original
    expect(await runUnlink([], { all: true }, ws)).toBe(0)
    expect(stateKeys(ws)).toBeNull()
    expect(depsOf(ws)).toEqual(beforeLink)                         // 验收 3：声明恢复原样
    expect(await runLink([], { last: true }, ws)).toBe(0)
    expect([...(stateKeys(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    expect(stateOf(ws).links['@t/a']!.original).toEqual(orig1)      // 验收 5：original 逐文件精确还原
  })

  it('LC-18：直通回归钉 —— `link <A> <B>` 全已链接仍不写 last；`link <A>` 单个不写', async () => {
    const { ws, paths } = setup(['a', 'b'])
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(join(ws, '.lpm', 'state.json'), JSON.stringify({ version: 1, links: {
      '@t/a': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      '@t/b': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
    } }), 'utf8')
    captureOut()
    expect(await runLink([paths['@t/a']!, paths['@t/b']!], {}, ws)).toBe(0)
    expect(lastNames(ws)).toBeNull()

    const solo = setup(['a'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    expect(await runLink([solo.paths['@t/a']!], {}, solo.ws)).toBe(0)
    expect(lastNames(solo.ws)).toBeNull()
  })
})
