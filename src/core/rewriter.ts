import { isAbsolute, relative } from 'node:path'
import type { PackageManagerId } from './pm.js'

export type Protocol = 'link' | 'portal' | 'file'

// 协议映射单源（S3 spec §8 定版；S5 spec §4.4 F6：常量单源，防多处清单漂移成第二份真相）
const PROTOCOL_BY_PM: Record<PackageManagerId, Protocol> = {
  pnpm: 'link',
  'yarn-classic': 'link',
  'yarn-berry': 'portal',
  npm: 'file',
}

/** mapProtocol 无法相对化（Windows 跨盘符，path.relative 退化为绝对路径）时抛出 */
export class ProtocolPathError extends Error {
  constructor(
    public libDirAbs: string,
    public manifestDirAbs: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProtocolPathError'
  }
}

/** PRD §5 协议映射：pnpm | yarn-classic → link:，yarn-berry → portal:，npm → file:；
 *  返回完整依赖值（协议前缀 + 相对路径），相对路径基于 manifest 所在目录换算，
 *  正斜杠，永不输出绝对路径 */
export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string {
  const protocol = PROTOCOL_BY_PM[pm]
  const rel = relative(manifestDirAbs, libDirAbs).replaceAll('\\', '/')
  // 跨盘符双兜底（spec §4.4 步骤 4；OCR 修复轮尾锚定精化）：isAbsolute 捕获平台原生绝对路径
  // （Windows 跨盘符时 path.relative 退化为盘符开头绝对路径）；盘符段正则（尾锚定：冒号后随
  // '/' 或串尾）捕获任意位置盘符形态——含 POSIX 上 path.relative 对 Windows 跨盘符输入的
  // 退化产物 '../D:/...'，同时不误伤 POSIX 合法的含冒号目录名（如 '../c:cache'）
  if (isAbsolute(rel) || /(^|\/)[a-zA-Z]:(\/|$)/.test(rel)) {
    throw new ProtocolPathError(
      libDirAbs,
      manifestDirAbs,
      `无法生成相对路径（跨盘符？）：libDir=${libDirAbs} manifestDir=${manifestDirAbs}\n下一步：Windows 无法跨盘符写相对路径——将 lib 与项目放到同一盘符后重试`,
    )
  }
  // 步骤 3（OCR 修复轮段感知精化）：不以 './' 或 '../' 段开头（/^\.\.?($|\/)/）补 './' 前缀
  // ——防 '.libs/foo' 这类点开头目录产出非法 'file:.libs/foo'；空串（同目录）→ './'
  let relFixed = rel
  if (rel === '') relFixed = './'
  else if (!/^\.\.?($|\/)/.test(rel)) relFixed = `./${rel}`
  return `${protocol}:${relFixed}`
}

export interface RewriteResult {
  content: string          // 改写后全文
  changedKeys: string[]    // "段名.包名"
  unchangedKeys: string[]  // 值已等于目标（幂等命中）
}

/** 文本级替换（PRD §9）：保持缩进 / key 顺序 / 尾随换行 / CRLF-LF / BOM；
 *  仅动命中行的 value；命中段：dependencies / devDependencies / optionalDependencies */
export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult {
  const hits = scanManifest(manifestSource, pkgName)
  // 段级判定（F3 去重）：任一命中点需改写 → 该段记 changed；全部命中点幂等 → 记 unchanged
  const unchangedBySection = new Map<string, boolean>()
  for (const hit of hits) {
    const unchanged = safeJsonParse(hit.literal) === targetValue
    const prev = unchangedBySection.get(hit.section)
    unchangedBySection.set(hit.section, prev === undefined ? unchanged : prev && unchanged)
  }
  const newLiteral = JSON.stringify(targetValue)
  let content = manifestSource
  // 逆序拼接保证先行命中点的下标在原文中仍有效；peerDependencies 段不改写（spec §4.4，PRD §9 行 312）
  for (let n = hits.length - 1; n >= 0; n--) {
    const hit = hits[n]
    if (!(REWRITE_SECTIONS as readonly string[]).includes(hit.section)) continue
    if (unchangedBySection.get(hit.section)) continue
    content = content.slice(0, hit.valueStart) + newLiteral + content.slice(hit.valueEnd)
  }
  // 输出按规范段序（计划期修订 1）；仅三改段（peer 不入 keys——spec §4.4 零改动路径）；
  // "段名.包名" 整体构造，禁按 '.' 切分（F5）
  const changedKeys: string[] = []
  const unchangedKeys: string[] = []
  for (const section of REWRITE_SECTIONS) {
    const unchanged = unchangedBySection.get(section)
    if (unchanged === undefined) continue
    ;(unchanged ? unchangedKeys : changedKeys).push(`${section}.${pkgName}`)
  }
  return { content, changedKeys, unchangedKeys }
}

/** unlink 恢复原 range，格式保持语义同上 */
export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult {
  return rewriteDepValue(manifestSource, pkgName, originalRange)
}

// ─────────────────────────── 文本级依赖改写引擎（S5 spec §4.4）───────────────────────────

/** 本地协议判定单源（S7 P1-2 + OCR：由 PROTOCOL_BY_PM 派生——新增协议自动同步，防字面量漂移） */
const LOCAL_PROTOCOLS = [...new Set(Object.values(PROTOCOL_BY_PM))]
export const LOCAL_PROTOCOL_RE = new RegExp(`^(${LOCAL_PROTOCOLS.join('|')}):`)

