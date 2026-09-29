import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  readProjectConfig,
  readState,
  writeProjectConfig,
} from '../state/index.js'
import * as clack from '@clack/prompts'
import type { ProjectLpmConfig } from '../state/types.js'
import { renderPlan, type PlanView } from './plan-view.js'

/** 预设相关错误（命令域；沿用 S6/S7「错误类归命令文件」先例） */
export class PresetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PresetError'
  }
}

/** 预设表守卫后的视图（只读）：raw 供读-改-写，entries 只含合法条目，corrupt 记录脏条目名 */
export interface PresetView {
  raw: Record<string, unknown>
  entries: Record<string, string[]>
  corrupt: string[]
}

/**
 * 预设表读取守卫（spec §4.7）：
 * - cfg=null / presets 缺省 → 空视图
 * - presets 存在但非对象（数组 / null / 标量）→ **抛 PresetError（不吞）**
 * - 逐条目：值不是「元素全为字符串的数组」→ 进 corrupt（**不读其元素**）；否则进 entries
 * - raw 原样保留一切（含 corrupt 条目与未知字段），供保存/删除做读-改-写
 */
export function readPresets(cfg: ProjectLpmConfig | null): PresetView {
  if (cfg === null || cfg.presets === undefined) return { raw: {}, entries: {}, corrupt: [] }
  const rawPresets: unknown = cfg.presets
  if (typeof rawPresets !== 'object' || rawPresets === null || Array.isArray(rawPresets)) {
    throw new PresetError('lpm.config.json 的 presets 应为对象。\n下一步：手工修正该字段，或删除 presets 后重新 lpm save——lpm 状态可抛弃重建')
  }
  const raw = rawPresets as Record<string, unknown>
  const entries: Record<string, string[]> = {}
  const corrupt: string[] = []
  for (const name of Object.keys(raw)) {
    const v = raw[name]
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) entries[name] = v as string[]
    else corrupt.push(name)
  }
  return { raw, entries, corrupt }
}

/** 预设名合法性（spec §4.7）：trim 后非空、且不含空白字符 */
function validatePresetName(name: string): void {
  if (name.trim() === '' || /\s/.test(name)) {
    throw new PresetError('预设名不能为空，且不能包含空白字符。\n下一步：改用不含空白的名字，如 my-preset')
  }
}

