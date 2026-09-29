# S13「umi utoopack 适配注入」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 按本仓库 SDD 惯例（S11/S12 账本 Setup 裁定）执行：brief 载体 = 本 plan 文件 + `### Task N:` 标题锚定；零 commit（用户全局 Git 写操作禁令），实现者报告不含 commit，每任务收尾用只读 `git status --porcelain -uall` 核对；禁止派生子代理；子代理同样禁止任何 git 写操作。可用 `superpowers:executing-plans` / `superpowers:subagent-driven-development` 流程，但以本段裁定为准。

**Goal:** 完成 S13 交付——`lpm init` 向宿主 umi 配置注入标记段（`utoopack.root` 扩边界 + peer dedupe alias），`lpm uninit` 对称摘除；继承 S12 的 `--dry-run` / TTY 确认 / 非 TTY 拒绝三态交互。

**Architecture:** 纯函数层（`src/core/utoopack.ts`）承担全部可单测逻辑——宿主定位、对象体定位（字符串/注释感知括号配对）、公共祖先与相对路径、peer dedupe 集合、标记段注入/摘除（文本级保真）；编排层（`src/commands/init.ts`）承担 IO 与交互——读宿主配置、findWorkspaceRoot/readProjectConfig、三态闸门（dry-run 打印 diff 零写盘 / 非 TTY 拒绝 / TTY confirm）、writeTextFileAtomic 写盘。cli.ts 将 init/uninit 从 stub 特判为真实命令。

**Tech Stack:** TypeScript ESM + Node ≥22.12 + commander 15 + vitest（沿用）；零新增运行时依赖。

**Spec:** docs/superpowers/specs/2026-09-29-s13-utoopack-adapt-design.md（行为权威；§8 自决为唯一逐字节规范）

## Global Constraints

- **零 commit**：改动不提交，用户自行提交；每任务收尾 `git status --porcelain -uall` 记录未提交面。
- **编辑纪律**：同一文件禁止并行 SearchReplace；import 与使用合并进同一次编辑；编辑后跑 `npx tsc --noEmit`（禁用 GetDiagnostics，TS Server 缓存不可靠）。
- **相对导入一律带 `.js`**；目录模块写 `<dir>/index.js`。
- **冻结面零改动**：`renderPlan` / 各既有 `reportError` helper / S1–S12 全部命令签名零改动。S13 只**新增** `src/core/utoopack.ts` + `src/commands/init.ts`，cli.ts 只**新增** init/uninit 两个特判块（仿 use/link），registry.ts 的 COMMANDS 条目沿用（init/uninit 已存在，`plannedSpec: 'S13'` 保留——stub 提示仍引用，无碍）。
- **错误文案**：I1–I8 按 spec §5 逐字；「描述」与「下一步：」两行模板；`reportError`（init.ts 内私有）结构仿既有命令。
- **验证命令**：任务内 scoped 检查 `npx tsc --noEmit --pretty 2>&1 | Select-String "<改动目录>"`；每任务收尾跑该任务相关测试文件；T6 终态跑 `pnpm verify`。
- **SDD workspace**：`.superpowers/sdd/2026-09-29-s13-utoopack-adapt.md/progress.md` 记录每任务（零 commit 时账本是唯一证据，不删）。
- **e2e 必须先 `pnpm build`**（S12 T3-1 教训：e2e 走 dist/cli.js；本 plan T6 内建）。
- **OCR-8（S12 P2 候选）不触发**：`rejectInteractiveDryRun` helper 的触发信号 = 第四个命令接入「交互遇 --dry-run 拒绝」——init/uninit 遇 `--dry-run` 是**正常预览**（不是拒绝），其拒绝形态是**非 TTY**（与 repair 同构），语义不同，**本阶段不抽 helper**（spec §8 自决 9 的「顺手抽」经实现期裁定否决，理由见上；五处共用待未来真正接入交互遇 --dry-run 的第五个命令时再抽）。

---

### Task 1: core/utoopack.ts 宿主定位 + 对象体定位 + 标记检测 + 错误类

**Files:**
- Create: `src/core/utoopack.ts`
- Create: `tests/unit/init-locate.test.ts`

**Interfaces:**
- Produces（T1–T6 共用）:
  - 错误类（8 个，export）：`InitConfigNotFoundError` / `InitConfigShapeError` / `InitRootError` / `InitHostPkgError` / `InitInteractionError` / `InitAlreadyInjectedError` / `InitNotInjectedError` / `InitIncompleteMarkerError`（构造签名 = spec §5 文案逐字，message 内嵌 `\n下一步：`）
  - `findHostConfig(cwd: string): string`（候选文件名按序探测，找不到抛 `InitConfigNotFoundError`）
  - `locateConfigObject(source: string): { start: number; end: number } | null`（对象体起止括号下标；`{` 后紧跟 `}` 空体也返回）
  - `findMarker(source: string): { start: number; end: number; complete: boolean } | null`（start 标记定位；无 → null；有 start 无 end → `{ complete: false }`；完整 → `{ start, end: end 标记后一位, complete: true }`）
  - `stripBom(source: string): string`

- [ ] **Step 1: 写失败测试** `tests/unit/init-locate.test.ts`

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InitConfigNotFoundError,
  findHostConfig,
  findMarker,
  locateConfigObject,
} from '../../src/core/utoopack.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-loc-'))
  dirs.push(dir)
  for (const [n, c] of Object.entries(files)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}

describe('findHostConfig（spec §4.2 候选文件名按序）', () => {
  it('候选顺序：config/config.ts 优先于 .umirc.ts', () => {
    const dir = makeDir({
      'config/config.ts': 'x',
      '.umirc.ts': 'y',
    })
    expect(findHostConfig(dir)).toBe(join(dir, 'config', 'config.ts'))
  })
  it('config 缺失 → 命中 .umirc.ts', () => {
    const dir = makeDir({ '.umirc.ts': 'y' })
    expect(findHostConfig(dir)).toBe(join(dir, '.umirc.ts'))
  })
  it('全部缺失 → InitConfigNotFoundError（文案含候选清单）', () => {
    const dir = makeDir()
    expect(() => findHostConfig(dir)).toThrow(InitConfigNotFoundError)
    expect(() => findHostConfig(dir)).toThrow('未找到 umi 配置文件')
  })
})

