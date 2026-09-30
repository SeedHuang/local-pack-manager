// 命令层错误上报骨架（各命令文件保留自己的 KNOWN 错误类集合——错误分类语义本就随命令不同，
// 重复的只是「KNOWN 命中 → stderr 打印 + return 1，否则 rethrow」三行骨架，故收敛到此处单源）。

/** 错误类构造器（各错误类构造签名不同，无法用非 any 联合表示；仅此一处使用） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type KnownErrorClass = new (...args: any[]) => Error

/** KNOWN 命中 → stderr 打印错误文案 + return 1；未命中 → rethrow（未知错误不吞） */
export function reportError(err: unknown, known: readonly KnownErrorClass[]): number {
  if (known.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}
