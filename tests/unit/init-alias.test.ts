import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InitHostPkgError, buildAliasMap } from '../../src/core/utoopack.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-al-'))
  dirs.push(dir)
  for (const [n, c] of Object.entries(files)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}
function pkg(body: Record<string, unknown>): string { return JSON.stringify(body) }

describe('buildAliasMap（spec §4.5 peer dedupe）', () => {
  it('lib peer ∩ 宿主直接依赖 → 宿主实例绝对路径（正斜杠）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0', react: '^18.0.0' } }),
      'node_modules/antd/index.js': '// ok',
      'node_modules/react/index.js': '// ok',
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*', react: '*' } }),
    })
    const alias = buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])
    expect(alias['antd']).toBe(join(dir, 'node_modules', 'antd').replaceAll('\\', '/'))
    expect(alias['react']).toBe(join(dir, 'node_modules', 'react').replaceAll('\\', '/'))
  })
  it('空交集 → {}', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { vue: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
  it('lib 无 peerDependencies → 空', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a' }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
  it('宿主 package.json 缺失 → InitHostPkgError', () => {
    const dir = makeDir({ 'libs/a/package.json': pkg({ name: 'a' }) })
    expect(() => buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toThrow(InitHostPkgError)
  })
  it('peer 已在宿主 node_modules 存在 → 取 cwd 路径（探测顺序 1）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'node_modules/antd/index.js': '// ok',
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])['antd']).toBe(join(dir, 'node_modules', 'antd').replaceAll('\\', '/'))
  })
  it('peer 仅存在 workspace 根 node_modules（hoist 落点）→ 取 rootDir 路径（探测顺序 2）', () => {
    const root = makeDir({
      'package.json': pkg({ name: 'root', workspaces: ['apps/*', 'libs/*'] }),
      'apps/web/package.json': pkg({ name: 'web', dependencies: { antd: '^5.0.0' } }),
      'node_modules/antd/index.js': '// ok',
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    const cwd = join(root, 'apps', 'web')
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    const alias = buildAliasMap(cwd, root, [join(root, 'libs', 'a')])
    expect(alias['antd']).toBe(join(root, 'node_modules', 'antd').replaceAll('\\', '/'))
  })
  it('两者皆无 → 跳过该 peer（不进 alias）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
})