/** 命令级错误上报（与 link/unlink 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [PresetError, WorkspaceNotFoundError, LpmConfigParseError, LpmStateParseError]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

/** `lpm save <预设名>`：把当前链接集存为预设（spec §4.8）——纯直通，不弹菜单 */
export async function runSave(name: string, cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number> {
  try {
    validatePresetName(name)
    const rootDir = await findWorkspaceRoot(cwd)
    const cfg: ProjectLpmConfig = (await readProjectConfig(rootDir)) ?? { version: 1, libs: {} }
    const view = readPresets(cfg)
    const st = await readState(rootDir)
    const names = Object.keys(st?.links ?? {})
    if (names.length === 0) {
      throw new PresetError('当前没有任何已链接的库，无法存为预设。\n下一步：先 lpm link <名字|路径> 建立链接')
    }
    if (Object.hasOwn(view.raw, name)) {
      throw new PresetError(`预设名已存在：${name}。\n下一步：先 lpm preset rm ${name} 删除，或换一个名字`)
    }
    const sorted = [...names].sort()
    // raw 可能含损坏条目（值非 string[]）——spec §4.7「读-改-写绝不丢损坏条目/未知字段」；
    // 类型断言仅对齐 ProjectLpmConfig.presets 的声明（运行时原样保留）
    if (opts.dryRun === true) {
      const view: PlanView = { entries: [{ kind: 'line', text: `将保存预设：${name}（${sorted.length} 项：${sorted.join('、')}）` }], install: null, watch: [] }
      process.stdout.write(renderPlan(view, 'dry-run'))
      return 0
    }
    await writeProjectConfig(rootDir, { ...cfg, presets: { ...view.raw, [name]: sorted } as Record<string, string[]> })
    process.stdout.write(`已保存预设：${name}（${sorted.length} 项：${sorted.join('、')}）\n`)
    return 0
  } catch (err) {
    return reportError(err)
  }
}

/** 写回预设表（读-改-写：next 空对象 → 移除 presets 字段；不丢损坏条目/未知字段）——rm 直通与交互两处共用 */
async function persistPresets(rootDir: string, cfg: ProjectLpmConfig, next: Record<string, unknown>): Promise<void> {
  const nextCfg: ProjectLpmConfig = { ...cfg }
  if (Object.keys(next).length === 0) delete nextCfg.presets
  else nextCfg.presets = next as Record<string, string[]>
  await writeProjectConfig(rootDir, nextCfg)
}

/** `lpm preset rm <名>`：按名删除（spec §4.9）——损坏条目也可删（这是修好脏配置的唯一入口） */
async function runPresetRm(name: string, cwd: string, opts: { dryRun?: boolean }): Promise<number> {
  const rootDir = await findWorkspaceRoot(cwd)
  const cfg = await readProjectConfig(rootDir)
  if (cfg === null) {
    throw new PresetError('没有 lpm.config.json，没有任何预设。\n下一步：该文件进 git，可由版本库恢复')
  }
  const view = readPresets(cfg)
  if (!Object.hasOwn(view.raw, name)) {
    const avail = Object.keys(view.raw)
    throw new PresetError(
      avail.length === 0
        ? `预设不存在：${name}。\n下一步：当前没有任何预设。先 lpm save <名字> 建立`
        : `预设不存在：${name}。\n下一步：可用预设：${avail.join('、')}`,
    )
  }
  const next: Record<string, unknown> = { ...view.raw }
  delete next[name]
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将删除预设：${name}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
  await persistPresets(rootDir, cfg, next)
  process.stdout.write(`已删除预设：${name}\n`)
  return 0
}

/** `lpm preset`（无参数）：列表管理「看 + 多选删除」（spec §4.9） */
async function runPresetInteractive(cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write('当前不是交互终端；直通用法：lpm preset rm <名>\n')
    return 1
  }
  const rootDir = await findWorkspaceRoot(cwd)
  const cfg = (await readProjectConfig(rootDir)) ?? { version: 1, libs: {} }
  const view = readPresets(cfg)
  const names = [...Object.keys(view.entries), ...view.corrupt]
  if (names.length === 0) {
    process.stdout.write('还没有任何预设。用 lpm save <名字> 把当前链接集存下来\n')
    return 0
  }
  const options = names.map((n) =>
    Object.hasOwn(view.entries, n)
      ? { value: n, label: `${n}（${view.entries[n]!.length} 项：${view.entries[n]!.join('、')}）` }
      : { value: n, label: `${n}  [损坏]`, hint: '内容不是字符串数组——删除可修复' },
  )
  const picked = await clack.multiselect({ message: '选择要删除的预设（空格勾选，回车确认）', options })
  if (clack.isCancel(picked)) { process.stdout.write('已取消\n'); return 1 }
  const chosen = picked as string[]
  if (chosen.length === 0) { process.stdout.write('未选择任何预设\n'); return 1 }
  const ok = await clack.confirm({
    message: `删除这 ${chosen.length} 个预设？（删除后需重新 lpm save 才能恢复）`,
    initialValue: false,
  })
  if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
  const next: Record<string, unknown> = { ...view.raw }
  for (const n of chosen) delete next[n]
  await persistPresets(rootDir, cfg, next)
  for (const n of chosen) process.stdout.write(`已删除预设：${n}\n`)
  return 0
}

/** `lpm preset` 入口（spec §4.9 的参数分派）：[] → 交互；['rm', 名] → 直通删除；其它 → 用法错误 */
export async function runPreset(args: readonly string[], cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number> {
  try {
    if (args.length === 0) {
      if (opts.dryRun === true) {
        process.stderr.write('--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：lpm preset rm <名> --dry-run\n')
        return 1
      }
      return await runPresetInteractive(cwd)
    }
    if (args[0] === 'rm' && args.length === 2) return await runPresetRm(args[1] as string, cwd, opts)
    throw new PresetError('用法错误。\n下一步：lpm preset（列表管理）/ lpm preset rm <名>')
  } catch (err) {
    return reportError(err)
  }
}
