# S5 改写引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 S1 §4.3 冻结的 core/rewriter.ts 四签名（mapProtocol / RewriteResult / rewriteDepValue / restoreDepValue）+ 新增 findDepEntries / ProtocolPathError——单遍字符串感知扫描器 + value 字面量区间拼接的文本级改写引擎（B3 修复），golden 内联样本 byte 级验证。

**Architecture:** 单文件 `src/core/rewriter.ts`：T1 落协议映射（常量单源）+ 错误类；T2 落私有扫描器（字符串状态机 + 花括号深度计数 + key 解码比对）与三导出（rewrite/restore 同一引擎、findDepEntries 复用扫描器）；T3 落 golden 内联样本集（22 样本覆盖 spec §4.5 #1–#14 维度）+ byte 级断言 + restore roundtrip；T4 回写 S1 spec stub 注记 + verify 收口。纯函数层，无 IO。

**Tech Stack:** TypeScript ESM（NodeNext，strict）+ Node ≥22.12 + vitest 5；仅用内置模块 node:path。

**Spec:** docs/superpowers/specs/2026-09-26-s5-rewrite-engine-design.md（含 §10 评审 Backlog F1–F10；plan 与 spec 同读）

## Global Constraints（每个任务隐含包含）

- **禁止一切 Git 写操作**（commit/restore/checkout 等）——用户全局规则，改动由用户自行 commit；本 plan 无任何 commit 步骤
- **终端为 Windows PowerShell**：命令一律 PowerShell 兼容写法；skill bash 脚本不可用
- **相对导入一律带 `.js` 扩展名**（NodeNext）；node 内置模块用具名导入（`import { isAbsolute, relative } from 'node:path'`，同 core 既有风格）
- **运行时依赖零新增**（PRD §14 行 391）：本 plan 仅用 node:path + `import type { PackageManagerId } from './pm.js'`（S1 冻结 import 行）
- **冻结签名零改动**：S1 §4.3 五导出（Protocol / mapProtocol / RewriteResult / rewriteDepValue / restoreDepValue）逐字保持；S5 新增 2 导出（findDepEntries / ProtocolPathError）后公共 API 恰为 **7 导出封闭面**，扫描器不导出
- **格式保真是拼接的必然结果**：实现只允许替换 value 字面量区间 `[valueStart, valueEnd)`，区间外字节零触碰（B3 修复落点，spec §4.4）
- **keys 输出按规范段序**（dependencies → devDependencies → optionalDependencies → peerDependencies）且 "段名.包名" 整体构造——**禁止按 '.' 切分**（F5，包名可含点如 lodash.chunk）
- **测试代码为权威**：plan 内计数若与实测不符，以实测为准并在账本记录（S3 P0 先例）
- **测试期子代理运行后必须核对 git status**（2026-09-26 双 BOM 教训）；本 plan 无磁盘 fixture 写入（golden 内联，裁定②），无 BOM 敏感文件写入
- **每任务结束全量绿**：任务收尾时既有用例不得红

## 计划期修订（writing-plans 自审发现，随 plan 评审一并确认——S3/S4 先例）

