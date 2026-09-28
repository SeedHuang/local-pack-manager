# S9 交互层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `lpm link` / `lpm unlink` 的**无参数分支**从占位升级为交互入口（空态向导 / 分组多选 / 按路径取消 / 扫描发现），并让交互模式在动手前打印一份**执行计划预览**、一次确认后才执行——link 与 unlink 共用同一份计划渲染器。

**Architecture:** 三个动作面分离——① `src/commands/plan-view.ts` 只负责「计划视图 → 文本」（link/unlink 共用，`mode='dry-run'|'preview'` 只差首行）；② `link.ts` / `unlink.ts` 各自把既有编排**原地拆成** `buildXxxPlan`（前置判定 + 计划构建，含全部 TTY 弹问）与 `executeXxxPlan`（写序 + 留痕 + 完成提示，逐字不变），**两者都不导出**；③ 无参数分支成为交互入口：菜单选库 → 构建计划 → 渲染预览 → 一次 `clack.confirm`（默认否）→ 执行。**同一份计划被预览与执行共用**，故「dry-run 说的」与「实际做的」天然同源（PRD §13 验收 9）。直通模式行为与文案零变化。

**Tech Stack:** TypeScript ESM（Node ≥ 22.12）+ commander + @clack/prompts **1.8.1**（`groupMultiselect` / `multiselect` / `select` / `text` / `confirm` / `isCancel`）+ execa + tsup + vitest。**运行时依赖零新增**。

**Spec:** `docs/superpowers/specs/2026-09-28-s9-interactive-design.md`（行为权威；本计划与 spec 冲突时以 spec 为准，除 T2/T4/T6 标注的「实现期裁定」——那些需在 T7 回写 spec）

## Global Constraints

- 技术栈定版：TS ESM + Node ≥ 22.12 + commander + @clack/prompts + execa + tsup + vitest；**运行时依赖零新增**（PRD §14 行 391）
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入
- **禁止一切 Git 写操作**（worktree/分支/commit/push/add）：本计划所有任务**不执行任何 git 命令**，改动由用户自行提交；每任务收尾只用**只读** `git status --porcelain -uall` 核对工作树
- 终端 Windows PowerShell；skill 自带 bash 脚本不可用；**brief 载体 = 本 plan 文件 + 任务标题锚定**（`### Task N:` 到下一个 `### Task ` 之前）；评审载体 = reviewer 直读产出文件（无 commit 区间可依）
- 编辑纪律：**同一文件禁止并行 SearchReplace**；新增 import 与使用它的代码必须合并进**同一次**编辑；编辑后跑 `npx tsc --noEmit` 分级检查（**禁用 GetDiagnostics**，其结果为 TS Server 缓存）
- Task 工具无 model 参数，统一默认模型；实现者**禁止派生子代理**；子代理同样禁止 git 写操作
- **冻结签名零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3 所列公共 API 的既有签名；`runLink(targets, opts, cwd)` / `runUnlink(targets, opts, cwd)` 的**签名与直通行为**均不变；`LinkOptions` / `UnlinkOptions` **不扩字段**
- **dry-run 文案逐字保真**：link 的 `dry-run 执行计划（不落任何盘、不执行任何子进程）：` 及其后各行、unlink 的同名首行与各行、link 空分支的 `无待执行变更`（**无缩进**）、unlink 空分支的 `  无待执行变更`（**两空格缩进**）——一字不改（既有测试断言这些字符串）
- 交互入口**不新增导出**：入口即 `runLink` / `runUnlink` 的 `targets.length === 0` 分支；`buildXxxPlan` / `executeXxxPlan` / `xxxPlanView` 与全部交互编排函数一律**不导出**
- 新增导出的正确类归命令文件（S6/S7 先例）：`PathInputError` 定义在 `src/commands/link.ts`，`unlink.ts` 经 import 复用
- 交互模式下 `isTTY` 判定单源 = `process.stdin.isTTY === true`（`repair.ts` 先例）；**非 TTY 绝不进菜单**
- 退出码口径单源 = spec §4.10：非 TTY 无参数 / 取消 / 空选中 / 确认答否 → 1；空态告知 / 无目标 `--dry-run` / 计划为空 → 0
- 全 lpm 状态文件（state/last/config/last-run）皆「可删除后重建」；交互模式新增的唯一写盘面 = 用户级 `~/.lpm/config.json` 的 `scanDirs`（可手删）
- 验证命令：`pnpm verify`（= typecheck && build && unit && e2e）。**基线：unit 20 文件 / 324 用例 + e2e 1 文件 / 26 用例，exit 0**（HEAD `0b78b49`，2026-09-28 实跑）
- 计数链最终定版在收尾任务（T7）写入本计划与 spec 回写

---

## 文件结构总览

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/commands/plan-view.ts` | **新增**：计划视图 `PlanView`/`PlanEntry` + `renderPlan(view, mode)`（link/unlink 共用；repair 不接） | T1 |
| `tests/unit/plan-view.test.ts` | **新增**：渲染器单测（PV-*） | T1 |
| `src/commands/link.ts` | 改：原地拆 `buildLinkPlan`/`executeLinkPlan`（不导出）；dry-run 改走 `renderPlan`；`runLink` 空 targets 分支改交互入口；新增导出 `parsePathInput`/`collectLinkCandidates`/`PathInputError`/`LinkCandidate`/`DiscoveredLib` | T2 / T3 / T4 |
| `src/commands/unlink.ts` | 改：原地拆 `buildUnlinkPlan`/`executeUnlinkPlan`（不导出）；dry-run 改走 `renderPlan`；空 targets 分支改交互入口；新增导出 `collectLinkedItems`/`LinkedItem` | T5 / T6 |
| `tests/unit/link-picker.test.ts` | **新增**：tokenizer + 候选集合单测（PP-*/PC-*） | T3 |
| `tests/unit/link-interactive.test.ts` | **新增**：link 交互入口单测（LI-*） | T4 |
| `tests/unit/unlink-interactive.test.ts` | **新增**：列表数据源 + unlink 交互入口单测（UI-*） | T5 / T6 |
| `tests/unit/link-command.test.ts`、`tests/unit/unlink-command.test.ts` | 改：既有「无参数占位文案」用例改造为 S9 契约（其余断言不动） | T4 / T6 |
| `tests/e2e/cli.e2e.test.ts` | 改：新增 2 例（非 TTY 无参数） | T7 |
| `src/state/index.ts`、`src/cli.ts` | **零改动** | — |

---

### Task 1: 计划视图与渲染器（plan-view）

**Files:**
- Create: `src/commands/plan-view.ts`
- Create: `tests/unit/plan-view.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，零 import）
- Produces:
  ```ts
  export type PlanEntry =
    | { kind: 'group'; heading: string; lines: string[] }
    | { kind: 'line'; text: string }
  export interface PlanView {
    entries: PlanEntry[]
    install: { command: string; verify: string | null } | null
    watch: string[]
  }
  export type PlanMode = 'dry-run' | 'preview'
  export function renderPlan(view: PlanView, mode: PlanMode): string
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/plan-view.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { renderPlan, type PlanView } from '../../src/commands/plan-view.js'

const DRY_HEAD = 'dry-run 执行计划（不落任何盘、不执行任何子进程）：'
const PREVIEW_HEAD = '执行计划预览：'

/** 一个含 CJK 与中英混排的代表性计划（link 形态） */
function view(): PlanView {
  return {
    entries: [
      { kind: 'line', text: '注册 upsert：@t/lib → ../../lpm-lib（新增/更新）' },
      { kind: 'group', heading: '改写 apps/web/package.json:', lines: ['dependencies.@t/lib：^1.0.0 → link:../../lpm-lib'] },
      { kind: 'line', text: '已链接跳过：@t/two' },
      { kind: 'line', text: 'peer 警告：apps/web/package.json（@t/lib）' },
    ],
    install: { command: 'pnpm install --no-frozen-lockfile', verify: null },
    watch: ['拉起 ../../lpm-lib 的 build:watch（pnpm run build:watch）'],
  }
}

describe('renderPlan', () => {
  it('PV-1：dry-run 首行是既有 K 文案', () => {
    expect(renderPlan(view(), 'dry-run').split('\n')[0]).toBe(DRY_HEAD)
  })
  it('PV-2：preview 首行是「执行计划预览：」', () => {
    expect(renderPlan(view(), 'preview').split('\n')[0]).toBe(PREVIEW_HEAD)
  })
  it('PV-3：两模式除首行外逐字相同（§13.9 一致性的结构保证）', () => {
    const d = renderPlan(view(), 'dry-run').split('\n').slice(1).join('\n')
    const p = renderPlan(view(), 'preview').split('\n').slice(1).join('\n')
    expect(p).toBe(d)
  })
  it('PV-4：group 条目 = 2 空格 heading + 4 空格明细行', () => {
    const lines = renderPlan(view(), 'preview').split('\n')
    expect(lines).toContain('  改写 apps/web/package.json:')
    expect(lines).toContain('    dependencies.@t/lib：^1.0.0 → link:../../lpm-lib')
  })
  it('PV-5：line 条目 2 空格缩进', () => {
    const lines = renderPlan(view(), 'preview').split('\n')
    expect(lines).toContain('  已链接跳过：@t/two')
    expect(lines).toContain('  peer 警告：apps/web/package.json（@t/lib）')
  })
  it('PV-6：verify === null 时不出现「复验」行', () => {
    expect(renderPlan(view(), 'preview')).not.toContain('复验：')
  })
  it('PV-7：verify 非 null 时出现在 install 之后', () => {
    const v = view()
    v.install = { command: 'pnpm install --no-frozen-lockfile', verify: 'node_modules 实际指向（残留/缺失将 pnpm install --force 重建）' }
    const lines = renderPlan(v, 'preview').split('\n')
    const i = lines.findIndex((l) => l.startsWith('  install：'))
    expect(lines[i + 1]).toBe('  复验：node_modules 实际指向（残留/缺失将 pnpm install --force 重建）')
  })
  it('PV-8：watch 为空数组时不出现 watch 行', () => {
    const v = view()
    v.watch = []
    expect(renderPlan(v, 'preview')).not.toContain('  watch：')
  })
  it('PV-9：install 为 null 时不出现 install 行', () => {
    const v = view()
    v.install = null
    expect(renderPlan(v, 'preview')).not.toContain('  install：')
  })
  it('PV-10：已安装段落在 entries 之后（行序 = entries 顺序 + install + watch）', () => {
    const lines = renderPlan(view(), 'preview').split('\n').filter((l) => l !== '')
    expect(lines[lines.length - 1]).toBe('  watch：拉起 ../../lpm-lib 的 build:watch（pnpm run build:watch）')
  })
  it('PV-11：返回值以单个换行结尾（与既有 stdout.write 调用形态一致）', () => {
    const out = renderPlan(view(), 'preview')
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/plan-view.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/commands/plan-view.js"`

- [ ] **Step 3: 实现渲染器**

创建 `src/commands/plan-view.ts`：

