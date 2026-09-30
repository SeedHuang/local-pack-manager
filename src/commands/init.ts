import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { stripBom } from '../util.js'
import { findWorkspaceRoot, loadWorkspace } from '../core/workspace.js'
import { readProjectConfig, LpmConfigParseError } from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import { WorkspaceNotFoundError, ManifestParseError } from '../core/workspace.js'
import {
  InitAlreadyInjectedError,
  InitConfigNotFoundError,
  InitConfigShapeError,
  InitHostPkgError,
  InitIncompleteMarkerError,
  InitInteractionError,
  InitKeyNotObjectError,
  InitNotInjectedError,
  InitRootError,
  buildAliasMap,
  buildRootValue,
  findHostConfig,
  findHostConfigInWorkspace,
  findMarker,
  hasTopLevelKeys,
  injectAdaptation,
  removeFragment,
} from '../core/utoopack.js'
import { reportError as reportKnownError } from './errors.js'

export interface InitOptions { dryRun?: boolean }

// ── diff 预览（spec §4.7；只 diff 对象体区间）──
function printInjectDiff(hostPath: string, source: string, after: string, mode: 'inject' | 'remove', dryRun: boolean): void {
  const cmd = mode === 'inject' ? 'init' : 'uninit'
  let title: string
  if (dryRun) {
    title = `${cmd} dry-run 执行计划（不落任何盘、不执行任何子进程）：`
  } else {
    title = mode === 'inject' ? '注入计划：' : '摘除计划：'
  }
  process.stdout.write(`${title}\n`)
  process.stdout.write(`  文件：${hostPath}\n`)
  const beforeLines = source.split('\n')
  const afterLines = after.split('\n')
  let s = 0
  while (s < beforeLines.length && s < afterLines.length && beforeLines[s] === afterLines[s]) s++
  let eB = beforeLines.length - 1
  let eA = afterLines.length - 1
  while (eB >= s && eA >= s && beforeLines[eB] === afterLines[eA]) { eB--; eA-- }
  for (let i = s; i <= eB; i++) process.stdout.write(`- ${beforeLines[i]}\n`)
  for (let i = s; i <= eA; i++) process.stdout.write(`+ ${afterLines[i]}\n`)
}

function reportError(err: unknown): number {
  const KNOWN = [
    InitConfigNotFoundError, InitConfigShapeError, InitRootError, InitHostPkgError, InitInteractionError,
    InitAlreadyInjectedError, InitNotInjectedError, InitIncompleteMarkerError, InitKeyNotObjectError,
    WorkspaceNotFoundError, ManifestParseError, LpmConfigParseError,
  ]
  return reportKnownError(err, KNOWN)
}

async function ensureInitPreconditions(cwd: string): Promise<{ hostPath: string; source: string }> {
  const hostPath = findHostConfig(cwd)
  const source = stripBom(readFileSync(hostPath, 'utf8'))
  return { hostPath, source }
}

/** 注入计算核心（runInit / autoInitAfterLink 共用，防两处漂移）：读配置 → 算 root/alias → 生成注入后文本。
 *  libs 为空 → libsEmpty（调用方各自处理文案与返回值）。 */
async function computeInjectionPlan(
  source: string,
  cwd: string,
  rootDir: string,
): Promise<
  | { libsEmpty: true }
  | { libsEmpty: false; libDirs: string[]; root: string; alias: Record<string, string>; skipped: string[]; after: string; hasShadow: boolean }
> {
  const cfg = await readProjectConfig(rootDir)
  const libRels = Object.values(cfg?.libs ?? {})
  if (libRels.length === 0) return { libsEmpty: true }
  const libDirs = libRels.map((rel) => resolve(rootDir, rel))
  const root = buildRootValue(cwd, libDirs)
  const { alias, skipped } = buildAliasMap(cwd, rootDir, libDirs)
  const hasShadow = hasTopLevelKeys(source, ['utoopack', 'alias'])
  const after = injectAdaptation(source, root, alias)
  return { libsEmpty: false, libDirs, root, alias, skipped, after, hasShadow }
}

