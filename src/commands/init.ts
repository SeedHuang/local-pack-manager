import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { stripBom } from '../util.js'
import { findWorkspaceRoot } from '../core/workspace.js'
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
  InitNotInjectedError,
  InitRootError,
  buildAliasMap,
  buildFragment,
  buildRootValue,
  findHostConfig,
  findMarker,
  hasTopLevelKeys,
  injectFragment,
  removeFragment,
} from '../core/utoopack.js'
import { reportError as reportKnownError } from './errors.js'

export interface InitOptions { dryRun?: boolean }

// ── diff 预览（spec §4.7；只 diff 对象体区间）──
function printInjectDiff(hostPath: string, source: string, after: string, mode: 'inject' | 'remove', dryRun: boolean): void {
  const cmd = mode === 'inject' ? 'init' : 'uninit'
  const title = dryRun
    ? `${cmd} dry-run 执行计划（不落任何盘、不执行任何子进程）：`
    : mode === 'inject' ? '注入计划：' : '摘除计划：'
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
    InitAlreadyInjectedError, InitNotInjectedError, InitIncompleteMarkerError,
    WorkspaceNotFoundError, ManifestParseError, LpmConfigParseError,
  ]
  return reportKnownError(err, KNOWN)
}

async function ensureInitPreconditions(cwd: string): Promise<{ hostPath: string; source: string }> {
  const hostPath = findHostConfig(cwd)
  const source = stripBom(readFileSync(hostPath, 'utf8'))
  return { hostPath, source }
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
    const cfg = await readProjectConfig(rootDir)
    const libRels = Object.values(cfg?.libs ?? {})
    if (libRels.length === 0) {
      process.stdout.write('当前没有任何已注册的 lib。\n下一步：先 lpm link <路径> 注册后再 init\n')
      return 0
    }
    const libDirs = libRels.map((rel) => resolve(rootDir, rel))
    const root = buildRootValue(cwd, libDirs)
    const { alias, skipped } = buildAliasMap(cwd, rootDir, libDirs)
    // OCR M1：遮蔽判定收窄到对象体顶层键（不再全文件子串扫描——注释/webpack resolve.alias 等不误报）
    const hasShadow = hasTopLevelKeys(source, ['utoopack', 'alias'])
    const fragment = buildFragment(root, alias)
    const after = injectFragment(source, fragment)
    if (hasShadow) process.stdout.write('提示：检测到宿主已有 utoopack/alias 配置，lpm 片段将覆盖之；uninit 后可还原\n')
    if (opts.dryRun === true) { printInjectDiff(hostPath, source, after, 'inject', true); return 0 }
    if (process.stdin.isTTY !== true) throw new InitInteractionError('init')
    printInjectDiff(hostPath, source, after, 'inject', false)
    const ok = await clack.confirm({ message: `执行以上注入？（写入 ${hostPath}）`, initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    writeTextFileAtomic(hostPath, after)
    const aliasCount = Object.keys(alias).length
    process.stdout.write(`已注入 utoopack 适配片段：${hostPath}\n`)
    process.stdout.write(`  root：${root}（覆盖 ${libDirs.length} 个已注册 lib 的公共祖先）\n`)
    if (aliasCount > 0) process.stdout.write(`  dedupe：${aliasCount} 个 peer（${Object.keys(alias).join('、')}）\n`)
    else process.stdout.write('  未检测到需要 dedupe 的 peer（lib peer ∩ 宿主直接依赖 为空），仅注入 root\n')
    // OCR M2：declared 但未安装的 peer 提示（spec §8 自决 11「跳过 + 提示」由 runInit 落盘）
    if (skipped.length > 0) process.stdout.write(`  提示：以下 peer 已声明但宿主/workspace 均未安装，未注入 alias（${skipped.join('、')}）\n`)
    process.stdout.write('若 lib 后续新增 peer，请重跑 lpm init 重新注入。\n')
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
    process.stdout.write(`已摘除 utoopack 适配片段：${hostPath}（宿主原有 utoopack/alias 配置已还原）\n`)
    return 0
  } catch (err) {
    return reportError(err)
  }
}
