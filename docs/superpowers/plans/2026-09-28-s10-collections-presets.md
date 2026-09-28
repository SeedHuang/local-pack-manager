# S10 集合与预设 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「一批库」成为可存可复现的一等公民——`lpm link --last` / `--all` / `--preset <名>` 三条集合级直通（互斥、与位置参数互斥）、`lpm save <名>` / `lpm preset rm <名>` / `lpm preset` 菜单，以及 link 主列表的「快捷」组虚拟项；并把 last.json 的刷新口径补成 PRD §10 行 341 的字面（集合级操作一律刷新）。

**Architecture:** 集合开关**不新增入口**——`runLink(targets, opts, cwd)` 签名一字不动，只在 `LinkOptions` 追加 `last?` / `all?` / `preset?` 三个可选字段（spec 裁决 7，用户 2026-09-28 拍板）。`runLink` 第一行做互斥校验（早于一切读盘），随后把开关**展开成名字数组**交给既有的 `buildLinkPlan`——计划、dry-run、执行三段一行不改，所以「dry-run 说的」与「实际做的」仍同源。预设是**项目级 `lpm.config.json` 的 `presets` 字段**（S4 期已预留），新命令 `preset.ts` 只提供「守卫读取 + 存 + 删」，**零新增状态文件、零新增运行时依赖**。last 的口径改动**只有两处**：`executeLinkPlan` 的判定加 `forceLastWrite`，以及集合级分支「计划为空」出口补一次 `writeLast`——直通路径行为零变化（既有 39 + 35 例断言即判据）。

**Tech Stack:** TypeScript ESM（Node ≥ 22.12）+ commander + @clack/prompts **1.8.1**（`multiselect` / `groupMultiselect` / `confirm` / `text` / `isCancel`）+ execa + tsup + vitest。**运行时依赖零新增**。

**Spec:** `docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md`（行为权威；本计划与 spec 冲突时以 spec 为准。spec §9 的自审记录里有 2 P0 + 9 P1 + 17 P2 的完整清单，其中**三处**与本计划直接相关：`label` 字段不返回、`--last` 文案不得提 `lpm save`、集合级「全跳过」仍刷新 last）

## Global Constraints

- 技术栈定版：TS ESM + Node ≥ 22.12 + commander + @clack/prompts 1.8.1 + execa + tsup + vitest；**运行时依赖零新增**（PRD §14 行 391）
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入
- **禁止一切 Git 写操作**（worktree/分支/commit/push/add）：本计划所有任务**不执行任何 git 写命令**，改动由用户自行提交；每任务收尾只用**只读** `git status --porcelain -uall` 核对工作树
- 终端 Windows PowerShell；skill 自带 bash 脚本不可用；**brief 载体 = 本 plan 文件 + 任务标题锚定**（`### Task N:` 到下一个 `### Task ` 之前）；评审载体 = reviewer 直读产出文件（无 commit 区间可依）。实现者报告契约里「Commits created」栏位替换为「改动文件清单」
- 编辑纪律：**同一文件禁止并行 SearchReplace**；新增 import 与使用它的代码必须合并进**同一次**编辑；编辑后跑 `npx tsc --noEmit` 分级检查（**禁用 GetDiagnostics**——它是 TS Server 缓存，编辑后立即调用不可靠）
- 评审产物 / diff 一律用工具自身写文件（`git diff --no-index --output=<file>`）；**禁止**用 PowerShell `>` 重定向接原生命令输出（会写 BOM 且静默丢行）
- Task 工具无 model 参数，统一默认模型；实现者**禁止派生子代理**；子代理同样禁止 git 写操作
- **冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3、S9 §4.3 所列公共 API 的**既有签名**不变；`runLink(targets, opts, cwd)` / `runUnlink(targets, opts, cwd)` 形参不变；`UnlinkOptions` 不扩。**唯一松动的字面** = S9 §4.3「`LinkOptions` / `UnlinkOptions` 不扩字段」→ `LinkOptions` 允许**追加可选字段**（三个新字段缺省时行为与 HEAD 完全一致）
- **直通路径行为与文案逐字保真**：`lpm link <目标>...` / `lpm unlink ...` 的既有输出、写序、退出码一字不改；`link-command.test.ts`（39 例）与 `unlink-command.test.ts`（35 例）**零改动**即为判据。特别注意 `link-command.test.ts:282`（T4-15「全跳过不写 last」，targets 非空）与 `:407`（T4-23b「单个不写 last」）——本计划的 last 改动**只在集合级分支**，这两条必须保持绿
- dry-run 文案逐字保真：link 的 `dry-run 执行计划（不落任何盘、不执行任何子进程）：` 与 link 空分支的 `无待执行变更`（**无缩进**）一字不改
- 非 TTY 判定单源 = `process.stdin.isTTY !== true` → 一行提示 + **零菜单零写盘** + exit 1
- 退出码口径单源 = spec §4.11；错误类归命令文件（S6/S7 先例）：`PresetError` 定义在 `src/commands/preset.ts`
- 不新增任何状态文件；预设只写**已有**的 `lpm.config.json` 的 `presets` 字段；`save` / `preset rm` **不写** `.lpm/last-run.json`（S8 §4.3 的 `LastRunTrace.command` 只认 link/unlink/repair）
- 验证命令：`pnpm verify`（= typecheck && build && unit && e2e）。**基线：typecheck 0 + build 成功 + unit 24 文件 / 395 用例 + e2e 1 文件 / 28 用例，exit 0**（HEAD `0f9407d`，2026-09-28 实跑）
- 各任务里出现的累计计数（如「unit 398 例」）**仅为参考**；**一律以 `pnpm verify` 实测为准**，不符必须查明原因后才可继续，不得静默接受
- 计数链与文档回写最终定版在收尾任务（T7）

---

