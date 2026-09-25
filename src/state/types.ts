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
