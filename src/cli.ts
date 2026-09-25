import { Command } from 'commander'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COMMANDS } from './commands/registry.js'
import { notImplemented } from './commands/stub.js'
import { LPM_VERSION } from './version.js'

export function buildProgram(): Command {
  const program = new Command()
  program.name('lpm').description('npm 本地 link 联调 CLI').version(LPM_VERSION)

  for (const meta of COMMANDS) {
    program
      .command(meta.name)
      .description(`${meta.summary}（计划 ${meta.plannedSpec}）`)
      .action(() => notImplemented(meta))
  }
  return program
}

export async function run(argv: string[]): Promise<number> {
  const program = buildProgram()

  // spec §4.5 行为契约：无参数 → stdout help，退出码 0
  //（commander 对"有子命令但未给子命令"的默认行为是 stderr + exit 1，必须显式接管）
  if (argv.length === 0) {
    program.outputHelp()
    return 0
  }

  await program.parseAsync(argv, { from: 'user' })
  // @types/node ≥22 中 exitCode 为 number | string | undefined，收敛为 number（契约 0/1）
  return Number(process.exitCode ?? 0)
}

// 直接执行时才 run()，被 import（测试）时不执行；
// 两侧 realpath 归一，防 Windows 路径大小写差异
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2))
}