```ts
// 执行计划视图与渲染（S9 spec §4.4）。行为权威 = spec §4.4。
// 设计要点：link / unlink 共用一份渲染器——同一份 PlanView 在两种模式下只差首行，
// 这是「dry-run 输出与真实执行计划一致」（PRD §13 验收 9）的结构保证，不靠额外测试对齐。
// repair 不接本模块（S8 的 printPlan 已含三类信息且刚验收，spec §2 裁决 5）。

export type PlanEntry =
  | { kind: 'group'; heading: string; lines: string[] }
  | { kind: 'line'; text: string }

export interface PlanView {
  /** 明细条目：按各命令既有 dry-run 的行序填好文案（渲染器不重排、不改字） */
  entries: PlanEntry[]
  /** 尾部 install 段；verify 为 null 表示该命令不复验（link） */
  install: { command: string; verify: string | null } | null
  /** watch 行（已含「拉起 … 的 build:watch（… run build:watch）」正文） */
  watch: string[]
}

export type PlanMode = 'dry-run' | 'preview'

const TITLE: Record<PlanMode, string> = {
  'dry-run': 'dry-run 执行计划（不落任何盘、不执行任何子进程）：',
  preview: '执行计划预览：',
}

export function renderPlan(view: PlanView, mode: PlanMode): string {
  const out: string[] = [TITLE[mode]]
  for (const e of view.entries) {
    if (e.kind === 'group') {
      out.push(`  ${e.heading}`)
      for (const l of e.lines) out.push(`    ${l}`)
    } else {
      out.push(`  ${e.text}`)
    }
  }
  if (view.install !== null) {
    out.push(`  install：${view.install.command}（workspace 根）`)
    if (view.install.verify !== null) out.push(`  复验：${view.install.verify}`)
  }
  for (const w of view.watch) out.push(`  watch：${w}`)
  return `${out.join('\n')}\n`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/plan-view.test.ts`
Expected: PASS（11 例）

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit --pretty`
Expected: 0 错误

- [ ] **Step 6: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读，记录新增文件）

---

### Task 2: link 编排拆分 + dry-run 接共享渲染器（零对外行为变化）

**Files:**
- Modify: `src/commands/link.ts`（原地拆分 `runLink`；dry-run 改走 `renderPlan`）
- Test: `tests/unit/link-command.test.ts`（**不改**——它的既有断言就是本任务的判据）

**Interfaces:**
- Consumes: T1 的 `renderPlan` / `PlanView` / `PlanEntry`；既有 `findWorkspaceRoot` / `loadWorkspace` / `readProjectConfig` / `resolvePackageManager` / `readState` / `resolveTarget` / `resolveMonorepo` / `checkLib` / `findDependents` / `mapProtocol` / `rewriteDepValue` / `readFileSync` / `writeTextFileAtomic` / `writeState` / `writeLast` / `runInstall` / `spawnBuildWatch` / `detectLibPM` / `pmExecutable` / `buildInstallCommandLine` / `writeRunTrace` / `buildRunTrace` / `traceFailure`
- Produces（**均不导出**，供 T4 在同一文件内复用）：
  ```ts
  interface LinkPlan {
    rootDir: string
    pm: PackageManagerId
    cfg: ProjectLpmConfig | null            // upsert 之后的值（dry-run 下为原值）
    st: LinkState | null
    targets: readonly string[]
    aggregated: Map<string, FileAgg>
    planUpserts: Array<{ key: string; rel: string; isNew: boolean }>
    planSkipped: string[]
    planAbandoned: string[]
    peerWarn: Array<{ rel: string; pkg: string }>
    linkedTargets: LinkedTarget[]
    pendingLinks: Array<{ key: string; original: Record<string, string> }>
    totalChanged: number
    skippedTotal: number
    traceChanges: LastRunTrace['changes']
    traceInstalls: LastRunTrace['installs']
    /** T4 用：交互模式下零命中项被剔除时的提示行（直通模式恒为空） */
    pruned: string[]
  }
  async function linkPreflight(cwd: string): Promise<{ rootDir: string; ws: Workspace; cfg: ProjectLpmConfig | null; pm: PackageManagerId }>
  async function buildLinkPlan(args: {
    targets: readonly string[]
    opts: LinkOptions
    rootDir: string
    /** 调用方的工作目录（= runLink / runLinkInteractive 的 cwd 形参）——`resolveTarget` 用 `resolve(cwd, raw)`
     *  解析相对路径目标，缺了它就改变对外行为（T2 实现者发现并上报的 plan 缺陷，已裁定补齐） */
    cwd: string
    ws: Workspace
    cfg: ProjectLpmConfig | null
    pm: PackageManagerId
    st: LinkState | null
    traceChanges: LastRunTrace['changes']
    traceInstalls: LastRunTrace['installs']
    /** T4 传 true；直通传 false/省略 —— 见实现期裁定 1 */
    pruneZeroHit?: boolean
  }): Promise<LinkPlan>
  async function executeLinkPlan(plan: LinkPlan, opts: LinkOptions): Promise<number>
  function linkPlanView(plan: LinkPlan, opts: LinkOptions): PlanView
  ```

**实现期裁定 1（需在 T7 回写 spec §4.5）**：spec 写「前置剔除在构建计划**之前**」，实现改为**在 `buildLinkPlan` 内部**做——因为「零命中」只有在 `resolveTarget`/`resolveMonorepo` 解析出包名之后才能判断（B4 让选可能弹菜单），放到构建前会导致**同一个 lib 被解析两次、B4 菜单弹两次**。改在构建内做，语义仍满足 spec 的两条硬要求：① 在**预览之前**判定完毕；② 不连累同批其它项。判定用的 `findDependents` 就在该处现取，天然满足「不得复用渲染期快照」（spec §4.5）。

**抽取边界（行号取自 HEAD `0b78b49` 的 `src/commands/link.ts`，共 534 行）**：

| 现位置 | 归属 | 说明 |
|---|---|---|
| 245–250 | `runLink` 保留 | A1 无参数分支（**T4 改成 `return runLinkInteractive(opts, cwd)`**；本任务先保持原样） |
| 251–256 | `runLink` 保留 | `traceRoot`/`tracePm`/`traceChanges`/`traceInstalls` 声明 |
| 258–271 | → `linkPreflight` | `findWorkspaceRoot` → `loadWorkspace` → `readProjectConfig` → `resolvePackageManager` → `readState`；**「检测到包管理器」那行打印留在这里**（两个入口共用同一次前置） |
| 273–283 | → `buildLinkPlan` | 局部累加器（`seenRaw`/`seenKey`/`aggregated`/`peerWarn`/`planUpserts`/`planSkipped`/`planAbandoned`/`dedupSkipped`/`unchangedTotal`/`linkedTargets`/`pendingLinks`）+ **新增 `const pruned: string[] = []`** |
| 285–404 | → `buildLinkPlan` | 逐 target 循环，**逐字搬运**；仅两处改动：见下「改动点」 |
| 406–408 | → `buildLinkPlan` 末尾 | `totalChanged` / `skippedTotal` 计算 |
| 409–415 | `runLink` 保留 | 空计划分支（**不动**：dry-run 打 `无待执行变更`、非 dry-run 静默 return 0） |
| 417–436 | **删除** | 原 dry-run 打印块 → 由 `linkPlanView` + `renderPlan(..., 'dry-run')` 替代 |
| 438–521 | → `executeLinkPlan` | E6a/E6b/E6c + I last + H watch + J 完成提示 + 留痕，**逐字搬运** |
| 522–533 | `runLink` 保留 | catch（含 `traceFailure` 闸门与 `LinkCancelledError` 分支），**逐字不动** |

**改动点（仅两处，其余逐字搬运）**：

1. `const pruned: string[] = []`（新累加器，属于 `buildLinkPlan` 局部）
2. E3 零命中分支（原 337–340）：

```ts
      // E3 O5 零命中
      if (hits.length === 0) {
        if (args.pruneZeroHit === true) {
          // S9 交互模式：剔除该 target 并提示，不连累同批其它勾选项（spec §4.5）
          pruned.push(`⚠️ ${check.name} 未在任何成员依赖中，已跳过——请先 pnpm add ${check.name}`)
          planAbandoned.push(check.name)
          continue
        }
        throw new LinkTargetError(check.name, `${check.name} 不在任何成员依赖中。先在引用方执行 pnpm add ${check.name} 再 link`)
      }
```

> 注意：剔除时**仍把它计入 `skippedTotal`**（走 `planAbandoned`），这样完成提示的「已链接跳过：N 处」计数与既有口径一致；直通路径（`pruneZeroHit !== true`）完全不变。

- [ ] **Step 1: 记录基线（改之前必须绿）**

Run: `npx vitest run tests/unit/link-command.test.ts`
Expected: PASS（39 例）；记下用例数作为重构判据

- [ ] **Step 2: 原地拆分（一次编辑内完成，禁止并行 SearchReplace）**

按上表把 534 行的 `runLink` 拆成 `linkPreflight` / `buildLinkPlan` / `executeLinkPlan` / `linkPlanView` + 瘦身后的 `runLink`。新结构（除 `runLink` 外**全部不导出**，写在 `runLink` 之前）：

```ts
async function linkPreflight(cwd: string): Promise<{ rootDir: string; ws: Workspace; cfg: ProjectLpmConfig | null; pm: PackageManagerId }> {
  const rootDir = await findWorkspaceRoot(cwd)
  const ws: Workspace = await loadWorkspace(rootDir)
  const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
  const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
  if (pmResolution.source === 'detected') {
    process.stdout.write(`检测到包管理器：${pmResolution.pm}（未 lpm use 固化）\n`)
  }
  return { rootDir, ws, cfg, pm: pmResolution.pm }
}

/** 计划构建（统一前置判定）：把原 runLink 的 A2–A5 + 计划构建整体搬入。
 *  直通与交互入口共用同一份计划——预览与执行因此天然同源（PRD §13 验收 9）。 */
async function buildLinkPlan(args: { /* 见 Interfaces */ }): Promise<LinkPlan> {
  const { targets, opts, rootDir, ws, pm, traceChanges, traceInstalls } = args
  let cfg = args.cfg
  const st = args.st
  const pruned: string[] = []
  // …原 273–404 逐字搬运（含 E1 幂等 / D upsert / E2 命中 / E4 非 lpm 三选一 / E5 改写聚合）…
  // …其中 E3 零命中分支按上方「改动点 2」改写…
  const totalChanged = [...aggregated.values()].reduce((s, e) => s + e.changedCount, 0)
  const skippedTotal = planSkipped.length + planAbandoned.length + dedupSkipped + unchangedTotal
  return { rootDir, pm, cfg, st, targets, aggregated, planUpserts, planSkipped, planAbandoned,
           peerWarn, linkedTargets, pendingLinks, totalChanged, skippedTotal, traceChanges, traceInstalls, pruned }
}

