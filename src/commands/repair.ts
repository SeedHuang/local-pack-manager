import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import {
  InstallError,
  buildForceInstallCommandLine,
  buildInstallCommandLine,
  runForceInstall,
  runInstall,
} from '../core/install.js'
import { probeNodeModules } from '../core/nmcheck.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import { ProtocolPathError, mapProtocol, readDepValues, rewriteDepValue } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findWorkspaceRoot,
  loadWorkspace,
  type DepHit,
} from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  buildRunTrace,
  deleteState,
  readProjectConfig,
  readState,
  writeProjectConfig,
  writeRunTrace,
  writeState,
} from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import type { LastRunTrace, LinkState, ProjectLpmConfig } from '../state/types.js'
import { ABANDON, ternaryOriginal } from './link.js'
import { isLocalish, scanLinkState, type EntryScan, type FileScan } from './status.js'
import { ESCAPE_HATCH } from './unlink.js'
import { traceFailure } from './run-trace.js'
import { reportError as reportKnownError } from './errors.js'

// repair 六族自修复编排（S8 spec §4.5）。行为权威 = spec §4.5 + 裁决 11–16。
// 写序（裁决 11）：声明改写 → install 恰一次 → 复验/--force → 档案对齐（state/config）→ 留痕。
// 档案最后动：前三段失败 → 档案零改动 → 重跑收敛（崩溃安全）。

interface RepairOptions { dryRun?: boolean }

/** 存在待修项但无法交互（非 TTY）——唯一入口（spec §4.3） */
class RepairInteractionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RepairInteractionError'
  }
}

/** 内部信号：用户在交互中被取消（与 spec §4.3 的 RepairInteractionError 分离——那是非 TTY 入口） */
class RepairCancelled extends Error {
  constructor() {
    super('已取消')
    this.name = 'RepairCancelled'
  }
}

const REPAIR_RETRY_ADVICE = `state 已保留（档案未改动），重跑 lpm repair 会重新收敛；${ESCAPE_HATCH}`

