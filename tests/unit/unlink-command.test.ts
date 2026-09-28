import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { isCancel, select } from '@clack/prompts'
import { runUnlink } from '../../src/commands/unlink.js'

const dirs: string[] = []
function makeWs(files: Record<string, string> = {}, state?: object, last?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-unlk-'))
  dirs.push(dir)
  const full: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    // 注册路径 = 'lpm-lib'（与 apps/web 依赖值 'link:../lpm-lib' 及 UNL-20 junction 目标一致）
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }),
    // registry 实体形态（复验 ok——realpath 为自身 ≠ libDirAbs）：默认无 force 干扰，force 场景用例特化覆盖
    'apps/web/node_modules/@t/lib/.keep': '',
    ...files,
  }
  for (const [name, content] of Object.entries(full)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  if (state !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify(state), 'utf8')
  }
  if (last !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'last.json'), JSON.stringify(last), 'utf8')
  }
  return dir
}
const STATE_ONE = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
afterEach(() => {
  vi.mocked(execa).mockReset()
  stubTty(undefined) // TTY 状态隔离（镜像 link-command.test.ts）
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('参数与解析', () => {
  it('UNL-1：无参数无 --all → 用法提示 exit 1', async () => {
    const ws = makeWs()
    const r = await runUnlink([], {})
    expect(r).toBe(1)
  })
  it('UNL-2：--all 与显式 targets 互斥 → exit 1 + stderr', async () => {
    const ws = makeWs({}, STATE_ONE)
    const r = await runUnlink(['@t/lib'], { all: true }, ws)
    expect(r).toBe(1)
  })
  it('UNL-3：名字分支未链接 → 「未链接：x，跳过」exit 0 零写盘', async () => {
    const ws = makeWs()
    const r = await runUnlink(['ghost'], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
  })
  it('UNL-26：路径分支——注册路径解析出 key；不存在路径 → exit 1', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink([join(ws, 'lpm-lib')], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    const r2 = await runUnlink([join(ws, 'no-such-dir')], {}, ws)
    expect(r2).toBe(1)
  })
})

describe('三态恢复（per-file）', () => {
  it('UNL-4：态1 恢复——pkg link: → ^1.0.0 + install 恰一次 + 条目删除', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(execa).toHaveBeenCalledWith('pnpm', ['install', '--no-frozen-lockfile'], expect.objectContaining({ cwd: ws }))
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/lib'])
  })
  it('UNL-5：态2 幂等跳过——pkg 已 ^1.0.0 → pkg byte 不变 + install 恰一次（重跑收敛）+ 条目删除', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }) }, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }))
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-6：态3 冲突非 TTY → LinkInteractionError + state 保留 + pkg 不变', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
  })
  it('UNL-7：态3 冲突 TTY 选「用当前」→ 零改写 + install 恰一次 + 条目删除', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('current')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-8：态3 冲突 TTY 选「用 original」→ 恢复', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('original')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('UNL-9：态3 isCancel → 放弃（条目保留 + pkg 不变 + 无 install）', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('current')
    vi.mocked(isCancel).mockReturnValue(true)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
  })
  it('UNL-24：同 key 去重（名字 + 同路径两写法）→ 第二处跳过计数', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib', join(ws, 'lpm-lib')], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)
  })
  it('UNL-10：文件不存在 → 跳过警告 + 条目删除照常', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0', 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    expect(execa).toHaveBeenCalledTimes(1) // 恰一次 install
    expect(execa).not.toHaveBeenCalledWith('pnpm', ['install', '--force'], expect.anything()) // 0 次 --force：缺失文件不入复验面（D1）
  })
  it('UNL-11：全文件缺失 → 条目保留 + 无 install + exit 0', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } })
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8')).links['@t/lib']).toBeDefined()
  })
  it('UNL-23：多 target 同文件链式恢复（两 lib 一 manifest）', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }), 'apps/web/node_modules/@t/libb/.keep': '' },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/web/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    writeFileSync(join(ws, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib', '@t/libb': 'link:../lpm-libb' } }), 'utf8')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib', '@t/libb'], {}, ws)
    expect(r).toBe(0)
    const pkg = JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8'))
    expect(pkg.dependencies['@t/lib']).toBe('^1.0.0')
    expect(pkg.dependencies['@t/libb']).toBe('^2.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
  })
})

