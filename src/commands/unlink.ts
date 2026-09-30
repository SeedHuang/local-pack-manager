import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { probeNodeModules, type NmProbe } from '../core/nmcheck.js'
import { dirname, isAbsolute, join, relative } from 'node:path'
import * as clack from '@clack/prompts'
import { LibCheckError } from '../core/linkcheck.js'
import {
  InstallError,
  buildForceInstallCommandLine,
  buildInstallCommandLine,
  runForceInstall,
  runInstall,
} from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import { LOCAL_PROTOCOL_RE, readDepValues, restoreDepValue } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findWorkspaceRoot,
  loadWorkspace,
  type Workspace,
} from '../core/workspace.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  buildRunTrace,
  deleteState,
  readProjectConfig,
  readState,
  writeLast,
  writeRunTrace,
  writeState,
} from '../state/index.js'
import type { LastRunTrace, LinkState, ProjectLpmConfig } from '../state/types.js'
import { LinkArgumentError, LinkCancelledError, LinkInteractionError, promptPathList, resolveMonorepo, resolveTarget } from './link.js'
import { renderPlan, type PlanEntry, type PlanView } from './plan-view.js'
import { traceFailure } from './run-trace.js'
import { reportError as reportKnownError } from './errors.js'

// unlink 直通版编排（S7 spec §4.4）。行为权威 = spec；崩溃安全顺序（PRD §9 行 306）：
// 先恢复文件 → install → 复验/--force → 才删 state（last 先写后删——评审 P1-1）。

interface UnlinkOptions { all?: boolean; dryRun?: boolean }

export class LinkStateCorruptError extends Error {
  constructor(public key: string, message: string) {
    super(message)
    this.name = 'LinkStateCorruptError'
  }
}

interface RestoreHit { manifestPath: string; pkgName: string; original: string; fromValue: string; section: string }
interface FileAgg { content: string; hits: RestoreHit[]; changedCount: number }

function toRel(rootDir: string, abs: string): string {
  return relative(rootDir, abs).replaceAll('\\', '/')
}

/** raw → key（直通/交互共用；spec §4.4 B1）：注册名 / 非路径语法 / @scope 直接作 key；
 *  路径才走 resolveTarget → resolveMonorepo → 回退相对路径链。异常原样上抛（调用方决定吞/报） */
async function resolveUnlinkKey(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): Promise<string> {
  const registered = cfg?.libs !== undefined && Object.hasOwn(cfg.libs, raw)
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
  if (registered || !looksLikePath || raw.startsWith('@')) return raw
  const rt = await resolveTarget(raw, cfg, rootDir, cwd)
  if (rt.source === 'name') return rt.key
  const mr = await resolveMonorepo(rt.libDirAbs)
  return mr.name !== '' ? mr.name : toRel(rootDir, mr.libDirAbs)
}

/** 手工逃生三步文案（S8 §4.3：扩为导出供 repair 复用同一份字符串——零文案改动） */
export const ESCAPE_HATCH = '若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建'

/** unlink 向 install 失败建议（裁决 7：重跑语义与 link 相反且真实有效——PRD §6.2 行 143） */
const UNLINK_RETRY_ADVICE = `state 已保留（文件已恢复），可直接重跑 lpm unlink——恢复段幂等跳过直达 install；${ESCAPE_HATCH}`

function reportError(err: unknown): number {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkStateCorruptError,
    InstallError,
  ]
  return reportKnownError(err, KNOWN)
}

/** C 条目校验（裁决 5）：original 为对象、非空、键值全非空 string；损坏 → LinkStateCorruptError
 *  （S8 §4.3：扩为导出，供 status/repair 复用条目结构校验；定义与行为零变化） */
export function validateEntry(key: string, entry: LinkState['links'][string] | undefined): Record<string, string> {
  if (entry === undefined) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 缺失。\n下一步：手工逃生三步：${ESCAPE_HATCH}`)
  }
  const o = entry.original
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 不是对象。\n下一步：手工逃生三步：${ESCAPE_HATCH}`)
  }
  const keys = Object.keys(o)
  if (keys.length === 0) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 为空对象。\n下一步：手工逃生三步：${ESCAPE_HATCH}`)
  }
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k]
    if (typeof v !== 'string' || v === '') {
      throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original["${k}"] 应为非空字符串。\n下一步：手工逃生三步：${ESCAPE_HATCH}`)
    }
  }
  return o as Record<string, string>
}

