import type { PackageManagerId } from '../core/pm.js'

/** 项目级 lpm.config.json（进 git）—— PRD §9.1 */
export interface ProjectLpmConfig {
  version: 1
  packageManager?: PackageManagerId        // lpm use 显式设定后写入；未设定缺省
  libs: Record<string, string>             // lib 名 → 相对 workspace 根路径（正斜杠）
  presets?: Record<string, string[]>       // 预设名 → lib 名列表
}

/** 项目级 .lpm/state.json（gitignore）—— PRD §9.2 */
export interface LinkState {
  version: 1
  links: Record<string, {
    original: Record<string, string>       // "<相对根>/package.json" → 原 range
    linkedAt: string                       // ISO 8601
  }>
}

/** 项目级 .lpm/last.json（gitignore）—— PRD §9.3 */
export interface LastSet { version: 1; names: string[] }

/** 用户级 ~/.lpm/config.json —— PRD §9.4 */
export interface UserLpmConfig { version: 1; scanDirs: string[] }   // 绝对路径

/** 项目级 .lpm/last-run.json（gitignore）—— S8 运行留痕：只留最近一次 */
export interface LastRunTrace {
  version: 1
  command: 'link' | 'unlink' | 'repair' | 'umd'
  at: string                    // ISO 8601
  rootDir: string
  packageManager: PackageManagerId
  result: 'ok' | 'failed'
  /** target = 被改动对象：manifest 相对路径（文件动作）或 lib 名 / '.lpm/state.json'（档案动作）
   *  action：rewrite-manifest=改写声明；upsert-registration=注册 upsert（lpm.config.json）；
   *          write-state=写档案 state.json（部分改动）；delete-entry=删档案条目/整文件删除（detail 写明） */
  changes: Array<{ target: string; action: 'rewrite-manifest' | 'write-state' | 'delete-entry' | 'upsert-registration'; detail: string }>
  installs: Array<{ command: string; ok: boolean; exitCode: number | null }>
  failure: { command: string; exitCode: number | null; stderrTail: string; message: string } | null
}
