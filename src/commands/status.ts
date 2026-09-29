import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { stripBom } from '../util.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import { probeNodeModules, type NmProbe } from '../core/nmcheck.js'
import { LOCAL_PROTOCOL_RE, mapProtocol, readDepValues } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findWorkspaceRoot,
  loadWorkspace,
  type Workspace,
} from '../core/workspace.js'
import { LpmConfigParseError, LpmStateParseError, readProjectConfig, readState } from '../state/index.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'
import { LinkStateCorruptError, validateEntry } from './unlink.js'

// status 三方核对（S8 spec §4.4）。纯只读：零写盘（不落留痕、不建目录）、零子进程。
// 判定面 scanLinkState 与 repair 共用（spec §9 自决 2）——本文件只做「判定 + 报告」，不做任何修复动作。

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
/** 裸路径值（npm 允许 "foo": "../foo" 不带协议前缀）——S8 spec 裁决 7 */
const BARE_PATH_RE = /^(\.{1,2}[/\\]|\/|[A-Za-z]:[/\\])/

export type IssueFamily = 'drifted' | 'install-ineffective' | 'orphan' | 'stale-link' | 'stale-record' | 'corrupt'
const FAMILY_ORDER: readonly IssueFamily[] = ['drifted', 'install-ineffective', 'orphan', 'stale-link', 'stale-record', 'corrupt']
/** 屏幕输出用中文族名（§4.4 示例文案） */
const FAMILY_LABEL: Record<IssueFamily, string> = {
  drifted: '漂移', 'install-ineffective': '装了没生效', orphan: '孤儿',
  'stale-link': '残留链接', 'stale-record': '失效记录', corrupt: '记录损坏',
}

export interface FileScan { manifest: string; manifestPath: string; declared: string; sections: string[]; nm: NmProbe }
export interface EntryScan {
  key: string; registered: boolean; recorded: boolean; linkedAt?: string
  original?: Record<string, string>; libDirAbs: string | null; libReal: string | null
  files: FileScan[]; issues: IssueFamily[]; notes: string[]
  /** 漂移族专属（S8 最终评审 Important ③）：该库全部漂移文件的 declared 均等于档案 original 的对应值
   *  → 无法区分「用户手动还原」与「unlink 写序中断的残留」，故建议须中性（不把用户往反向的 repair 带） */
  originalConsistentDrift: boolean
}
export interface ScanOutcome {
  entries: EntryScan[]
  total: number; ok: number; issue: number; issueCounts: Record<IssueFamily, number>
}

function toRel(rootDir: string, abs: string): string { return relative(rootDir, abs).replaceAll('\\', '/') }

/** 三依赖段全值（规范段序；同名多段全部保留） */
function readAllDepValues(manifestPath: string): Map<string, string[]> {
  const raw = readFileSync(manifestPath, 'utf8')
  const parsed = JSON.parse(stripBom(raw)) as Record<string, unknown>
  const out = new Map<string, string[]>()
  for (const s of DEP_SECTIONS) {
    const d = parsed[s]
    if (d === null || typeof d !== 'object' || Array.isArray(d)) continue
    for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      const list = out.get(name)
      if (list === undefined) out.set(name, [v]); else list.push(v)
    }
  }
  return out
}

/** 本地链接值判定（协议前缀或裸路径）——判定面单源（S8 spec §9 自决 2）；repair 经 import 复用，不再各留一份 */
export function isLocalish(v: string): boolean { return LOCAL_PROTOCOL_RE.test(v) || BARE_PATH_RE.test(v) }

function statSyncSafe(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}
function sectionsOf(manifestPath: string, key: string): string[] {
  try { return readDepValues(readFileSync(manifestPath, 'utf8'), key).map((v) => v.section) }
  catch { return [] }
}

