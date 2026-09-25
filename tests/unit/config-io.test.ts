import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LpmConfigParseError, readProjectConfig, writeProjectConfig } from '../../src/state/index.js'
import { writeJsonFileAtomic } from '../../src/state/atomic.js'
import type { ProjectLpmConfig } from '../../src/state/types.js'

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
