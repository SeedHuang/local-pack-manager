import { InstallError } from '../core/install.js'
import type { PackageManagerId } from '../core/pm.js'
import { buildRunTrace, writeRunTrace } from '../state/index.js'
import type { LastRunTrace } from '../state/types.js'

// 失败留痕工厂（S8 OCR 评审 ③）：link / unlink / repair 三处 catch 的失败留痕构造逐字重复，
// 收敛到命令层单源。此处需要 `InstallError` 收窄，故放命令层（**不进 src/state/**，
// 避免 state → core/install 的分层耦合）。`writeRunTrace` 内建吞异常（spec §4.6），此处不再包 try/catch。

/** 把一次失败的原始证据（`InstallError` 的 command/exitCode/stderrTail 等）装配成运行留痕并落盘。
 *  与三命令原 catch 内联块行为逐字等价：非 `InstallError` 时 installs 不追加、failure 字段为空串 / null。 */
export async function traceFailure(
  command: LastRunTrace['command'],
  rootDir: string,
  pm: PackageManagerId,
  changes: LastRunTrace['changes'],
  installs: LastRunTrace['installs'],
  err: unknown,
): Promise<void> {
  const e = err as { command?: string; exitCode?: number | null; stderrTail?: string }
  const isInstall = err instanceof InstallError
  await writeRunTrace(rootDir, buildRunTrace({
    command,
    rootDir,
    packageManager: pm,
    changes,
    installs: isInstall
      ? [...installs, { command: e.command ?? '', ok: false, exitCode: e.exitCode ?? null }]
      : installs,
    failure: {
      command: isInstall ? e.command ?? '' : '',
      exitCode: isInstall ? e.exitCode ?? null : null,
      stderrTail: isInstall ? e.stderrTail ?? '' : '',
      message: err instanceof Error ? err.message : String(err),
    },
  }))
}