/** 判定面（只读）：注册 ∪ 档案 ∪ 本地声明 求并集 → 逐库三列（档案 / 声明 / node_modules）判六族 */
export async function scanLinkState(rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null): Promise<ScanOutcome> {
  const keys = new Set<string>()
  for (const k of Object.keys(cfg?.libs ?? {})) keys.add(k)
  for (const k of Object.keys(st?.links ?? {})) keys.add(k)

  const declaredByManifest = new Map<string, Map<string, string[]>>()
  for (const m of ws.members) {
    // loadWorkspace 已严格解析过全部成员清单（坏 JSON 会在那里抛 ManifestParseError 并 exit 1）；
    // 此处 try/catch 仅兜住「加载与扫描之间文件被改动」的竞态，跳过该成员即可
    try { declaredByManifest.set(m.manifestPath, readAllDepValues(m.manifestPath)) }
    catch { /* 竞态：成员清单在扫描期间变得不可读，跳过 */ }
  }
  for (const deps of declaredByManifest.values()) {
    for (const [name, vals] of deps) if (vals.some(isLocalish)) keys.add(name)
  }

  const entries: EntryScan[] = []
  for (const key of keys) {
    const issues = new Set<IssueFamily>()
    const notes: string[] = []
    const libs = cfg?.libs ?? {}
    const hasCfg = Object.hasOwn(libs, key)
    const cfgVal: unknown = hasCfg ? libs[key] : undefined
    const registered = typeof cfgVal === 'string'
    const libDirAbs = registered ? join(rootDir, ...(cfgVal as string).split('/')) : null
    let libReal: string | null = null
    if (libDirAbs !== null) { try { libReal = realpathSync(libDirAbs) } catch { libReal = null } }

    const links = st?.links ?? {}
    const hasSt = Object.hasOwn(links, key)
    // 条目只取一次并判空：值为 null / 非对象时绝不读取其字段
    // （S8 spec §4.4/§6：按 corrupt 族如实报告，不中断）
    const entryVal: unknown = hasSt ? (links as Record<string, unknown>)[key] : undefined
    const entryObj: { linkedAt?: unknown } | null =
      entryVal !== null && typeof entryVal === 'object' && !Array.isArray(entryVal) ? entryVal as { linkedAt?: unknown } : null
    let original: Record<string, string> | null = null
    if (hasSt) {
      try { original = validateEntry(key, entryVal as LinkState['links'][string] | undefined) }
      catch (e) {
        // 条目级损坏（original 缺失/空/值非字符串，或条目为 null 等形态）→ 归 corrupt 族如实报告，
        // 不中断（S8 spec §6 注：status 与 repair 均不抛 LinkStateCorruptError）
        notes.push(e instanceof LinkStateCorruptError ? '记录损坏：original 结构不合法' : '记录损坏：条目结构不合法')
        original = null
      }
    }
    const recorded = original !== null
    if (hasCfg && !registered) notes.push('注册值异常（非字符串），无法比对期望指向')
    if (hasSt && !recorded) issues.add('corrupt')

    const fileSet = new Set<string>()
    if (original !== null) {
      for (const k of Object.keys(original)) {
        if (k === '') continue
        fileSet.add(join(rootDir, ...k.split('/')))
      }
    }
    // 命中文件直接从已缓存的 declaredByManifest 派生（与 findDependents 同一份成员清单数据），
    // 避免对每个 key 重扫全部成员清单（原为 O(keys × 成员) 次读盘 + JSON.parse，且形成第二份声明真相源）
    for (const [mp, deps] of declaredByManifest) if (deps.has(key)) fileSet.add(mp)

    const files: FileScan[] = []
    // Important ③：漂移族「声明值 == 档案原值」判定——无法区分「手动还原」与「unlink 未完成残留」。
    // 初值 null（无漂移文件）；任一步不等则整体 false；全部相等才 true。
    let driftDeclaredMatchesOriginal: boolean | null = null

    for (const manifestPath of fileSet) {
      const rel = toRel(rootDir, manifestPath)
      const exists = statSyncSafe(manifestPath)
      const all = declaredByManifest.get(manifestPath)?.get(key)
      const declared = all?.[0] ?? ''
      const sections = sectionsOf(manifestPath, key)
      const fileRecorded = original !== null && Object.hasOwn(original, rel)
      const nm: NmProbe = exists ? probeNodeModules(manifestPath, key, libReal) : { status: 'unknown' }
      files.push({ manifest: rel, manifestPath, declared, sections, nm })

      if (!exists) { if (fileRecorded) issues.add('stale-record'); continue }
      if (fileRecorded) {
        if (declared === '') issues.add('stale-record')
        // 判定单源 isLocalish（协议前缀 **或裸相对路径**，Important ②）：裸路径声明属「本地链接」而非「正式版本号」
        else if (isLocalish(declared)) { if (nm.status !== 'link-to-lib') issues.add('install-ineffective') }
        else {
          issues.add('drifted')
          const equalsOriginal = original !== null && original[rel] === declared
          driftDeclaredMatchesOriginal = driftDeclaredMatchesOriginal === null
            ? equalsOriginal
            : (driftDeclaredMatchesOriginal && equalsOriginal)
        }
      } else if (declared !== '' && isLocalish(declared)) {
        issues.add('orphan')
      } else if (declared !== '' && (nm.status === 'link-to-lib' || nm.status === 'link-elsewhere')) {
        issues.add('stale-link')
      }
      if (all !== undefined && all.length >= 2 && new Set(all).size > 1) {
        notes.push(`多段命中值异：${sections.join('、')} 声明不一致，判定以首段 ${declared} 为准`)
      }
    }
    if (fileSet.size === 0 && registered) notes.push('已注册，但当前没有任何子包依赖它')

    const originalConsistentDrift = driftDeclaredMatchesOriginal === true
    if (originalConsistentDrift) notes.push('声明值等于档案原值：可能为 unlink 未完成的残留')

    let linkedAt: string | undefined
    if (entryObj !== null && typeof entryObj.linkedAt === 'string') linkedAt = entryObj.linkedAt

    entries.push({
      key, registered, recorded, linkedAt,
      original: original ?? undefined, libDirAbs, libReal, files,
      issues: FAMILY_ORDER.filter((f) => issues.has(f)),
      notes, originalConsistentDrift,
    })
  }

  const issue = entries.filter((e) => e.issues.length > 0).length
  const issueCounts = Object.fromEntries(FAMILY_ORDER.map((f) => [f, 0])) as Record<IssueFamily, number>
  for (const e of entries) for (const f of e.issues) issueCounts[f]++
  return { entries, total: entries.length, ok: entries.length - issue, issue, issueCounts }
}

