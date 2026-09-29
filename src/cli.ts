import { Command, Argument, CommanderError } from 'commander'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COMMANDS } from './commands/registry.js'
import { runLink } from './commands/link.js'
import { runUnlink } from './commands/unlink.js'
import { runStatus } from './commands/status.js'
import { runRepair } from './commands/repair.js'
import { runPreset, runSave } from './commands/preset.js'
import { runDir } from './commands/dir.js'
import { runForget } from './commands/forget.js'
import { runInit, runUninit } from './commands/init.js'
import { runUse } from './commands/use.js'
import { LPM_VERSION } from './version.js'

/** 未知命令模糊纠错（S12 spec §4.6）：Damerau-Levenshtein ≤3（与 commander 同质，含 transposition）。
 *  返回全部同距离候选（按名排序）；candidates 缺省 = 全部注册命令名。纯函数，供单测。 */
export function suggestCommand(raw: string, candidates: readonly string[] = COMMANDS.map((c) => c.name)): string[] {
  const MAX = 3
  const dist = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i++) d[i]![0] = i
    for (let j = 0; j <= b.length; j++) d[0]![j] = j
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
        }
      }
    }
    return d[a.length]![b.length]!
  }
  let best = MAX
  const hits: string[] = []
  for (const c of candidates) {
    if (c.length <= 1) continue // 1 字符候选不猜（与 commander suggestSimilar 同规约；默认 COMMANDS 全 ≥3 字符，此守卫服务自定义 candidates 的调用方）
    const dd = dist(raw, c)
    if (dd < best) { best = dd; hits.length = 0; hits.push(c) }
    else if (dd === best) hits.push(c)
  }
  return hits.sort()
}

export function buildProgram(): Command {
  const program = new Command()
  program.name('lpm').description('npm 本地 link 联调 CLI').version(LPM_VERSION)
  // S12 §4.6：commander 改抛异常（不直接 process.exit）；关闭其英文 (Did you mean…?) 建议，改用自写中文建议
  program.exitOverride()
  program.showSuggestionAfterError(false)

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
        .option('--last', '链接 last.json 记录的那一批')
        .option('--all', '链接全部已注册的 lib')
        .option('--preset <名>', '链接指定预设')
        .action(async (targets: string[], options: { watch?: boolean; dryRun?: boolean; last?: boolean; all?: boolean; preset?: string }) => {
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
    // S10：save 直通接线（description 不带计划后缀）
    if (meta.name === 'save') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('<预设名>', '预设名')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .allowExcessArguments(false)
        .action(async (name: string, options: { dryRun?: boolean }) => {
          process.exitCode = await runSave(name, undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S10：preset 接线（无参数 → 交互列表管理；rm <名> → 直通删除）
    if (meta.name === 'preset') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'rm <名>')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (args: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runPreset(args, undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S11：dir 接线（无参数 → 交互；add/rm/ls → 直通；分派在 runDir 内）
    if (meta.name === 'dir') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'add <路径> | rm <路径> | ls')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (args: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runDir(args, undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S11：forget 接线（无参数 → 交互；[targets...] → 直通删除）
    if (meta.name === 'forget') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runForget(targets, undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S13：init 注入接线（无位置参数；diff 预览确认型，仿 repair）
    if (meta.name === 'init') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--dry-run', '仅打印注入 diff 预览，不落盘')
        .allowExcessArguments(false)
        .action(async (options: { dryRun?: boolean }) => {
          process.exitCode = await runInit(undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S13：uninit 摘除接线（对称）
    if (meta.name === 'uninit') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--dry-run', '仅打印摘除 diff 预览，不落盘')
        .allowExcessArguments(false)
        .action(async (options: { dryRun?: boolean }) => {
          process.exitCode = await runUninit(undefined, { dryRun: options.dryRun })
        })
      continue
    }
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

  try {
    await program.parseAsync(argv, { from: 'user' })
    // @types/node ≥22 中 exitCode 为 number | string | undefined，收敛为 number（契约 0/1）
    return Number(process.exitCode ?? 0)
  } catch (err) {
    if (err instanceof CommanderError) {
      // exitOverride 下 --help/--version 抛 exitCode=0（内容 commander 已打印到 stdout）→ 正常结束
      if (err.exitCode === 0) return 0
      // 报错内容（error: unknown command 'lnik' 等）commander 已写入 stderr（command.js error() 先 outputError 再 _exit）
      if (err.code === 'commander.unknownCommand') {
        const raw = /'([^']+)'/.exec(err.message)?.[1]
        if (raw !== undefined) {
          const sim = suggestCommand(raw)
          if (sim.length > 0) process.stderr.write(`最接近的命令：${sim.join('、')}\n`)
        }
      }
      return 1
    }
    throw err
  }
}

// 直接执行时才 run()，被 import（测试）时不执行；
// 两侧 realpath 归一，防 Windows 路径大小写差异
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2))
}
