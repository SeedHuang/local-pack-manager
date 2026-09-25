import { describe, expect, it } from 'vitest'
import { matchWorkspacePattern } from '../../src/core/globmatch.js'
import { WorkspacePatternError } from '../../src/core/workspace.js'

const M = (pattern: string, relDir: string) => matchWorkspacePattern(pattern, relDir)

describe('受限 glob 语义（spec §5 逐条 golden）', () => {
  it('字面量段：精确且大小写敏感', () => {
    expect(M('docs', 'docs')).toBe(true)
    expect(M('docs', 'docs/site')).toBe(false)
    expect(M('Docs', 'docs')).toBe(false)
  })

  it('单段 *（spec §5 表）', () => {
    expect(M('packages/*', 'packages/server')).toBe(true)
    expect(M('packages/*', 'packages/a/b')).toBe(false)
    expect(M('packages/*', 'packages')).toBe(false)
  })

  it('** 零或多段；a/** 含 a 自身（§5.1）', () => {
    expect(M('packages/**', 'packages')).toBe(true)
    expect(M('packages/**', 'packages/a')).toBe(true)
    expect(M('packages/**', 'packages/a/b')).toBe(true)
    expect(M('packages/**', 'apps/web')).toBe(false)
  })

  it('裸 ** / 裸 *（§5.2/5.3）', () => {
    expect(M('**', 'a')).toBe(true)
    expect(M('**', 'a/b/c')).toBe(true)
    expect(M('*', 'a')).toBe(true)
    expect(M('*', 'a/b')).toBe(false)
  })

  it('规范化：反斜杠与尾随斜杠（§5 输入规范化）', () => {
    expect(M('packages\\*', 'packages/server')).toBe(true)
    expect(M('packages/*/', 'packages/server')).toBe(true)
    expect(M('packages\\**', 'packages/a')).toBe(true)
  })

  it('负模式由调用方剥离：匹配器按剥离后的内容匹配（§5 表）', () => {
    expect(M('!packages/legacy', 'packages/legacy')).toBe(true)
  })

  it('不支持语法逐一抛 WorkspacePatternError（§5.8；\\ 已按分隔符规范化故不在列）', () => {
    for (const bad of ['pkg?', 'pkg[ab]', 'pkg-{a,b}', 'pkg+(x)', 'pkg@(x)', 'app*', 'a**b', 'a//b', '', '!']) {
      expect(() => M(bad, 'x')).toThrow(WorkspacePatternError)
    }
  })
})
