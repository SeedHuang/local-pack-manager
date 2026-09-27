import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibCheckError, checkLib } from '../../src/core/linkcheck.js'

const dirs: string[] = []
function makeLib(files: Record<string, string> = {}, extra: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-check-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  extra(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const OK_MANIFEST = JSON.stringify({ name: '@t/lib', main: './index.js', scripts: { 'build:watch': 'echo' } })

describe('checkLib（S6 spec §4.4 C 七 kind 正反）', () => {
  it('T2-1 dir-missing：目录不存在', () => {
    expect(() => checkLib(join('Z:', 'no-such-dir-xyz'))).toThrowError(LibCheckError)
    try {
      checkLib(join('Z:', 'no-such-dir-xyz'))
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('dir-missing')
      expect((e as Error).message).toContain('路径不存在')
    }
  })

  it('T2-2 dir-missing：路径是文件非目录', () => {
    const dir = makeLib({ 'file.txt': 'x' })
    expect(() => checkLib(join(dir, 'file.txt'))).toThrowError(LibCheckError)
  })

  it('T2-3 manifest-missing：目录无 package.json', () => {
    const dir = makeLib()
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('manifest-missing')
      expect((e as Error).message).toContain('不是 npm 包')
    }
  })

  it('T2-4 manifest-invalid：坏 JSON', () => {
    const dir = makeLib({ 'package.json': '{oops' })
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('manifest-invalid')
    }
  })

  it('T2-5 manifest-invalid：BOM + 坏 JSON（剥 BOM 后仍坏）', () => {
    const dir = makeLib({ 'package.json': '\uFEFF{oops' })
    expect(() => checkLib(dir)).toThrowError(LibCheckError)
  })

  it('T2-6 name-mismatch：expectedName 传入且 lib name 不等（B7）', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    try {
      checkLib(dir, { expectedName: '@t/old-name' })
      expect.unreachable()
    } catch (e) {
      const err = e as LibCheckError
      expect(err.kind).toBe('name-mismatch')
      expect(err.message).toContain('请更新 lpm.config.json')
    }
  })

  it('T2-7 name 一致通过', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir, { expectedName: '@t/lib' }).name).toBe('@t/lib')
  })

  it('T2-8 name 空串跳过一致性', () => {
    const dir2 = makeLib({ 'package.json': JSON.stringify({ main: './index.js' }), 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir2, { expectedName: 'whatever' }).name).toBe('')
  })

  it('T2-9 entry-missing：main 指向缺失文件', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'node_modules/.keep': '' })
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('entry-missing')
      expect((e as Error).message).toContain('先 build')
    }
  })

  it('T2-10 entry-missing：exports.default 指向缺失文件', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { default: './dist/x.js' } } }),
      'node_modules/.keep': '',
    })
    expect(() => checkLib(dir)).toThrowError(LibCheckError)
  })

  it('T2-11 通过：main 存在', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir).manifestPath).toBe(join(dir, 'package.json'))
  })

  it('T2-12 通过：exports.import 存在', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { import: './esm/x.js' } } }),
      'esm/x.js': '',
      'node_modules/.keep': '',
    })
    expect(checkLib(dir).name).toBe('@t/lib')
  })

  it('T2-13 豁免：无 exports 无 main', () => {
    const dir = makeLib({ 'package.json': JSON.stringify({ name: '@t/lib' }), 'node_modules/.keep': '' })
    expect(checkLib(dir).name).toBe('@t/lib')
  })

  it('T2-14 豁免：exports 仅 types', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { types: './x.d.ts' } } }),
      'node_modules/.keep': '',
    })
    expect(() => checkLib(dir)).not.toThrowError()
  })

  it('T2-15 node-modules-empty：目录不存在 / readdir 空；非空通过', () => {
    const a = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '' })
    expect(() => checkLib(a)).toThrowError(/node_modules 为空/)
    const b = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(() => checkLib(b)).not.toThrowError()
  })

  it('T2-16 watch-script-missing：缺 script / 非串；有则通过', () => {
    const a = makeLib({ 'package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }), 'index.js': '', 'node_modules/.keep': '' })
    try {
      checkLib(a, { expectWatchScript: true })
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('watch-script-missing')
    }
    const b = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(() => checkLib(b, { expectWatchScript: true })).not.toThrowError()
  })

  it('T2-17 entry-missing：exports 顶层条件简写（无 . 键）→ 检查生效（OCR O9）', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { import: './dist/missing.js' } }),
      'node_modules/.keep': '',
    })
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('entry-missing')
    }
  })
})