## 文件结构总览

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/commands/preset.ts` | **新增**：`PresetError` / `PresetView` / `readPresets`（守卫读取）+ `runSave` + `runPreset`（分派 / `rm` 直通 / 无参数交互菜单）+ 内部 `reportError` | T1 / T2 / T3 |
| `tests/unit/preset-command.test.ts` | **新增**：预设守卫 + save + preset 单测（PRE-* / SV-* / PR-*） | T1 / T2 / T3 |
| `src/commands/link.ts` | 改：`LinkOptions` 追加 3 个可选字段；新增内部 `resolveLinkCollection`；`runLink` 加参数校验 + 集合级分支；`executeLinkPlan` 的 last 判定加 `forceLastWrite`；`pickLinkTargets` 加「快捷」组并返回 `collectionLevel`；`runLinkInteractive` 读 `readLast` | T4 / T5 / T6 |
| `src/cli.ts` | 改：link 加 3 个 option；`save` / `preset` 从 stub 循环提出来接线 | T2 / T3 / T4 |
| `tests/unit/link-collection.test.ts` | **新增**：集合级直通 + last 口径（LC-*） | T4 / T5 |
| `tests/unit/link-interactive.test.ts` | 改：追加「快捷」组虚拟项用例（VI-*） | T6 |
| `tests/e2e/cli.e2e.test.ts` | 改：新增 5 例（E2E-S10-*） | T2 / T3 / T4 |
| `src/commands/registry.ts` | **零改动**（`plannedSpec` 是必填字段，仍被其余 stub 命令消费；T7 只**核实**无过期文案） | — |
| `docs/superpowers/specs/2026-09-28-s9-interactive-design.md`、`docs/handoffs/`、spec §10 | 改：S10 落地后的声明处回写 + 继任交接词 | T7 |

---

## Preflight 扫描（任务对 × 共享文件/接口）

| 对 | 共享 | 产出 ↔ 消费 | 结论 |
|---|---|---|---|
| T1 → T2 / T3 | `src/commands/preset.ts`（同文件） | `readPresets` / `PresetError` / `PresetView` / `reportError` ↔ `runSave` / `runPreset` | 同文件，**严格顺序**（T2/T3 只追加，不动 T1 的守卫） |
| T1 → T4 | `preset.ts` 的导出 | `readPresets` / `PresetError` ↔ `link.ts` 的 `--preset` 展开 + `reportError` KNOWN | 签名一致 ✓；`link.ts → preset.ts` **单向**，`preset.ts` 不反向 import |
| T2 / T3 / T4 | `src/cli.ts` | T2 加 `save` 分支、T3 加 `preset` 分支、T4 给 link 加 3 个 option | 不同行、不重叠；**严格顺序** |
| T4 → T5 | `src/commands/link.ts` | T4 的 `hasSwitch` 局部量 + 集合级分支的空计划出口 ↔ T5 的 `forceLastWrite` 字段与该出口的 `else if` | 同文件、**相邻区域**，**严格顺序** |
| T5 → T6 | `src/commands/link.ts` | `buildLinkPlan` 的 `forceLastWrite` 参数 ↔ T6 的 `collectionLevel` 传导 | 签名一致 ✓；**严格顺序** |
| T4 / T5 | `tests/unit/link-collection.test.ts` | T4 建文件（LC-1…LC-13）、T5 追加（LC-14…LC-18） | 同文件，**严格顺序** |
| T6 | `tests/unit/link-interactive.test.ts`（独占） | — | ✓ 与其它任务无交集 |
| T2 / T3 / T4 | `tests/e2e/cli.e2e.test.ts` | 各追加自己的用例 | 同文件，**严格顺序** |
| T1 / T2 / T3 | `tests/unit/preset-command.test.ts` | T1 建文件、T2/T3 追加 describe | 同文件，**严格顺序** |
| T6 → 既有 `collectLinkCandidates` | **只读消费** | `cand.registered` 当「注册表键集」用 | 不改其签名/返回（S9 §4.3 冻结导出）✓ |

**关键顺序约束**：T1 → T2 → T3 → T4 → T5 → T6 → T7（**串行，不可并行**）。

---

### Task 1: 预设表读取守卫（preset.ts 骨架）

**Files:**
- Create: `src/commands/preset.ts`
- Create: `tests/unit/preset-command.test.ts`

**Interfaces:**
- Consumes: `ProjectLpmConfig`（`../state/types.js` 的既有类型）
- Produces:
  ```ts
  export class PresetError extends Error {}
  export interface PresetView {
    raw: Record<string, unknown>                       // 原样保留（含损坏条目与未知字段）——读-改-写基线
    entries: Record<string, string[]>                  // 合法条目（空数组合法）
    corrupt: string[]                                  // 值不是「元素全为字符串的数组」
  }
  export function readPresets(cfg: ProjectLpmConfig | null): PresetView
  ```

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/preset-command.test.ts`：

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PresetError, readPresets } from '../../src/commands/preset.js'
import type { ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

describe('readPresets 守卫（spec §4.7）', () => {
  it('PRE-1：cfg=null / 无 presets → 空视图', () => {
    const empty = { raw: {}, entries: {}, corrupt: [] }
    expect(readPresets(null)).toEqual(empty)
    expect(readPresets({ version: 1, libs: {} })).toEqual(empty)
  })

  it('PRE-2：presets 为数组 / null / 标量 → 抛 PresetError（不吞）', () => {
    const mk = (p: unknown): ProjectLpmConfig => ({ version: 1, libs: {}, presets: p } as unknown as ProjectLpmConfig)
    expect(() => readPresets(mk([]))).toThrow(PresetError)
    expect(() => readPresets(mk(null))).toThrow(PresetError)
    expect(() => readPresets(mk(5))).toThrow(PresetError)
  })

  it('PRE-3：值非「字符串数组」→ 进 corrupt、不进 entries；raw 原样保留', () => {
    const cfg = { version: 1, libs: {}, presets: { good: ['@t/lib'], bad: 42, mixed: ['@t/a', 7], obj: { a: 1 } } } as unknown as ProjectLpmConfig
    const v = readPresets(cfg)
    expect(v.entries).toEqual({ good: ['@t/lib'] })
    expect([...v.corrupt].sort()).toEqual(['bad', 'mixed', 'obj'])
    expect(v.raw.bad).toBe(42)
    expect(v.raw.good).toEqual(['@t/lib'])
  })

  it('PRE-4：空数组属合法条目', () => {
    const cfg = { version: 1, libs: {}, presets: { empty: [] } } as unknown as ProjectLpmConfig
    expect(readPresets(cfg).entries).toEqual({ empty: [] })
    expect(readPresets(cfg).corrupt).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/commands/preset.js"`

- [ ] **Step 3: 写最小实现**

创建 `src/commands/preset.ts`：

```ts
import type { ProjectLpmConfig } from '../state/types.js'

/** 预设相关错误（命令域；沿用 S6/S7「错误类归命令文件」先例） */
export class PresetError extends Error {}

/** 预设表守卫后的视图（只读）：raw 供读-改-写，entries 只含合法条目，corrupt 记录脏条目名 */
export interface PresetView {
  raw: Record<string, unknown>
  entries: Record<string, string[]>
  corrupt: string[]
}

/**
 * 预设表读取守卫（spec §4.7）：
 * - cfg=null / presets 缺省 → 空视图
 * - presets 存在但非对象（数组 / null / 标量）→ **抛 PresetError（不吞）**
 * - 逐条目：值不是「元素全为字符串的数组」→ 进 corrupt（**不读其元素**）；否则进 entries
 * - raw 原样保留一切（含 corrupt 条目与未知字段），供保存/删除做读-改-写
 */
export function readPresets(cfg: ProjectLpmConfig | null): PresetView {
  if (cfg === null || cfg.presets === undefined) return { raw: {}, entries: {}, corrupt: [] }
  const rawPresets: unknown = cfg.presets
  if (typeof rawPresets !== 'object' || rawPresets === null || Array.isArray(rawPresets)) {
    throw new PresetError('lpm.config.json 的 presets 应为对象。可手工修正或删除该字段——lpm 状态可抛弃重建')
  }
  const raw = rawPresets as Record<string, unknown>
  const entries: Record<string, string[]> = {}
  const corrupt: string[] = []
  for (const name of Object.keys(raw)) {
    const v = raw[name]
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) entries[name] = v as string[]
    else corrupt.push(name)
  }
  return { raw, entries, corrupt }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: PASS —— 4 passed

- [ ] **Step 5: 单文件类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/preset"`
Expected: 无输出（零错误）

- [ ] **Step 6: 收尾核对（只读）**

Run: `git status --porcelain -uall`
Expected: `?? src/commands/preset.ts` + `?? tests/unit/preset-command.test.ts`（无其它面）

---

### Task 2: `lpm save`（+ cli 接线）

**Files:**
- Modify: `src/commands/preset.ts`（追加 import、`validatePresetName`、`reportError`、`runSave`）
- Modify: `src/cli.ts`（`save` 特判接线）
- Modify: `tests/unit/preset-command.test.ts`（追加 describe）
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 1 例）

**Interfaces:**
- Consumes: T1 的 `readPresets` / `PresetError`；既有 `findWorkspaceRoot`（`../core/workspace.js`）、`readProjectConfig` / `readState` / `writeProjectConfig`（`../state/index.js`）、`WorkspaceNotFoundError` / `LpmConfigParseError` / `LpmStateParseError`
- Produces:
  ```ts
  export async function runSave(name: string, cwd?: string): Promise<number>
  ```
  行为（spec §4.8）：① 名校验 → ② `findWorkspaceRoot` + `readProjectConfig`（缺失用 `{ version: 1, libs: {} }`）→ ③ `readState` 为空则报错 → ④ 撞名报错 → ⑤ `[...names].sort()` → ⑥ 读-改-写落盘 → ⑦ 打印 `已保存预设：<名>（N 项：a、b、c）` → ⑧ exit 0

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/preset-command.test.ts` 顶部把 fixture 补上（`import` 段下方），并追加 describe：

```ts
// ── 追加 import（与既有 import 行合并，勿分两次编辑同一个文件）──
import { runSave } from '../../src/commands/preset.js'
import { vi } from 'vitest'

// ── fixture ──
function makeProj(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-pre-'))
  dirs.push(dir)
  const base: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
  for (const [n, c] of Object.entries(base)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return dir
}
function entry(): Record<string, unknown> {
  return { original: { 'package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' }
}
function writeStateFile(dir: string, keys: string[]): void {
  const links: Record<string, unknown> = {}
  for (const k of keys) links[k] = entry()
  mkdirSync(join(dir, '.lpm'), { recursive: true })
  writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify({ version: 1, links }), 'utf8')
}
function cfgOf(dir: string): { libs: Record<string, string>; presets?: Record<string, string[]> } {
  return JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8'))
}
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('runSave（spec §4.8）', () => {
  it('SV-1：正常 → 名单 = state.links 的 keys 且按 .sort() 排序 + 打印', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/b', '@t/a'])
    const cap = captureOut()
    expect(await runSave('前端', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ 前端: ['@t/a', '@t/b'] })
    expect(cap.stdout()).toContain('已保存预设：前端（2 项：@t/a、@t/b）')
  })

  it('SV-2：无 state.json / links 为空 → 报错 exit 1，且不写 presets', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    const cap = captureOut()
    expect(await runSave('x', dir)).toBe(1)
    expect(cap.stderr()).toContain('当前没有任何已链接的库')
    expect(cfgOf(dir).presets).toBeUndefined()
  })

  it('SV-3：撞名 → 报错 + lpm.config.json byte 级不变', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { 前端: ['@t/a'] } }) })
    writeStateFile(dir, ['@t/b'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runSave('前端', dir)).toBe(1)
    expect(cap.stderr()).toContain('预设名已存在：前端')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('SV-4：名非法（空 / 全空白 / 含空格）→ 报错 exit 1', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    const cap = captureOut()
    for (const bad of ['', '   ', 'a b']) {
      expect(await runSave(bad, dir)).toBe(1)
    }
    expect(cap.stderr()).toContain('不能包含空白字符')
  })

  it('SV-5：读-改-写 —— 已有其它预设与损坏条目都保留', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { other: ['@t/x'], broken: 42 } }) })
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('新', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ other: ['@t/x'], broken: 42, 新: ['@t/a'] })
  })

  it('SV-6：无 lpm.config.json → 创建且 libs 为 {}', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('x', dir)).toBe(0)
    expect(cfgOf(dir)).toEqual({ version: 1, libs: {}, presets: { x: ['@t/a'] } })
  })

  it('SV-7：预设名含 CJK 能存', async () => {
    const dir = makeProj()
    writeStateFile(dir, ['@t/a'])
    expect(await runSave('中文预-设', dir)).toBe(0)
    expect(cfgOf(dir).presets?.['中文预-设']).toEqual(['@t/a'])
  })

  it('SV-8：state.links 的键不在 cfg.libs 也**照样存**（不静默丢数据；配对用例 = T4 的 LC-8 报错半边）', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/a', '@t/gone'])
    expect(await runSave('p', dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ p: ['@t/a', '@t/gone'] })   // 存原样；日后 `link --preset p` 会以「不在注册表」报错（LC-8）
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: FAIL —— `runSave is not a function`（或 import 解析失败）

- [ ] **Step 3: 写最小实现**

把 `src/commands/preset.ts` 的 import 段整体替换为：

```ts
import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  readProjectConfig,
  readState,
  writeProjectConfig,
} from '../state/index.js'
import type { ProjectLpmConfig } from '../state/types.js'
```

在文件末尾追加：

```ts
/** 预设名合法性（spec §4.7）：trim 后非空、且不含空白字符 */
function validatePresetName(name: string): void {
  if (name.trim() === '' || /\s/.test(name)) {
    throw new PresetError('预设名不能为空，且不能包含空白字符（示例：my-preset）')
  }
}

/** 命令级错误上报（与 link/unlink 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [PresetError, WorkspaceNotFoundError, LpmConfigParseError, LpmStateParseError]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

/** `lpm save <预设名>`：把当前链接集存为预设（spec §4.8）——纯直通，不弹菜单 */
export async function runSave(name: string, cwd: string = process.cwd()): Promise<number> {
  try {
    validatePresetName(name)
    const rootDir = await findWorkspaceRoot(cwd)
    const cfg: ProjectLpmConfig = (await readProjectConfig(rootDir)) ?? { version: 1, libs: {} }
    const view = readPresets(cfg)
    const st = await readState(rootDir)
    const names = Object.keys(st?.links ?? {})
    if (names.length === 0) {
      throw new PresetError('当前没有任何已链接的库，无法存为预设。先 lpm link <名字|路径>')
    }
    if (Object.hasOwn(view.raw, name)) {
      throw new PresetError(`预设名已存在：${name}。先 lpm preset rm ${name} 删除，或换一个名字`)
    }
    const sorted = [...names].sort()
    await writeProjectConfig(rootDir, { ...cfg, presets: { ...view.raw, [name]: sorted } as Record<string, string[]> })
    process.stdout.write(`已保存预设：${name}（${sorted.length} 项：${sorted.join('、')}）\n`)
    return 0
  } catch (err) {
    return reportError(err)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: PASS —— 12 passed（4 + 8）

- [ ] **Step 5: cli 接线**

在 `src/cli.ts` 的 import 段追加（与既有 import 合并成一次编辑；`runPreset` 的 import 由 T3 自己加）：

```ts
import { runSave } from './commands/preset.js'
```

在 `buildProgram()` 的 for 循环里，`repair` 的 `continue` 之后、`program.command(meta.name)` 兜底之前插入：

```ts
    // S10：save 直通接线（description 不带计划后缀）
    if (meta.name === 'save') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('<预设名>', '预设名')
        .allowExcessArguments(false)
        .action(async (name: string) => {
          process.exitCode = await runSave(name)
        })
      continue
    }
