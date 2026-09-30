import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { RemoteQueryError, queryLatestVersion } from '../../src/core/remote.js'

afterEach(() => {
  vi.mocked(execa).mockReset()
})

describe('queryLatestVersion（spec §6 remote 面）', () => {
  it('正常输出：trim 后返回合法版本号', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: '1.2.0\n', stderr: '' } as never)
    await expect(queryLatestVersion('@t/lib', { cwd: 'D:/p' })).resolves.toBe('1.2.0')
    expect(execa).toHaveBeenCalledWith('npm', ['view', '@t/lib', 'dist-tags.latest'], { cwd: 'D:/p', timeout: 15000, reject: false })
  })
  it('非零退出码 → RemoteQueryError（含 pkgName 与包名提示）', async () => {
    vi.mocked(execa).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'npm ERR! code E404' } as never)
    await expect(queryLatestVersion('not-exists')).rejects.toMatchObject({ name: 'RemoteQueryError', pkgName: 'not-exists' })
    await expect(queryLatestVersion('not-exists')).rejects.toThrow(/E404/)
  })
  it('stdout 非合法 semver（空串 / foo / 1.2）→ RemoteQueryError', async () => {
    for (const out of ['', 'foo', '1.2']) {
      vi.mocked(execa).mockResolvedValue({ exitCode: 0, stdout: out, stderr: '' } as never)
      await expect(queryLatestVersion('pkg')).rejects.toBeInstanceOf(RemoteQueryError)
    }
  })
  it('execa 抛错（超时 / spawn 失败）→ RemoteQueryError', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('Command timed out after 15000ms'))
    await expect(queryLatestVersion('pkg')).rejects.toBeInstanceOf(RemoteQueryError)
  })
})