describe('崩溃安全与 state/last', () => {
  it('UNL-13：install 失败 → InstallError + state 保留 + 文件已恢复', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom' })
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })
  it('UNL-14：重跑收敛——UNL-13 场景再跑 → 零改写 + install 再调 + 条目删除', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockRejectedValueOnce({ exitCode: 1, stderr: 'boom' })
    await runUnlink(['@t/lib'], {}, ws)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const pkgBefore = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(pkgBefore)
    expect(execa).toHaveBeenCalledTimes(2)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-15：--all 多 key 拆至清空 → last 记清空前完整集合 + state 文件删除', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }) },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/web/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink([], { all: true }, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/lib', '@t/libb'])
  })
  it('UNL-16：部分恢复（2 key 删 1）→ last 不动 + state 剩余条目', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }) },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/other/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
    const st = JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8'))
    expect(st.links['@t/lib']).toBeUndefined()
    expect(st.links['@t/libb']).toBeDefined()
  })
  it('UNL-17：--all 空 state → 「无已链接项」exit 0', async () => {
    const ws = makeWs()
    const r = await runUnlink([], { all: true }, ws)
    expect(r).toBe(0)
  })
})

describe('条目校验（裁决 5）', () => {
  it('UNL-12：损坏四形态 → LinkStateCorruptError + exit 1（缺失/非对象/空对象/值空串）', async () => {
    const cases = [
      { version: 1, links: { '@t/lib': { linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: 'oops', linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: {}, linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '' }, linkedAt: 'x' } } },
    ]
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      for (const state of cases) {
        const ws = makeWs({}, state)
        const r = await runUnlink(['@t/lib'], {}, ws)
        expect(r).toBe(1)
      }
      // 实质断言：LinkStateCorruptError 经 reportError 单通道落 stderr
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('state 条目损坏')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('--dry-run（裁决 6）', () => {
  it('UNL-18：计划逐行输出 + 零写盘零子进程', async () => {
    const ws = makeWs({}, STATE_ONE)
    const pkgBefore = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runUnlink(['@t/lib'], { dryRun: true }, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(pkgBefore)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })
  it('UNL-19：dry-run 冲突降级警告继续', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    const r = await runUnlink(['@t/lib'], { dryRun: true }, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })
})

describe('lstat 复验 + --force（裁决 1）', () => {
  it('UNL-20：真实软链残留 → force 恰一次 → 复验未过警告（mock 不真重建）exit 0', async () => {
    const ws = makeWs({}, STATE_ONE)
    // 默认 registry 实体替换为指向 lib 的 junction（残留形态）
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2) // install + force 恰一次
    expect(execa).toHaveBeenNthCalledWith(2, 'pnpm', ['install', '--force'], expect.objectContaining({ cwd: ws }))
  })
  it('UNL-21：复验缺失 → force；force 后仍缺失 → 警告不阻塞', async () => {
    const ws = makeWs({}, STATE_ONE)
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2)
  })
  it('UNL-22：注册缺失（cfg.libs 无 key）→ 存在实体则 ok + 注明，无 force', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) }, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1) // 仅 install——实体存在，指向比对跳过注明
  })
  it('UNL-27：「已重建」只打印先前坏条目，健康条目零误报', async () => {
    const ws = makeWs(
      {
        'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }),
        'apps/web/node_modules/@t/libb/.keep': '', // @t/libb 保持 registry 实体（健康）
        'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib', '@t/libb': 'lpm-libb' } }),
      },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/web/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    // @t/lib 删除 → 缺失（先前坏）；@t/libb 不动（先前就 ok）
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    // force 后 mock 重建 @t/lib 实体 → 复验转 ok（触发「已重建」）
    vi.mocked(execa).mockImplementation((async (_cmd: unknown, args: unknown[]) => {
      if (Array.isArray(args) && args.includes('--force')) {
        mkdirSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true })
        writeFileSync(join(ws, 'apps/web/node_modules/@t/lib/.keep'), '', 'utf8')
      }
      return { exitCode: 0 } as never
    }) as never)
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const r = await runUnlink(['@t/lib', '@t/libb'], {}, ws)
      expect(r).toBe(0)
      const out = outSpy.mock.calls.map((c) => String(c[0])).join('')
      // 情形 A：先前坏 → force 后 ok → 打印「已重建：<nmRel>」
      expect(out).toContain('已重建：apps/web/node_modules/@t/lib\n')
      // 情形 B：先前就 ok → 不得打印
      expect(out).not.toContain('已重建：apps/web/node_modules/@t/libb')
      expect(out.split('已重建').length - 1).toBe(1) // 未对健康条目误报
      expect(execa).toHaveBeenCalledTimes(2) // install + force 恰一次
    } finally {
      outSpy.mockRestore()
    }
  })
  it('UNL-31：悬空链接 → 复验报「悬空链接」→ force 恰一次', async () => {
    const ws = makeWs({}, STATE_ONE)
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    rmSync(join(ws, 'lpm-lib'), { recursive: true, force: true }) // 目标删除 → 悬空
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2) // install + --force
  })
})

describe('完成提示（J/I）', () => {
  it('UNL-25：恢复完成计数与逐行明细', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
  })
})

