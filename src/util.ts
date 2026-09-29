// 无依赖共享原语（S1 §7.1 分层：core 与 state 均不互相依赖，共用的纯函数放本叶子，
// 供三层 import——避免各层各留一份私有副本导致口径漂移）。

import { existsSync, statSync } from 'node:fs'

/** 剥行首 UTF-8 BOM（记事本等工具常产生；lpm 家族所有 JSON/文本读路径统一口径） */
export function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

/** 路径存在且为目录（与原各处内联判定完全等价：statSync 异常照常上抛） */
export function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}
