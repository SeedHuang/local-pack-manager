# S2 workspace 解析 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 填充 S1 冻结的三个 workspace stub（`findWorkspaceRoot` / `loadWorkspace` / `findDependents`）：三格式清单探测、受限 glob 成员展开（含排除）、三依赖位命中扫描，全部只读，错误逐条带下一步动作。

**Architecture:** 公开面只在 `src/core/workspace.ts`（三个冻结函数 + 3 个错误类 + 内部 YAML 子集解析/manifest 读取）；新增纯函数匹配器 `src/core/globmatch.ts`（无 IO，golden 可测）。walker 全树遍历 + 模式过滤；pattern 前置校验一次报全。

**Tech Stack:** TypeScript（ESM，Node ≥ 18）+ vitest（零新增运行时依赖——spec 决策 A）

**Spec:** docs/superpowers/specs/2026-09-25-s2-workspace-discovery-design.md（glob 语义 §5 与错误契约 §6 是需求原文；执行者必须先读 spec §4.2–4.6 与 §5–§6）

## Global Constraints

- **S1 冻结签名零改动**：`findWorkspaceRoot/startDir→Promise<string>`、`loadWorkspace/rootDir→Promise<Workspace>`、`findDependents/ws,pkgName→Promise<DepHit[]>`；`PackageJsonInfo` / `Workspace` / `DepHit` 字段不动
- 依赖白名单不变：运行时恰为 commander / @clack/prompts / execa，devDeps 恰为 typescript / tsup / vitest / @types/node（**零新增**）
- **导入一律带 `.js` 扩展名**（S1 裁决：NodeNext 强制）；目录模块写 `<dir>/index.js`
- 全程只读：三个导出函数零写操作；错误后磁盘状态不变
- 报错优于猜测：语法/结构错误抛 spec §6 所列错误类（文案逐字），"语义空"（零命中/无 packages 键）是合法结果
- glob 匹配对象 = 相对 rootDir 的 posix 目录路径；root（空串）永不参与匹配；node_modules 与点目录硬排除；目录符号链接不跟随
- 大小写敏感匹配；pattern `\` → `/` 规范化（Windows 容错），尾随 `/` 去除
- **Git：本 plan 不含任何 commit 步骤**（用户全局 Git 规则）
- 循环引用说明：globmatch.ts ↔ workspace.ts 相互引用，但均只在函数体内使用对方导出（ESM 延迟绑定，初始化期不触达），安全

---

### Task 1: 受限 glob 匹配器（globmatch.ts）

**Files:**
- Create: `src/core/globmatch.ts`
- Test: `tests/unit/globmatch.test.ts`

**Interfaces:**
- Consumes: `WorkspacePatternError`（workspace.ts，Task 2 创建——本任务先写测试与 globmatch，typecheck 会在 Task 2 完成前报缺失错误属预期；本任务运行 `pnpm test` 仅验证 globmatch 用例失败原因正确）
- Produces: `matchWorkspacePattern(pattern: string, relDir: string): boolean`（Task 3 的 loadWorkspace 消费；纯函数，非法 pattern 抛 `WorkspacePatternError`（manifestPath 空串））

> 执行顺序说明：Task 1 先落 globmatch.ts + 测试；因 `WorkspacePatternError` 在 Task 2 才创建，本任务结束时 typecheck 允许存在 `workspace.js` 缺失错误——**只要 globmatch 的测试红灯原因是"无法解析 './workspace.js'"即算通过**；Task 2 落地后自然转绿（Task 2 的 Step 含回归验证 globmatch 用例）。

- [ ] **Step 1: 写失败测试 tests/unit/globmatch.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { matchWorkspacePattern } from '../../src/core/globmatch.js'
import { WorkspacePatternError } from '../../src/core/workspace.js'

const M = (pattern: string, relDir: string) => matchWorkspacePattern(pattern, relDir)

describe('受限 glob 语义（spec §5 逐条 golden）', () => {
  it('字面量段：精确且大小写敏感', () => {
    expect(M('docs', 'docs')).toBe(true)
    expect(M('docs', 'docs/site')).toBe(false)
    expect(M('Docs', 'docs')).toBe(false)
  })

  it('单段 *（spec §5 表）', () => {
    expect(M('packages/*', 'packages/server')).toBe(true)
    expect(M('packages/*', 'packages/a/b')).toBe(false)
    expect(M('packages/*', 'packages')).toBe(false)
  })

  it('** 零或多段；a/** 含 a 自身（§5.1）', () => {
    expect(M('packages/**', 'packages')).toBe(true)
    expect(M('packages/**', 'packages/a')).toBe(true)
    expect(M('packages/**', 'packages/a/b')).toBe(true)
    expect(M('packages/**', 'apps/web')).toBe(false)
  })

  it('裸 ** / 裸 *（§5.2/5.3）', () => {
    expect(M('**', 'a')).toBe(true)
    expect(M('**', 'a/b/c')).toBe(true)
    expect(M('*', 'a')).toBe(true)
    expect(M('*', 'a/b')).toBe(false)
  })

  it('规范化：反斜杠与尾随斜杠（§5 输入规范化）', () => {
    expect(M('packages\\*', 'packages/server')).toBe(true)
    expect(M('packages/*/', 'packages/server')).toBe(true)
    expect(M('packages\\**', 'packages/a')).toBe(true)
  })

  it('负模式由调用方剥离：匹配器按剥离后的内容匹配（§5 表）', () => {
    expect(M('!packages/legacy', 'packages/legacy')).toBe(true)
  })

  it('不支持语法逐一抛 WorkspacePatternError（§5.8；\\ 已按分隔符规范化故不在列）', () => {
    for (const bad of ['pkg?', 'pkg[ab]', 'pkg-{a,b}', 'pkg+(x)', 'pkg@(x)', 'app*', 'a**b', 'a//b', '', '!']) {
      expect(() => M(bad, 'x')).toThrow(WorkspacePatternError)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——globmatch 套件报"无法解析 `../../src/core/globmatch.js`"

- [ ] **Step 3: 写实现 src/core/globmatch.ts**

```ts
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
```

- [ ] **Step 4: 验证失败原因正确（而非其他错误）**

Run: `pnpm test`
Expected: globmatch 的 7 个用例仍 FAIL，但失败原因均为"无法解析 `../../src/core/workspace.js`"（WorkspacePatternError 缺失）——其余既有 7 个 S1 用例不受影响

---

### Task 2: 错误类 + findWorkspaceRoot

**Files:**
- Modify: `src/core/workspace.ts`（整文件重写：数据契约不动，stub → 错误类 + 内部读取函数 + findWorkspaceRoot 实现；loadWorkspace / findDependents 保持 stub）
- Test: `tests/unit/find-workspace-root.test.ts`
- Create fixtures: `tests/fixtures/workspace/monorepo-pnpm/**`、`single-package/**`（本任务所需部分）

**Interfaces:**
- Consumes: `matchWorkspacePattern`（Task 1；本任务不使用，Task 3 使用）
- Produces: `WorkspaceNotFoundError`（kind: start-dir-missing / root-not-found / invalid-root）、`ManifestParseError`、`WorkspacePatternError`（Task 1 的 globmatch 消费 → 解除其红灯）；`findWorkspaceRoot` 实现

- [ ] **Step 1: 创建本任务所需 fixtures（文件内容逐字）**

`tests/fixtures/workspace/monorepo-pnpm/package.json`：

```json
{
  "name": "monorepo-pnpm",
  "workspaces": ["packages/*"],
  "dependencies": { "@fixture/shared": "^0.1.0" }
}
```

`tests/fixtures/workspace/monorepo-pnpm/pnpm-workspace.yaml`：

```yaml
# 块列表 + 引号 + 排除 + 行内注释 + catalog 同存
packages:
  - 'packages/*'
  - 'apps/**'
  - docs # 文档站
  - !packages/legacy

catalog:
  react: ^18.0.0
```

`tests/fixtures/workspace/monorepo-pnpm/packages/server/package.json`：

```json
{
  "name": "@fixture/server",
  "devDependencies": { "@fixture/shared": "^0.2.0" },
  "peerDependencies": { "@fixture/peer-thing": "*" }
}
```

`tests/fixtures/workspace/monorepo-pnpm/packages/legacy/package.json`：

```json
{ "name": "@fixture/legacy" }
```

`tests/fixtures/workspace/monorepo-pnpm/apps/web/package.json`：

```json
{ "name": "@fixture/web" }
```

`tests/fixtures/workspace/monorepo-pnpm/docs/package.json`：

```json
{
  "name": "@fixture/docs",
  "optionalDependencies": { "@fixture/shared": "^0.3.0" }
}
```

`tests/fixtures/workspace/monorepo-pnpm/node_modules/fake/package.json`：

```json
{ "name": "fake" }
```

`tests/fixtures/workspace/monorepo-pnpm/.hidden/pkg/package.json`：

```json
{ "name": "hidden" }
```

`tests/fixtures/workspace/single-package/package.json`：

```json
{ "name": "single" }
```

- [ ] **Step 2: 写失败测试 tests/unit/find-workspace-root.test.ts**

```ts
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceNotFoundError, findWorkspaceRoot } from '../../src/core/workspace.js'

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))

afterEach(() => vi.restoreAllMocks())

describe('findWorkspaceRoot（spec §4.4）', () => {
  it('monorepo 内子包 cwd → workspace 根（§4.4.2）', async () => {
    const root = await findWorkspaceRoot(path.join(FIX('monorepo-pnpm'), 'packages', 'server'))
    expect(path.resolve(root)).toBe(path.resolve(FIX('monorepo-pnpm')))
  })

  it('单包 cwd → 自身（§4.4.5 fallback）', async () => {
    const root = await findWorkspaceRoot(FIX('single-package'))
    expect(path.resolve(root)).toBe(path.resolve(FIX('single-package')))
  })

  it('cwd 在无 package.json 的中间目录，标记在上层（§4.4.2）', async () => {
    const root = await findWorkspaceRoot(path.join(FIX('monorepo-pnpm'), 'packages'))
    expect(path.resolve(root)).toBe(path.resolve(FIX('monorepo-pnpm')))
  })

  it('startDir 不存在 → start-dir-missing（§6.1）', async () => {
    const p = path.join(FIX('single-package'), 'no-such-dir')
    const err = await findWorkspaceRoot(p).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspaceNotFoundError)
    expect((err as WorkspaceNotFoundError).kind).toBe('start-dir-missing')
    expect((err as Error).message).toContain('路径不存在')
  })

  it('盘根无任何标记与 package.json → root-not-found（§6.2；fs spy 隔离祖先链）', async () => {
    const spy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === os.tmpdir())
    try {
      const err = await findWorkspaceRoot(os.tmpdir()).catch((e) => e)
      expect(err).toBeInstanceOf(WorkspaceNotFoundError)
      expect((err as WorkspaceNotFoundError).kind).toBe('root-not-found')
      expect((err as Error).message).toContain('未找到项目根')
    } finally {
      spy.mockRestore()
    }
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test`
Expected: find-workspace-root 套件 FAIL——无法解析 `../../src/core/workspace.js`（错误类缺失）；globmatch 套件同样因该缺失 FAIL

- [ ] **Step 4: 重写 src/core/workspace.ts（整文件；数据契约与 S1 逐字一致）**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

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
  try {
    return JSON.parse(stripBom(source)) as Record<string, unknown>
  } catch (e) {
    throw new ManifestParseError(
      manifestPath,
      `清单解析失败：${manifestPath}（${(e as Error).message}）。请修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状。`,
    )
  }
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
  throw new Error('not implemented: loadWorkspace（计划 S2）')
}

export async function findDependents(ws: Workspace, pkgName: string): Promise<DepHit[]> {
  throw new Error('not implemented: findDependents（计划 S2）')
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS——globmatch 7 例转绿（WorkspacePatternError 就位）+ find-workspace-root 5 例绿 + S1 既有 7 例绿，共 19 例
Run: `pnpm typecheck`
Expected: 无输出

---

### Task 3: loadWorkspace（YAML 子集 + walker + 模式编排）

**Files:**
- Modify: `src/core/workspace.ts`（新增内部 `parsePackagesYaml` / `parseFlowList` / `unquoteValue`；替换 `loadWorkspace` stub；import 增加 `readdirSync` 与 `matchWorkspacePattern`）
- Test: `tests/unit/load-workspace.test.ts`
- Create fixtures: `monorepo-npm/**`、`monorepo-npm-object/**`、`monorepo-npm-empty/**`、`monorepo-empty-patterns/**`、`monorepo-zero-hit/**`、`monorepo-bom/**`、`broken-bad-json/**`、`broken-member-bad-json/**`、`broken-bad-yaml/**`、`broken-bad-pattern/**`

**Interfaces:**
- Consumes: `matchWorkspacePattern`（Task 1）、`readManifest` / `extractWorkspacesPatterns`（Task 2 内部函数）
- Produces: `loadWorkspace` 实现（Task 4 测试经由 fixture workspace 消费）

- [ ] **Step 1: 创建 fixtures（文件内容逐字）**

`tests/fixtures/workspace/monorepo-npm/package.json`：

```json
{ "name": "monorepo-npm", "workspaces": ["packages/*"] }
```

`tests/fixtures/workspace/monorepo-npm/packages/a/package.json`：

```json
{ "name": "@fixture/a" }
```

`tests/fixtures/workspace/monorepo-npm/packages/b/package.json`：

```json
{ "name": "@fixture/b" }
```

`tests/fixtures/workspace/monorepo-npm-object/package.json`：

```json
{ "name": "monorepo-npm-object", "workspaces": { "packages": ["apps/*"], "nohoist": ["**/y"] } }
```

`tests/fixtures/workspace/monorepo-npm-object/apps/one/package.json`：

```json
{ "name": "@fixture/one" }
```

`tests/fixtures/workspace/monorepo-npm-empty/package.json`：

```json
{ "name": "monorepo-npm-empty", "workspaces": [] }
```

`tests/fixtures/workspace/monorepo-empty-patterns/package.json`：

```json
{ "name": "monorepo-empty-patterns" }
```

`tests/fixtures/workspace/monorepo-empty-patterns/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  esbuild: true
```

`tests/fixtures/workspace/monorepo-zero-hit/package.json`：

```json
{ "name": "monorepo-zero-hit" }
```

`tests/fixtures/workspace/monorepo-zero-hit/pnpm-workspace.yaml`：

```yaml
packages:
  - 'nonexistent/*'
