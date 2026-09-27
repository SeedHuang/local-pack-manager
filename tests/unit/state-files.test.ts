import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTextFileAtomic } from '../../src/state/atomic.js'
import {
  LpmStateParseError,
  deleteState,
  ensureGitignoreEntry,
  readLast,
  readState,
  readUserConfig,
  writeLast,
  writeState,
  writeUserConfig,
} from '../../src/state/index.js'

// homedir 隔离（spec §7.1）：默认透传真实现，osMock.home 非空时替换（F10：plan 期红灯即验；失效则改 USERPROFILE 注入）
const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})

const dirs: string[] = []
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-state-'))
  dirs.push(dir)
  return dir
}
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-home-'))
  dirs.push(home)
  osMock.home = home
  return home
}
afterEach(() => {
  osMock.home = ''
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function writeStateFile(dir: string, content: string): void {
  mkdirSync(join(dir, '.lpm'), { recursive: true })
  writeFileSync(join(dir, '.lpm', 'state.json'), content, 'utf8')
}

describe('readState（S4 spec §4.4 读取共通规约）', () => {
  it('用例 1a：缺失 → null', async () => {
    expect(await readState(makeProject())).toBeNull()
  })

  it('用例 1b：手工落盘合法 state → 读出一致（roundtrip 前半，writeState 于 Task 3 补后半）', async () => {
    const dir = makeProject()
    const st = {
      version: 1 as const,
      links: { x: { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-09-26T00:00:00.000Z' } },
    }
    writeStateFile(dir, JSON.stringify(st, null, 2))
    expect(await readState(dir)).toEqual(st)
  })

  it('用例 2a：坏 JSON → LpmStateParseError（filePath + 可抛弃重建）', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{oops')
    const err = await readState(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as LpmStateParseError).filePath).toBe(join(dir, '.lpm', 'state.json'))
    expect((err as Error).message).toContain('不是合法 JSON')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 2b：非对象（数组/原始值）→ LpmStateParseError', async () => {
    const dir = makeProject()
    writeStateFile(dir, '[]')
    await expect(readState(dir)).rejects.toBeInstanceOf(LpmStateParseError)
    const dir2 = makeProject()
    writeStateFile(dir2, '"x"')
    await expect(readState(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 3：links 缺失 / links 非对象（数组）→ LpmStateParseError「links 应为对象」', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{"version":1}')
    const err = await readState(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('links 应为对象')
    const dir2 = makeProject()
    writeStateFile(dir2, '{"version":1,"links":[]}')
    await expect(readState(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 4：version 缺失宽容通过；version ≠ 1 → 「不支持的版本」', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{"links":{}}')
    expect(await readState(dir)).toEqual({ links: {} })
    const dir2 = makeProject()
    writeStateFile(dir2, '{"version":2,"links":{}}')
    const err = await readState(dir2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('不受支持（当前仅 version: 1）')
  })

  it('用例 5：BOM 容忍（Buffer EF BB BF 前缀）', async () => {
    const dir = makeProject()
    writeStateFile(dir, '')
    const body = JSON.stringify({ version: 1, links: {} })
    writeFileSync(
      join(dir, '.lpm', 'state.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    )
    expect(await readState(dir)).toEqual({ version: 1, links: {} })
  })
})

describe('readLast（读路径部分；roundtrip 于 Task 3 用例 9c 补）', () => {
  it('用例 9a：缺失 → null', async () => {
    expect(await readLast(makeProject())).toBeNull()
  })

  it('用例 9b：names 缺失 / 非数组 → LpmStateParseError「names 应为数组」', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'last.json'), '{"version":1}', 'utf8')
    const err = await readLast(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('names 应为数组')
    const dir2 = makeProject()
    mkdirSync(join(dir2, '.lpm'), { recursive: true })
    writeFileSync(join(dir2, '.lpm', 'last.json'), '{"version":1,"names":"x"}', 'utf8')
    await expect(readLast(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })
})

describe('readUserConfig（homedir 隔离）', () => {
  it('用例 11a：文件缺失 → { version: 1, scanDirs: [] }（S1 冻结注释定版）', async () => {
    makeHome()
    expect(await readUserConfig()).toEqual({ version: 1, scanDirs: [] })
  })

  it('用例 11b：scanDirs 缺失 / 非数组 → LpmStateParseError「scanDirs 应为数组」', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{"version":1}', 'utf8')
    const err = await readUserConfig().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('scanDirs 应为数组')
    const home2 = makeHome()
    mkdirSync(join(home2, '.lpm'), { recursive: true })
    writeFileSync(join(home2, '.lpm', 'config.json'), '{"version":1,"scanDirs":"x"}', 'utf8')
    await expect(readUserConfig()).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 11c：坏 JSON → LpmStateParseError', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{oops', 'utf8')
    await expect(readUserConfig()).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 11d：version ≠ 1 → 「不支持的版本」', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{"version":2,"scanDirs":[]}', 'utf8')
    const err = await readUserConfig().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('不受支持（当前仅 version: 1）')
  })
})

describe('writeState（S4 spec §4.4：mkdir + gitignore 防护 + 原子写）', () => {
  it('用例 6：.lpm/ 不存在时自动 mkdir；原子写（无 tmp 残留）', async () => {
    const dir = makeProject()
    const st = { version: 1 as const, links: {} }
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.lpm', 'state.json'), 'utf8')).toContain('"version": 1')
    expect(readFileSync(join(dir, '.lpm', 'state.json'), 'utf8').endsWith('\n')).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 7：首写触发 .gitignore 追加（新建含 .lpm/ 行）；次写幂等不重复', async () => {
    const dir = makeProject()
    const st = { version: 1 as const, links: {} }
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
  })

  it('用例 7b：.gitignore 已存在且末尾无换行 → 先补换行再追加', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8')
    await writeState(dir, { version: 1 as const, links: {} })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.lpm/\n')
  })
})

describe('deleteState（幂等；只删 state.json）', () => {
  it('用例 8：删除成功；文件缺失幂等；last.json 不受影响', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), '{"version":1,"links":{}}', 'utf8')
    writeFileSync(join(dir, '.lpm', 'last.json'), '{"version":1,"names":[]}', 'utf8')
    await deleteState(dir)
    expect(() => readFileSync(join(dir, '.lpm', 'state.json'), 'utf8')).toThrow()
    expect(readFileSync(join(dir, '.lpm', 'last.json'), 'utf8')).toBe('{"version":1,"names":[]}')
    await deleteState(dir) // 幂等
    await deleteState(makeProject()) // 目录都不存在也幂等
  })
})

describe('writeLast / readLast roundtrip（S4 spec §4.4：mkdir + 原子写；不触 gitignore）', () => {
  it('用例 9c：writeLast 后 readLast 一致（roundtrip 后半）', async () => {
    const dir = makeProject()
    const last = { version: 1 as const, names: ['a', 'b'] }
    await writeLast(dir, last)
    expect(await readLast(dir)).toEqual(last)
  })

  it('用例 10：writeLast 不追加 .gitignore（不调 ensureGitignoreEntry，spec §4.4 差异点）', async () => {
    const dir = makeProject()
    await writeLast(dir, { version: 1 as const, names: [] })
    expect(() => readFileSync(join(dir, '.gitignore'), 'utf8')).toThrow()
  })
})

describe('writeUserConfig（homedir 隔离）', () => {
  it('用例 12：mkdir ~/.lpm + 原子写 + roundtrip', async () => {
    makeHome()
    const cfg = { version: 1 as const, scanDirs: ['D:/libs', 'D:/more'] }
    await writeUserConfig(cfg)
    expect(await readUserConfig()).toEqual(cfg)
    expect(readFileSync(join(osMock.home, '.lpm', 'config.json'), 'utf8')).toContain('D:/libs')
  })
})

describe('ensureGitignoreEntry（S4 spec §4.4 归一化口径，F4 含 BOM）', () => {
  it('用例 13-1：文件不存在 → 新建内容 .lpm/\\n → added', async () => {
    const dir = makeProject()
    expect(await ensureGitignoreEntry(dir)).toBe('added')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
  })

  it('用例 13-2：已覆盖 12 种常见写法 → present 且内容零改动', async () => {
    const entries = [
      '.lpm', '.lpm/', '/.lpm', '/.lpm/', '.lpm/*', '/.lpm/*',
      '.lpm/**', '/.lpm/**', '**/.lpm', '**/.lpm/', '**/.lpm/*', '**/.lpm/**',
    ]
    for (const entry of entries) {
      const dir = makeProject()
      writeFileSync(join(dir, '.gitignore'), `node_modules/\n${entry}\n`, 'utf8')
      expect(await ensureGitignoreEntry(dir), `写法 ${entry}`).toBe('present')
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `写法 ${entry}`).toBe(`node_modules/\n${entry}\n`)
    }
  })

  it('用例 13-3：反例 .lpmx / .foo/.lpm / !.lpm/ → 未覆盖，追加 .lpm/ 行', async () => {
    for (const entry of ['.lpmx', '.foo/.lpm', '!.lpm/']) {
      const dir = makeProject()
      writeFileSync(join(dir, '.gitignore'), `${entry}\n`, 'utf8')
      expect(await ensureGitignoreEntry(dir), `反例 ${entry}`).toBe('added')
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `反例 ${entry}`).toBe(`${entry}\n.lpm/\n`)
    }
  })

  it('用例 13-4：末尾无换行 → 先补换行再追加', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8')
    expect(await ensureGitignoreEntry(dir)).toBe('added')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.lpm/\n')
  })

  it('用例 13-5：带 BOM 的 .gitignore（首行 .lpm/）→ present 且零改动（F4）', async () => {
    const dir = makeProject()
    writeFileSync(
      join(dir, '.gitignore'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('.lpm/\nnode_modules/\n', 'utf8')]),
    )
    expect(await ensureGitignoreEntry(dir)).toBe('present')
    // present 零改动：BOM 与原内容原样保留
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').charCodeAt(0)).toBe(0xfeff)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('\uFEFF.lpm/\nnode_modules/\n')
  })
})

describe('writeTextFileAtomic（S6 spec §4.3）', () => {
  it('用例 T1-1：逐字节写回（BOM/CRLF/中文 byte 级保真）且无 tmp 残留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const p = join(dir, 'package.json')
      const content = '\uFEFF{\r\n  "name": "包",\r\n  "dependencies": {\r\n    "x": "link:../lib"\r\n  }\r\n}\r\n'
      writeTextFileAtomic(p, content)
      expect(readFileSync(p, 'utf8')).toBe(content)
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用例 T1-2：目标为已存在目录 → rename 失败 → 原错误重抛且 tmp 清理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const target = join(dir, 'occupied')
      mkdirSync(target)
      expect(() => writeTextFileAtomic(target, 'x')).toThrow()
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用例 T1-3：父目录缺失 → write 失败重抛且目标不存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const p = join(dir, 'no-such', 'package.json')
      expect(() => writeTextFileAtomic(p, 'x')).toThrow()
      expect(existsSync(p)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