/** 恢复动作（态1 恢复 与 冲突选「original」共用）：改写内容 + 记命中 + 返回 changed 数（调用方累加 totalChanged / 置 anyRestored） */
function applyRestore(
  agg: FileAgg,
  key: string,
  origValue: string,
  values: ReadonlyArray<{ section: string; value: string }>,
  manifestPath: string,
): number {
  const result = restoreDepValue(agg.content, key, origValue)
  agg.content = result.content
  agg.changedCount += result.changedKeys.length
  for (const h of values) {
    agg.hits.push({ manifestPath, pkgName: key, original: origValue, fromValue: h.value, section: h.section })
  }
  return result.changedKeys.length
}

interface VerifyFinding { rel: string; nmRel: string; status: 'ok' | 'missing' | 'residue'; note?: string }

/** F 复验（判定走 nmcheck.probeNodeModules；本节只做「事实 → unlink 侧语义」解释，文案逐字不变） */
function verifyResidue(rootDir: string, cfg: ProjectLpmConfig | null, key: string, manifestPaths: string[]): VerifyFinding[] {
  const out: VerifyFinding[] = []
  const registered = cfg?.libs[key]
  const libDirAbs = typeof registered === 'string' ? join(rootDir, ...registered.split('/')) : null
  let libReal: string | null = null
  if (libDirAbs !== null) {
    try { libReal = realpathSync(libDirAbs) } catch { libReal = null }
  }
  for (const mp of manifestPaths) {
    const nmRel = `${toRel(rootDir, dirname(mp))}/node_modules/${key}`
    const probe: NmProbe = probeNodeModules(mp, key, libReal)
    if (probe.status === 'link-to-lib') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '软链残留' })
      continue
    }
    if (probe.status === 'dangling') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '悬空链接' })
      continue
    }
    if (probe.status === 'missing') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'missing' })
      continue
    }
    // entity / link-elsewhere → ok（note 无值）；unknown → ok + 注明（probe.note 原样透传）
    out.push({ rel: toRel(rootDir, mp), nmRel, status: 'ok', note: probe.note })
  }
  return out
}

// ─────────────────────────── S9 unlink 编排拆分 + 列表数据源（spec §4.4 / §4.6 / §4.11）───────────────────────────

/** 统一前置（直通与交互入口共用同一次）：A workspace → loadWorkspace（仅校验副作用）→ config → PM；
 *  「检测到包管理器」打印留此 */
async function unlinkPreflight(cwd: string): Promise<{ rootDir: string; cfg: ProjectLpmConfig | null; pm: PackageManagerId }> {
  // A workspace + PM（镜像 S6 A5）
  const rootDir = await findWorkspaceRoot(cwd)
  await loadWorkspace(rootDir) // 仅取校验副作用（WorkspacePatternError 等）——OCR：勿保留死绑定
  const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
  const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
  if (pmResolution.source === 'detected') {
    process.stdout.write(`检测到包管理器：${pmResolution.pm}（未 lpm use 固化）\n`)
  }
  // 注意：readState **不在这里**——留在调用方紧跟 traceRoot/tracePm 赋值之后（与 link 同形；
  // 且 state 损坏时 catch 仍能定位 rootDir/pm 写失败留痕）
  return { rootDir, cfg, pm: pmResolution.pm }
}

interface UnlinkPlan {
  rootDir: string
  cwd: string
  pm: PackageManagerId
  cfg: ProjectLpmConfig | null
  st: LinkState | null
  targets: readonly string[]
  aggregated: Map<string, FileAgg>
  pendingDelete: string[]
  verifyManifests: Map<string, string[]>
  planSkipped: string[]
  planAbandoned: string[]
  planConflicts: string[]
  planMissing: string[]
  planIdempotent: Array<{ key: string; rel: string }>
  dedupSkipped: number
  totalChanged: number
  restoredKeyCount: number
  traceChanges: LastRunTrace['changes']
  traceInstalls: LastRunTrace['installs']
}

