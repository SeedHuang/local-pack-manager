import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { execa } from 'execa'
import { LibCheckError, checkLib } from '../core/linkcheck.js'
import { InstallError, buildInstallCommandLine, detectLibPM, pmExecutable, runInstall, spawnBuildWatch, type WatchProcess } from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager } from '../core/pm.js'
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
  readProjectConfig,
  readState,
  writeLast,
  writeProjectConfig,
  writeState,
} from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'

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

const ABANDON = Symbol('abandon')

async function ternaryOriginal(
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

export async function runLink(targets: readonly string[], opts: LinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数
  if (targets.length === 0) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]\n')
    return 1
  }
  try {
    // A5 workspace
    const rootDir = await findWorkspaceRoot(cwd)
    const ws: Workspace = await loadWorkspace(rootDir)
    let cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
    // A4 PM
    const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
    const pm = pmResolution.pm
    if (pmResolution.source === 'detected') {
      process.stdout.write(`检测到包管理器：${pm}（未 lpm use 固化）\n`)
    }
    // state 预读（幂等判定 + 合并写基线）
    let st: LinkState | null = await readState(rootDir)

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
      }
      planUpserts.push({ key, rel: relPath, isNew })

      // E2 命中
      const hits: DepHit[] = await findDependents(ws, check.name)
      // E3 O5 零命中
      if (hits.length === 0) {
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
    if (aggregated.size === 0) {
      // 无改写：全已链接 / 全放弃（dry-run 下 abandon 不发生——E4 降级警告；此分支即「全部已链接」）
      if (opts.dryRun === true) {
        process.stdout.write('无待执行变更\n') // spec §4.4 K3：计划体为空 + 「无待执行变更」
      }
      return 0
    }

    // dry-run（K）：零写盘零子进程，打印执行计划
    if (opts.dryRun === true) {
      process.stdout.write('dry-run 执行计划（不落任何盘、不执行任何子进程）：\n')
      for (const u of planUpserts) {
        if (u.isNew || cfg?.libs[u.key] === undefined) process.stdout.write(`  注册 upsert：${u.key} → ${u.rel}（新增/更新）\n`)
      }
      for (const [mp, entry] of aggregated) {
        process.stdout.write(`  改写 ${toRel(rootDir, mp)}:\n`)
        for (const h of entry.hits) {
          process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}\n`)
        }
      }
      for (const k of planSkipped) process.stdout.write(`  已链接跳过：${k}\n`)
      for (const p of peerWarn) process.stdout.write(`  peer 警告：${p.rel}（${p.pkg}）\n`)
      process.stdout.write(`  install：${buildInstallCommandLine(pm)}（workspace 根）\n`)
      if (opts.watch === true) {
        for (const t of linkedTargets) process.stdout.write(`  watch：拉起 ${t.rel} 的 build:watch（${pmExecutable(detectLibPM(t.libDirAbs))} run build:watch）\n`)
      }
      return 0
    }

    // E6a state（合并单次写；linkedAt = S6 生成 ISO 8601）
    const newLinks: LinkState['links'] = { ...(st?.links ?? {}) }
    for (const p of pendingLinks) {
      newLinks[p.key] = { original: p.original, linkedAt: new Date().toISOString() }
    }
    await writeState(rootDir, { version: 1, links: newLinks })

    // E6b package.json（文本级原子写）
    for (const [mp, entry] of aggregated) {
      writeTextFileAtomic(mp, entry.content)
    }

    // E6c 单次 install
    await runInstall(rootDir, pm)

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
    return 0
  } catch (err) {
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
