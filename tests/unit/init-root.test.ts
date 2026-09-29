import { describe, expect, it } from 'vitest'
import { InitRootError, buildRootValue, commonAncestor, toRelSlashes } from '../../src/core/utoopack.js'

describe('commonAncestor（spec §4.4）', () => {
  it('多路径同盘 → 最近公共目录', () => {
    expect(commonAncestor(['D:/app/libs/a', 'D:/app/libs/b'])).toBe('D:/app/libs')
    expect(commonAncestor(['D:/app/libs/a', 'D:/app/apps/web'])).toBe('D:/app')
  })
  it('单路径 → 其父目录', () => {
    expect(commonAncestor(['D:/app/libs/a'])).toBe('D:/app/libs')
  })
  it('跨盘符（无公共祖先）→ 行为锁定为「返回各自盘符根中最长的公共前缀」（Windows 语义）', () => {
    // 实现约定：跨盘符 → 逐段比较至盘符不同 → 返回空串；测试锁死该约定
    expect(commonAncestor(['C:/a/x', 'D:/a/y'])).toBe('')
  })
})

describe('toRelSlashes（spec §4.4 跨盘符护栏）', () => {
  it('同级 → .', () => {
    expect(toRelSlashes('D:/app', 'D:/app')).toBe('.')
  })
  it('上级 → ../..', () => {
    expect(toRelSlashes('D:/app/apps/web', 'D:/app')).toBe('../..')
  })
  it('正斜杠输出', () => {
    expect(toRelSlashes('D:\\app\\apps\\web', 'D:\\app')).toBe('../..')
  })
  it('Windows 跨盘符 → InitRootError', () => {
    expect(() => toRelSlashes('D:/app', 'C:/lib')).toThrow(InitRootError)
    expect(() => toRelSlashes('D:/app', 'C:/lib')).toThrow('无法计算 utoopack.root')
  })
})

describe('buildRootValue（spec §4.5 root 公式）', () => {
  it('宿主 + 多 lib 的公共祖先 → 相对宿主路径', () => {
    expect(buildRootValue('D:/app/apps/web', ['D:/app/libs/a', 'D:/app/libs/b'])).toBe('../..')
  })
  it('宿主与 lib 同目录 → .', () => {
    expect(buildRootValue('D:/app', ['D:/app/libs/a'])).toBe('.')
  })
  it('跨盘符 → InitRootError', () => {
    expect(() => buildRootValue('D:/app', ['C:/libs/a'])).toThrow(InitRootError)
  })
})