```

（把 `import { runSave } …` 写成与既有 `./commands/*.js` import 相邻的一行即可。）

- [ ] **Step 6: 追加 e2e 用例**

在 `tests/e2e/cli.e2e.test.ts` 末尾追加：

```ts
// S10：`lpm save` 错误路径（需要 workspace fixture——`findWorkspaceRoot` 在裸目录会先报错）
describe('lpm save e2e（S10）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-save-'))
    made.push(dir)
    const full: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) writeFileSync(join(dir, name), content, 'utf8')
    return dir
  }
  afterEach(() => { while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true }) })

  it('E2E-S10-5：save 无已链接 → exit 1 + 提示', async () => {
    const dir = makeProject()
    const r = await runCli(['save', 'x'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('当前没有任何已链接的库')
  })
})
```

- [ ] **Step 7: 单文件类型检查 + 收尾核对**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/preset|src/cli"`
Expected: 无输出

Run: `git status --porcelain -uall`
Expected: ` M src/cli.ts`、` M tests/e2e/cli.e2e.test.ts`、` M src/commands/preset.ts`（T1 的 untracked 变 modified 视 T1 是否已入库，按实际记录）、` M tests/unit/preset-command.test.ts`

---

### Task 3: `lpm preset`（分派 + `rm` 直通 + 无参数交互菜单 + cli 接线）

**Files:**
- Modify: `src/commands/preset.ts`（追加 `runPreset` / `runPresetRm` / `runPresetInteractive`）
- Modify: `src/cli.ts`（`preset` 特判接线）
- Modify: `tests/unit/preset-command.test.ts`（追加 describe + clack mock）
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 1 例）

**Interfaces:**
- Consumes: T1 的 `readPresets` / `PresetError`、T2 的 `reportError` / `validatePresetName`（`rm` 不做名校验——名字是查表用的，非法名自然落到「不存在」分支）
- Produces:
  ```ts
  export async function runPreset(args: readonly string[], cwd?: string): Promise<number>
  ```
  分派（spec §4.9）：`[]` → 交互菜单；`['rm', 名]` → 直通删除；其它 → 用法错误 exit 1

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/preset-command.test.ts` 顶部补 clack mock（**必须放在所有 `import ... from '../../src/...'` 之前**，与既有 import 段一起改）：

```ts
import { beforeEach, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), confirm: vi.fn(), isCancel: vi.fn(() => false),
}))
```

并在 import 段追加：

```ts
import { multiselect, confirm, isCancel } from '@clack/prompts'
import { runPreset } from '../../src/commands/preset.js'
```

在文件末尾追加：

```ts
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

describe('lpm preset rm（直通，spec §4.9）', () => {
  it('PR-1：正常 → 该键消失、其它键保留', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'], b: ['@t/b'] } }) })
    const cap = captureOut()
    expect(await runPreset(['rm', 'a'], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ b: ['@t/b'] })
    expect(cap.stdout()).toContain('已删除预设：a')
  })

  it('PR-2：删最后一个 → presets 字段整体移除', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    expect(await runPreset(['rm', 'a'], dir)).toBe(0)
    expect('presets' in cfgOf(dir)).toBe(false)
    expect(cfgOf(dir).libs).toEqual({})
  })

  it('PR-3：名不存在 → 报错 + 列出可用预设', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'], b: ['@t/b'] } }) })
    const cap = captureOut()
    expect(await runPreset(['rm', 'nope'], dir)).toBe(1)
    expect(cap.stderr()).toContain('预设不存在：nope')
    expect(cap.stderr()).toContain('a、b')
  })

  it('PR-4：没有 lpm.config.json → 报错（不崩）', async () => {
    const dir = makeProj()
    const cap = captureOut()
    expect(await runPreset(['rm', 'a'], dir)).toBe(1)
    expect(cap.stderr()).toContain('没有 lpm.config.json')
  })

  it('PR-5：删损坏条目 → 成功（修复路径）', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { broken: 42, ok: ['@t/a'] } }) })
    expect(await runPreset(['rm', 'broken'], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ ok: ['@t/a'] })
  })

  it('PR-6：子命令非法 / rm 缺名 / 多余参数 → 用法错误 exit 1', async () => {
    const dir = makeProj()
    const cap = captureOut()
    for (const args of [['foo'], ['rm'], ['rm', 'a', 'b'], ['rm', 'a', 'b', 'c']]) {
      expect(await runPreset(args, dir)).toBe(1)
    }
    expect(cap.stderr()).toContain('用法：lpm preset')
  })
})

describe('lpm preset（无参数交互菜单，spec §4.9）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isCancel).mockReturnValue(false)
  })

  it('PR-7：非 TTY → 一行提示 + exit 1 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(false)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('当前不是交互终端；直通用法：lpm preset rm <名>')
    expect(multiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('PR-8：无任何预设 → 告知 + exit 0 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    stubTty(true)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    expect(cap.stdout()).toContain('还没有任何预设')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('PR-9：多选删除 → 二次确认 → 文件更新 + 逐行提示', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a', '@t/b'], b: ['@t/c'], c: ['@t/d'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['a', 'b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    expect(cfgOf(dir).presets).toEqual({ c: ['@t/d'] })
    expect(cap.stdout()).toContain('已删除预设：a')
    expect(cap.stdout()).toContain('已删除预设：b')
    // 选项 label 内联名单（spec §8 自决 6）
    const opts = (vi.mocked(multiselect).mock.calls[0]![0] as { options: Array<{ label: string }> }).options
    expect(opts.map((o) => o.label)).toContain('a（2 项：@t/a、@t/b）')
  })

  it('PR-10：空选中 → 未选择任何预设 + exit 1 + 文件不变', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('未选择任何预设')
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('PR-11：答否 → 已取消 + exit 1 + byte 级零写盘', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('PR-12：isCancel → 已取消 + exit 1', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce('__cancel__' as never)
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(1)
    expect(cap.stdout()).toContain('已取消')
  })

  it('PR-13：损坏条目 label 含 [损坏] 且可被选中删除', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { broken: 42, ok: ['@t/a'] } }) })
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['broken'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    expect(await runPreset([], dir)).toBe(0)
    const opts = (vi.mocked(multiselect).mock.calls[0]![0] as { options: Array<{ value: string; label: string }> }).options
    expect(opts.find((o) => o.value === 'broken')?.label).toContain('[损坏]')
    expect(cfgOf(dir).presets).toEqual({ ok: ['@t/a'] })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: FAIL —— `runPreset is not a function`

- [ ] **Step 3: 写实现**

在 `src/commands/preset.ts` 的 import 段追加（与既有 import 合并成一次编辑）：

```ts
import * as clack from '@clack/prompts'
```

文件末尾追加：

```ts
/** `lpm preset rm <名>`：按名删除（spec §4.9）——损坏条目也可删（这是修好脏配置的唯一入口） */
async function runPresetRm(name: string, cwd: string): Promise<number> {
  const rootDir = await findWorkspaceRoot(cwd)
  const cfg = await readProjectConfig(rootDir)
  if (cfg === null) {
    throw new PresetError('没有 lpm.config.json，没有任何预设（该文件进 git，可由版本库恢复）')
  }
  const view = readPresets(cfg)
  if (!Object.hasOwn(view.raw, name)) {
    const avail = Object.keys(view.raw)
    throw new PresetError(
      avail.length === 0
        ? `预设不存在：${name}。当前没有任何预设`
        : `预设不存在：${name}。可用预设：${avail.join('、')}`,
    )
  }
  const next: Record<string, unknown> = { ...view.raw }
  delete next[name]
  const nextCfg: ProjectLpmConfig = { ...cfg }
  if (Object.keys(next).length === 0) delete nextCfg.presets
  else nextCfg.presets = next as Record<string, string[]>
  await writeProjectConfig(rootDir, nextCfg)
  process.stdout.write(`已删除预设：${name}\n`)
  return 0
}