```

`tests/fixtures/workspace/monorepo-bom/package.json`：UTF-8 **带 BOM** 写入（内容首字符 U+FEFF）：

```json
{ "name": "monorepo-bom" }
```

`tests/fixtures/workspace/broken-bad-json/package.json`（尾逗号，非法 JSON）：

```json
{ "name": "bad", }
```

`tests/fixtures/workspace/broken-member-bad-json/package.json`：

```json
{ "name": "member-bad-json" }
```

`tests/fixtures/workspace/broken-member-bad-json/pnpm-workspace.yaml`：

```yaml
packages:
  - 'pkgs/*'
```

`tests/fixtures/workspace/broken-member-bad-json/pkgs/bad/package.json`：

```json
{ "name": }
```

`tests/fixtures/workspace/broken-bad-yaml/package.json`：

```json
{ "name": "bad-yaml" }
```

`tests/fixtures/workspace/broken-bad-yaml/pnpm-workspace.yaml`（值引号不闭合）：

```yaml
packages:
  - "unclosed
```

`tests/fixtures/workspace/broken-bad-pattern/package.json`：

```json
{ "name": "bad-pattern", "workspaces": ["packages/*", "pkg-{a,b}"] }
```

- [ ] **Step 2: 写失败测试 tests/unit/load-workspace.test.ts**

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ManifestParseError,
  WorkspacePatternError,
  loadWorkspace,
  type Workspace,
} from '../../src/core/workspace.js'

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))
const rels = (ws: Workspace) =>
  ws.members.map((m) => path.relative(ws.rootDir, m.dir).replaceAll('\\', '/'))

describe('loadWorkspace（spec §4.5）', () => {
  it('pnpm 块列表+引号+排除+catalog 同存：golden 序 + 双标记 pnpm 优先', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.manifestFormat).toBe('pnpm-workspace')
    expect(rels(ws)).toEqual(['', 'apps/web', 'docs', 'packages/server'])
    expect(ws.members[0]?.isRoot).toBe(true)
    expect(ws.members[0]?.name).toBe('monorepo-pnpm')
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('legacy'))).toBe(false)
  })

  it('无 packages 键 → 仅 root（§5 YAML.5；本仓库自身同款形态）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-empty-patterns'))
    expect(ws.manifestFormat).toBe('pnpm-workspace')
    expect(ws.members).toHaveLength(1)
    expect(ws.members[0]?.isRoot).toBe(true)
  })

  it('npm 数组 form', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(rels(ws)).toEqual(['', 'packages/a', 'packages/b'])
  })

  it('npm 对象 form（yarn classic { packages }）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm-object'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(rels(ws)).toEqual(['', 'apps/one'])
  })

  it('空数组 workspaces → 仅 root（§4.4.3 含空数组算标记）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm-empty'))
    expect(ws.manifestFormat).toBe('package-json')
    expect(ws.members).toHaveLength(1)
  })

  it('single', async () => {
    const ws = await loadWorkspace(FIX('single-package'))
    expect(ws.manifestFormat).toBe('single')
    expect(ws.members).toHaveLength(1)
  })

  it('node_modules / 点目录永不入选，即使 pattern 意图覆盖（§5.4/5.5）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('node_modules'))).toBe(false)
    expect(ws.members.some((m) => m.dir.replaceAll('\\', '/').includes('.hidden'))).toBe(false)
  })

  it('命中目录无 package.json（apps）时后代仍命中（§4.5.3 继续下钻；由 pnpm golden 的 apps/web 隐含覆盖）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(ws.members.some((m) => m.name === '@fixture/web')).toBe(true)
  })

  it('零命中 → 合法 members=[root]（§2 语义空）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-zero-hit'))
    expect(ws.members).toHaveLength(1)
  })

  it('根 manifest 坏 JSON → ManifestParseError（§6.4）', async () => {
    const err = await loadWorkspace(FIX('broken-bad-json')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as ManifestParseError).manifestPath).toBe(path.join(FIX('broken-bad-json'), 'package.json'))
    expect((err as Error).message).toContain('清单解析失败')
  })

  it('成员 manifest 坏 JSON → ManifestParseError（§4.5.3 不静默跳过）', async () => {
    const err = await loadWorkspace(FIX('broken-member-bad-json')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as ManifestParseError).manifestPath).toContain(path.join('pkgs', 'bad', 'package.json'))
  })

  it('坏 YAML → ManifestParseError（§6.5）', async () => {
    const err = await loadWorkspace(FIX('broken-bad-yaml')).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
    expect((err as Error).message).toContain('引号不闭合')
  })

  it('非法 pattern → WorkspacePatternError（先整体校验，带 pattern 与清单定位）', async () => {
    const p = FIX('broken-bad-pattern')
    const err = await loadWorkspace(p).catch((e) => e)
    expect(err).toBeInstanceOf(WorkspacePatternError)
    expect((err as WorkspacePatternError).pattern).toBe('pkg-{a,b}')
    expect((err as WorkspacePatternError).manifestPath).toBe(path.join(p, 'package.json'))
  })

  it('根 manifest 带 BOM → 正常解析（§4.2 读取规约）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-bom'))
    expect(ws.members[0]?.name).toBe('monorepo-bom')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test`
