import { WorkspacePatternError } from './workspace.js'

// 循环引用说明：globmatch ↔ workspace 相互引用，但均只在函数体内使用对方导出
//（ESM 延迟绑定，模块初始化期不触达对方命名空间），安全。

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/').replace(/\/+$/, '')
}

function invalid(pattern: string, reason: string): WorkspacePatternError {
  return new WorkspacePatternError(
    pattern,
    '',
    `不支持的 workspace pattern "${pattern}"（${reason}）。支持：字面量段、*（单段）、**（独立段）、!排除；不支持 ?、[...]、{a,b}、\\ 转义、段内混合。请修改清单中的该 pattern。`,
  )
}

/** spec §5 段语法校验：非法抛 WorkspacePatternError（manifestPath 空串，调用方补全） */
function validateSegments(original: string, stripped: string): void {
  if (stripped === '') throw invalid(original, '空 pattern')
  for (const seg of stripped.split('/')) {
    if (seg === '') throw invalid(original, '空段（连续或首尾斜杠）')
    if (seg === '**') continue
    if (seg.includes('*') && seg !== '*') throw invalid(original, `段内混合 "*"："${seg}"`)
    if (/[?[\]{}+@()\\]/.test(seg)) throw invalid(original, `不支持语法："${seg}"`)
  }
}

function matchSegments(pat: string[], dir: string[]): boolean {
  if (pat.length === 0) return dir.length === 0
  const [head, ...rest] = pat
  if (head === '**') {
    return matchSegments(rest, dir) || (dir.length > 0 && matchSegments(pat, dir.slice(1)))
  }
  if (dir.length === 0) return false
  if (head === '*') return matchSegments(rest, dir.slice(1))
  return head === dir[0] && matchSegments(rest, dir.slice(1))
}

/** S2 spec §5：受限 workspace glob 匹配（纯函数；pattern 语法非法抛 WorkspacePatternError） */
export function matchWorkspacePattern(pattern: string, relDir: string): boolean {
  const normalized = normalizePattern(pattern)
  const stripped = normalized.startsWith('!') ? normalized.slice(1) : normalized
  validateSegments(normalized, stripped)
  const dirSegs = relDir
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '')
  return matchSegments(stripped.split('/'), dirSegs)
}