/** `lpm preset`（无参数）：列表管理「看 + 多选删除」（spec §4.9） */
async function runPresetInteractive(cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write('当前不是交互终端；直通用法：lpm preset rm <名>\n')
    return 1
  }
  const rootDir = await findWorkspaceRoot(cwd)
  const cfg = (await readProjectConfig(rootDir)) ?? { version: 1, libs: {} }
  const view = readPresets(cfg)
  const names = [...Object.keys(view.entries), ...view.corrupt]
  if (names.length === 0) {
    process.stdout.write('还没有任何预设。用 lpm save <名字> 把当前链接集存下来\n')
    return 0
  }
  const options = names.map((n) =>
    Object.hasOwn(view.entries, n)
      ? { value: n, label: `${n}（${view.entries[n]!.length} 项：${view.entries[n]!.join('、')}）` }
      : { value: n, label: `${n}  [损坏]`, hint: '内容不是字符串数组——删除可修复' },
  )
  const picked = await clack.multiselect({ message: '选择要删除的预设（空格勾选，回车确认）', options })
  if (clack.isCancel(picked)) { process.stdout.write('已取消\n'); return 1 }
  const chosen = picked as string[]
  if (chosen.length === 0) { process.stdout.write('未选择任何预设\n'); return 1 }
  const ok = await clack.confirm({
    message: `删除这 ${chosen.length} 个预设？（删除后需重新 lpm save 才能恢复）`,
    initialValue: false,
  })
  if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
  const next: Record<string, unknown> = { ...view.raw }
  for (const n of chosen) delete next[n]
  const nextCfg: ProjectLpmConfig = { ...cfg }
  if (Object.keys(next).length === 0) delete nextCfg.presets
  else nextCfg.presets = next as Record<string, string[]>
  await writeProjectConfig(rootDir, nextCfg)
  for (const n of chosen) process.stdout.write(`已删除预设：${n}\n`)
  return 0
}