/** 计划构建：把原 runUnlink 的 B/C/D 整体搬入。直通与交互入口共用同一份计划——
 *  预览与执行因此天然同源（PRD §13 验收 9）。
 *  复杂度 71：多 key 聚合 + 三态校验，拆分属 E 类立项，暂标注豁免 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function buildUnlinkPlan(args: {
  targets: readonly string[]
  opts: UnlinkOptions
  rootDir: string
  cwd: string
  cfg: ProjectLpmConfig | null
  pm: PackageManagerId
  st: LinkState | null
  traceChanges: LastRunTrace['changes']
  traceInstalls: LastRunTrace['installs']
}): Promise<UnlinkPlan> {
  const { targets, opts, rootDir, cwd, cfg, pm, st, traceChanges, traceInstalls } = args

  // B target 解析（--all → state 全量 keys；显式 → 逐个解析 + 去重）
  const seenRaw = new Set<string>()
  const seenKey = new Set<string>()
  let dedupSkipped = 0
  const requested: string[] = []
  if (opts.all === true) {
    requested.push(...Object.keys(st?.links ?? {}))
  } else {
    for (const raw of targets) {
      if (seenRaw.has(raw)) continue
      seenRaw.add(raw)
      // 名字分支（spec §4.4 B1）：非路径语法的 target 直接作 key——不读 lib 目录、不要求注册
      // （unlink 用途含 lib 已删/未注册残留条目）；路径分支才走 resolveTarget/resolveMonorepo
      const key = await resolveUnlinkKey(raw, cfg, rootDir, cwd)
      if (seenKey.has(key)) { dedupSkipped++; continue }
      seenKey.add(key)
      requested.push(key)
    }
  }

  // C/D 逐 key 校验 + 逐文件三态（聚合在内存——遇错即停零写盘）
  const aggregated = new Map<string, FileAgg>()
  const pendingDelete: string[] = []
  const verifyManifests = new Map<string, string[]>() // key → manifestPaths（复验面 = 待删集全部 original 键）
  const planSkipped: string[] = []       // 未链接跳过
  const planAbandoned: string[] = []     // 冲突放弃
  const planIdempotent: Array<{ key: string; rel: string }> = [] // 已恢复跳过（key, file）
  const planMissing: string[] = []       // 文件不存在警告
  const planConflicts: string[] = []     // dry-run 冲突降级行
  let totalChanged = 0
  let restoredKeyCount = 0               // 有恢复动作的 key 数（O4 镜像 N）

  for (const key of requested) {
    const idemMark = planIdempotent.length
    const missingMark = planMissing.length
    // OCR：own-property 守卫——防 'constructor'/'toString' 等原型链成员被当作已存在条目
    // （与上方 Object.hasOwn(cfg.libs, raw) 惯例一致）
    const entry = st?.links !== undefined && Object.hasOwn(st.links, key) ? st.links[key] : undefined
    if (entry === undefined) {
      process.stdout.write(`未链接：${key}，跳过\n`)
      planSkipped.push(key)
      continue
    }
    const original = validateEntry(key, entry)
    // per-key 快照（isCancel 放弃 → 内存回滚——放弃语义 = 该 lib 零改写）
    const snapshot = new Map([...aggregated].map(([k, v]) => [k, { content: v.content, hits: [...v.hits], changedCount: v.changedCount }] as const))
    let anyRestored = false
    let allMissing = true
    const keyManifestPaths: string[] = []

    for (const [origKey, origValue] of Object.entries(original)) {
      const manifestPath = join(rootDir, ...origKey.split('/'))
      // 不存在或非常规文件（键格式损坏/指向目录，如 ''→rootDir、'apps/web'）→ 警告出局；
      // 缺 isFile 会放行目录致 readFileSync 抛 EISDIR 逃逸出 runUnlink（OCR 修复，同 linkcheck B5 类）
      if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
        process.stderr.write(`警告：文件不存在或不是常规文件，跳过恢复：${origKey}\n`)
        planMissing.push(origKey)
        continue
      }
      keyManifestPaths.push(manifestPath)
      allMissing = false
      const rel = toRel(rootDir, manifestPath)
      let agg = aggregated.get(manifestPath)
      if (agg === undefined) {
        agg = { content: readFileSync(manifestPath, 'utf8'), hits: [], changedCount: 0 }
        aggregated.set(manifestPath, agg)
      }
      const values = readDepValues(agg.content, key)
      const representative = values[0]?.value ?? ''
      if (representative === '') {
        // 文件内无命中段（依赖已被手动移除）→ 幂等跳过（计划期修订 2）
        planIdempotent.push({ key, rel })
        continue
      }
      if (LOCAL_PROTOCOL_RE.test(representative)) {
        // 态1 恢复（全段写回——裁决 4）
        totalChanged += applyRestore(agg, key, origValue, values, manifestPath)
        anyRestored = true
        // 裁决 4（全段写回）：点明哪些段的手动改动将被覆盖——OCR 建议的文案显性化（行为不变）
        if (values.length >= 2 && new Set(values.map((v) => v.value)).size > 1) {
          const overridden = values.filter((v) => v.value !== origValue).map((v) => `${v.section}.${key}`)
          process.stderr.write(`警告：${rel} 多段命中值异——${overridden.join('、')} 的手动改动将被覆盖为 ${origValue}\n`)
        }
      } else if (representative === origValue) {
        // 态2 幂等跳过（零改写；key 仍进待删集——重跑收敛，G1）
        planIdempotent.push({ key, rel })
      } else {
        // 态3 冲突二选一（B1 防护核心）
        if (opts.dryRun === true) {
          planConflicts.push(`${rel}（当前 ${representative} vs original ${origValue}）`)
          continue
        }
        if (!process.stdin.isTTY) {
          throw new LinkInteractionError('conflict-ternary', `检测到手动改动（${rel}：当前 ${representative} vs original ${origValue}），需交互确认。\n下一步：手动处理该文件后重试，或先 lpm unlink --dry-run 查看`)
        }
        const picked = await clack.select({
          message: `检测到手动改动（${rel}），选择处理方式`,
          options: [
            { value: 'current', label: `用当前 ${representative}（保留手动升级）` },
            { value: 'original', label: `用 original ${origValue}（恢复）` },
          ],
        })
        if (clack.isCancel(picked)) {
          process.stdout.write(`已放弃：${key}（state 条目保留）\n`)
          planAbandoned.push(key)
          break
        }
        if (picked === 'original') {
          totalChanged += applyRestore(agg, key, origValue, values, manifestPath)
          anyRestored = true
        }
        // picked === 'current' → 该文件该 key 零改写；key 仍进待删集（G1）
      }
    }

    if (planAbandoned.includes(key)) {
      // 内存回滚（放弃 = 该 lib 零改写）
      aggregated.clear()
      let restoredTotal = 0
      for (const [k, v] of snapshot) {
        aggregated.set(k, { content: v.content, hits: [...v.hits], changedCount: v.changedCount })
        restoredTotal += v.changedCount
      }
      totalChanged = restoredTotal
      planIdempotent.length = idemMark   // O4：放弃 = 该 lib 零改写 → 计数同步回滚
      planMissing.length = missingMark
      continue
    }
    if (allMissing) continue // 全文件缺失 → 条目保留（自决 5），不进待删集
    pendingDelete.push(key)
    if (anyRestored) restoredKeyCount++
    verifyManifests.set(key, keyManifestPaths)
  }

  return {
    rootDir, cwd, pm, cfg, st, targets, aggregated, pendingDelete, verifyManifests,
    planSkipped, planAbandoned, planConflicts, planMissing, planIdempotent,
    dedupSkipped, totalChanged, restoredKeyCount, traceChanges, traceInstalls,
  }
}

/** 计划为空（无改写、无待删、无冲突/缺失/跳过）——dry-run 空分支判据（逐字兼容原空判据） */
function unlinkPlanIsEmpty(plan: UnlinkPlan): boolean {
  return plan.aggregated.size === 0 && plan.pendingDelete.length === 0
    && plan.planConflicts.length === 0 && plan.planMissing.length === 0 && plan.planSkipped.length === 0
}

