import { renameSync, rmSync, writeFileSync } from 'node:fs'

/** 原子写 JSON（PRD §9 崩溃安全：临时文件 + rename 覆盖；S3 spec §4.6，S4 的 state/last/user 写入复用）。
 *  序列化契约：JSON.stringify(value, null, 2) + 尾随换行；LF；无 BOM。
 *  tmp 名含 pid 后缀——防双终端并发写同一目标时互踩临时文件。
 *  失败语义：value 不可序列化（undefined）→ TypeError，不落盘；
 *  写入/rename 失败（Windows 目标被占用、磁盘满等）→ 清理孤儿 tmp 后原错误重抛。 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    // JSON.stringify(undefined) 运行时返回 undefined（lib 签名误标 string），直接拼接会把字符串 "undefined" 落盘
    throw new TypeError(`writeJsonFileAtomic: value 不可序列化为 JSON：${filePath}`)
  }
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, json + '\n', 'utf8')
    renameSync(tmp, filePath) // Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING 语义）
  } catch (err) {
    rmSync(tmp, { force: true }) // 清理孤儿 tmp，不掩盖原错误
    throw err
  }
}
