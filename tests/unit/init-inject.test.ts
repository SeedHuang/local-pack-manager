import { describe, expect, it } from 'vitest'
import {
  InitConfigShapeError,
  InitIncompleteMarkerError,
  InitNotInjectedError,
  buildFragment,
  findAllMarkers,
  injectAdaptation,
  injectFragment,
  injectIntoKey,
  locateTopLevelKeyObject,
  removeFragment,
} from '../../src/core/utoopack.js'

const FRAG = (): string => buildFragment('../..', { react: 'D:/h/node_modules/react', antd: 'D:/h/node_modules/antd' })

describe('buildFragment（spec §3.1）', () => {
  it('含 start/end 注释 + utoopack + alias（正斜杠绝对路径）', () => {
    const f = FRAG()
    expect(f).toContain('/* lpm-inject:start */')
    expect(f).toContain('/* lpm-inject:end */')
    expect(f).toContain("root: '../..'")
    expect(f).toContain("react: 'D:/h/node_modules/react'")
  })
  it('空 alias → 省略 alias 键', () => {
    const f = buildFragment('..', {})
    expect(f).toContain('utoopack:')
    expect(f).not.toContain('alias:')
  })
  it('非标识符键名（连字符/scope）→ 加引号（OCR H1：react-dom、@ant-design/icons 是非法裸标识符）', () => {
    const f = buildFragment('..', { 'react-dom': 'D:/h/node_modules/react-dom', '@ant-design/icons': 'D:/h/node_modules/@ant-design/icons' })
    expect(f).toContain("'react-dom': 'D:/h/node_modules/react-dom'")
    expect(f).toContain("'@ant-design/icons': 'D:/h/node_modules/@ant-design/icons'")
  })
})

describe('injectFragment（spec §8 自决 1 三态）', () => {
  it('空对象体 {} → 无前置逗号（追加模式普通键格式，S14 方案 A）', () => {
    const out = injectFragment('export default defineConfig({})\n', FRAG())
    expect(out).toBe('export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: {\n    root: \'../..\',\n  },\n  alias: {\n    react: \'D:/h/node_modules/react\',\n    antd: \'D:/h/node_modules/antd\',\n  },\n  /* lpm-inject:end */})\n')
  })
  it('无尾逗号 → 补逗号作分隔', () => {
    const out = injectFragment('export default defineConfig({\n  antd: {},\n})\n', FRAG())
    expect(out).toContain('  antd: {},\n  /* lpm-inject:start */')
  })
  it('有尾逗号 → 复用原逗号不补', () => {
    const out = injectFragment('export default defineConfig({\n  antd: {},\n})\n'.replace('antd: {},', 'antd: {},,'), FRAG())
    // 构造有尾逗号：对象体末尾已有 ,
    const src = 'export default defineConfig({\n  antd: {},\n})\n'
    const withTail = src.replace('antd: {},\n})', 'antd: {},\n  ,\n})')
    const out2 = injectFragment(withTail, FRAG())
    expect(out2).not.toContain(',,\n')
  })
  it('无 defineConfig → InitConfigShapeError', () => {
    expect(() => injectFragment('module.exports = {}\n', FRAG())).toThrow(InitConfigShapeError)
  })
})

