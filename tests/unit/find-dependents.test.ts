import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ManifestParseError,
  findDependents,
  loadWorkspace,
  type Workspace,
} from '../../src/core/workspace.js'

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))

describe('findDependents（spec §4.6）', () => {
  it('三段命中 + 多成员 + 成员序（monorepo-pnpm golden）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    const hits = await findDependents(ws, '@fixture/shared')
    expect(hits).toEqual([
      {
        manifestPath: path.join(ws.rootDir, 'package.json'),
        section: 'dependencies',
        currentValue: '^0.1.0',
      },
      {
        manifestPath: path.join(ws.rootDir, 'docs', 'package.json'),
        section: 'optionalDependencies',
        currentValue: '^0.3.0',
      },
      {
        manifestPath: path.join(ws.rootDir, 'packages', 'server', 'package.json'),
        section: 'devDependencies',
        currentValue: '^0.2.0',
      },
    ])
  })

  it('peerDependencies 不产出 hit（§4.6）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(await findDependents(ws, '@fixture/peer-thing')).toEqual([])
  })

  it('空/缺段合法 → 无 hit', async () => {
    const ws = await loadWorkspace(FIX('single-package'))
    expect(await findDependents(ws, '@fixture/shared')).toEqual([])
  })

  it('坏 manifest → 传播 ManifestParseError（§4.6 不静默跳过；手工构造 ws）', async () => {
    const dir = FIX('broken-bad-json')
    const ws: Workspace = {
      rootDir: dir,
      manifestFormat: 'single',
      members: [
        {
          dir,
          manifestPath: path.join(dir, 'package.json'),
          name: '',
          isRoot: true,
        },
      ],
    }
    const err = await findDependents(ws, 'x').catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
  })

  it('currentValue 为字面量原样（含非常规 range）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm'))
    expect(await findDependents(ws, '@fixture/none')).toEqual([])
    const hits = await findDependents(ws, '@fixture/x')
    expect(hits).toEqual([{ manifestPath: path.join(ws.rootDir, 'packages', 'a', 'package.json'), section: 'dependencies', currentValue: 'workspace:*' }])
  })
})
