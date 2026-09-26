import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/** 原子写 JSON（PRD §9 崩溃安全：临时文件 + rename 覆盖；S3 spec §4.6 契约 + S4 spec §4.5 tmp 强化）。
 *  序列化契约：JSON.stringify(value, null, 2) + 尾随换行；LF；无 BOM。
 *  tmp 名含 pid + uuid 后缀——pid 防双终端并发互踩，uuid 防同进程并发互撞（T1① 定版；同步函数体在
 *  单线程事件循环下不可交错，uuid 实际覆盖 worker_threads 共享 pid 场景，作防御纵深）。
 *  失败语义：value 不可序列化（undefined）→ TypeError，不落盘；
 *  写入/rename 失败（Windows 目标被占用、磁盘满等）→ 清理孤儿 tmp 后原错误重抛。 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    // JSON.stringify(undefined) 运行时返回 undefined（lib 签名误标 string），直接拼接会把字符串 "undefined" 落盘
    throw new TypeError(`writeJsonFileAtomic: value 不可序列化为 JSON：${filePath}`)
  }
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, json + '\n', 'utf8')
    renameSync(tmp, filePath) // Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING 语义）
  } catch (err) {
    rmSync(tmp, { force: true }) // 清理孤儿 tmp，不掩盖原错误
    throw err
  }
}