Expected: load-workspace 套件 FAIL——`not implemented: loadWorkspace（计划 S2）`

- [ ] **Step 4: 实现——workspace.ts 增补以下内容**

import 行改为：

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { matchWorkspacePattern } from './globmatch.js'
```

在错误类之后、`findWorkspaceRoot` 之前新增内部函数：

```ts
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
    if (!line.startsWith(' ') && !line.startsWith('-')) {
      if (trimmed === 'packages:') {
        inPackages = true
      } else {
        if (trimmed.startsWith('packages:')) {
          patterns.push(...parseFlowList(trimmed.slice('packages:'.length).trim(), yamlPath))
        }
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
```

`loadWorkspace` stub 整体替换为：

```ts
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

  // pattern 前置校验（§4.5.3：错误前置、一次报全；以空 relDir 探测调用匹配器完成校验，
  // WorkspacePatternError 重抛时补全 manifestPath 定位——§4.3 重抛机制）
  for (const p of patterns) {
    try {
      matchWorkspacePattern(p, '')
    } catch (e) {
      if (e instanceof WorkspacePatternError) {
        throw new WorkspacePatternError(e.pattern, patternSource, e.message)
      }
      throw e
    }
  }

  const members: PackageJsonInfo[] = [
    {
      dir: rootDir,
      manifestPath: rootManifestPath,
      name: typeof rootManifest['name'] === 'string' ? rootManifest['name'] : '',
      isRoot: true,
    },
  ]

  if (patterns.length > 0) {
    const positives = patterns.filter((p) => !p.startsWith('!'))
    const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
    const collected: string[] = []
    const walk = (dir: string, rel: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        if (entry.isSymbolicLink()) continue
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
        collected.push(childRel)
        walk(path.join(dir, entry.name), childRel)
      }
    }
    walk(rootDir, '')

    // 正模式并集（Set 保持首次命中序 = DFS 字典序），再依序应用负模式剔除（§5.6/5.7）
    const hit = new Set<string>()
    for (const rel of collected) {
      if (positives.some((p) => matchWorkspacePattern(p, rel))) hit.add(rel)
    }
    for (const rel of hit) {
      if (negatives.some((p) => matchWorkspacePattern(p, rel))) continue
      const manifestPath = path.join(rootDir, rel, 'package.json')
      if (!existsSync(manifestPath)) continue   // 命中目录无 package.json → 非成员（后代已在 collected 中）
      const manifest = readManifest(manifestPath)
      members.push({
        dir: path.join(rootDir, rel),
        manifestPath,
        name: typeof manifest['name'] === 'string' ? manifest['name'] : '',
        isRoot: false,
      })
    }
  }

  return { rootDir, manifestFormat, members }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS——load-workspace 14 例绿；累计 unit 33 例（globmatch 7 + root 5 + load 14 + S1 7）
Run: `pnpm typecheck`
Expected: 无输出

---

### Task 4: findDependents

**Files:**
- Modify: `src/core/workspace.ts`（替换 `findDependents` stub；新增内部常量 `DEP_SECTIONS`）
- Test: `tests/unit/find-dependents.test.ts`

**Interfaces:**
- Consumes: `loadWorkspace`（Task 3，测试中经 fixture workspace 消费）、`readManifest`（Task 2 内部函数）
- Produces: `findDependents` 实现（S5/S6 消费）

- [ ] **Step 1: 写失败测试 tests/unit/find-dependents.test.ts**

```ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ManifestParseError,
  findDependents,
  loadWorkspace,
  type Workspace,
} from '../../src/core/workspace.js'

const FIX = (name: string) => fileURLToPath(new URL(`../fixtures/workspace/${name}`, import.meta.url))

describe('findDependents（spec §4.6）', () => {
  it('三段命中 + 多成员 + 成员序（monorepo-pnpm golden）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    const hits = await findDependents(ws, '@fixture/shared')
    expect(hits).toEqual([
      {
        manifestPath: path.join(ws.rootDir, 'package.json'),
        section: 'dependencies',
        currentValue: '^0.1.0',
      },
      {
        manifestPath: path.join(ws.rootDir, 'docs', 'package.json'),
        section: 'optionalDependencies',
        currentValue: '^0.3.0',
      },
      {
        manifestPath: path.join(ws.rootDir, 'packages', 'server', 'package.json'),
        section: 'devDependencies',
        currentValue: '^0.2.0',
      },
    ])
  })

  it('peerDependencies 不产出 hit（§4.6）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-pnpm'))
    expect(await findDependents(ws, '@fixture/peer-thing')).toEqual([])
  })

  it('空/缺段合法 → 无 hit', async () => {
    const ws = await loadWorkspace(FIX('single-package'))
    expect(await findDependents(ws, '@fixture/shared')).toEqual([])
  })

  it('坏 manifest → 传播 ManifestParseError（§4.6 不静默跳过；手工构造 ws）', async () => {
    const dir = FIX('broken-bad-json')
    const ws: Workspace = {
      rootDir: dir,
      manifestFormat: 'single',
      members: [
        {
          dir,
          manifestPath: path.join(dir, 'package.json'),
          name: '',
          isRoot: true,
        },
      ],
    }
    const err = await findDependents(ws, 'x').catch((e) => e)
    expect(err).toBeInstanceOf(ManifestParseError)
  })

  it('currentValue 为字面量原样（含非常规 range）', async () => {
    const ws = await loadWorkspace(FIX('monorepo-npm'))
    expect(await findDependents(ws, '@fixture/none')).toEqual([])
    const hits = await findDependents(ws, '@fixture/a')
    expect(hits).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: find-dependents 套件 FAIL——`not implemented: findDependents（计划 S2）`

- [ ] **Step 3: 实现——workspace.ts 替换 findDependents stub**

在文件内（`loadWorkspace` 之后）新增常量并替换函数体：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS——find-dependents 5 例绿；累计 unit 38 例
Run: `pnpm typecheck`
Expected: 无输出

---

### Task 5: 收口——S1 spec 回写 + verify 全绿

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（§4.7 回写义务的履行）
- 无新代码

**Interfaces:**
- Consumes: Task 1-4 全部产出
- Produces: spec 与代码一致（S1 §4.6 约定）；`pnpm verify` 全绿 = spec §7.4 验收 1/6

- [ ] **Step 1: S1 spec §4.1 文件树回写**

在 S1 spec 的 §4.1 文件清单 `core/` 块中，`workspace.ts` 行之前插入一行（保持树形对齐）：

```
   │  ├─ globmatch.ts       # S2 新增：受限 glob 匹配器（纯函数，无 IO）
```

- [ ] **Step 2: S1 spec §4.3 末尾追加导出记录**

在 S1 spec §4.3 小节末尾追加：

```markdown
> S2 落地回写（S1 §4.6 演进约定）：`core/globmatch.ts` 新增导出 `matchWorkspacePattern`；`core/workspace.ts` 新增导出 3 个错误类 `WorkspaceNotFoundError` / `ManifestParseError` / `WorkspacePatternError`。冻结签名与数据契约未改动。
```

- [ ] **Step 3: 全量收口**

Run: `pnpm verify`
Expected: typecheck → build → unit（38 例）→ e2e（5 例）全绿（S2 spec §7.4 验收 1/6 达成；验收 2/3/4 由 Task 1-4 的 golden 与错误断言构成）

---

## Self-Review 记录

1. **Spec 覆盖**：§4.3 错误类+匹配器 → Task 1/2；§4.4 findWorkspaceRoot → Task 2；§4.5 loadWorkspace（YAML 子集/walker/前置校验/读取规约）→ Task 3；§4.6 findDependents → Task 4；§4.7 回写义务 → Task 5；§7.2 四个测试文件 → Task 1-4；fixture 树（§4.1 + §7.2 用例所需，含 monorepo-zero-hit / monorepo-bom / 4 个 broken 变体）→ Task 2/3。无缺口
2. **占位符扫描**：所有代码步骤含完整代码；fixture 文件逐字给出；无 TBD/TODO
3. **类型一致性**：`WorkspacePatternError(pattern, manifestPath, message)` 构造签名在 globmatch（manifestPath=''）与 workspace 重抛（补全）两处一致；`matchWorkspacePattern` 签名一致；测试导入路径均带 `.js`（S1 裁决）；`rels()` 辅助仅在 load-workspace.test.ts 内定义并使用
4. **既有测试回归**：Task 2 重写 workspace.ts 保留 `loadWorkspace`/`findDependents` stub（not-implemented 文案不变），S1 的 state-stub.test.ts 不受影响（它只测 state 模块）；unit 计数 7（S1）+ 31（S2 新增）= 38
