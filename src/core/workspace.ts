import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { matchWorkspacePattern } from './globmatch.js'

// —— 数据契约（S1 spec §4.2 冻结，不得改动）——

export interface PackageJsonInfo {
  dir: string            // 包目录绝对路径
  manifestPath: string   // package.json 绝对路径
  name: string           // 包 name（缺失时为空串）
  isRoot: boolean
}

export interface Workspace {
  rootDir: string
  manifestFormat: 'pnpm-workspace' | 'package-json' | 'single'   // single = 非 monorepo
  members: PackageJsonInfo[]                                     // 含根自身
}

export interface DepHit {
  manifestPath: string
  section: 'dependencies' | 'devDependencies' | 'optionalDependencies'
  currentValue: string    // 当前 range 字面值
}

// —— 错误类（S2 spec §4.3；文案 = spec §6 逐字）——

export class WorkspaceNotFoundError extends Error {
  constructor(
    public kind: 'start-dir-missing' | 'root-not-found' | 'invalid-root',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceNotFoundError'
  }
}

export class ManifestParseError extends Error {
  constructor(public manifestPath: string, message: string) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

export class WorkspacePatternError extends Error {
  constructor(public pattern: string, public manifestPath: string, message: string) {
    super(message)
    this.name = 'WorkspacePatternError'
  }
}

// —— 内部：manifest 读取（spec §4.2 读取规约：剥 UTF-8 BOM）——

function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

/** 严格读取：不可读 / JSON 坏 → ManifestParseError（§6.4） */
function readManifest(manifestPath: string): Record<string, unknown> {
  let source: string
  try {
    source = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new ManifestParseError(
      manifestPath,
      `清单解析失败：${manifestPath}（无法读取文件）。请确认文件存在且可读。`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(source))
  } catch (e) {
    throw new ManifestParseError(
      manifestPath,
      `清单解析失败：${manifestPath}（${(e as Error).message}）。请修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状。`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestParseError(
      manifestPath,
      `清单解析失败：${manifestPath}（根值不是 JSON 对象）。请修正 JSON 语法后重试。`,
    )
  }
  return parsed as Record<string, unknown>
}

/** 容错读取：仅用于 findWorkspaceRoot 的标记探测（§4.4.3：解析失败不算标记，继续向上） */
function tryReadManifest(manifestPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripBom(readFileSync(manifestPath, 'utf8'))) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 提取 workspaces patterns：数组或 { packages: 数组 }（均须全字符串项）；其余形态一律 null（视为无，§4.5.2） */
function extractWorkspacesPatterns(manifest: Record<string, unknown>): string[] | null {
  const w = manifest['workspaces']
  if (Array.isArray(w) && w.every((x) => typeof x === 'string')) return w as string[]
  if (w !== null && typeof w === 'object' && !Array.isArray(w)) {
    const pkgs = (w as { packages?: unknown })['packages']
    if (Array.isArray(pkgs) && pkgs.every((x) => typeof x === 'string')) return pkgs as string[]
  }
  return null
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}

// —— 内部：pnpm-workspace.yaml 极简 YAML 子集（spec §5 YAML 规则 1-6）——

function yamlError(yamlPath: string, reason: string): ManifestParseError {
  return new ManifestParseError(
    yamlPath,
    `pnpm-workspace.yaml 解析失败：${yamlPath}（${reason}）。lpm 仅支持 pnpm 默认风格的 packages 列表（2 空格缩进）；复杂 YAML 请简化后重试。`,
  )
}

/** 去引号 / 行内注释截断（§5 YAML.2/.4） */
function unquoteValue(token: string, yamlPath: string): string {
  if (token.startsWith("'") || token.startsWith('"')) {
    const end = token.indexOf(token[0], 1)
    if (end === -1) throw yamlError(yamlPath, '引号不闭合')
    const rest = token.slice(end + 1).trim()
    if (rest !== '' && !rest.startsWith('#')) throw yamlError(yamlPath, '引号后有多余内容')
    return token.slice(1, end)
  }
  const hash = token.indexOf('#')
  return (hash === -1 ? token : token.slice(0, hash)).trim()
}

/** 引号感知的行内注释截断：返回注释前的部分（引号内的 # 保留）（§5 YAML.4） */
function stripInlineComment(token: string): string {
  let quote: string | null = null
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '#') return token.slice(0, i)
  }
  return token
}

