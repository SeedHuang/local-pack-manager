import type { CommandMeta } from './registry.js'

export function notImplemented(meta: CommandMeta): void {
  // 只提示，不设退出码（spec §6：stub 统一退出码 0）
  process.stderr.write(`lpm ${meta.name} 尚未实现（计划 ${meta.plannedSpec}）。当前可用：lpm --help\n`)
}
