import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as clack from '@clack/prompts'
import semver from 'semver'
import { RemoteQueryError, queryLatestVersion } from '../core/remote.js'
import { decideUpgrade, type UpgradeDecision } from '../core/upgrade.js'
import { rewriteDepValue } from '../core/rewriter.js'
import { InstallError, buildInstallCommandLine, runInstall } from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import {
  ManifestParseError, WorkspaceNotFoundError, WorkspacePatternError,
  findDependents, findWorkspaceRoot, loadWorkspace, type Workspace,
} from '../core/workspace.js'
import { LpmConfigParseError, LpmStateParseError, buildRunTrace, readProjectConfig, readState, writeRunTrace } from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import type { LastRunTrace, LinkState, ProjectLpmConfig } from '../state/types.js'
import { traceFailure } from './run-trace.js'
import { reportError as reportKnownError } from './errors.js'
import { renderPlan, type PlanEntry, type PlanView } from './plan-view.js'

export interface UmdOptions { dryRun?: boolean; yes?: boolean }

/** U2：非 TTY 且无 --yes（spec §5） */
export class UmdInteractionError extends Error {
  constructor() {
    super('需逐库确认升级。\n下一步：改用 lpm umd --yes 直接更新，或 lpm umd --dry-run 查看预览')
    this.name = 'UmdInteractionError'
  }
}

interface UmdChange { manifestPath: string; pkgName: string; section: string; from: string; to: string }
interface UmdLibPlan { pkgName: string; latest: string; changes: UmdChange[] }
interface UmdPlan {
  rootDir: string
  pm: PackageManagerId
  libs: UmdLibPlan[]
  skipNotes: string[]
  queryNotes: string[]
}

function toRel(rootDir: string, abs: string): string {
  return relative(rootDir, abs).replaceAll('\\', '/')
}

function reportError(err: unknown): number {
  const KNOWN = [
    RemoteQueryError, UmdInteractionError, InstallError,
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError, LpmConfigParseError, LpmStateParseError,
  ]
  return reportKnownError(err, KNOWN)
}

/** 统一前置（spec §3 ①–②）：workspace + config；PM/state 由 runUmd 在空态检查后解析（② 先于 ④） */
async function umdPreflight(cwd: string): Promise<{
  rootDir: string; ws: Workspace; cfg: ProjectLpmConfig | null
}> {
  const rootDir = await findWorkspaceRoot(cwd)
  const ws = await loadWorkspace(rootDir)
  const cfg = await readProjectConfig(rootDir)
  return { rootDir, ws, cfg }
}

/** 计划构建（spec §3 ⑤–⑦）：只读 + 远程查询，零写盘。dry-run 与真实执行共用同一份。
 *  复杂度 31：多 lib 聚合 + 一致性判定，拆分属 E 类立项，暂标注豁免（同 link.ts buildLinkPlan 先例） */
// eslint-disable-next-line sonarjs/cognitive-complexity
async function buildUmdPlan(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, pm: PackageManagerId, st: LinkState | null,
): Promise<UmdPlan> {
  const skipNotes: string[] = []
  const queryNotes: string[] = []
  const linked = new Set(Object.keys(st?.links ?? {}))
  const byLib = new Map<string, { latest: string; changes: UmdChange[] }>()
  for (const name of Object.keys(cfg?.libs ?? {})) {
    if (linked.has(name)) { // 裁决 5：联调中整库跳过
      process.stdout.write(`已链接：${name}，跳过（联调中的库不更新）\n`)
      continue
    }
    let latest: string
    try { // 裁决 7：查询失败 → 警告跳过该库，不阻断其它
      latest = await queryLatestVersion(name, { cwd: rootDir })
    } catch (err) {
      if (err instanceof RemoteQueryError) {
        queryNotes.push(`查询 ${name} 远程版本失败，已跳过该库：${err.message}`)
        continue
      }
      throw err
    }
    const hits = await findDependents(ws, name)
    // §4.3 一致性：按 manifest 分组，全部 behind 且 next 相同才写
    const byManifest = new Map<string, Array<{ section: string; value: string; decision: UpgradeDecision }>>()
    for (const h of hits) {
      const rec = { section: h.section, value: h.currentValue, decision: decideUpgrade(h.currentValue, latest) }
      const g = byManifest.get(h.manifestPath)
      if (g === undefined) byManifest.set(h.manifestPath, [rec])
      else g.push(rec)
    }
    for (const [manifestPath, group] of byManifest) {
      const allBehind = group.every((r) => r.decision.kind === 'behind')
      const first = group[0]
      const next = allBehind && first !== undefined ? (first.decision as { kind: 'behind'; next: string }).next : null
      const sameNext = allBehind && next !== null && group.every(
        (r) => r.decision.kind === 'behind' && r.decision.next === next,
      )
      if (!allBehind || !sameNext) {
        const detail = group.map((r) => `${r.section}=${r.value}`).join('、')
        skipNotes.push(`${toRel(rootDir, manifestPath)} 的 ${name} 多段声明判定不一致（${detail}），已整体跳过——请手动对齐`)
        continue
      }
      let lib = byLib.get(name)
      if (lib === undefined) {
        lib = { latest, changes: [] }
        byLib.set(name, lib)
      }
      for (const r of group) {
        lib.changes.push({ manifestPath, pkgName: name, section: r.section, from: r.value, to: next })
      }
    }
  }
  const libs: UmdLibPlan[] = []
  for (const [pkgName, lib] of byLib) libs.push({ pkgName, latest: lib.latest, changes: lib.changes })
  return { rootDir, pm, libs, skipNotes, queryNotes }
}

