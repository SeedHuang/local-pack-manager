import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import * as clack from '@clack/prompts'
import { LpmStateParseError, readUserConfig, writeUserConfig } from '../state/index.js'

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
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

const DIR_USAGE = 'lpm dir add <路径> | rm <路径> | ls'

/** `lpm dir add <路径>`：校验（绝对 + 存在目录，同 S9 addScanDir）→ 去重 → 读-改-写 */
async function runDirAdd(dir: string): Promise<number> {
  const trimmed = dir.trim()
  let ok = false
  try {
    ok = isAbsolute(trimmed) && existsSync(trimmed) && statSync(trimmed).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    throw new DirError(`扫描目录必须是已存在的绝对路径：${trimmed}。示例：D:\\Seed\\libs`)
  }
  const cur = await readUserConfig()
  if (!cur.scanDirs.includes(trimmed)) {
    await writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, trimmed] })
  }
  process.stdout.write(`已加入扫描目录：${trimmed}\n`)
  return 0
}

/** `lpm dir rm <路径>`：按值移除（空态与不在列表分别报错） */
async function runDirRm(dir: string): Promise<number> {
  const cur = await readUserConfig()
  if (cur.scanDirs.length === 0) {
    throw new DirError('当前没有任何扫描目录。可用 lpm dir add <路径> 添加')
  }
  if (!cur.scanDirs.includes(dir)) {
    throw new DirError(`扫描目录不在列表中：${dir}。可用 lpm dir ls 查看`)
  }
  await writeUserConfig({ ...cur, scanDirs: cur.scanDirs.filter((d) => d !== dir) })
  process.stdout.write(`已移除扫描目录：${dir}\n`)
  return 0
}

/** `lpm dir ls`：逐行列出（非字符串元素跳过 + 一行提示） */
async function runDirLs(): Promise<number> {
  const cur = await readUserConfig()
  for (const d of cur.scanDirs) {
    if (typeof d !== 'string') process.stdout.write(`跳过无效的扫描目录项（非字符串）：${String(d)}\n`)
  }
  const valid = cur.scanDirs.filter((d) => typeof d === 'string')
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
  for (const d of cur.scanDirs) {
    if (typeof d !== 'string') process.stdout.write(`跳过无效的扫描目录项（非字符串）：${String(d)}\n`)
  }
  const valid = cur.scanDirs.filter((d) => typeof d === 'string')
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
export async function runDir(args: readonly string[], _cwd: string = process.cwd()): Promise<number> {
  try {
    if (args.length === 0) return await runDirInteractive()
    if (args[0] === 'add' && args.length === 2) return await runDirAdd(args[1] as string)
    if (args[0] === 'rm' && args.length === 2) return await runDirRm(args[1] as string)
    if (args[0] === 'ls' && args.length === 1) return await runDirLs()
    throw new DirError(`用法：${DIR_USAGE}`)
  } catch (err) {
    return reportError(err)
  }
}