// 判定面单源（spec §9 自决 2）：isLocalish / BARE_PATH_RE 由 status.ts 提供，repair 经 import 复用
// （isLocalish 判定落在 planOrphan / verifyAll 的 probe.status 分支，此处仅为协议前缀剥离工具）
function stripProtocol(v: string): string { return v.replace(/^(link|file|portal):/, '') }
function toRel(rootDir: string, abs: string): string { return relative(rootDir, abs).replaceAll('\\', '/') }
function nmRelOf(rootDir: string, manifestPath: string, key: string): string {
  const rel = toRel(rootDir, dirname(manifestPath))
  return rel === '' ? `node_modules/${key}` : `${rel}/node_modules/${key}`
}
function safeRealpath(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

// ─────────────────────────── 计划结构 ───────────────────────────

interface RewriteAction { manifestPath: string; rel: string; content: string; detail: string }
interface InstallTarget { key: string; manifestPath: string; nmRel: string; want: 'link' | 'entity'; libReal: string | null }
interface DeleteAction { key: string; removeWhole: boolean; remaining: string[]; detail: string }
interface RegisterAction { key: string; rel: string; originalKey: string; originalValue: string }
interface OriginalUpdate { key: string; rel: string; value: string }

interface Plan {
  rewrites: RewriteAction[]
  needInstall: boolean
  installTargets: InstallTarget[]
  deletes: DeleteAction[]
  registers: RegisterAction[]
  originalUpdates: OriginalUpdate[]
  hints: string[]
  overwrites: string[]
  actions: number
}

interface RewriteAgg { manifestPath: string; rel: string; content: string; details: string[] }

// ─────────────────────────── 计划构建（统一前置判定）───────────────────────────

// 复杂度 71：六族判定 + 逐文件三态聚合，拆分属 E 类立项，暂标注豁免
// eslint-disable-next-line sonarjs/cognitive-complexity
async function buildPlan(
  rootDir: string,
  pm: PackageManagerId,
  scan: { entries: EntryScan[] },
  interactive: boolean,
  st: LinkState | null,
): Promise<Plan> {
  const plan: Plan = {
    rewrites: [], needInstall: false, installTargets: [], deletes: [], registers: [],
    originalUpdates: [], hints: [], overwrites: [], actions: 0,
  }
  const agg = new Map<string, RewriteAgg>()
  const targetSeen = new Set<string>()

  const addTarget = (t: InstallTarget): void => {
    const id = `${t.key}\u0000${t.manifestPath}`
    if (targetSeen.has(id)) return
    targetSeen.add(id)
    plan.installTargets.push(t)
    plan.needInstall = true
  }

  const applyRewrite = (f: FileScan, key: string, targetValue: string): void => {
    let a = agg.get(f.manifestPath)
    if (a === undefined) {
      a = { manifestPath: f.manifestPath, rel: f.manifest, content: readFileSync(f.manifestPath, 'utf8'), details: [] }
      agg.set(f.manifestPath, a)
    }
    const values = readDepValues(a.content, key)
    const res = rewriteDepValue(a.content, key, targetValue)
    if (res.content === a.content) return
    a.content = res.content
    const froms = values.length > 0 ? values : [{ section: 'dependencies', value: '' }]
    for (const v of froms) a.details.push(`${v.section}.${key}：${v.value} → ${targetValue}`)
  }

  for (const entry of scan.entries) {
    const key = entry.key
    const original = entry.original ?? {}

    // corrupt（裁决 12）：结构损坏 → 删条目 + 提示重跑（下一轮以孤儿身份进入修复流程）
    if (entry.issues.includes('corrupt')) {
      // 原值兜底展示（Minor ③ / 裁决 17 第二道保险）：validateEntry 抛错后 entry.original 为 undefined，
      // 直接序列化 state 里该条目的原始值，避免「原记录将丢失：{}」使展示失效
      const rawEntry = st !== null && Object.hasOwn(st.links, key) ? (st.links as Record<string, unknown>)[key] : undefined
      const memo = JSON.stringify(rawEntry ?? original)
      plan.deletes.push({
        key, removeWhole: true, remaining: [],
        detail: `删除损坏条目 ${key}（原记录将丢失：${memo}）；若声明仍是本地链接，重跑 lpm repair 可继续修复`,
      })
      continue
    }

    const staleRels: string[] = []

    for (const f of entry.files) {
      const recorded = Object.hasOwn(original, f.manifest)

      // stale-record：文件里已无该依赖 / 文件不存在（两者 field 表现同为 declared === ''）
      if (recorded && f.declared === '') { staleRels.push(f.manifest); continue }

      // drifted（裁决 14/15）：档案记着 + 声明是正式版本号（判定单源 isLocalish——裸路径亦算本地链接，Important ②）
      if (recorded && f.declared !== '' && !isLocalish(f.declared)) {
        const origVal = original[f.manifest] ?? ''
        // 可修性前置筛查（裁决 15）：lib 绝对路径不可得 → 不入计划，降级为提示（PF-1）
        if (entry.libDirAbs === null || entry.libReal === null) {
          // 两种成因分文案（Minor ⑤）：注册缺失 vs 注册在、但目录已不存在/不可解析（后者按原提示会白跑）
          const cause = entry.libDirAbs === null
            ? '注册缺失：请先 lpm link <路径> 重建注册'
            : '注册指向的目录不存在或不可解析：请确认路径后重跑（仍无法解决则 lpm link <路径> 重建注册）'
          const pointing = f.nm.realTarget !== undefined ? `（node_modules 当前指向 ${f.nm.realTarget}）` : ''
          plan.hints.push(`⚠️ ${key} 处于漂移，${cause}${pointing}；未纳入本次修复计划`)
          continue
        }
        const targetValue = mapProtocol(pm, entry.libDirAbs, dirname(f.manifestPath))
        if (f.declared !== origVal) {
          // 用户手改过（裁决 14 防静默覆盖）→ 先停下二选一
          plan.overwrites.push(`${f.manifest}：声明当前值 ${f.declared}（与档案原值 ${origVal} 不一致，疑似手动改动）将被替换为 ${targetValue}`)
          let keepCurrent = false
          if (interactive) {
            const picked = await clack.select({
              message: `${key}（${f.manifest}）声明 ${f.declared} 与档案原值 ${origVal} 不一致，选择处理方式`,
              options: [
                { value: 'keep-current', label: `保留当前值 ${f.declared}（写入档案为新的 original）` },
                { value: 'keep-original', label: `丢弃当前值，恢复档案原值 ${origVal}` },
              ],
            })
            if (clack.isCancel(picked)) throw new RepairCancelled()
            keepCurrent = picked === 'keep-current'
          } else {
            plan.hints.push(`⚠️ ${key}（${f.manifest}）声明值 ${f.declared} 与档案原值 ${origVal} 不一致：真实执行时将询问「保留当前值 / 恢复原 original」`)
          }
          if (keepCurrent) plan.originalUpdates.push({ key, rel: f.manifest, value: f.declared })
        }
        applyRewrite(f, key, targetValue)
        addTarget({ key, manifestPath: f.manifestPath, nmRel: nmRelOf(rootDir, f.manifestPath, key), want: 'link', libReal: entry.libReal })
        continue
      }

      // install-ineffective：档案记着 + 声明是本地链接 + 目录不对 → 仅并入 install/复验
      // （判定与上方漂移同源：isLocalish——裸路径声明也归此支，Important ②）
      if (recorded && f.declared !== '' && isLocalish(f.declared) && f.nm.status !== 'link-to-lib') {
        addTarget({ key, manifestPath: f.manifestPath, nmRel: nmRelOf(rootDir, f.manifestPath, key), want: 'link', libReal: entry.libReal })
        continue
      }

      // orphan：无档案 + 声明是本地链接
      if (!recorded && f.declared !== '' && isLocalish(f.declared)) {
        await planOrphan(plan, entry, f, rootDir, interactive, addTarget, applyRewrite)
        continue
      }

      // stale-link：无档案 + 声明是正式版本号 + 目录是链接
      if (!recorded && f.declared !== '' && !isLocalish(f.declared) && (f.nm.status === 'link-to-lib' || f.nm.status === 'link-elsewhere')) {
        plan.overwrites.push(`${f.manifest}：node_modules/${key} 当前指向 ${f.nm.realTarget ?? '未知'}（将被 install 重建为 registry 实体）`)
        addTarget({ key, manifestPath: f.manifestPath, nmRel: nmRelOf(rootDir, f.manifestPath, key), want: 'entity', libReal: entry.libReal })
        continue
      }
    }

    // stale-record 文件级出局 / 整条全失效 → 删整条（裁决 17 三道保险：原值进计划展示 + 留痕 detail）
    if (staleRels.length > 0) {
      const remaining = Object.keys(original).filter((k) => !staleRels.includes(k))
      const memo = JSON.stringify(Object.fromEntries(staleRels.map((k) => [k, original[k]])))
      if (remaining.length === 0) {
        plan.deletes.push({
          key, removeWhole: true, remaining: [],
          detail: `删除整个失效条目 ${key}（原记录将丢失：${JSON.stringify(original)}）`,
        })
      } else {
        plan.deletes.push({
          key, removeWhole: false, remaining,
          detail: `删除失效记录 ${key}：${staleRels.join('、')}（原值将丢失：${memo}；剩余记录：${remaining.join('、')}）`,
        })
      }
    }
  }

  plan.rewrites = [...agg.values()].map((a) => ({ manifestPath: a.manifestPath, rel: a.rel, content: a.content, detail: a.details.join('；') }))
  // 计数口径（Minor ⑥）：install 只计 1——无论合并了几个 installTarget，实际只跑一次子进程
  plan.actions = plan.rewrites.length + (plan.needInstall ? 1 : 0) + plan.deletes.length + plan.registers.length + plan.originalUpdates.length
  return plan
}

/** 孤儿（裁决 6/16）：先取原值（兄弟声明 → ternaryOriginal 的 git HEAD / 手动输入 / 放弃），再令用户二选一 */
async function planOrphan(
  plan: Plan,
  entry: EntryScan,
  f: FileScan,
  rootDir: string,
  interactive: boolean,
  addTarget: (t: InstallTarget) => void,
  applyRewrite: (f: FileScan, key: string, targetValue: string) => void,
): Promise<void> {
  const key = entry.key
  // ② 前置校验（裁决 16）：lib 目录 = 从声明值倒推（孤儿未注册，不能走 cfg）
  const libDirCandidate = resolve(dirname(f.manifestPath), stripProtocol(f.declared))
  const dirValid = existsSync(libDirCandidate) && existsSync(resolve(libDirCandidate, 'package.json'))

  // 原值三级来源（三个分支均赋值或 return，走到使用时必已赋值）
  let original: string | null
  let sourceNote: string
  const sibling = siblingOriginal(entry, f)
  if (sibling !== null) {
    original = sibling.value
    sourceNote = sibling.source
  } else if (interactive) {
    const got = await ternaryOriginal(rootDir, key, key, hitsOf(entry))
    if (got === ABANDON) {
      plan.hints.push(`已放弃：${key}（未取到原值，本次不改动）`)
      return
    }
    const v = got.get(f.manifestPath)
    if (v === undefined || v === '') {
      plan.hints.push(`已放弃：${key}（未取到原值，本次不改动）`)
      return
    }
    original = v
    sourceNote = 'git HEAD / 手动输入'
  } else {
    plan.hints.push(`⚠️ ${key}（${f.manifest}）是非 lpm 管理的本地链接：真实执行时将询问「恢复正式版本 / 纳入 lpm 管理」`)
    return
  }

  // 取不到原值 → 不提供选项②（否则将来 unlink 会「恢复」成链接值，永久丢失——S6 E4）
  const options: Array<{ value: string; label: string }> = []
  options.push({ value: 'restore-registry', label: `恢复正式版本 ${original}（来源：${sourceNote}）` })
  if (dirValid) options.push({ value: 'adopt', label: `纳入 lpm 管理（注册 ${toRel(rootDir, libDirCandidate)}）` })

  let picked = 'restore-registry'
  if (interactive) {
    const p = await clack.select({ message: `检测到孤儿 ${key}（${f.manifest}），选择处理方式`, options })
    if (clack.isCancel(p)) throw new RepairCancelled()
    picked = String(p)
  }

  if (picked === 'adopt') {
    // 注册 upsert + 补档案条目（original = 原值，声明不动）
    const relDir = toRel(rootDir, dirname(f.manifestPath))
    plan.registers.push({
      key,
      rel: toRel(rootDir, libDirCandidate),
      originalKey: relDir === '' ? 'package.json' : `${relDir}/package.json`,
      originalValue: original,
    })
    // ② 后按探测结果并入 install（裁决 16）：非 link-to-lib 则触发 install + 复验
    const libReal = safeRealpath(libDirCandidate)
    const probe = probeNodeModules(f.manifestPath, key, libReal)
    if (probe.status !== 'link-to-lib') {
      addTarget({ key, manifestPath: f.manifestPath, nmRel: nmRelOf(rootDir, f.manifestPath, key), want: 'link', libReal })
    }
    return
  }

  // restore-registry：写回原值 + 并入 install
  plan.overwrites.push(`${f.manifest}：${key} 当前 ${f.declared} 将恢复为 ${original}`)
  applyRewrite(f, key, original)
  addTarget({ key, manifestPath: f.manifestPath, nmRel: nmRelOf(rootDir, f.manifestPath, key), want: 'entity', libReal: entry.libReal })
}

/** 一级来源：同库其他声明文件中的正式版本号（唯一值才采用；不一致则降级——裁决 6） */
function siblingOriginal(entry: EntryScan, self: FileScan): { value: string; source: string } | null {
  const byValue = new Map<string, string[]>()
  for (const f of entry.files) {
    if (f.manifest === self.manifest) continue
    if (f.declared === '' || isLocalish(f.declared)) continue
    const arr = byValue.get(f.declared)
    if (arr === undefined) byValue.set(f.declared, [f.manifest])
    else arr.push(f.manifest)
  }
  if (byValue.size !== 1) return null // 0 → 无；≥2 → 兄弟值不一致，不采用
  const [value, sources] = [...byValue.entries()][0]
  return { value, source: `${sources.join('、')} 的声明` }
}

function hitsOf(entry: EntryScan): DepHit[] {
  const hits: DepHit[] = []
  for (const f of entry.files) {
    if (f.declared === '') continue
    hits.push({ manifestPath: f.manifestPath, section: (f.sections[0] ?? 'dependencies') as DepHit['section'], currentValue: f.declared })
  }
  return hits
}

// ─────────────────────────── 计划展示（三类信息必须齐全）───────────────────────────

function printPlan(plan: Plan, pm: PackageManagerId, dryRun: boolean): void {
  process.stdout.write(dryRun ? 'repair dry-run 执行计划（不落任何盘、不执行任何子进程）：\n' : '修复计划：\n')
  for (const h of plan.hints) process.stdout.write(`  ${h}\n`)
  // ① 每个文件的改写明细（原值 → 新值）
  for (const r of plan.rewrites) {
    process.stdout.write(`  改写 ${r.rel}:\n`)
    for (const d of r.detail.split('；')) if (d !== '') process.stdout.write(`    ${d}\n`)
  }
  // ② 将被覆盖的当前值（残留链接当前指向 / 漂移被替换的手改值）
  for (const o of plan.overwrites) process.stdout.write(`  将被覆盖的当前值：${o}\n`)
  // ③ 不可逆的档案动作（条目/记录删除，注明 original 将丢失）
  for (const d of plan.deletes) process.stdout.write(`  不可逆档案动作：${d.detail}\n`)
  for (const reg of plan.registers) process.stdout.write(`  注册 upsert：${reg.key} → ${reg.rel}（档案 original：${reg.originalKey}=${reg.originalValue}）\n`)
  for (const u of plan.originalUpdates) process.stdout.write(`  档案更新：${u.key} 的 ${u.rel} original → ${u.value}\n`)
  if (plan.needInstall) {
    process.stdout.write(`  install：${buildInstallCommandLine(pm)}（workspace 根）\n`)
    process.stdout.write(`  复验：node_modules 实际指向（残留/缺失将 ${buildForceInstallCommandLine(pm)} 重建）\n`)
  }
}

// ─────────────────────────── 执行（写序 = 裁决 11）───────────────────────────

function verifyAll(targets: InstallTarget[]): Array<{ t: InstallTarget; ok: boolean }> {
  return targets.map((t) => {
    const probe = probeNodeModules(t.manifestPath, t.key, t.libReal)
    // unknown（期望真实路径不可解析）→ 无法比对，不触发 --force（S7 惯例 / spec 自洽确认区）
    let ok: boolean
    if (probe.status === 'unknown') ok = true
    else if (t.want === 'entity') ok = probe.status === 'entity'
    else ok = probe.status === 'link-to-lib'
    return { t, ok }
  })
}

// 复杂度 57：写序五段（改写/install/复验/档案/留痕）多步校验，拆分属 E 类立项，暂标注豁免
// eslint-disable-next-line sonarjs/cognitive-complexity
async function execute(
  plan: Plan,
  rootDir: string,
  pm: PackageManagerId,
  cfg: ProjectLpmConfig | null,
  st: LinkState | null,
  traceChanges: LastRunTrace['changes'],
  traceInstalls: LastRunTrace['installs'],
): Promise<number> {
  // 第一段：声明改写（文本级保真）
  for (const a of plan.rewrites) {
    writeTextFileAtomic(a.manifestPath, a.content)
    traceChanges.push({ target: a.rel, action: 'rewrite-manifest', detail: a.detail })
  }

  // 第二段：install 恰一次（存在改写 / install-ineffective / stale-link / 孤儿②链接未生效）
  if (plan.needInstall) {
    await runInstall(rootDir, pm, REPAIR_RETRY_ADVICE)
    traceInstalls.push({ command: buildInstallCommandLine(pm), ok: true, exitCode: 0 })
  }

  // 第三段：复验 → 残留/缺失则 --force 重建恰一次 → 再复验一次
  if (plan.needInstall) {
    const bad = verifyAll(plan.installTargets).filter((v) => !v.ok)
    if (bad.length > 0) {
      for (const b of bad) process.stdout.write(`警告：node_modules 复验未通过：${b.t.nmRel}——${buildForceInstallCommandLine(pm)} 重建\n`)
      await runForceInstall(rootDir, pm, REPAIR_RETRY_ADVICE)
      traceInstalls.push({ command: buildForceInstallCommandLine(pm), ok: true, exitCode: 0 })
      for (const v of verifyAll(plan.installTargets)) {
        if (!v.ok) process.stderr.write(`警告：node_modules 复验未通过：${v.t.nmRel}；lpm status 可进一步诊断\n`)
      }
    }
  }

  // 第四段：档案对齐（state/config）——档案最后动
  const stateChanged = plan.deletes.length > 0 || plan.registers.length > 0 || plan.originalUpdates.length > 0
  if (stateChanged) {
    const links: LinkState['links'] = {}
    const srcLinks = (st?.links ?? {}) as Record<string, unknown>
    for (const k of Object.keys(srcLinks)) {
      const e = srcLinks[k]
      const obj = e !== null && typeof e === 'object' && !Array.isArray(e) ? (e as { original?: unknown; linkedAt?: unknown }) : null
      const origRaw = obj?.original
      const orig = origRaw !== null && typeof origRaw === 'object' && !Array.isArray(origRaw) ? { ...(origRaw as Record<string, string>) } : {}
      links[k] = { original: orig, linkedAt: typeof obj?.linkedAt === 'string' ? obj.linkedAt : new Date().toISOString() }
    }
    for (const d of plan.deletes) {
      if (d.removeWhole) {
        delete links[d.key]
      } else if (links[d.key] !== undefined) {
        const rem: Record<string, string> = {}
        for (const k of Object.keys(links[d.key].original)) if (d.remaining.includes(k)) rem[k] = links[d.key].original[k]
        links[d.key] = { ...links[d.key], original: rem }
      }
      traceChanges.push({ target: d.key, action: 'delete-entry', detail: d.detail })
    }
    for (const u of plan.originalUpdates) {
      if (links[u.key] !== undefined) links[u.key] = { ...links[u.key], original: { ...links[u.key].original, [u.rel]: u.value } }
      traceChanges.push({ target: u.key, action: 'write-state', detail: `更新档案 original：${u.rel} → ${u.value}` })
    }
    for (const reg of plan.registers) {
      // 按键合并（Important ①）：同一库可被多个成员目录以 link: 声明并都选「纳入管理」——
      // 整体赋值会让后写覆盖先写、只有一个文件的原值进档案（unlink 时另一个永久停在 link:）
      links[reg.key] = {
        original: { ...(links[reg.key]?.original ?? {}), [reg.originalKey]: reg.originalValue },
        linkedAt: new Date().toISOString(),
      }
      traceChanges.push({ target: reg.key, action: 'upsert-registration', detail: `纳入管理：注册 ${reg.key} → ${reg.rel}；档案 original：${reg.originalKey}=${reg.originalValue}` })
    }
    if (Object.keys(links).length === 0) await deleteState(rootDir)
    else await writeState(rootDir, { version: 1, links })
  }
  if (plan.registers.length > 0) {
    const next: ProjectLpmConfig = cfg ?? { version: 1, libs: {} }
    next.libs = { ...(cfg?.libs ?? {}) }
    for (const reg of plan.registers) next.libs[reg.key] = reg.rel
    await writeProjectConfig(rootDir, next)
  }

  // 第五段：留痕（成功）
  await writeRunTrace(rootDir, buildRunTrace({
    command: 'repair',
    rootDir,
    packageManager: pm,
    changes: traceChanges,
    installs: traceInstalls,
    failure: null,
  }))
  return 0
}

function reportError(err: unknown): number {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    ProtocolPathError, InstallError, RepairInteractionError,
  ]
  return reportKnownError(err, KNOWN)
}