/** 流列表 `packages: ['a', b]`（§5 YAML.3） */
function parseFlowList(rest: string, yamlPath: string): string[] {
  if (rest === '') return []
  if (!(rest.startsWith('[') && rest.endsWith(']'))) {
    throw yamlError(yamlPath, 'packages: 后跟非列表标量')
  }
  const inner = rest.slice(1, -1).trim()
  if (inner === '') return []
  return inner.split(',').map((item) => unquoteValue(item.trim(), yamlPath))
}

/** 只提取第 0 列 packages 键；其余键整体忽略（§5 YAML.1/.5/.6） */
function parsePackagesYaml(source: string, yamlPath: string): string[] {
  const patterns: string[] = []
  let inPackages = false
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!/^[ \t]/.test(line) && !line.startsWith('-')) {
      if (trimmed === 'packages:') {
        inPackages = true
      } else if (trimmed.startsWith('packages:')) {
        const rest = stripInlineComment(trimmed.slice('packages:'.length)).trim()
        if (rest === '') {
          inPackages = true   // packages: # 注释 ≡ 空 packages 键，块列表仍可跟随（§5 YAML.5）
        } else {
          patterns.push(...parseFlowList(rest, yamlPath))
          inPackages = false
        }
      } else {
        inPackages = false
      }
      continue
    }
    if (inPackages && trimmed.startsWith('-')) {
      const indent = line.length - line.trimStart().length
      if (indent !== 2) {
        throw yamlError(yamlPath, `列表项缩进为 ${indent} 空格，lpm 仅支持 2 空格`)
      }
      patterns.push(unquoteValue(trimmed.slice(1).trim(), yamlPath))
    }
    // 其余缩进行（其他键的子块，如 catalog/allowBuilds）→ 忽略
  }
  return patterns
}

// —— 公开 API（S1 冻结签名；§4.4 行为契约）——

