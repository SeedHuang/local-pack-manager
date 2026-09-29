import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ManifestParseError } from './workspace.js'

// ── 错误类（spec §5 逐字；统一「描述。\n下一步：」两行模板）──

export class InitConfigNotFoundError extends Error {
  constructor(cwd: string) {
    super(`未找到 umi 配置文件（已检查 config/config.ts、.umirc.ts、config/config.js、.umirc.js）。\n下一步：请在含 umi 配置的项目目录运行 lpm init`)
    this.name = 'InitConfigNotFoundError'
    void cwd
  }
}
export class InitConfigShapeError extends Error {
  constructor() {
    super(`无法定位 umi 配置对象体。\n下一步：确认配置文件以 export default defineConfig({ 或 export default { 开头`)
    this.name = 'InitConfigShapeError'
  }
}
export class InitRootError extends Error {
  constructor(libs: string) {
    super(`无法计算 utoopack.root（跨盘符或无公共祖先）：lib=${libs}。\n下一步：将 lib 与宿主放到同一盘符、或调整目录结构后重试`)
    this.name = 'InitRootError'
  }
}
export class InitHostPkgError extends Error {
  constructor(cwd: string) {
    super(`未找到宿主 package.json：${cwd}。\n下一步：确认在含 package.json 的项目目录运行 lpm init`)
    this.name = 'InitHostPkgError'
  }
}
export class InitInteractionError extends Error {
  constructor(cmd: 'init' | 'uninit') {
    super(`需交互确认注入/摘除计划。\n下一步：改用 lpm ${cmd} --dry-run 查看预览`)
    this.name = 'InitInteractionError'
  }
}
export class InitAlreadyInjectedError extends Error {
  constructor() {
    super(`宿主配置已注入 lpm 片段。\n下一步：先 lpm uninit 摘除后再重新注入`)
    this.name = 'InitAlreadyInjectedError'
  }
}
export class InitNotInjectedError extends Error {
  constructor() {
    super(`未检测到 lpm 注入片段。\n下一步：先运行 lpm init 注入`)
    this.name = 'InitNotInjectedError'
  }
}
export class InitIncompleteMarkerError extends Error {
  constructor() {
    super(`检测到不完整的 lpm 注入标记（缺结束标记）。\n下一步：请手工删除 config 中残留的 /* lpm-inject:start */ 后重试`)
    this.name = 'InitIncompleteMarkerError'
  }
}

// ── 标记常量（单源；spec §3.1）──
export const INJECT_START = '/* lpm-inject:start */'
export const INJECT_END = '/* lpm-inject:end */'

// ── 宿主定位（spec §4.2 候选文件名按序）──
const HOST_CONFIG_CANDIDATES = ['config/config.ts', '.umirc.ts', 'config/config.js', '.umirc.js'] as const

export function findHostConfig(cwd: string): string {
  for (const rel of HOST_CONFIG_CANDIDATES) {
    const p = join(cwd, rel)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  throw new InitConfigNotFoundError(cwd)
}

// ── 源码读取：剥 UTF-8 BOM（spec §8 自决 12）──
export function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
}