// ─────────────────────────── 报告（只格式化，不改判定）───────────────────────────

export interface StatusOptions { json?: boolean }

function nmText(nm: NmProbe): string {
  if (nm.status === 'entity') return '实体目录（PM 安装的正式版本）'
  if (nm.status === 'link-to-lib') return `链接仍指向 ${nm.realTarget ?? '未知'}`
  if (nm.status === 'link-elsewhere') return `链接指向他处：${nm.realTarget ?? '未知'}`
  if (nm.status === 'dangling') return '悬空链接'
  if (nm.status === 'missing') return '缺失'
  return nm.note ?? '无法比对指向'
}

/** 期望值（人读）：注册路径可得时给出该文件应写的协议值；不可得一律降级为文字（不抛错） */
function expectedOf(pm: PackageManagerId, libDirAbs: string | null, manifestPath: string): string {
  if (libDirAbs === null) return '不可得（注册缺失/库已删）'
  try { return mapProtocol(pm, libDirAbs, dirname(manifestPath)) } catch { return '不可得（跨盘符）' }
}

function printReport(pm: PackageManagerId, scan: ScanOutcome): void {
  process.stdout.write(`核对完成：${scan.total} 个库（${scan.ok} 正常 / ${scan.issue} 异常）\n`)
  for (const e of scan.entries) {
    if (e.issues.length === 0) continue
    process.stdout.write(`\n⚠️ ${e.key} —— ${e.issues.map((f) => FAMILY_LABEL[f]).join('、')}\n`)
    if (e.original !== undefined) {
      const recs = Object.entries(e.original).map(([k, v]) => `${k}：${v}`).join('、')
      process.stdout.write(`   档案记录：${recs}${e.linkedAt !== undefined ? `（${e.linkedAt} 链接）` : ''}\n`)
    }
    for (const f of e.files) {
      const declared = f.declared === '' ? '（无声明）' : f.declared
      process.stdout.write(`   ${f.manifest}：${declared}（期望 ${expectedOf(pm, e.libDirAbs, f.manifestPath)}）\n`)
      process.stdout.write(`   node_modules：${nmText(f.nm)}\n`)
    }
    for (const n of e.notes) process.stdout.write(`   注：${n}\n`)
    // Important ③：declared == 档案原值的漂移 → 中性建议（消除与 unlink 失败指引「重跑 lpm unlink」的互相打脸）
    process.stdout.write(e.originalConsistentDrift
      ? '   → 修复：若你刚执行过 unlink，请优先重跑 lpm unlink；否则 lpm repair 可恢复本地链接\n'
      : '   → 修复：lpm repair\n')
  }
  for (const e of scan.entries) {
    if (e.issues.length > 0 || e.notes.length === 0) continue
    process.stdout.write(`注（${e.key}）：${e.notes.join('；')}\n`)
  }
  if (scan.ok > 0) process.stdout.write(`其余 ${scan.ok} 个已注册库当前使用正式版本，正常\n`)
}