// 改写段名单单源（F6；T2 评审期勘误，计划期修订 6）：REWRITE_SECTIONS 三改段；
// peerDependencies 仅扫描供 findDepEntries 警告数据源（不改写、不入 keys）
const REWRITE_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const SCAN_SECTIONS = [...REWRITE_SECTIONS, 'peerDependencies'] as const

interface DepHitPoint {
  section: string
  valueStart: number // value 字面量起始（开引号下标）
  valueEnd: number // value 字面量结束（闭引号后一位，拼接用）
  literal: string // value 字面量原文（含引号）
}

/** 安全解析 JSON 字符串字面量（F2 解码语义）：失败/非字符串 → null（畸形转义不致命） */
function safeJsonParse(literal: string): string | null {
  try {
    const parsed: unknown = JSON.parse(literal)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** 返回 source[start]（须为 '"'）字符串字面量的闭引号下标；未闭合 → -1。
 *  字符串内遇 '\' 跳过下一字符（任意转义对——F1：含 "a\\" 尾反斜杠字面量的真实结束判定） */
function closingQuote(source: string, start: number): number {
  let j = start + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === '\\') {
      j += 2
      continue
    }
    if (ch === '"') return j
    j++
  }
  return -1
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** 单遍字符串感知扫描器（S5 spec §4.4）：定位 pkgName 在四段中的全部命中点。
 *  - 段键/包名 key 比对均先经 JSON 转义解码（F2，如 "@scope\/pkg" 不得漏命中）
 *  - 深度 1 识别段键，段体（深度 2）内 key 与 pkgName 全等（解码后 ===）
 *  - 重复段/重复 key 全部记录（F3），去重归 keys 输出层
 *  - 字符串状态机防 scripts 值内花括号/引号字样干扰；未闭合字面量不记命中（计划期修订 2） */
function scanManifest(source: string, pkgName: string): DepHitPoint[] {
  const hits: DepHitPoint[] = []
  let depth = 0
  let i = 0
  let pendingSectionKey: string | null = null // 深度 1 待定段键（已过冒号、等 '{'）
  let activeSection: string | null = null
  let pendingPkgKey = false // 段体内待定包名 key（已过冒号、等字符串 value）
  while (i < source.length) {
    const ch = source[i]
    if (isWs(ch)) {
      i++
      continue
    }
    if (ch === '"') {
      const close = closingQuote(source, i)
      const literal = close === -1 ? source.slice(i) : source.slice(i, close + 1)
      const decoded = safeJsonParse(literal)
      let k = close === -1 ? source.length : close + 1
      while (k < source.length && isWs(source[k])) k++
      if (close !== -1 && source[k] === ':') {
        // key 位置
        if (depth === 1 && decoded !== null && (SCAN_SECTIONS as readonly string[]).includes(decoded)) {
          pendingSectionKey = decoded
        } else if (depth === 2 && activeSection !== null && decoded === pkgName) {
          pendingPkgKey = true
        } else if (depth === 2) {
          pendingPkgKey = false
        }
        i = k + 1
        continue
      }
      // value 位置
      if (close !== -1 && depth === 2 && activeSection !== null && pendingPkgKey) {
        hits.push({
          section: activeSection,
          valueStart: i,
          valueEnd: close + 1,
          literal,
        })
      }
      pendingPkgKey = false
      if (depth === 1) pendingSectionKey = null // 段键后随非 '{' 值 → 非段体
      i = close === -1 ? source.length : close + 1
      continue
    }
    if (ch === '{') {
      if (depth === 1 && pendingSectionKey !== null) {
        activeSection = pendingSectionKey
        pendingSectionKey = null
      }
      depth++
      pendingPkgKey = false
      i++
      continue
    }
    if (ch === '}') {
      if (depth === 2 && activeSection !== null) activeSection = null
      if (depth > 0) depth--
      pendingSectionKey = null
      pendingPkgKey = false
      i++
      continue
    }
    // 其余字符（数字/null/true/false 字母、逗号、中括号等）：待定 key 状态全部失效
    pendingSectionKey = null
    pendingPkgKey = false
    i++
  }
  return hits
}

/** pkgName 在 manifest 中出现的全部依赖段名——S6 警告「peerDependencies 不改写」与
 *  O4 完成提示段清单的数据源（S5 spec 裁定①）；纯查询不改写不报错；规范段序 + 去重 */
export function findDepEntries(manifestSource: string, pkgName: string): string[] {
  const hits = scanManifest(manifestSource, pkgName)
  const out: string[] = []
  for (const section of SCAN_SECTIONS) {
    if (hits.some((h) => h.section === section)) out.push(section)
  }
  return out
}

/** 读取 pkgName 在三改写段的全部当前值（S7 §4.3）：规范段序输出、段内按文件出现序；
 *  peer 不入读取面（link 未改 peer，unlink 恢复不碰）；safeJsonParse 失败的命中跳过不致命 */
export function readDepValues(manifestSource: string, pkgName: string): Array<{ section: string; value: string }> {
  const hits = scanManifest(manifestSource, pkgName)
  const out: Array<{ section: string; value: string }> = []
  for (const section of REWRITE_SECTIONS) {
    for (const h of hits) {
      if (h.section !== section) continue
      const v = safeJsonParse(h.literal)
      if (v !== null) out.push({ section, value: v })
    }
  }
  return out
}
