import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  loadWorkspace,
  type Workspace,
} from '../../src/core/workspace.js'

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))
const rels = (ws: Workspace) =>
  ws.members.map((m) => path.relative(ws.rootDir, m.dir).replaceAll('\\', '/'))

describe('loadWorkspace（spec §4.5）', () => {
  it('pnpm 块列表+引号+排除+catalog 同存：golden 序 + 双标记 pnpm 优先', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.manifestFormat).toBe('pnpm-workspace')
    expect(rels(ws)).toEqual(['', 'apps/web', 'docs', 'packages/server'])
    expect(ws.members[0]?.isRoot).toBe(true)
    expect(ws.members[0]?.name).toBe('monorepo-pnpm')
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('legacy'))).toBe(false)
  })

  it('无 packages 键 → 仅 root（§5 YAML.5；本仓库自身同款形态）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-empty-patterns'))
    expect(ws.manifestFormat).toBe('pnpm-workspace')
    expect(ws.members).toHaveLength(1)
    expect(ws.members[0]?.isRoot).toBe(true)
  })

  it('npm 数组 form', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(rels(ws)).toEqual(['', 'packages/a', 'packages/b'])
  })

  it('npm 对象 form（yarn classic { packages }）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm-object'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(rels(ws)).toEqual(['', 'apps/one'])
  })

  it('空数组 workspaces → 仅 root（§4.4.3 含空数组算标记）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm-empty'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(ws.members).toHaveLength(1)
  })

  it('single', async () => {
    const ws = await loadWorkspace(FIX('single-package'))
    expect(ws.manifestFormat).toBe('single')
    expect(ws.members).toHaveLength(1)
  })

  it('node_modules / 点目录永不入选，即使 pattern 意图覆盖（§5.4/5.5）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('node_modules'))).toBe(false)
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('.hidden'))).toBe(false)
  })

  it('命中目录无 package.json（apps）时后代仍命中（§4.5.3 继续下钻；由 pnpm golden 的 apps/web 隐含覆盖）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.members.some((m) => m.name === '@fixture/web')).toBe(true)
  })

  it('零命中 → 合法 members=[root]（§2 语义空）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-zero-hit'))
    expect(ws.members).toHaveLength(1)
  })

  it('rootDir 缺 package.json → invalid-root（§6.3）', async () => {
    const err = await loadWorkspace(path.join(FIX('monorepo-pnpm'), 'apps')).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspaceNotFoundError)
    expect((err as WorkspaceNotFoundError).kind).toBe('invalid-root')
    expect((err as Error).message).toContain('不是有效的项目根')
  })

  it('根 manifest 坏 JSON → ManifestParseError（§6.4）', async () => {
    const err = await loadWorkspace(FIX('broken-bad-json')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as ManifestParseError).manifestPath).toBe(path.join(FIX('broken-bad-json'), 'package.json'))
    expect((err as Error).message).toContain('清单解析失败')
  })

  it('成员 manifest 坏 JSON → ManifestParseError（§4.5.3 不静默跳过）', async () => {
    const err = await loadWorkspace(FIX('broken-member-bad-json')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as ManifestParseError).manifestPath).toContain(path.join('pkgs', 'bad', 'package.json'))
  })

  it('坏 YAML → ManifestParseError（§6.5）', async () => {
    const err = await loadWorkspace(FIX('broken-bad-yaml')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as Error).message).toContain('引号不闭合')
  })

  it('非法 pattern → WorkspacePatternError（先整体校验，带 pattern 与清单定位）', async () => {
    const p = FIX('broken-bad-pattern')
    const err = await loadWorkspace(p).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspacePatternError)
    expect((err as WorkspacePatternError).pattern).toBe('pkg-{a,b}')
    expect((err as WorkspacePatternError).manifestPath).toBe(path.join(p, 'package.json'))
    expect((err as Error).message).toContain(`清单：${path.join(p, 'package.json')}`)
  })

  it('根 manifest 带 BOM → 正常解析（§4.2 读取规约）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-bom'))
    expect(ws.members[0]?.name).toBe('monorepo-bom')
  })

  it('根 manifest 为 null 字面量 → ManifestParseError（根值不是 JSON 对象）', async () => {
    const err = await loadWorkspace(FIX('broken-null-root')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as Error).message).toContain('根值不是 JSON 对象')
  })

  it('YAML 列表项 tab 缩进 → ManifestParseError（§5 YAML.6 宁报错不猜测）', async () => {
    const err = await loadWorkspace(FIX('broken-tab-yaml')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as Error).message).toContain('缩进')
  })

  it('packages: 流列表 + 行内注释 → 正常展开', async () => {
    const ws = await loadWorkspace(FIX('packages-comment'))
    expect(ws.manifestFormat).toBe('pnpm-workspace')
    expect(rels(ws)).toEqual(['', 'apps/web'])
  })

  it('packages: 空值 + 行内注释 → 仅 root（§5 YAML.5）', async () => {
    const ws = await loadWorkspace(FIX('packages-comment-empty'))
    expect(ws.members).toHaveLength(1)
  })
})
