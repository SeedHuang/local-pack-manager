import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { subdivideYarn, type PackageManagerId } from './pm.js'

// install/watch 子进程构造（S6 spec §4.3 + §2 裁决 2/3）。core 不依赖 state（S1 §3 分层）。

/** per-PM install 参数单源表（§2 裁决 3）：全部显式关闭冻结，本地/CI 行为一致 */
const INSTALL_ARGS_BY_PM: Record<PackageManagerId, readonly string[]> = {
  pnpm: ['install', '--no-frozen-lockfile'],
  npm: ['install'],
  'yarn-classic': ['install', '--no-frozen-lockfile'],
  'yarn-berry': ['install', '--no-immutable'],
}

/** PM 逻辑 id → 可执行文件名（OCR O1：yarn-classic/yarn-berry 无同名可执行文件） */
const PM_BINARY: Record<PackageManagerId, string> = {
  pnpm: 'pnpm',
  npm: 'npm',
  'yarn-classic': 'yarn',
  'yarn-berry': 'yarn',
}

export function buildInstallCommand(pm: PackageManagerId): readonly string[] {
  return [...INSTALL_ARGS_BY_PM[pm]]
}

/** PM 逻辑 id → 可执行文件名（展示与子进程构造共用单源；OCR O1 + 残余①） */
export function pmExecutable(pm: PackageManagerId): string {
  return PM_BINARY[pm]
}

/** 可直接重跑的完整 install 命令行（`<可执行名> install <flags>`）——runInstall 诊断串与 dry-run 计划共用 */
export function buildInstallCommandLine(pm: PackageManagerId): string {
  return `${PM_BINARY[pm]} ${INSTALL_ARGS_BY_PM[pm].join(' ')}`
}

export class InstallError extends Error {
  constructor(
    public command: string,       // 展示用完整命令行
    public exitCode: number | null,
    public stderrTail: string,    // 子进程 stderr 末尾（≤2000 字符）
    message: string,
  ) {
    super(message)
    this.name = 'InstallError'
  }
}

/** 组装 InstallError（S6 #16 修正版结构）：首行诊断 + retryAdvice 建议行 */
function installError(command: string, exitCode: number | null, stderrTail: string, advice: string): InstallError {
  return new InstallError(
    command,
    exitCode,
    stderrTail,
    `install 失败（exit ${exitCode ?? '未知'}）：${stderrTail !== '' ? stderrTail : command}\n下一步：${advice}`,
  )
}

/** 默认建议（S6 #16 修正版 link 向文案——link 调用零改动；裁决 7） */
function linkRetryAdvice(command: string): string {
  return `state 已保留，重跑 lpm link 会幂等跳过（E1）——重试：修复报错后在 workspace 根重跑一次 ${command}；若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建`
}

/** install 子进程共通执行体（runInstall / runForceInstall 单源——OCR O1 精神：execa 细节不出本文件） */
async function execInstall(binary: string, args: readonly string[], rootDir: string, command: string, advice: string): Promise<void> {
  try {
    await execa(binary, [...args], { cwd: rootDir, stdio: ['inherit', 'inherit', 'pipe'] })
  } catch (err) {
    const e = err as { exitCode?: number | null; stderr?: string | undefined }
    const stderrTail = (e.stderr ?? '').slice(-2000)
    throw installError(command, e.exitCode ?? null, stderrTail, advice)
  }
}

/** 单次 install（workspace 根执行，stdio 继承透传输出——禁止死屏）；失败抛 InstallError。
 *  retryAdvice（S7 裁决 7）：可选建议文案；缺省 = link 向文案 */
export async function runInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void> {
  const command = buildInstallCommandLine(pm)
  await execInstall(PM_BINARY[pm], buildInstallCommand(pm), rootDir, command, retryAdvice ?? linkRetryAdvice(command))
}

