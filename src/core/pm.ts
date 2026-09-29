import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { stripBom } from '../util.js'

export type PackageManagerId = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry'

// 推断优先级（lockfile > packageManager 字段 > workspace 清单）与 berry/classic 判定见 PRD §7；
// 行为契约见 S3 spec §4.4

/** 多 lockfile 共存 → 判定歧义（S3 spec §6.1）。found 固定顺序 pnpm-lock.yaml → package-lock.json → yarn.lock */
export class PMAmbiguousError extends Error {
  constructor(public found: string[], message: string) {
    super(message)
    this.name = 'PMAmbiguousError'
  }
}

/** 无任何可推断证据（S3 spec §6.2） */
export class PMUnresolvedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PMUnresolvedError'
  }
}

export type PMEvidence =
  | { kind: 'lockfile'; file: string }
  | { kind: 'corepack-field'; value: string }
  | { kind: 'workspace-manifest'; file: 'pnpm-workspace.yaml' }

export interface DetectResult {
  pm: PackageManagerId
  evidence: PMEvidence
}

const LOCKFILE_ORDER = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const
type LockfileName = (typeof LOCKFILE_ORDER)[number]
const PM_BY_LOCKFILE: Record<Exclude<LockfileName, 'yarn.lock'>, 'pnpm' | 'npm'> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
}

const YARN_LOCK_HEAD_BYTES = 4096

/** yarn 细分（S3 spec §4.4 a/b/c）：.yarnrc.yml 存在 → berry；否则 yarn.lock 头部 4KB 含 __metadata → berry；
 *  否则（含 yarn.lock 缺失/读取失败）→ classic（PRD"否则 classic"字面）。
 *  lockfile 级命中 yarn.lock 与显式 `lpm use yarn` 共用本口径。 */
export function subdivideYarn(rootDir: string): 'yarn-classic' | 'yarn-berry' {
  if (existsSync(join(rootDir, '.yarnrc.yml'))) return 'yarn-berry'
  try {
    const fd = openSync(join(rootDir, 'yarn.lock'), 'r')
    try {
      const buf = Buffer.alloc(YARN_LOCK_HEAD_BYTES)
      const bytesRead = readSync(fd, buf, 0, YARN_LOCK_HEAD_BYTES, 0)
      return buf.toString('utf8', 0, bytesRead).includes('__metadata') ? 'yarn-berry' : 'yarn-classic'
    } finally {
      closeSync(fd)
    }
  } catch {
    return 'yarn-classic'
  }
}

/** 读 package.json 的 packageManager（corepack）字段 → PM。
 *  返回 null = 无信号（缺失/读取失败/JSON 坏/字段缺失或非 string/未知名/切分失败——宽容策略，§4.4 级 2） */
function readCorepackField(rootDir: string): { pm: PackageManagerId; raw: string } | null {
  const manifestPath = join(rootDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  let parsed: unknown
  try {
    const source = readFileSync(manifestPath, 'utf8')
    parsed = JSON.parse(stripBom(source))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as Record<string, unknown>)['packageManager']
  if (typeof raw !== 'string') return null
  const at = raw.indexOf('@')
  if (at <= 0) return null
  const name = raw.slice(0, at)
  if (name === 'pnpm') return { pm: 'pnpm', raw }
  if (name === 'npm') return { pm: 'npm', raw }
  if (name === 'yarn') {
    const major = Number.parseInt(raw.slice(at + 1), 10)
    return { pm: Number.isFinite(major) && major >= 2 ? 'yarn-berry' : 'yarn-classic', raw }
  }
  return null
}

/** 详细检测（S3 spec §4.4 逐条契约；探测基准 rootDir 本层，不向上）。
 *  三级推断：lockfile > corepack 字段 > workspace 清单（仅 pnpm-workspace.yaml 可辨，PRD §7 定版） */
export async function detectPackageManagerDetailed(rootDir: string): Promise<DetectResult> {
  // 1. lockfile 级：存在性探测，不读内容
  const found = LOCKFILE_ORDER.filter((f) => existsSync(join(rootDir, f)))
  if (found.length >= 2) {
    throw new PMAmbiguousError(
      [...found],
      `检测到多个 lockfile（${found.join(', ')}），包管理器判定歧义。\n下一步：手动指定：lpm use <pnpm|npm|yarn>`,
    )
  }
  if (found.length === 1) {
    const file = found[0]
    if (file === 'yarn.lock') {
      return { pm: subdivideYarn(rootDir), evidence: { kind: 'lockfile', file } }
    }
    return { pm: PM_BY_LOCKFILE[file], evidence: { kind: 'lockfile', file } }
  }

  // 2. corepack 字段级
  const field = readCorepackField(rootDir)
  if (field !== null) {
    return { pm: field.pm, evidence: { kind: 'corepack-field', value: field.raw } }
  }

  // 3. 清单级：package.json workspaces 不作信号（npm/yarn 同形不可辨）
  if (existsSync(join(rootDir, 'pnpm-workspace.yaml'))) {
    return { pm: 'pnpm', evidence: { kind: 'workspace-manifest', file: 'pnpm-workspace.yaml' } }
  }

  throw new PMUnresolvedError(
    '无法推断包管理器（未发现 lockfile、packageManager 字段或 pnpm-workspace.yaml）。\n下一步：手动指定：lpm use <pnpm|npm|yarn>',
  )
}

/** S1 §4.3 冻结签名——detectPackageManagerDetailed 的单行包装 */
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId> {
  return (await detectPackageManagerDetailed(rootDir)).pm
}

export type PMResolution =
  | { source: 'config'; pm: PackageManagerId }
  | ({ source: 'detected' } & DetectResult)

const VALID_PM_IDS: readonly string[] = ['pnpm', 'npm', 'yarn-classic', 'yarn-berry']

/** S6 唯一 PM 消费入口（S3 spec §4.3）：显式设定优先（不探测）；未设定/运行时越界值 → 走推断。
 *  configPM 由调用方读 config 后注入——core 不依赖 state（S1 §3 分层规则）。 */
export async function resolvePackageManager(
  rootDir: string,
  configPM: PackageManagerId | undefined,
): Promise<PMResolution> {
  if (configPM !== undefined && VALID_PM_IDS.includes(configPM)) {
    return { source: 'config', pm: configPM }
  }
  return { source: 'detected', ...(await detectPackageManagerDetailed(rootDir)) }
}