/** 计划 → 共享视图（行序 = 既有 dry-run 行序，逐字兼容 spec §4.4） */
function unlinkPlanView(plan: UnlinkPlan): PlanView {
  const entries: PlanEntry[] = []
  for (const [mp, agg] of plan.aggregated) {
    if (agg.hits.length === 0) continue
    entries.push({
      kind: 'group',
      heading: `恢复 ${toRel(plan.rootDir, mp)}:`,
      lines: agg.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}`),
    })
  }
  for (const p of plan.planIdempotent) entries.push({ kind: 'line', text: `已恢复跳过：${p.key}（${p.rel} 值已等于 original）` })
  for (const k of plan.planSkipped) entries.push({ kind: 'line', text: `未链接跳过：${k}` })
  for (const c of plan.planConflicts) entries.push({ kind: 'line', text: `冲突需确认：${c}——真实执行时将询问` })
  for (const m of plan.planMissing) entries.push({ kind: 'line', text: `文件不存在警告：${m}` })
  let install: PlanView['install'] = null
  if (plan.pendingDelete.length > 0) {
    const remainCount = Object.keys(plan.st?.links ?? {}).length - plan.pendingDelete.length
    if (remainCount === 0) {
      entries.push({ kind: 'line', text: `state：清空——last 记 ${JSON.stringify(Object.keys(plan.st?.links ?? {}))} → 删 state 文件` })
    } else {
      for (const k of plan.pendingDelete) entries.push({ kind: 'line', text: `state：删除 ${k}（剩余 ${remainCount} 条）` })
    }
    install = { command: buildInstallCommandLine(plan.pm), verify: `node_modules 实际指向（残留/缺失将 ${buildForceInstallCommandLine(plan.pm)} 重建）` }
  }
  if (unlinkPlanIsEmpty(plan)) entries.push({ kind: 'line', text: '无待执行变更' })
  return { entries, install, watch: [] }
}

/** 执行（写序 = S7 裁决：恢复文件 → install 成功 → 才删 state）。
 *  复杂度 53：恢复/复验/force/删档多段校验，拆分属 E 类立项，暂标注豁免 */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function executeUnlinkPlan(plan: UnlinkPlan): Promise<number> {
  const {
    rootDir, pm, cfg, st, aggregated, pendingDelete, verifyManifests, planIdempotent,
    planSkipped, planAbandoned, dedupSkipped, totalChanged, restoredKeyCount, traceChanges, traceInstalls,
  } = plan

  // E1 先恢复文件（零改写文件不写盘——byte 保真）
  for (const [mp, agg] of aggregated) {
    if (agg.changedCount === 0) continue
    writeTextFileAtomic(mp, agg.content)
    traceChanges.push({
      target: toRel(rootDir, mp),
      action: 'rewrite-manifest',
      detail: agg.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}`).join('；'),
    })
  }

  // E2 install 恰一次（待删集非空——恢复/幂等跳过/用当前 三类覆盖）
  if (pendingDelete.length > 0) {
    await runInstall(rootDir, pm, UNLINK_RETRY_ADVICE)
    traceInstalls.push({ command: buildInstallCommandLine(pm), ok: true, exitCode: 0 })
  }

  // F 复验 + --force（恰一次重建 + 恰一次复验；--force 在删 state 之前）
  if (pendingDelete.length > 0) {
    const findings: VerifyFinding[] = []
    for (const [key, mps] of verifyManifests) {
      findings.push(...verifyResidue(rootDir, cfg, key, mps))
    }
    const bad = findings.filter((f) => f.status !== 'ok')
    if (bad.length > 0) {
      for (const f of bad) {
        const what = f.status === 'residue' ? `残留（${f.note ?? '软链残留'}）` : '缺失'
        process.stdout.write(`警告：node_modules ${what}：${f.nmRel}——${buildForceInstallCommandLine(pm)} 重建\n`)
      }
      await runForceInstall(rootDir, pm, UNLINK_RETRY_ADVICE)
      traceInstalls.push({ command: buildForceInstallCommandLine(pm), ok: true, exitCode: 0 })
      const recheck: VerifyFinding[] = []
      for (const [key, mps] of verifyManifests) {
        recheck.push(...verifyResidue(rootDir, cfg, key, mps))
      }
      for (const f of recheck) {
        if (f.status !== 'ok') {
          process.stderr.write(`警告：node_modules 复验未通过：${f.nmRel}（${f.status === 'residue' ? '残留' : '缺失'}）；lpm status（S8）可进一步诊断\n`)
        } else if (bad.some((b) => b.rel === f.rel && b.nmRel === f.nmRel)) {
          process.stdout.write(`已重建：${f.nmRel}\n`)
        }
      }
    } else {
      for (const f of findings) {
        if (f.note !== undefined) process.stdout.write(`复验注明：${f.nmRel}（${f.note}）\n`)
      }
    }
  }

  // G 删 state（install 成功后才到此处——崩溃顺序保证）+ last（先写后删——评审 P1-1）
  const beforeKeys = Object.keys(st?.links ?? {})
  const remaining: LinkState['links'] = {}
  for (const k of beforeKeys) {
    if (!pendingDelete.includes(k)) remaining[k] = (st?.links[k]) as LinkState['links'][string]
  }
  if (Object.keys(remaining).length === 0 && pendingDelete.length > 0) {
    await writeLast(rootDir, { version: 1, names: beforeKeys }) // 清空前完整集合
    await deleteState(rootDir)
    traceChanges.push({
      target: '.lpm/state.json',
      action: 'delete-entry',
      detail: `删除整个档案文件（清空前条目：${beforeKeys.join('、')}；原值：${JSON.stringify(Object.fromEntries(beforeKeys.map((k) => [k, st?.links[k]?.original ?? {}])))}）`,
    })
  } else if (pendingDelete.length > 0) {
    await writeState(rootDir, { version: 1, links: remaining })
    traceChanges.push({
      target: '.lpm/state.json',
      action: 'write-state',
      detail: `删除档案条目：${pendingDelete.join('、')}（剩余 ${Object.keys(remaining).length} 条；原值：${JSON.stringify(Object.fromEntries(pendingDelete.map((k) => [k, st?.links[k]?.original ?? {}])))}）`,
    })
  }

  // I/J 完成提示（O4 镜像 + PRD 行 145）
  process.stdout.write(`恢复完成：${restoredKeyCount} 个 lib，${totalChanged} 处声明恢复：\n`)
  for (const [mp, agg] of aggregated) {
    if (agg.hits.length === 0) continue
    process.stdout.write(`  ${toRel(rootDir, mp)}:\n`)
    for (const h of agg.hits) {
      process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}\n`)
    }
  }
  const skippedTotal = planSkipped.length + planAbandoned.length + dedupSkipped + planIdempotent.length
  if (skippedTotal > 0) process.stdout.write(`  跳过合计：${skippedTotal} 处\n`)
  process.stdout.write('以上 package.json 已恢复原 range（多数场景与 git 基线一致；冲突选「用当前」的文件保留手动改动）；建议重启 dev server 使依赖变更生效。\n')
  // S8 运行留痕（spec §4.6）：仅当本次确有改动（pendingDelete 非空）时写，避免零动作空跑凭空建 .lpm/
  if (pendingDelete.length > 0) {
    await writeRunTrace(rootDir, buildRunTrace({
      command: 'unlink',
      rootDir,
      packageManager: pm,
      changes: traceChanges,
      installs: traceInstalls,
      failure: null,
    }))
  }
  return 0
}

/** 已链接列表数据源（spec §4.6）：state.links 键 × status 判定面（动态 import 规避 status ⇄ unlink 静态循环） */
interface LinkedItem {
  key: string; rel: string; restoreTo: string[]; linkedMembers: string[]
  drifted: boolean; corrupt: boolean
}

export async function collectLinkedItems(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null,
): Promise<LinkedItem[]> {
  const { scanLinkState } = await import('./status.js')
  const scan = await scanLinkState(rootDir, ws, cfg, st)
  const byKey = new Map(scan.entries.map((e) => [e.key, e]))
  const links = st?.links ?? {}
  const out: LinkedItem[] = []
  for (const key of Object.keys(links)) {
    const e = byKey.get(key)
    // 读取守卫（spec §4.6）：条目可能为 null / 非对象 / original 结构非法——绝不直接读字段
    const rawEntry = Object.hasOwn(links, key) ? (links as Record<string, unknown>)[key] : undefined
    const entryObj = rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
      ? (rawEntry as { original?: unknown })
      : null
    const origRaw = entryObj?.original
    const origObj = origRaw !== null && typeof origRaw === 'object' && !Array.isArray(origRaw)
      ? (origRaw as Record<string, unknown>)
      : {}
    const rels = Object.keys(origObj).filter((k) => typeof origObj[k] === 'string')
    const cfgVal: unknown = (cfg?.libs as Record<string, unknown> | undefined)?.[key]
    out.push({
      key,
      rel: typeof cfgVal === 'string' ? cfgVal : '',
      restoreTo: [...new Set(rels.map((r) => String(origObj[r])))],
      linkedMembers: [...new Set(rels.map((r) => (r.endsWith('/package.json') ? r.slice(0, -'/package.json'.length) : '（根）')))],
      drifted: e?.issues.includes('drifted') ?? false,
      corrupt: e?.issues.includes('corrupt') ?? false,
    })
  }
  return out
}

// ─────────────────────────── S9 交互入口（spec §4.6 / §4.7）───────────────────────────

const CANCELLED_U = Symbol('cancelled')
const PATH_OPTION = '\u0000__path__'
const UNLINK_USAGE = 'lpm unlink <名字|路径>... [--all] [--dry-run]'

/** 列表多选（spec §4.6）：包名 +（链接的子包）+ 将恢复的 range + [漂移]/[记录损坏]；附「按路径取消…」 */
async function pickLinkedKeys(
  items: LinkedItem[],
  ctx: { rootDir: string; cwd: string; cfg: ProjectLpmConfig | null },
): Promise<string[] | typeof CANCELLED_U> {
  const options: Array<{ value: string; label: string }> = items.map((it) => ({
    value: it.key,
    label: `${it.key}`
      + (it.linkedMembers.length > 0 ? `（${it.linkedMembers.join('、')}）` : '')
      + (it.restoreTo.length > 0 ? ` → ${it.restoreTo.join(' / ')}` : '')
      + (it.drifted ? '  [漂移]' : '')
      + (it.corrupt ? '  [记录损坏]' : ''),
  }))
  options.push({ value: PATH_OPTION, label: '按路径取消…（手输路径）' })
  const picked = await clack.multiselect({ message: '选择要取消链接的库（空格勾选，回车确认）', options, required: false })
  if (clack.isCancel(picked)) return CANCELLED_U
  const values = (picked as string[]).filter((v) => v !== PATH_OPTION)
  if (!(picked as string[]).includes(PATH_OPTION)) return values
  const raws = await promptPathList('输入要取消的路径（多个用空格分隔，含空格加引号）', CANCELLED_U)
  if (raws === CANCELLED_U) return CANCELLED_U
  for (const raw of raws) {
    // 路径 → key（复用直通解析链；解析失败/不在注册表 → 一律按「未处于链接状态」处理，不中断）
    let key = raw
    try {
      key = await resolveUnlinkKey(raw, ctx.cfg, ctx.rootDir, ctx.cwd)
    } catch (err) {
      if (err instanceof LinkCancelledError) throw err   // 用户在 B4 让选里主动取消 → 必须中止（spec §4.10 / §8 裁定 2）
      process.stdout.write(`当前未处于链接状态：${raw}。可用 lpm status 核对三方状态\n`)
      continue
    }
    if (items.some((i) => i.key === key)) values.push(key)
    else process.stdout.write(`当前未处于链接状态：${raw}。可用 lpm status 核对三方状态\n`)
  }
  return values
}

/** unlink 交互入口：列表 → 预览 → 确认 → 执行（spec §4.6 / §4.7 / §4.10） */
async function runUnlinkInteractive(opts: UnlinkOptions, cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${UNLINK_USAGE}\n`)
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, cfg, pm } = await unlinkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)   // 与 runUnlink 同形：紧跟赋值之后
    const ws = await loadWorkspace(rootDir)
    const items = await collectLinkedItems(rootDir, ws, cfg, st)
    if (items.length === 0) {
      // 空态三去向（spec §4.7）
      process.stdout.write('当前没有已链接的库。\n')
      process.stdout.write('  lpm link    把依赖切到本地目录联调\n')
      process.stdout.write('  lpm status  核对三方状态\n')
      process.stdout.write('  lpm forget  移除 lib 注册\n')
      return 0
    }
    const picked = await pickLinkedKeys(items, { rootDir, cwd, cfg })
    if (picked === CANCELLED_U) { process.stdout.write('已取消\n'); return 1 }
    if (picked.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
    // 前置剔除：记录损坏项（spec §4.6）——否则 buildUnlinkPlan 抛 LinkStateCorruptError 会炸掉整批
    const keep: string[] = []
    for (const k of picked) {
      if (items.some((i) => i.key === k && i.corrupt)) {
        process.stdout.write(`⚠️ ${k} 记录损坏，已跳过——请先 lpm repair\n`)
        continue
      }
      keep.push(k)
    }
    if (keep.length === 0) { process.stdout.write('  无待执行变更\n'); return 0 }
    const plan = await buildUnlinkPlan({ targets: keep, opts, rootDir, cwd, cfg, pm, st, traceChanges, traceInstalls })
    const view = unlinkPlanView(plan)
    if (plan.aggregated.size === 0 && plan.pendingDelete.length === 0) {
      process.stdout.write(renderPlan(view, opts.dryRun === true ? 'dry-run' : 'preview'))
      if (!unlinkPlanIsEmpty(plan)) process.stdout.write('  无待执行变更\n')
      return 0
    }
    if (opts.dryRun === true) { process.stdout.write(renderPlan(view, 'dry-run')); return 0 }
    process.stdout.write(renderPlan(view, 'preview'))
    const restoredFiles = [...plan.aggregated.values()].filter((a) => a.changedCount > 0).length
    const ok = await clack.confirm({
      message: `执行以上计划？（恢复 ${restoredFiles} 个文件、执行 1 次安装）`,
      initialValue: false,
    })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }  // 闸门取消不写留痕（裁定 2）
    return await executeUnlinkPlan(plan)
  } catch (err) {
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('unlink', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) { process.stderr.write('已取消\n'); return 1 }
    return reportError(err)
  }
}