/** 把计划渲染成共享视图（行序 = 既有 dry-run 行序，逐字兼容 spec §4.4） */
function linkPlanView(plan: LinkPlan, opts: LinkOptions): PlanView {
  const entries: PlanEntry[] = []
  for (const u of plan.planUpserts) {
    if (u.isNew || plan.cfg?.libs[u.key] === undefined) entries.push({ kind: 'line', text: `注册 upsert：${u.key} → ${u.rel}（新增/更新）` })
  }
  for (const [mp, entry] of plan.aggregated) {
    entries.push({ kind: 'group', heading: `改写 ${toRel(plan.rootDir, mp)}:`,
      lines: entry.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}`) })
  }
  for (const k of plan.planSkipped) entries.push({ kind: 'line', text: `已链接跳过：${k}` })
  for (const p of plan.peerWarn) entries.push({ kind: 'line', text: `peer 警告：${p.rel}（${p.pkg}）` })
  const watch = opts.watch === true
    ? plan.linkedTargets.map((t) => `拉起 ${t.rel} 的 build:watch（${pmExecutable(detectLibPM(t.libDirAbs))} run build:watch）`)
    : []
  return { entries, install: { command: buildInstallCommandLine(plan.pm), verify: null }, watch }
}

/** 执行（写序 = S6 裁决：state → package.json → install → last → watch → 提示 → 留痕）——逐字搬运原 438–521 */
async function executeLinkPlan(plan: LinkPlan, opts: LinkOptions): Promise<number> { /* … */ }
```

`runLink` 瘦身后（**签名与 A1 分支本任务保持原样**）：

```ts
export async function runLink(targets: readonly string[], opts: LinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数（T4 改为交互入口）
  if (targets.length === 0) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]\n')
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, ws, cfg, pm } = await linkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)
    const plan = await buildLinkPlan({ targets, opts, rootDir, ws, cfg, pm, st, traceChanges, traceInstalls, cwd })
    if (plan.aggregated.size === 0) {
      if (opts.dryRun === true) process.stdout.write('无待执行变更\n')   // spec §4.4 K3：无缩进，逐字保真
      return 0
    }
    if (opts.dryRun === true) {
      process.stdout.write(renderPlan(linkPlanView(plan, opts), 'dry-run'))
      return 0
    }
    return await executeLinkPlan(plan, opts)
  } catch (err) {
    // 逐字不动（S8 §4.6）
  }
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit --pretty`
Expected: 0 错误（若报 `pruned` 未使用等，检查是否漏了 E3 改动点）

- [ ] **Step 4: 回归验证（本任务的核心判据）**

Run: `npx vitest run tests/unit/link-command.test.ts`
Expected: PASS，**用例数与 Step 1 记录完全一致**（既有 dry-run 文案断言全绿 = 逐字兼容）

Run: `pnpm verify`
Expected: exit 0；unit **20 文件 / 324 用例**、e2e **26/26**（数字与基线一致，本任务不新增用例）

- [ ] **Step 5: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读）

---

### Task 3: 路径输入解析 + 候选集合（link-picker）

**Files:**
- Modify: `src/commands/link.ts`（追加 3 个导出 + 2 个模块私有帮助函数）
- Create: `tests/unit/link-picker.test.ts`

**Interfaces:**
- Consumes: 既有 `findDependents(ws, pkgName)`（`src/core/workspace.js`）、`node:fs`（`existsSync`/`readdirSync`/`readFileSync`/`statSync`）、`node:path`（`join`）、模块私有 `toRel`
- Produces:
  ```ts
  export class PathInputError extends Error { constructor(message: string) }
  export function parsePathInput(raw: string): string[]
  export interface LinkCandidate { key: string; rel: string; hitMembers: string[]; linked: boolean; cfgIntact: boolean }
  export interface DiscoveredLib { key: string; dirAbs: string; dirLabel: string; hitMembers: string[] }
  export async function collectLinkCandidates(
    rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null, scanDirs: readonly string[],
  ): Promise<{ registered: LinkCandidate[]; discovered: DiscoveredLib[]; scanNotes: string[] }>
  ```

> `hitMembers` 的元素是**相对根路径标签**（如 `apps/web/package.json`），供交互层排序与提示使用；只读快照，**不参与执行判定**（spec §8 自决 10）。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/link-picker.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLinkCandidates, parsePathInput, PathInputError } from '../../src/commands/link.js'
import { loadWorkspace } from '../../src/core/workspace.js'
import type { LinkState, ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function mkTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lpm-pick-'))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return root
}

describe('parsePathInput', () => {
  it('PP-1：绝对路径单目标', () => { expect(parsePathInput('D:\\Seed\\lib')).toEqual(['D:\\Seed\\lib']) })
  it('PP-2：相对路径多目标（空白分隔）', () => { expect(parsePathInput('../lib ../other')).toEqual(['../lib', '../other']) })
  it('PP-3：双引号含空格', () => { expect(parsePathInput('"D:\\My Lib\\core"')).toEqual(['D:\\My Lib\\core']) })
  it('PP-4：单引号含空格', () => { expect(parsePathInput("'../my lib'")).toEqual(['../my lib']) })
  it('PP-5：引号与裸串混排', () => { expect(parsePathInput('a "b c" d')).toEqual(['a', 'b c', 'd']) })
  it('PP-6：未闭合引号抛错', () => { expect(() => parsePathInput('"未闭合')).toThrow(PathInputError) })
  it('PP-7：空串 / 全空白抛错', () => { expect(() => parsePathInput('')).toThrow(PathInputError); expect(() => parsePathInput('   ')).toThrow(PathInputError) })
  it('PP-8：空引号抛错', () => { expect(() => parsePathInput('""')).toThrow(PathInputError) })
})

describe('collectLinkCandidates', () => {
  /** ws：apps/web 与 apps/server 声明 @t/lib；apps/web 另声明 @t/two */
  function wsFiles(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'package.json': JSON.stringify({ name: 'ws-root', private: true }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n  - 'apps/server'\n",
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/two': '^1.0.0' } }),
      'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': '^1.0.0' } }),
      ...extra,
    }
  }

  it('PC-1：★ 按命中成员数降序，并列按注册顺序', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/two': '../two', '@t/lib': '../lib', '@t/none': '../none' } }
    const { registered } = await collectLinkCandidates(root, ws, cfg, null, [])
    expect(registered.map((c) => c.key)).toEqual(['@t/lib', '@t/two', '@t/none'])
    // hitMembers 的元素顺序由 findDependents/成员枚举序决定——spec §4.9/§8 未定义该顺序，且无消费者依赖它（交互层只用 .length）
    // → 断言用无序比较（Ruling R3-1：T3 实现者上报，brief 原断言假定书写序，实测为成员枚举序）
    expect([...registered[0].hitMembers].sort()).toEqual(['apps/server/package.json', 'apps/web/package.json'])
    expect(registered[2].hitMembers).toEqual([])
  })
  it('PC-2：[已链接] 标记来自 state', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const { registered } = await collectLinkCandidates(root, ws, cfg, st, [])
    expect(registered[0].linked).toBe(true)
  })
  it('PC-3：注册值非字符串 → cfgIntact=false，不抛错', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg = { version: 1, libs: { '@t/bad': 42 } } as unknown as ProjectLpmConfig
    const { registered } = await collectLinkCandidates(root, ws, cfg, null, [])
    expect(registered[0]).toMatchObject({ key: '@t/bad', cfgIntact: false, hitMembers: [] })
  })
  it('PC-4：links[key] 为 null / 原型链成员脏值不崩', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const st = { version: 1, links: { '@t/lib': null, constructor: {} } } as unknown as LinkState
    const { registered } = await collectLinkCandidates(root, ws, cfg, st, [])
    expect(registered[0].linked).toBe(true)
  })
  it('PC-5：扫描发现只认直接子目录里 name 非空的包', async () => {
    const scan = mkTree({
      'lib-a/package.json': JSON.stringify({ name: '@t/found' }),
      'lib-b/package.json': JSON.stringify({ name: '' }),
      'lib-c/notpkg.txt': '',
      'node_modules/x/package.json': JSON.stringify({ name: '@t/nm' }),
      '.hidden/package.json': JSON.stringify({ name: '@t/hidden' }),
    })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered } = await collectLinkCandidates(root, ws, null, null, [scan])
    expect(discovered.map((d) => d.key)).toEqual(['@t/found'])
  })
  it('PC-6：已注册键不进发现组；被成员依赖声明的库不被排除（第 4 轮评审修正的回归钉）', async () => {
    const scan = mkTree({
      'lib-a/package.json': JSON.stringify({ name: '@t/lib' }),
      'lib-b/package.json': JSON.stringify({ name: '@t/found' }),
    })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const cfg: ProjectLpmConfig = { version: 1, libs: { '@t/lib': '../lib' } }
    const { discovered } = await collectLinkCandidates(root, ws, cfg, null, [scan])
    expect(discovered.map((d) => d.key)).toEqual(['@t/found'])
  })
  it('PC-7：discovered 项也带 hitMembers（零命中标记与前置剔除同规则）', async () => {
    const scan = mkTree({ 'lib-a/package.json': JSON.stringify({ name: '@t/lib' }) })
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered } = await collectLinkCandidates(root, ws, null, null, [scan])
    expect(discovered[0].hitMembers.length).toBeGreaterThan(0)
  })
  it('PC-8：scanDirs 不存在 → 提示但不中断', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { discovered, scanNotes } = await collectLinkCandidates(root, ws, null, null, [join(root, 'no-such-dir')])
    expect(discovered).toEqual([])
    expect(scanNotes[0]).toContain('跳过不可读的扫描目录')
  })
  it('PC-9：scanDirs 元素非字符串 → 提示并跳过', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    const { scanNotes } = await collectLinkCandidates(root, ws, null, null, [42 as unknown as string])
    expect(scanNotes[0]).toContain('非字符串')
  })
  it('PC-10：scanDirs 为空 → discovered 为空数组', async () => {
    const root = mkTree(wsFiles())
    const ws = await loadWorkspace(root)
    expect((await collectLinkCandidates(root, ws, null, null, [])).discovered).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-picker.test.ts`
Expected: FAIL —— `collectLinkCandidates is not a function` / `PathInputError` 未导出

- [ ] **Step 3: 实现（在 `src/commands/link.ts` 内追加；import 与代码合并进同一次编辑）**

`link.ts` 顶部 import 调整为（**只做两处**：node:fs 加 `readdirSync` 与 `type Dirent`；`node:path` 那一行**保持不动**——`isAbsolute` 与 `resolve` 本就在用且在用，改动它会误删 `resolve`）：

```ts
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
// node:path 的既有行不动：import { dirname, isAbsolute, join, relative } from 'node:path'
```

在 `reportError` 之前追加（**全部导出仅为 `parsePathInput` / `PathInputError` / `collectLinkCandidates` 及两个接口**）：

```ts
// ─────────────────────────── S9 路径输入与候选集合（spec §4.8 / §4.9）───────────────────────────

/** 路径输入解析失败（未闭合引号 / 空项）——交互内提示重试，不作命令级终止 */
export class PathInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathInputError'
  }
}

/** 路径输入 tokenizer（spec §4.8）：空白分隔；单/双引号包裹可含空格；未闭合引号或空项 → PathInputError */
export function parsePathInput(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t') {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (quote !== null) throw new PathInputError('路径输入的引号未闭合')
  if (started) out.push(cur)
  if (out.length === 0 || out.some((v) => v === '')) throw new PathInputError('路径输入为空')
  return out
}

export interface LinkCandidate { key: string; rel: string; hitMembers: string[]; linked: boolean; cfgIntact: boolean }
export interface DiscoveredLib { key: string; dirAbs: string; dirLabel: string; hitMembers: string[] }

/** 该库被哪些成员声明（相对根路径标签；只读快照，仅供排序与标记——spec §8 自决 10） */
async function hitMembersOf(rootDir: string, ws: Workspace, key: string): Promise<string[]> {
  const hits: DepHit[] = await findDependents(ws, key)
  return [...new Set(hits.map((h) => toRel(rootDir, h.manifestPath)))]
}