function umdPlanView(plan: UmdPlan): PlanView {
  const entries: PlanEntry[] = []
  for (const lib of plan.libs) {
    const fileCount = new Set(lib.changes.map((c) => c.manifestPath)).size
    entries.push({
      kind: 'group',
      heading: `${lib.pkgName}：更新到 ${lib.latest}（${fileCount} 个文件 ${lib.changes.length} 处声明）`,
      lines: lib.changes.map((c) => `${toRel(plan.rootDir, c.manifestPath)}：${c.section}.${c.pkgName} ${c.from} → ${c.to}`),
    })
  }
  for (const n of plan.skipNotes) entries.push({ kind: 'line', text: n })
  for (const n of plan.queryNotes) entries.push({ kind: 'line', text: n })
  return { entries, install: { command: buildInstallCommandLine(plan.pm), verify: null }, watch: [] }
}

/** 执行（spec §3 ⑨–⑫）：写盘全部完成 → install 一次 → 验证 → 完成提示 */
async function executeUmdPlan(
  plan: UmdPlan, traceChanges: LastRunTrace['changes'], traceInstalls: LastRunTrace['installs'],
): Promise<number> {
  const { rootDir, pm, libs } = plan
  const allChanges = libs.flatMap((l) => l.changes)
  const byManifest = new Map<string, UmdChange[]>()
  for (const c of allChanges) {
    const g = byManifest.get(c.manifestPath)
    if (g === undefined) byManifest.set(c.manifestPath, [c])
    else g.push(c)
  }
  // ⑨ 先全部改写写完（§4.7 崩溃安全）
  for (const [manifestPath, changes] of byManifest) {
    const source = readFileSync(manifestPath, 'utf8')
    let content = source
    const seenPkg = new Set<string>()
    for (const c of changes) { // 同文件多 pkg 各改一次；rewriteDepValue 整包替换
      if (seenPkg.has(c.pkgName)) continue
      seenPkg.add(c.pkgName)
      content = rewriteDepValue(content, c.pkgName, c.to).content
    }
    writeTextFileAtomic(manifestPath, content)
    traceChanges.push({
      target: toRel(rootDir, manifestPath),
      action: 'rewrite-manifest',
      detail: changes.map((c) => `${c.section}.${c.pkgName}：${c.from} → ${c.to}`).join('；'),
    })
  }
  // ⑩ install 一次（Global Constraint 6/7：失败建议重跑 install 而非 umd——传 umd 向 retryAdvice，
  // 绝不走 runInstall 缺省的 link 向文案）
  await runInstall(
    rootDir,
    pm,
    `版本号已写入 package.json（语义已定）；修复报错后在 workspace 根重跑一次 ${buildInstallCommandLine(pm)}——不要重跑 lpm umd（已最新的库会跳过、不会触发安装）`,
  )
  traceInstalls.push({ command: buildInstallCommandLine(pm), ok: true, exitCode: 0 })
  // ⑪ 装后验证（尽力而为；缺失跳过不误报——spec 裁决 11）
  for (const lib of libs) {
    const p = join(rootDir, 'node_modules', lib.pkgName, 'package.json')
    if (!existsSync(p)) continue
    try {
      const installed = (JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version
      if (typeof installed === 'string' && semver.valid(installed) !== null && !semver.eq(installed, lib.latest)) {
        process.stderr.write(`警告：${lib.pkgName} 安装后版本为 ${installed}，与目标 ${lib.latest} 不一致——请在 workspace 根重跑一次 ${buildInstallCommandLine(pm)}\n`)
      }
    } catch {
      // 读不到就当没有
    }
  }
  // ⑫ 完成提示（install 命令动态——Global Constraint 8）
  process.stdout.write(`更新完成：${libs.length} 个库、${byManifest.size} 个文件、${allChanges.length} 处声明已更新版本号：\n`)
  for (const [manifestPath, changes] of byManifest) {
    process.stdout.write(`  ${toRel(rootDir, manifestPath)}:\n`)
    for (const c of changes) process.stdout.write(`    ${c.section}.${c.pkgName}：${c.from} → ${c.to}\n`)
  }
  process.stdout.write(`已执行 1 次安装：${buildInstallCommandLine(pm)}\n`)
  process.stdout.write('以上 package.json 已修改，请勿提交；如需回退：git checkout -- <受影响>/package.json 后重跑一次 install\n')
  return 0
}

export async function runUmd(opts: UmdOptions, cwd: string = process.cwd()): Promise<number> {
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, ws, cfg } = await umdPreflight(cwd)
    traceRoot = rootDir
    // ② 无已注册 lib → 空态提示（exit 0，spec §5）——在 PM 解析之前返回（spec §3 ② 先于 ④；
    // 无 config 且无 lockfile 的项目也应得到空态提示而非 PMUnresolvedError）
    if (Object.keys(cfg?.libs ?? {}).length === 0) {
      process.stdout.write('当前没有任何已注册的 lib。\n下一步：先 lpm link <路径> 注册\n')
      return 0
    }
    const pm = (await resolvePackageManager(rootDir, cfg?.packageManager)).pm
    tracePm = pm
    const st = await readState(rootDir)
    const plan = await buildUmdPlan(rootDir, ws, cfg, pm, st)
    for (const n of plan.queryNotes) process.stdout.write(`${n}\n`)
    for (const n of plan.skipNotes) process.stdout.write(`${n}\n`)
    // 无候选 → 说明（spec §4.5）
    if (plan.libs.length === 0) {
      process.stdout.write('没有需要更新的依赖。\n（已声明的版本范围均能装到最新版；若实际安装的版本滞后，请用 <pm> update <包名>）\n')
      return 0
    }
    // --dry-run 零写盘（spec §4.4）
    if (opts.dryRun === true) {
      process.stdout.write(renderPlan(umdPlanView(plan), 'dry-run'))
      return 0
    }
    // ⑧ 交互闸门：--yes 全过；TTY 逐库确认（session memory：聚合已保证每库一次）；非 TTY → 报错
    let approved: UmdLibPlan[]
    if (opts.yes === true) {
      approved = plan.libs
    } else if (!process.stdin.isTTY) {
      throw new UmdInteractionError()
    } else {
      process.stdout.write(renderPlan(umdPlanView(plan), 'preview'))
      approved = []
      for (const lib of plan.libs) {
        const fileCount = new Set(lib.changes.map((c) => c.manifestPath)).size
        const ok = await clack.confirm({
          message: `更新 ${lib.pkgName} 到 ${lib.latest}？（${fileCount} 个文件 ${lib.changes.length} 处声明）`,
          initialValue: false,
        })
        if (clack.isCancel(ok)) {
          process.stdout.write('已取消\n')
          return 1
        }
        if (ok === true) approved.push(lib)
      }
    }
    if (approved.length === 0) {
      process.stdout.write('未更新任何依赖\n')
      return 0
    }
    // 执行 + 成功留痕（Global Constraint 9）
    const code = await executeUmdPlan({ ...plan, libs: approved }, traceChanges, traceInstalls)
    await writeRunTrace(rootDir, buildRunTrace({
      command: 'umd',
      rootDir,
      packageManager: pm,
      changes: traceChanges,
      installs: traceInstalls,
      failure: null,
    }))
    return code
  } catch (err) {
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('umd', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    return reportError(err)
  }
}