1. **keys 输出顺序定版为规范段序**：spec §4.4 仅对 findDepEntries 明文「顺序固定」；changedKeys/unchangedKeys 沿用同序（内部以段为键的 Map + 按 SCAN_SECTIONS 遍历输出，天然规范序 + F3 去重），消除对文档顺序的依赖。golden #13 断言即此序。行为细节澄清，不违反 spec。
2. **未闭合字符串字面量不记命中点**（`closingQuote` 返回 -1 时该 value 跳过）：畸形尾部不参与改写，容错安全侧——spec §4.4 未明文，实现自决，评审可否决。
3. **T2/T3 红灯形态为整文件 import ERROR**（ESM 具名导出缺失 / 模块不存在），非断言 FAIL——与 S4「TypeError 形红」不同型，属预期。
4. **unit 计数链**：T1 +4 → 126；T2 +6 → 132；T3 +24 → **156**（22 golden + BOM 断言 1 + roundtrip 1）；e2e 11 不变。测试代码为权威。
5. **跨盘符用例为 Windows 专属语义**（POSIX 无盘符概念，path.relative 不退化）——spec §7.4 验收 1「本机 Windows 通过」语境下确定性成立。
6. **T2 评审期勘误（SDD fix round 1，2026-09-26）**：Task 2 参考实现未落实 spec §4.4「peerDependencies 段不改写」（改写循环无段过滤 + keys 循环遍历含 peer 的 SCAN_SECTIONS）——修订为 REWRITE_SECTIONS（三改段）单源 + SCAN_SECTIONS 派生（F6 同款），改写循环跳过 peer 命中点、keys 循环仅遍历三改段；增补用例 11（仅 peer 零改动双空 + 混合命中 peer 值原样）；计数链修订为 T2 +7 → **133**、T3 +24 → **157**（golden #10 与用例 11 互补：byte 级 golden + 行为契约各一）。同轮 T1 fix：跨盘符守卫 POSIX 盲区强化（见 Task 1 代码块，POSIX 退化产物 '../D:/...' 由盘符段正则命中）。
7. **OCR 修复轮勘误（2026-09-26，用户授权控制者直修）**：OCR 评审 5 意见——采纳 3：①mapProtocol 盘符正则尾锚定 `/(^|\/)[a-zA-Z]:(\/|$)/`（防 POSIX 含冒号目录名误报，Windows 行为不变）②mapProtocol `./` 前缀判定段感知 `/^\.\.?($|\/)/`（防 '.libs/foo' 产出非法 'file:.libs/foo'）③补 golden #15（optionalDependencies 命中，三改段全覆盖）。关闭 2：changed 段幂等命中点重拼接（spec §4.4 明文全部命中点均改写，非缺陷）、skipRoundtrip 样本 originalValue 惰性（runtime 不消费）。计数链修订：T3 golden 23 + BOM 1 + roundtrip 1 = **25**，rewriter.test.ts **36**，unit **158**。spec §4.4 步骤 3/4 与 §4.5 表随轮同步。

---

### Task 1: mapProtocol 协议映射 + ProtocolPathError

**Files:**
- Create: `src/core/rewriter.ts`
- Test: `tests/unit/rewriter.test.ts`（新建）

**Interfaces:**
- Consumes: `PackageManagerId`（src/core/pm.ts 导出，type-only import，S1 冻结 import 行）
- Produces（Task 2/3 依赖）: `export type Protocol = 'link' | 'portal' | 'file'`；`export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string`；`export class ProtocolPathError extends Error`（构造参数 `public libDirAbs: string, public manifestDirAbs: string, message: string`，`name = 'ProtocolPathError'`）；模块级常量 `PROTOCOL_BY_PM`（协议映射单源，F6）。文件注释保留 S1 §4.3 冻结注释原文（mapProtocol 处去掉 `// stub`）。

- [ ] **Step 1: 写失败测试**

新建 `tests/unit/rewriter.test.ts` 全文：