/** 读某个目录下 package.json 的 name（剥 BOM；缺失/坏 JSON/name 非字符串 → null） */
function readPkgName(dirAbs: string): string | null {
  try {
    const raw = readFileSync(join(dirAbs, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name !== '' ? parsed.name : null
  } catch {
    return null
  }
}

/** 候选集合（只读）：已注册组（★ 排序 / [已链接] / 零命中标记）+ 扫描发现组（spec §4.9） */
export async function collectLinkCandidates(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null, scanDirs: readonly string[],
): Promise<{ registered: LinkCandidate[]; discovered: DiscoveredLib[]; scanNotes: string[] }> {
  const links = st?.links ?? {}
  const registered: LinkCandidate[] = []
  for (const key of Object.keys(cfg?.libs ?? {})) {
    const v: unknown = (cfg?.libs as Record<string, unknown>)[key]
    const cfgIntact = typeof v === 'string'
    registered.push({
      key,
      rel: cfgIntact ? (v as string) : '',
      hitMembers: cfgIntact ? await hitMembersOf(rootDir, ws, key) : [],
      linked: Object.hasOwn(links, key),
      cfgIntact,
    })
  }
  // ★ 置顶：命中成员数降序；Array.prototype.sort 稳定 → 并列保持注册顺序（spec §2 裁决 9）
  registered.sort((a, b) => b.hitMembers.length - a.hitMembers.length)

  const known = new Set(registered.map((c) => c.key))
  const discovered: DiscoveredLib[] = []
  const scanNotes: string[] = []
  for (const dir of scanDirs) {
    if (typeof dir !== 'string') { scanNotes.push(`跳过无效的扫描目录项（非字符串）：${String(dir)}`); continue }
    let entries: Dirent[]
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('not-a-directory')
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      scanNotes.push(`跳过不可读的扫描目录：${dir}`)
      continue
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'node_modules' || ent.name.startsWith('.')) continue
      const abs = join(dir, ent.name)
      const name = readPkgName(abs)
      if (name === null || known.has(name) || discovered.some((d) => d.key === name)) continue
      discovered.push({ key: name, dirAbs: abs, dirLabel: abs, hitMembers: await hitMembersOf(rootDir, ws, name) })
    }
  }
  return { registered, discovered, scanNotes }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-picker.test.ts`
Expected: PASS（8 + 10 = 18 例）

- [ ] **Step 5: 回归（确认 link 直通未受影响）**

Run: `npx vitest run tests/unit/link-command.test.ts`
Expected: PASS（用例数不变）

- [ ] **Step 6: 类型检查 + 收尾**

Run: `npx tsc --noEmit --pretty` → 0 错误；Run: `git status --porcelain -uall`（只读）

---

### Task 4: link 交互入口（无参数分支）

**Files:**
- Modify: `src/commands/link.ts`（A1 分支改为交互入口 + 追加交互编排函数）
- **不改** `tests/unit/link-command.test.ts`（见 Step 4 裁定 R4-1：既有 A1 用例在新文案下自动成立）
- Create: `tests/unit/link-interactive.test.ts`

**Interfaces:**
- Consumes: T1 `renderPlan`；T2 `linkPreflight`/`buildLinkPlan`/`executeLinkPlan`/`linkPlanView`；T3 `parsePathInput`/`PathInputError`/`collectLinkCandidates`/`LinkCandidate`/`DiscoveredLib`；既有 `readUserConfig`/`writeUserConfig`（`src/state/index.js`，T4 新增 import）、`clack.groupMultiselect`/`clack.select`/`clack.text`/`clack.confirm`/`clack.isCancel`
- Produces（**均不导出**）：`runLinkInteractive(opts, cwd)`、`runPlanAndExecute(picked, ctx)`、`pickLinkTargets(cand, rootDir)`、`promptPaths()`、`emptyStateWizard()`、`addScanDir()`、符号 `CANCELLED`、常量 `OTHER_OPTION`、`LINK_USAGE`

**实现期裁定 2（需在 T7 回写 spec §8 自决 3）**：交互闸门（预览确认答否 / Ctrl+C）用**内联 `return 1`**，不抛错误——因此**不写失败留痕**，与 spec 自决 3 一致；而 `buildLinkPlan` 内的三态/B4 取消仍抛既有 `LinkCancelledError`（走既有 catch → 写留痕），**直通路径的这一行为一字不改**（自决 3 的「取消不写留痕」只适用于闸门取消）。

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/link-interactive.test.ts`（**必须带 `node:os` 的 homedir 隔离**，防测试读到真实 `~/.lpm/config.json`——手法取自 `tests/unit/state-files.test.ts:20-25`）：

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  select: vi.fn(), groupMultiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { select, groupMultiselect, confirm, text, isCancel } from '@clack/prompts'
import { runLink } from '../../src/commands/link.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** workspace：apps/web 依赖 @t/lib；**cfg.libs 默认为空**（注册由各用例用 registerLib 显式做） */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-li-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    ...files,
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
}
/** lib：真实存在的包目录（name 可指定——零命中剔除用例需要「存在但无人依赖」的库） */
function makeLib(name = '@t/lib'): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  mkdirSync(lib, { recursive: true })
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'package.json'), JSON.stringify({ name, main: './index.js' }), 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
}
/** 把「绝对 lib 路径」写进 ws 的 lpm.config.json（键 = 包名，值 = 相对根的路径） */
function registerLib(ws: string, key: string, libAbs: string): void {
  const p = join(ws, 'lpm.config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as { version: 1; packageManager?: string; libs: Record<string, string> }
  cfg.libs[key] = relative(ws, libAbs).replaceAll('\\', '/')
  writeFileSync(p, JSON.stringify(cfg), 'utf8')
}
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-home-'))
  dirs.push(home)
  osMock.home = home
  mkdirSync(join(home, '.lpm'), { recursive: true })
  return home
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}

beforeEach(() => {
  osMock.home = ''
  vi.clearAllMocks()
  vi.mocked(isCancel).mockReturnValue(false)
})

