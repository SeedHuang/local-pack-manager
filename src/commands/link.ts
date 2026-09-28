import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { execa } from 'execa'
import { LibCheckError, checkLib } from '../core/linkcheck.js'
import { InstallError, buildInstallCommandLine, detectLibPM, pmExecutable, runInstall, spawnBuildWatch, type WatchProcess } from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import { LOCAL_PROTOCOL_RE, ProtocolPathError, findDepEntries, mapProtocol, rewriteDepValue, type RewriteResult } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findDependents,
  findWorkspaceRoot,
  listWorkspaceMembers,
  loadWorkspace,
  type DepHit,
  type PackageJsonInfo,
  type Workspace,
} from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  buildRunTrace,
  readProjectConfig,
  readState,
  readUserConfig,
  writeLast,
  writeProjectConfig,
  writeRunTrace,
  writeState,
  writeUserConfig,
} from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import type { LastRunTrace, LinkState, ProjectLpmConfig } from '../state/types.js'
import { traceFailure } from './run-trace.js'
import { renderPlan, type PlanEntry, type PlanView } from './plan-view.js'

export interface LinkOptions { watch?: boolean; dryRun?: boolean }

export class LinkArgumentError extends Error {
  constructor(public target: string, message: string) {
    super(message)
    this.name = 'LinkArgumentError'
  }
}

export class LinkInteractionError extends Error {
  constructor(public kind: 'member-select' | 'non-lpm-ternary' | 'conflict-ternary', message: string) {
    super(message)
    this.name = 'LinkInteractionError'
  }
}

/** O5 零命中（<name> 不在任何成员依赖中）——计划期修订 4；OCR O3：字段 pkgName（name 被 Error.name 占用） */
export class LinkTargetError extends Error {
  constructor(public pkgName: string, message: string) {
    super(message)
    this.name = 'LinkTargetError'
  }
}

/** B4 让选取消——内部信号错误（B3：stderr「已取消」+ exit 1），不经 §6 错误表 */
export class LinkCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'LinkCancelledError'
  }
}

export interface ResolvedTarget { key: string; libDirAbs: string; source: 'name' | 'path' }
interface RewriteHit { manifestPath: string; pkgName: string; targetValue: string; fromValue: string; section: string }
interface FileAgg { content: string; hits: RewriteHit[]; changedCount: number }
interface LinkedTarget { libDirAbs: string; rel: string }

function toRel(rootDir: string, abs: string): string {
  return relative(rootDir, abs).replaceAll('\\', '/')
}

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}

/** JSON.parse 级提取（HEAD 文本/宽松场景）——original 值获取用（与 S5 文本级引擎解耦，恢复值语义等价） */
function extractValueFromManifestText(source: string, pkgName: string): string | null {
  try {
    const parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as Record<string, unknown>
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = parsed[section]
      if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
        const v = (deps as Record<string, unknown>)[pkgName]
        if (typeof v === 'string') return v
      }
    }
  } catch {
    return null
  }
  return null
}

function registeredList(cfg: ProjectLpmConfig | null): string {
  const keys = Object.keys(cfg?.libs ?? {})
  return keys.length > 0 ? keys.join(', ') : '（无）'
}

export async function resolveTarget(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): Promise<ResolvedTarget> {
  const libs = cfg?.libs
  const registered = libs !== undefined && Object.hasOwn(libs, raw) ? libs[raw] : undefined
  if (registered !== undefined) {
    if (typeof registered !== 'string') {
      throw new LinkArgumentError(raw, `注册值损坏：libs["${raw}"] 应为字符串相对路径。请修正 lpm.config.json。`)
    }
    return { key: raw, libDirAbs: join(rootDir, ...registered.split('/')), source: 'name' }
  }
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
  if (!looksLikePath) {
    throw new LinkArgumentError(raw, `未知注册名/路径不存在：${raw}。已注册：${registeredList(cfg)}；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册。`)
  }
  const abs = resolve(cwd, raw)
  if (!isDirectory(abs)) {
    throw new LinkArgumentError(raw, `未知注册名/路径不存在：${raw}。已注册：${registeredList(cfg)}；若为路径请确认目录存在；若为注册名请检查拼写或先注册。`)
  }
  return { key: '', libDirAbs: abs, source: 'path' }
}

/** B4 monorepo 根分支（spec §4.4 B）：返回确定成员后的 libDirAbs 与其 name */
export async function resolveMonorepo(libDirAbs: string): Promise<{ libDirAbs: string; name: string }> {
  if (!existsSync(join(libDirAbs, 'package.json'))) {
    if (!existsSync(join(libDirAbs, 'pnpm-workspace.yaml'))) {
      throw new LibCheckError('manifest-missing', libDirAbs, `${libDirAbs} 不是 npm 包（缺 package.json）。请确认路径指向包目录。`)
    }
    const members = await listWorkspaceMembers(libDirAbs)
    return pickMember(libDirAbs, members)
  }
  const libWs = await loadWorkspace(libDirAbs)
  if (libWs.manifestFormat === 'single') {
    return { libDirAbs, name: libWs.members[0]?.name ?? '' }
  }
  return pickMember(libDirAbs, libWs.members)
}