// ── 对象体定位（spec §4.4 + §8 自决 2）──
function skipString(source: string, i: number): number {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    if (source[j] === '\\') { j += 2; continue }
    if (source[j] === quote) return j + 1
    j++
  }
  return source.length
}
function skipLineComment(source: string, i: number): number {
  const nl = source.indexOf('\n', i)
  return nl === -1 ? source.length : nl + 1
}
function skipBlockComment(source: string, i: number): number {
  const close = source.indexOf('*/', i + 2)
  return close === -1 ? source.length : close + 2
}
/** 从 from 起跳过字符串/注释，返回第一个 '{' 下标；无 → -1 */
function nextOpenBrace(source: string, from: number): number {
  let i = from
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = skipString(source, i); continue }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue }
    if (ch === '{') return i
    i++
  }
  return -1
}
/** 从 open（'{' 下标）起括号配对，返回闭合 '}' 下标；不闭合 → -1 */
function matchCloseBrace(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'") { i = skipString(source, i); continue }
    if (ch === '/' && source[i + 1] === '/') { i = skipLineComment(source, i); continue }
    if (ch === '/' && source[i + 1] === '*') { i = skipBlockComment(source, i); continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

export function locateConfigObject(source: string): { start: number; end: number } | null {
  const def = source.indexOf('defineConfig(')
  const exp = source.indexOf('export default {')
  let open = -1
  if (def !== -1 && (exp === -1 || def < exp)) {
    open = nextOpenBrace(source, def + 'defineConfig('.length)
  } else if (exp !== -1) {
    open = exp + 'export default {'.length - 1 // 指向 '{'
  }
  if (open === -1) return null
  const close = matchCloseBrace(source, open)
  if (close === -1) return null
  return { start: open, end: close }
}

// ── 标记检测（spec §4.8 自感知）──
export function findMarker(source: string): { start: number; end: number; complete: boolean } | null {
  const s = source.indexOf(INJECT_START)
  if (s === -1) return null
  const e = source.indexOf(INJECT_END, s)
  if (e === -1) return { start: s, end: -1, complete: false }
  return { start: s, end: e + INJECT_END.length, complete: true }
}

// ── 公共祖先与相对路径（spec §4.4；root 计算原语）──
export function commonAncestor(absPaths: string[]): string {
  if (absPaths.length === 0) return ''
  if (absPaths.length === 1) return resolve(absPaths[0] as string, '..').replaceAll('\\', '/')
  const segs = absPaths.map((p) => resolve(p).split(/[\\/]/))
  const first = segs[0] as string[]
  let n = 0
  outer: for (; n < first.length; n++) {
    for (const s of segs) {
      if ((s[n] ?? '') !== (first[n] ?? '')) break outer
    }
  }
  // 公共前缀段数 n；首段即不同（跨盘符）→ 无祖先
  if (n === 0) return ''
  const joined = (first as string[]).slice(0, n).join('/')
  // Windows 盘符段（C:）需补成路径
  return /^[a-zA-Z]:$/.test(joined) ? `${joined}/` : joined
}

export function toRelSlashes(fromDir: string, toDir: string): string {
  const rel = relative(fromDir, toDir).replaceAll('\\', '/')
  if (isAbsolute(rel) || /(^|\/)[a-zA-Z]:(\/|$)/.test(rel)) {
    throw new InitRootError(`${toDir}`)
  }
  return rel === '' ? '.' : rel
}

export function buildRootValue(cwd: string, libDirs: string[]): string {
  const target = commonAncestor([cwd, ...libDirs])
  if (target === '') throw new InitRootError(libDirs.join('、'))
  return toRelSlashes(cwd, target)
}

// ── 标记段注入 / 摘除（spec §4.4 文本级保真 + §8 自决 1 三态逗号）──
export function buildFragment(root: string, aliasMap: Record<string, string>): string {
  const lines: string[] = [INJECT_START, 'utoopack: {', `  root: '${root}',`, '},']
  if (Object.keys(aliasMap).length > 0) {
    lines.push('alias: {')
    for (const [k, v] of Object.entries(aliasMap)) lines.push(`  ${k}: '${v}',`)
    lines.push('},')
  }
  lines.push(INJECT_END)
  return lines.join('\n')
}

export function injectFragment(source: string, fragment: string): string {
  const range = locateConfigObject(source)
  if (range === null) throw new InitConfigShapeError()
  // 取对象体闭合 '}' 前最后一个非空白字符
  let k = range.end - 1
  while (k > range.start && /\s/.test(source[k] as string)) k--
  const empty = k === range.start // 空对象体（{ 后紧接 } 或仅空白）
  const hasTrailingComma = !empty && source[k] === ','
  const indented = fragment.split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n')
  // 无尾逗号且非空 → 补逗号；空体/有尾逗号 → 不补（indented 已含每行 2 空格缩进，spec §8 自决 1 形态 \n  /* lpm-inject:start */）
  const insert = (empty || hasTrailingComma ? '' : ',') + '\n' + indented
  return source.slice(0, k + 1) + insert + source.slice(k + 1)
}

export function removeFragment(source: string): string {
  const m = findMarker(source)
  if (m === null) throw new InitNotInjectedError()
  if (!m.complete) throw new InitIncompleteMarkerError()
  // start 前一个非空白字符若是 ','（注入补的逗号或宿主尾逗号）→ 连同删除
  let k = m.start - 1
  while (k >= 0 && /\s/.test(source[k] as string)) k--
  const removeStart = k >= 0 && source[k] === ',' ? k : m.start
  return source.slice(0, removeStart) + source.slice(m.end)
}

export function readJsonSafe(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripBom(readFileSync(filePath, 'utf8')))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
  return parsed as Record<string, unknown>
}

// ── peer dedupe alias 集合（spec §4.5 + §8 自决 4/5/11）──
export function buildAliasMap(cwd: string, rootDir: string, libDirs: string[]): Record<string, string> {
  const hostPkgPath = join(cwd, 'package.json')
  if (!existsSync(hostPkgPath)) throw new InitHostPkgError(cwd)
  let hostPkg: Record<string, unknown>
  try {
    hostPkg = readJsonSafe(hostPkgPath)
  } catch (err) {
    // 宿主 package.json 坏 JSON：readJsonSafe 抛裸 Error（上游 KNOWN 不可捕获）→ 转 ManifestParseError（spec §5 W2 模板）
    throw new ManifestParseError(hostPkgPath, `${hostPkgPath} 不是合法 JSON（${(err as Error).message}）。\n下一步：修正 JSON 语法后重试`)
  }
  const deps = hostPkg['dependencies']
  const devDeps = hostPkg['devDependencies']
  const hostDeps = new Set<string>([
    ...(deps !== null && typeof deps === 'object' ? Object.keys(deps as Record<string, unknown>) : []),
    ...(devDeps !== null && typeof devDeps === 'object' ? Object.keys(devDeps as Record<string, unknown>) : []),
  ])
  const alias: Record<string, string> = {}
  for (const libDir of libDirs) {
    let libPkg: Record<string, unknown>
    try {
      libPkg = readJsonSafe(join(libDir, 'package.json'))
    } catch {
      continue // spec §8 自决 5：单 lib 不可读 → 跳过 dedupe，不阻断
    }
    const peers = libPkg['peerDependencies']
    if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) continue
    for (const peer of Object.keys(peers as Record<string, unknown>)) {
      if (!hostDeps.has(peer) || alias[peer] !== undefined) continue
      const cwdPath = join(cwd, 'node_modules', peer)
      if (existsSync(cwdPath)) { alias[peer] = cwdPath.replaceAll('\\', '/'); continue }
      const rootPath = join(rootDir, 'node_modules', peer)
      if (existsSync(rootPath)) { alias[peer] = rootPath.replaceAll('\\', '/'); continue }
      // spec §8 自决 11：两者皆无 → 跳过 + 提示（declared 未安装，非 lpm 职责）
    }
  }
  return alias
}