describe('link 交互入口', () => {
  it('LI-1：非 TTY 无参数 → 提示 + exit 1，且零菜单调用', async () => {
    const ws = makeWs(); makeLib()
    stubTty(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm link')
    expect(select).not.toHaveBeenCalled()
    expect(groupMultiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('LI-2：空态向导 → 输路径 → 隐形注册并执行', async () => {
    const lib = makeLib()
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('path')          // 向导：输路径
    vi.mocked(text).mockResolvedValueOnce(lib)               // 手输路径
    vi.mocked(confirm).mockResolvedValueOnce(true)           // 闸门：确认
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBeDefined()
  })

  it('LI-3：空态向导 → 加扫描目录 → 写入用户级 config 并重扫', async () => {
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const ws = makeWs()   // libs 为空 → 空态
    stubTty(true); const home = makeHome()
    vi.mocked(select).mockResolvedValueOnce('scan').mockResolvedValueOnce('quit')
    vi.mocked(text).mockResolvedValueOnce(scan)
    captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')).scanDirs).toContain(scan)
  })

  it('LI-4：空态向导 → 退出 → exit 0', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) })
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('quit')
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('还没有注册任何 lib')
  })

  it('LI-5：主列表选中 → 预览 → 确认「是」→ 执行', async () => {
    const lib = makeLib()
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(cap.out.join('')).toContain('改写 apps/web/package.json:')
    expect(cap.out.join('')).toContain('链接完成：1 个 lib')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('LI-6：确认答否 → 已取消 + exit 1 + 零写盘', async () => {
    makeLib(); const ws = makeWs()
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(execa).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('LI-7：Ctrl+C（isCancel）→ 已取消 + exit 1', async () => {
    makeLib(); const ws = makeWs()
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce([])
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('LI-8：空选中提交 → 未选择任何库 + exit 1', async () => {
    makeLib(); const ws = makeWs()
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('LI-9：勾选全为 [已链接] → 预览 + 无待执行变更 + confirm 零调用 + exit 0', async () => {
    const lib = makeLib()
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('LI-10：零命中项前置剔除，不连累同批其它项', async () => {
    const lib = makeLib()                 // 真实存在且在 apps/web 依赖中
    const none = makeLib('@t/none')       // 真实存在，但无人依赖 —— 触发零命中剔除
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    registerLib(ws, '@t/none', none)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib', '@t/none'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('未在任何成员依赖中，已跳过')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
  })

  it('LI-11：注册值损坏项被剔除 + 提示', async () => {
    makeLib()
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/bad': 42 } }) })
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/bad'])
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('注册值损坏，已跳过')
  })

  it('LI-12：无目标 + --dry-run → dry-run 计划 + 零写盘零子进程 + exit 0', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], { dryRun: true }, ws)).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(execa).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('LI-13：--watch 透传 → 预览里出现 watch 行', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runLink([], { dryRun: true, watch: true }, ws)).toBe(0)
    expect(cap.out.join('')).toContain('watch：拉起')
  })

  it('LI-14：「其他…」被勾选 → 提交后弹 text 并并入 targets', async () => {
    const lib = makeLib(); const ws = makeWs()
    registerLib(ws, '@t/lib', lib)   // 有已注册项 → 主列表出现（不进空态向导）
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__other__'])
    vi.mocked(text).mockResolvedValueOnce(lib)
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(text).toHaveBeenCalledTimes(1)          // 只来自「其他…」的输入通道
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
  })

  it('LI-15：三态弹问在 confirm 之前（统一前置判定的顺序断言）', async () => {
    const lib = makeLib()
    const ws = makeWs({
      // 声明值已是「非 lpm 管理的本地链接」→ 触发三态弹问（E4）
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }),
    })
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValue('abandon')       // 三态选「放弃」
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    await runLink([], {}, ws)
    expect(select).toHaveBeenCalled()
    const selOrder = vi.mocked(select).mock.invocationCallOrder[0]
    const gmOrder = vi.mocked(groupMultiselect).mock.invocationCallOrder[0]
    expect(gmOrder).toBeLessThan(selOrder)               // 先选库，再进行前置判定
    expect(confirm).not.toHaveBeenCalled()               // 放弃 → 计划为空 → 不进入确认
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('LI-16：勾选「扫描发现」项 → 以路径隐形注册并成功链接（T4 评审 Important-1 的回归钉）', async () => {
    const ws = makeWs()                                   // libs 为空：候选只能来自扫描发现
    const home = makeHome()
    const scanRoot = mkdtempSync(join(tmpdir(), 'lpm-scan-'))
    dirs.push(scanRoot)
    const lib = join(scanRoot, 'lib')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scanRoot] }), 'utf8')
    stubTty(true)
    vi.mocked(groupMultiselect).mockResolvedValueOnce([lib])   // 扫描发现项的 value = 库目录绝对路径
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(0)
    expect(JSON.stringify(vi.mocked(groupMultiselect).mock.calls[0]?.[0])).toContain('[未注册]')   // 该组确实出现
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('link:')
    expect(JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).libs['@t/lib']).toBeDefined()   // 隐形注册
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-interactive.test.ts`
Expected: FAIL —— 非 TTY 用例拿到的是旧占位文案；TTY 用例 `runLink` 直接 return 1

- [ ] **Step 3: 实现交互入口**

把 `link.ts` 的 A1 分支改为：

```ts
  // A1 无参数 → S9 交互入口（非 TTY 由入口内部拒绝，绝不进菜单）
  if (targets.length === 0) return await runLinkInteractive(opts, cwd)
```

并在 `runLink` **之前**追加（全部不导出）：

```ts
// ─────────────────────────── S9 交互入口（spec §4.5 / §4.7）───────────────────────────

const CANCELLED = Symbol('cancelled')

/** 「其他…」虚拟项的值（不会与真实包名冲突——包名不可能含 NUL） */
const OTHER_OPTION = '\u0000__other__'
const LINK_USAGE = 'lpm link <名字|路径>... [--watch] [--dry-run]'

/** 手输路径：3 次重试（镜像 ternaryOriginal 的手动通道）；取消 → CANCELLED；耗尽 → [] */
async function promptPaths(): Promise<string[] | typeof CANCELLED> {
  for (let i = 0; i < 3; i++) {
    const inp = await clack.text({ message: '输入 lib 路径（多个用空格分隔，含空格加引号）' })
    if (clack.isCancel(inp)) return CANCELLED
    try {
      return parsePathInput(String(inp))
    } catch (err) {
      process.stderr.write(`${(err as Error).message}。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号\n`)
    }
  }
  return []
}

/** 空态向导（spec §4.7）：输路径 / 加扫描目录 / 退出 */
async function emptyStateWizard(): Promise<'path' | 'scan' | 'quit' | typeof CANCELLED> {
  const picked = await clack.select({
    message: '还没有注册任何 lib，选一个下一步',
    options: [
      { value: 'path', label: '输入 lib 路径', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' },
      { value: 'scan', label: '添加扫描目录', hint: '写入用户级 scanDirs，以后自动发现' },
      { value: 'quit', label: '退出' },
    ],
  })
  if (clack.isCancel(picked)) return CANCELLED
  return picked as 'path' | 'scan' | 'quit'
}

/** 「添加扫描目录」：必须已存在的绝对路径；读-改-写（保留未知字段）；失败留在向导（spec §4.7 / §4.9） */
async function addScanDir(): Promise<void> {
  const inp = await clack.text({ message: '输入扫描目录（已存在的绝对路径）', placeholder: 'D:\\Seed\\libs' })
  if (clack.isCancel(inp)) return
  const dir = String(inp).trim()
  let ok = false
  try {
    ok = isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    process.stderr.write(`扫描目录必须是已存在的绝对路径：${dir}。示例：D:\\Seed\\libs\n`)
    return
  }
  try {
    const cur = await readUserConfig()
    if (!cur.scanDirs.includes(dir)) await writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, dir] })
    process.stdout.write(`已加入扫描目录：${dir}\n`)
  } catch (err) {
    process.stderr.write(`无法写入用户级配置：${(err as Error).message}。可改用手输路径，或修正后重试\n`)
  }
}

/** 主列表多选（spec §4.5）：分组 + 「其他…」；返回 target 原文数组 */
async function pickLinkTargets(
  cand: { registered: LinkCandidate[]; discovered: DiscoveredLib[] },
): Promise<string[] | typeof CANCELLED> {
  const groups: Record<string, Array<{ value: string; label: string; hint?: string }>> = {}
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
      label: `${d.key}  [未注册]`,
      hint: d.hitMembers.length === 0 ? `${d.dirLabel}｜未在依赖中，链接前需先 pnpm add` : d.dirLabel,
    }))
  }
  groups['其他'] = [{ value: OTHER_OPTION, label: '其他…（手输路径）', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' }]

  const picked = await clack.groupMultiselect({ message: '选择要链接的库（空格勾选，回车确认）', options: groups })
  if (clack.isCancel(picked)) return CANCELLED
  const values = (picked as string[]).filter((v) => v !== OTHER_OPTION)
  // 「其他…」不是最终勾选项：提交后若被勾选，先弹输入并把解析出的 target 并入（spec §4.5）
  if ((picked as string[]).includes(OTHER_OPTION)) {
    const raws = await promptPaths()
    if (raws === CANCELLED) return CANCELLED
    return [...values, ...raws]
  }
  return values
}

/** 计划 → 预览 → 一次确认 → 执行（spec §4.4 / §4.11）；空态手输路径也走这里 */
async function runPlanAndExecute(
  picked: readonly string[],
  ctx: {
    opts: LinkOptions; rootDir: string; cwd: string; ws: Workspace; cfg: ProjectLpmConfig | null; pm: PackageManagerId
    st: LinkState | null; traceChanges: LastRunTrace['changes']; traceInstalls: LastRunTrace['installs']
  },
): Promise<number> {
  // 前置剔除（注册值损坏——纯本地判定、无副作用；spec §4.5）
  const keep: string[] = []
  for (const raw of picked) {
    const libs = ctx.cfg?.libs ?? {}
    if (Object.hasOwn(libs, raw) && typeof (libs as Record<string, unknown>)[raw] !== 'string') {
      process.stdout.write(`⚠️ ${raw} 注册值损坏，已跳过——请修正 lpm.config.json 后重试\n`)
      continue
    }
    keep.push(raw)
  }
  if (keep.length === 0) {
    process.stdout.write('  无待执行变更\n')
    return 0
  }
  const plan = await buildLinkPlan({
    targets: keep, opts: ctx.opts, rootDir: ctx.rootDir, cwd: ctx.cwd, ws: ctx.ws, cfg: ctx.cfg, pm: ctx.pm, st: ctx.st,
    traceChanges: ctx.traceChanges, traceInstalls: ctx.traceInstalls, pruneZeroHit: true,
  })
  for (const p of plan.pruned) process.stdout.write(`${p}\n`)
  const view = linkPlanView(plan, ctx.opts)
  // 计划为空（勾选全为 [已链接] 或全被剔除）：打印计划 + 「无待执行变更」+ 不确认（spec §4.4）
  if (plan.aggregated.size === 0) {
    process.stdout.write(renderPlan(view, 'preview'))
    process.stdout.write('  无待执行变更\n')
    return 0
  }
  if (ctx.opts.dryRun === true) {
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
  process.stdout.write(renderPlan(view, 'preview'))
  const ok = await clack.confirm({
    message: `执行以上计划？（改写 ${plan.aggregated.size} 个文件、执行 1 次安装）`,
    initialValue: false,
  })
  // 闸门取消：内联 return（不抛 → 不写失败留痕，spec §8 自决 3 / 实现期裁定 2）
  if (clack.isCancel(ok) || ok !== true) {
    process.stdout.write('已取消\n')
    return 1
  }
  return await executeLinkPlan(plan, ctx.opts)
}

/** link 交互入口：空态向导 → 主列表 → 计划预览 → 确认 → 执行（spec §4.5 / §4.7 / §4.10） */
async function runLinkInteractive(opts: LinkOptions, cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${LINK_USAGE}\n`)
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, ws, cfg, pm } = await linkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)
    for (;;) {
      const { scanDirs } = await readUserConfig() // 坏 JSON → LpmStateParseError 透传（spec §4.9）
      const cand = await collectLinkCandidates(rootDir, ws, cfg, st, scanDirs)
      if (cand.registered.length > 0 || cand.discovered.length > 0) {
        for (const n of cand.scanNotes) process.stdout.write(`${n}\n`)
        const picked = await pickLinkTargets(cand)
        if (picked === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
        if (picked.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
        return await runPlanAndExecute(picked, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
      }
      // 空态（两组皆空）→ 向导
      const step = await emptyStateWizard()
      if (step === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
      if (step === 'quit') return 0
      if (step === 'scan') { await addScanDir(); continue }   // 成功/失败都回主列表重扫
      const raws = await promptPaths()
      if (raws === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
      if (raws.length === 0) continue
      return await runPlanAndExecute(raws, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls })
    }
  } catch (err) {
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('link', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
```

import 追加（与上面的代码合并进**同一次编辑**）：`readUserConfig`、`writeUserConfig` 并入既有 `../state/index.js` 的 import 块；`isAbsolute` 已在 T3 加入。

- [ ] **Step 4: 既有「A1 无参数」用例 —— 零改动（裁定 R4-1）**

**不要改** `tests/unit/link-command.test.ts`。其既有用例 `T4-1 无参数 → 用法提示 + exit 1`（`link-command.test.ts:98-102`）断言的是 `cap.stdout()).toContain('lpm link <名字|路径>')` 与 `exit 1`——非 TTY 下新文案 `当前不是交互终端；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]` **同时满足这两条**，故该用例在新行为下自动成立（brief 原先假设它断言的是 `交互模式随 S9 上线` 占位文案，实测该字符串只存在于源码、不在测试里）。

→ **回归判据**：`link-command.test.ts` 保持 **39/39 且文件零改动**；新契约（非 TTY 提示 + exit 1）由本任务新增的 `LI-1` 断言。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-interactive.test.ts tests/unit/link-command.test.ts`
Expected: PASS（link-interactive **16** 例；link-command 例数与改造前一致且文件零改动）

- [ ] **Step 6: 全量回归 + 类型检查**

Run: `pnpm verify`
Expected: exit 0；unit 用例数 = 353（T1–T3 后实测）+ **16** = **369**；e2e **26/26**（若数字不符，先查是否有用例被静默跳过）

- [ ] **Step 7: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读）

---

### Task 5: unlink 编排拆分 + 列表数据源（collectLinkedItems）

**Files:**
- Modify: `src/commands/unlink.ts`（原地拆分 `runUnlink`；dry-run 改走 `renderPlan`；追加 `collectLinkedItems`/`LinkedItem` 导出）
- Create: `tests/unit/unlink-interactive.test.ts`（本任务先放 UI-1…UI-6 的列表数据源用例；T6 追加交互用例）
- Test: `tests/unit/unlink-command.test.ts`（**不改**——既有断言就是本任务的判据）

**Interfaces:**
- Consumes: T1 `renderPlan`/`PlanView`/`PlanEntry`；既有 `findWorkspaceRoot`/`loadWorkspace`/`readProjectConfig`/`resolvePackageManager`/`readState`/`resolveTarget`/`resolveMonorepo`/`validateEntry`/`verifyResidue`/`runInstall`/`runForceInstall`/`buildInstallCommandLine`/`buildForceInstallCommandLine`/`writeState`/`deleteState`/`writeLast`/`writeTextFileAtomic`/`writeRunTrace`/`buildRunTrace`/`traceFailure`
- Produces（`UnlinkPlan` 与三个函数**不导出**；仅 `LinkedItem` / `collectLinkedItems` 导出）：
  ```ts
  interface UnlinkPlan {
    rootDir: string; cwd: string; pm: PackageManagerId; cfg: ProjectLpmConfig | null; st: LinkState | null
    targets: readonly string[]
    aggregated: Map<string, FileAgg>
    pendingDelete: string[]
    verifyManifests: Map<string, string[]>
    planSkipped: string[]; planAbandoned: string[]; planConflicts: string[]; planMissing: string[]
    planIdempotent: Array<{ key: string; rel: string }>
    dedupSkipped: number; totalChanged: number; restoredKeyCount: number
    traceChanges: LastRunTrace['changes']; traceInstalls: LastRunTrace['installs']
  }
  async function unlinkPreflight(cwd: string): Promise<{ rootDir: string; cfg: ProjectLpmConfig | null; pm: PackageManagerId }>
  async function buildUnlinkPlan(args: {
    targets: readonly string[]; opts: UnlinkOptions; rootDir: string; cwd: string
    cfg: ProjectLpmConfig | null; pm: PackageManagerId; st: LinkState | null
    traceChanges: LastRunTrace['changes']; traceInstalls: LastRunTrace['installs']
  }): Promise<UnlinkPlan>
  async function executeUnlinkPlan(plan: UnlinkPlan): Promise<number>
  function unlinkPlanView(plan: UnlinkPlan): PlanView
  function unlinkPlanIsEmpty(plan: UnlinkPlan): boolean
  export interface LinkedItem {
    key: string; rel: string; restoreTo: string[]; linkedMembers: string[]
    drifted: boolean; corrupt: boolean
  }
  export async function collectLinkedItems(
    rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null,
  ): Promise<LinkedItem[]>
  ```

**实现期裁定 3（需在 T7 回写 spec §4.6）**：`collectLinkedItems` 对判定面 `scanLinkState` 用**动态 import**（`const { scanLinkState } = await import('./status.js')`）——因为 `status.ts` 已经静态 import `unlink.ts` 的 `validateEntry` / `LinkStateCorruptError`（S8 落地），若 unlink 再静态 import status 就形成**静态循环依赖**。动态 import 语义等价（spec §4.6 要求的「判定面复用」照旧成立），且不引循环。

**抽取边界（行号取自 HEAD `0b78b49` 的 `src/commands/unlink.ts`，共 464 行）**：

| 现位置 | 归属 | 说明 |
|---|---|---|
| 133–138 | `runUnlink` 保留 | A1 无参数（且非 `--all`）分支（**T6 改成交互入口**；本任务先保持原样） |
| 139–149 | `runUnlink` 保留 | trace 声明 + A2 互斥校验 |
| 150–161 | → `unlinkPreflight`（**不含 `readState`**） | `findWorkspaceRoot` → `loadWorkspace`（仅校验副作用）→ `readProjectConfig` → `resolvePackageManager`；“检测到包管理器”打印留此处。**`readState` 留在调用方**（`runUnlink` / T6 的交互入口），紧跟 `traceRoot`/`tracePm` 赋值之后——与 link 侧（T2 的 `linkPreflight`）同形，且保住既有行为：`.lpm/state.json` 损坏时 `catch` 仍能定位 `rootDir`/`pm` 并写失败留痕（T5 实现者上报的差异，控制方裁定后修正） |
| 163–166 | `runUnlink` 保留 | G5 `--all` 空 state 早退（**逐字不动**，位于 `readState` 之后、赋值之后） |
| 168–199 | → `buildUnlinkPlan` | B target 解析（`--all` 全量 keys / 显式逐个解析 + 去重） |
| 201–325 | → `buildUnlinkPlan` | C/D 逐 key 校验 + 逐文件三态（含冲突二选一 `clack.select`、放弃回滚），**逐字搬运** |
| 327–355 | **删除** | 原 dry-run 打印块 → `unlinkPlanView` + `renderPlan(..., 'dry-run')` |
| 357–451 | → `executeUnlinkPlan` | E1 恢复文件 → E2 install → F 复验/`--force` → G 删 state + last → I/J 完成提示 → 留痕，**逐字搬运** |
| 452–463 | `runUnlink` 保留 | catch，**逐字不动** |

- [ ] **Step 1: 写失败测试（列表数据源）**

创建 `tests/unit/unlink-interactive.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLinkedItems } from '../../src/commands/unlink.js'
import { loadWorkspace } from '../../src/core/workspace.js'
import type { LinkState, ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-ui-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n  - 'apps/server'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': '../../lpm-lib' } }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
    'apps/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@t/lib': 'link:../../lpm-lib' } }),
    ...files,
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
}
const cfgOf = (libs: Record<string, string> = { '@t/lib': '../../lpm-lib' }): ProjectLpmConfig => ({ version: 1, libs })