/** `lpm preset` 入口（spec §4.9 的参数分派）：[] → 交互；['rm', 名] → 直通删除；其它 → 用法错误 */
export async function runPreset(args: readonly string[], cwd: string = process.cwd()): Promise<number> {
  try {
    if (args.length === 0) return await runPresetInteractive(cwd)
    if (args[0] === 'rm' && args.length === 2) return await runPresetRm(args[1] as string, cwd)
    throw new PresetError('用法：lpm preset（列表管理）/ lpm preset rm <名>')
  } catch (err) {
    return reportError(err)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: PASS —— 25 passed（12 + 13）

- [ ] **Step 5: cli 接线**

在 `src/cli.ts` 的 import 段把 T2 那行扩为（与 T2 的 `runSave` 同一行，勿新增第二行 import）：

```ts
import { runPreset, runSave } from './commands/preset.js'
```

在 `save` 分支之后插入：

```ts
    // S10：preset 接线（无参数 → 交互列表管理；rm <名> → 直通删除）
    if (meta.name === 'preset') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'rm <名>')
        .action(async (args: string[]) => {
          process.exitCode = await runPreset(args)
        })
      continue
    }
```

- [ ] **Step 6: 追加 e2e 用例**

在 `tests/e2e/cli.e2e.test.ts` 的 S10 describe 内追加：

```ts
  it('E2E-S10-4：preset 非 TTY → exit 1 + 提示 + 无菜单残片', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/a'] } }) })
    const r = await runCli(['preset'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm preset rm <名>')
    expect(r.stdout).not.toContain('已删除预设')
  })
```

- [ ] **Step 7: 单文件类型检查 + 收尾核对**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/preset|src/cli"`
Expected: 无输出

Run: `git status --porcelain -uall`
Expected: 改动面仍只有 `src/cli.ts`、`src/commands/preset.ts`、两个测试文件

---

### Task 4: `link` 集合级直通（`--last` / `--all` / `--preset`）

**Files:**
- Modify: `src/commands/link.ts`（`LinkOptions` 追加 3 字段；`reportError` KNOWN 追加 `PresetError`；新增内部 `resolveLinkCollection`；`runLink` 加参数校验与集合级分支）
- Modify: `src/cli.ts`（link 加 3 个 option）
- Create: `tests/unit/link-collection.test.ts`
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 3 例）

**Interfaces:**
- Consumes: T1 的 `readPresets` / `PresetError`；既有 `readLast`（`../state/index.js`）、`LinkArgumentError`、`linkPreflight`、`readState`、`buildLinkPlan`、`linkPlanView`、`renderPlan`、`executeLinkPlan`
- Produces（对外）:
  ```ts
  export interface LinkOptions {
    watch?: boolean; dryRun?: boolean
    last?: boolean; all?: boolean; preset?: string
  }
  ```
  （内部）`async function resolveLinkCollection(opts: LinkOptions, cfg: ProjectLpmConfig | null, rootDir: string): Promise<{ names: string[]; source: 'last' | 'all' | 'preset' }>`

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/link-collection.test.ts`：

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(), groupMultiselect: vi.fn(), multiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { runLink } from '../../src/commands/link.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeLib(name: string): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lc-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name, main: './index.js' }), 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
}

/** ws + N 个真实 lib：全部已注册（cfg.libs）且被 apps/web 声明 */
function setup(shortNames: string[] = ['a', 'b']): { ws: string; paths: Record<string, string> } {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-lc-'))
  dirs.push(ws)
  const deps: Record<string, string> = {}
  const libs: Record<string, string> = {}
  const paths: Record<string, string> = {}
  for (const s of shortNames) {
    const key = `@t/${s}`
    const lib = makeLib(key)
    deps[key] = '^1.0.0'
    libs[key] = relative(ws, lib).replaceAll('\\', '/')
    paths[key] = lib
  }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: deps }),
  }
  for (const [n, c] of Object.entries(files)) {
    const p = join(ws, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  return { ws, paths }
}
function writeCfg(ws: string, cfg: Record<string, unknown>): void {
  writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify(cfg), 'utf8')
}
function writeLastFile(ws: string, names: unknown[]): void {
  mkdirSync(join(ws, '.lpm'), { recursive: true })
  writeFileSync(join(ws, '.lpm', 'last.json'), JSON.stringify({ version: 1, names }), 'utf8')
}
function depsOf(ws: string): Record<string, string> {
  return JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies
}
function cfgOf(ws: string): { libs: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8'))
}
/** 项目 byte 级快照（cfg + manifest）——用于「零写盘」断言 */
function snapshot(ws: string): string {
  return ['lpm.config.json', 'apps/web/package.json'].map((f) => readFileSync(join(ws, f), 'utf8')).join('\u0000')
}
function captureOut(): { stdout: () => string; stderr: () => string } {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

describe('link 集合级直通（spec §4.4 / §4.5）', () => {
  it('LC-1：--all 展开全部已注册 → 全部替换为 link: + install 恰一次', async () => {
    const { ws } = setup(['a', 'b'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(0)
    const deps = depsOf(ws)
    expect(deps['@t/a']).toContain('link:')
    expect(deps['@t/b']).toContain('link:')
    expect(execa).toHaveBeenCalledTimes(1)
  })

  it('LC-2：--last 展开 last.json 的 names', async () => {
    const { ws } = setup(['a', 'b'])
    writeLastFile(ws, ['@t/b'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(0)
    const deps = depsOf(ws)
    expect(deps['@t/b']).toContain('link:')
    expect(deps['@t/a']).toBe('^1.0.0')
  })

  it('LC-3：--preset 正常展开', async () => {
    const { ws } = setup(['a', 'b'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { 前端: ['@t/a'] } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { preset: '前端' }, ws)).toBe(0)
    expect(depsOf(ws)['@t/a']).toContain('link:')
    expect(depsOf(ws)['@t/b']).toBe('^1.0.0')
  })

  it('LC-4：--last 无记录 / names 为空 → 报错 exit 1 + 零写盘，且提示不含 lpm save', async () => {
    for (const withFile of [false, true]) {
      const { ws } = setup(['a'])
      if (withFile) writeLastFile(ws, [])
      const before = snapshot(ws)
      const cap = captureOut()
      expect(await runLink([], { last: true }, ws)).toBe(1)
      expect(cap.stderr()).toContain('没有上次链接的记录')
      expect(cap.stderr()).not.toContain('lpm save')
      expect(snapshot(ws)).toBe(before)
      expect(execa).not.toHaveBeenCalled()
    }
  })

  it('LC-5：--all 无已注册 → 报错 exit 1', async () => {
    const { ws } = setup([])
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('当前没有任何已注册的 lib')
  })

  it('LC-6：--preset 不存在 → 报错 + 列出可用预设', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { 前端: ['@t/a'], 后端: ['@t/b'] } })
    const cap = captureOut()
    expect(await runLink([], { preset: 'nope' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('预设不存在：nope')
    expect(cap.stderr()).toContain('前端、后端')
  })

  it('LC-7：--preset 损坏 / 空数组 → 报错 exit 1', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { bad: 42, empty: [] } })
    const cap = captureOut()
    expect(await runLink([], { preset: 'bad' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('内容损坏')
    expect(await runLink([], { preset: 'empty' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('是空的')
  })

  it('LC-8：失效名字（2 失效 + 1 正常）→ 一次性列出 + byte 级零变化 + 零子进程', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { p: ['@t/a', '@t/gone1', '@t/gone2'] } })
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { preset: 'p' }, ws)).toBe(1)
    expect(cap.stderr()).toContain('@t/gone1')
    expect(cap.stderr()).toContain('@t/gone2')
    expect(cap.stderr()).toContain('lpm preset rm p')
    expect(snapshot(ws)).toBe(before)          // 一个都不链、且任何写盘之前中止
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-9：注册值损坏 → 展开期报错 exit 1 + 零写盘', async () => {
    const { ws } = setup(['a'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: { ...cfgOf(ws).libs, '@t/bad': 42 } })
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('注册值损坏')
    expect(snapshot(ws)).toBe(before)
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-10：互斥与参数校验 → 各自 exit 1 + 零写盘零子进程', async () => {
    const { ws } = setup(['a'])
    const cases: Array<{ targets: string[]; opts: Record<string, unknown> }> = [
      { targets: [], opts: { last: true, all: true } },
      { targets: [], opts: { all: true, preset: 'p' } },
      { targets: ['@t/a'], opts: { all: true } },
      { targets: [], opts: { preset: '' } },
    ]
    for (const c of cases) {
      const before = snapshot(ws)
      const cap = captureOut()
      expect(await runLink(c.targets, c.opts, ws)).toBe(1)
      expect(cap.stderr()).toMatch(/互斥|不能与|需要一个预设名/)
      expect(snapshot(ws)).toBe(before)
      expect(execa).not.toHaveBeenCalled()
    }
  })

  it('LC-11：--all --dry-run → 首行逐字 + 零写盘零子进程', async () => {
    const { ws } = setup(['a'])
    const before = snapshot(ws)
    const cap = captureOut()
    expect(await runLink([], { all: true, dryRun: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(snapshot(ws)).toBe(before)
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-12：--all --watch → watch 行出现', async () => {
    const { ws } = setup(['a'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], { all: true, watch: true, dryRun: true }, ws)).toBe(0)
    expect(cap.stdout()).toContain('watch：')
  })

  it('LC-13：--last 的 names 含非字符串 → 报错指出该元素、不崩', async () => {
    const { ws } = setup(['a'])
    writeLastFile(ws, ['@t/a', 7])
    const cap = captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('7')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-collection.test.ts`
Expected: FAIL —— LC-1 起全部失败（`--all` 目前当位置参数之外的东西被忽略 → 走 `targets.length === 0` 的交互分支，非 TTY 下 exit 1）

- [ ] **Step 3: 改 `LinkOptions` 与 `reportError`**

`src/commands/link.ts`：

把 `export interface LinkOptions { watch?: boolean; dryRun?: boolean }` 替换为：

```ts
export interface LinkOptions {
  watch?: boolean
  dryRun?: boolean
  /** S10：链接 last.json 记录的集合（与 all / preset 三者互斥，且不与位置参数同用） */
  last?: boolean
  /** S10：链接全部已注册的 lib（`Object.keys(cfg.libs)`） */
  all?: boolean
  /** S10：链接指定预设；空串等同非法（spec §4.5） */
  preset?: string
}
```

import 段追加（与既有 import 合并成一次编辑）：

```ts
// 在 '../state/index.js' 的具名导入里追加 readLast
// 新增两行：
import { PresetError, readPresets } from './preset.js'
```

`reportError` 的 `KNOWN` 数组里追加 `PresetError`：

```ts
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkTargetError,
    ProtocolPathError, InstallError, PresetError,
```

- [ ] **Step 4: 加 `resolveLinkCollection` 与 `runLink` 的校验/分支**

在 `src/commands/link.ts` 的 `buildLinkPlan` **之前**插入：

```ts
/** S10 集合来源解析（spec §4.4）：展开 + 两类预检（名字在注册表？注册值是字符串？）——都在任何写盘之前 */
async function resolveLinkCollection(
  opts: LinkOptions, cfg: ProjectLpmConfig | null, rootDir: string,
): Promise<{ names: string[]; source: 'last' | 'all' | 'preset' }> {
  const libs: Record<string, unknown> = cfg?.libs ?? {}
  let names: readonly unknown[]
  let source: 'last' | 'all' | 'preset'
  if (opts.all === true) {
    names = Object.keys(libs)
    source = 'all'
    if (names.length === 0) {
      // R4-1：LinkArgumentError 构造器 (target, message) 是 S6 §4.3 冻结面——target 传 ''（src/ 无 .target 消费者）
      throw new LinkArgumentError('', '当前没有任何已注册的 lib。先 lpm link <路径> 注册')
    }
  } else if (opts.last === true) {
    const last = await readLast(rootDir)
    names = last?.names ?? []
    source = 'last'
    if (names.length === 0) {
      throw new LinkArgumentError('', '没有上次链接的记录。先做一次批量 link（一次给 ≥ 2 个目标、或 --all / --preset）建立记录')
    }
  } else {
    const name = opts.preset as string
    const view = readPresets(cfg)
    if (view.corrupt.includes(name)) {
      throw new LinkArgumentError('', `预设 ${name} 内容损坏（应为字符串数组）。可 lpm preset rm ${name} 删除后重存`)
    }
    if (!Object.hasOwn(view.raw, name)) {
      const avail = Object.keys(view.raw)
      throw new LinkArgumentError('', avail.length === 0
        ? `预设不存在：${name}。当前没有任何预设。先 lpm save <名字>`
        : `预设不存在：${name}。可用预设：${avail.join('、')}`)
    }
    names = view.entries[name] ?? []
    source = 'preset'
    if (names.length === 0) {
      throw new LinkArgumentError('', `预设 ${name} 是空的。先 lpm save ${name} 写入内容`)
    }
  }
  const missing: string[] = []
  const corrupt: string[] = []
  for (const n of names) {
    const key = String(n)
    if (!Object.hasOwn(libs, key)) missing.push(key)
    else if (typeof libs[key] !== 'string') corrupt.push(key)
  }
  if (missing.length > 0 || corrupt.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`${missing.length} 个名字已不在注册表：${missing.join('、')}`)
    if (corrupt.length > 0) parts.push(`${corrupt.length} 个名字的注册值损坏（应为字符串）：${corrupt.join('、')}`)
    const where = source === 'preset' ? `预设 ${opts.preset}` : source === 'last' ? '上次链接的记录' : '--all 的注册表'
    const hints = source === 'preset'
      ? `\n  用路径重新注册：lpm link <lib 路径>\n  或修掉这个预设：lpm preset rm ${opts.preset} 后重新 lpm save ${opts.preset}`
      : '\n  用路径重新注册：lpm link <lib 路径>'
    throw new LinkArgumentError('', `${where}里有${parts.join('；')}。${hints}`)
  }
  return { names: names.map((n) => String(n)), source }
}
```

把 `runLink` 的开头（`// A1 无参数 → S9 交互入口…` 那一行之前）改为：

```ts
export async function runLink(targets: readonly string[], opts: LinkOptions, cwd: string = process.cwd()): Promise<number> {
  // S10 参数校验（spec §4.5）：顺序 = 三者互斥 → 与位置参数互斥 → 名为空；全部早于任何读盘
  const switchCount = [opts.last === true, opts.all === true, opts.preset !== undefined].filter(Boolean).length
  if (switchCount > 1) {
    return reportError(new LinkArgumentError('', '--last / --all / --preset 三者互斥，请只用一个。用法：lpm link --last | --all | --preset <名>'))
  }
  const hasSwitch = switchCount === 1
  if (targets.length > 0 && hasSwitch) {
    return reportError(new LinkArgumentError('', '--last / --all / --preset 不能与 <名字|路径> 同时使用；要链接指定目标请直接给名字或路径'))
  }
  if (typeof opts.preset === 'string' && opts.preset.trim() === '') {
    return reportError(new LinkArgumentError('', '--preset 需要一个预设名（用法：lpm link --preset <名>）'))
  }
  // A1 无参数（且无集合开关）→ S9 交互入口（非 TTY 由入口内部拒绝，绝不进菜单）
  if (targets.length === 0 && !hasSwitch) return await runLinkInteractive(opts, cwd)
```

并在 `runLink` 的 `try` 块里，把 `const plan = await buildLinkPlan({...})` 这一行**之前**插入展开，并让 targets 用展开结果：

```ts
    const st = await readState(rootDir)
    const effectiveTargets = hasSwitch ? (await resolveLinkCollection(opts, cfg, rootDir)).names : targets
    const plan = await buildLinkPlan({ targets: effectiveTargets, opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-collection.test.ts`
Expected: PASS —— 13 passed

- [ ] **Step 6: cli 加 3 个 option**

`src/cli.ts` 的 `link` 分支里，在 `.option('--dry-run', …)` 之后追加：

```ts
        .option('--last', '链接 last.json 记录的那一批')
        .option('--all', '链接全部已注册的 lib')
        .option('--preset <名>', '链接指定预设')
```

并把该分支的 action 类型扩为：

```ts
        .action(async (targets: string[], options: { watch?: boolean; dryRun?: boolean; last?: boolean; all?: boolean; preset?: string }) => {
          process.exitCode = await runLink(targets, options)
        })
```

- [ ] **Step 7: 追加 e2e**

在 `tests/e2e/cli.e2e.test.ts` 的 S10 describe 内追加：

```ts
  it('E2E-S10-1：link --last 无记录 → exit 1 + 提示（且不含 lpm save 字样）', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--last'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('没有上次链接的记录')
    expect(r.stderr).not.toContain('lpm save')
  })

  it('E2E-S10-2：link --preset nope → exit 1 + 提示', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--preset', 'nope'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('预设不存在：nope')
  })

  it('E2E-S10-3：link --all --last → exit 1 + 互斥提示', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    const r = await runCli(['link', '--all', '--last'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('三者互斥')
  })
```

> e2e 的 `makeProject` 需要 `pnpm-workspace.yaml` 或单包 `package.json`（`findWorkspaceRoot` 单包 fallback）——上面用单包即可。

- [ ] **Step 8: 回归检查（直通未变）**

Run: `npx vitest run tests/unit/link-command.test.ts tests/unit/link-interactive.test.ts tests/unit/unlink-command.test.ts`
Expected: `link-command` 39 passed / `link-interactive` 18 passed / `unlink-command` 35 passed（**零改动**；若有用例红，先查是否动了直通路径）

- [ ] **Step 9: 收尾核对（只读）**

Run: `git status --porcelain -uall`
Expected: ` M src/commands/link.ts`、` M src/cli.ts`、` M tests/e2e/cli.e2e.test.ts`、`?? tests/unit/link-collection.test.ts`（+ T1–T3 的面）

---

### Task 5: last.json 刷新口径（`forceLastWrite` 两处落点）

**Files:**
- Modify: `src/commands/link.ts`（`LinkPlan` 加字段；`buildLinkPlan` 接收 `forceLastWrite`；`executeLinkPlan` 判定改动；`runLink` 集合级空计划出口补写；集合级调用传参）
- Modify: `tests/unit/link-collection.test.ts`（追加 LC-14…LC-18）

**Interfaces:**
- Consumes: T4 的 `hasSwitch` 与集合级分支
- Produces: 无新导出；`buildLinkPlan` 的内部参数 `forceLastWrite?: boolean`

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/link-collection.test.ts` 末尾追加：

```ts
function stateKeys(ws: string): string[] | null {
  const p = join(ws, '.lpm', 'state.json')
  if (!existsSync(p)) return null
  return Object.keys(JSON.parse(readFileSync(p, 'utf8')).links)
}
function stateOf(ws: string): { links: Record<string, { original: Record<string, string> }> } {
  return JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8'))
}
function lastNames(ws: string): string[] | null {
  const p = join(ws, '.lpm', 'last.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')).names
}

describe('last.json 刷新口径（spec §4.6）', () => {
  it('LC-14：集合级操作展开后仅 1 个名字 → 也刷新 last（forceLastWrite）', async () => {
    const { ws } = setup(['a', 'b'])
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: cfgOf(ws).libs, presets: { solo: ['@t/a'] } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { preset: 'solo' }, ws)).toBe(0)
    expect(lastNames(ws)).toEqual(['@t/a'])
  })

  it('LC-15：集合级操作全部命中「已链接、跳过」→ 仍把 last 对齐到当前全集', async () => {
    const { ws } = setup(['a', 'b'])
    // 先手动造出：state 已有 @t/a 与 @t/b（全已链接），而 last 只记了 @t/a
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(join(ws, '.lpm', 'state.json'), JSON.stringify({ version: 1, links: {
      '@t/a': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      '@t/b': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
    } }), 'utf8')
    writeLastFile(ws, ['@t/a'])
    captureOut()
    expect(await runLink([], { last: true }, ws)).toBe(0)   // 展开 [@t/a]，已链接 → 计划为空
    expect(execa).not.toHaveBeenCalled()                    // 确实全跳过
    expect([...(lastNames(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b'])
  })

  it('LC-16：非预检类的中途失败（零命中依赖）→ LinkTargetError 整批停，且此前合法项的 upsert 已落盘', async () => {
    const { ws } = setup(['a'])                             // 只有 @t/a 被 apps/web 声明
    const orphan = makeLib('@t/orphan')                     // 注册了但无人依赖
    writeCfg(ws, { version: 1, packageManager: 'pnpm', libs: { ...cfgOf(ws).libs, '@t/orphan': relative(ws, orphan).replaceAll('\\', '/') } })
    const cap = captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(1)
    expect(cap.stderr()).toContain('不在任何成员依赖中')
    expect(cfgOf(ws).libs['@t/orphan']).toBeDefined()      // 与 S6 直通同口径：不回滚
    expect(execa).not.toHaveBeenCalled()
  })

  it('LC-17：PRD §13 验收 5 闭环 —— link --all → unlink --all → link --last', async () => {
    const { ws } = setup(['a', 'b', 'c'])
    const beforeLink = { ...depsOf(ws) }                          // 最初声明值
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], { all: true }, ws)).toBe(0)
    expect([...(stateKeys(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    expect([...(lastNames(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    const orig1 = stateOf(ws).links['@t/a']!.original              // 第一轮落档的 original
    expect(await runUnlink([], { all: true }, ws)).toBe(0)
    expect(stateKeys(ws)).toBeNull()
    expect(depsOf(ws)).toEqual(beforeLink)                         // 验收 3：声明恢复原样
    expect(await runLink([], { last: true }, ws)).toBe(0)
    expect([...(stateKeys(ws) ?? [])].sort()).toEqual(['@t/a', '@t/b', '@t/c'])
    expect(stateOf(ws).links['@t/a']!.original).toEqual(orig1)      // 验收 5：original 逐文件精确还原
  })

  it('LC-18：直通回归钉 —— `link <A> <B>` 全已链接仍不写 last；`link <A>` 单个不写', async () => {
    const { ws, paths } = setup(['a', 'b'])
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(join(ws, '.lpm', 'state.json'), JSON.stringify({ version: 1, links: {
      '@t/a': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      '@t/b': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
    } }), 'utf8')
    captureOut()
    expect(await runLink([paths['@t/a']!, paths['@t/b']!], {}, ws)).toBe(0)
    expect(lastNames(ws)).toBeNull()

    const solo = setup(['a'])
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    expect(await runLink([solo.paths['@t/a']!], {}, solo.ws)).toBe(0)
    expect(lastNames(solo.ws)).toBeNull()
  })
})
```

并在该测试文件顶部补 `existsSync` 与 `runUnlink` 的 import：

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runUnlink } from '../../src/commands/unlink.js'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-collection.test.ts -t "LC-14"`
Expected: FAIL —— LC-14 `lastNames(...)` 为 `null`（单个 target 不写 last）

- [ ] **Step 3: 写实现**

`src/commands/link.ts`，`LinkPlan` 接口里 `deferredRegistration` 之后追加：

```ts
  /** S10：集合级操作（--last / --all / --preset）为 true → last 刷新不受「target 数 ≥ 2」限制 */
  forceLastWrite: boolean
```

`buildLinkPlan` 的入参类型里 `deferRegistration?: boolean` 之后追加：

```ts
  /** S10：集合级操作为 true（spec §4.6 表 #1/#3） */
  forceLastWrite?: boolean
```

`buildLinkPlan` 的返回对象里 `deferredRegistration: args.deferRegistration === true` 之后追加：

```ts
    , forceLastWrite: args.forceLastWrite === true
```

（保持对象字面量格式与既有风格一致——把该行并入 `deferredRegistration` 那一行即可：
`deferredRegistration: args.deferRegistration === true, forceLastWrite: args.forceLastWrite === true,`）

`executeLinkPlan` 的 last 段（`// I last（targets ≥ 2 且至少成功 1 个）` 那一处）改为：

```ts
  // I last（S10：集合级操作一律刷新；直通沿用「targets ≥ 2 且至少成功 1 个」）
  if ((plan.forceLastWrite || targets.length >= 2) && linkedTargets.length >= 1) {
```

`runLink` 里，`buildLinkPlan({ targets: effectiveTargets, ... })` 的参数对象追加：

```ts
      traceChanges, traceInstalls, forceLastWrite: hasSwitch,
```

`runLink` 的空计划出口改为：

```ts
    if (plan.aggregated.size === 0) {
      if (opts.dryRun === true) {
        process.stdout.write('无待执行变更\n') // spec §4.4 K3：计划体为空 + 「无待执行变更」
      } else if (hasSwitch) {
        // S10 表 #2（spec §4.6 实现落点 2）：集合级操作即使全跳过，也把 last 对齐到当前 links 全集
        try {
          const fresh = await readState(rootDir)
          await writeLast(rootDir, { version: 1, names: Object.keys(fresh?.links ?? {}) })
        } catch {
          process.stderr.write('警告：last.json 写入失败（不影响链接）\n')
        }
      }
      return 0
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-collection.test.ts`
Expected: PASS —— 18 passed

- [ ] **Step 5: 直通回归（关键）**

Run: `npx vitest run tests/unit/link-command.test.ts tests/unit/unlink-command.test.ts`
Expected: 39 passed / 35 passed（`T4-15 全跳过不写 last`、`T4-23b 单个不写` 必须绿——说明本改动**只在集合级分支**生效）

- [ ] **Step 6: 收尾核对（只读）**

Run: `git status --porcelain -uall`
Expected: ` M src/commands/link.ts`、` M tests/unit/link-collection.test.ts`（无新增面）

---

### Task 6: link 主列表虚拟项（「快捷」组）

**Files:**
- Modify: `src/commands/link.ts`（哨兵常量、`pickLinkTargets` 签名与「快捷」组、`runPlanAndExecute` 加 `collectionLevel`、`runLinkInteractive` 读 `readLast` 并传参）
- Modify: `tests/unit/link-interactive.test.ts`（追加 VI-* describe + `readLast` 相关 fixture）

**Interfaces:**
- Consumes: T5 的 `forceLastWrite` 参数；既有 `collectLinkCandidates`（**不改签名/返回**）、`readLast`
- Produces（内部，不导出）:
  ```ts
  async function pickLinkTargets(
    cand: { registered: LinkCandidate[]; discovered: DiscoveredLib[] },
    lastNames: readonly string[],
  ): Promise<{ targets: string[]; collectionLevel: boolean } | typeof CANCELLED>
  ```
- **契约（spec §4.10）**：「谁是集合级操作」**只在此一处判定**（提交集合里含任一虚拟项 → `collectionLevel: true` → `buildLinkPlan({ …, forceLastWrite })`）。任何新增的集合级入口（如 S11 的 forget 交互复用本函数）都必须显式传 `forceLastWrite`，**不得**在 `executeLinkPlan` 里二次推断（否则就是第二份真相）

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/link-interactive.test.ts` 末尾追加（该文件已有 `makeWs` / `makeLib` / `registerLib` / `stubTty` / `makeHome` / `captureOut`，直接复用）：

```ts
function writeLast(ws: string, names: string[]): void {
  mkdirSync(join(ws, '.lpm'), { recursive: true })
  writeFileSync(join(ws, '.lpm', 'last.json'), JSON.stringify({ version: 1, names }), 'utf8')
}
function shortcutOpts(): Array<{ value: string; label: string; hint?: string }> {
  const arg = vi.mocked(groupMultiselect).mock.calls[0]![0] as { options: Record<string, Array<{ value: string; label: string; hint?: string }>> }
  return arg.options['快捷'] ?? []
}

describe('link 主列表「快捷」组（spec §4.10）', () => {
  it('VI-1：有注册 + 有 last → 两项都在；勾「全部已注册」→ 展开全部注册键', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    writeLast(ws, ['@t/a'])
    stubTty(true); makeHome()
    const ALL = '\u0000__all_registered__'
    vi.mocked(groupMultiselect).mockResolvedValueOnce([ALL] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(shortcutOpts().map((o) => o.value)).toEqual([ALL, '\u0000__last__'])
    expect(shortcutOpts()[0]!.label).toContain('全部已注册（2）')
    expect(shortcutOpts()[1]!.label).toContain('上次链接的（1）')
    expect(cap.out.join('')).toContain('执行计划预览：')
    const pkg = JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8'))
    expect(pkg.dependencies['@t/a']).toContain('link:')
    expect(pkg.dependencies['@t/b']).toContain('link:')
  })

  it('VI-2：无 last.json → 「上次链接的」不出现，仅「全部已注册」', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(shortcutOpts().map((o) => o.label)).toEqual(['全部已注册（1）'])
  })

  it('VI-3：N 的口径 = 渲染期长度（不过滤失效名字）', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(shortcutOpts()[1]!.label).toContain('上次链接的（2）')
  })

  it('VI-4：勾「上次链接的」含失效名字 → 逐行剔除提示 + 其余照常 + 不报错', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('⚠️ @t/gone 已不在注册表，已跳过')
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/a']).toContain('link:')
  })

  it('VI-5：虚拟项触发的 last 刷新（展开后仅 1 个也刷新）', async () => {
    const libA = makeLib('@t/a')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    // 判别力（T6 评审 Important-1）：初始 last 含一个「将在展开期被剔除」的 @t/gone——
    // 无 forceLastWrite 传导时 targets 过滤后 =1 < 2 不刷新，终态会是 ['@t/a','@t/gone']；传导后才收敛为 ['@t/a']
    writeLast(ws, ['@t/a', '@t/gone'])
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/a'])
  })

  it('VI-6：无注册且无 last（空态）→ 不进主列表、无「快捷」组', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('quit')
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(groupMultiselect).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalled()   // 走的是空态向导，不是主列表
  })

  it('VI-7：有「扫描发现」但无注册、无 last → 主列表仍出现，但无「快捷」组', async () => {
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(join(scan, 'lib-x'), { recursive: true })
    writeFileSync(join(scan, 'lib-x', 'package.json'), JSON.stringify({ name: '@t/found' }), 'utf8')
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true)
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scan] }), 'utf8')
    vi.mocked(groupMultiselect).mockResolvedValueOnce([] as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(1)              // 空选中 → exit 1
    const arg = vi.mocked(groupMultiselect).mock.calls[0]![0] as { options: Record<string, unknown> }
    expect(arg.options['快捷']).toBeUndefined()
    expect(arg.options['扫描发现（1）']).toBeDefined()
  })

  it('VI-8：交互勾选 ≥ 2 个普通项 → last 刷新（S10 只补断言，代码未改）', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/a', '@t/b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    const last = JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')) as { names: string[] }
    expect([...last.names].sort()).toEqual(['@t/a', '@t/b'])
  })

  it('VI-9：虚拟项 + 手勾普通项混选 → 去重后只链一次', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/a': '^1.0.0', '@t/b': '^1.0.0' } }) })
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    writeLast(ws, ['@t/a'])
    stubTty(true); makeHome()
    // 同时勾「全部已注册」「上次链接的」与重复的普通项 @t/a
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__all_registered__', '@t/a', '\u0000__last__'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)                                  // install 恰一次
    const out = cap.out.join('')
    expect(out.match(/改写 apps\/web\/package\.json:/g)?.length).toBe(1)     // 同一 manifest 只列一段
    expect(out).not.toContain('已链接跳过：')                                // 去重后不该出现「已链接跳过」
  })
})
```

（`vi.mocked(groupMultiselect).mock.calls[0]![0]` 的取值形状与 S9 `LI-16` 一致；`\u0000__last__` 必须与实现里的哨兵字面一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-interactive.test.ts -t "VI-1"`
Expected: FAIL —— `shortcutOpts()` 返回 `[]`（目前没有「快捷」组）

