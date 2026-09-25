import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const distCli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  // 前置 pnpm build；dist 缺失必须显式报错，不允许静默跳过（spec §7.1）
  if (!existsSync(distCli)) {
    throw new Error('dist/cli.js 不存在，请先运行 pnpm build')
  }
  const r = await execa('node', [distCli, ...args], { cwd, reject: false })
  // execa reject:false 时 exitCode 为 number | undefined（signal 终止），收敛为非 0 契约值
  return { exitCode: r.exitCode ?? -1, stdout: r.stdout, stderr: r.stderr }
}
