import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceNotFoundError, findWorkspaceRoot } from '../../src/core/workspace.js'

// node:fs 为 ESM 外置模块，其命名空间属性不可配置，无法直接 vi.spyOn（vitest 抛
// "Module namespace is not configurable in ESM"）。按 vitest 官方建议以 vi.mock 对本测试
// 模块图整体替换：readFileSync/statSync 等逐项保留真实实现，existsSync 换成默认委托真实
// 实现的 vi.fn（workspace.ts 与本测试同图，故其具名导入同样命中该 mock）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))

afterEach(() => vi.restoreAllMocks())

describe('findWorkspaceRoot（spec §4.4）', () => {
  it('monorepo 内子包 cwd → workspace 根（§4.4.2）', async () => {
    const root = await findWorkspaceRoot(path.join(FIX('monorepo-pnpm'), 'packages', 'server'))
    expect(path.resolve(root)).toBe(path.resolve(FIX('monorepo-pnpm')))
  })

  it('单包 cwd → 自身（§4.4.5 fallback）', async () => {
    // 本仓库根自身含 pnpm-workspace.yaml，会污染 fixture 之上的真实祖先链；
    // 以 existsSync 白名单隔离：仅 fixture 根与其 package.json 可见，上层一律不可见
    const base = FIX('single-package')
    const spy = vi.mocked(fs.existsSync)
    spy.mockImplementation((p) => {
      const s = String(p)
      return s === base || s === path.join(base, 'package.json')
    })
    try {
      const root = await findWorkspaceRoot(base)
      expect(path.resolve(root)).toBe(path.resolve(base))
    } finally {
      spy.mockRestore()
    }
  })

  it('cwd 在无 package.json 的中间目录，标记在上层（§4.4.2）', async () => {
    const root = await findWorkspaceRoot(path.join(FIX('monorepo-pnpm'), 'packages'))
    expect(path.resolve(root)).toBe(path.resolve(FIX('monorepo-pnpm')))
  })

  it('startDir 不存在 → start-dir-missing（§6.1）', async () => {
    const p = path.join(FIX('single-package'), 'no-such-dir')
    const err = await findWorkspaceRoot(p).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspaceNotFoundError)
    expect((err as WorkspaceNotFoundError).kind).toBe('start-dir-missing')
    expect((err as Error).message).toContain('路径不存在')
  })

  it('盘根无任何标记与 package.json → root-not-found（§6.2；fs spy 隔离祖先链）', async () => {
    const spy = vi.mocked(fs.existsSync)
    spy.mockImplementation((p) => p === os.tmpdir())
    try {
      const err = await findWorkspaceRoot(os.tmpdir()).catch((e) => e)
      expect(err).toBeInstanceOf(WorkspaceNotFoundError)
      expect((err as WorkspaceNotFoundError).kind).toBe('root-not-found')
      expect((err as Error).message).toContain('未找到项目根')
    } finally {
      spy.mockRestore()
    }
  })
})
