import { execa } from 'execa'
import semver from 'semver'

export class RemoteQueryError extends Error {
  constructor(public pkgName: string, message: string) {
    super(message)
    this.name = 'RemoteQueryError'
  }
}

/** 查 pkg 在 npm 上的 latest dist-tag（spec 裁决 7 + §8 自决 2）：
 *  cwd 让项目 .npmrc 的 registry 生效；超时缺省 15s；stdout 非合法 semver → 错误 */
export async function queryLatestVersion(
  pkgName: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd()
  const timeoutMs = opts.timeoutMs ?? 15000
  let result: { exitCode?: number | null; stdout: string; stderr?: string }
  try {
    result = await execa('npm', ['view', pkgName, 'dist-tags.latest'], {
      cwd,
      timeout: timeoutMs,
      reject: false,
    })
  } catch (err) {
    throw new RemoteQueryError(
      pkgName,
      `查不到 ${pkgName} 在远程仓库的最新版本（npm view 执行失败：${(err as Error).message}）。\n下一步：检查网络与 registry 配置；可手动 npm view ${pkgName} dist-tags.latest 验证`,
    )
  }
  if (result.exitCode !== 0) {
    const errTail = result.stderr !== '' ? `：${(result.stderr ?? '').slice(-500)}` : ''
    throw new RemoteQueryError(
      pkgName,
      `查不到 ${pkgName} 在远程仓库的最新版本（npm view 退出码 ${result.exitCode}${errTail}）。\n下一步：检查网络与 registry 配置；确认包名正确；包未发布过则先发布`,
    )
  }
  const version = result.stdout.trim()
  if (semver.valid(version) === null) {
    throw new RemoteQueryError(
      pkgName,
      `查不到 ${pkgName} 在远程仓库的最新版本（npm view 输出不是合法版本号：${JSON.stringify(version)}）。\n下一步：可手动 npm view ${pkgName} dist-tags.latest 验证`,
    )
  }
  return version
}
