import type { LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types.js'

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——S4 实现，S1 全为 stub
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  throw new Error('not implemented: readProjectConfig（计划 S4）')
}

export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  throw new Error('not implemented: writeProjectConfig（计划 S4）')
}

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