describe('removeFragment（spec §8 自决 1 摘除）', () => {
  it('无标记 → InitNotInjectedError', () => {
    expect(() => removeFragment('export default defineConfig({})\n')).toThrow(InitNotInjectedError)
  })
  it('不完整标记 → InitIncompleteMarkerError', () => {
    expect(() => removeFragment('export default defineConfig({\n  /* lpm-inject:start */\n  antd: {},\n})\n')).toThrow(InitIncompleteMarkerError)
  })
  it('无尾逗号宿主：byte 往返恒等（inject(uninject(x)) === x）', () => {
    const orig = 'export default defineConfig({\n  antd: {},\n  access: {}\n})\n'
    const injected = injectFragment(orig, FRAG())
    expect(removeFragment(injected)).toBe(orig)
  })
  it('遮蔽：宿主已有 utoopack 键 → uninit 后宿主键保留原样', () => {
    const orig = "export default defineConfig({\n  utoopack: { root: 'custom' },\n  antd: {}\n})\n"
    const injected = injectFragment(orig, FRAG())
    const restored = removeFragment(injected)
    expect(restored).toContain("utoopack: { root: 'custom' }")
    expect(restored).toBe(orig)
  })
  it('有尾逗号宿主：摘除后语义等价（尾逗号被消费），不断言 byte', () => {
    const orig = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'
    const withTail = orig.replace('access: {},', 'access: {},')
    // 直接构造有尾逗号文本
    const tailSrc = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'.replace('access: {},\n})', 'access: {},\n  ,\n})')
    const injected = injectFragment(tailSrc, FRAG())
    const restored = removeFragment(injected)
    // 语义等价：仍以 access 键开头且无残留标记
    expect(restored).toContain('access: {}')
    expect(restored).not.toContain('lpm-inject')
    void withTail
  })
  it('CRLF 保持：注入+摘除后原 CRLF 不变', () => {
    const orig = 'export default defineConfig({\r\n  antd: {}\r\n})\r\n'
    const injected = injectFragment(orig, FRAG())
    expect(injected).toContain('\r\n')
    expect(removeFragment(injected)).toBe(orig)
  })
})

describe('S14 方案 A：合并进宿主键（规避 TS1117/TS2783）', () => {
  const HOST = 'export default defineConfig({\n  utoopack: {},\n  antd: {}\n})\n'

  it('locateTopLevelKeyObject：命中顶层同名键对象体', () => {
    const r = locateTopLevelKeyObject(HOST, 'utoopack')
    expect(r).not.toBeNull()
    expect(HOST.slice((r as { start: number; end: number }).start, (r as { start: number; end: number }).end + 1)).toBe('{}')
  })
  it('locateTopLevelKeyObject：无同名键 → null', () => {
    expect(locateTopLevelKeyObject(HOST, 'alias')).toBeNull()
  })
  it('injectIntoKey：root 合并进宿主 utoopack 键内部，不产生第二个同名键', () => {
    const out = injectIntoKey(HOST, 'utoopack', ["root: '../..',"])
    // 同一对象体里 utoopack 键只出现一次
    const utoCount = (out.match(/utoopack/g) ?? []).length
    expect(utoCount).toBe(1)
    expect(out).toContain("root: '../..'")
    expect(out).toContain('/* lpm-inject:start */')
    expect(out).toContain('/* lpm-inject:end */')
  })
  it('injectAdaptation：宿主有 utoopack 键 → 合并（单 utoopack）；alias 无 → 追加', () => {
    const out = injectAdaptation(HOST, '../..', { react: 'D:/h/node_modules/react' })
    expect((out.match(/utoopack/g) ?? []).length).toBe(1)
    expect((out.match(/alias/g) ?? []).length).toBe(1)
    expect(out).toContain("root: '../..'")
  })
  it('injectAdaptation：宿主无同名键 → 追加新键（与 S13 行为一致）', () => {
    const bare = 'export default defineConfig({\n  antd: {}\n})\n'
    const out = injectAdaptation(bare, '../..', { react: 'D:/h/node_modules/react' })
    expect((out.match(/utoopack/g) ?? []).length).toBe(1)
    expect((out.match(/alias/g) ?? []).length).toBe(1)
  })
  it('removeFragment：合并+追加双标记段一次摘除，宿主键保留原内容', () => {
    const out = injectAdaptation(HOST, '../..', { react: 'D:/h/node_modules/react' })
    expect(findAllMarkers(out).length).toBe(2) // utoopack 合并段 + alias 追加段
    const restored = removeFragment(out)
    expect(restored).not.toContain('lpm-inject')
    expect(restored).not.toContain("root: '../..'")
    expect(restored).toContain('utoopack: {}') // 宿主原键原样保留
    expect(restored).toContain('antd: {}')
  })
  it('inject(uninit) 往返：合并模式 byte 恒等（宿主无尾逗号 + 单键合并）', () => {
    const src = 'export default defineConfig({\n  utoopack: {}\n})\n'
    const out = injectAdaptation(src, '../..', {})
    expect(removeFragment(out)).toBe(src)
  })
})
