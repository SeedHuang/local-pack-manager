import { Command, Argument } from 'commander'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COMMANDS } from './commands/registry.js'
import { notImplemented } from './commands/stub.js'
import { runLink } from './commands/link.js'
import { runUnlink } from './commands/unlink.js'
import { runStatus } from './commands/status.js'
import { runRepair } from './commands/repair.js'
import { runUse } from './commands/use.js'
import { LPM_VERSION } from './version.js'

export function buildProgram(): Command {
  const program = new Command()
  program.name('lpm').description('npm 本地 link 联调 CLI').version(LPM_VERSION)

  for (const meta of COMMANDS) {
    // S3：use 为首个真实命令，特判接线（description 不带计划后缀）；其余命令维持 stub 循环（S1 §4.5）
    if (meta.name === 'use') {
      program
        .command(meta.name)
        .description(meta.summary)
        .addArgument(new Argument('[pm]', 'pnpm | npm | yarn').choices(['pnpm', 'npm', 'yarn']))
        .action(async (pm: 'pnpm' | 'npm' | 'yarn' | undefined) => {
          process.exitCode = await runUse(pm)
        })
      continue
    }
    // S6：link 直通版接线（同 use 特判；description 不带计划后缀）
    if (meta.name === 'link') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--watch', '链接后拉起 lib 的 build:watch 子进程')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { watch?: boolean; dryRun?: boolean }) => {
          process.exitCode = await runLink(targets, options)
        })
      continue
    }
    // S7：unlink 直通版接线（同 use/link 特判；description 不带计划后缀）
    if (meta.name === 'unlink') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--all', '取消全部已链接依赖')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { all?: boolean; dryRun?: boolean }) => {
          process.exitCode = await runUnlink(targets, options)
        })
      continue
    }
    // S8：status 只读诊断接线（description 不带计划后缀）
    if (meta.name === 'status') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--json', '输出结构化 JSON（供脚本与 E2E 消费）')
        .allowExcessArguments(false)
        .action(async (options: { json?: boolean }) => {
          process.exitCode = await runStatus(options)
        })
      continue
    }
    // S8：repair 六族自修复接线（description 不带计划后缀；不接受位置参数）
    if (meta.name === 'repair') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--dry-run', '仅打印修复计划，不落盘不执行')
        .allowExcessArguments(false)
        .action(async (options: { dryRun?: boolean }) => {
          process.exitCode = await runRepair(options)
        })
      continue
    }
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
