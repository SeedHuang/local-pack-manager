import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LpmConfigParseError, readProjectConfig, writeProjectConfig } from '../../src/state/index.js'
import { writeJsonFileAtomic } from '../../src/state/atomic.js'
import type { ProjectLpmConfig } from '../../src/state/types.js'

// T1①（S4 spec §4.5）：writeFileSync 默认透传真实现；failWrite 开关注入失败以观察 tmp 名；
// calls 记录 writeFileSync 首参（tmp 路径）供 14-2 断言 uuid 段
const fsMock = vi.hoisted(() => ({ failWrite: false, calls: [] as unknown[][] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      fsMock.calls.push(args)
      if (fsMock.failWrite) throw new Error('injected write failure')
      return actual.writeFileSync(...args)
    }) as typeof actual.writeFileSync,
  }
})

const dirs: string[] = []
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-cfg-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('readProjectConfig / writeProjectConfig（S1 §4.4 冻结签名）', () => {
  it('用例 14a：roundtrip——写后读一致', async () => {
    const dir = makeProject()
    const cfg: ProjectLpmConfig = { version: 1, packageManager: 'pnpm', libs: { x: '../x' } }
    await writeProjectConfig(dir, cfg)
    expect(await readProjectConfig(dir)).toEqual(cfg)
  })

  it('用例 14b：文件缺失 → null', async () => {
    expect(await readProjectConfig(makeProject())).toBeNull()
  })

  it('用例 14c：坏 JSON → LpmConfigParseError（路径 + 可抛弃重建，§6.5）', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{oops', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as LpmConfigParseError).configPath).toBe(join(dir, 'lpm.config.json'))
    expect((err as Error).message).toContain('不是合法 JSON')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 14d：非对象 JSON（数组/原始值）→ LpmConfigParseError（OCR 修复 M1）', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '[]', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as Error).message).toContain('应为 JSON 对象')
    expect((err as Error).message).toContain('可抛弃重建')
    const dir2 = makeProject()
    writeFileSync(join(dir2, 'lpm.config.json'), '"pnpm"', 'utf8')
    await expect(readProjectConfig(dir2)).rejects.toBeInstanceOf(LpmConfigParseError)
  })

  it('用例 16：读容忍 BOM（运行时 Buffer 写入 EF BB BF）', async () => {
    const dir = makeProject()
    const body = JSON.stringify({ version: 1, libs: {} })
    writeFileSync(
      join(dir, 'lpm.config.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    )
    expect(await readProjectConfig(dir)).toEqual({ version: 1, libs: {} })
  })
})

describe('writeJsonFileAtomic（原子写 helper，S4 复用）', () => {
  it('用例 15a：写后无 *.tmp 残留，目标可读', () => {
    const dir = makeProject()
    writeJsonFileAtomic(join(dir, 'a.json'), { a: 1 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))).toEqual({ a: 1 })
  })

  it('用例 15b：目标已存在 → 覆盖成功且无残留', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    writeJsonFileAtomic(p, { a: 1 })
    writeJsonFileAtomic(p, { a: 2 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 15c：格式——2 空格缩进 + 尾随换行 + 无 BOM', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    writeJsonFileAtomic(p, { a: 1 })
    const raw = readFileSync(p, 'utf8')
    expect(raw).toBe('{\n  "a": 1\n}\n')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
  })
})

describe('writeJsonFileAtomic 并发与 tmp 契约（T1①，S4 spec §4.5）', () => {
  it('用例 14：同进程并发写同目标——双成功、无 tmp 残留、终值为两次之一的完整内容', async () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    await Promise.all([
      Promise.resolve().then(() => writeJsonFileAtomic(p, { a: 1 })),
      Promise.resolve().then(() => writeJsonFileAtomic(p, { b: 2 })),
    ])
    const raw = readFileSync(p, 'utf8')
    // 同步函数体在事件循环下串行执行——终值确定为后写者；此处按并发契约「二选一」断言（计划期修订 1）
    expect(raw === '{\n  "a": 1\n}\n' || raw === '{\n  "b": 2\n}\n').toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 14-2：tmp 名含 pid 与 uuid 段（失败注入观察，§4.5 格式契约）', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    fsMock.calls.length = 0
    fsMock.failWrite = true
    try {
      expect(() => writeJsonFileAtomic(p, { a: 1 })).toThrow('injected write failure')
    } finally {
      fsMock.failWrite = false
    }
    const tmpArg = fsMock.calls[0]?.[0]
    expect(typeof tmpArg).toBe('string')
    const base = (tmpArg as string).split(/[\\/]/).pop() as string
    expect(base).toMatch(/^a\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/)
    // 失败路径清理后无孤儿 tmp（S3 L1 语义回归守护）
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('readProjectConfig 深层校验（S4 spec §4.4 规约 5–7，F1/F2 闭环）', () => {
  it('用例 14b-1：libs 缺失 → LpmConfigParseError「libs 应为对象」', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":1}', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as Error).message).toContain('libs 应为对象')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 14b-2：libs 非对象（数组）→ LpmConfigParseError', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":1,"libs":[]}', 'utf8')
    await expect(readProjectConfig(dir)).rejects.toBeInstanceOf(LpmConfigParseError)
  })

  it('用例 14b-3：version ≠ 1（libs 合法）→ LpmConfigParseError「不支持的版本」', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":2,"libs":{}}', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as Error).message).toContain('不受支持（当前仅 version: 1）')
  })

  it('用例 14b-4：libs 齐全 + version 缺失 → 宽容通过', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"libs":{}}', 'utf8')
    expect(await readProjectConfig(dir)).toEqual({ libs: {} })
  })
})
