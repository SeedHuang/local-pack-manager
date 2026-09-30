import { isAbsolute } from 'node:path'
import * as clack from '@clack/prompts'
import { isDirectory } from '../util.js'
import { LpmStateParseError, readUserConfig, writeUserConfig } from '../state/index.js'
import { renderPlan, type PlanView } from './plan-view.js'
import { reportError as reportKnownError } from './errors.js'

/** dir 相关错误（命令域；沿用「错误类归命令文件」先例） */
export class DirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirError'
  }
}

/** 命令级错误上报（与 link/unlink/preset 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [DirError, LpmStateParseError]
  return reportKnownError(err, KNOWN)
}

const DIR_USAGE = 'lpm dir add <路径> | rm <路径> | ls'

/** `lpm dir add <路径>`：校验（绝对 + 存在目录，同 S9 addScanDir）→ 去重 → 读-改-写 */
async function runDirAdd(dir: string, opts: { dryRun?: boolean }): Promise<number> {
  const trimmed = dir.trim()
  let ok: boolean
  try {
    ok = isAbsolute(trimmed) && isDirectory(trimmed)
  } catch {
    ok = false
  }
  if (!ok) {
    throw new DirError(`扫描目录必须是已存在的绝对路径：${trimmed}。\n下一步：示例：D:\\Seed\\libs`)
  }
  // 先读用户配置再短路 dry-run（OCR-2：corrupt 配置下 dry-run 与真实执行一致报 exit 1）；
  // includes 去重检查在 dry-run 跳过（spec §8 自决 11：真实执行已存在时也照报「已加入」）
  const cur = await readUserConfig()
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将加入扫描目录：${trimmed}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
  if (!cur.scanDirs.includes(trimmed)) {
    await writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, trimmed] })
  }
  process.stdout.write(`已加入扫描目录：${trimmed}\n`)
  return 0
}

/** `lpm dir rm <路径>`：按值移除（空态与不在列表分别报错）；先 trim（与 runDirAdd 对称：add 存的都是 trim 后值） */
async function runDirRm(raw: string, opts: { dryRun?: boolean }): Promise<number> {
  const dir = raw.trim()
  const cur = await readUserConfig()
  if (cur.scanDirs.length === 0) {
    throw new DirError('当前没有任何扫描目录。\n下一步：用 lpm dir add <路径> 添加')
  }
  if (!cur.scanDirs.includes(dir)) {
    throw new DirError(`扫描目录不在列表中：${dir}。\n下一步：用 lpm dir ls 查看当前列表`)
  }
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将移除扫描目录：${dir}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
  await writeUserConfig({ ...cur, scanDirs: cur.scanDirs.filter((d) => d !== dir) })
  process.stdout.write(`已移除扫描目录：${dir}\n`)
  return 0
}

/** 过滤出合法（字符串）扫描目录项；非字符串项打印一行跳过提示（脏配置降级，runDirLs / runDirInteractive 共用） */
function validScanDirs(scanDirs: readonly string[]): string[] {
  for (const d of scanDirs) {
    if (typeof d !== 'string') process.stdout.write(`跳过无效的扫描目录项（非字符串）：${String(d)}\n`)
  }
  return scanDirs.filter((d) => typeof d === 'string')
}

/** `lpm dir ls`：逐行列出（非字符串元素跳过 + 一行提示） */
async function runDirLs(): Promise<number> {
  const cur = await readUserConfig()
  const valid = validScanDirs(cur.scanDirs)
  if (valid.length === 0) {
    process.stdout.write('当前没有任何扫描目录。用 lpm dir add <路径> 添加\n')
    return 0
  }
  for (const d of valid) process.stdout.write(`${d}\n`)
  return 0
}

/** `lpm dir`（无参数，TTY）：列出多选删除——可逆操作不二次确认（unlink 先例） */
async function runDirInteractive(): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${DIR_USAGE}\n`)
    return 1
  }
  const cur = await readUserConfig()
  const valid = validScanDirs(cur.scanDirs)
  if (valid.length === 0) {
    process.stdout.write('当前没有任何扫描目录。用 lpm dir add <路径> 添加\n')
    return 0
  }
  const picked = await clack.multiselect({
    message: '选择要移除的扫描目录（空格勾选，回车确认）',
    options: valid.map((d) => ({ value: d, label: d })),
    required: false,
  })
  if (clack.isCancel(picked)) { process.stdout.write('已取消\n'); return 1 }
  const chosen = picked as string[]
  if (chosen.length === 0) { process.stdout.write('未选择任何扫描目录\n'); return 1 }
  await writeUserConfig({ ...cur, scanDirs: cur.scanDirs.filter((d) => !chosen.includes(d)) })
  for (const d of chosen) process.stdout.write(`已移除扫描目录：${d}\n`)
  return 0
}

/** `lpm dir` 入口（分派在内部，便于单测）；`_cwd` 仅供 cli 位置一致，dir 纯用户级不定位 workspace */
export async function runDir(args: readonly string[], _cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number> {
  try {
    if (args.length === 0) {
      if (opts.dryRun === true) {
        process.stderr.write(`--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：${DIR_USAGE} --dry-run\n`)
        return 1
      }
      return await runDirInteractive()
    }
    if (args[0] === 'add' && args.length === 2) return await runDirAdd(args[1] as string, opts)
    if (args[0] === 'rm' && args.length === 2) return await runDirRm(args[1] as string, opts)
    if (args[0] === 'ls' && args.length === 1) return await runDirLs()
    throw new DirError(`用法错误。\n下一步：${DIR_USAGE}`)
  } catch (err) {
    return reportError(err)
  }
}