async function pickMember(libDirAbs: string, members: PackageJsonInfo[]): Promise<{ libDirAbs: string; name: string }> {
  if (!process.stdin.isTTY) {
    const names = members.map((m) => (m.isRoot ? '（根）' : '') + (m.name !== '' ? m.name : toRel(libDirAbs, m.dir)))
    throw new LinkInteractionError('member-select', `${libDirAbs} 是 monorepo 根，需要选择成员包：可选成员 ${names.join(', ')}。当前环境无法交互——请直接使用成员路径，如 lpm link <成员路径>。`)
  }
  const selected = await clack.select({
    message: '该路径是 monorepo 根，请选择要链接的成员包',
    options: members.map((m) => ({
      value: m.dir,
      label: (m.isRoot ? '（根）' : '') + (m.name !== '' ? m.name : toRel(libDirAbs, m.dir)),
    })),
  })
  if (clack.isCancel(selected)) {
    throw new LinkCancelledError()
  }
  const dir = selected as string
  const member = members.find((m) => m.dir === dir)
  return { libDirAbs: dir, name: member?.name ?? '' }
}

export const ABANDON: unique symbol = Symbol('abandon')

export async function ternaryOriginal(
  rootDir: string,
  key: string,
  pkgName: string,
  hits: DepHit[],
): Promise<Map<string, string> | typeof ABANDON> {
  // 选项① git HEAD 预取（F1/F2：全部命中文件均取得非本地协议原值才可用）
  const headValues = new Map<string, string>()
  let headUsable = true
  let headReason = ''
  let repoRoot = ''
  try {
    const rr = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir })
    repoRoot = rr.stdout.trim()
  } catch {
    headUsable = false
    headReason = 'git 不可用或当前不在 git 仓库内'
  }
  if (headUsable) {
    for (const h of hits) {
      const relFromRepo = relative(repoRoot, h.manifestPath).replaceAll('\\', '/')
      try {
        const r = await execa('git', ['show', `HEAD:${relFromRepo}`], { cwd: repoRoot })
        const val = extractValueFromManifestText(r.stdout, pkgName)
        if (val === null || val === '' || LOCAL_PROTOCOL_RE.test(val)) {
          headUsable = false
          headReason = `HEAD 版 ${toRel(rootDir, h.manifestPath)} 的 ${pkgName} 值缺失或仍为本地协议`
          break
        }
        headValues.set(h.manifestPath, val)
      } catch {
        headUsable = false
        headReason = `HEAD 版 ${toRel(rootDir, h.manifestPath)} 读取失败（文件未入库？）`
        break
      }
    }
  }
  const options: Array<{ value: string; label: string }> = []
  if (headUsable) options.push({ value: 'head', label: '从 git HEAD 读取原值' })
  options.push({ value: 'manual', label: '手动输入原 range' })
  options.push({ value: 'abandon', label: '放弃该 lib（不链接）' })
  if (!headUsable) {
    process.stderr.write(`提示：git HEAD 通道不可用——${headReason}。\n`)
  }
  const sel = await clack.select({
    message: `检测到非 lpm 管理的本地链接（${key}），选择原始 range 来源`,
    options,
  })
  if (clack.isCancel(sel)) return ABANDON
  if (sel === 'abandon') return ABANDON
  if (sel === 'head') return headValues
  // 手动输入（F3：空串重提示 / 本地协议拒绝重提示 / 3 次耗尽或取消 → 放弃）
  for (let i = 0; i < 3; i++) {
    const inp = await clack.text({ message: `输入 ${key} 的原始 range（如 ^1.2.3）` })
    if (clack.isCancel(inp)) return ABANDON
    const v = String(inp).trim()
    if (v === '') {
      process.stderr.write('输入为空，请重试。\n')
      continue
    }
    if (LOCAL_PROTOCOL_RE.test(v)) {
      process.stderr.write('原 range 不应为本地协议值（link:/file:/portal:）——否则 unlink 会「恢复」成 link 路径。请重试。\n')
      continue
    }
    return new Map(hits.map((h) => [h.manifestPath, v] as const))
  }
  return ABANDON
}

// ─────────────────────────── S9 路径输入与候选集合（spec §4.8 / §4.9）───────────────────────────

/** 路径输入解析失败（未闭合引号 / 空项）——交互内提示重试，不作命令级终止 */
export class PathInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathInputError'
  }
}