export async function runUnlink(targets: readonly string[], opts: UnlinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数（--all 除外）→ S9 交互入口（非 TTY 由入口内部拒绝）
  if (targets.length === 0 && opts.all !== true) return await runUnlinkInteractive(opts, cwd)
  // 运行留痕所需上下文（失败路径在 catch 中也要能定位 rootDir/pm）——S8 spec §4.6
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  // S8 运行留痕（spec §4.6）：本次**已落盘**的改动与子进程——成功/失败路径共用（失败时记已发生部分）
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    // A2 互斥（spec §5 #3）
    if (opts.all === true && targets.length > 0) {
      throw new LinkArgumentError('--all', '--all 与显式目标互斥。\n下一步：要取消指定目标请直接给名字或路径')
    }
    // A workspace + PM（统一前置）
    const { rootDir, cfg, pm } = await unlinkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    // readState 紧跟 traceRoot/tracePm 赋值之后（与 link 同形）——state 损坏时 catch 仍能定位 rootDir/pm 写失败留痕
    const st = await readState(rootDir)
    // G5：--all 空 state → 无已链接项 exit 0（幂等不报错）
    if (opts.all === true && Object.keys(st?.links ?? {}).length === 0) {
      process.stdout.write('无已链接项\n')
      return 0
    }
    const plan = await buildUnlinkPlan({ targets, opts, rootDir, cwd, cfg, pm, st, traceChanges, traceInstalls })
    // H dry-run（裁决 6；镜像 S6 K）——计划体渲染走共享渲染器（spec §4.4）
    if (opts.dryRun === true) {
      process.stdout.write(renderPlan(unlinkPlanView(plan), 'dry-run'))
      return 0
    }
    return await executeUnlinkPlan(plan)
  } catch (err) {
    // S8 运行留痕（spec §4.6）：失败路径在 reportError 之前捕获原始证据
    // 闸门：--dry-run 零写盘契约优先（不跑子进程、无值得留的证据）——S8 评审 ① 裁定
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('unlink', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