/** 注入完成提示（runInit / autoInitAfterLink 共用同一文案块，防漂移；extraHint 插在「如需还原」前） */
function printInjectionSummary(
  headline: string,
  hostPath: string,
  libDirs: string[],
  root: string,
  alias: Record<string, string>,
  skipped: string[],
  extraHint?: string,
): void {
  process.stdout.write(`${headline}：${hostPath}\n`)
  process.stdout.write(`  root：${root}（覆盖 ${libDirs.length} 个已注册 lib 的公共祖先）\n`)
  const aliasCount = Object.keys(alias).length
  if (aliasCount > 0) process.stdout.write(`  dedupe：${aliasCount} 个 peer（${Object.keys(alias).join('、')}）\n`)
  else process.stdout.write('  未检测到需要 dedupe 的 peer（lib peer ∩ 宿主直接依赖 为空），仅注入 root\n')
  if (skipped.length > 0) process.stdout.write(`  提示：以下 peer 已声明但宿主/workspace 均未安装，未注入 alias（${skipped.join('、')}）\n`)
  if (extraHint !== undefined) process.stdout.write(`${extraHint}\n`)
  process.stdout.write('如需还原配置（摘除注入片段），运行 lpm uninit。\n')
}

/** 摘除完成提示（runUninit / autoUninitAfterUnlinkAll 共用同一行，防漂移；headline 区分「已摘除/已自动摘除」） */
function printRemovalSummary(headline: string, hostPath: string): void {
  process.stdout.write(`${headline}：${hostPath}（宿主原有 utoopack/alias 配置已还原）\n`)
}