- [ ] **Step 3: 写实现**

`src/commands/link.ts`，在 `OTHER_OPTION` 附近追加：

```ts
/** S10 虚拟项哨兵（NUL 前缀，包名不可能含 NUL——沿用 OTHER_OPTION 惯例） */
const ALL_REGISTERED = '\u0000__all_registered__'
const LAST_LINKED = '\u0000__last__'
```

`pickLinkTargets` 整体替换为：

```ts
/** 主列表多选（spec §4.5 + §4.10）：快捷组（虚拟项）+ 分组 + 「其他…」；返回 targets 与「是否集合级操作」 */
async function pickLinkTargets(
  cand: { registered: LinkCandidate[]; discovered: DiscoveredLib[] },
  lastNames: readonly string[],
): Promise<{ targets: string[]; collectionLevel: boolean } | typeof CANCELLED> {
  const groups: Record<string, Array<{ value: string; label: string; hint?: string }>> = {}
  // S10「快捷」组：虚拟项（提交后展开并入勾选集合；本身不是最终 target）
  const shortcuts: Array<{ value: string; label: string; hint?: string }> = []
  if (cand.registered.length > 0) {
    shortcuts.push({ value: ALL_REGISTERED, label: `全部已注册（${cand.registered.length}）`, hint: '一次勾选全部已注册的库' })
  }
  if (lastNames.length > 0) {
    shortcuts.push({ value: LAST_LINKED, label: `上次链接的（${lastNames.length}）`, hint: '恢复 last.json 记录的那一批' })
  }
  if (shortcuts.length > 0) groups['快捷'] = shortcuts
  if (cand.registered.length > 0) {
    groups[`已注册（${cand.registered.length}）`] = cand.registered.map((c) => ({
      value: c.key,
      label: c.hitMembers.length > 0 ? `${c.key}  ★` : c.key,
      hint: !c.cfgIntact
        ? '注册值损坏：修正 lpm.config.json 后重试'
        : c.linked
          ? '已链接，将跳过'
          : c.hitMembers.length === 0
            ? '未在依赖中，链接前需先 pnpm add'
            : c.rel,
    }))
  }
  if (cand.discovered.length > 0) {
    groups[`扫描发现（${cand.discovered.length}）`] = cand.discovered.map((d) => ({
      // ⚠️ value 必须是**路径**（不是包名）：该库尚未注册，`resolveTarget(包名)` 会因「含 / 的裸名被判为类路径」
      // 而抛 LinkArgumentError（`link.ts:115-121`）——走路径分支才能完成「隐形注册」（T4 评审 Important-1 修正）
      value: d.dirAbs,
      label: d.hitMembers.length > 0 ? `${d.key}  ★  [未注册]` : `${d.key}  [未注册]`,
      hint: d.hitMembers.length === 0 ? `${d.dirLabel}｜未在依赖中，链接前需先 pnpm add` : d.dirLabel,
    }))
  }
  groups['其他'] = [{ value: OTHER_OPTION, label: '其他…（手输路径）', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' }]

  const picked = await clack.groupMultiselect({ message: '选择要链接的库（空格勾选，回车确认）', options: groups })
  if (clack.isCancel(picked)) return CANCELLED
  const pickedArr = picked as string[]
  const collectionLevel = pickedArr.includes(ALL_REGISTERED) || pickedArr.includes(LAST_LINKED)
  const registeredKeys = new Set(cand.registered.map((c) => c.key))
  const values: string[] = []
  if (pickedArr.includes(ALL_REGISTERED)) values.push(...cand.registered.map((c) => c.key))
  if (pickedArr.includes(LAST_LINKED)) {
    // 交互侧失效名字 = 前置剔除 + 提示（spec §4.10；直通侧是整批停——不对称是刻意的）
    for (const n of lastNames) {
      if (registeredKeys.has(n)) values.push(n)
      else process.stdout.write(`⚠️ ${n} 已不在注册表，已跳过——请用路径重新注册\n`)
    }
  }
  for (const v of pickedArr) {
    if (v === ALL_REGISTERED || v === LAST_LINKED || v === OTHER_OPTION) continue
    values.push(v)
  }
  // 「其他…」不是最终勾选项：提交后若被勾选，先弹输入并把解析出的 target 并入（spec §4.5）
  if (pickedArr.includes(OTHER_OPTION)) {
    const raws = await promptPaths()
    if (raws === CANCELLED) return CANCELLED
    values.push(...raws)
  }
  return { targets: values, collectionLevel }
}
```