describe('locateConfigObject（spec §4.4 + §8 自决 2）', () => {
  it('defineConfig({...}) 多行 → 返回对象体 { } 下标', () => {
    const src = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    expect(src.slice((r as { start: number; end: number }).start)).toMatch(/^\{[\s\S]*\}$/)
    expect((r as { start: number; end: number }).end).toBe(src.indexOf('})'))
  })
  it('defineConfig( 与 { 之间换行也命中', () => {
    const src = 'export default defineConfig(\n  {\n    antd: {},\n  },\n)\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('export default { 单行紧凑 → 命中', () => {
    const src = 'export default { antd: {} }\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('字符串内花括号不干扰配对（antd: { theme: "{}" }）', () => {
    const src = "export default defineConfig({ antd: { theme: '{}' }, access: {} })\n"
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    expect(src[(r as { start: number; end: number }).end]).toBe('}')
  })
  it('行注释/块注释内括号不干扰', () => {
    const src = 'export default defineConfig({\n  // a { b }\n  /* c { d } */\n  antd: {},\n})\n'
    expect(locateConfigObject(src)).not.toBeNull()
  })
  it('嵌套对象 → 配对到最外层 }', () => {
    const src = 'export default defineConfig({ a: { b: { c: 1 } }, d: 2 })\n'
    const r = locateConfigObject(src)
    expect(src[(r as { start: number; end: number }).end]).toBe('}')
    expect((r as { start: number; end: number }).end).toBe(src.lastIndexOf('}'))
  })
  it('括号不闭合 → null', () => {
    const src = 'export default defineConfig({ antd: {}\n'
    expect(locateConfigObject(src)).toBeNull()
  })
  it('无 defineConfig 也无 export default { → null', () => {
    expect(locateConfigObject('module.exports = {}')).toBeNull()
    expect(locateConfigObject('')).toBeNull()
  })
  it('空对象体 {} → 返回（start+1 与 end 相邻）', () => {
    const src = 'export default defineConfig({})\n'
    const r = locateConfigObject(src)
    expect(r).not.toBeNull()
    const { start, end } = r as { start: number; end: number }
    expect(src[start]).toBe('{')
    expect(src[end]).toBe('}')
  })
})

describe('findMarker（spec §4.8 自感知 + 不完整标记）', () => {
  it('无标记 → null', () => {
    expect(findMarker('export default defineConfig({})')).toBeNull()
  })
  it('完整标记 → complete:true + end 定位到 end 标记后', () => {
    const src = 'export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: { root: ".." },\n  /* lpm-inject:end */\n})\n'
    const m = findMarker(src)
    expect(m?.complete).toBe(true)
    expect(src.slice((m as { start: number; end: number }).start, (m as { start: number; end: number }).end)).toContain('/* lpm-inject:end */')
  })
  it('有 start 无 end → complete:false', () => {
    const src = 'export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: {},\n})\n'
    const m = findMarker(src)
    expect(m?.complete).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/init-locate.test.ts`
Expected: FAIL（模块不存在 / import not found）

- [ ] **Step 3: 实现 `src/core/utoopack.ts`**（本任务含错误类 + 宿主定位 + 对象体定位 + 标记检测；`commonAncestor`/`toRelSlashes`/alias/注入摘除在后续任务追加到同一文件）

```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

// 供后续任务 import 的占位导出（T2–T4 逐步实装；占位会随任务推进被替换）
export function commonAncestor(_absPaths: string[]): string { throw new Error('commonAncestor: 未实现（T2）') }
export function toRelSlashes(_fromDir: string, _toDir: string): string { throw new Error('toRelSlashes: 未实现（T2）') }
export function buildFragment(_root: string, _aliasMap: Record<string, string>): string { throw new Error('buildFragment: 未实现（T4）') }
export function injectFragment(_source: string, _fragment: string): string { throw new Error('injectFragment: 未实现（T4）') }
export function removeFragment(_source: string): string { throw new Error('removeFragment: 未实现（T4）') }

export function readJsonSafe(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripBom(readFileSync(filePath, 'utf8')))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
  return parsed as Record<string, unknown>
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/unit/init-locate.test.ts`
Expected: PASS（15 passed：findHostConfig 3 + locateConfigObject 9 + findMarker 3）

- [ ] **Step 5: 编译检查 + 记录未提交面**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/core/utoopack|tests/unit/init-locate"`
Expected: 零输出
Run: `git status --porcelain -uall`
Expected: `?? src/core/utoopack.ts` + `?? tests/unit/init-locate.test.ts` + 既有未提交面（交接词文档等）

---

### Task 2: core/utoopack.ts 公共祖先 + 相对路径（root 计算原语）

**Files:**
- Modify: `src/core/utoopack.ts`（替换 `commonAncestor`/`toRelSlashes` 占位为实装；追加 `buildRootValue`）
- Create: `tests/unit/init-root.test.ts`

**Interfaces:**
- Consumes: T1 的错误类 `InitRootError`
- Produces:
  - `commonAncestor(absPaths: string[]): string`（最近公共祖先目录；单路径 → 其父目录；跨盘符输入行为由测试锁死）
  - `toRelSlashes(fromDir: string, toDir: string): string`（`relative` + 正斜杠；跨盘符退化 → 抛 `InitRootError`；`from===to` → `'.'`）
  - `buildRootValue(cwd: string, libDirs: string[]): string`（`commonAncestor([cwd, ...libDirs])` → `toRelSlashes(cwd, target)`）

- [ ] **Step 1: 写失败测试** `tests/unit/init-root.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { InitRootError, buildRootValue, commonAncestor, toRelSlashes } from '../../src/core/utoopack.js'

describe('commonAncestor（spec §4.4）', () => {
  it('多路径同盘 → 最近公共目录', () => {
    expect(commonAncestor(['D:/app/libs/a', 'D:/app/libs/b'])).toBe('D:/app/libs')
    expect(commonAncestor(['D:/app/libs/a', 'D:/app/apps/web'])).toBe('D:/app')
  })
  it('单路径 → 其父目录', () => {
    expect(commonAncestor(['D:/app/libs/a'])).toBe('D:/app/libs')
  })
  it('跨盘符（无公共祖先）→ 行为锁定为「返回各自盘符根中最长的公共前缀」（Windows 语义）', () => {
    // 实现约定：跨盘符 → 逐段比较至盘符不同 → 返回空串；测试锁死该约定
    expect(commonAncestor(['C:/a/x', 'D:/a/y'])).toBe('')
  })
})

describe('toRelSlashes（spec §4.4 跨盘符护栏）', () => {
  it('同级 → .', () => {
    expect(toRelSlashes('D:/app', 'D:/app')).toBe('.')
  })
  it('上级 → ../..', () => {
    expect(toRelSlashes('D:/app/apps/web', 'D:/app')).toBe('../..')
  })
  it('正斜杠输出', () => {
    expect(toRelSlashes('D:\\app\\apps\\web', 'D:\\app')).toBe('../..')
  })
  it('Windows 跨盘符 → InitRootError', () => {
    expect(() => toRelSlashes('D:/app', 'C:/lib')).toThrow(InitRootError)
    expect(() => toRelSlashes('D:/app', 'C:/lib')).toThrow('无法计算 utoopack.root')
  })
})

describe('buildRootValue（spec §4.5 root 公式）', () => {
  it('宿主 + 多 lib 的公共祖先 → 相对宿主路径', () => {
    expect(buildRootValue('D:/app/apps/web', ['D:/app/libs/a', 'D:/app/libs/b'])).toBe('../..')
  })
  it('宿主与 lib 同目录 → .', () => {
    expect(buildRootValue('D:/app', ['D:/app/libs/a'])).toBe('..')
  })
  it('跨盘符 → InitRootError', () => {
    expect(() => buildRootValue('D:/app', ['C:/libs/a'])).toThrow(InitRootError)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/init-root.test.ts`
Expected: FAIL（`commonAncestor` 抛「未实现（T2）」）

- [ ] **Step 3: 实现 `commonAncestor` / `toRelSlashes` / `buildRootValue`**（替换 T1 占位）

```ts
import { isAbsolute, relative, resolve } from 'node:path'

// 公共祖先：逐路径比较各段；首段即不同（跨盘符/根不同）→ 返回 ''（调用方走 InitRootError）
export function commonAncestor(absPaths: string[]): string {
  if (absPaths.length === 0) return ''
  if (absPaths.length === 1) return resolve(absPaths[0] as string, '..')
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
```

- [ ] **Step 4: 跑测试验证通过 + 全量回归**

Run: `npx vitest run tests/unit/init-root.test.ts tests/unit/init-locate.test.ts`
Expected: PASS（root 10 passed + locate 15）
Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/core/utoopack"`
Expected: 零输出

- [ ] **Step 5: 记录未提交面**

Run: `git status --porcelain -uall`
Expected: `?? src/core/utoopack.ts` + `?? tests/unit/init-{locate,root}.test.ts` + 既有未提交面

---

### Task 3: core/utoopack.ts peer dedupe alias 计算

**Files:**
- Modify: `src/core/utoopack.ts`（追加 `buildAliasMap`）
- Create: `tests/unit/init-alias.test.ts`

**Interfaces:**
- Consumes: T1 的错误类 `InitHostPkgError` + `readJsonSafe`；`resolve`/`join`/`existsSync`
- Produces: `buildAliasMap(cwd: string, rootDir: string, libDirs: string[]): Record<string, string>`（peerDependencies ∩ 宿主直接依赖 → 绝对路径正斜杠；探测顺序 cwd → rootDir；空交集 → `{}`；宿主 package.json 缺失 → 抛 `InitHostPkgError`；单 lib package.json 不可读 → 跳过该 lib）

- [ ] **Step 1: 写失败测试** `tests/unit/init-alias.test.ts`

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InitHostPkgError, buildAliasMap } from '../../src/core/utoopack.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-al-'))
  dirs.push(dir)
  for (const [n, c] of Object.entries(files)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}
function pkg(body: Record<string, unknown>): string { return JSON.stringify(body) }

describe('buildAliasMap（spec §4.5 peer dedupe）', () => {
  it('lib peer ∩ 宿主直接依赖 → 宿主实例绝对路径（正斜杠）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0', react: '^18.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*', react: '*' } }),
    })
    const alias = buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])
    expect(alias['antd']).toBe(join(dir, 'node_modules', 'antd').replaceAll('\\', '/'))
    expect(alias['react']).toBe(join(dir, 'node_modules', 'react').replaceAll('\\', '/'))
  })
  it('空交集 → {}', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { vue: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
  it('lib 无 peerDependencies → 空', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a' }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
  it('宿主 package.json 缺失 → InitHostPkgError', () => {
    const dir = makeDir({ 'libs/a/package.json': pkg({ name: 'a' }) })
    expect(() => buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toThrow(InitHostPkgError)
  })
  it('peer 已在宿主 node_modules 存在 → 取 cwd 路径（探测顺序 1）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'node_modules/antd/index.js': '// ok',
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])['antd']).toBe(join(dir, 'node_modules', 'antd').replaceAll('\\', '/'))
  })
  it('peer 仅存在 workspace 根 node_modules（hoist 落点）→ 取 rootDir 路径（探测顺序 2）', () => {
    const root = makeDir({
      'package.json': pkg({ name: 'root', dependencies: { antd: '^5.0.0' } }),
      'node_modules/antd/index.js': '// ok',
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    const cwd = join(root, 'apps', 'web')
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    const alias = buildAliasMap(cwd, root, [join(root, 'libs', 'a')])
    expect(alias['antd']).toBe(join(root, 'node_modules', 'antd').replaceAll('\\', '/'))
  })
  it('两者皆无 → 跳过该 peer（不进 alias）', () => {
    const dir = makeDir({
      'package.json': pkg({ name: 'host', dependencies: { antd: '^5.0.0' } }),
      'libs/a/package.json': pkg({ name: 'a', peerDependencies: { antd: '*' } }),
    })
    expect(buildAliasMap(dir, dir, [join(dir, 'libs', 'a')])).toEqual({})
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/init-alias.test.ts`
Expected: FAIL（`buildAliasMap` 未定义）

- [ ] **Step 3: 实现 `buildAliasMap`**

```ts
export function buildAliasMap(cwd: string, rootDir: string, libDirs: string[]): Record<string, string> {
  const hostPkgPath = join(cwd, 'package.json')
  if (!existsSync(hostPkgPath)) throw new InitHostPkgError(cwd)
  const hostPkg = readJsonSafe(hostPkgPath)
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
```

- [ ] **Step 4: 跑测试验证通过 + 全量回归**

Run: `npx vitest run tests/unit/init-alias.test.ts tests/unit/init-root.test.ts tests/unit/init-locate.test.ts`
Expected: PASS（alias 7 passed + root 10 + locate 15）
Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/core/utoopack"`
Expected: 零输出

- [ ] **Step 5: 记录未提交面**

Run: `git status --porcelain -uall`
Expected: `?? src/core/utoopack.ts` + `?? tests/unit/init-*.test.ts`（3 个）+ 既有未提交面

---

### Task 4: core/utoopack.ts 标记段注入 / 摘除（文本级 golden）

**Files:**
- Modify: `src/core/utoopack.ts`（替换 `buildFragment`/`injectFragment`/`removeFragment` 占位为实装）
- Create: `tests/unit/init-inject.test.ts`

**Interfaces:**
- Consumes: T1 的 `INJECT_START`/`INJECT_END`/`locateConfigObject`/`findMarker` + 错误类 `InitConfigShapeError`/`InitNotInjectedError`/`InitIncompleteMarkerError`
- Produces:
  - `buildFragment(root: string, aliasMap: Record<string, string>): string`（标记段源码，行首无缩进，含 start/end 注释 + `utoopack` 键 + `alias` 键（空 map 省略 alias））
  - `injectFragment(source: string, fragment: string): string`（对象体末尾插入；三态：空体无前置逗号 / 无尾逗号补逗号 / 有尾逗号复用；`locateConfigObject` null → 抛 `InitConfigShapeError`）
  - `removeFragment(source: string): string`（start 定位，删标记段连同前导逗号；无标记 → 抛 `InitNotInjectedError`；不完整 → 抛 `InitIncompleteMarkerError`）

- [ ] **Step 1: 写失败测试** `tests/unit/init-inject.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import {
  InitConfigShapeError,
  InitIncompleteMarkerError,
  InitNotInjectedError,
  buildFragment,
  injectFragment,
  removeFragment,
} from '../../src/core/utoopack.js'

const FRAG = (): string => buildFragment('../..', { react: 'D:/h/node_modules/react', antd: 'D:/h/node_modules/antd' })

describe('buildFragment（spec §3.1）', () => {
  it('含 start/end 注释 + utoopack + alias（正斜杠绝对路径）', () => {
    const f = FRAG()
    expect(f).toContain('/* lpm-inject:start */')
    expect(f).toContain('/* lpm-inject:end */')
    expect(f).toContain("root: '../..'")
    expect(f).toContain("react: 'D:/h/node_modules/react'")
  })
  it('空 alias → 省略 alias 键', () => {
    const f = buildFragment('..', {})
    expect(f).toContain('utoopack:')
    expect(f).not.toContain('alias:')
  })
})

describe('injectFragment（spec §8 自决 1 三态）', () => {
  it('空对象体 {} → 无前置逗号', () => {
    const out = injectFragment('export default defineConfig({})\n', FRAG())
    expect(out).toBe('export default defineConfig({\n  /* lpm-inject:start */\n  utoopack: {\n    root: \'../..\',\n  },\n  alias: {\n    react: \'D:/h/node_modules/react\',\n    antd: \'D:/h/node_modules/antd\',\n  },\n  /* lpm-inject:end */})\n')
  })
  it('无尾逗号 → 补逗号作分隔', () => {
    const out = injectFragment('export default defineConfig({\n  antd: {},\n})\n', FRAG())
    expect(out).toContain('  antd: {},\n  /* lpm-inject:start */')
  })
  it('有尾逗号 → 复用原逗号不补', () => {
    const out = injectFragment('export default defineConfig({\n  antd: {},\n})\n'.replace('antd: {},', 'antd: {},,'), FRAG())
    // 构造有尾逗号：对象体末尾已有 ,
    const src = 'export default defineConfig({\n  antd: {},\n})\n'
    const withTail = src.replace('antd: {},\n})', 'antd: {},\n  ,\n})')
    const out2 = injectFragment(withTail, FRAG())
    expect(out2).not.toContain(',,\n')
  })
  it('无 defineConfig → InitConfigShapeError', () => {
    expect(() => injectFragment('module.exports = {}\n', FRAG())).toThrow(InitConfigShapeError)
  })
})

describe('removeFragment（spec §8 自决 1 摘除）', () => {
  it('无标记 → InitNotInjectedError', () => {
    expect(() => removeFragment('export default defineConfig({})\n')).toThrow(InitNotInjectedError)
  })
  it('不完整标记 → InitIncompleteMarkerError', () => {
    expect(() => removeFragment('export default defineConfig({\n  /* lpm-inject:start */\n  antd: {},\n})\n')).toThrow(InitIncompleteMarkerError)
  })
  it('无尾逗号宿主：byte 往返恒等（inject(uninject(x)) === x）', () => {
    const orig = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'
    const injected = injectFragment(orig, FRAG())
    expect(removeFragment(injected)).toBe(orig)
  })
  it('遮蔽：宿主已有 utoopack 键 → uninit 后宿主键保留原样', () => {
    const orig = "export default defineConfig({\n  utoopack: { root: 'custom' },\n  antd: {},\n})\n"
    const injected = injectFragment(orig, FRAG())
    const restored = removeFragment(injected)
    expect(restored).toContain("utoopack: { root: 'custom' }")
    expect(restored).toBe(orig)
  })
  it('有尾逗号宿主：摘除后语义等价（尾逗号被消费），不断言 byte', () => {
    const orig = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'
    const withTail = orig.replace('access: {},', 'access: {},')
    // 直接构造有尾逗号文本
    const tailSrc = 'export default defineConfig({\n  antd: {},\n  access: {},\n})\n'.replace('access: {},\n})', 'access: {},\n  ,\n})')
    const injected = injectFragment(tailSrc, FRAG())
    const restored = removeFragment(injected)
    // 语义等价：仍以 access 键开头且无残留标记
    expect(restored).toContain('access: {}')
    expect(restored).not.toContain('lpm-inject')
    void withTail
  })
  it('CRLF 保持：注入+摘除后原 CRLF 不变', () => {
    const orig = 'export default defineConfig({\r\n  antd: {},\r\n})\r\n'
    const injected = injectFragment(orig, FRAG())
    expect(injected).toContain('\r\n')
    expect(removeFragment(injected)).toBe(orig)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/init-inject.test.ts`
Expected: FAIL（`buildFragment` 抛「未实现（T4）」）

- [ ] **Step 3: 实现 `buildFragment` / `injectFragment` / `removeFragment`**

```ts
export function buildFragment(root: string, aliasMap: Record<string, string>): string {
  const lines: string[] = [INJECT_START, 'utoopack: {', `  root: '${root}',`, '},']
  if (Object.keys(aliasMap).length > 0) {
    lines.push('alias: {')
    for (const [k, v] of Object.entries(aliasMap)) lines.push(`  '${k}': '${v}',`)
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
  // 无尾逗号且非空 → 补逗号；空体/有尾逗号 → 不补
  const insert = (empty || hasTrailingComma ? '' : ',') + '\n  ' + indented
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
```

- [ ] **Step 4: 跑测试验证通过 + 全量回归**

Run: `npx vitest run tests/unit/init-inject.test.ts tests/unit/init-alias.test.ts tests/unit/init-root.test.ts tests/unit/init-locate.test.ts`
Expected: PASS（inject 12 passed + alias 7 + root 10 + locate 15）
Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/core/utoopack"`
Expected: 零输出

> 注：inject/remove 的 byte 往返恒等以「无尾逗号宿主」为唯一 byte 断言（spec §6/§8 自决 1）；「有尾逗号宿主」断言语义等价。CRLF 用例验证格式保持。

- [ ] **Step 5: 记录未提交面**

Run: `git status --porcelain -uall`
Expected: `?? src/core/utoopack.ts` + `?? tests/unit/init-*.test.ts`（4 个）+ 既有未提交面

---

### Task 5: commands/init.ts runInit/runUninit 编排 + diff 预览 + 交互闸门

**Files:**
- Create: `src/commands/init.ts`
- Create: `tests/unit/init-command.test.ts`

**Interfaces:**
- Consumes: T1–T4 的 core/utoopack.ts 全部导出；`findWorkspaceRoot`/`readProjectConfig`（既有）；`writeTextFileAtomic`（既有）；`@clack/prompts`（confirm）；错误类 `WorkspaceNotFoundError`/`LpmConfigParseError`（既有，入 KNOWN）
- Produces:
  - `runInit(cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`
  - `runUninit(cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`

**行为契约（spec §3.2/§3.3/§4.6）**：
- init：宿主定位 → 读源码 + 剥 BOM → 已注入？I6 → findWorkspaceRoot → readProjectConfig → libs 空 → 提示 exit 0 → 计算 root（I3）/alias（I4）→ 已有同名键提示 → 组装注入后全文 → 三态闸门（dry-run 打印 + 行 diff 零写盘 / 非 TTY I5 / TTY confirm）→ 写盘 + 完成提示
- uninit：宿主定位 → 读源码 → findMarker（null → I7；不完整 → I8）→ 摘除 → 三态闸门 → 写盘 + 完成提示
- 不写运行留痕（spec §1.3/§8 自决 6）；`LastRunTrace.command` 不加值

- [ ] **Step 1: 写失败测试** `tests/unit/init-command.test.ts`

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(), isCancel: vi.fn(() => false),
}))

import { confirm } from '@clack/prompts'
import { runInit, runUninit } from '../../src/commands/init.js'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.clearAllMocks()
  // 还原 isTTY 默认（非 TTY）
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  process.exitCode = undefined
})
beforeEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
})

