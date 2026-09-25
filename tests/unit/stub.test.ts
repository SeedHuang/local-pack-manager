import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS } from '../../src/commands/registry.js'
import { notImplemented } from '../../src/commands/stub.js'

describe('stub 行为', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // process.exitCode 不可 delete（Node 运行时 TypeError），用置空等价清理
    process.exitCode = undefined
  })

  it('任取 2 个命令：stderr 含"尚未实现"与 plannedSpec，且不设非零退出码', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const samples = [COMMANDS[0], COMMANDS[3]] // use + status

    for (const meta of samples) {
      stderr.mockClear()
      notImplemented(meta)
      const out = stderr.mock.calls.map((c) => String(c[0])).join('')
      expect(out).toContain(`lpm ${meta.name} 尚未实现`)
      expect(out).toContain(meta.plannedSpec)
      expect(out).toContain('lpm --help')
    }
    expect(process.exitCode ?? 0).toBe(0)
  })
})