`runPlanAndExecute` 的签名与调用改为：

```ts
async function runPlanAndExecute(
  picked: readonly string[],
  ctx: { /* 既有 ctx 类型不变 */ },
  collectionLevel: boolean,
): Promise<number> {
```

并在其 `buildLinkPlan({...})` 参数对象里追加：

```ts
    pruneZeroHit: true, deferRegistration: true, forceLastWrite: collectionLevel,
```

`runLinkInteractive` 里，在 `const st = await readState(rootDir)` 之后追加：

```ts
    const lastNames = (await readLast(rootDir))?.names ?? []
```

并把主列表分支改为：

```ts
        const picked = await pickLinkTargets(cand, lastNames)
        if (picked === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
        if (picked.targets.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
        return await runPlanAndExecute(picked.targets, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls }, picked.collectionLevel)
```

空态手输路径那一处改为：

```ts
      return await runPlanAndExecute(raws, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls }, false)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-interactive.test.ts`
Expected: PASS —— 27 passed（既有 18 + VI-1…VI-9 共 9 例）

- [ ] **Step 5: 全量单测 + e2e**

Run: `pnpm verify`
Expected: exit 0；typecheck 0 + build 成功 + unit（**参考** 26 文件 / 447 例 = 基线 24 文件/395 例 + preset-command 25 + link-collection 18 + link-interactive 9）+ e2e（**参考** 33 例 = 基线 28 + 5）。**以实测为准**