/** `--force` 重建（S7 F3：pnpm "Already up to date" 软链残留重建）；失败抛 InstallError（advice 由调用方传 unlink 向文案） */
export async function runForceInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void> {
  const command = buildForceInstallCommandLine(pm)
  await execInstall(PM_BINARY[pm], buildForceInstallCommand(pm), rootDir, command, retryAdvice ?? linkRetryAdvice(command))
}

/** `--force` 重建参数（四 PM 同形 `install --force`，无 per-PM 表——YAGNI；参数保留仅为与
 *  buildInstallCommand 签名对称）。注意：**故意未叠加**常规路径的防冻结 flag
 *  （pnpm/yarn-classic `--no-frozen-lockfile`、yarn-berry `--no-immutable`）。
 *  若未来出现「CI 冻结配置下 --force 重建失败」的真实信号，在此函数内按 PM 分支补齐，
 *  勿新建第二份表（OCR 建议；参数行为变更需先评估再动）。 */
export function buildForceInstallCommand(_pm: PackageManagerId): readonly string[] {
  return ['install', '--force']
}

export function buildForceInstallCommandLine(pm: PackageManagerId): string {
  return `${PM_BINARY[pm]} ${buildForceInstallCommand(pm).join(' ')}`
}

/** lib 自身 PM 探测（§2 裁决 2）：lib 目录 lockfile——pnpm-lock→pnpm；yarn.lock→subdivideYarn；
 *  package-lock→npm；无证据 → 'npm'（回退）；多 lockfile 共存按 pnpm-lock > yarn.lock > package-lock
 *  首个命中（对齐 S3 LOCKFILE_ORDER 探测精神） */
export function detectLibPM(libDirAbs: string): PackageManagerId {
  if (existsSync(join(libDirAbs, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(libDirAbs, 'yarn.lock'))) return subdivideYarn(libDirAbs)
  if (existsSync(join(libDirAbs, 'package-lock.json'))) return 'npm'
  return 'npm'
}

export interface WatchProcess {
  pid: number
  exited: Promise<void>
  kill: () => void
  /** resolve 为子进程失败原因（spawn 失败/非零退出/异常信号）；正常退出与非错误终止（Ctrl+C/kill——H5）→ null——H7 警告数据源（计划期修订 3） */
  failure: Promise<unknown | null>
}

/** 拉起 lib 的 build:watch 子进程：<pm> run build:watch，cwd=libDir，stdio 继承，前台。
 *  前置检查已保证 script 存在；调用方经 exited 驻留、kill 终止、failure 出警告（§4.4 H） */
export function spawnBuildWatch(libDirAbs: string, pm: PackageManagerId): WatchProcess {
  const child = execa(PM_BINARY[pm], ['run', 'build:watch'], { cwd: libDirAbs, stdio: 'inherit', reject: false })
  let killed = false
  const outcome = child.then(
    (r) => {
      if (r.exitCode === 0) return null
      // H5：Ctrl+C / kill() 终止 = 非错误退出，不告警。Windows 无跨进程 signal
      //（kill() → TerminateProcess → exit 1），故先看 killed 标记；POSIX Ctrl+C 经
      // SIGINT/SIGTERM 判定（SIGSEGV 等异常信号仍视为失败）。
      if (killed) return null
      if (r.signal === 'SIGINT' || r.signal === 'SIGTERM') return null
      // execa ^10 reject:false：spawn 失败（ENOENT 等）以 ExecaError 实例 resolve 而非 reject
      //（Task 3 评审 I-1）——优先取 shortMessage 携带原始 cause，防 H7 警告原因串降级为 'exit undefined'
      const e = r as { shortMessage?: string; message?: string }
      return new Error(e.shortMessage ?? e.message ?? `exit ${r.exitCode}`)
    },
    (err) => err,
  )
  const exited = outcome.then(
    () => undefined,
    () => undefined,
  )
  return {
    pid: child.pid ?? -1,
    exited,
    kill: () => {
      killed = true
      void child.kill('SIGTERM')
    },
    failure: outcome,
  }
}
