import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { LastRunTrace, LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types.js'
import { writeJsonFileAtomic } from './atomic.js'

/** lpm.config.json 不是合法 JSON/结构无效（S3 引入；深层最小校验由 S4 补——S4 spec §4.4 规约 5–7） */
export class LpmConfigParseError extends Error {
  constructor(public configPath: string, message: string) {
    super(message)
    this.name = 'LpmConfigParseError'
  }
}

/** .lpm/state.json、.lpm/last.json、~/.lpm/config.json 不是合法 JSON/结构无效
 *  （S4 引入；与 LpmConfigParseError 分域——S4 spec §4.4 规约 7） */
export class LpmStateParseError extends Error {
  constructor(public filePath: string, message: string) {
    super(message)
    this.name = 'LpmStateParseError'
  }
}

function configPathOf(rootDir: string): string {
  return join(rootDir, 'lpm.config.json')
}

function statePathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'state.json')
}

function lastPathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'last.json')
}

function userConfigPath(): string {
  return join(homedir(), '.lpm', 'config.json')
}

/** 读 lpm JSON 文件共通规约（S4 spec §4.4 读取共通规约）：
 *  剥行首 UTF-8 BOM → JSON.parse → 非对象判定 → 顶层字段最小校验 → version 校验；
 *  错误类经 errOf 分域（config → LpmConfigParseError，state/last/user → LpmStateParseError）。
 *  S3 readProjectConfig 行为保持 + 增强：坏 JSON/非对象文案统一为「lpm 状态/配置文件」措辞
 *  （计划期修订 3，14d 断言不受影响；S3 spec §6.5 #5 随 Task 4 回写）。 */