- [ ] **Step 6: 收尾核对（只读）**

Run: `git status --porcelain -uall`
Expected: 本任务面 = ` M src/commands/link.ts`、` M tests/unit/link-interactive.test.ts`

---

### Task 7: 文档回写 + 全量验证 + 未提交面清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-s9-interactive-design.md`（回写 3 处）
- Modify: `docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md`（§10 回填实现期裁定）
- Modify: `docs/superpowers/plans/2026-09-28-s10-collections-presets.md`（终态计数行）
- Create: `docs/handoffs/<落盘当日>-s11-registry-management.md`（继任交接词）
- 核实（零改动）：`src/commands/registry.ts`

**Interfaces:**
- Consumes: T1–T6 的全部产出
- Produces: 无代码

- [ ] **Step 1: 回写 S9 spec §3.1 数据流（A6 块与 A8 行）**

`docs/superpowers/specs/2026-09-28-s9-interactive-design.md`：

在 §3.1 的 A6 块末尾（`        └─ readUserConfig().scanDirs → 直接子目录扫描 → 未注册候选` 这一行之后）追加：

```
        └─ last.json（readLast）→ 虚拟项「上次链接的」（有记录时）**——S10 追加**
```

把 A8 行

```
  A8  主列表多选（clack.groupMultiselect）→ 选中集合（已注册 key / 扫描发现 key / 手输路径解析出的 target）
```

替换为

```
  A8  主列表多选（clack.groupMultiselect）→ 选中集合（**S10 追加**：「快捷」组虚拟项展开 / 已注册 key / 扫描发现 key / 手输路径解析出的 target）
```

- [ ] **Step 2: 回写 S9 spec §4.5 的 A6 表**

在该表（`| 组 | 内容 | 标记 |` 那张表）的**第一行之前**插入一行：

```
| 快捷（N）——**S10 追加** | 「全部已注册（N）」（注册 ≥ 1 时出现）；「上次链接的（N）」（last.json 有记录时出现，无记录则整项隐藏） | 虚拟项：**本身不是最终勾选项**，提交后展开并入勾选集合；「上次链接的」展开时剔除已不在 `cfg.libs` 的名字并逐行提示 |
```

再在 §6 测试清单的 `tests/unit/link-interactive.test.ts` 小节末尾追加一行（spec 回写清单第 1 条的「§6 同步」）：

```
- **S10 追加**：「快捷」组两项的出现条件 / N 口径（渲染期不做注册表过滤）/ 勾选后展开与失效名字剔除 / 虚拟项触发的 last 刷新（仅 1 个也刷新）
```

- [ ] **Step 3: 回写 S9 spec §4.3 的冻结面那句**

把

```
**冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3 所列公共 API 签名不变。`runLink(targets, opts, cwd)` 与 `runUnlink(targets, opts, cwd)` **签名零改动**（本 spec 不改其形参，只改内部结构）；`LinkOptions` / `UnlinkOptions` **不扩字段**。
```

替换为（保留原文 + 追加一条注）：

```
**冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3 所列公共 API 签名不变。`runLink(targets, opts, cwd)` 与 `runUnlink(targets, opts, cwd)` **签名零改动**（本 spec 不改其形参，只改内部结构）；`LinkOptions` / `UnlinkOptions` **不扩字段**。

> **S10 追加（2026-09-28）**：上句的「不扩字段」是 **S9 对自身范围**的界定，非永久禁令。S10 按裁决 7 给 `LinkOptions` **追加了 3 个可选字段**（`last?` / `all?` / `preset?`，见 S10 spec §4.3）；三字段缺省时行为与 S9 交付态完全一致，`runLink` 形参未动。`UnlinkOptions` 仍未扩。
```

- [ ] **Step 4: 回填 S10 spec §10（实现期实测与裁定）**

把 `## 10. 实现期实测与裁定` 下的 `_（实施期回填：…）_` 占位替换为实测内容，至少包含：① 终态计数（`pnpm verify` 的 typecheck/build/unit/e2e 实测值 + 取数命令）；② 实施期做过的**细则裁定**（若有：编号 + 理由 + 代价）；③ 未提交面清单（`git status --porcelain -uall` 的原文）。

- [ ] **Step 5: 核实 registry 与 S6/S7 spec 的 S10 行（零改动，只记录结论）**

Run: `Get-ChildItem src,docs -Recurse -File -Include *.ts,*.md | Select-String -Pattern '计划 S10|交互模式随 S9|不扩字段'`
Expected: 命中的每一处都逐条对照现状——
- `src/commands/registry.ts` 的 `plannedSpec: 'S10'` 是**元数据**（`save`/`preset` 已由 cli 单独接线，不再走到 stub 分支），**不是过期描述**，维持不动；
- S6 §8 行 450 / S7 §8 行 301 的 S10 行核对「已就位」表述与 S10 实际交付一致（S7 那句「`--last`/`--preset` 恢复操作」须明确为 **link 侧**开关）；
- 若发现任何一处仍写「S10 未做 / 待建」，**当场改掉**。

- [ ] **Step 6: 终态全量验证**

Run: `pnpm verify`
Expected: exit 0，且四段全绿；记录**实测**数字（文件数 / 用例数）

Run: `git status --porcelain -uall`
Expected: 逐项记录「本阶段未提交面」（含 `??` 的未跟踪文件）——写进 S10 spec §10 与交接词

- [ ] **Step 7: 回填本计划的终态实测节**

把本计划**末尾的** `## 终态实测` 一节（当前是一段说明文字）整体替换为：

```markdown
## 终态实测

- `pnpm verify` exit 0 = typecheck 0 + build 成功 + unit <实测文件数> 文件 / <实测用例数> 例 + e2e <实测文件数> 文件 / <实测用例数> 例（取数命令：`pnpm verify`；实跑时间：<年-月-日 时:分>）
- 关键回归：`link-command.test.ts` 39 / `unlink-command.test.ts` 35 **零改动**；`link-picker.test.ts` / `plan-view.test.ts` / `unlink-interactive.test.ts` 零改动
- 未提交面（`git status --porcelain -uall` 原文）：<逐项照抄>
```

- [ ] **Step 8: 写继任交接词（S11）**

新建 `docs/handoffs/<落盘当日>-s11-registry-management.md`，按既有交接词链的**同构结构**写（元信息表 / 项目定位 / 现状 / 过程记录 / 本次任务 / 范围依据 / 开放问题 / 既定约束 / 遗留裁决与留观项 / 开工前先做 / 开场话术）。硬要求：

- 元信息表的 **HEAD / 验证基线 / 工作树状态**一律取**实测**（`git log --oneline -3`、`pnpm verify`、`git status --porcelain -uall`），并注明「实跑」
- 「本次任务」= PRD §14 行 410 的 S11 行（`forget` 直通 + 交互化（集成进 link 无参数列表的「管理注册…」）+ `dir` + 用户级 config），依赖 S4 S6 S9
- 「范围依据」必须包含本次新加的接口：`pickLinkTargets` 返回 `{ targets, collectionLevel }`（S11 接手时不要退回 `string[]`）、「快捷」组与「管理注册…」的**组装顺序**（快捷 → 已注册 → 扫描发现 → 其他 → 管理注册…）、`readPresets` 的失效名字策略（`lpm forget` 会让预设里的旧名字失效 → 直通整批停）
- 「遗留裁决与留观项」必须搬运 S10 的：S9 final-review 的 parked 项（死字段 / 重复解析 / 双次 `loadWorkspace` / `[注册值损坏]` label-vs-hint / `vi.clearAllMocks`）、S9 未覆盖分支清单、CJK 三屏手测的见证范围备注、S9 spec §4.4 第 215 行的措辞待回写（若 T7 未顺手改则继续挂）、**S10 新增的真实终端手测项（`lpm preset` 菜单含 `[损坏]` label 与 link 主列表「快捷」组的中文对齐 / 长行换行——归用户，无 PTY 不可自动化）**、以及本计划实施期新产生的 `minor (deferred)`

- [ ] **Step 9: 收尾核对（只读，全部产物）**

Run: `git status --porcelain -uall`
Expected: 与 Step 6 的记录一致（文档回写只增改 md，不引入新的源码面）

---

## 终态实测

- `pnpm verify` exit 0 = typecheck 0 + build 成功 + unit **26 文件 / 447 例** + e2e **1 文件 / 33 例**（取数命令：`pnpm verify`；实跑时间：2026-09-28 21:00）
- 关键回归：`link-command.test.ts` 39 / `unlink-command.test.ts` 35 **零改动**；`link-picker.test.ts`（19）/ `plan-view.test.ts` / `unlink-interactive.test.ts`（23）零改动
- 未提交面（`git status --porcelain -uall` 原文，2026-09-28 21:00 实跑；S10 全程零 commit，HEAD = `0f9407d`）：

```
 M docs/superpowers/specs/2026-09-28-s9-interactive-design.md
 M src/cli.ts
 M src/commands/link.ts
 M tests/e2e/cli.e2e.test.ts
 M tests/unit/link-interactive.test.ts
?? docs/superpowers/plans/2026-09-28-s10-collections-presets.md
?? docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md
?? src/commands/preset.ts
?? tests/unit/link-collection.test.ts
?? tests/unit/preset-command.test.ts
```
