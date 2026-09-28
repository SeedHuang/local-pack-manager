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
import { LOCAL_PROTOCOL_RE, readDepValues, restoreDepValue, type RewriteResult } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findWorkspaceRoot,
  loadWorkspace,
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
import { LinkArgumentError, LinkCancelledError, LinkInteractionError, resolveMonorepo, resolveTarget } from './link.js'
import { traceFailure } from './run-trace.js'

// unlink 直通版编排（S7 spec §4.4）。行为权威 = spec；崩溃安全顺序（PRD §9 行 306）：
// 先恢复文件 → install → 复验/--force → 才删 state（last 先写后删——评审 P1-1）。

export interface UnlinkOptions { all?: boolean; dryRun?: boolean }

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
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

/** C 条目校验（裁决 5）：original 为对象、非空、键值全非空 string；损坏 → LinkStateCorruptError
 *  （S8 §4.3：扩为导出，供 status/repair 复用条目结构校验；定义与行为零变化） */
export function validateEntry(key: string, entry: LinkState['links'][string] | undefined): Record<string, string> {
  if (entry === undefined) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 缺失。手工逃生三步：${ESCAPE_HATCH}`)
  }
  const o = entry.original
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 不是对象。手工逃生三步：${ESCAPE_HATCH}`)
  }
  const keys = Object.keys(o)
  if (keys.length === 0) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 为空对象。手工逃生三步：${ESCAPE_HATCH}`)
  }
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k]
    if (typeof v !== 'string' || v === '') {
      throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original["${k}"] 应为非空字符串。手工逃生三步：${ESCAPE_HATCH}`)
    }
  }
  return o as Record<string, string>
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
    // entity / link-elsewhere → ok（无 note）；unknown → ok + 注明
    out.push({ rel: toRel(rootDir, mp), nmRel, status: 'ok', note: probe.note })
  }
  return out
}

export async function runUnlink(targets: readonly string[], opts: UnlinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数（--all 除外——spec §4.1）
  if (targets.length === 0 && opts.all !== true) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm unlink <名字|路径>... [--all] [--dry-run]\n')
    return 1
  }
  // 运行留痕所需上下文（失败路径在 catch 中也要能定位 rootDir/pm）——S8 spec §4.6
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  // S8 运行留痕（spec §4.6）：本次**已落盘**的改动与子进程——成功/失败路径共用（失败时记已发生部分）
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    // A2 互斥（spec §5 #3）
    if (opts.all === true && targets.length > 0) {
      throw new LinkArgumentError('--all', '--all 与显式目标互斥')
    }
    // A workspace + PM（镜像 S6 A5）
    const rootDir = await findWorkspaceRoot(cwd)
    await loadWorkspace(rootDir) // 仅取校验副作用（WorkspacePatternError 等）——OCR：勿保留死绑定
    const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
    const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
    const pm = pmResolution.pm
    traceRoot = rootDir
    tracePm = pm
    if (pmResolution.source === 'detected') {
      process.stdout.write(`检测到包管理器：${pm}（未 lpm use 固化）\n`)
    }
    const st: LinkState | null = await readState(rootDir)
    // G5：--all 空 state → 无已链接项 exit 0（幂等不报错）
    if (opts.all === true && Object.keys(st?.links ?? {}).length === 0) {
      process.stdout.write('无已链接项\n')
      return 0
    }

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
        const registered = cfg?.libs !== undefined && Object.hasOwn(cfg.libs, raw)
        const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
        let key: string
        if (registered || !looksLikePath || raw.startsWith('@')) {
          key = raw
        } else {
          const rt = await resolveTarget(raw, cfg, rootDir, cwd)
          if (rt.source === 'name') {
            key = rt.key
          } else {
            const mr = await resolveMonorepo(rt.libDirAbs)
            key = mr.name !== '' ? mr.name : toRel(rootDir, mr.libDirAbs)
          }
        }
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
          const result: RewriteResult = restoreDepValue(agg.content, key, origValue)
          agg.content = result.content
          agg.changedCount += result.changedKeys.length
          totalChanged += result.changedKeys.length
          for (const h of values) {
            agg.hits.push({ manifestPath, pkgName: key, original: origValue, fromValue: h.value, section: h.section })
          }
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
            throw new LinkInteractionError('conflict-ternary', `检测到手动改动（${rel}：当前 ${representative} vs original ${origValue}），需交互确认。请手动处理该文件后重试，或先 lpm unlink --dry-run 查看`)
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
            const result = restoreDepValue(agg.content, key, origValue)
            agg.content = result.content
            agg.changedCount += result.changedKeys.length
            totalChanged += result.changedKeys.length
            for (const h of values) {
              agg.hits.push({ manifestPath, pkgName: key, original: origValue, fromValue: h.value, section: h.section })
            }
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

    // H dry-run（裁决 6；镜像 S6 K）
    if (opts.dryRun === true) {
      process.stdout.write('dry-run 执行计划（不落任何盘、不执行任何子进程）：\n')
      for (const [mp, agg] of aggregated) {
        if (agg.hits.length === 0) continue
        process.stdout.write(`  恢复 ${toRel(rootDir, mp)}:\n`)
        for (const h of agg.hits) {
          process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}\n`)
        }
      }
      for (const p of planIdempotent) process.stdout.write(`  已恢复跳过：${p.key}（${p.rel} 值已等于 original）\n`)
      for (const k of planSkipped) process.stdout.write(`  未链接跳过：${k}\n`)
      for (const c of planConflicts) process.stdout.write(`  冲突需确认：${c}——真实执行时将询问\n`)
      for (const m of planMissing) process.stdout.write(`  文件不存在警告：${m}\n`)
      const remainCount = (st?.links ? Object.keys(st.links).length : 0) - pendingDelete.length
      if (pendingDelete.length > 0) {
        if (remainCount === 0) {
          process.stdout.write(`  state：清空——last 记 ${JSON.stringify(Object.keys(st?.links ?? {}))} → 删 state 文件\n`)
        } else {
          for (const k of pendingDelete) process.stdout.write(`  state：删除 ${k}（剩余 ${remainCount} 条）\n`)
        }
        process.stdout.write(`  install：${buildInstallCommandLine(pm)}（workspace 根）\n`)
        process.stdout.write(`  复验：node_modules 实际指向（残留/缺失将 ${buildForceInstallCommandLine(pm)} 重建）\n`)
      }
      if (aggregated.size === 0 && pendingDelete.length === 0 && planConflicts.length === 0 && planMissing.length === 0 && planSkipped.length === 0) {
        process.stdout.write('  无待执行变更\n')
      }
      return 0
    }

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
          process.stdout.write(`警告：node_modules ${f.status === 'residue' ? `残留（${f.note ?? '软链残留'}）` : '缺失'}：${f.nmRel}——${buildForceInstallCommandLine(pm)} 重建\n`)
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