function readLpmJson(
  filePath: string,
  raw: string,
  fieldChecks: Array<{ field: string; kind: 'object' | 'array' }>,
  errOf: (filePath: string, message: string) => Error,
): Record<string, unknown> {
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw errOf(
      filePath,
      `${filePath} 不是合法 JSON（${(err as Error).message}）。\n下一步：可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw errOf(
      filePath,
      `${filePath} 不是合法的 lpm 状态/配置文件（应为 JSON 对象）。\n下一步：可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  const obj = parsed as Record<string, unknown>
  for (const { field, kind } of fieldChecks) {
    const v = obj[field]
    const ok =
      kind === 'object'
        ? typeof v === 'object' && v !== null && !Array.isArray(v)
        : Array.isArray(v)
    if (!ok) {
      throw errOf(
        filePath,
        `${filePath} 的 ${field} 应为${kind === 'object' ? '对象' : '数组'}。\n下一步：可修复或直接删除该文件——lpm 状态可抛弃重建`,
      )
    }
  }
  if (obj.version !== undefined && obj.version !== 1) {
    throw errOf(
      filePath,
      `${filePath} 版本 ${String(obj.version)} 不受支持（当前仅 version: 1）。\n下一步：可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  return obj
}

/** S3 提前实现（S3 spec §4.6）+ S4 深层校验增强（F1/F2 闭环）：缺失 → null；坏 JSON/非对象/字段校验失败 → LpmConfigParseError */
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  const p = configPathOf(rootDir)
  if (!existsSync(p)) return null
  const parsed = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'libs', kind: 'object' }],
    (fp, msg) => new LpmConfigParseError(fp, msg),
  )
  return parsed as unknown as ProjectLpmConfig
}

/** S3 提前实现（S3 spec §4.6）：原子写（PRD §9） */
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  writeJsonFileAtomic(configPathOf(rootDir), cfg)
}

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——S4 实现（spec §4.4）

export async function readState(rootDir: string): Promise<LinkState | null> {
  const p = statePathOf(rootDir)
  if (!existsSync(p)) return null
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'links', kind: 'object' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as LinkState
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

export async function writeState(rootDir: string, st: LinkState): Promise<void> {
  // 写入前内建 gitignore 防护（spec §2 决策 5，B6 不依赖 S6 记性）；await 保证 fs 失败按正常错误路径传播（OCR O1 修复，2026-09-26）
  await ensureGitignoreEntry(rootDir)
  const p = statePathOf(rootDir)
  ensureParentDir(p)
  writeJsonFileAtomic(p, st)
}

export async function deleteState(rootDir: string): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）；force 缺失幂等；只删 state.json，不动 last.json 与 .lpm/ 目录
  rmSync(statePathOf(rootDir), { force: true })
}

export async function readLast(rootDir: string): Promise<LastSet | null> {
  const p = lastPathOf(rootDir)
  if (!existsSync(p)) return null
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'names', kind: 'array' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as LastSet
}

export async function writeLast(rootDir: string, last: LastSet): Promise<void> {
  // last.json 仅在 state 存续后才可能被写（.lpm/ 必已存在）——不调 ensureGitignoreEntry（spec §4.4 差异点）；mkdir 幂等仍做
  const p = lastPathOf(rootDir)
  ensureParentDir(p)
  writeJsonFileAtomic(p, last)
}

export async function readUserConfig(): Promise<UserLpmConfig> {
  // 文件缺失 → { version: 1, scanDirs: [] }
  const p = userConfigPath()
  if (!existsSync(p)) return { version: 1, scanDirs: [] }
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'scanDirs', kind: 'array' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as UserLpmConfig
}

export async function writeUserConfig(cfg: UserLpmConfig): Promise<void> {
  // ~/.lpm 不在项目 git 仓库内——无 gitignore 逻辑（spec §4.4）
  const p = userConfigPath()
  ensureParentDir(p)
  writeJsonFileAtomic(p, cfg)
}

/** 归一化（S4 spec §4.4）：trim → 循环剥前导 '/' 或 '**/'、剥尾 '/**'、'/*'、'/' 至稳定 → 与 '.lpm' 全等 */
function normalizeGitignoreLine(line: string): string {
  let s = line.trim()
  let prev: string
  do {
    prev = s
    if (s.startsWith('/')) s = s.slice(1)
    if (s.startsWith('**/')) s = s.slice(3)
    if (s.endsWith('/**')) s = s.slice(0, -3)
    else if (s.endsWith('/*')) s = s.slice(0, -2)
    else if (s.endsWith('/') && s.length > 0) s = s.slice(0, -1)
  } while (s !== prev)
  return s
}

export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'> {
  // 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/（PRD §9.5）；.gitignore 为宿主项目文件，
  // 直接 writeFileSync 不入原子写承诺（spec §4.4；追加写坏可由 git 恢复）
  const p = join(rootDir, '.gitignore')
  if (existsSync(p)) {
    const raw = readFileSync(p, 'utf8')
    // 剥行首 UTF-8 BOM（记事本等工具常产生；lpm 家族读路径一致性——F4）
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const covered = stripped.split(/\r?\n/).some((line) => normalizeGitignoreLine(line) === '.lpm')
    if (covered) return 'present'
    const sep = raw.length === 0 || raw.endsWith('\n') ? '' : '\n'
    writeFileSync(p, raw + sep + '.lpm/\n', 'utf8')
    return 'added'
  }
  writeFileSync(p, '.lpm/\n', 'utf8')
  return 'added'
}

function lastRunPathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'last-run.json')
}

/** 运行留痕（S8 spec §4.6）：原子写；与 state 同级做 gitignore 防护（repair 可能在 .lpm/ 尚不存在时写）；
 *  只留最近一次（新写覆盖旧写）。**内建吞异常**——留痕失败绝不影响主流程（spec §4.6：异常一律吞掉 + stderr 一行提示）。 */
export async function writeRunTrace(rootDir: string, trace: LastRunTrace): Promise<void> {
  try {
    await ensureGitignoreEntry(rootDir)
    const p = lastRunPathOf(rootDir)
    ensureParentDir(p)
    writeJsonFileAtomic(p, trace)
  } catch {
    process.stderr.write('警告：运行留痕写入失败（不影响本次结果）\n')
  }
}

/** 运行留痕构造工厂（S8 最终评审 Important ④ 裁定）：link/unlink/repair 三命令共用，
 *  收敛成功/失败两态的同构装配，消除逐字重复的构造块。
 *  - `result` 由 `failure` 是否为 null 决定（null → 'ok'，否则 'failed'）
 *  - 分层约束：**不 import `core/install.js`**；失败字段（command/exitCode/stderrTail）由调用方
 *    从 `InstallError` 提取后传入，state 层只做纯装配
 *  - 只装配对象、不落盘（落盘仍由 `writeRunTrace` 负责，其自身已内建吞异常） */
export function buildRunTrace(input: {
  command: LastRunTrace['command']
  rootDir: string
  packageManager: LastRunTrace['packageManager']
  changes: LastRunTrace['changes']
  installs: LastRunTrace['installs']
  failure: LastRunTrace['failure']
}): LastRunTrace {
  return {
    version: 1,
    command: input.command,
    at: new Date().toISOString(),
    rootDir: input.rootDir,
    packageManager: input.packageManager,
    result: input.failure === null ? 'ok' : 'failed',
    changes: input.changes,
    installs: input.installs,
    failure: input.failure,
  }
}
