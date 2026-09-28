import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeNodeModules } from '../../src/core/nmcheck.js'

const dirs: string[] = []
function mk(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-nmc-'))
  dirs.push(dir)
  for (const f of files) {
    const p = join(dir, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '', 'utf8')
  }
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('probeNodeModules', () => {
  it('NMC-1：实体目录 → entity', () => {
    const ws = mk(['apps/web/package.json', 'apps/web/node_modules/@t/lib/index.js'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('entity')
  })
  it('NMC-2：链接指向期望库 → link-to-lib', () => {
    const ws = mk(['apps/web/package.json', 'lib/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules/@t'), { recursive: true })
    symlinkSync(join(ws, 'lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('link-to-lib')
    expect(r.realTarget).toBe(join(ws, 'lib'))
  })
  it('NMC-3：链接指向他处 → link-elsewhere', () => {
    const ws = mk(['apps/web/package.json', 'lib/package.json', 'other/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules/@t'), { recursive: true })
    symlinkSync(join(ws, 'other'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('link-elsewhere')
  })
  it('NMC-4：悬空链接 → dangling + note 悬空链接', () => {
    const ws = mk(['apps/web/package.json', 'gone/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules/@t'), { recursive: true })
    symlinkSync(join(ws, 'gone'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    rmSync(join(ws, 'gone'), { recursive: true, force: true })
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('dangling')
    expect(r.note).toBe('悬空链接')
  })
  it('NMC-5：条目不存在 → missing', () => {
    const ws = mk(['apps/web/package.json'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('missing')
    expect(r.note).toBeUndefined()
  })
  it('NMC-6：条目存在但期望库不可解析 → unknown + note 注册缺失/库已删，无法比对指向', () => {
    const ws = mk(['apps/web/package.json', 'apps/web/node_modules/@t/lib/index.js'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('unknown')
    expect(r.note).toBe('注册缺失/库已删，无法比对指向')
  })
  it('NMC-7：祖先目录是 junction 时，真实实体目录仍判 entity（不误判为链接）', () => {
    // <tmp>/real 为真实目录；<tmp>/link 为指向它的 junction——模拟被软链的项目目录（macOS /var→/private/var 同型）。
    // 父目录 <tmp> 已存在；不可先建 link 自身（否则 junction 创建报 EEXIST）
    const ws = mk(['real/apps/web/package.json', 'real/apps/web/node_modules/@t/lib/index.js'])
    symlinkSync(join(ws, 'real'), join(ws, 'link'), 'junction')
    // expectedLibReal 传一个与之无关的路径：修复前实体经 realpath 后 != 字面路径 → 误判 link-elsewhere；
    // 修复后只比较「父目录 canonical + 文件名」，最终组件非链接 → entity
    const r = probeNodeModules(join(ws, 'link', 'apps', 'web', 'package.json'), '@t/lib', join(ws, 'some-other-lib'))
    expect(r.status).toBe('entity')
  })
})
