import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { InstallError, buildInstallCommand, buildInstallCommandLine, detectLibPM, pmExecutable, runInstall, spawnBuildWatch } from '../../src/core/install.js'

const dirs: string[] = []
function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-inst-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return dir
}
afterEach(() => {
  vi.mocked(execa).mockReset()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('buildInstallCommand（spec §2 裁决 3 单源表）', () => {
  it('T3-1：四 PM 全表', () => {
    expect(buildInstallCommand('pnpm')).toEqual(['install', '--no-frozen-lockfile'])
    expect(buildInstallCommand('npm')).toEqual(['install'])
    expect(buildInstallCommand('yarn-classic')).toEqual(['install', '--no-frozen-lockfile'])
    expect(buildInstallCommand('yarn-berry')).toEqual(['install', '--no-immutable'])
  })
})

describe('detectLibPM（lib 目录 lockfile 探测）', () => {
  it('T3-2：pnpm-lock / package-lock / 无证据回退 npm', () => {
    expect(detectLibPM(makeDir({ 'pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(detectLibPM(makeDir({ 'package-lock.json': '' }))).toBe('npm')
    expect(detectLibPM(makeDir())).toBe('npm')
  })
  it('T3-3：yarn 细分——.yarnrc.yml → berry；裸 yarn.lock → classic', () => {
    expect(detectLibPM(makeDir({ 'yarn.lock': '', '.yarnrc.yml': '' }))).toBe('yarn-berry')
    expect(detectLibPM(makeDir({ 'yarn.lock': '# yarn lockfile v1\n' }))).toBe('yarn-classic')
  })
})

describe('runInstall', () => {
  it('T3-4：成功——execa 以根目录 + stdio 管道形态调用（计划期修订 2）', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runInstall(dir, 'pnpm')
    expect(execa).toHaveBeenCalledWith('pnpm', ['install', '--no-frozen-lockfile'], { cwd: dir, stdio: ['inherit', 'inherit', 'pipe'] })
  })
  it('T3-5：失败 → InstallError（command/exitCode/stderrTail/文案含「state 已保留」）', async () => {
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom line' })
    try {
      await runInstall(makeDir(), 'npm')
      expect.unreachable()
    } catch (e) {
      const err = e as InstallError
      expect(err).toBeInstanceOf(InstallError)
      expect(err.command).toBe('npm install')
      expect(err.exitCode).toBe(1)
      expect(err.stderrTail).toBe('boom line')
      expect(err.message).toContain('state 已保留')
      expect(err.message).toContain('可抛弃重建')
    }
  })
})

describe('spawnBuildWatch', () => {
  it('T3-6：spawn 参数 / pid 透传 / kill 转发 / failure 正常退出为 null', async () => {
    const dir = makeDir()
    const fakeChild = {
      pid: 4321,
      kill: vi.fn(),
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0 }).then(onF, onR),
    }
    vi.mocked(execa).mockReturnValue(fakeChild as never)
    const w = spawnBuildWatch(dir, 'yarn-berry')
    expect(execa).toHaveBeenCalledWith('yarn', ['run', 'build:watch'], { cwd: dir, stdio: 'inherit', reject: false })
    expect(w.pid).toBe(4321)
    w.kill()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(w.failure).resolves.toBeNull()
    await expect(w.exited).resolves.toBeUndefined()
  })
  it('T3-7：spawn 失败（reject:false 以 Error 实例 resolve，Task 3 评审 I-1）→ failure 携带 shortMessage', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({
      failed: true,
      exitCode: undefined,
      shortMessage: 'Command failed with ENOENT: pnpm run build:watch',
    } as never)
    const w = spawnBuildWatch(dir, 'pnpm')
    await expect(w.failure).resolves.toMatchObject({ message: 'Command failed with ENOENT: pnpm run build:watch' })
    await expect(w.exited).resolves.toBeUndefined()
  })

  it('T3-8：PM 逻辑 id → 可执行名映射（OCR O1）', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runInstall(dir, 'yarn-classic')
    expect(execa).toHaveBeenCalledWith('yarn', ['install', '--no-frozen-lockfile'], { cwd: dir, stdio: ['inherit', 'inherit', 'pipe'] })
    const fakeChild = {
      pid: 1,
      kill: vi.fn(),
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0 }).then(onF, onR),
    }
    vi.mocked(execa).mockReturnValue(fakeChild as never)
    spawnBuildWatch(dir, 'yarn-berry')
    expect(execa).toHaveBeenCalledWith('yarn', ['run', 'build:watch'], { cwd: dir, stdio: 'inherit', reject: false })
    expect(pmExecutable('yarn-classic')).toBe('yarn')
    expect(buildInstallCommandLine('yarn-berry')).toBe('yarn install --no-immutable')
  })
})