describe('OCR 修复回归（S7 评审轮）', () => {
  it('UNL-28：原型链成员名（constructor）→ 「未链接跳过」而非条目损坏（own-property 守卫）', async () => {
    const ws = makeWs({}, STATE_ONE) // state 存在——修复前 st.links['constructor'] 取到原型链成员
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const r = await runUnlink(['constructor'], {}, ws)
      expect(r).toBe(0)
      const outText = out.mock.calls.map((c) => String(c[0])).join('')
      const errText = err.mock.calls.map((c) => String(c[0])).join('')
      expect(outText).toContain('未链接：constructor，跳过')
      expect(errText).not.toContain('条目损坏')
      expect(execa).not.toHaveBeenCalled()
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  })

  it('UNL-29：键指向目录（非常规文件）→ 警告出局、无 EISDIR 逃逸、条目保留', async () => {
    // 'apps/web' 是已存在目录——修复前 existsSync 放行 → readFileSync 抛 EISDIR 逃逸出 runUnlink
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/web': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const r = await runUnlink(['@t/lib'], {}, ws)
      expect(r).toBe(0) // 修复前此处会 reject（EISDIR 非 KNOWN 错误）
      const errText = err.mock.calls.map((c) => String(c[0])).join('')
      expect(errText).toContain('不是常规文件')
      expect(errText).not.toContain('EISDIR')
      expect(execa).not.toHaveBeenCalled() // 全文件出局 → 条目保留、零子进程
      expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
    } finally {
      err.mockRestore()
    }
  })

  it('UNL-30：多段命中值异警告点明被覆盖的段（文案显性化，行为仍为全段写回）', async () => {
    const ws = makeWs(
      { 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' }, devDependencies: { '@t/lib': '^2.0.0' } }) },
      STATE_ONE,
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const r = await runUnlink(['@t/lib'], {}, ws)
      expect(r).toBe(0)
      const errText = err.mock.calls.map((c) => String(c[0])).join('')
      expect(errText).toContain('devDependencies.@t/lib')
      expect(errText).toContain('将被覆盖为 ^1.0.0')
      // 裁决 4 行为不变：全段写回首个命中 original
      const pkg = JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8'))
      expect(pkg.dependencies['@t/lib']).toBe('^1.0.0')
      expect(pkg.devDependencies['@t/lib']).toBe('^1.0.0')
    } finally {
      err.mockRestore()
    }
  })
})

describe('S8 运行留痕 + O4 计数回滚（unlink）', () => {
  it('STR-U1：放弃时 planIdempotent 回滚——「跳过合计」不虚增', async () => {
    const ws = makeWs(
      {
        'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }), // 幂等跳过（值 == original）
        'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^2.0.0' } }), // 冲突 → isCancel → 放弃
      },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/other/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    stubTty(true)
    vi.mocked(select).mockResolvedValue('current')
    vi.mocked(isCancel).mockReturnValue(true)
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const r = await runUnlink(['@t/lib'], {}, ws)
      expect(r).toBe(0)
      const text = out.mock.calls.map((c) => String(c[0])).join('')
      // 回滚前 planIdempotent 会多计 web 的 1 处 → 跳过合计 2；回滚后仅放弃的 key → 1
      expect(text).toContain('跳过合计：1 处')
      expect(text).not.toContain('跳过合计：2 处')
    } finally {
      out.mockRestore()
    }
  })
  it('STR-U2：unlink 成功 → last-run.json 存在且 command=unlink/result=ok/含 delete-entry', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    expect(await runUnlink(['@t/lib'], {}, ws)).toBe(0)
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    expect(trace.command).toBe('unlink')
    expect(trace.result).toBe('ok')
    expect(trace.failure).toBeNull()
    expect(trace.changes.some((c: { action: string }) => c.action === 'delete-entry')).toBe(true)
  })
  it('STR-U3：install 失败 → result=failed 且 failure.stderrTail 为原始 stderr 末尾', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom-tail' })
    expect(await runUnlink(['@t/lib'], {}, ws)).toBe(1)
    const trace = JSON.parse(readFileSync(join(ws, '.lpm', 'last-run.json'), 'utf8'))
    expect(trace.command).toBe('unlink')
    expect(trace.result).toBe('failed')
    expect(trace.failure.exitCode).toBe(1)
    expect(trace.failure.stderrTail).toContain('boom-tail')
    // 评审 ②：失败时也须记下「已发生的改动」（声明已恢复）与失败的那次子进程；档案未动
    expect(trace.changes.some((c: { action: string }) => c.action === 'rewrite-manifest')).toBe(true)
    expect(trace.changes.some((c: { action: string }) => c.action === 'write-state' || c.action === 'delete-entry')).toBe(false)
    expect(trace.installs).toHaveLength(1)
    expect(trace.installs[0]).toMatchObject({ ok: false, exitCode: 1 })
  })
  it('STR-U4：--dry-run 失败路径零写盘——不存在路径 exit 1 且不建 .lpm/（评审 ①）', async () => {
    const ws = makeWs()
    const r = await runUnlink([join(ws, 'no-such-dir')], { dryRun: true }, ws)
    expect(r).toBe(1)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
  })
})