```ts
import { describe, expect, it } from 'vitest'
import { mapProtocol, ProtocolPathError } from '../../src/core/rewriter.js'

describe('mapProtocol（S5 spec §4.4）', () => {
  it('用例 1：四 pm 协议映射（S3 spec §8 定版）', () => {
    expect(mapProtocol('pnpm', 'C:\\repo\\lib', 'C:\\app')).toBe('link:../repo/lib')
    expect(mapProtocol('yarn-classic', 'C:\\repo\\lib', 'C:\\app')).toBe('link:../repo/lib')
    expect(mapProtocol('yarn-berry', 'C:\\repo\\lib', 'C:\\app')).toBe('portal:../repo/lib')
    expect(mapProtocol('npm', 'C:\\repo\\lib', 'C:\\app')).toBe('file:../repo/lib')
  })

  it('用例 2：相对换算基准 = manifest 所在目录；反斜杠输入 → 正斜杠输出', () => {
    expect(mapProtocol('pnpm', 'C:\\app\\libs\\lib', 'C:\\app')).toBe('link:./libs/lib')
    expect(mapProtocol('pnpm', 'C:\\libs\\lib', 'C:\\app\\packages\\web')).toBe('link:../../../libs/lib')
    expect(mapProtocol('npm', 'C:/libs/lib', 'C:\\app')).toBe('file:../libs/lib')
  })

  it('用例 3：同目录 → "./"（步骤 3 空串规则）', () => {
    expect(mapProtocol('pnpm', 'C:\\app', 'C:\\app')).toBe('link:./')
    expect(mapProtocol('npm', 'C:\\app', 'C:\\app')).toBe('file:./')
  })

  it('用例 4：Windows 跨盘符 → ProtocolPathError（message 含两路径，计划期修订 5）', () => {
    let err: unknown
    try {
      mapProtocol('pnpm', 'D:\\libs\\lib', 'C:\\app')
      expect.unreachable('应抛出 ProtocolPathError')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ProtocolPathError)
    const perr = err as ProtocolPathError
    expect(perr.libDirAbs).toBe('D:\\libs\\lib')
    expect(perr.manifestDirAbs).toBe('C:\\app')
    expect(perr.message).toContain('D:\\libs\\lib')
    expect(perr.message).toContain('C:\\app')
    expect(perr.name).toBe('ProtocolPathError')
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **整文件 ERROR——Failed to resolve import "../../src/core/rewriter.js"**（源文件尚不存在，计划期修订 3）。

- [ ] **Step 3: 实现**

新建 `src/core/rewriter.ts` 全文：

```ts
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
      `无法生成相对路径（跨盘符？）：libDir=${libDirAbs} manifestDir=${manifestDirAbs}`,
    )
  }
  // 步骤 3（OCR 修复轮段感知精化）：不以 './' 或 '../' 段开头（/^\.\.?($|\/)/）补 './' 前缀
  // ——防 '.libs/foo' 这类点开头目录产出非法 'file:.libs/foo'；空串（同目录）→ './'
  let relFixed = rel
  if (rel === '') relFixed = './'
  else if (!/^\.\.?($|\/)/.test(rel)) relFixed = `./${rel}`
  return `${protocol}:${relFixed}`
}
```

- [ ] **Step 4: 跑绿灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **4 passed**。

Run: `pnpm vitest run tests/unit`
Expected: **126 passed（12 文件 + rewriter.test.ts = 13 文件）**，既有用例零回归。

- [ ] **Step 5: 编译与 git status 核对**

Run: `pnpm typecheck`
Expected: 0 错误。

Run: `git status --porcelain -uall`
Expected: 改动面恰为 `?? src/core/rewriter.ts` + `?? tests/unit/rewriter.test.ts` + 既有未跟踪 docs；无越界文件、无 fixture 残留。

### Task 2: 文本级改写引擎（扫描器 + rewrite/restore/findDepEntries）

**Files:**
- Modify: `src/core/rewriter.ts`（文件末尾追加引擎段）
- Test: `tests/unit/rewriter.test.ts`（import 区合并 + 末尾追加两个 describe）

**Interfaces:**
- Consumes: Task 1 的 `src/core/rewriter.ts`（在其后追加；`PROTOCOL_BY_PM` 不动）
- Produces（Task 3 依赖）: `export interface RewriteResult { content: string; changedKeys: string[]; unchangedKeys: string[] }`（S1 冻结）；`export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult`；`export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult`（= 复用 rewriteDepValue）；`export function findDepEntries(manifestSource: string, pkgName: string): string[]`；模块级常量 `SCAN_SECTIONS`（四段名单单源，F6）；私有 `scanManifest`（不导出）。

- [ ] **Step 1: 写失败测试**

`tests/unit/rewriter.test.ts` 顶部 import 区改为（具名导入合并为单条语句，替换 Task 1 的两导出导入）：

```ts
import {
  findDepEntries,
  mapProtocol,
  ProtocolPathError,
  restoreDepValue,
  rewriteDepValue,
} from '../../src/core/rewriter.js'
```

文件末尾追加：

```ts
describe('rewriteDepValue 行为契约（S5 spec §4.4）', () => {
  it('用例 5：零命中 → content 原样双空（含空串/纯空白 manifestSource，F7）', () => {
    const src = '{\n  "name": "app",\n  "dependencies": {\n    "other": "1.0.0"\n  }\n}\n'
    expect(rewriteDepValue(src, 'lib', 'link:../lib')).toEqual({
      content: src,
      changedKeys: [],
      unchangedKeys: [],
    })
    expect(rewriteDepValue('', 'lib', 'link:../lib')).toEqual({
      content: '',
      changedKeys: [],
      unchangedKeys: [],
    })
    expect(rewriteDepValue('  \n\t', 'lib', 'link:../lib')).toEqual({
      content: '  \n\t',
      changedKeys: [],
      unchangedKeys: [],
    })
  })

  it('用例 6：命中点 value 非字符串字面量 → 视为未命中不动', () => {
    const src = '{\n  "dependencies": {\n    "lib": null,\n    "also": {}\n  }\n}'
    const r = rewriteDepValue(src, 'lib', 'link:../lib')
    expect(r.content).toBe(src)
    expect(r.changedKeys).toEqual([])
    expect(r.unchangedKeys).toEqual([])
  })

  it('用例 7：字符串感知守护——scripts 值内 "dependencies"/花括号字样不误判段', () => {
    const src = [
      '{',
      '  "scripts": {',
      '    "build": "echo \\"{ dependencies: { \\"lib\\": \\"1.0.0\\" } }\\"",',
      '  },',
      '  "dependencies": {',
      '    "lib": "^2.0.0"',
      '  }',
      '}',
      '',
    ].join('\n')
    const r = rewriteDepValue(src, 'lib', 'link:../lib')
    expect(r.changedKeys).toEqual(['dependencies.lib'])
    // byte 级：仅真实依赖段 value 变化——把新值字面量还原回去应逐字节等于原文
    expect(r.content.replace('"link:../lib"', '"^2.0.0"')).toBe(src)
    expect(r.content).toContain('echo \\"{ dependencies: { \\"lib\\": \\"1.0.0\\" } }\\"')
  })

  it('用例 11：仅 peer 命中 → content 原样双空；混合命中 peer 值原样（spec §4.4，SDD 勘误增补）', () => {
    const peerOnly = '{\n  "name": "app",\n  "peerDependencies": {\n    "lib": "^1.0.0"\n  }\n}\n'
    expect(rewriteDepValue(peerOnly, 'lib', 'link:../lib')).toEqual({
      content: peerOnly,
      changedKeys: [],
      unchangedKeys: [],
    })
    const mixed = '{\n  "dependencies": {\n    "lib": "^1.0.0"\n  },\n  "peerDependencies": {\n    "lib": "^2.0.0"\n  }\n}\n'
    const rm = rewriteDepValue(mixed, 'lib', 'link:../lib')
    expect(rm.changedKeys).toEqual(['dependencies.lib'])
    expect(rm.content).toContain('"lib": "^2.0.0"')
    expect(rm.content).toContain('"lib": "link:../lib"')
  })
})

