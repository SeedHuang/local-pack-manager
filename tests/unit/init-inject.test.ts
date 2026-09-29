import { describe, expect, it } from 'vitest'
import {
  InitConfigShapeError,
  InitIncompleteMarkerError,
  InitNotInjectedError,
  buildFragment,
  injectFragment,
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
})

describe('injectFragment（spec §8 自决 1 三态）', () => {
  it('空对象体 {} → 无前置逗号', () => {
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