export async function findWorkspaceRoot(startDir: string): Promise<string> {
  if (!isDir(startDir)) {
    throw new WorkspaceNotFoundError(
      'start-dir-missing',
      `路径不存在：${startDir}。请检查路径后重试。`,
    )
  }
  let current = startDir
  let firstManifestDir: string | null = null
  for (;;) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current
    const manifestPath = path.join(current, 'package.json')
    if (existsSync(manifestPath)) {
      if (firstManifestDir === null) firstManifestDir = current
      if (extractWorkspacesPatterns(tryReadManifest(manifestPath) ?? {}) !== null) return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (firstManifestDir !== null) return firstManifestDir
  throw new WorkspaceNotFoundError(
    'root-not-found',
    '未找到项目根（未发现 workspace 清单或 package.json）。请进入项目目录后运行 lpm。',
  )
}

export async function loadWorkspace(rootDir: string): Promise<Workspace> {
  const rootManifestPath = path.join(rootDir, 'package.json')
  if (!existsSync(rootManifestPath)) {
    throw new WorkspaceNotFoundError(
      'invalid-root',
      `${rootDir} 不是有效的项目根（缺 package.json）。请以 findWorkspaceRoot 的返回值为根。`,
    )
  }
  const rootManifest = readManifest(rootManifestPath)

  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml')
  let manifestFormat: Workspace['manifestFormat']
  let patterns: string[]
  let patternSource: string
  if (existsSync(yamlPath)) {
    manifestFormat = 'pnpm-workspace'
    patterns = parsePackagesYaml(readFileSync(yamlPath, 'utf8'), yamlPath)
    patternSource = yamlPath
  } else {
    const w = extractWorkspacesPatterns(rootManifest)
    if (w !== null) {
      manifestFormat = 'package-json'
      patterns = w
      patternSource = rootManifestPath
    } else {
      manifestFormat = 'single'
      patterns = []
      patternSource = rootManifestPath
    }
  }

  // pattern 前置校验（§4.5.3：错误前置、一次报全）——OCR O5：与 listWorkspaceMembers 共用 validatePatterns
  validatePatterns(patterns, patternSource)

  const members: PackageJsonInfo[] = [
    {
      dir: rootDir,
      manifestPath: rootManifestPath,
      name: typeof rootManifest['name'] === 'string' ? rootManifest['name'] : '',
      isRoot: true,
    },
  ]
  members.push(...collectMembers(rootDir, patterns))
  return { rootDir, manifestFormat, members }
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export async function findDependents(ws: Workspace, pkgName: string): Promise<DepHit[]> {
  const hits: DepHit[] = []
  for (const member of ws.members) {
    const manifest = readManifest(member.manifestPath)
    for (const section of DEP_SECTIONS) {
      const deps = manifest[section]
      if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
        const value = (deps as Record<string, unknown>)[pkgName]
        if (typeof value === 'string') {
          hits.push({ manifestPath: member.manifestPath, section, currentValue: value })
        }
      }
    }
  }
  return hits
}

/** pattern 前置校验（§4.5.3 错误前置、一次报全）：以空 relDir 探测调用匹配器完成校验；
 *  WorkspacePatternError 重抛时补全清单路径定位——loadWorkspace 与 listWorkspaceMembers 共用（OCR O5 单源） */
function validatePatterns(patterns: string[], patternSource: string): void {
  for (const p of patterns) {
    try {
      matchWorkspacePattern(p, '')
    } catch (e) {
      if (e instanceof WorkspacePatternError) {
        throw new WorkspacePatternError(
          e.pattern,
          patternSource,
          e.message.replace('）。支持：', `）。清单：${patternSource}。支持：`),
        )
      }
      throw e
    }
  }
}

/** loadWorkspace 与 listWorkspaceMembers 共用的成员展开（计划期修订 1：单一真相抽取）。
 *  patterns 为空 → 空数组；正模式并集（Set 保持首次命中序 = DFS 字典序）→ 依序负模式剔除；
 *  命中目录无 package.json → 非成员（后代已在 collected 中）；manifest 严格读取（§4.2 读取规约）。 */
function collectMembers(rootDir: string, patterns: string[]): PackageJsonInfo[] {
  if (patterns.length === 0) return []
  const positives = patterns.filter((p) => !p.startsWith('!'))
  const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  const collected: string[] = []
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      collected.push(childRel)
      walk(path.join(dir, entry.name), childRel)
    }
  }
  walk(rootDir, '')
  const hit = new Set<string>()
  for (const rel of collected) {
    if (positives.some((p) => matchWorkspacePattern(p, rel))) hit.add(rel)
  }
  const out: PackageJsonInfo[] = []
  for (const rel of hit) {
    if (negatives.some((p) => matchWorkspacePattern(p, rel))) continue
    const manifestPath = path.join(rootDir, rel, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readManifest(manifestPath)
    out.push({
      dir: path.join(rootDir, rel),
      manifestPath,
      name: typeof manifest['name'] === 'string' ? manifest['name'] : '',
      isRoot: false,
    })
  }
  return out
}

/** B4 形态 A（S6 spec §4.3/§4.4 B1）：lib 路径是无 package.json 的 pnpm monorepo 根
 *  （本地有 pnpm-workspace.yaml）→ 解析 packages patterns 展开成员（不含根——根无 manifest）。
 *  无 pnpm-workspace.yaml → WorkspaceNotFoundError('invalid-root')；成员展开与 loadWorkspace
 *  共用 collectMembers（单一真相）；pattern 语义错误前置校验（同 loadWorkspace 重抛机制）。 */
export async function listWorkspaceMembers(rootDir: string): Promise<PackageJsonInfo[]> {
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) {
    throw new WorkspaceNotFoundError(
      'invalid-root',
      `${rootDir} 不是 npm 包（缺 package.json）且缺 pnpm-workspace.yaml，无法作为 lib 链接。请确认路径指向包目录或 pnpm monorepo 根。`,
    )
  }
  const patterns = parsePackagesYaml(readFileSync(yamlPath, 'utf8'), yamlPath)
  validatePatterns(patterns, yamlPath)
  return collectMembers(rootDir, patterns)
}
