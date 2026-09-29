import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), isCancel: vi.fn(() => false),
}))

import { multiselect, isCancel } from '@clack/prompts'
import { runDir } from '../../src/commands/dir.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-dir-home-'))
  dirs.push(home)
  osMock.home = home
  mkdirSync(join(home, '.lpm'), { recursive: true })
  return home
}
function readUserCfg(home: string): { version: number; scanDirs: unknown[] } {
  const p = join(home, '.lpm', 'config.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as { version: number; scanDirs: unknown[] } : { version: 1, scanDirs: [] }
}
function stubTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true })
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}

beforeEach(() => { osMock.home = ''; vi.clearAllMocks(); vi.mocked(isCancel).mockReturnValue(false) })

describe('lpm dir（S11）', () => {
  it('D-1 add：正常 → 写入 scanDirs', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const cap = captureOut()
    const code = await runDir(['add', scan])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toContain(scan)
    expect(cap.out.join('')).toContain(`已加入扫描目录：${scan}`)
  })

  it('D-2 add 去重：重复 add 不重复写', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    captureOut()
    expect(await runDir(['add', scan])).toBe(0)
    expect(await runDir(['add', scan])).toBe(0)
    expect(readUserCfg(home).scanDirs.filter((d) => d === scan)).toHaveLength(1)
  })

  it('D-3 add 校验：非绝对路径 → DirError + 零写盘', async () => {
    const home = makeHome()
    const cap = captureOut()
    const code = await runDir(['add', 'relative/path'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录必须是已存在的绝对路径')
    expect(existsSync(join(home, '.lpm', 'config.json'))).toBe(false)
  })

  it('D-4 add 校验：目录不存在 → DirError', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['add', join(tmpdir(), 'no-such-dir-xyz')])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录必须是已存在的绝对路径')
  })

  it('D-5 add 读-改-写保留未知字段', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [], future: 1 }), 'utf8')
    captureOut()
    expect(await runDir(['add', scan])).toBe(0)
    const cfg = JSON.parse(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')) as { future: number }
    expect(cfg.future).toBe(1)
  })

  it('D-6 rm：按值移除', async () => {
    const home = makeHome()
    const a = 'D:\\Seed\\libs'
    const b = 'D:\\Seed\\other'
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [a, b] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', a])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toEqual([b])
    expect(cap.out.join('')).toContain(`已移除扫描目录：${a}`)
  })

  it('D-7 rm 不在列表 → DirError + 列当前', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', 'D:\\Seed\\nope'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录不在列表中')
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\libs'])
  })

  it('D-8 rm 空列表 → 专属文案', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['rm', 'D:\\Seed\\nope'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-9 ls：逐行列出', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 'D:\\Seed\\other'] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('D:\\Seed\\libs\nD:\\Seed\\other')
  })

  it('D-10 ls 空 → 提示 + exit 0', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-11 ls 非字符串元素 → 跳过 + 提示（脏配置降级）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 123] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('跳过无效的扫描目录项（非字符串）：123')
    expect(cap.out.join('')).toContain('D:\\Seed\\libs')
  })

  it('D-12 无参数非 TTY → 提示 + exit 1 + 零 clack 调用', async () => {
    makeHome()
    stubTty(false)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm dir add')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('D-13 无参数 TTY 交互：列出多选删 → 逐行提示 + 文件更新（不二次确认）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 'D:\\Seed\\other'] }), 'utf8')
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['D:\\Seed\\libs'] as never)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\other'])
    expect(cap.out.join('')).toContain('已移除扫描目录：D:\\Seed\\libs')
  })

  it('D-14 无参数 TTY 空列表 → 提示 + exit 0', async () => {
    makeHome()
    stubTty(true)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-15 无参数 TTY 空选中 → exit 1', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何扫描目录')
  })

  it('D-16 无参数 TTY 取消 → 已取消 + exit 1 + 零写盘', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    stubTty(true)
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\libs'])
  })

  it('D-17 子命令非法 / 缺路径 / 多余参数 → 用法错误', async () => {
    makeHome()
    for (const args of [['bogus'], ['add'], ['rm'], ['add', 'a', 'b']]) {
      const cap = captureOut()
      const code = await runDir(args)
      expect(code).toBe(1)
      expect(cap.err.join('')).toContain('用法错误')
    }
  })

  it('D-18 scanDirs 顶层非数组（脏配置）→ 透传 LpmStateParseError（不吞）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: 'oops' }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('scanDirs 应为数组')
  })
})

describe('lpm dir --dry-run（S12 spec §4.4/§4.5）', () => {
  it('S12-D-DR1：add --dry-run → 计划文本 + 用户配置零写盘 + exit 0', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const cap = captureOut()
    const code = await runDir(['add', scan], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.out.join('')).toContain(`将加入扫描目录：${scan}`)
    expect(existsSync(join(home, '.lpm', 'config.json'))).toBe(false)
  })

  it('S12-D-DR2：rm --dry-run → 计划文本 + 零写盘 + exit 0', async () => {
    const home = makeHome()
    const scan = join(home, 'scan-dir')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scan] }), 'utf8')
    const before = readFileSync(join(home, '.lpm', 'config.json'), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', scan], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain(`将移除扫描目录：${scan}`)
    expect(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')).toBe(before)
  })

  it('S12-D-DR3：ls --dry-run → 照常列出（只读不受影响）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [join(home, 'a')] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain(join(home, 'a'))
  })

  it('S12-D-DR4：无参数 + --dry-run → 拒绝 + exit 1 + 零 clack 调用', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir([], process.cwd(), { dryRun: true })
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('--dry-run 仅直通模式适用')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('S12-D-DR5：add --dry-run + corrupt 用户配置 → 照样报错 exit 1（OCR-2 回归钉：先读配置再短路）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), '{ not valid json', 'utf8')
    const scan = join(home, 'scan-dir')
    mkdirSync(scan, { recursive: true })
    const cap = captureOut()
    const code = await runDir(['add', scan], process.cwd(), { dryRun: true })
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('不是合法 JSON')
    expect(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')).toBe('{ not valid json')
  })
})