const CONFIG_TS = 'export default defineConfig({\n  antd: {},\n})\n'

// 宿主 + workspace 一体化 fixture：dir 为 workspace 根，apps/web 为宿主
function makeHost(extraLibs: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-s13-cmd-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }), 'utf8')
  const web = join(dir, 'apps', 'web')
  mkdirSync(join(web, 'config'), { recursive: true })
  writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'web', dependencies: { antd: '^5.0.0' } }), 'utf8')
  writeFileSync(join(web, 'config', 'config.ts'), CONFIG_TS, 'utf8')
  const libDir = join(dir, 'libs', 'mylib')
  mkdirSync(libDir, { recursive: true })
  writeFileSync(join(libDir, 'package.json'), JSON.stringify({ name: '@t/mylib', peerDependencies: { antd: '*' } }), 'utf8')
  writeFileSync(join(dir, 'lpm.config.json'), JSON.stringify({ version: 1, libs: { '@t/mylib': 'libs/mylib', ...extraLibs } }), 'utf8')
  return web
}
function hostConfig(web: string): string { return join(web, 'config', 'config.ts') }
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('runInit（spec §3.2/§4.6）', () => {
  it('dry-run：首行 + + 行 + 宿主配置 byte 级零写盘 + exit 0', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('init dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.stdout()).toContain('+ ')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('TTY + confirm=true → 写盘 + 完成提示', async () => {
    const web = makeHost()
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    expect(await runInit(web)).toBe(0)
    expect(readFileSync(hostConfig(web), 'utf8')).toContain('/* lpm-inject:start */')
    expect(cap.stdout()).toContain('已注入 utoopack 适配片段')
  })
  it('TTY + confirm=false → 已取消 + 零写盘 + exit 1', async () => {
    const web = makeHost()
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(false)
    const cfg = hostConfig(web)
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('非 TTY：I5 文案 + exit 1 + 零 clack 调用', async () => {
    const web = makeHost()
    const cap = captureOut()
    expect(await runInit(web)).toBe(1)
    expect(cap.stderr()).toContain('需交互确认注入/摘除计划')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('无已注册 lib → 提示 + 零写盘 + exit 0', async () => {
    const web = makeHost()
    writeFileSync(join(web, '..', '..', 'lpm.config.json'), JSON.stringify({ version: 1, libs: {} }), 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('当前没有任何已注册的 lib')
  })
  it('已注入 → I6 + 零写盘', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('宿主配置已注入 lpm 片段')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('root 跨盘符 → I3（lib 指向与 tmp 盘符不同的对侧盘）', async () => {
    const web = makeHost()
    const tmpDrive = tmpdir().charAt(0).toUpperCase()
    const otherDrive = tmpDrive === 'C' ? 'D' : 'C'
    writeFileSync(join(web, '..', '..', 'lpm.config.json'), JSON.stringify({ version: 1, libs: { '@t/x': `${otherDrive}:/elsewhere` } }), 'utf8')
    const cap = captureOut()
    expect(await runInit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('无法计算 utoopack.root')
  })
})

describe('runUninit（spec §3.3/§4.6）', () => {
  it('dry-run 未注入 → I7 + 零写盘 + exit 1', async () => {
    const web = makeHost()
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('未检测到 lpm 注入片段')
  })
  it('dry-run 已注入 → - 行 + 零写盘 + exit 0', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(0)
    expect(cap.stdout()).toContain('- ')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
  it('TTY + confirm=true → 摘除还原 + 提示', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */\n  utoopack: { root: "." },\n  /* lpm-inject:end */'), 'utf8')
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    expect(await runUninit(web)).toBe(0)
    expect(readFileSync(cfg, 'utf8')).toBe(CONFIG_TS)
    expect(cap.stdout()).toContain('已摘除 utoopack 适配片段')
  })
  it('不完整标记 → I8 + 零写盘', async () => {
    const web = makeHost()
    const cfg = hostConfig(web)
    writeFileSync(cfg, CONFIG_TS.replace('  antd: {},', '  antd: {},\n  /* lpm-inject:start */'), 'utf8')
    const before = readFileSync(cfg, 'utf8')
    const cap = captureOut()
    expect(await runUninit(web, { dryRun: true })).toBe(1)
    expect(cap.stderr()).toContain('不完整的 lpm 注入标记')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/init-command.test.ts`
Expected: FAIL（`../../src/commands/init.js` 不存在）

- [ ] **Step 3: 实现 `src/commands/init.ts`**

```ts
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { findWorkspaceRoot } from '../core/workspace.js'
import { readProjectConfig, LpmConfigParseError } from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import { WorkspaceNotFoundError } from '../core/workspace.js'
import {
  InitAlreadyInjectedError,
  InitConfigShapeError,
  InitHostPkgError,
  InitIncompleteMarkerError,
  InitInteractionError,
  InitNotInjectedError,
  InitRootError,
  buildAliasMap,
  buildFragment,
  buildRootValue,
  findHostConfig,
  findMarker,
  injectFragment,
  locateConfigObject,
  removeFragment,
  stripBom,
} from '../core/utoopack.js'

export interface InitOptions { dryRun?: boolean }

// ── diff 预览（spec §4.7；只 diff 对象体区间）──
function printInjectDiff(hostPath: string, source: string, after: string, mode: 'inject' | 'remove', dryRun: boolean): void {
  const cmd = mode === 'inject' ? 'init' : 'uninit'
  const title = dryRun
    ? `${cmd} dry-run 执行计划（不落任何盘、不执行任何子进程）：`
    : mode === 'inject' ? '注入计划：' : '摘除计划：'
  process.stdout.write(`${title}\n`)
  process.stdout.write(`  文件：${hostPath}\n`)
  const beforeLines = source.split('\n')
  const afterLines = after.split('\n')
  let s = 0
  while (s < beforeLines.length && s < afterLines.length && beforeLines[s] === afterLines[s]) s++
  let eB = beforeLines.length - 1
  let eA = afterLines.length - 1
  while (eB >= s && eA >= s && beforeLines[eB] === afterLines[eA]) { eB--; eA-- }
  for (let i = s; i <= eB; i++) process.stdout.write(`- ${beforeLines[i]}\n`)
  for (let i = s; i <= eA; i++) process.stdout.write(`+ ${afterLines[i]}\n`)
}

function reportError(err: unknown): number {
  const KNOWN = [
    InitConfigShapeError, InitRootError, InitHostPkgError, InitInteractionError,
    InitAlreadyInjectedError, InitNotInjectedError, InitIncompleteMarkerError,
    WorkspaceNotFoundError, LpmConfigParseError,
  ]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

async function ensureInitPreconditions(cwd: string): Promise<{ hostPath: string; source: string }> {
  const hostPath = findHostConfig(cwd)
  const source = stripBom(readFileSync(hostPath, 'utf8'))
  return { hostPath, source }
}

export async function runInit(cwd: string = process.cwd(), opts: InitOptions = {}): Promise<number> {
  try {
    const { hostPath, source } = await ensureInitPreconditions(cwd)
    if (findMarker(source) !== null) throw new InitAlreadyInjectedError()
    const rootDir = await findWorkspaceRoot(cwd)
    const cfg = await readProjectConfig(rootDir)
    const libRels = Object.values(cfg?.libs ?? {})
    if (libRels.length === 0) {
      process.stdout.write('当前没有任何已注册的 lib。\n下一步：先 lpm link <路径> 注册后再 init\n')
      return 0
    }
    const libDirs = libRels.map((rel) => resolve(rootDir, rel))
    const root = buildRootValue(cwd, libDirs)
    const aliasMap = buildAliasMap(cwd, rootDir, libDirs)
    const hasShadow = source.includes('utoopack') || source.includes('alias')
    const fragment = buildFragment(root, aliasMap)
    const after = injectFragment(source, fragment)
    if (hasShadow) process.stdout.write('提示：检测到宿主已有 utoopack/alias 配置，lpm 片段将覆盖之；uninit 后可还原\n')
    if (opts.dryRun === true) { printInjectDiff(hostPath, source, after, 'inject', true); return 0 }
    if (process.stdin.isTTY !== true) throw new InitInteractionError('init')
    printInjectDiff(hostPath, source, after, 'inject', false)
    const ok = await clack.confirm({ message: `执行以上注入？（写入 ${hostPath}）`, initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    writeTextFileAtomic(hostPath, after)
    const aliasCount = Object.keys(aliasMap).length
    process.stdout.write(`已注入 utoopack 适配片段：${hostPath}\n`)
    process.stdout.write(`  root：${root}（覆盖 ${libDirs.length} 个已注册 lib 的公共祖先）\n`)
    if (aliasCount > 0) process.stdout.write(`  dedupe：${aliasCount} 个 peer（${Object.keys(aliasMap).join('、')}）\n`)
    else process.stdout.write('  未检测到需要 dedupe 的 peer（lib peer ∩ 宿主直接依赖 为空），仅注入 root\n')
    process.stdout.write('若 lib 后续新增 peer，请重跑 lpm init 重新注入。\n')
    return 0
  } catch (err) {
    return reportError(err)
  }
}

export async function runUninit(cwd: string = process.cwd(), opts: InitOptions = {}): Promise<number> {
  try {
    const { hostPath, source } = await ensureInitPreconditions(cwd)
    const m = findMarker(source)
    if (m === null) throw new InitNotInjectedError()
    const after = removeFragment(source) // 不完整标记在内部抛 InitIncompleteMarkerError
    if (opts.dryRun === true) { printInjectDiff(hostPath, source, after, 'remove', true); return 0 }
    if (process.stdin.isTTY !== true) throw new InitInteractionError('uninit')
    printInjectDiff(hostPath, source, after, 'remove', false)
    const ok = await clack.confirm({ message: `执行以上摘除？（写入 ${hostPath}）`, initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    writeTextFileAtomic(hostPath, after)
    process.stdout.write(`已摘除 utoopack 适配片段：${hostPath}（宿主原有 utoopack/alias 配置已还原）\n`)
    return 0
  } catch (err) {
    return reportError(err)
  }
}
```

- [ ] **Step 4: 跑测试验证通过 + 全量回归**

Run: `npx vitest run tests/unit/init-command.test.ts`
Expected: PASS（11 passed）
Run: `npx vitest run tests/unit`（全量）
Expected: 全部通过（新增 init 4 文件 + 40 例，既有零回归）
Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/init|src/core/utoopack"`
Expected: 零输出

> 注：I3 集成用例用「与 tmp 盘符不同的对侧盘」（如 tmp 在 C: → lib 指 `D:/elsewhere`）确保 `commonAncestor` 首段即不同 → 返回 `''` → `buildRootValue` 抛 I3——比硬编码 `C:/elsewhere`（可能与 tmp 同盘）更可靠。

- [ ] **Step 5: 记录未提交面**

Run: `git status --porcelain -uall`
Expected: `?? src/commands/init.ts` + `?? src/core/utoopack.ts` + `?? tests/unit/init-*.test.ts`（5 个）+ 既有未提交面

---

### Task 6: cli.ts 接线 init/uninit + e2e 冒烟 + 终态验证 + 文档收口

**Files:**
- Modify: `src/cli.ts`（buildProgram 新增 init/uninit 两个特判块，仿 use/link/repair）
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 S13 冒烟 describe）
- Create: `.superpowers/sdd/2026-09-29-s13-utoopack-adapt.md/progress.md`（本 plan 账本）
- 文档收口：spec §9 补「实现期裁定」（OCR-8 不触发；其余自决落地记录）

**Interfaces:**
- Consumes: `runInit`/`runUninit`（T5）
- Produces: `lpm init` / `lpm uninit` 成为真实命令（`--help` 列表不变，11 个命令全真实）

- [ ] **Step 1: 写失败 e2e**（追加到 `tests/e2e/cli.e2e.test.ts` 末尾）

```ts
// S13 e2e（spec §6）：init --dry-run 冒烟 + uninit 未注入报错（spawn 即非 TTY，确认路径不进 e2e）
describe('lpm init/uninit e2e（S13）', () => {
  const made: string[] = []
  function makeHost(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-s13-'))
    made.push(dir)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }), 'utf8')
    const web = join(dir, 'apps', 'web')
    mkdirSync(join(web, 'config'), { recursive: true })
    writeFileSync(join(web, 'package.json'), JSON.stringify({ name: 'web', dependencies: { antd: '^5.0.0' } }), 'utf8')
    writeFileSync(join(web, 'config', 'config.ts'), 'export default defineConfig({\n  antd: {},\n})\n', 'utf8')
    const libDir = join(dir, 'libs', 'mylib')
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(libDir, 'package.json'), JSON.stringify({ name: '@t/mylib', peerDependencies: { antd: '*' } }), 'utf8')
    writeFileSync(join(dir, 'lpm.config.json'), JSON.stringify({ version: 1, libs: { '@t/mylib': 'libs/mylib' } }), 'utf8')
    return web
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  it('init --dry-run：exit 0 + stdout 含 init dry-run + 宿主配置零写盘', async () => {
    const web = makeHost()
    const cfg = join(web, 'config', 'config.ts')
    const before = readFileSync(cfg, 'utf8')
    const r = await runCli(['init', '--dry-run'], web)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('init dry-run')
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })

  it('uninit --dry-run（未注入）：exit 1 + stderr 含 未检测到 lpm 注入片段', async () => {
    const web = makeHost()
    const r = await runCli(['uninit', '--dry-run'], web)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('未检测到 lpm 注入片段')
  })
})
```

- [ ] **Step 2: 跑 e2e 验证失败（先 build）**

Run: `pnpm build`
Expected: tsup Build success（此时 init/uninit 仍是 stub，e2e 新用例红：`init --dry-run` 走 stub 报「计划 S13」）
Run: `npx vitest run tests/e2e/cli.e2e.test.ts`
Expected: S13 两个新用例 FAIL（stub 未实现）；既有 40 例 PASS

- [ ] **Step 3: cli.ts 接线**（在 `forget` 特判块之后、stub 循环之前插入两段）

```ts
    // S13：init 注入接线（无位置参数；diff 预览确认型，仿 repair）
    if (meta.name === 'init') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--dry-run', '仅打印注入 diff 预览，不落盘')
        .allowExcessArguments(false)
        .action(async (options: { dryRun?: boolean }) => {
          process.exitCode = await runInit(undefined, { dryRun: options.dryRun })
        })
      continue
    }
    // S13：uninit 摘除接线（对称）
    if (meta.name === 'uninit') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--dry-run', '仅打印摘除 diff 预览，不落盘')
        .allowExcessArguments(false)
        .action(async (options: { dryRun?: boolean }) => {
          process.exitCode = await runUninit(undefined, { dryRun: options.dryRun })
        })
      continue
    }
```

同时在 `src/cli.ts` import 区追加（与既有 import 合并进同一次编辑）：

```ts
import { runInit, runUninit } from './commands/init.js'
```

- [ ] **Step 4: 编译 + e2e 全绿**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/cli|src/commands/init"`
Expected: 零输出
Run: `pnpm build`
Expected: tsup Build success（e2e 走 dist，必须先重建）
Run: `npx vitest run tests/e2e/cli.e2e.test.ts`
Expected: PASS（40 + 2 = 42 passed；--help 回归钉仍全列 11 命令）

- [ ] **Step 5: 终态验证 `pnpm verify`**

Run: `pnpm verify`
Expected: exit 0 = typecheck 0 + build + unit **34 文件 / 573 例**（29 + 5 新文件：init-locate 15 + init-root 10 + init-alias 7 + init-inject 12 + init-command 11 = 55 新例）+ e2e **1 文件 / 42 例**（40 + 2 新冒烟）

- [ ] **Step 6: 文档收口 + 账本**

1. `docs/superpowers/specs/2026-09-29-s13-utoopack-adapt-design.md` §9 追加实现期裁定：
   - OCR-8 不触发（理由：init/uninit 的拒绝形态 = 非 TTY，与「交互遇 --dry-run 拒绝」语义不同；spec §8 自决 9 的「顺手抽」否决）
   - 其余 §8 自决 1–12 全部按 plan 落地（无偏差）
2. 建 `.superpowers/sdd/2026-09-29-s13-utoopack-adapt.md/progress.md`，记录 T1–T6 逐任务（实现者/改动文件/验证输出/未提交面），终态 `pnpm verify` 计数。
3. 过时声明扫描（用户规则）：`Get-ChildItem docs -Recurse -File -Include *.md | Select-String -Pattern '计划 S13|S13 待|未实现.*init|init.*尚未实现'`——命中 stub 相关旧文案（如 registry 注释）则修正。

- [ ] **Step 7: 记录未提交面**

Run: `git status --porcelain -uall`
Expected: `?? src/commands/init.ts` + `?? src/core/utoopack.ts` + `?? tests/unit/init-*.test.ts`（5 个）+ ` M src/cli.ts` + ` M tests/e2e/cli.e2e.test.ts` + `?? docs/superpowers/specs/2026-09-29-s13-utoopack-adapt-design.md` + `?? docs/superpowers/plans/2026-09-29-s13-utoopack-adapt.md` + `?? docs/handoffs/2026-09-29-s13-utoopack-adapt.md`（用户待 commit；`.superpowers/` 被 gitignore 不计）

---

## Self-Review 结果（writing-plans 自检，2026-09-29）

**Spec 覆盖**：§4.1 命令面 → T6；§4.2 宿主定位 → T1；§4.3 API → T5/T6；§4.4 原语 → T1/T2；§4.5 root/alias → T2/T3；§4.6 交互闸门 → T5；§4.7 diff 预览 → T5；§4.8 写盘/幂等/不完整标记 → T5；§4.9 完成提示 → T5；§5 错误表 I1–I8 → T1（类）+ T5（reportError）；§6 测试清单 → T1–T6 逐条对应；§8 自决 1–12 → T1–T6（9 否决、其余落地）。**零缺口**。

**占位扫描**：无 TBD/「待实现」残留（T1 的占位导出在 T2–T4 逐步替换，plan 内明确；最终态零占位）。

**类型一致性**：`runInit(cwd?, opts?)`/`runUninit(cwd?, opts?)` 在 T5 定义、T6 引用一致；`buildAliasMap`/`buildRootValue`/`buildFragment`/`injectFragment`/`removeFragment`/`locateConfigObject`/`findMarker`/`findHostConfig` 签名在 T1–T4 定义、T5 引用一致；错误类 8 个在 T1 定义、T2–T5 引用一致。`printInjectDiff` 为 init.ts 私有（spec §4.7），测试通过 stdout 断言验证，不导出。

**与既有冻结面核对**：cli.ts 只加两个特判块（仿既有模式），不动其余 9 命令；`renderPlan`/`reportError`（既有）/S1–S12 签名零改动；registry.ts COMMANDS 不动（`plannedSpec: 'S13'` 保留供 stub 提示，但 init/uninit 不再走 stub 分支）。
