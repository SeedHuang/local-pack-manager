import type { PackageManagerId } from './pm.js'

export type Protocol = 'link' | 'portal' | 'file'

/** PRD §5 协议映射：pnpm | yarn-classic → link:，yarn-berry → portal:，npm → file:；
 *  返回完整依赖值（协议前缀 + 相对路径），相对路径基于 manifest 所在目录换算，
 *  正斜杠，永不输出绝对路径 */
export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string {
  throw new Error('not implemented: mapProtocol（计划 S5）')
}

export interface RewriteResult {
  content: string          // 改写后全文
  changedKeys: string[]    // "段名.包名"
  unchangedKeys: string[]  // 值已等于目标（幂等命中）
}

/** 文本级替换（PRD §9）：保持缩进 / key 顺序 / 尾随换行 / CRLF-LF / BOM；
 *  仅动命中行的 value；命中段：dependencies / devDependencies / optionalDependencies */
export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult {
  throw new Error('not implemented: rewriteDepValue（计划 S5）')
}

/** unlink 恢复原 range，格式保持语义同上 */
export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult {
  throw new Error('not implemented: restoreDepValue（计划 S5）')
}