describe('findDepEntries（S5 spec §4.4，裁定①）', () => {
  it('用例 8：四段全命中 → 规范段序输出（与文档顺序无关，计划期修订 1）', () => {
    const src = [
      '{',
      '  "peerDependencies": { "lib": "*" },',
      '  "devDependencies": { "lib": "^1.0.0" },',
      '  "optionalDependencies": { "lib": "^2.0.0" },',
      '  "dependencies": { "lib": "^3.0.0" }',
      '}',
    ].join('\n')
    expect(findDepEntries(src, 'lib')).toEqual([
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
  })

  it('用例 9：仅 peer 命中 / 零命中', () => {
    expect(findDepEntries('{"peerDependencies": {"lib": "*"}}', 'lib')).toEqual(['peerDependencies'])
    expect(findDepEntries('{"dependencies": {"other": "1.0.0"}}', 'lib')).toEqual([])
  })

  it('用例 10：重复段 → 去重（F3 同族）', () => {
    const src = '{"dependencies": {"lib": "1.0.0"}, "name": "app", "dependencies": {"lib": "2.0.0"}}'
    expect(findDepEntries(src, 'lib')).toEqual(['dependencies'])
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **7 个新用例 FAIL**（用例 5–7 与 11 为 stub not-implemented throw；用例 8–10 为 findDepEntries is not a function；4 既有用例 PASS）——计划期修订 3 预测的 import ERROR 不会出现（导出名已作为 stub 存在），全失败且原因与待实现对应即等效红灯（SDD T1/T2 实证形态）。

- [ ] **Step 3: 实现**

`src/core/rewriter.ts` 文件末尾追加（Task 1 内容零改动）：

```ts
// ─────────────────────────── 文本级依赖改写引擎（S5 spec §4.4）───────────────────────────

export interface RewriteResult {
  content: string // 改写后全文
  changedKeys: string[] // "段名.包名"
  unchangedKeys: string[] // 值已等于目标（幂等命中）
}

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

/** unlink 恢复原 range，格式保持语义同上（同一引擎，不造第二实现） */
export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult {
  return rewriteDepValue(manifestSource, pkgName, originalRange)
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
```

- [ ] **Step 4: 跑绿灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **11 passed**（用例 1–11）。

Run: `pnpm vitest run tests/unit`
Expected: **133 passed**，既有用例零回归。

- [ ] **Step 5: 编译与 git status 核对**

Run: `pnpm typecheck`
Expected: 0 错误。

Run: `git status --porcelain -uall`
Expected: 改动面恰为 `?? src/core/rewriter.ts` + `?? tests/unit/rewriter.test.ts` + 既有未跟踪 docs。

### Task 3: golden 内联样本集 + byte 级断言

**Files:**
- Create: `tests/unit/rewriter-samples.ts`（纯数据模块，vitest 不收集——文件名不含 .test）
- Test: `tests/unit/rewriter.test.ts`（import 区并入 samples + 末尾追加 golden describe）

**Interfaces:**
- Consumes: Task 2 的 `rewriteDepValue` / `restoreDepValue`
- Produces: `export interface RewriteSample { name; source; pkgName; targetValue; originalValue; expectedContent; changedKeys; unchangedKeys; skipRoundtrip? }` 与 `export const rewriteSamples: RewriteSample[]`（22 样本，spec §4.5 #1–#14 维度全量）；`skipRoundtrip: true` 仅用于同名异值样本（F10 边界注记）。

- [ ] **Step 1: 写失败测试**

`tests/unit/rewriter.test.ts` import 区追加一行（与既有 import 并列）：

```ts
import { rewriteSamples } from './rewriter-samples.js'
```

文件末尾追加：

```ts
describe('golden 样本矩阵（S5 spec §4.5 #1–#14）', () => {
  for (const s of rewriteSamples) {
    it(`golden ${s.name}`, () => {
      const r = rewriteDepValue(s.source, s.pkgName, s.targetValue)
      expect(r.content).toBe(s.expectedContent)
      expect(r.changedKeys).toEqual(s.changedKeys)
      expect(r.unchangedKeys).toEqual(s.unchangedKeys)
    })
  }

  it('golden BOM 首字节保留断言（0xFEFF，#4/#4b；标题编号 T3 评审勘误）', () => {
    for (const s of rewriteSamples.filter((x) => x.name.includes('BOM'))) {
      expect(rewriteDepValue(s.source, s.pkgName, s.targetValue).content.charCodeAt(0)).toBe(0xfeff)
    }
  })

  it('golden restore roundtrip：byte 级还原（F10 标记样本除外）', () => {
    for (const s of rewriteSamples) {
      if (s.skipRoundtrip) continue
      const r = rewriteDepValue(s.source, s.pkgName, s.targetValue)
      const back = restoreDepValue(r.content, s.pkgName, s.originalValue)
      expect(back.content).toBe(s.source)
    }
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **整文件 ERROR——Failed to resolve import "./rewriter-samples.js"**（计划期修订 3）。

- [ ] **Step 3: 写样本集**

新建 `tests/unit/rewriter-samples.ts` 全文：

```ts
// S5 spec §4.5 golden 内联样本集（裁定②）——行数组逐字节控制，免疫 git autocrlf/编辑器规范化/
// Write 工具剥 BOM（S2 账本行 26 Ruling）。维度编号对应 spec §4.5 表 #1–#14。
// skipRoundtrip: 同名异值样本（F10：rewrite→restore 不保证 byte 级还原，边界明示不设分支）
export interface RewriteSample {
  name: string
  source: string
  pkgName: string
  targetValue: string
  originalValue: string
  expectedContent: string
  changedKeys: string[]
  unchangedKeys: string[]
  skipRoundtrip?: boolean
}

const BOM = '\uFEFF'
const lf = (lines: string[]) => lines.join('\n')
const crlf = (lines: string[]) => lines.join('\r\n')

export const rewriteSamples: RewriteSample[] = [
  // ── #1 基线：LF + 2 空格 + 尾随换行
  {
    name: '#1 基线 LF+2空格+尾随换行',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "left-pad": "^1.3.0",',
      '    "lib": "^2.0.0"',
      '  },',
      '  "devDependencies": {',
      '    "typescript": "^5.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "left-pad": "^1.3.0",',
      '    "lib": "link:../lib"',
      '  },',
      '  "devDependencies": {',
      '    "typescript": "^5.0.0"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #2 CRLF
  {
    name: '#2 CRLF',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: crlf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "^2.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: crlf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "link:../lib"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #2b 混合行尾：逐行原样保留
  {
    name: '#2b 混合行尾逐行保留',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: ['{\r\n', '  "name": "app",\n', '  "dependencies": {\r\n', '    "lib": "^2.0.0"\n', '  },\r\n', '}\n'].join(''),
    expectedContent: [
      '{\r\n',
      '  "name": "app",\n',
      '  "dependencies": {\r\n',
      '    "lib": "link:../lib"\n',
      '  },\r\n',
      '}\n',
    ].join(''),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #3 4 空格缩进
  {
    name: '#3 4空格缩进',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf([
      '{',
      '    "name": "app",',
      '    "dependencies": {',
      '        "lib": "^2.0.0"',
      '    },',
      '    "devDependencies": {}',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '    "name": "app",',
      '    "dependencies": {',
      '        "lib": "link:../lib"',
      '    },',
      '    "devDependencies": {}',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #3b tab 缩进
  {
    name: '#3b tab缩进',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf([
      '{',
      '\t"name": "app",',
      '\t"dependencies": {',
      '\t\t"lib": "^2.0.0"',
      '\t}',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '\t"name": "app",',
      '\t"dependencies": {',
      '\t\t"lib": "link:../lib"',
      '\t}',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #4 BOM + LF（BOM 字节保留）
  {
    name: '#4 BOM+LF',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: BOM + lf(['{', '  "dependencies": {', '    "lib": "^2.0.0"', '  }', '}', '']),
    expectedContent: BOM + lf(['{', '  "dependencies": {', '    "lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #4b BOM + CRLF
  {
    name: '#4b BOM+CRLF',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: BOM + crlf(['{', '  "dependencies": {', '    "lib": "^2.0.0"', '  }', '}', '']),
    expectedContent: BOM + crlf(['{', '  "dependencies": {', '    "lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #5 单行依赖块（段体在一行）
  {
    name: '#5 单行依赖块',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": { "lib": "^2.0.0", "other": "1.0.0" },',
      '  "devDependencies": {}',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": { "lib": "link:../lib", "other": "1.0.0" },',
      '  "devDependencies": {}',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #5b 整文件单行（minified）
  {
    name: '#5b 整文件单行',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: '{"name":"app","dependencies":{"lib":"^2.0.0","other":"1.0.0"},"devDependencies":{}}',
    expectedContent: '{"name":"app","dependencies":{"lib":"link:../lib","other":"1.0.0"},"devDependencies":{}}',
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #6 无尾随换行
  {
    name: '#6 无尾随换行',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf(['{', '  "dependencies": {', '    "lib": "^2.0.0"', '  }', '}']),
    expectedContent: lf(['{', '  "dependencies": {', '    "lib": "link:../lib"', '  }', '}']),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #7 key 乱序（devDependencies 在 dependencies 前）
  {
    name: '#7 key乱序 devDeps在前',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf([
      '{',
      '  "devDependencies": { "typescript": "^5.0.0" },',
      '  "dependencies": { "lib": "^2.0.0" },',
      '  "name": "app"',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "devDependencies": { "typescript": "^5.0.0" },',
      '  "dependencies": { "lib": "link:../lib" },',
      '  "name": "app"',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #8 @scope/package 包名
  {
    name: '#8 @scope包名',
    pkgName: '@scope/lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf(['{', '  "dependencies": {', '    "@scope/lib": "^2.0.0"', '  }', '}', '']),
    expectedContent: lf(['{', '  "dependencies": {', '    "@scope/lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.@scope/lib'],
    unchangedKeys: [],
  },
  // ── #9 多段命中（裁定③：全改 + keys 逐段；同名异值 → F10 跳过 roundtrip）
  {
    name: '#9 多段命中全改',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^3.0.0',
    source: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "^3.0.0"',
      '  },',
      '  "devDependencies": {',
      '    "lib": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "link:../lib"',
      '  },',
      '  "devDependencies": {',
      '    "lib": "link:../lib"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib', 'devDependencies.lib'],
    unchangedKeys: [],
    skipRoundtrip: true,
  },
  // ── #10 仅 peer 命中（零改写，裁定①数据源）
  {
    name: '#10 仅peer命中零改写',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^1.0.0',
    source: lf(['{', '  "name": "app",', '  "peerDependencies": {', '    "lib": "^1.0.0"', '  }', '}', '']),
    expectedContent: lf(['{', '  "name": "app",', '  "peerDependencies": {', '    "lib": "^1.0.0"', '  }', '}', '']),
    changedKeys: [],
    unchangedKeys: [],
  },
  // ── #11 幂等命中（值已等于目标 → unchangedKeys，字节不动）
  {
    name: '#11 幂等命中',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: 'link:../lib',
    source: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "link:../lib",',
      '    "other": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {',
      '    "lib": "link:../lib",',
      '    "other": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: [],
    unchangedKeys: ['dependencies.lib'],
  },
  // ── #12 空段（不使扫描器脱轨）
  {
    name: '#12 空段',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^1.0.0',
    source: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {},',
      '  "devDependencies": {',
      '    "lib": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "name": "app",',
      '  "dependencies": {},',
      '  "devDependencies": {',
      '    "lib": "link:../lib"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: ['devDependencies.lib'],
    unchangedKeys: [],
  },
  // ── #13 值形态：workspace:* / catalog:（改 workspace:* 一项）
  {
    name: '#13 值形态 workspace与catalog',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: 'workspace:*',
    source: lf([
      '{',
      '  "dependencies": {',
      '    "lib": "workspace:*",',
      '    "a": "catalog:",',
      '    "b": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    expectedContent: lf([
      '{',
      '  "dependencies": {',
      '    "lib": "link:../lib",',
      '    "a": "catalog:",',
      '    "b": "^1.0.0"',
      '  }',
      '}',
      '',
    ]),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #13b 已是本地协议 file:../x（纯引擎照改，无策略）
  {
    name: '#13b 本地协议照改',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: 'file:../x',
    source: lf(['{', '  "dependencies": {', '    "lib": "file:../x"', '  }', '}', '']),
    expectedContent: lf(['{', '  "dependencies": {', '    "lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #14 key 含 \/ 转义（F2：合法转义写法不漏命中，key 字节形态保留）
  {
    name: '#14 转义key命中',
    pkgName: '@scope/lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf(['{', '  "dependencies": {', '    "@scope\\/lib": "^2.0.0"', '  }', '}', '']),
    expectedContent: lf(['{', '  "dependencies": {', '    "@scope\\/lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.@scope/lib'],
    unchangedKeys: [],
  },
  // ── #14b value 含尾反斜杠 "a\\"（F1：扫描器守护——后续行不得被吞）
  {
    name: '#14b 尾反斜杠value',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '^2.0.0',
    source: lf(['{', '  "dependencies": {', '    "weird": "a\\\\",', '    "lib": "^2.0.0"', '  }', '}', '']),
    expectedContent: lf(['{', '  "dependencies": {', '    "weird": "a\\\\",', '    "lib": "link:../lib"', '  }', '}', '']),
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
  },
  // ── #14c 段内重复 key（F3：全改 + keys 去重；同名异值 → F10 跳过 roundtrip）
  {
    name: '#14c 段内重复key',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '1.0.0',
    source: '{"dependencies": {"lib": "1.0.0", "other": "2.0.0", "lib": "3.0.0"}}',
    expectedContent: '{"dependencies": {"lib": "link:../lib", "other": "2.0.0", "lib": "link:../lib"}}',
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
    skipRoundtrip: true,
  },
  // ── #14d 重复段（F3：全改 + keys 去重；同名异值 → F10 跳过 roundtrip）
  {
    name: '#14d 重复段',
    pkgName: 'lib',
    targetValue: 'link:../lib',
    originalValue: '1.0.0',
    source: '{"dependencies": {"lib": "1.0.0"}, "name": "app", "dependencies": {"lib": "2.0.0"}}',
    expectedContent: '{"dependencies": {"lib": "link:../lib"}, "name": "app", "dependencies": {"lib": "link:../lib"}}',
    changedKeys: ['dependencies.lib'],
    unchangedKeys: [],
    skipRoundtrip: true,
  },
]
```

- [ ] **Step 4: 跑绿灯**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: **36 passed**（用例 1–11 + golden 23 + BOM 断言 1 + roundtrip 1，含 OCR 修复轮补样 #15）。

Run: `pnpm vitest run tests/unit`
Expected: **158 passed（13 文件）**，既有用例零回归。

- [ ] **Step 5: 编译与 git status 核对**

Run: `pnpm typecheck`
Expected: 0 错误。

Run: `git status --porcelain -uall`
Expected: `M src/core/rewriter.ts`（T1/T2 遗留未提交）+ `?? tests/unit/rewriter.test.ts` + `?? tests/unit/rewriter-samples.ts` + 既有未跟踪 docs（T3 评审勘误：rewriter.ts 为 tracked 文件，M 为正确形态）。

### Task 4: S1 spec 回写 + verify 收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（4 hunk，行 235/245/255/258）

**Interfaces:**
- Consumes: 无代码依赖。
- Produces: S1 spec §4.3 core/rewriter.ts 节回写完成（S5 spec §4.6 义务）；`pnpm verify` 四段全绿收口数字（unit 157 + e2e 11；计数勘误见计划期修订 6）。

- [ ] **Step 1: S1 spec 回写（4 hunk，old_str 均应一次逐字命中）**

hunk 1（节标题注记）：

```markdown
 old_str: **core/rewriter.ts**（S5 填充）：
 new_str: **core/rewriter.ts**（已由 S5 实现；新增导出 findDepEntries / ProtocolPathError 见 S5 spec §4.3）：
```

hunk 2（mapProtocol 行去 stub）：

```markdown
 old_str: export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string   // stub
 new_str: export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string
```

hunk 3（rewriteDepValue 行去 stub）：

```markdown
 old_str: export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult   // stub
 new_str: export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult
```

hunk 4（restoreDepValue 行去 stub）：

```markdown
 old_str: export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult   // stub
 new_str: export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult
```

- [ ] **Step 2: 回写核对**

Run: `git diff -- docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md` 与 `git status --porcelain -uall`
Expected: S1 spec 恰 4 hunk 零外溢（RewriteResult 接口定义无 stub 注释不动）；改动面 = 上述三新文件 + S1 spec M + 既有未跟踪 docs。

- [ ] **Step 3: 全量 verify 收口**

Run: `pnpm verify`
Expected: typecheck 0 错误 + tsup build success + **unit 158/158（13 文件）** + **e2e 11/11**（计数链：122 基线 + T1 4 + T2 7 + T3 25，计划期修订 6/7 勘误；不符时以测试代码为准并在账本记录）。

- [ ] **Step 4: 终核**

Run: `git status --porcelain -uall`
Expected: 无越界改动、无 fixture/tmp 残留；改动全部未提交（用户自行 commit）。
