import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InitConfigNotFoundError,
  findHostConfig,
  findMarker,
  locateConfigObject,
} from '../../src/core/utoopack.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-loc-'))
  dirs.push(dir)
  for (const [n, c] of Object.entries(files)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}

describe('findHostConfig（spec §4.2 候选文件名按序）', () => {
  it('候选顺序：config/config.ts 优先于 .umirc.ts', () => {
    const dir = makeDir({
      'config/config.ts': 'x',
      '.umirc.ts': 'y',
    })
    expect(findHostConfig(dir)).toBe(join(dir, 'config', 'config.ts'))
  })
  it('config 缺失 → 命中 .umirc.ts', () => {
    const dir = makeDir({ '.umirc.ts': 'y' })
    expect(findHostConfig(dir)).toBe(join(dir, '.umirc.ts'))
  })
  it('全部缺失 → InitConfigNotFoundError（文案含候选清单）', () => {
    const dir = makeDir()
    expect(() => findHostConfig(dir)).toThrow(InitConfigNotFoundError)
    expect(() => findHostConfig(dir)).toThrow('未找到 umi 配置文件')
  })
})

describe('locateConfigObject（spec §4.4 + §8 自决 2）', () => {
  it('defineConfig({...}) 多行 → 返回对象体 { } 下标', () => {
    const src = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    expect(src.slice((r as { start: number; end: number }).start, (r as { start: number; end: number }).end + 1)).toMatch(/^\{[\s\S]*\}$/)
    expect((r as { start: number; end: number }).end).toBe(src.indexOf('})'))
  })
  it('defineConfig( 与 { 之间换行也命中', () => {
    const src = 'export default defineConfig(\n  {\n    antd: {},\n  },\n)\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('export default { 单行紧凑 → 命中', () => {
    const src = 'export default { antd: {} }\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('字符串内花括号不干扰配对（antd: { theme: "{}" }）', () => {
    const src = "export default defineConfig({ antd: { theme: '{}' }, access: {} })\n"
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    expect(src[(r as { start: number; end: number }).end]).toBe('}')
  })
  it('行注释/块注释内括号不干扰', () => {
    const src = 'export default defineConfig({\n  // a { b }\n  /* c { d } */\n  antd: {},\n})\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('嵌套对象 → 配对到最外层 }', () => {
    const src = 'export default defineConfig({ a: { b: { c: 1 } }, d: 2 })\n'
    const r = locateConfigObject(src)
    expect(src[(r as { start: number; end: number }).end]).toBe('}')
    expect((r as { start: number; end: number }).end).toBe(src.lastIndexOf('}'))
  })
  it('括号不闭合 → null', () => {
    const src = 'export default defineConfig({ antd: {}\n'
    expect(locateConfigObject(src)).toBeNull()
  })
  it('无 defineConfig 也无 export default { → null', () => {
    expect(locateConfigObject('module.exports = {}')).toBeNull()
    expect(locateConfigObject('')).toBeNull()
  })
  it('空对象体 {} → 返回（start+1 与 end 相邻）', () => {
    const src = 'export default defineConfig({})\n'
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    const { start, end } = r as { start: number; end: number }
    expect(src[start]).toBe('{')
    expect(src[end]).toBe('}')
  })
})

describe('findMarker（spec §4.8 自感知 + 不完整标记）', () => {
  it('无标记 → null', () => {
    expect(findMarker('export default defineConfig({})')).toBeNull()
  })
  it('完整标记 → complete:true + end 定位到 end 标记后', () => {
    const src = 'export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: { root: ".." },\n  /* lpm-inject:end */\n})\n'
    const m = findMarker(src)
    expect(m?.complete).toBe(true)
    expect(src.slice((m as { start: number; end: number }).start, (m as { start: number; end: number }).end)).toContain('/* lpm-inject:end */')
  })
  it('有 start 无 end → complete:false', () => {
    const src = 'export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: {},\n})\n'
    const m = findMarker(src)
    expect(m?.complete).toBe(false)
  })
})