describe('collectLinkedItems', () => {
  it('UI-1：列表 = state.links 键；restoreTo = original 值去重', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.key)).toEqual(['@t/lib'])
    expect(items[0].restoreTo).toEqual(['^1.0.0'])
    expect(items[0].linkedMembers).toEqual(['apps/web', 'apps/server'])
  })
  it('UI-2：多文件异值 → restoreTo 并列保留', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^2.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items[0].restoreTo).toEqual(['^1.0.0', '^2.0.0'])
  })
  it('UI-3：[漂移] 标记 = state 有条目但声明已回到正式版本号', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }) })
    const st: LinkState = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items[0].drifted).toBe(true)
  })
  it('UI-4：损坏条目 → corrupt=true 且不崩（读取守卫）', async () => {
    const ws = makeWs()
    const st = { version: 1, links: { '@t/lib': null, '@t/two': { original: {} } } } as unknown as LinkState
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.corrupt)).toEqual([true, true])
    expect(items[0].restoreTo).toEqual([])
  })
  it('UI-5：state 无条目 → 空数组', async () => {
    const ws = makeWs()
    expect(await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), null)).toEqual([])
  })
  it('UI-6：列表顺序 = state.links 键顺序', async () => {
    const ws = makeWs()
    const st: LinkState = { version: 1, links: {
      '@t/two': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
      '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
    } }
    const items = await collectLinkedItems(ws, await loadWorkspace(ws), cfgOf(), st)
    expect(items.map((i) => i.key)).toEqual(['@t/two', '@t/lib'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/unlink-interactive.test.ts`
Expected: FAIL —— `collectLinkedItems is not a function`

- [ ] **Step 3: 拆分 + 实现列表数据源**

按上表就地拆分 `runUnlink`（新结构除 `runUnlink` / `collectLinkedItems` / `LinkedItem` 外**全部不导出**）：

```ts
async function unlinkPreflight(cwd: string): Promise<{ rootDir: string; cfg: ProjectLpmConfig | null; pm: PackageManagerId }> {
  const rootDir = await findWorkspaceRoot(cwd)
  await loadWorkspace(rootDir) // 仅取校验副作用（WorkspacePatternError 等）——OCR：勿保留死绑定
  const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
  const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
  if (pmResolution.source === 'detected') {
    process.stdout.write(`检测到包管理器：${pmResolution.pm}（未 lpm use 固化）\n`)
  }
  // 注意：readState **不在这里**——留在调用方紧跟 traceRoot/tracePm 赋值之后（与 link 同形；
  // 且 state 损坏时 catch 仍能定位 rootDir/pm 写失败留痕）
  return { rootDir, cfg, pm: pmResolution.pm }
}

/** 已链接列表数据源（spec §4.6）：state.links 键 × status 判定面（动态 import 规避静态循环） */
export interface LinkedItem {
  key: string; rel: string; restoreTo: string[]; linkedMembers: string[]
  drifted: boolean; corrupt: boolean
}

export async function collectLinkedItems(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null,
): Promise<LinkedItem[]> {
  const { scanLinkState } = await import('./status.js')
  const scan = await scanLinkState(rootDir, ws, cfg, st)
  const byKey = new Map(scan.entries.map((e) => [e.key, e]))
  const links = st?.links ?? {}
  const out: LinkedItem[] = []
  for (const key of Object.keys(links)) {
    const e = byKey.get(key)
    // 读取守卫（spec §4.6）：条目可能为 null / 非对象 / original 结构非法——绝不直接读字段
    const rawEntry = Object.hasOwn(links, key) ? (links as Record<string, unknown>)[key] : undefined
    const entryObj = rawEntry !== null && typeof rawEntry === 'object' && !Array.isArray(rawEntry)
      ? (rawEntry as { original?: unknown })
      : null
    const origRaw = entryObj?.original
    const origObj = origRaw !== null && typeof origRaw === 'object' && !Array.isArray(origRaw)
      ? (origRaw as Record<string, unknown>)
      : {}
    const rels = Object.keys(origObj).filter((k) => typeof origObj[k] === 'string')
    const cfgVal: unknown = (cfg?.libs as Record<string, unknown> | undefined)?.[key]
    out.push({
      key,
      rel: typeof cfgVal === 'string' ? cfgVal : '',
      restoreTo: [...new Set(rels.map((r) => String(origObj[r])))],
      linkedMembers: [...new Set(rels.map((r) => (r.endsWith('/package.json') ? r.slice(0, -'/package.json'.length) : '（根）')))],
      drifted: e?.issues.includes('drifted') ?? false,
      corrupt: e?.issues.includes('corrupt') ?? false,
    })
  }
  return out
}

/** 计划 → 共享视图（行序 = 既有 dry-run 行序，逐字兼容 spec §4.4） */
function unlinkPlanIsEmpty(plan: UnlinkPlan): boolean {
  return plan.aggregated.size === 0 && plan.pendingDelete.length === 0
    && plan.planConflicts.length === 0 && plan.planMissing.length === 0 && plan.planSkipped.length === 0
}

function unlinkPlanView(plan: UnlinkPlan): PlanView {
  const entries: PlanEntry[] = []
  for (const [mp, agg] of plan.aggregated) {
    if (agg.hits.length === 0) continue
    entries.push({ kind: 'group', heading: `恢复 ${toRel(plan.rootDir, mp)}:`,
      lines: agg.hits.map((h) => `${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}`) })
  }
  for (const p of plan.planIdempotent) entries.push({ kind: 'line', text: `已恢复跳过：${p.key}（${p.rel} 值已等于 original）` })
  for (const k of plan.planSkipped) entries.push({ kind: 'line', text: `未链接跳过：${k}` })
  for (const c of plan.planConflicts) entries.push({ kind: 'line', text: `冲突需确认：${c}——真实执行时将询问` })
  for (const m of plan.planMissing) entries.push({ kind: 'line', text: `文件不存在警告：${m}` })
  let install: PlanView['install'] = null
  if (plan.pendingDelete.length > 0) {
    const remainCount = Object.keys(plan.st?.links ?? {}).length - plan.pendingDelete.length
    if (remainCount === 0) {
      entries.push({ kind: 'line', text: `state：清空——last 记 ${JSON.stringify(Object.keys(plan.st?.links ?? {}))} → 删 state 文件` })
    } else {
      for (const k of plan.pendingDelete) entries.push({ kind: 'line', text: `state：删除 ${k}（剩余 ${remainCount} 条）` })
    }
    install = { command: buildInstallCommandLine(plan.pm), verify: `node_modules 实际指向（残留/缺失将 ${buildForceInstallCommandLine(plan.pm)} 重建）` }
  }
  if (unlinkPlanIsEmpty(plan)) entries.push({ kind: 'line', text: '无待执行变更' })
  return { entries, install, watch: [] }
}

/** 执行（写序 = S7 裁决：恢复文件 → install 成功 → 才删 state）——逐字搬运原 357–451 */
async function executeUnlinkPlan(plan: UnlinkPlan): Promise<number> { /* … */ }
```

`runUnlink` 瘦身后（**签名与 A1/A2/G5 分支本任务保持原样**）：

```ts
export async function runUnlink(targets: readonly string[], opts: UnlinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数（--all 除外——spec §4.1）（T6 改为交互入口）
  if (targets.length === 0 && opts.all !== true) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm unlink <名字|路径>... [--all] [--dry-run]\n')
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    if (opts.all === true && targets.length > 0) throw new LinkArgumentError('--all', '--all 与显式目标互斥')
    const { rootDir, cfg, pm } = await unlinkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)   // 紧跟赋值之后（与 link 同形；保住 state 损坏时的失败留痕）
    if (opts.all === true && Object.keys(st?.links ?? {}).length === 0) {
      process.stdout.write('无已链接项\n')   // G5
      return 0
    }
    const plan = await buildUnlinkPlan({ targets, opts, rootDir, cwd, cfg, pm, st, traceChanges, traceInstalls })
    if (opts.dryRun === true) {
      process.stdout.write(renderPlan(unlinkPlanView(plan), 'dry-run'))
      return 0
    }
    return await executeUnlinkPlan(plan)
  } catch (err) {
    // 逐字不动（S8 §4.6）
  }
}
```

- [ ] **Step 4: 跑测试 + 回归**

Run: `npx vitest run tests/unit/unlink-interactive.test.ts tests/unit/unlink-command.test.ts`
Expected: PASS（UI-1…UI-6 共 6 例；unlink-command 例数与改造前一致 = dry-run 文案逐字兼容）

Run: `npx tsc --noEmit --pretty` → 0 错误

- [ ] **Step 5: 全量验证**

Run: `pnpm verify`
Expected: exit 0；unit = 基线 324 + 11 + 18 + 15（T1–T4）+ **6** = **374**；e2e **26/26**

- [ ] **Step 6: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读）

---

### Task 6: unlink 交互入口（无参数分支）

**Files:**
- Modify: `src/commands/unlink.ts`（A1 分支改为交互入口 + 追加交互编排函数）
- **不改** `tests/unit/unlink-command.test.ts`（见 Step 4 裁定 R6-1：既有 UNL-1 用例只断言 exit 1，在新行为下自动成立）
- Modify: `tests/unit/unlink-interactive.test.ts`（追加 UI-7…UI-18）

**Interfaces:**
- Consumes: T1 `renderPlan`；T5 `unlinkPreflight`/`buildUnlinkPlan`/`executeUnlinkPlan`/`unlinkPlanView`/`unlinkPlanIsEmpty`/`collectLinkedItems`/`LinkedItem`；T3/T4 已在 link.ts 导出的 `parsePathInput`/`PathInputError`；既有 `resolveTarget`/`resolveMonorepo`（已 import）、`clack.multiselect`/`clack.text`/`clack.confirm`/`clack.isCancel`
- Produces（**均不导出**）：`runUnlinkInteractive(opts, cwd)`、`pickLinkedKeys(items, ctx)`、`promptUnlinkPaths()`、`UNLINK_USAGE`、`PATH_OPTION`（复用 link.ts 未导出的 `CANCELLED` 语义时在 unlink.ts 内**另定义同名局部符号**，避免为符号扩导出面）

**实现期裁定 4（需在 T7 回写 spec §4.4）**：交互模式的「计划为空」分支在 link 侧会多打一条**带两空格缩进**的 `  无待执行变更`（spec §4.4 明文），而 link **直通 dry-run** 的空分支沿用 S6 现状（`无待执行变更`，**无缩进**，且只打这一行、不列跳过明细）。两者都保持各自既有形态——原因是「dry-run 逐字兼容」是硬约束（既有测试断言），而预览需要让人看懂「为什么没事可做」。spec §4.4 的「两模式只差首行」应限定为**非空计划**。

- [ ] **Step 1: 写失败测试（交互入口）**

在 `tests/unit/unlink-interactive.test.ts` 末尾追加（沿用文件头已有的 `makeWs` / `dirs` 与 `node:os` homedir 隔离；若本文件尚无 mock 段，按 T4 的 `link-interactive.test.ts` 同款加 `vi.mock('@clack/prompts')` 与 `vi.mock('execa')`，并在 `beforeEach` 里 `vi.mocked(isCancel).mockReturnValue(false)`）：

```ts
describe('unlink 交互入口', () => {
  function wsLinked(): string {
    return makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0', 'apps/server/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
  }

  it('UI-7：非 TTY 无参数 → 提示 + exit 1，零菜单调用', async () => {
    const ws = wsLinked(); stubTty(false)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm unlink')
    expect(multiselect).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('UI-8：无已链接项 → 三去向提示 + exit 0', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: {} }) })
    stubTty(true); makeHome()
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('当前没有已链接的库')
    expect(cap.out.join('')).toContain('lpm forget')
    expect(cap.out.join('')).toContain('待 S11 上线')
  })

  it('UI-9：列表多选 → 预览 → 确认「是」→ 执行（恢复 + install + 删 state）', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('执行计划预览：')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })

  it('UI-10：确认答否 → 已取消 + exit 1 + 零写盘', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(false)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('UI-11：Ctrl+C → 已取消 + exit 1', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('UI-12：空选中提交 → 未选择任何库 + exit 1', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('UI-13：corrupt 项前置剔除，不连累同批其它项', async () => {
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' },
        '@t/bad': null,
      } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib', '@t/bad'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('记录损坏，已跳过')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('UI-14：按路径取消 → 已在链接列表并入；未在则提示且流程继续', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__path__'])
    vi.mocked(text).mockResolvedValueOnce('@t/lib ../../not-linked')   // 前者已注册且在链接列表；后者不在
    vi.mocked(confirm).mockResolvedValueOnce(true)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(cap.out.join('')).toContain('当前未处于链接状态')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })

  it('UI-15：计划为空 → 无待执行变更 + confirm 零调用 + exit 0', async () => {
    // 裁定 R6-3（T6 实现者上报、控制方核定）：brief 原 fixture 用 state original = apps/web/package.json
    // 会产出「恢复」计划（非空）；unlink 的空计划判据（aggregated 空 **且** pendingDelete 空）
    // 只在「original 指向的文件不存在」时成立（全文件缺失 → 条目保留、不进待删集，spec §8 自决 5）。
    // 注意「幂等跳过」**不算**空计划（该 key 仍进待删集，执行阶段确有 install + 删档动作）。
    const ws = makeWs({
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(confirm).not.toHaveBeenCalled()
    expect(cap.out.join('')).toContain('无待执行变更')
  })

  it('UI-16：无目标 + --dry-run → dry-run 计划整段逐字 + 零写盘零子进程 + exit 0', async () => {
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    const cap = captureOut()
    expect(await runUnlink([], { dryRun: true }, ws)).toBe(0)
    // 「dry-run 逐字兼容」是硬约束，而 unlink 的 dry-run 整块此前只有 toContain 级断言（T5 实现者上报的缺口）
    // → 这里固化为**整段黄金断言**（内容取自改造前的 dry-run 打印块，逐行核对过）
    expect(cap.out.join('')).toBe(
      'dry-run 执行计划（不落任何盘、不执行任何子进程）：\n'
      + '  恢复 apps/web/package.json:\n'
      + '    dependencies.@t/lib：link:../../lpm-lib → ^1.0.0\n'
      + '  恢复 apps/server/package.json:\n'
      + '    dependencies.@t/lib：link:../../lpm-lib → ^1.0.0\n'
      + '  state：清空——last 记 ["@t/lib"] → 删 state 文件\n'
      + '  install：pnpm install --no-frozen-lockfile（workspace 根）\n'
      + '  复验：node_modules 实际指向（残留/缺失将 pnpm install --force 重建）\n',
    )
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })

  it('UI-17：列表 label 含恢复去向与 [漂移] 标记', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }),
    })
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce([])
    const cap = captureOut()
    await runUnlink([], {}, ws)
    const labels = JSON.stringify(vi.mocked(multiselect).mock.calls[0]?.[0])
    expect(labels).toContain('apps/web')
    expect(labels).toContain('^1.0.0')
    expect(labels).toContain('[漂移]')
    expect(cap.out.join('')).toContain('未选择任何库')
  })

  it('UI-18：写序——恢复文件先于 install；state 删除在 install 成功之后（崩溃安全顺序）', async () => {
    // 补齐 brief 缺失的第 12 例（plan 声明 UI-7…UI-18 共 12 例，但 Step 1 代码块止于 UI-17——T6 实现者上报的计数不一致）
    // 契约取自 spec §6「预览 → 确认 → 执行（写序：文件恢复在前、state 删除在后、install 成功才删 state）」
    const ws = wsLinked()
    stubTty(true); makeHome()
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/lib'])
    vi.mocked(confirm).mockResolvedValueOnce(true)
    let pkgAtInstall = ''
    let stateExistsAtInstall = false
    vi.mocked(execa).mockImplementation((async () => {
      // install 被调用的那一刻：声明应已恢复、state 应仍在（尚未删）
      pkgAtInstall = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
      stateExistsAtInstall = existsSync(join(ws, '.lpm', 'state.json'))
      return { exitCode: 0 } as never
    }) as never)
    captureOut()
    expect(await runUnlink([], {}, ws)).toBe(0)
    expect(pkgAtInstall).toContain('^1.0.0')                        // 恢复先于 install
    expect(stateExistsAtInstall).toBe(true)                         // state 删除在 install 成功之后
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)  // 最终已删
  })
})
```

> 本组用例需要与 T4 同款的本地 helper（`stubTty` / `captureOut` / `makeHome`）与 clack/execa mock；若 T5 的 Step 1 未建这些，**在同一次编辑里补齐**（文件头 mock 段 + helper 段），import 需含 `runUnlink`、`multiselect`、`execa`、`isCancel`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/unlink-interactive.test.ts`
Expected: FAIL —— TTY 用例拿到旧占位文案