/** 路径输入 tokenizer（spec §4.8）：空白分隔；单/双引号包裹可含空格；未闭合引号或空项 → PathInputError */
export function parsePathInput(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t') {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (quote !== null) throw new PathInputError('路径输入的引号未闭合')
  if (started) out.push(cur)
  if (out.length === 0 || out.some((v) => v === '')) throw new PathInputError('路径输入为空')
  return out
}

export interface LinkCandidate { key: string; rel: string; hitMembers: string[]; linked: boolean; cfgIntact: boolean }
export interface DiscoveredLib { key: string; dirAbs: string; dirLabel: string; hitMembers: string[] }

/** 该库被哪些成员声明（相对根路径标签；只读快照，仅供排序与标记——spec §8 自决 10） */
async function hitMembersOf(rootDir: string, ws: Workspace, key: string): Promise<string[]> {
  const hits: DepHit[] = await findDependents(ws, key)
  return [...new Set(hits.map((h) => toRel(rootDir, h.manifestPath)))]
}

/** 读某个目录下 package.json 的 name（剥 BOM；缺失/坏 JSON/name 非字符串 → null） */
function readPkgName(dirAbs: string): string | null {
  try {
    const raw = readFileSync(join(dirAbs, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null
  } catch {
    return null
  }
}

/** 候选集合（只读）：已注册组（★ 排序 / [已链接] / 零命中标记）+ 扫描发现组（spec §4.9） */
export async function collectLinkCandidates(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null, scanDirs: readonly string[],
): Promise<{ registered: LinkCandidate[]; discovered: DiscoveredLib[]; scanNotes: string[] }> {
  const links = st?.links ?? {}
  const registered: LinkCandidate[] = []
  for (const key of Object.keys(cfg?.libs ?? {})) {
    const v: unknown = (cfg?.libs as Record<string, unknown>)[key]
    const cfgIntact = typeof v === 'string'
    registered.push({
      key,
      rel: cfgIntact ? (v as string) : '',
      hitMembers: cfgIntact ? await hitMembersOf(rootDir, ws, key) : [],
      linked: Object.hasOwn(links, key),
      cfgIntact,
    })
  }
  // ★ 置顶：命中成员数降序；Array.prototype.sort 稳定 → 并列保持注册顺序（spec §2 裁决 9）
  registered.sort((a, b) => b.hitMembers.length - a.hitMembers.length)

  const known = new Set(registered.map((c) => c.key))
  const discovered: DiscoveredLib[] = []
  const scanNotes: string[] = []
  for (const dir of scanDirs) {
    if (typeof dir !== 'string') { scanNotes.push(`跳过无效的扫描目录项（非字符串）：${String(dir)}`); continue }
    let entries: Dirent[]
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('not-a-directory')
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      scanNotes.push(`跳过不可读的扫描目录：${dir}`)
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const abs = join(dir, ent.name)
      const name = readPkgName(abs)
      if (name === null || known.has(name) || discovered.some((d) => d.key === name)) continue
      discovered.push({ key: name, dirAbs: abs, dirLabel: abs, hitMembers: await hitMembersOf(rootDir, ws, name) })
    }
  }
  return { registered, discovered, scanNotes }
}

function reportError(err: unknown): number {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkTargetError,
    ProtocolPathError, InstallError,
  ]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

interface LinkPlan {
  rootDir: string
  pm: PackageManagerId
  cfg: ProjectLpmConfig | null // upsert 之后的值（dry-run 下为原值）
  st: LinkState | null
  targets: readonly string[]
  aggregated: Map<string, FileAgg>
  planUpserts: Array<{ key: string; rel: string; isNew: boolean }>
  planSkipped: string[]
  planAbandoned: string[]
  peerWarn: Array<{ rel: string; pkg: string }>
  linkedTargets: LinkedTarget[]
  pendingLinks: Array<{ key: string; original: Record<string, string> }>
  totalChanged: number
  skippedTotal: number
  traceChanges: LastRunTrace['changes']
  traceInstalls: LastRunTrace['installs']
  /** T4 用：交互模式下零命中项被剔除时的提示行（直通模式恒为空） */
  pruned: string[]
}

/** 统一前置（两入口共用同一次）：A5 workspace → loadWorkspace → readProjectConfig → A4 PM；「检测到包管理器」打印留此 */
async function linkPreflight(cwd: string): Promise<{ rootDir: string; ws: Workspace; cfg: ProjectLpmConfig | null; pm: PackageManagerId }> {
  // A5 workspace
  const rootDir = await findWorkspaceRoot(cwd)
  const ws: Workspace = await loadWorkspace(rootDir)
  const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
  // A4 PM
  const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
  const pm = pmResolution.pm
  if (pmResolution.source === 'detected') {
    process.stdout.write(`检测到包管理器：${pm}（未 lpm use 固化）\n`)
  }
  return { rootDir, ws, cfg, pm }
}

/** 计划构建（统一前置判定）：把原 runLink 的 A2–A5 + 计划构建整体搬入。
 *  直通与交互入口共用同一份计划——预览与执行因此天然同源（PRD §13 验收 9）。 */
async function buildLinkPlan(args: {
  targets: readonly string[]
  opts: LinkOptions
  rootDir: string
  cwd: string
  ws: Workspace
  cfg: ProjectLpmConfig | null
  pm: PackageManagerId
  st: LinkState | null
  traceChanges: LastRunTrace['changes']
  traceInstalls: LastRunTrace['installs']
  pruneZeroHit?: boolean
}): Promise<LinkPlan> {
  const { targets, opts, rootDir, cwd, ws, pm, traceChanges, traceInstalls } = args
  let cfg = args.cfg
  const st = args.st
  const seenRaw = new Set<string>()
  const seenKey = new Set<string>()
  const aggregated = new Map<string, FileAgg>()
  const peerWarn: Array<{ rel: string; pkg: string }> = []
  const planUpserts: Array<{ key: string; rel: string; isNew: boolean }> = []
  const planSkipped: string[] = []
  const planAbandoned: string[] = []
  let dedupSkipped = 0 // 同 key 去重跳过计数（J2：K 含去重跳过）
  let unchangedTotal = 0 // unchangedKeys 全 target 求和（J2）
  const linkedTargets: LinkedTarget[] = []
  const pendingLinks: Array<{ key: string; original: Record<string, string> }> = []
  const pruned: string[] = []

  // ── 逐 target（遇错即停——聚合在内存，state/pkg 零写盘；config upsert 允许已发生）──
  for (const raw of targets) {
    if (seenRaw.has(raw)) continue
    seenRaw.add(raw)

    const rt = await resolveTarget(raw, cfg, rootDir, cwd)
    let libDirAbs = rt.libDirAbs
    let libName = ''
    if (rt.source === 'name') {
      libName = rt.key
    } else {
      const mr = await resolveMonorepo(libDirAbs)
      libDirAbs = mr.libDirAbs
      libName = mr.name
    }
    // key 确定（D1：名字分支 = target；路径分支 = name 预读，空名回退相对路径——§9 自决 7）
    let key: string
    if (rt.source === 'name') key = rt.key
    else key = libName !== '' ? libName : toRel(rootDir, libDirAbs)
    if (seenKey.has(key)) {
      dedupSkipped++ // E5 同 key 去重（不同写法指向同一 lib）——计入 J2 跳过数
      continue
    }
    seenKey.add(key)

    // E1 幂等判定（C1，尽早）
    if (st?.links[key] !== undefined) {
      process.stdout.write(`已链接：${key}，跳过（保留原 original 条目）\n`)
      planSkipped.push(key)
      continue
    }

    // C 前置检查（名字分支做 B7 一致性；dry-run 也跑——K3 参数有效性）
    const check = checkLib(libDirAbs, {
      expectedName: rt.source === 'name' ? rt.key : null,
      expectWatchScript: opts.watch === true,
    })

    // D upsert（静默；dry-run 只记录）
    const relPath = toRel(rootDir, libDirAbs)
    const isNew = cfg?.libs[key] !== relPath
    if (isNew && opts.dryRun !== true) {
      const next: ProjectLpmConfig = cfg ?? { version: 1, libs: {} }
      next.libs[key] = relPath
      await writeProjectConfig(rootDir, next)
      cfg = next
      traceChanges.push({ target: key, action: 'upsert-registration', detail: `${key} → ${relPath}` })
    }
    planUpserts.push({ key, rel: relPath, isNew })

    // E2 命中
    const hits: DepHit[] = await findDependents(ws, check.name)
    // E3 O5 零命中
    if (hits.length === 0) {
      if (args.pruneZeroHit === true) {
        // S9 交互模式：剔除该 target 并提示，不连累同批其它勾选项（spec §4.5）
        pruned.push(`⚠️ ${check.name} 未在任何成员依赖中，已跳过——请先 pnpm add ${check.name}`)
        planAbandoned.push(check.name)
        continue
      }
      throw new LinkTargetError(check.name, `${check.name} 不在任何成员依赖中。先在引用方执行 pnpm add ${check.name} 再 link`)
    }

    // E4 非 lpm 检测
    const localHits = hits.filter((h) => LOCAL_PROTOCOL_RE.test(h.currentValue))
    let originals: Map<string, string>
    // E6a：同 manifest 多段命中原值异 → 记首个命中值（先到先得，后者不覆盖）
    const firstWinOriginals = (): Map<string, string> => {
      const m = new Map<string, string>()
      for (const h of hits) if (!m.has(h.manifestPath)) m.set(h.manifestPath, h.currentValue)
      return m
    }
    if (localHits.length > 0) {
      if (opts.dryRun === true) {
        process.stdout.write(`警告：检测到非 lpm 管理的本地链接（${toRel(rootDir, localHits[0].manifestPath)}）（dry-run 不记录 original）\n`)
        originals = firstWinOriginals()
      } else if (!process.stdin.isTTY) {
        throw new LinkInteractionError('non-lpm-ternary', `检测到非 lpm 管理的本地链接（${toRel(rootDir, localHits[0].manifestPath)}），需交互确认原始 range。请手动恢复该文件原值后重试，或先 lpm link --dry-run 查看。`)
      } else {
        const picked = await ternaryOriginal(rootDir, key, check.name, hits)
        if (picked === ABANDON) {
          process.stdout.write(`已放弃：${key}（注册已保留，本次未链接）\n`)
          planAbandoned.push(key)
          continue
        }
        originals = picked
      }
    } else {
      originals = firstWinOriginals()
    }

    // E5 改写聚合（按 manifestPath 分组：每 manifest 每 target 恰一次 rewriteDepValue——
    // 防多段命中重复改写与 J2 计数虚增；OCR O7）
    const originalMap: Record<string, string> = {}
    const byManifest = new Map<string, DepHit[]>()
    for (const h of hits) {
      const g = byManifest.get(h.manifestPath)
      if (g === undefined) byManifest.set(h.manifestPath, [h])
      else g.push(h)
    }
    for (const [manifestPath, group] of byManifest) {
      const targetValue = mapProtocol(pm, libDirAbs, dirname(manifestPath))
      let entry = aggregated.get(manifestPath)
      if (entry === undefined) {
        entry = { content: readFileSync(manifestPath, 'utf8'), hits: [], changedCount: 0 }
        aggregated.set(manifestPath, entry)
      }
      const source = entry.content
      const result: RewriteResult = rewriteDepValue(source, check.name, targetValue)
      entry.content = result.content
      entry.changedCount += result.changedKeys.length
      unchangedTotal += result.unchangedKeys.length
      for (const h of group) {
        entry.hits.push({ manifestPath, pkgName: check.name, targetValue, fromValue: h.currentValue, section: h.section })
      }
      if (findDepEntries(source, check.name).includes('peerDependencies')) {
        peerWarn.push({ rel: toRel(rootDir, manifestPath), pkg: check.name })
      }
      // G1 original：键 = 相对根 + /package.json（根自身 → 'package.json'）；首个命中值（§9 自决 3）
      const relDir = toRel(rootDir, dirname(manifestPath))
      const origKey = relDir === '' ? 'package.json' : `${relDir}/package.json`
      if (originalMap[origKey] === undefined) originalMap[origKey] = originals.get(manifestPath) ?? group[0]?.currentValue ?? ''
    }
    pendingLinks.push({ key, original: originalMap })
    linkedTargets.push({ libDirAbs, rel: relPath })
  }

  // ── 汇总出口 ──
  const totalChanged = [...aggregated.values()].reduce((s, e) => s + e.changedCount, 0)
  const skippedTotal = planSkipped.length + planAbandoned.length + dedupSkipped + unchangedTotal
  return { rootDir, pm, cfg, st, targets, aggregated, planUpserts, planSkipped, planAbandoned, peerWarn, linkedTargets, pendingLinks, totalChanged, skippedTotal, traceChanges, traceInstalls, pruned }
}

/** 把计划渲染成共享视图（行序 = 既有 dry-run 行序，逐字兼容 spec §4.4） */
function linkPlanView(plan: LinkPlan, opts: LinkOptions): PlanView {
  const entries: PlanEntry[] = []
  for (const u of plan.planUpserts) {
    if (u.isNew || plan.cfg?.libs[u.key] === undefined) entries.push({ kind: 'line', text: `注册 upsert：${u.key} → ${u.rel}（新增/更新）` })
  }
  for (const [mp, entry] of plan.aggregated) {
    entries.push({
      kind: 'group',
      heading: `改写 ${toRel(plan.rootDir, mp)}:`,
      lines: entry.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}`),
    })
  }
  for (const k of plan.planSkipped) entries.push({ kind: 'line', text: `已链接跳过：${k}` })
  for (const p of plan.peerWarn) entries.push({ kind: 'line', text: `peer 警告：${p.rel}（${p.pkg}）` })
  const watch = opts.watch === true
    ? plan.linkedTargets.map((t) => `拉起 ${t.rel} 的 build:watch（${pmExecutable(detectLibPM(t.libDirAbs))} run build:watch）`)
    : []
  return { entries, install: { command: buildInstallCommandLine(plan.pm), verify: null }, watch }
}

/** 执行（写序 = S6 裁决：state → package.json → install → last → watch → 提示 → 留痕）——逐字搬运原 438–521 */
async function executeLinkPlan(plan: LinkPlan, opts: LinkOptions): Promise<number> {
  const { rootDir, pm, st, targets, aggregated, linkedTargets, pendingLinks, peerWarn, totalChanged, skippedTotal, traceChanges, traceInstalls } = plan
  // E6a state（合并单次写；linkedAt = S6 生成 ISO 8601）
  const newLinks: LinkState['links'] = { ...(st?.links ?? {}) }
  for (const p of pendingLinks) {
    newLinks[p.key] = { original: p.original, linkedAt: new Date().toISOString() }
  }
  await writeState(rootDir, { version: 1, links: newLinks })
  traceChanges.push({ target: '.lpm/state.json', action: 'write-state', detail: `写入 ${pendingLinks.length} 个链接条目：${pendingLinks.map((p) => p.key).join('、')}` })

  // E6b package.json（文本级原子写）
  for (const [mp, entry] of aggregated) {
    writeTextFileAtomic(mp, entry.content)
    if (entry.changedCount > 0) {
      traceChanges.push({
        target: toRel(rootDir, mp),
        action: 'rewrite-manifest',
        detail: entry.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}`).join('；'),
      })
    }
  }

  // E6c 单次 install
  await runInstall(rootDir, pm)
  traceInstalls.push({ command: buildInstallCommandLine(pm), ok: true, exitCode: 0 })

  // I last（targets ≥ 2 且至少成功 1 个）
  if (targets.length >= 2 && linkedTargets.length >= 1) {
    try {
      const fresh = await readState(rootDir)
      await writeLast(rootDir, { version: 1, names: Object.keys(fresh?.links ?? {}) })
    } catch {
      process.stderr.write('警告：last.json 写入失败（不影响链接）\n')
    }
  }

  // H watch（Ruling 2：lib 自身 PM；前台驻留；Ctrl+C 兜底 kill；H7 spawn 失败警告）
  if (opts.watch === true && linkedTargets.length > 0) {
    const watches: WatchProcess[] = []
    for (const t of linkedTargets) {
      const libPm = detectLibPM(t.libDirAbs)
      try {
        const w = spawnBuildWatch(t.libDirAbs, libPm)
        watches.push(w)
        process.stdout.write(`watch：${t.rel}（${pmExecutable(libPm)} run build:watch，pid ${w.pid}）\n`)
        void w.failure.then((err) => {
          if (err !== null) process.stderr.write(`警告：build:watch 异常退出：${String(err)}（链接本身不受影响）\n`)
        })
      } catch (err) {
        process.stderr.write(`警告：build:watch 拉起失败：${(err as Error).message}（链接本身不受影响）\n`)
      }
    }
    if (watches.length > 0) {
      const onSigint = (): void => {
        for (const w of watches) w.kill()
      }
      process.on('SIGINT', onSigint)
      try {
        await Promise.all(watches.map((w) => w.exited))
      } finally {
        process.off('SIGINT', onSigint)
      }
    }
  }

  // J O4 完成提示（Ruling 6）
  process.stdout.write(`链接完成：${linkedTargets.length} 个 lib，${totalChanged} 处声明改写：\n`)
  for (const [mp, entry] of aggregated) {
    process.stdout.write(`  ${toRel(rootDir, mp)}:\n`)
    for (const h of entry.hits) {
      process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}\n`)
    }
  }
  if (skippedTotal > 0) process.stdout.write(`  已链接跳过：${skippedTotal} 处\n`)
  for (const p of peerWarn) process.stdout.write(`  警告：peerDependencies 命中不改写：${p.rel}（${p.pkg}）\n`)
  process.stdout.write('以上 package.json 已修改，请勿提交；lpm unlink 可恢复原状。\n')
  // S8 运行留痕（spec §4.6）：记本次写盘动作与子进程结果（writeRunTrace 内建吞异常）
  await writeRunTrace(rootDir, buildRunTrace({
    command: 'link',
    rootDir,
    packageManager: pm,
    changes: traceChanges,
    installs: traceInstalls,
    failure: null,
  }))
  return 0
}

// ─────────────────────────── S9 交互入口（spec §4.5 / §4.7）───────────────────────────

const CANCELLED = Symbol('cancelled')

/** 「其他…」虚拟项的值（不会与真实包名冲突——包名不可能含 NUL） */
const OTHER_OPTION = '\u0000__other__'
const LINK_USAGE = 'lpm link <名字|路径>... [--watch] [--dry-run]'

/** 手输路径：3 次重试（镜像 ternaryOriginal 的手动通道）；取消 → CANCELLED；耗尽 → [] */
async function promptPaths(): Promise<string[] | typeof CANCELLED> {
  for (let i = 0; i < 3; i++) {
    const inp = await clack.text({ message: '输入 lib 路径（多个用空格分隔，含空格加引号）' })
    if (clack.isCancel(inp)) return CANCELLED
    try {
      return parsePathInput(String(inp))
    } catch (err) {
      process.stderr.write(`${(err as Error).message}。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号\n`)
    }
  }
  return []
}

/** 空态向导（spec §4.7）：输路径 / 加扫描目录 / 退出 */
async function emptyStateWizard(): Promise<'path' | 'scan' | 'quit' | typeof CANCELLED> {
  const picked = await clack.select({
    message: '还没有注册任何 lib，选一个下一步',
    options: [
      { value: 'path', label: '输入 lib 路径', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' },
      { value: 'scan', label: '添加扫描目录', hint: '写入用户级 scanDirs，以后自动发现' },
      { value: 'quit', label: '退出' },
    ],
  })
  if (clack.isCancel(picked)) return CANCELLED
  return picked as 'path' | 'scan' | 'quit'
}

/** 「添加扫描目录」：必须已存在的绝对路径；读-改-写（保留未知字段）；失败留在向导（spec §4.7 / §4.9） */
async function addScanDir(): Promise<void> {
  const inp = await clack.text({ message: '输入扫描目录（已存在的绝对路径）', placeholder: 'D:\\Seed\\libs' })
  if (clack.isCancel(inp)) return
  const dir = String(inp).trim()
  let ok = false
  try {
    ok = isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    process.stderr.write(`扫描目录必须是已存在的绝对路径：${dir}。示例：D:\\Seed\\libs\n`)
    return
  }
  try {
    const cur = await readUserConfig()
    if (!cur.scanDirs.includes(dir)) await writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, dir] })
    process.stdout.write(`已加入扫描目录：${dir}\n`)
  } catch (err) {
    process.stderr.write(`无法写入用户级配置：${(err as Error).message}。可改用手输路径，或修正后重试\n`)
  }
}

/** 主列表多选（spec §4.5）：分组 + 「其他…」；返回 target 原文数组 */
async function pickLinkTargets(
  cand: { registered: LinkCandidate[]; discovered: DiscoveredLib[] },
): Promise<string[] | typeof CANCELLED> {
  const groups: Record<string, Array<{ value: string; label: string; hint?: string }>> = {}
  if (cand.registered.length > 0) {
    groups[`已注册（${cand.registered.length}）`] = cand.registered.map((c) => ({
      value: c.key,
      label: c.hitMembers.length > 0 ? `${c.key}  ★` : c.key,
      hint: !c.cfgIntact
        ? '注册值损坏：修正 lpm.config.json 后重试'
        : c.linked
          ? '已链接，将跳过'
          : c.hitMembers.length === 0
            ? '未在依赖中，链接前需先 pnpm add'
            : c.rel,
    }))
  }
  if (cand.discovered.length > 0) {
    groups[`扫描发现（${cand.discovered.length}）`] = cand.discovered.map((d) => ({
      // ⚠️ value 必须是**路径**（不是包名）：该库尚未注册，`resolveTarget(包名)` 会因「含 / 的裸名被判为类路径」
      // 而抛 LinkArgumentError（`link.ts:115-121`）——走路径分支才能完成「隐形注册」（T4 评审 Important-1 修正）
      value: d.dirAbs,
      label: `${d.key}  [未注册]`,
      hint: d.hitMembers.length === 0 ? `${d.dirLabel}｜未在依赖中，链接前需先 pnpm add` : d.dirLabel,
    }))
  }
  groups['其他'] = [{ value: OTHER_OPTION, label: '其他…（手输路径）', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' }]

  const picked = await clack.groupMultiselect({ message: '选择要链接的库（空格勾选，回车确认）', options: groups })
  if (clack.isCancel(picked)) return CANCELLED
  const values = (picked as string[]).filter((v) => v !== OTHER_OPTION)
  // 「其他…」不是最终勾选项：提交后若被勾选，先弹输入并把解析出的 target 并入（spec §4.5）
  if ((picked as string[]).includes(OTHER_OPTION)) {
    const raws = await promptPaths()
    if (raws === CANCELLED) return CANCELLED
    return [...values, ...raws]
  }
  return values
}

/** 计划 → 预览 → 一次确认 → 执行（spec §4.4 / §4.11）；空态手输路径也走这里 */
async function runPlanAndExecute(
  picked: readonly string[],
  ctx: {
    opts: LinkOptions; rootDir: string; cwd: string; ws: Workspace; cfg: ProjectLpmConfig | null; pm: PackageManagerId
    st: LinkState | null; traceChanges: LastRunTrace['changes']; traceInstalls: LastRunTrace['installs']
  },
): Promise<number> {
  // 前置剔除（注册值损坏——纯本地判定、无副作用；spec §4.5）
  const keep: string[] = []
  for (const raw of picked) {
    const libs = ctx.cfg?.libs ?? {}
    if (Object.hasOwn(libs, raw) && typeof (libs as Record<string, unknown>)[raw] !== 'string') {
      process.stdout.write(`⚠️ ${raw} 注册值损坏，已跳过——请修正 lpm.config.json 后重试\n`)
      continue
    }
    keep.push(raw)
  }
  if (keep.length === 0) {
    process.stdout.write('  无待执行变更\n')
    return 0
  }
  const plan = await buildLinkPlan({
    targets: keep, opts: ctx.opts, rootDir: ctx.rootDir, cwd: ctx.cwd, ws: ctx.ws, cfg: ctx.cfg, pm: ctx.pm, st: ctx.st,
    traceChanges: ctx.traceChanges, traceInstalls: ctx.traceInstalls, pruneZeroHit: true,
  })
  for (const p of plan.pruned) process.stdout.write(`${p}\n`)
  const view = linkPlanView(plan, ctx.opts)
  // 计划为空（勾选全为 [已链接] 或全被剔除）：打印计划 + 「无待执行变更」+ 不确认（spec §4.4）
  if (plan.aggregated.size === 0) {
    if (ctx.opts.dryRun === true) {
      process.stdout.write('无待执行变更\n') // 与直通 dry-run 空分支逐字同形（无缩进、只此一行）
      return 0
    }
    process.stdout.write(renderPlan(view, 'preview'))
    process.stdout.write('  无待执行变更\n')
    return 0
  }
  if (ctx.opts.dryRun === true) {
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
  process.stdout.write(renderPlan(view, 'preview'))
  const ok = await clack.confirm({
    message: `执行以上计划？（改写 ${plan.aggregated.size} 个文件、执行 1 次安装）`,
    initialValue: false,
  })
  // 闸门取消：内联 return（不抛 → 不写失败留痕，spec §8 自决 3 / 实现期裁定 2）
  if (clack.isCancel(ok) || ok !== true) {
    process.stdout.write('已取消\n')
    return 1
  }
  return await executeLinkPlan(plan, ctx.opts)
}

/** link 交互入口：空态向导 → 主列表 → 计划预览 → 确认 → 执行（spec §4.5 / §4.7 / §4.10） */
async function runLinkInteractive(opts: LinkOptions, cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${LINK_USAGE}\n`)
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, ws, cfg, pm } = await linkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)
    for (;;) {
      const { scanDirs } = await readUserConfig() // 坏 JSON → LpmStateParseError 透传（spec §4.9）
      const cand = await collectLinkCandidates(rootDir, ws, cfg, st, scanDirs)
      if (cand.registered.length > 0 || cand.discovered.length > 0) {
        for (const n of cand.scanNotes) process.stdout.write(`${n}\n`)
        const picked = await pickLinkTargets(cand)
        if (picked === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
        if (picked.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
        return await runPlanAndExecute(picked, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
      }
      // 空态（两组皆空）→ 向导
      const step = await emptyStateWizard()
      if (step === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
      if (step === 'quit') return 0
      if (step === 'scan') { await addScanDir(); continue }   // 成功/失败都回主列表重扫
      const raws = await promptPaths()
      if (raws === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
      if (raws.length === 0) continue
      return await runPlanAndExecute(raws, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
    }
  } catch (err) {
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('link', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}

export async function runLink(targets: readonly string[], opts: LinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数 → S9 交互入口（非 TTY 由入口内部拒绝，绝不进菜单）
  if (targets.length === 0) return await runLinkInteractive(opts, cwd)
  // 运行留痕所需上下文（失败路径在 catch 中也要能定位 rootDir/pm）——S8 spec §4.6
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  // S8 运行留痕（spec §4.6）：本次**已落盘**的改动与子进程——成功/失败路径共用（失败时记已发生部分）
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, ws, cfg, pm } = await linkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    // state 预读（幂等判定 + 合并写基线）
    const st = await readState(rootDir)
    const plan = await buildLinkPlan({ targets, opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
    if (plan.aggregated.size === 0) {
      // 无改写：全已链接 / 全放弃（dry-run 下 abandon 不发生——E4 降级警告；此分支即「全部已链接」）
      if (opts.dryRun === true) {
        process.stdout.write('无待执行变更\n') // spec §4.4 K3：计划体为空 + 「无待执行变更」
      }
      return 0
    }
    // dry-run（K）：零写盘零子进程，打印执行计划
    if (opts.dryRun === true) {
      process.stdout.write(renderPlan(linkPlanView(plan, opts), 'dry-run'))
      return 0
    }
    return await executeLinkPlan(plan, opts)
  } catch (err) {
    // S8 运行留痕（spec §4.6）：失败路径在 reportError 之前捕获原始证据
    // 闸门：--dry-run 零写盘契约优先（不跑子进程、无值得留的证据）——S8 评审 ① 裁定
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('link', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
