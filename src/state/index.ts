import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types.js'
import { writeJsonFileAtomic } from './atomic.js'

/** lpm.config.json 不是合法 JSON（S3 引入；深层 schema 校验由 S4 深化） */
export class LpmConfigParseError extends Error {
  constructor(public configPath: string, message: string) {
    super(message)
    this.name = 'LpmConfigParseError'
  }
}

function configPathOf(rootDir: string): string {
  return join(rootDir, 'lpm.config.json')
}

/** S3 提前实现（S3 spec §4.6）：缺失 → null；坏 JSON/非对象 → LpmConfigParseError；不做深层 schema 校验（S4 深化） */
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  const p = configPathOf(rootDir)
  if (!existsSync(p)) return null
  const source = readFileSync(p, 'utf8')
  // 剥行首 UTF-8 BOM（规约同 S2 spec §4.2）
  const stripped = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw new LpmConfigParseError(
      p,
      `${p} 不是合法 JSON（${(err as Error).message}）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  // 最小对象判定（非深层 schema 校验）：非对象配置（数组/原始值）会让下游属性赋值/序列化静默失败
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LpmConfigParseError(
      p,
      `${p} 不是合法的 lpm 配置（应为 JSON 对象）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  return parsed as ProjectLpmConfig
}

/** S3 提前实现（S3 spec §4.6）：原子写（PRD §9） */
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  writeJsonFileAtomic(configPathOf(rootDir), cfg)
}

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——以下为 S4 范围 stub
export async function readState(rootDir: string): Promise<LinkState | null> {
  throw new Error('not implemented: readState（计划 S4）')
}

export async function writeState(rootDir: string, st: LinkState): Promise<void> {
  throw new Error('not implemented: writeState（计划 S4）')
}

export async function deleteState(rootDir: string): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）
  throw new Error('not implemented: deleteState（计划 S4）')
}

export async function readLast(rootDir: string): Promise<LastSet | null> {
  throw new Error('not implemented: readLast（计划 S4）')
}

export async function writeLast(rootDir: string, last: LastSet): Promise<void> {
  throw new Error('not implemented: writeLast（计划 S4）')
}

export async function readUserConfig(): Promise<UserLpmConfig> {
  // 文件缺失 → { version: 1, scanDirs: [] }
  throw new Error('not implemented: readUserConfig（计划 S4）')
}

export async function writeUserConfig(cfg: UserLpmConfig): Promise<void> {
  throw new Error('not implemented: writeUserConfig（计划 S4）')
}

export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'> {
  // 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/（PRD §9.5）
  throw new Error('not implemented: ensureGitignoreEntry（计划 S4）')
}