/** 退出码：0 完成（含无异常 / 仅提示）；1 失败或放弃 */
export async function runRepair(opts: RepairOptions, cwd: string = process.cwd()): Promise<number> {
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const rootDir = await findWorkspaceRoot(cwd)
    const ws = await loadWorkspace(rootDir)
    const cfg = await readProjectConfig(rootDir)
    const { pm } = await resolvePackageManager(rootDir, cfg?.packageManager)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)
    const scan = await scanLinkState(rootDir, ws, cfg, st)
    // ① 非 TTY 下绝不进入交互：buildPlan(interactive=true) 在有需拍板分支时会自行调 clack.select，
    //   非 TTY 的 select Promise 永不 resolve → 未决顶层 await → exit 13 + 半张菜单。
    //   故 interactive 只在「非 dry-run 且 TTY」时为真；非 TTY 以非交互模式算计划（可产出 hints），
    //   随后由下方 isTTY 闸门统一拒绝（有可执行动作 → RepairInteractionError exit 1；仅 hints → exit 0）。
    const interactive = opts.dryRun !== true && process.stdin.isTTY === true
    const plan = await buildPlan(rootDir, pm, scan, interactive, st)

    if (plan.actions === 0) {
      // PF-1：可执行动作为空但有提示 → 先打印提示（不可修的异常不得伪装成「无异常」）
      if (plan.hints.length > 0) {
        for (const h of plan.hints) process.stdout.write(`${h}\n`)
        return 0
      }
      process.stdout.write('无异常，无需修复\n')
      return 0
    }
    if (opts.dryRun === true) {
      printPlan(plan, pm, true)
      return 0
    }
    if (!process.stdin.isTTY) {
      throw new RepairInteractionError('需交互确认修复计划。\n下一步：改用 lpm repair --dry-run 查看计划')
    }
    printPlan(plan, pm, false)
    // 确认语口径（Minor ⑥）：install 计 1；档案动作按条目数——与实际子进程数一致（不再把一次 install 拆成 N 项）
    const recordActions = plan.deletes.length + plan.registers.length + plan.originalUpdates.length
    const ok = await clack.confirm({
      message: `执行以上修复计划？（改写 ${plan.rewrites.length} 个文件、处理 ${recordActions} 条档案记录、执行 ${plan.needInstall ? 1 : 0} 次安装）`,
      initialValue: false,
    })
    if (clack.isCancel(ok) || ok !== true) throw new RepairCancelled()
    return await execute(plan, rootDir, pm, cfg, st, traceChanges, traceInstalls)
  } catch (err) {
    // 失败/取消路径也写留痕（spec §4.6：命令收尾成功与失败都写）；--dry-run 零写盘契约优先
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('repair', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof RepairCancelled) {
      process.stdout.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