/** 建议文案（--json 用）：无异常 → null；漂移且声明==档案原值 → 中性建议；否则直接 repair。
 *  单层 if/else，替原先的嵌套三元（S8 OCR 评审 ⑤） */
function suggestionOf(e: EntryScan): string | null {
  if (e.issues.length === 0) return null
  if (e.originalConsistentDrift) return '若刚执行过 unlink 请优先重跑 lpm unlink；否则 lpm repair'
  return 'lpm repair'
}

function buildPayload(rootDir: string, pm: PackageManagerId, scan: ScanOutcome): Record<string, unknown> {
  const slash = (p: string | null): string | null => (p === null ? null : p.replaceAll('\\', '/'))
  return {
    version: 1,
    rootDir: rootDir.replaceAll('\\', '/'),
    packageManager: pm,
    summary: { total: scan.total, ok: scan.ok, issue: scan.issue, issueCounts: scan.issueCounts },
    entries: scan.entries.map((e) => ({
      key: e.key,
      registered: e.registered,
      recorded: e.recorded,
      linkedAt: e.linkedAt,
      original: e.original,
      libDirAbs: slash(e.libDirAbs),
      libReal: slash(e.libReal),
      files: e.files.map((f) => ({
        manifest: f.manifest, declared: f.declared, sections: f.sections,
        // realTarget 与 rootDir/libDirAbs/libReal 同口径归一为正斜杠
        nm: f.nm.realTarget === undefined ? f.nm : { ...f.nm, realTarget: f.nm.realTarget.replaceAll('\\', '/') },
      })),
      status: e.issues.length > 0 ? 'issue' : 'ok',
      issues: e.issues,
      suggestion: suggestionOf(e),
      notes: e.notes,
    })),
  }
}

/** 退出码：核对完成一律 0（含发现异常）；无法核对（workspace/manifest/PM/状态文件层失败）为 1 */
export async function runStatus(opts: StatusOptions, cwd: string = process.cwd()): Promise<number> {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError, LpmConfigParseError, LpmStateParseError,
  ]
  try {
    const rootDir = await findWorkspaceRoot(cwd)
    const ws = await loadWorkspace(rootDir)
    const cfg = await readProjectConfig(rootDir)
    const { pm } = await resolvePackageManager(rootDir, cfg?.packageManager)
    const st = await readState(rootDir)
    const scan = await scanLinkState(rootDir, ws, cfg, st)
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(buildPayload(rootDir, pm, scan), null, 2)}\n`)
    } else {
      printReport(pm, scan)
    }
    return 0
  } catch (err) {
    if (KNOWN.some((k) => err instanceof k)) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
}
