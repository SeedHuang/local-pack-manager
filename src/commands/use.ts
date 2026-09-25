import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as clack from '@clack/prompts'
import {
  detectPackageManagerDetailed,
  PMAmbiguousError,
  PMUnresolvedError,
  subdivideYarn,
  type PackageManagerId,
  type PMEvidence,
} from '../core/pm.js'
import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace.js'
import { LpmConfigParseError, readProjectConfig, writeProjectConfig } from '../state/index.js'
import type { ProjectLpmConfig } from '../state/types.js'

export type UseToken = 'pnpm' | 'npm' | 'yarn'

const LOCKFILE_BY_TOKEN: Record<UseToken, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
}

type ConfirmResult = 'confirmed' | 'declined' | 'no-tty'

async function confirmOverride(message: string): Promise<ConfirmResult> {
  if (!process.stdin.isTTY) return 'no-tty' // 非 TTY 无法交互（spec §4.5 步骤 4）
  const answer = await clack.confirm({ message })
  if (clack.isCancel(answer)) return 'declined'
  return answer === true ? 'confirmed' : 'declined'
}

function evidenceText(ev: PMEvidence): string {
  if (ev.kind === 'lockfile') return ev.file
  if (ev.kind === 'corepack-field') return `package.json packageManager 字段 ${ev.value}`
  return 'pnpm-workspace.yaml'
}

/** use 命令行为（S3 spec §4.5）。pm 缺省 = 裸 use：自动推断展示，不落盘（PRD §9.1 仅显式写入）。
 *  cwd 参数化仅为可测性；cli.ts 以默认值调用，行为等价于 findWorkspaceRoot(process.cwd())。 */
export async function runUse(pm: UseToken | undefined, cwd: string = process.cwd()): Promise<number> {
  let rootDir: string
  try {
    rootDir = await findWorkspaceRoot(cwd)
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
  try {
    return pm === undefined ? await runBare(rootDir) : await runExplicit(rootDir, pm)
  } catch (err) {
    // config 坏 JSON/非对象 → LpmConfigParseError 自带下一步动作文案（spec §6.5：stderr + 退出 1）
    if (err instanceof LpmConfigParseError) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
}

async function runBare(rootDir: string): Promise<number> {
  const cfg = await readProjectConfig(rootDir)
  const configured = cfg?.packageManager
  if (configured !== undefined && configured !== null) {
    // 含运行时越界值（手改 config）——仅显示，深层校验归 S4
    process.stdout.write(`当前设定：${String(configured)}\n`)
    return 0
  }
  try {
    const r = await detectPackageManagerDetailed(rootDir)
    process.stdout.write(`检测到包管理器：${r.pm}（依据：${evidenceText(r.evidence)}）\n`)
    process.stdout.write('如需固化设定：lpm use <pnpm|npm|yarn>\n')
    return 0
  } catch (err) {
    if (err instanceof PMAmbiguousError || err instanceof PMUnresolvedError) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
}

async function runExplicit(rootDir: string, pm: UseToken): Promise<number> {
  const target: PackageManagerId = pm === 'yarn' ? subdivideYarn(rootDir) : pm
  const cfg = await readProjectConfig(rootDir)

  // 幂等前置（spec §4.5 步骤 2）：已设定同值不写，冲突确认只发生在有实际写入时
  if (cfg?.packageManager === target) {
    process.stdout.write(`包管理器已设定为 ${target}\n`)
    return 0
  }

  // 冲突判定（B2 口径，spec §4.5 步骤 3）：指定 PM 缺自家 lockfile 且存在他类 lockfile
  const ownLockfile = LOCKFILE_BY_TOKEN[pm]
  const others = Object.values(LOCKFILE_BY_TOKEN).filter(
    (f) => f !== ownLockfile && existsSync(join(rootDir, f)),
  )
  const hasConflict = !existsSync(join(rootDir, ownLockfile)) && others.length > 0

  if (hasConflict) {
    process.stderr.write(`警告：项目现有 lockfile（${others.join(', ')}）与指定的 ${pm} 冲突。\n`)
    const c = await confirmOverride(`仍要使用 ${pm}？`)
    if (c === 'no-tty') {
      process.stderr.write(
        '与现有 lockfile 冲突，且当前环境无法交互确认。请改在终端运行，或先移除冲突 lockfile\n',
      )
      return 1
    }
    if (c === 'declined') {
      process.stdout.write('已取消，未变更\n')
      return 0
    }
  }

  const next: ProjectLpmConfig = cfg ?? { version: 1, libs: {} }
  next.packageManager = target
  await writeProjectConfig(rootDir, next)
  const suffix = hasConflict ? `（与 ${others.join(', ')} 冲突，已按你的选择继续）` : ''
  process.stdout.write(`已设定包管理器：${target}${suffix}\n`)
  return 0
}
