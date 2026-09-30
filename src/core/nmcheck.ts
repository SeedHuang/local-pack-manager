import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

// node_modules/<key> 真实形态探源（S8 spec §4.3）。只返回事实，异常语义由调用方解释
// （unlink 侧映射见 src/commands/unlink.ts 的 verifyResidue）。

export type NmStatus = 'entity' | 'link-to-lib' | 'link-elsewhere' | 'dangling' | 'missing' | 'unknown'

export interface NmProbe {
  status: NmStatus
  realTarget?: string
  note?: string
}

/** 路径归一（比对用）：反斜杠转正斜杠；Windows 大小写不敏感 */
function normPath(p: string): string {
  const s = resolve(p).replaceAll('\\', '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 链接判定：lstat().isSymbolicLink() 对 junction 返回 false（PRD §10 行 328），
 *  故叠加 realpath 比较——但须与「**父目录 canonical + 自身文件名**」而非字面路径比较：
 *  仅当**最终组件本身**是链接/junction 时二者才不等；否则路径含符号链接祖先（POSIX /var → /private/var、
 *  被软链的项目/家目录）或 Windows 8.3 短名时，会把真实目录误判为链接 */
function isLink(nmEntry: string, realTarget: string): boolean {
  if (lstatSync(nmEntry).isSymbolicLink()) return true
  let expected: string
  try { expected = join(realpathSync(dirname(nmEntry)), basename(nmEntry)) }
  catch { expected = resolve(nmEntry) }   // 父目录不可解析（理论不可达）→ 退回字面路径，绝不抛异常
  return normPath(realTarget) !== normPath(expected)
}

export function probeNodeModules(manifestPath: string, key: string, expectedLibReal: string | null): NmProbe {
  const nmEntry = join(dirname(manifestPath), 'node_modules', key)
  if (!existsSync(nmEntry)) {
    // existsSync 跟随链接：false = 不存在或悬空——lstat 不跟随，成功即悬空链接
    let dangling = false
    try { lstatSync(nmEntry); dangling = true } catch { /* 保持 false */ }
    return dangling ? { status: 'dangling', note: '悬空链接' } : { status: 'missing' }
  }
  let real: string
  try {
    real = realpathSync(nmEntry)
  } catch {
    return { status: 'dangling', note: '悬空链接' }
  }
  // 期望值不可解析（注册缺失/库已删）→ 无法比对；此判定必须先于实体/链接区分，
  // 以保持 S7 unlink 现有行为与文案（UNL-22 断言「存在实体则 ok + 注明」）
  if (expectedLibReal === null) {
    return { status: 'unknown', realTarget: real, note: '注册缺失/库已删，无法比对指向' }
  }
  if (!isLink(nmEntry, real)) return { status: 'entity', realTarget: real }
  return normPath(real) === normPath(expectedLibReal)
    ? { status: 'link-to-lib', realTarget: real }
    : { status: 'link-elsewhere', realTarget: real }
}
