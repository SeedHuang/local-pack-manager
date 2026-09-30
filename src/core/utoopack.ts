import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { stripBom } from '../util.js'
import { ManifestParseError } from './workspace.js'

// ── 错误类（spec §5 逐字；统一「描述。\n下一步：」两行模板）──

export class InitConfigNotFoundError extends Error {
  constructor(cwd: string) {
    super(`未找到 umi 配置文件（已检查 config/config.ts、.umirc.ts、config/config.js、.umirc.js）：${cwd}。\n下一步：请在含 umi 配置的项目目录运行 lpm init`)
    this.name = 'InitConfigNotFoundError'
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
/** 宿主顶层键已存在但值不是对象字面量（如 utoopack: someVar）——无法合并，追加又会撞 TS1117/TS2783 重复属性 */
export class InitKeyNotObjectError extends Error {
  constructor(key: string) {
    super(`宿主配置的 ${key} 不是对象字面量（如 ${key}: someVar），无法自动合并注入。\n下一步：手工把 ${key} 改为对象字面量（${key}: { ... }）后重试，或删除该键让 lpm 追加`)
    this.name = 'InitKeyNotObjectError'
  }
}

// ── 标记常量（单源；spec §3.1）──
const INJECT_START = '/* lpm-inject:start */'
const INJECT_END = '/* lpm-inject:end */'

// ── 宿主定位（spec §4.2 候选文件名按序）──
export const HOST_CONFIG_CANDIDATES = ['config/config.ts', '.umirc.ts', 'config/config.js', '.umirc.js'] as const

export function findHostConfig(cwd: string): string {
  for (const rel of HOST_CONFIG_CANDIDATES) {
    const p = join(cwd, rel)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  throw new InitConfigNotFoundError(cwd)
}

/** workspace 级宿主定位（自动联动用）：遍历成员（含根），候选文件名按序，返回首个命中的宿主目录与配置路径。
 *  手动 `lpm init` 在宿主目录运行；link/unlink 在 workspace 根运行，umi 配置可能在成员子包（如 web/.umirc.ts）。
 *  返回宿主**目录**（dir）——root/alias 计算需要以宿主目录为 cwd（读其 package.json），
 *  而非 dirname(config 路径)（config 可能在 config/ 子目录）。 */
export function findHostConfigInWorkspace(ws: { members: { dir: string }[] }): { dir: string; hostPath: string } | null {
  for (const m of ws.members) {
    try {
      return { dir: m.dir, hostPath: findHostConfig(m.dir) }
    } catch {
      // 该成员无 umi 配置 → 试下一个
    }
  }
  return null
}

// ── 对象体定位（spec §4.4 + §8 自决 2）──
/** 跳过普通字符串（' 或 "），返回闭引号后一位；不闭合 → 末尾（复用 rewriter closingQuote 思路） */
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
/** 跳过 ${...} 插值体（i 指向 '{'），括号配对 + 递归跳过字符串/模板/注释；不闭合 → 末尾 */
function skipInterpolation(source: string, i: number): number {
  let depth = 1
  let j = i + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === '"' || ch === "'") { j = skipString(source, j); continue }
    if (ch === '`') { j = skipTemplate(source, j); continue }
    if (ch === '/' && source[j + 1] === '/') { j = skipLineComment(source, j); continue }
    if (ch === '/' && source[j + 1] === '*') { j = skipBlockComment(source, j); continue }
    if (ch === '{') { depth++; j++; continue }
    if (ch === '}') { depth--; if (depth === 0) return j + 1; j++; continue }
    j++
  }
  return source.length
}
/** 跳过反引号模板字面量（含 ${...} 插值，递归），返回闭反引号后一位；不闭合 → 末尾（OCR H2） */
function skipTemplate(source: string, i: number): number {
  let j = i + 1
  while (j < source.length) {
    if (source[j] === '\\') { j += 2; continue }
    if (source[j] === '$' && source[j + 1] === '{') { j = skipInterpolation(source, j + 1); continue }
    if (source[j] === '`') return j + 1
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
/** 共享跳过 dispatch（OCR H2 单一扫描原语，nextOpenBrace/matchCloseBrace 共用，防两处漂移）：
 *  i 指向候选字符；命中字符串/模板/注释 → 返回跳过后的下标；否则原样返回 i */
function skipIgnorable(source: string, i: number): number {
  const ch = source[i]
  if (ch === '"' || ch === "'") return skipString(source, i)
  if (ch === '`') return skipTemplate(source, i)
  if (ch === '/' && source[i + 1] === '/') return skipLineComment(source, i)
  if (ch === '/' && source[i + 1] === '*') return skipBlockComment(source, i)
  return i
}
/** 从 from 起跳过字符串/模板/注释，返回第一个 '{' 下标；无 → -1 */
function nextOpenBrace(source: string, from: number): number {
  let i = from
  while (i < source.length) {
    const skipped = skipIgnorable(source, i)
    if (skipped !== i) { i = skipped; continue }
    if (source[i] === '{') return i
    i++
  }
  return -1
}
/** 从 open（'{' 下标）起括号配对，返回闭合 '}' 下标；不闭合 → -1 */
function matchCloseBrace(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const skipped = skipIgnorable(source, i)
    if (skipped !== i) { i = skipped; continue }
    const ch = source[i]
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

/** 检测配置对象体的**顶层**键（OCR M1 遮蔽判定收紧）：只认对象体直接子键（嵌套对象/webpack resolve.alias/注释/字符串内的同名键不算）。
 *  与 hasTopLevelKey 同一扫描循环（scanTopLevelKeyHit 单源），此处只是对键名数组求 some。 */
export function hasTopLevelKeys(source: string, keys: readonly string[]): boolean {
  return keys.some((k) => hasTopLevelKey(source, k))
}

/** 顶层键扫描单步（供 locateTopLevelKeyObject 降复杂度，认知复杂度从 37 → 拆分）：
 *  从 body[i]（顶层标识符首字符）读键名/冒号/值。
 *  命中 keyName 且值为 `{...}` → 返回 open/close（body 内下标）；值为非对象/不闭合 → nonObject:true（无法合并）；
 *  键名不匹配或无冒号 → 仅返回 keyEnd 供调用方跳过该标识符继续扫。 */
type KeyScanHit =
  | { keyEnd: number; open: number; close: number }
  | { keyEnd: number; nonObject: true }
  | { keyEnd: number } // 键名不匹配/无冒号：调用方从 keyEnd 跳过后继续扫
function scanTopLevelKey(body: string, i: number, keyName: string): KeyScanHit {
  let j = i
  while (j < body.length && /[A-Za-z0-9_$]/.test(body[j] as string)) j++
  const name = body.slice(i, j)
  let k = j
  while (k < body.length && /\s/.test(body[k] as string)) k++
  if (name !== keyName || body[k] !== ':') return { keyEnd: j }
  let v = k + 1
  while (v < body.length && /\s/.test(body[v] as string)) v++
  if (body[v] !== '{') return { keyEnd: j, nonObject: true }
  const close = matchCloseBrace(body, v)
  if (close === -1) return { keyEnd: j, nonObject: true }
  return { keyEnd: j, open: v, close }
}

/** 顶层键扫描循环（locateTopLevelKeyObject / hasTopLevelKey / hasTopLevelKeys 共用单源）：
 *  配置对象体深度 0 扫 `<keyName>` 键（嵌套/注释/字符串内不算）。命中 → open/close（**绝对下标**，值为对象字面量）
 *  或 nonObject=true（值非对象字面量，无法合并）；无此键 → null。 */
type TopLevelKeyHit = { open: number; close: number } | { nonObject: true }
function scanTopLevelKeyHit(source: string, keyName: string): TopLevelKeyHit | null {
  const range = locateConfigObject(source)
  if (range === null) return null
  const bodyStart = range.start + 1
  const body = source.slice(bodyStart, range.end)
  let depth = 0
  let i = 0
  while (i < body.length) {
    const skipped = skipIgnorable(body, i)
    if (skipped !== i) { i = skipped; continue }
    const ch = body[i] as string
    if (ch === '{') { depth++; i++; continue }
    if (ch === '}') { depth--; i++; continue }
    if (depth === 0 && /[A-Za-z_$]/.test(ch)) {
      const hit = scanTopLevelKey(body, i, keyName)
      if ('nonObject' in hit) return { nonObject: true }
      if ('open' in hit) return { open: bodyStart + hit.open, close: bodyStart + hit.close }
      i = hit.keyEnd
      continue
    }
    i++
  }
  return null
}

/** 定位配置对象体顶层 `<keyName>` 键的对象体范围（绝对下标；值须为 `{...}`）。
 *  S14 方案 A：宿主已有同名键时不再「追加新键」——TS 不允许同名属性（TS1117/TS2783），
 *  改为**合并进宿主键对象体内部**。该函数即定位合并插入点；找不到 → null（宿主无此键，走追加）。 */
export function locateTopLevelKeyObject(source: string, keyName: string): { start: number; end: number } | null {
  const hit = scanTopLevelKeyHit(source, keyName)
  if (hit === null || 'nonObject' in hit) return null // 无此键 / 值非对象 → 无法合并，走追加或由调用方报错
  return { start: hit.open, end: hit.close }
}

/** 宿主配置对象体是否已有顶层 `<keyName>` 键（值类型不限）。与 locateTopLevelKeyObject 的分工：
 *  「无此键」→ 可追加新键；「有此键但值非对象字面量」→ 既不能合并也不能追加（追加会撞 TS1117/TS2783），
 *  由调用方按 hasTopLevelKey=true + locateTopLevelKeyObject=null 判定后抛 InitKeyNotObjectError。 */
export function hasTopLevelKey(source: string, keyName: string): boolean {
  return scanTopLevelKeyHit(source, keyName) !== null
}

/** 单步扫顶层键名（topLevelKeyNames 拆复杂度用）：body[i] 为标识符或引号起始 → 返回键名与键名后下标（hasColon 指示是否真是键）；否则 null */
type KeyNameHit = { name: string; next: number; hasColon: boolean }
function scanTopLevelKeyName(body: string, i: number): KeyNameHit | null {
  let j: number
  let name: string
  if (body[i] === '"' || body[i] === "'") {
    j = skipString(body, i)
    name = body.slice(i + 1, j - 1)
  } else if (/[A-Za-z_$]/.test(body[i] as string)) {
    j = i + 1
    while (j < body.length && /[A-Za-z0-9_$]/.test(body[j] as string)) j++
    name = body.slice(i, j)
  } else {
    return null
  }
  let k = j
  while (k < body.length && /\s/.test(body[k] as string)) k++
  return { name, next: j, hasColon: body[k] === ':' }
}

/** 对象体（绝对范围，含 { }）内顶层子键名集合（深度 0；标识符与引号键都认，嵌套/注释/字符串内不算）——合并模式查重用 */
function topLevelKeyNames(source: string, range: { start: number; end: number }): Set<string> {
  const body = source.slice(range.start + 1, range.end)
  const names = new Set<string>()
  let depth = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i] as string
    // 引号键名（如 '@ant-design/icons': ...）须在 skipIgnorable 吞掉字符串之前识别；非键的字符串值 hasColon=false 同样安全跳过
    if (depth === 0 && (ch === '"' || ch === "'" || /[A-Za-z_$]/.test(ch))) {
      const hit = scanTopLevelKeyName(body, i)
      if (hit !== null) {
        if (hit.hasColon) names.add(hit.name)
        i = hit.next
        continue
      }
    }
    const skipped = skipIgnorable(body, i)
    if (skipped !== i) { i = skipped; continue }
    if (ch === '{') { depth++; i++; continue }
    if (ch === '}') { depth--; i++; continue }
    i++
  }
  return names
}

// ── 标记检测（spec §4.8 自感知）──
/** 首个标记（spec §4.8 自感知；不完整标记照实返回 complete:false）——findAllMarkers 的 [0]，消除重复扫描逻辑 */
export function findMarker(source: string): { start: number; end: number; complete: boolean } | null {
  return findAllMarkers(source)[0] ?? null
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
  // OCR M3：POSIX 公共前缀仅到根（首段为 ''）→ 公共祖先即文件系统根 '/'
  if (joined === '') return '/'
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

// ── 标记段注入 / 摘除（spec §4.4 文本级保真 + §8 自决 1 三态逗号；S14 方案 A 起支持多标记段）──
const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 找**所有**标记段（S14 方案 A：合并模式在宿主键内部打标、追加模式在对象体末尾打标，可能有多段）。
 *  不完整标记（有 start 无 end）照实返回 complete:false，由 removeAll 拒绝自动摘除。 */
export function findAllMarkers(source: string): { start: number; end: number; complete: boolean }[] {
  const out: { start: number; end: number; complete: boolean }[] = []
  let from = 0
  for (;;) {
    const s = source.indexOf(INJECT_START, from)
    if (s === -1) break
    const e = source.indexOf(INJECT_END, s)
    if (e === -1) {
      out.push({ start: s, end: -1, complete: false })
      break
    }
    out.push({ start: s, end: e + INJECT_END.length, complete: true })
    from = e + INJECT_END.length
  }
  return out
}

/** alias 行渲染（buildFragment 追加 / alias 追加分支 / alias 合并分支 三处共用）：非法裸标识符加引号 + `${key}: '${v}',` */
function renderAliasEntries(aliasMap: Record<string, string>): string[] {
  return Object.entries(aliasMap).map(([k, v]) => {
    // OCR H1：包名可含连字符/scope（react-dom、@ant-design/icons 等），非法裸标识符必须加引号——否则产出语法错误的 umi 配置
    const key = JS_IDENT_RE.test(k) ? k : `'${k}'`
    return `${key}: '${v}',`
  })
}

/**
 * 追加模式片段（宿主**无**同名键时用）：普通键（非对象展开——无同名冲突，无需展开规避 TS1117）。
 * 标记段包裹整个新键，摘除即还原。
 */
export function buildFragment(root: string, aliasMap: Record<string, string>): string {
  const lines: string[] = [INJECT_START, 'utoopack: {', `  root: '${root}',`, '},']
  if (Object.keys(aliasMap).length > 0) {
    lines.push('alias: {')
    for (const line of renderAliasEntries(aliasMap)) lines.push(`  ${line}`)
    lines.push('},')
  }
  lines.push(INJECT_END)
  return lines.join('\n')
}

/** 追加模式：把 fragment（含标记段）插到配置对象体末尾（spec §8 自决 1 三态逗号）。 */
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

/**
 * 合并模式（S14 方案 A，宿主**有**同名键时用）：把注入行（root 或 alias peer）以标记段包裹，
 * 插进宿主 `<keyName>` 键对象体**内部**——不产生第二个同名键，TS1117/TS2783 从根上消失；
 * uninit 摘除标记段后宿主键保留原内容（含原键内其他配置）。
 * 三态逗号同 injectFragment，但作用对象是键对象体。
 */
export function injectIntoKey(source: string, keyName: string, bodyLines: string[]): string {
  const key = locateTopLevelKeyObject(source, keyName)
  if (key === null) throw new InitConfigShapeError()
  // OCR：查重——宿主键体内已有同名子键（如 utoopack: { root: 'custom' } / alias: { react: ... }）时跳过该行，
  // 避免同一对象字面量内追加同名属性（TS1117/TS2783）；全部被跳过 → 零改动返回
  const existing = topLevelKeyNames(source, key)
  const lines = bodyLines.filter((l) => {
    const name = l.slice(0, l.indexOf(':'))
    const unquoted = name.length >= 2 && (name[0] === "'" || name[0] === '"') ? name.slice(1, -1) : name.trim()
    return !existing.has(unquoted)
  })
  if (lines.length === 0) return source
  const { start, end } = key
  let k = end - 1
  while (k > start && /\s/.test(source[k] as string)) k--
  const empty = k === start
  const hasTrailingComma = !empty && source[k] === ','
  const body = [INJECT_START, ...lines, INJECT_END]
  // 键体比配置对象体深一层：对象体行缩进 2 空格 → 键体行缩进 4 空格（与 injectFragment 的 2 空格呼应）
  const indented = body.map((l) => `    ${l}`).join('\n')
  // 空键体（{ 后紧接 }）：不加前导 \n，且首行去掉 4 空格缩进让 start 标记与 { 紧贴——} 保持原位（同行），
  // 这样 uninit 摘除标记段后能 byte 还原回 {}（加 \n 会残留 {\n}，留缩进会残留 {    }）
  const block = empty ? indented.slice(4) : indented
  const insert = (empty || hasTrailingComma ? '' : ',') + (empty ? '' : '\n') + block
  return source.slice(0, k + 1) + insert + source.slice(k + 1)
}

/**
 * 一站式注入（S14 方案 A）：按宿主有无同名键决定「合并进键」还是「追加新键」。
 * - utoopack：宿主有 → root 合并进宿主 utoopack 键对象体内部；无 → 追加新键
 * - alias：宿主有 → peer 合并进宿主 alias 键内部；无 → 追加新键
 * 返回注入后全文（可能含 1~2 个标记段）。
 */
export function injectAdaptation(source: string, root: string, aliasMap: Record<string, string>): string {
  let out = source
  // utoopack：合并 or 追加（键已存在但值非对象字面量 → 报错，绝不追加同名键撞 TS1117/2783）
  if (hasTopLevelKey(out, 'utoopack')) {
    if (locateTopLevelKeyObject(out, 'utoopack') === null) throw new InitKeyNotObjectError('utoopack')
    out = injectIntoKey(out, 'utoopack', [`root: '${root}',`])
  } else {
    out = injectFragment(out, buildFragment(root, {}))
  }
  // alias：合并 or 追加
  if (Object.keys(aliasMap).length > 0) {
    if (hasTopLevelKey(out, 'alias')) {
      if (locateTopLevelKeyObject(out, 'alias') === null) throw new InitKeyNotObjectError('alias')
      out = injectIntoKey(out, 'alias', renderAliasEntries(aliasMap))
    } else {
      const aliasLines: string[] = [INJECT_START, 'alias: {']
      for (const line of renderAliasEntries(aliasMap)) aliasLines.push(`  ${line}`)
      aliasLines.push('},', INJECT_END)
      out = injectFragment(out, aliasLines.join('\n'))
    }
  }
  return out
}

/** 摘除**所有**标记段（S14 方案 A：可能多处）。任一不完整 → InitIncompleteMarkerError（绝不自动摘除）。 */
export function removeFragment(source: string): string {
  const markers = findAllMarkers(source)
  if (markers.length === 0) throw new InitNotInjectedError()
  if (markers.some((m) => !m.complete)) throw new InitIncompleteMarkerError()
  // 从后往前摘除（先摘靠后的，避免下标漂移）
  let out = source
  for (let i = markers.length - 1; i >= 0; i--) {
    const m = markers[i] as { start: number; end: number }
    let k = m.start - 1
    while (k >= 0 && /\s/.test(out[k] as string)) k--
    // 命中逗号 → 连逗号一起摘（追加/合并段的分隔逗号）；否则摘到前一非空白字符之后（吞掉标记行自身的缩进，
    // 否则空键体合并段会残留 `{    }`——那 4 空格是 start 标记行的缩进，不属于宿主原内容）
    const removeStart = k >= 0 && out[k] === ',' ? k : k + 1
    out = out.slice(0, removeStart) + out.slice(m.end)
  }
  return out
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripBom(readFileSync(filePath, 'utf8')))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
  return parsed as Record<string, unknown>
}

// ── peer dedupe alias 集合（spec §4.5 + §8 自决 4/5/11）──
export interface AliasPlan {
  alias: Record<string, string>
  /** declared 但两处 node_modules 均未找到的 peer（spec §8 自决 11「跳过 + 提示」——由上层 runInit 打印提示，OCR M2） */
  skipped: string[]
}

export function buildAliasMap(cwd: string, rootDir: string, libDirs: string[]): AliasPlan {
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
    // OCR L6：与 peers 守卫一致，数组型 dependencies/devDependencies 不入键集（否则 Object.keys 得数字下标）
    ...(deps !== null && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps as Record<string, unknown>) : []),
    ...(devDeps !== null && typeof devDeps === 'object' && !Array.isArray(devDeps) ? Object.keys(devDeps as Record<string, unknown>) : []),
  ])
  const alias: Record<string, string> = {}
  const skipped: string[] = []
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
      // spec §8 自决 11：两者皆无 → 跳过 + 提示（declared 未安装，非 lpm 职责）——OCR M2 收集进 skipped 交上层打印
      skipped.push(peer)
    }
  }
  return { alias, skipped }
}