export async function runInit(cwd: string = process.cwd(), opts: InitOptions = {}): Promise<number> {
  try {
    const { hostPath, source } = await ensureInitPreconditions(cwd)
    const marker = findMarker(source)
    // OCR L4：不完整标记（有 start 无 end）与完整标记分治——init 也报 I8，避免 I6 的「先 uninit」路径撞 I8
    if (marker !== null) {
      if (!marker.complete) throw new InitIncompleteMarkerError()
      throw new InitAlreadyInjectedError()
    }
    const rootDir = await findWorkspaceRoot(cwd)
    const plan = await computeInjectionPlan(source, cwd, rootDir)
    if (plan.libsEmpty) {
      process.stdout.write('当前没有任何已注册的 lib。\n下一步：先 lpm link <路径> 注册后再 init\n')
      return 0
    }
    const { libDirs, root, alias, skipped, after, hasShadow } = plan
    // OCR M1：遮蔽判定收窄到对象体顶层键（不再全文件子串扫描——注释/webpack resolve.alias 等不误报）
    // S14 方案 A：宿主已有同名键 → 合并进该键内部（不再追加新键规避 TS1117/2783），无遮蔽覆盖
    if (hasShadow) process.stdout.write('提示：检测到宿主已有 utoopack/alias 配置，已合并进宿主键；uninit 后可还原\n')
    if (opts.dryRun === true) { printInjectDiff(hostPath, source, after, 'inject', true); return 0 }
    if (process.stdin.isTTY !== true) throw new InitInteractionError('init')
    printInjectDiff(hostPath, source, after, 'inject', false)
    const ok = await clack.confirm({ message: `执行以上注入？（写入 ${hostPath}）`, initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    writeTextFileAtomic(hostPath, after)
    printInjectionSummary('已注入 utoopack 适配片段', hostPath, libDirs, root, alias, skipped, '若 lib 后续新增 peer，请重跑 lpm init 重新注入。')
    return 0
  } catch (err) {
    return reportError(err)
  }
}

export async function runUninit(cwd: string = process.cwd(), opts: InitOptions = {}): Promise<number> {
  try {
    const { hostPath, source } = await ensureInitPreconditions(cwd)
    const m = findMarker(source)
    if (m === null) throw new InitNotInjectedError()
    const after = removeFragment(source) // 不完整标记在内部抛 InitIncompleteMarkerError
    if (opts.dryRun === true) { printInjectDiff(hostPath, source, after, 'remove', true); return 0 }
    if (process.stdin.isTTY !== true) throw new InitInteractionError('uninit')
    printInjectDiff(hostPath, source, after, 'remove', false)
    const ok = await clack.confirm({ message: `执行以上摘除？（写入 ${hostPath}）`, initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    writeTextFileAtomic(hostPath, after)
    printRemovalSummary('已摘除 utoopack 适配片段', hostPath)
    return 0
  } catch (err) {
    return reportError(err)
  }
}

// ─────────────────────────── 自动联动（S14：link/unlink 成功后自动 init/uninit）───────────────────────────

/**
 * 在 workspace 中定位 umi 宿主（成员级，含根）。link/unlink 运行在 workspace 根，
 * 宿主可能是成员子包（如 web/.umirc.ts）——复用 findHostConfigInWorkspace（S13 单源）。
 */
export async function locateHostConfigInWs(rootDir: string): Promise<{ dir: string; hostPath: string } | null> {
  const ws = await loadWorkspace(rootDir)
  return findHostConfigInWorkspace(ws)
}

/**
 * link 执行路径后自愈注入（非交互，含「计划为空」的空跑）：workspace 内找到 umi 宿主 + 未注入 → 直接写入。
 * 复用 S13 已冻结的原语（root/alias 计算、文本级注入），**不经过 runInit 的交互闸门**。
 * 失败不抛错——联动是附加动作，link 主流程已完成，失败只提示用户手动 lpm init。
 * @returns 注入结果（供调用方决定是否打印提示）
 */
export async function autoInitAfterLink(rootDir: string): Promise<{ injected: boolean; hostPath?: string; reason?: string; error?: Error }> {
  try {
    const host = await locateHostConfigInWs(rootDir)
    if (host === null) return { injected: false, reason: 'no-umi-host' } // 非 umi 项目，跳过
    const { dir: cwd, hostPath } = host
    const source = stripBom(readFileSync(hostPath, 'utf8'))
    const marker = findMarker(source)
    // OCR：不完整标记绝不自动改写（与 uninit 侧 I8 铁律对称）
    if (marker !== null && !marker.complete) {
      process.stderr.write('警告：检测到不完整的 lpm 注入标记（缺结束标记），已跳过自动注入。\n')
      process.stderr.write('下一步：请手工删除 config 中残留的 /* lpm-inject:start */ 后重试\n')
      return { injected: false, hostPath, reason: 'incomplete-marker' }
    }
    // OCR 幂等增强：已注入 ≠ 免检——先把旧标记段摘除还原宿主原配置，再按当前注册全集重算期望态；
    // 与现文件一致 → 幂等跳过（reason=already-injected）；漂移（如新增 peer 需 dedupe、root 变化）→ 重注。
    const base = marker !== null ? removeFragment(source) : source
    const plan = await computeInjectionPlan(base, cwd, rootDir)
    if (plan.libsEmpty) return { injected: false, reason: 'no-libs' }
    if (plan.after === source) return { injected: false, reason: 'already-injected' }
    writeTextFileAtomic(hostPath, plan.after)
    if (plan.hasShadow) process.stdout.write('提示：检测到宿主已有 utoopack/alias 配置，已合并进宿主键；uninit 后可还原\n')
    printInjectionSummary('已自动注入 utoopack 适配片段', hostPath, plan.libDirs, plan.root, plan.alias, plan.skipped)
    return { injected: true, hostPath }
  } catch (err) {
    return { injected: false, error: err as Error }
  }
}

/**
 * unlink 全部断开后自动摘除（非交互）：workspace 内找到 umi 宿主 + 已注入 → 直接摘除。
 * 不完整标记（有 start 无 end）**绝不自动摘除**（S13 I8 铁律）——报错提示手动处理。
 * 失败不抛错——联动是附加动作，unlink 主流程已完成。
 */
export async function autoUninitAfterUnlinkAll(rootDir: string): Promise<{ removed: boolean; hostPath?: string; reason?: string; error?: Error }> {
  try {
    const host = await locateHostConfigInWs(rootDir)
    if (host === null) return { removed: false, reason: 'no-umi-host' }
    const { hostPath } = host
    const source = stripBom(readFileSync(hostPath, 'utf8'))
    const marker = findMarker(source)
    if (marker === null) return { removed: false, reason: 'not-injected' } // 未注入，跳过
    if (!marker.complete) {
      // I8：不完整标记绝不自动摘除（可能误删宿主配置），交用户手工
      process.stderr.write('警告：检测到不完整的 lpm 注入标记（缺结束标记），已跳过自动摘除。\n')
      process.stderr.write('下一步：请手工删除 config 中残留的 /* lpm-inject:start */ 后重试\n')
      return { removed: false, hostPath, reason: 'incomplete-marker' }
    }
    const after = removeFragment(source)
    writeTextFileAtomic(hostPath, after)
    printRemovalSummary('已自动摘除 utoopack 适配片段', hostPath)
    return { removed: true, hostPath }
  } catch (err) {
    return { removed: false, error: err as Error }
  }
}