- [ ] **Step 3: 实现交互入口**

把 `unlink.ts` 的 A1 分支改为：

```ts
  // A1 无参数（--all 除外）→ S9 交互入口（非 TTY 由入口内部拒绝）
  if (targets.length === 0 && opts.all !== true) return await runUnlinkInteractive(opts, cwd)
```

并在 `runUnlink` **之前**追加（全部不导出）：

```ts
// ─────────────────────────── S9 交互入口（spec §4.6 / §4.7）───────────────────────────

const CANCELLED_U = Symbol('cancelled')
const PATH_OPTION = '\u0000__path__'
const UNLINK_USAGE = 'lpm unlink <名字|路径>... [--all] [--dry-run]'

/** 按路径取消的输入通道：3 次重试；取消 → CANCELLED_U；耗尽 → [] */
async function promptUnlinkPaths(): Promise<string[] | typeof CANCELLED_U> {
  for (let i = 0; i < 3; i++) {
    const inp = await clack.text({ message: '输入要取消的路径（多个用空格分隔，含空格加引号）' })
    if (clack.isCancel(inp)) return CANCELLED_U
    try {
      return parsePathInput(String(inp))
    } catch (err) {
      process.stderr.write(`${(err as Error).message}。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号\n`)
    }
  }
  return []
}

/** 列表多选（spec §4.6）：包名 +（链接的子包）+ 将恢复的 range + [漂移]/[记录损坏]；附「按路径取消…」 */
async function pickLinkedKeys(
  items: LinkedItem[],
  ctx: { rootDir: string; cfg: ProjectLpmConfig | null },
): Promise<string[] | typeof CANCELLED_U> {
  const options: Array<{ value: string; label: string }> = items.map((it) => ({
    value: it.key,
    label: `${it.key}`
      + (it.linkedMembers.length > 0 ? `（${it.linkedMembers.join('、')}）` : '')
      + (it.restoreTo.length > 0 ? ` → ${it.restoreTo.join(' / ')}` : '')
      + (it.drifted ? '  [漂移]' : '')
      + (it.corrupt ? '  [记录损坏]' : ''),
  }))
  options.push({ value: PATH_OPTION, label: '按路径取消…（手输路径）' })
  const picked = await clack.multiselect({ message: '选择要取消链接的库（空格勾选，回车确认）', options, required: false })
  if (clack.isCancel(picked)) return CANCELLED_U
  const values = (picked as string[]).filter((v) => v !== PATH_OPTION)
  if (!(picked as string[]).includes(PATH_OPTION)) return values
  const raws = await promptUnlinkPaths()
  if (raws === CANCELLED_U) return CANCELLED_U
  for (const raw of raws) {
    // 路径 → key（复用直通解析链；解析失败/不在注册表 → 一律按「未处于链接状态」处理，不中断）
    let key = raw
    const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
    const registered = Object.hasOwn(ctx.cfg?.libs ?? {}, raw)
    if (!registered && looksLikePath && !raw.startsWith('@')) {
      try {
        const rt = await resolveTarget(raw, ctx.cfg, ctx.rootDir, ctx.rootDir)
        key = rt.source === 'name' ? rt.key : ((await resolveMonorepo(rt.libDirAbs)).name || toRel(ctx.rootDir, rt.libDirAbs))
      } catch {
        process.stdout.write(`当前未处于链接状态：${raw}。可用 lpm status 核对三方状态\n`)
        continue
      }
    }
    if (items.some((i) => i.key === key)) values.push(key)
    else process.stdout.write(`当前未处于链接状态：${raw}。可用 lpm status 核对三方状态\n`)
  }
  return values
}

/** unlink 交互入口：列表 → 预览 → 确认 → 执行（spec §4.6 / §4.7 / §4.10） */
async function runUnlinkInteractive(opts: UnlinkOptions, cwd: string): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${UNLINK_USAGE}\n`)
    return 1
  }
  let traceRoot: string | null = null
  let tracePm: PackageManagerId | null = null
  const traceChanges: LastRunTrace['changes'] = []
  const traceInstalls: LastRunTrace['installs'] = []
  try {
    const { rootDir, cfg, pm } = await unlinkPreflight(cwd)
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)   // 与 runUnlink 同形：紧跟赋值之后
    const ws = await loadWorkspace(rootDir)
    const items = await collectLinkedItems(rootDir, ws, cfg, st)
    if (items.length === 0) {
      // 空态三去向（spec §4.7）；forget 待 S11 上线故加注
      process.stdout.write('当前没有已链接的库。\n')
      process.stdout.write('  lpm link    把依赖切到本地目录联调\n')
      process.stdout.write('  lpm status  核对三方状态\n')
      process.stdout.write('  lpm forget  移除 lib 注册（待 S11 上线）\n')
      return 0
    }
    const picked = await pickLinkedKeys(items, { rootDir, cfg })
    if (picked === CANCELLED_U) { process.stdout.write('已取消\n'); return 1 }
    if (picked.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
    // 前置剔除：记录损坏项（spec §4.6）——否则 buildUnlinkPlan 抛 LinkStateCorruptError 会炸掉整批
    const keep: string[] = []
    for (const k of picked) {
      if (items.some((i) => i.key === k && i.corrupt)) {
        process.stdout.write(`⚠️ ${k} 记录损坏，已跳过——请先 lpm repair\n`)
        continue
      }
      keep.push(k)
    }
    if (keep.length === 0) { process.stdout.write('  无待执行变更\n'); return 0 }
    const plan = await buildUnlinkPlan({ targets: keep, opts, rootDir, cwd, cfg, pm, st, traceChanges, traceInstalls })
    const view = unlinkPlanView(plan)
    if (plan.aggregated.size === 0 && plan.pendingDelete.length === 0) {
      process.stdout.write(renderPlan(view, 'preview'))
      process.stdout.write('  无待执行变更\n')
      return 0
    }
    if (opts.dryRun === true) { process.stdout.write(renderPlan(view, 'dry-run')); return 0 }
    process.stdout.write(renderPlan(view, 'preview'))
    const ok = await clack.confirm({
      message: `执行以上计划？（恢复 ${plan.aggregated.size} 个文件、执行 1 次安装）`,
      initialValue: false,
    })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }  // 闸门取消不写留痕（裁定 2）
    return await executeUnlinkPlan(plan)
  } catch (err) {
    if (opts.dryRun !== true && traceRoot !== null && tracePm !== null) {
      await traceFailure('unlink', traceRoot, tracePm, traceChanges, traceInstalls, err)
    }
    if (err instanceof LinkCancelledError) { process.stderr.write('已取消\n'); return 1 }
    return reportError(err)
  }
}
```

import 追加（合并进同一次编辑）：`parsePathInput` 并入既有 `./link.js` 的 import 块；`clack.text`/`clack.multiselect` 用既有 `import * as clack` ✓ 无需改。

- [ ] **Step 4: 既有「A1 无参数」用例 —— 零改动（裁定 R6-1）**

**不要改** `tests/unit/unlink-command.test.ts`。其既有用例 `UNL-1：无参数无 --all → 用法提示 exit 1`（`unlink-command.test.ts:57-61`）只断言 `runUnlink([], {}) === 1`——非 TTY 下新行为仍为 `提示 + exit 1`，故自动成立（brief 原先假设它与 link 侧同形地断言占位文案，实测它没有断言文案）。

→ **回归判据**：`unlink-command.test.ts` 保持 **35/35 且文件零改动**；新契约由本任务新增的 `UI-7` 断言。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/unit/unlink-interactive.test.ts tests/unit/unlink-command.test.ts`
Expected: PASS（unlink-interactive 18 例；unlink-command 例数与改造前一致）

- [ ] **Step 6: 全量验证**

Run: `pnpm verify`
Expected: exit 0；unit = 353（T1–T3 后实测）+ 16（LI）+ 6（UI-1…6）+ **12**（UI-7…18）= **387**；e2e **26/26**

- [ ] **Step 7: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读）

---

### Task 7: 非 TTY e2e + 全量验证 + 文档回写

**Files:**
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 2 例）
- Modify: `docs/superpowers/specs/2026-09-28-s9-interactive-design.md`（回写实现期裁定 + 计数）
- Modify: 本 plan（标完成）

**Interfaces:**
- Consumes: `runCli(args, cwd)`（`tests/e2e/helpers.js`，spawn `dist/cli.js` → **天然非 TTY**）
- Produces: 无新导出

- [ ] **Step 1: 写 e2e（非 TTY 无参数）**

在 `tests/e2e/cli.e2e.test.ts` 末尾追加：

```ts
// S9 e2e（spec §4.10）：无参数 + 非真终端（spawn 即非 TTY）→ 一行提示 + exit 1，且不得出现菜单残片
describe('lpm link / unlink 无参数 e2e（S9）', () => {
  it('E2E-S9-1：lpm link 无参数（非 TTY）→ exit 1 + 提示直通用法 + 无菜单残片', async () => {
    const r = await runCli(['link'], os.tmpdir())
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]')
    expect(r.stdout).not.toContain('◆')   // clack 菜单符号，出现即为「卡死前糊出的半张菜单」
    expect(r.stdout).not.toContain('│')
  })
  it('E2E-S9-2：lpm unlink 无参数（非 TTY）→ exit 1 + 提示直通用法 + 无菜单残片', async () => {
    const r = await runCli(['unlink'], os.tmpdir())
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm unlink <名字|路径>... [--all] [--dry-run]')
    expect(r.stdout).not.toContain('◆')
    expect(r.stdout).not.toContain('│')
  })
})
```

> 两例都在**非 workspace 目录**下跑到 `isTTY` 闸门即返回，故不需要工作区 fixture（spec §4.10 的判定在最前面）。

- [ ] **Step 2: 跑 e2e**

Run: `npx vitest run tests/e2e`
Expected: PASS（26 + 2 = 28 例）

- [ ] **Step 3: 全量验证（四级）**

Run: `pnpm verify`
Expected: exit 0 = typecheck 0 错误 + build 成功（`dist/cli.js` 体积较基线增大）+ unit 6 新文件 / 用例数与 T1–T6 累加一致 + e2e 28/28

- [ ] **Step 4: 回写 spec（实现期裁定 + 计数）**

在 spec 追加/修订四处：

1. §4.4「空计划」段：补「**非空计划的预览与 dry-run 只差首行**；空计划分支两模式各自保持既有形态（dry-run 沿用 S6 的单行无缩进文案，预览打印明细 + 缩进版文案）」——即**实现期裁定 4**
2. §4.5「前置剔除」段：补「判定位置在 `buildLinkPlan` **内部**（解析出包名之后、预览之前），避免同一 lib 被解析两次（B4 菜单弹两次）」——即**实现期裁定 1**
3. §4.6 与 §8 自决 3：补「`collectLinkedItems` 对判定面用**动态 import**（规避 `status ⇄ unlink` 静态循环）」；自决 3 补「闸门取消走内联 return（不写留痕）；三态/B4 取消沿用既有写留痕」——即**实现期裁定 2/3**
4. §7 测试清单：把「计数在 plan 期细化」替换为**实测终态计数**（`pnpm verify` 输出的文件数/用例数，含取数命令）

- [ ] **Step 5: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读，列出全部改动文件供用户提交）

---

> **终态实测**：`pnpm verify` exit 0 = unit 24 文件 / 388 例 + e2e 28/28（2026-09-28 实跑）；本计划各任务标题下的预期计数（实测只出现过 324 → 369 → 374 → 387 这条链）为历史过程值，以此行为准。

## 收尾与后续（不属任何单任务）

- **最终全量评审（whole-branch）**：MERGE_BASE = `0b78b49`（S9 全程零 commit，故用 HEAD 作基线）；reviewer **直读产出文件**（本波新增/修改的 `src/commands/*.ts`、`tests/**`）；判定 With fixes 则修一波并 scoped 复评（S6/S7/S8 惯例）
- **OCR 评审轮**：**由用户指令触发**，非自动执行；按 `.trae/rules/ocr-review-diff-mode.md` **一律 diff 模式**（`ocr review --audience agent --background "<业务上下文>" --from 0b78b49 --to <HEAD>`），完整命令行落盘 `.superpowers/sdd/2026-09-28-s9-interactive.md/ocr-cmd.txt`，`[ocr] Summary:` 原始行落盘同目录
- **SDD workspace**：`.superpowers/sdd/2026-09-28-s9-interactive.md/`（含 `progress.md` 账本 + 各任务报告）；**本轮零 commit 时账本是唯一证据 → 不删**（S7/S8 账本 Ruling）
- **交接词**：收口后写 `docs/handoffs/2026-09-28-s10-*.md`（S1–S8 惯例），须含：本阶段未提交面（`git status --porcelain -uall` 实跑）、终态验证数字（含取数命令）、遗留裁决与留观项、三屏 CJK 手测结果
- **三屏 CJK 真实终端手测**（spec §2 裁决 1 的收尾验收，归用户）：link 主列表 / unlink 列表 / link 空态向导

---

## Self-Review 记录（writing-plans 第 4 步）

**1. Spec 覆盖对照**

| Spec 章节 | 落点任务 |
|---|---|
| §4.2 文件清单（plan-view / link / unlink / 测试） | T1 / T2–T4 / T5–T6 / T7 |
| §4.3 新增导出 `renderPlan`/`PlanView`/`PlanEntry` | T1 |
| §4.3 新增导出 `parsePathInput`/`collectLinkCandidates`/`PathInputError`/`LinkCandidate`/`DiscoveredLib` | T3 |
| §4.3 新增导出 `collectLinkedItems`/`LinkedItem` | T5 |
| §4.4 三类信息 + 首行两模式 + 逐字兼容 + 确认默认否 + 空计划分支 + 退出码单源 + 写盘面 | T1（渲染）/ T2（link dry-run）/ T4（link 闸门与空计划）/ T5（unlink dry-run）/ T6（unlink 闸门与空计划） |
| §4.5 候选集合 / ★ 置顶 / [已链接] 即时提示 / 其他… / 注册值损坏 / 前置剔除 / 直通不动 | T3（集合）+ T4（提示文案与剔除） |
| §4.6 列表字段 / 漂移标记 / 损坏守卫 / 按路径取消 / 前置剔除 / last 口径 | T5（字段与守卫）+ T6（按路径取消与剔除） |
| §4.7 link 空态向导（三分支）+ unlink 空态三去向 | T4（向导）/ T6（三去向） |
| §4.8 tokenizer 全表（含空引号） | T3（PP-1…PP-8） |
| §4.9 扫描规则 / 命中判定 / 排除修正 / config I/O / 读-改-写 | T3（扫描与命中）+ T4（addScanDir 的读-改-写与失败降级） |
| §4.10 非 TTY + 退出码表 | T4 / T6 / T7（e2e 实证） |
| §4.11 build/execute 拆分 + 闸门 + 前置失败同口径 | T2 / T5（拆分）；T4 / T6（闸门与 catch） |
| §5 错误表 #1–#10 | T4 / T6（#1–#8）+ T3（#2 的类）+ T4（#9/#10 的 config I/O） |
| §6 测试清单（4 新文件 + 改造 + e2e 2 例） | T1 / T3 / T4 / T5 / T6 / T7 |
| §8 自决 1–12 | T4（1/2/6/7/9）、T5（8/10/11）、T1（12）、T7（3 的回写） |
| §2 裁决 1（CJK） | 不在代码内实现；T7 收尾列入用户手测 |

**2. 占位符扫描**：无 TBD/TODO；所有代码步给真实代码；两处大函数（`buildLinkPlan` / `buildUnlinkPlan` / `executeLinkPlan` / `executeUnlinkPlan`）以「**精确行范围 + 逐字搬运 + 明确的改动点清单 + 新签名**」给出，无「自行补充」话术。已知待实现者补齐的只有两处，且都指名了来源与做法：T4 Step 4 的既有用例替换（按 `Grep 交互模式随 S9` 定位）、T6 Step 1 的 helper 补齐（按 T4 同款）。

**3. 类型一致性核对**（跨任务）：
- `renderPlan(view, mode)` 在 T2（link dry-run）、T4（link 预览）、T5（unlink dry-run）、T6（unlink 预览）四处调用，签名一致
- `PlanView.install` 在 link 侧恒为 `{ command, verify: null }`、unlink 侧 `verify` 为复验文案常量，均满足 `string | null` 契约
- `buildLinkPlan` 的 `pruneZeroHit` 由 T4 传 `true`、T2 直通不传（默认 falsy）；`LinkPlan.pruned` 由 T2 定义、T4 消费 `string[]`
- `LinkCandidate` / `DiscoveredLib` 的 `hitMembers: string[]`（相对路径标签）在 T3 产出、T4 的 `pickLinkTargets` 只读 `.length` 与 hint
- `LinkedItem` 五字段（`key`/`rel`/`restoreTo`/`linkedMembers`/`drifted`/`corrupt`）在 T5 产出、T6 消费（label 拼接与 corrupt 剔除）
- `UnlinkPlan.st` / `cfg` / `dedupSkipped` 由 T5 定义并在 `executeUnlinkPlan` 内被使用（`verifyResidue(rootDir, cfg, …)`、完成提示的 `skippedTotal`）
- `CANCELLED`（link.ts）与 `CANCELLED_U`（unlink.ts）为各自模块私有符号，互不跨模块引用——因此不需要为符号扩导出面（spec §4.3 的导出清单未被违反）
