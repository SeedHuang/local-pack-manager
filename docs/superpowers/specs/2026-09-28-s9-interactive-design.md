# S9 交互层 —— 设计 spec

- 阶段：S9（PRD §14 行 408：`link/unlink 交互、空态向导、执行计划预览`；依赖 S6 S7；承接 review 修复 O1）
- 上级依据：PRD `docs/prds/2026-09-25-lpm-v1-prd.md` §7 行 255–270、§8 行 272–293、§9 行 295–313、§10、§11、§13、§14 行 389–417、§15 行 419–427、§16 行 428+、附录 A 行 476（O1）
- 上游 spec：S6 §8 行 449（执行计划复用 §4.4 K）、S7 §8 行 300（无参数交互 / 冲突二选一交互化 / dry-run 计划复用）、S8 §8 行 375（status 判定面复用为状态标记 / repair 计划结构复用）
- 状态：**待用户终审**（PRD §14 行 395：spec 评审通过前不动代码）
- 基线：HEAD `0b78b49`（工作树 clean）；`pnpm verify` exit 0 = typecheck 0 + build + unit **20 文件 / 324 用例** + e2e **1 文件 / 26 用例**（2026-09-28 实跑）

---

## 1. 目标与非目标

### 1.1 目标

把 `link` / `unlink` 的**无参数分支**从占位（现文案：「交互模式随 S9 上线」+ exit 1）升级为**交互入口**，让不看 readme 的新用户在裸仓库里走完首次 link（PRD §13 验收 8）：

1. **link 交互**：空态向导 + 分组多选（已注册 / 扫描发现）+「其他…」路径引导
2. **unlink 交互**：已链接列表多选（显示恢复去向）+「按路径取消…」入口
3. **执行计划预览**：交互模式在**执行前**打印一份计划（改哪些文件 / 恢复什么 / 档案动作 / install 几次），**一次确认**后才动手；link 与 unlink 共用同一份渲染器
4. **扫描发现**：读用户级 `scanDirs` 列未注册候选；空态向导可写 `scanDirs`
5. **非 TTY 退化契约**：无参数且非真终端时一行提示 + exit 1，绝不进菜单

### 1.2 非目标（明确划界，防范围蔓延）

| 不做 | 归属 / 依据 |
|---|---|
| 注册管理（link 主列表里的「管理注册…」子界面 = forget 的交互化） | S11；PRD §14 行 410 把「forget 交互化（集成进 link 无参数列表的「管理注册…」）」写在 S11 交付物 |
| 主列表虚拟项「全部已注册」「上次链接的」 | S10（`--last` / `--all` / `--preset` 三者的交互入口，PRD §14 行 409） |
| `lpm forget` / `lpm dir` 直通命令 | S11 |
| `status` / `repair` 的命令面改动 | S8 已定稿；PRD §7 行 262–263 |
| 新增运行时依赖 | PRD §14 行 391（技术栈定版） |
| 真 PM（npm / yarn classic / berry）的交互链路验证 | PRD §12 行 375：实验性 PM 走 smoke 手测清单，不做自动化 |
| 直通路径既有输出与行为的任何改动（除无参数分支） | S6/S7 已验收冻结；本 spec §4.11 只做**内部结构拆分**，不动对外行为 |

---

## 2. 关键裁决（brainstorming 2026-09-28 拍板，9 问全收敛）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | 交互库是否换（PRD §15 行 426 的 CJK 前置冒烟） | **沿用 `@clack/prompts` 1.8.1**。实测：其宽度计算走 `fast-string-width@3.0.2`（`width('中文')=4`），换行/截断走 `fast-wrap-ansi@0.2.2`（`中文中文中文中文` 按 8 列硬换行 → `中文中文\n中文中文`）；`note` / `box` 渲染的中文与中英混排边框**逐列对齐**。PRD 记的是老版本问题，1.8.1 已修。**收尾验收**：实现完成后在真实终端跑三屏（link 主列表 / unlink 列表 / link 空态向导）确认对齐，不达标再议换库。**诚实边界（待验证假设）**：评审环境无伪终端（PTY），故「选项逐帧重绘 / 勾选态刷新」这一层无法事先实测；已实测的是（a）宽度库按 CJK 占 2 列计算、（b）静态框（`note` / `box`）逐列对齐、（c）选项标签的换行截断（`limitOptions`）走同一宽度库。动态重绘的对齐由上面三屏手测兜底 | PRD §15 行 426 是「S9 开工前冒烟」前置；PRD §14 行 391 要求运行时依赖零新增 |
| 2 | 「管理注册…」子界面归属 | **S9 不做**：link 主列表不出该入口，入口 + 子界面 + `lpm forget` 直通一并归 S11 | PRD §14 行 410；S9 期 forget 直通命令尚不存在（registry 里仍是 stub），先做子界面会得到「能拆注册但没有对应直通命令」的孤立功能 |
| 3 | 「扫描发现」与空态「加扫描目录」做到哪一步 | **S9 做完整**：读 `scanDirs` 列候选；空态向导可写入 `scanDirs`。`lpm dir add/rm/ls` 直通命令与目录管理界面仍归 S11 | PRD §7 行 260 的 spec 列 `S6/S9/S10/S11` 中，S9 承担「分组多选 + 空态向导 + 其他路径引导」；`scanDirs` 读写原语 `readUserConfig` / `writeUserConfig` **S4 已落地**（`src/state/index.ts`），S9 零新增依赖 |
| 4 | 交互模式的「预览 → 确认 → 执行」如何与既有 link/unlink 对接 | **抽「确认闸门」注入点**：link/unlink 内部拆成「构建计划（含全部前置判定）→ 【闸门】→ 执行」三段；直通模式构建完即执行（现状语义），交互模式在中间插「打印预览 + 一次确认」。两种模式**共用同一份计划**，故 §13.9 的「dry-run 输出与真实执行计划一致」由结构保证，不靠额外测试对齐 | PRD §8.4：交互模式在预览阶段把三态判定**一次性判定完毕**、禁止执行中途打断；直通模式本无确认环节（PRD §16 关闭项） |
| 5 | 计划渲染层的收敛范围 | **只收敛 link/unlink**：新增一份共享计划视图 + 渲染器；link/unlink 的 dry-run 与交互预览都走它（首行按模式切）。**repair 保持 S8 现状**（它已是「三类信息 + 一次确认」形态且刚验收）。repair 与另两者的同源化列为后续候选 | 避免动刚冻结的 S8（22 例 repair 测试 + 324 例回归）；link/unlink 的既有 dry-run 明细行**逐字兼容**以少改断言 |
| 6 | 无参数交互的覆盖范围 + 交互与 `--dry-run` 的关系 | **只 link/unlink**。交互流程内的「执行计划预览」就是预览环节，用户不必再手打 `--dry-run`；直通模式（带目标）仍保留 `--dry-run`；无目标 + `--dry-run` 视为「进交互、选完后只出计划不执行」 | PRD §7 行 262–263；§7 行 271；§8.4 |
| 7 | 无参数但非真终端（管道 / CI） | **绝不进菜单**：一行提示（含直通用法）+ exit 1 | S8 的真实事故：`repair` 非 TTY 下仍弹 `clack.select` → Promise 永不 resolve → 半张菜单 + exit 13（`.superpowers/sdd/2026-09-28-s8-status-repair.md/progress.md` 最终评审 final-C1）；该修法（非 TTY 时置 `interactive=false`）是本条的先例 |
| 8 | 「扫描发现」怎么扫 | **只扫每个 `scanDirs` 的直接子目录**：能读出 `package.json` 且 `name` 为非空字符串者即候选；不递归；已注册的、已在成员依赖里的不重复列。深处的库走「其他…」手输路径 | 快、可预期、不会把无关项目扫成候选；手输通道本就存在（PRD §8.1「其他…」） |
| 9 | 「已注册」组内排序与「未在依赖中」的呈现 | **★ 置顶 + 预先标记**：★ = 该库出现在成员依赖声明中，按**命中成员数**降序（并列按注册顺序）；未出现在任何依赖中的已注册库仍列出，但带「未在依赖中，链接前需先 `pnpm add`」标记 | PRD §8.1「依赖交集排序置顶 ★」+ 附录 A 行 476（O1）；PRD §11 行 358（选中会报错「先 pnpm add」）→ 提前标注，遵循 §16 已采纳项「反馈前置，不等执行后」 |

---

## 3. 数据流

### 3.1 link 交互（无参数，TTY）

```
lpm link [--watch] [--dry-run]
  A1  无参数分支：非 TTY → 提示 + exit 1（§4.10）；TTY → 进入交互
  A5  workspace 前置（findWorkspaceRoot → loadWorkspace → readProjectConfig → resolvePackageManager）
  A6  候选集合（§4.9）
        ├─ 读 readState → 已注册项标 [已链接]
        ├─ findDependents(ws, key) → ★ 命中成员数排序；零命中标「未在依赖中」
        └─ readUserConfig().scanDirs → 直接子目录扫描 → 未注册候选
  A7  空态？两组皆空 → 向导（输路径 / 加扫描目录 / 退出）（§4.7）
  A8  主列表多选（clack.groupMultiselect）→ 选中集合（已注册 key / 扫描发现 key / 手输路径解析出的 target）
  A9  构建计划（与直通共用 buildLinkPlan：注册 upsert、三态判定 ternaryOriginal、B4 让选、批量改写、install、watch）
  A10 【闸门】打印执行计划预览（§4.4） → clack.confirm(默认否)
        ├─ dry-run 组合：只打印，不确认、不执行 → exit 0
        ├─ 计划为空（选中的库全已链接等）→ 打印计划（含「无待执行变更」）→ **不确认** → exit 0（§4.4）
        ├─ 答否 / Ctrl+C → 「已取消」+ exit 1
        └─ 答是 →
  A11 执行（与直通共用 executeLinkPlan：写序 = state → package.json → install → 留痕）
```

### 3.2 unlink 交互（无参数且未给 `--all`，TTY）

```
lpm unlink [--dry-run]
  A1  无参数分支：非 TTY → 提示 + exit 1；TTY → 进入交互
  A5  workspace + PM 前置；readState
  A6  已链接集合 = state.links 的键；用 scanLinkState（S8 判定面）取每库 [漂移] / [记录损坏] 标记（§4.6）
  A7  无已链接项 → 空态提示「link / status / forget 三去向」+ exit 0（§4.7）
  A8  列表多选（clack.multiselect）：包名 + （链接的子包）+ 将恢复的 range + 标记
        「按路径取消…」入口 → clack.text → tokenizer → resolveTarget 解析 key
             ├─ 在已链接集合 → 并入取消集合
             └─ 不在 → 提示「当前未处于链接状态」+ status 建议（不并入）
  A9  构建计划（与直通共用 buildUnlinkPlan：三态恢复、冲突二选一、幂等跳过、last 规则）
  A10 【闸门】预览 → clack.confirm(默认否)（PRD §8.3：可逆操作不二次确认，计划确认即提交）
        ├─ 计划为空（选中的项全为幂等跳过等）→ 打印计划（含「无待执行变更」）→ 不确认 → exit 0（§4.4）
        ├─ 答否 / Ctrl+C → 「已取消」+ exit 1
        └─ 答是 →
  A11 执行（共用 executeUnlinkPlan：写序 = 恢复文件 → install 成功 → 才删 state → 留痕）
```

### 3.3 直通（带目标）—— 不变，仅内部拆分

```
lpm link <...> / lpm unlink <...|--all>
  → buildXxxPlan（原 A2…A5 + 计划构建，含 TTY 下的三态/B4 弹问）
  → dry-run ？ renderPlan(mode:'dry-run') + exit 0
  → executeXxxPlan（写序、留痕、完成提示——逐字同 S6/S7）
```

---

## 4. 接口与行为契约

### 4.1 命令面

**命令面零变化**：`lpm link [targets...] [--watch] [--dry-run]`、`lpm unlink [targets...] [--all] [--dry-run]` 的参数与选项一字不改；变化只发生在 `targets` 为空（且 unlink 未给 `--all`）时的分支行为。`src/cli.ts` **零改动**（空 targets 已经路由到 `runLink` / `runUnlink`）。

### 4.2 分层与文件

| 文件 | 变更 |
|---|---|
| `src/commands/plan-view.ts` | **新增**：计划视图数据结构 `PlanView` / `PlanEntry` + `renderPlan(view, mode)`（link/unlink 共用渲染器；repair 不接） |
| `src/commands/link.ts` | 内部拆 `buildLinkPlan` / `executeLinkPlan`（**均不导出**，零对外行为变化）；`runLink` 签名与直通行为不变，仅无参数分支改为交互入口；新增导出 `parsePathInput`、`collectLinkCandidates`、`PathInputError`（**交互编排自身不新增导出**——入口就是 `runLink` 的空 targets 分支，内部函数一律不导出） |
| `src/commands/unlink.ts` | 内部拆 `buildUnlinkPlan` / `executeUnlinkPlan`（**均不导出**）；`runUnlink` 签名与直通行为不变，无参数分支改为交互入口；新增导出 `collectLinkedItems`（列表数据源） |
| `src/state/index.ts` | **零改动**（消费既有 `readUserConfig` / `writeUserConfig`） |
| `src/cli.ts` | **零改动** |
| `tests/unit/plan-view.test.ts`、`link-picker.test.ts`、`link-interactive.test.ts`、`unlink-interactive.test.ts` | 新增（见 §6） |
| `tests/unit/link-command.test.ts`、`unlink-command.test.ts` | 改造既有「无参数」用例（占位文案 → S9 契约）；其余断言不动 |
| `tests/e2e/cli.e2e.test.ts` | 新增 2 例（`lpm link` / `lpm unlink` 非 TTY 无参数）；既有 26 例不动 |

### 4.3 公共 API 面

**冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3 所列公共 API 签名不变。`runLink(targets, opts, cwd)` 与 `runUnlink(targets, opts, cwd)` **签名零改动**（本 spec 不改其形参，只改内部结构）；`LinkOptions` / `UnlinkOptions` **不扩字段**。新增导出沿用「公共 API 冻结面约定」：

```ts
// ── src/commands/plan-view.ts（全部新增）──
/** 计划明细：分组行（如「改写 apps/web/package.json:」+ 缩进 4 的明细）或单行 */
export type PlanEntry =
  | { kind: 'group'; heading: string; lines: string[] }
  | { kind: 'line'; text: string }

export interface PlanView {
  entries: PlanEntry[]                    // 按命令语义填好文案（渲染器只负责缩进与分组）
  install: { command: string; verify: string | null } | null   // verify: 复验行文案（link 为 null）
  watch: string[]                         // watch 行
}

/** 渲染执行计划。mode='dry-run' 首行「dry-run 执行计划（不落任何盘、不执行任何子进程）：」；
 *  mode='preview' 首行「执行计划预览：」。其余行两模式逐字一致（§13.9 一致性的结构保证） */
export function renderPlan(view: PlanView, mode: 'dry-run' | 'preview'): string

// ── src/commands/link.ts（新增导出；runLink 签名零改动）──
/** 路径输入 tokenizer（§4.8）：空白分隔；支持单/双引号包裹（含空格）；未闭合引号抛 PathInputError */
export function parsePathInput(raw: string): string[]

export interface LinkCandidate {
  key: string; rel: string; hitMembers: string[]; linked: boolean; cfgIntact: boolean
}
export interface DiscoveredLib { key: string; dirAbs: string; dirLabel: string; hitMembers: string[] }

/** 候选集合（只读）：已注册项（含 ★ 排序数据与 [已链接] 标记）+ 扫描发现项（§4.9）
 *  scanNotes：扫描期降级提示（不可读目录 / 非字符串元素）——由交互层打印，函数自身不输出 */
export async function collectLinkCandidates(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null, scanDirs: readonly string[],
): Promise<{ registered: LinkCandidate[]; discovered: DiscoveredLib[]; scanNotes: string[] }>

// ── src/commands/unlink.ts（新增导出）──
export interface LinkedItem {
  key: string; rel: string; restoreTo: string[]; linkedMembers: string[]
  drifted: boolean; corrupt: boolean
}
/** 已链接列表数据源：state.links 键 × scanLinkState 的判定面（S8 §8 衔接） */
export async function collectLinkedItems(
  rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null,
): Promise<LinkedItem[]>
```

新增错误类（命令域，沿用 S6/S7「错误类归命令文件」先例）：

```ts
// src/commands/link.ts
/** 路径输入解析失败（未闭合引号 / 空输入）——交互内可重试，不作命令级终止 */
export class PathInputError extends Error {}
```

### 4.4 执行计划预览契约

**必须齐全的内容三类信息**（PRD §8.4 + §4.5 的 repair 先例）：

1. **改写 / 恢复明细**：`改写 <相对路径>:`（unlink 用「恢复」）+ 缩进 4 的 `段.包名：原值 → 新值`
2. **将被覆盖的当前值**：`将被覆盖的当前值：<文件>：<说明>`（存在时才出现）
3. **档案动作**：`注册 upsert：…`（新增/更新注册）/ `state：…`（删除条目 / 清空）
4. 尾部固定段：`install：<命令>（workspace 根）` + 可选 `复验：…`（unlink 有、link 无）+ 可选 `watch：…`

**行的顺序不由本 spec 另立**：一律沿用各命令**既有 dry-run 的顺序**（link：注册 upsert → 改写 → 已链接跳过 → peer 警告 → install → watch；unlink：恢复 → 已恢复跳过 → 未链接跳过 → 冲突需确认 → 文件不存在警告 → state → install → 复验）。交互预览与 dry-run 用同一份 `PlanView`、同一顺序渲染，二者只差首行（`执行计划预览：` vs `dry-run 执行计划（…）：`）与「是否确认」——**这正是 §13.9「dry-run 与真实计划一致」的结构保证**。

**屏幕示例（link 交互）**：

```
执行计划预览：
  注册 upsert：@t/lib → ../../lpm-lib（新增/更新）
  改写 apps/web/package.json:
    dependencies.@t/lib：^1.0.0 → link:../../lpm-lib
  已链接跳过：@t/two
  install：pnpm install --no-frozen-lockfile（workspace 根）
? 执行以上计划？（改写 1 个文件、执行 1 次安装） (y/N)
```

**逐字兼容约束**：`mode='dry-run'` 时，link 的输出必须与 S6 §4.4 K 现状**逐字一致**（`dry-run 执行计划（不落任何盘、不执行任何子进程）：` + 注册 upsert / 改写 / 已链接跳过 / peer 警告 / install / watch），unlink 同理（`恢复` / 已恢复跳过 / 未链接跳过 / 冲突需确认 / 文件不存在警告 / state / install / 复验 / 无待执行变更）——既有 dry-run 断言不得因此改写。

**交互模式下「冲突需确认」不出现**：交互模式的三态判定在构建计划时（预览之前）已用 `clack.select` 问完，所以预览里没有「冲突需确认」行——该行只属于 dry-run（dry-run 不弹问，故把「真实执行时将询问」写进计划）。这是「统一前置判定」的直接体现（PRD §8.4）。

**确认语**：`clack.confirm({ initialValue: false })`（沿用 S8 §4.5 先例与 PRD §16「单次回车是防误触最后闸门」）。消息含执行规模计数：`执行以上计划？（改写 N 个文件、执行 M 次安装）`；unlink 侧把「改写」换成「恢复」。

**计划为空时（交互模式专属分支）**：选中项可能全部落到「已链接跳过（link）/ 全文件缺失（unlink，§8 自决 5）/ 前置剔除」等**无可执行动作**的分支 → 计划无实质动作。此时：

- 仍打印计划（含跳过/提示行），末行加缩进行 `  无待执行变更`（与 `link.ts` dry-run 的既有文案同源）
- **跳过 `confirm`**（对空计划问「执行以上计划？」是荒谬的），直接 exit 0
- 直通模式的行为不变（`link.ts` 现状：无改写分支 `无待执行变更` + exit 0）
- **「两模式只差首行」只对非空计划成立（实现期裁定 4）**：**非空计划**下交互预览与 dry-run 只差首行；**空计划**分支两模式各自保持既有形态——dry-run 沿用 S6 的单行、**无缩进**文案 `无待执行变更`（且只打这一行、不列跳过明细），预览打印明细 + **两空格缩进**版 `  无待执行变更`。原因是「dry-run 逐字兼容」是硬约束（既有测试断言这些字符串），而预览需要让人看懂「为什么没事可做」

> **`幂等跳过` 不算空计划**（T6 实现者上报、控制方核定的措辞修正）：unlink 的「已恢复跳过」key **仍进待删集**（S7 G1），执行阶段确有动作（install + 删档），故照常预览 + 确认。spec 早先把它列为空计划的一例，是把「文件零改写」误当成「计划零动作」。

> **该行的单点责任（T6 评审 Minor-2 的回归钉）**：`unlinkPlanView` 在更窄的谓词 `unlinkPlanIsEmpty`（改写/待删/冲突/缺失/跳过全空）成立时**已含**该行；交互入口另有一个更宽的判据（无改写且无待删，覆盖「全文件缺失」这类情形）。因此入口只在**视图未给时**补一行（`if (!unlinkPlanIsEmpty(plan)) …`），否则「全部冲突放弃」路径会打印两遍。改动任一侧的谓词都必须同步另一侧。

**退出码单源**：本 spec 的退出码口径**只在 §4.10 定义**；§5 与 §8 出现的退出码均为引用，若两者与 §4.10 冲突，以 §4.10 为准。

**写盘面（交付视角）**：交互模式相对直通**新增的唯一写盘点**是空态向导里的「添加扫描目录」（写用户级 `~/.lpm/config.json`，PRD §9 行 303）；它可手删、也可由 S11 的 `lpm dir rm` 撤销——不引入新的不可逆面。

### 4.5 link 交互行为契约

**A6 候选集合**：

| 组 | 内容 | 标记 |
|---|---|---|
| 已注册（N） | `cfg.libs` 的键；label = `包名`；hint 显示相对路径 | `★` 命中依赖（按命中成员数降序置顶）；`[已链接]`（state 有条目）时 hint 写「已链接，将跳过」；零命中时 hint 写「未在依赖中，链接前需先 pnpm add」 |
| 扫描发现（M） | `scanDirs` 直接子目录里的未注册库（§4.9） | `[未注册]` + 目录标签（**绝对路径原样**，与 §4.9 的展示口径一致）；**★ / 零命中标记的规则与「已注册」组完全相同**（同一个 `hitMembers` 判定，见下） |
| 其他…（固定一项） | 手输路径入口；**本身不是最终勾选项** | label 带格式引导：`绝对 / 相对 / 多个用空格分隔 / 含空格加引号` |

- **分组渲染**用 `clack.groupMultiselect`（含组级全选）；无「扫描发现」候选时该组不出现
- **「勾选 [已链接] 项即时提示」**（PRD §16 已采纳项）落在 **label / hint 文本**上（clack 不提供 toggle 回调）+ **预览里的「已链接跳过：」明细行**——用户在下手前就能看到，无需等执行完（判定记录见 §8 自决 1）
- **空选中提交**（一个都没选回车）→ `未选择任何库` + exit 1（§8 自决 2）
- **「其他…」/ 向导「输路径」**：`clack.text` → `parsePathInput` → 逐个走既有 `resolveTarget`（路径分支 → 隐形注册 → 命中成员依赖校验）；解析失败逐条报错并重试，最多 3 次（镜像 `ternaryOriginal` 的手动输入通道先例）
- **「其他…」的触发时机**：`groupMultiselect` 只能「提交后」才拿到勾选集合，故语义定为——**提交后若集合含「其他…」，先逐条弹出 `clack.text` 输入、把解析出的 target 并入勾选集合，再进入计划构建**；该项本身不进最终 targets。未勾选它时零额外弹问
- **注册值损坏**（`cfg.libs[key]` 非字符串 → `LinkCandidate.cfgIntact === false`）：列表标 `[注册值损坏]` + hint「修正 lpm.config.json 后重试」；选中后由既有 `LinkArgumentError`（`link.ts` 的「注册值损坏」文案）给出同一指引——**不静默忽略**。候选集合的一切 `libs` / `links` 读取一律 `Object.hasOwn` 守卫（S8 §9 自决 9 同族）

**前置剔除（交互模式专属；直通语义不变）**：勾选集合里「**必然无结果**」的项在构建计划**之前**剔除并提示，不连累同批其它勾选项。**剔除判定必须用现取的 `findDependents`，不得复用列表渲染时的 `hitMembers` 快照**——快照只用于排序与标记；用户在菜单停留期间改了 `package.json` 时，用快照会误杀（把现已合法的库剔掉）或漏杀（现已失效的库没剔掉，`LinkTargetError` 照样炸整批）。

> **判定位置（实现期裁定 1）**：剔除判定在 `buildLinkPlan` **内部**（解析出包名之后、预览之前）完成，而非在**调用该函数之前**——因为「零命中」只有在 `resolveTarget` / `resolveMonorepo` 解析出包名之后才能判断（B4 让选可能弹菜单），放到构建前会让同一个 lib 被解析两次、B4 菜单弹两次。语义仍满足本节两条硬要求：在**预览之前**判定完毕、不连累同批其它项。

| 项 | 若不剔除会怎样 | 剔除后的提示 |
|---|---|---|
| 已注册但零命中依赖（现取的 `findDependents` 命中为空） | 直通会抛 `LinkTargetError`（O5）→ **整批中止**，其它勾选项一起白跑 | `<key> 未在任何成员依赖中，已跳过——请先 pnpm add <key>` |
| **扫描发现项零命中依赖** | 同上（隐形注册后同样走 O5 校验，见 §4.9 的依赖命中判定；这是第 3 轮复扫补上的同族遗漏） | 同上 |
| 注册值损坏（`cfg.libs[key]` 非字符串） | 抛 `LinkArgumentError` → 整批中止 | 见该行 hint 的修正指引 |
| 手动输入的路径解析后零命中 | 同上 | 同上 |

剔除后若计划为空 → 走 §4.4「计划为空」分支（打印提示 + 不确认 + exit 0）。**不做剔除**的情形：用户在弹出的三态三选一/B4 让选里**主动取消或放弃**——那是用户的实时决策，保持既有中止/放弃语义（`LinkCancelledError` → exit 1；`ABANDON` → 该项不链接、其余照常）。

**直通模式不动**：`lpm link <零命中项>` 仍按 S6 报错（显式点名 = 用户意图明确，遇错即停是既有契约）；剔除只发生在其上层的交互勾选集合，因为勾选场景下用户可能没注意到标记。

**A9 计划构建**：与直通**同一套** `buildLinkPlan`，故行为完全一致：注册 upsert、幂等跳过（PRD §9 行 308）、非 lpm 管理的本地链接三选一（`ternaryOriginal`）、B4 monorepo 让选（`pickMember`）、peer 警告、单次 install、watch。

### 4.6 unlink 交互行为契约

**A6 列表数据源**：`state.links` 的键（PRD §8.3「仅显示已链接项」），每项：

| 字段 | 来源 | 示例 |
|---|---|---|
| 包名 | state.links 的键 | `@t/lib` |
| （链接的子包） | 该库 `original` 的**键**去重（`apps/web/package.json` → `apps/web`）——即「**哪些宿主子包当前链着它**」（PRD §8.3「链接的子包」的解读，见 §8 自决 11） | `（apps/web、apps/server）` |
| 将恢复的 range | 该库 `original` 的**值**（多文件异值时并列展示） | `→ ^1.0.0` |
| `[漂移]` | `scanLinkState` 的 `entries[].issues` 含 `drifted`（**S8 §8 衔接的判定面复用**） | — |
| `[记录损坏]` | `issues` 含 `corrupt` | — |

**损坏条目的读取守卫（防崩）**：列表构建**不得**直接读 `st.links[key].original`——条目可能是 `null` / 非对象 / `original` 结构非法（S7 `validateEntry` 会抛、S8 的 `scanLinkState` 会 catch 成 `corrupt`）。口径：用与 `scanLinkState` 同型的 `Object.hasOwn` + 结构守卫，损坏条目取 `restoreTo: []` + `corrupt: true`，**绝不读取其字段**。

> **判定面的取用方式（实现期裁定 3）**：`collectLinkedItems` 对判定面 `scanLinkState` 用**动态 import**（`await import('./status.js')`）——因为 `status.ts` 已静态 import `unlink.ts` 的 `validateEntry` / `LinkStateCorruptError`（S8 落地），unlink 若再静态 import status 会形成 `status ⇄ unlink` **静态循环依赖**；动态 import 语义等价，「判定面复用」照旧成立。

**「按路径取消…」入口**：列表里的一项（**本身不是最终取消项**）。**提交后**若被勾选才弹出 `clack.text` → `parsePathInput` → **逐个**（支持一次输入多个路径）走既有 `resolveTarget` 解析出 key：
- 在已链接集合 → 并入取消集合
- 不在 → 打印「当前未处于链接状态：<path>」+ 一行 status 建议（PRD §8.3），**不并入**（不中断流程）
- 输入处理完 **直接进入计划构建**（不回列表——与 link 侧「其他…」同构，少一轮来回）

**前置剔除（交互模式专属）**：勾选集合里的 `[记录损坏]` 项在构建计划**之前**剔除并提示 `<key> 记录损坏，已跳过——请先 lpm repair`——否则 `buildUnlinkPlan` 会抛 `LinkStateCorruptError`（S7 既有类）**整批中止**，连累同批其它勾选项。剔除后计划为空 → 走 §4.4「计划为空」分支。（更早的方案是「不预先阻断、让错误照常抛」，自审判定为盲点：同一坑在 link 侧也有，故两侧统一改前置剔除。）

**A9 计划构建**：与直通同一套 `buildUnlinkPlan`：三态恢复（`link:` → original；已等于 original → 幂等跳过；其他 range → 冲突二选一 `clack.select`；文件不存在 → 跳过 + 警告）、`--all` 语义不参与交互、last.json 规则不变（**既有实现口径：只有「拆至清空」才写 `writeLast`，其余含 N>1 个一律不动** —— `unlink.ts` G 段；PRD §10 行 343/344）、写序不变。

### 4.7 空态与向导

**link 空态**（PRD §8.5：「无注册 → 向导」）——判定：已注册组与扫描发现组**皆空**：

```
? 还没有注册任何 lib，选一个下一步：
  ○ 输入 lib 路径（绝对 / 相对 / 多个用空格分隔 / 含空格加引号）
  ○ 添加扫描目录（加入用户级 scanDirs，以后自动发现）
  ○ 退出
```

- 「输入 lib 路径」→ 走 §4.5 的手输路径通道（解析 → 隐形注册 → 出现主列表）
- 「添加扫描目录」→ `clack.text` → 校验：必须是**绝对路径**且为已存在目录（PRD §9 行 303：`scanDirs` 存绝对路径）→ 去重后 `writeUserConfig` → **重新扫描并重渲染主列表**（不退出，§8 自决 4）
- 「退出」→ exit 0（§8 自决 2）

**unlink 空态**（PRD §8.5：「无链接 → 提示 link / status / forget 三去向」）：

```
当前没有已链接的库。
  lpm link    把依赖切到本地目录联调
  lpm status  核对三方状态
  lpm forget  移除 lib 注册（待 S11 上线）
```
exit 0（信息性告知，非错误；§8 自决 2、5）。

### 4.8 路径输入解析（`parsePathInput`）

| 输入 | 输出 |
|---|---|
| `D:\Seed\lib` | `['D:\\Seed\\lib']` |
| `../lib ../other` | `['../lib', '../other']` |
| `"D:\My Lib\core"` | `['D:\\My Lib\\core']`（双引号） |
| `'../my lib'` | `['../my lib']`（单引号） |
| `"未闭合` | 抛 `PathInputError`（交互内提示重试） |
| ``（空 / 全空白） | 抛 `PathInputError` |
| `""` / `''`（引号内为空） | 抛 `PathInputError`（空项与空输入同判） |

规则：逐字符扫描；引号内空白不算分隔；`"` 与 `'` 均可；不做转义展开（YAGNI——Windows 路径里的引号本身非法）；不做 glob 展开（S2 已有的 glob 属 workspace 清单解析，与此无关）。

### 4.9 扫描发现（`collectLinkCandidates` 的 `discovered` 部分）

- **输入**：`readUserConfig().scanDirs`（绝对路径数组）
- **扫描**：每个 `scanDirs` 的**直接子目录**（`readdirSync(dir, { withFileTypes: true })` 过滤 `isDirectory()`）
- **候选判定**：子目录内存在 `package.json`（剥 BOM 后 `JSON.parse`）且 `name` 为非空字符串
- **依赖命中判定（两组共用同一份数据）**：对每个候选——**已注册与扫描发现都算**——用 `findDependents(ws, key)` 求 `hitMembers`；★ 置顶排序与零命中**标记**用这份渲染期快照，而**前置剔除的判定在计划构建前现取**（§4.5）——同一规则、两个时点，快照只管展示（第 3 轮复扫前，此规则只写了「已注册」组，扫描发现组会漏掉零命中剔除）
- **排除**：**只排除「已在 `cfg.libs` 注册的键」**（避免与「已注册」组重复）+ `node_modules` / 以 `.` 开头的目录。（原先还写了「已在成员依赖声明中的键」——那是错的：扫描发现的候选本来就可能被成员依赖声明着，排除它等于把这一组清空，且与上一条的零命中剔除规则互相打架。第 4 轮复扫修正。）
- **展示**：`包名` + 目录标签（绝对路径原样；过长时不截断，交给 clack 的宽度换行）
- **失败降级**：`scanDirs` 某一项不存在 / 不可读 → 该项跳过并在列表下方以一行提示「跳过不可读的扫描目录：<路径>」（不中断，PRD §11「错误即建议」精神）
- **`scanDirs` 元素非字符串**（脏配置）：跳过该元素 + 一行提示（`readUserConfig` 只校验顶层是数组，不校验元素类型——S8 §9 自决 10 同族：脏值不抛错、如实降级）
- **用户级 config 读取失败**（坏 JSON / 非对象）：透传 `LpmStateParseError`（`readUserConfig` 既有行为）→ 命令级报错 + exit 1，**不 try/catch 吞掉**（吞掉会静默变成「没有扫描目录」，用户永远查不到原因）
- **用户级 config 写入失败**（权限 / 磁盘，仅空态「添加扫描目录」）：打印一行错误 + **留在向导**（不崩、不退出），让用户改用手输路径或修正后重试
- **写回方式 = 读-改-写**：`readUserConfig` → 追加去重后的目录 → `writeUserConfig`。`readUserConfig` 原样返回 JSON 对象，故未知字段得以保留（不做整体覆盖、不改 `version`）——防将来加字段时被这一处写丢
- **只读**：扫描过程零写盘（除向导里显式「添加扫描目录」）

### 4.10 非 TTY 与退出码

| 场景 | 行为 | 退出码 |
|---|---|---|
| `lpm link` / `lpm unlink` 无参数 + `process.stdin.isTTY !== true` | 一行提示含直通用法（`当前不是交互终端；直通用法：lpm link <名字\|路径>... [--watch] [--dry-run]`）+ **零子进程、零写盘、不出现任何菜单** | 1 |
| 交互流程里 Ctrl+C / `clack.isCancel` | `已取消` | 1 |
| 预览确认答否（默认否直接回车） | `已取消` | 1 |
| 空选中提交 | `未选择任何库` | 1 |
| 空态告知（link 向导选「退出」/ unlink 无已链接项） | 见 §4.7 | 0 |
| 计划为空（选中的项全部落在「全文件缺失 / 前置剔除」等**无可执行动作**的分支——**注意「幂等跳过」不算**，见 §4.4 注） | 打印计划（含跳过/提示行）+ `无待执行变更`，**不确认** | 0 |
| 无目标 + `--dry-run` | 进交互 → 选完 → 只打印计划 → 不确认不执行 | 0 |
| 交互内某项解析失败（路径 / 包名） | 逐条提示 + 重试（≤3 次） | 由最终结果决定 |

> **本表是退出码口径的唯一来源**（§5、§8 为引用）。

`isTTY` 判定单源：`process.stdin.isTTY === true`（与 S8 修复后的 `repair` 同口径；`repair.ts:503` 先例）。

### 4.11 与既有编排的对接（内部结构拆分，不改对外行为）

```
runLink(targets, opts, cwd)
  ├─ targets 非空（直通，现状不变）
  │    plan = await buildLinkPlan(...)            // 原 A2…A5 + 计划构建（含 TTY 弹问）
  │    dryRun ? write(renderPlan(plan, 'dry-run')) + return 0
  │           : await executeLinkPlan(plan, ...)  // 写序 / 留痕 / 完成提示，逐字不变
  └─ targets 为空（S9 交互入口）
       !isTTY → 提示 + return 1                    // §4.10
       交互选库 → plan = await buildLinkPlan(选中的 targets, ...)
                 dryRun ? write(renderPlan(plan,'dry-run')) + return 0
                        : write(renderPlan(plan,'preview'))
                          + confirm(默认否) ? await executeLinkPlan(plan, ...) : 取消(1)
```

- `buildXxxPlan` / `executeXxxPlan` **不导出**（避免扩冻结面）；两个入口在同一文件内共用
- **执行阶段零新增**：交互模式不引入任何新的写序、子进程或留痕逻辑——写盘顺序、复验、`--force` 重建、`writeRunTrace`、完成提示全部由既有 `executeXxxPlan` 负责（崩溃安全顺序与幂等性因此原样继承）
- **计划只算一次**：交互模式不会先跑 dry-run 再真跑（选「构建一次 → 闸门前确认 → 执行」），故「预览的」与「实际做的」天然同源（PRD §13 验收 9 的一致性）
- **既有的中途弹问位置不变**：三态二选一 / B4 让选仍发生在 `buildXxxPlan` 内（即预览之前），满足 PRD §8.4「统一前置判定，禁止执行中途打断」
- **前置失败同口径**：交互模式的前置步骤（`findWorkspaceRoot` / `loadWorkspace` / `readProjectConfig` / `readState` / `resolvePackageManager` / `readUserConfig`）与直通**完全同口径**——既有错误类透传 + exit 1，交互模式不新增吞错或降级；唯一两处例外是 §4.9 已列明的「扫描目录不可读」与「用户级 config 写盘失败」

---

## 5. 错误表（新增项；既有错误类透传）

| # | 错误 / 场景 | 触发 | 输出 | 退出码 |
|---|---|---|---|---|
| 1 | 非真终端 + 无参数 | `process.stdin.isTTY !== true` | `当前不是交互终端；直通用法：lpm link <名字\|路径>... [--watch] [--dry-run]`（unlink 侧为对应用法） | 1 |
| 2 | `PathInputError` | 路径输入未闭合引号 / 空输入 | `路径格式无法解析（<原因>）。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号` | 交互内重试（≤3 次）；耗尽 → 该项放弃并继续流程 |
| 3 | 扫描目录无效 | 向导「添加扫描目录」输入非绝对路径 / 不存在 / 非常规目录 | `扫描目录必须是已存在的绝对路径：<输入>。示例：D:\Seed\libs` | 交互内重试 |
| 4 | 「按路径取消…」解析出的 key 未链接 | 输入的路径对应库不在 `state.links` | `当前未处于链接状态：<path>。可用 lpm status 核对三方状态` | 不终止流程，继续留在列表 |
| 5 | 空选中 | 多选一个未选就回车 | `未选择任何库` | 1 |
| 6 | 用户取消 | Ctrl+C / 预览确认答否 | `已取消` | 1 |
| 7 | 记录损坏（unlink 选中 corrupt 项） | 该项 state 条目结构不合法（`validateEntry` 抛） | **前置剔除**：`<key> 记录损坏，已跳过——请先 lpm repair`（不让 `LinkStateCorruptError` 炸掉整批） | 不终止（继续执行其余项） |
| 8 | 零命中（link 选中「未在依赖中」的已注册项） | `hitMembers` 为空（直通会抛 `LinkTargetError` O5） | **前置剔除**：`<key> 未在任何成员依赖中，已跳过——请先 pnpm add <key>` | 不终止 |
| 9 | 用户级 config 读取失败 | `readUserConfig` 抛 `LpmStateParseError`（坏 JSON / 非对象） | 既有文案（含「可修复或直接删除该文件——lpm 状态可抛弃重建」） | 1 |
| 10 | 用户级 config 写入失败 | 空态「添加扫描目录」写盘失败（权限 / 磁盘） | `无法写入 <路径>：<原因>。可改用手输路径，或修正后重试` | 留在向导，不终止 |

> 说明：**非 TTY 不是异常**（不经错误类），而是命令内的一个分支（与 `use.ts` 的 `'no-tty'` 归一先例同型）。**退出码单源见 §4.10**——本表的退出码列是引用。

---

## 6. 测试清单（**终态实测 2026-09-28**：`pnpm verify` exit 0 = unit **24 文件 / 388 例** + e2e **1 文件 / 28 例**；取数命令 = `pnpm verify`）

**`tests/unit/plan-view.test.ts`（新）**
- `mode='dry-run'` 首行 = `dry-run 执行计划（不落任何盘、不执行任何子进程）：`；`mode='preview'` 首行 = `执行计划预览：`
- 两种模式的**其余行逐字相同**（同一 `PlanView` 双渲染断言）——§13.9 的结构保证
- group 条目（heading + 缩进 4 明细）/ line 条目（缩进 2）缩进正确
- `install.verify === null` 时不出现「复验」行；`watch` 空数组时不出现 watch 行

**`tests/unit/link-picker.test.ts`（新）**
- `parsePathInput`：绝对 / 相对 / 多目标 / 双引号含空格 / 单引号含空格 / 未闭合引号抛错 / 空串抛错 / **空引号 `""` 抛错**
- 候选集合：★ 命中成员数降序 + 并列按注册顺序；`[已链接]` 标记来自 state；零命中带「未在依赖中」；已注册键不在扫描发现组重复出现；**注册值非字符串 → 标 `[注册值损坏]` 且不抛错**；**`links[key] = null` 等脏值不崩**（`Object.hasOwn` 守卫）
- 扫描发现：直接子目录识别（有 name 的 package.json）/ `name` 为空则跳过 / 无 `package.json` 跳过 / `node_modules` 与 `.` 开头目录跳过 / **已注册键被排除、被成员依赖声明的库不被排除（第 4 轮修正的回归钉）** / scanDirs 不存在时降级提示且不中断 / `scanDirs` 元素非字符串 → 跳过该元素 / `scanDirs` 为空 → `discovered` 为空数组 / **discovered 项也带 `hitMembers`**（零命中标记与前置剔除同规则）
- 用户级 config I/O：坏 JSON → 透传 `LpmStateParseError`（不吞）

**`tests/unit/link-interactive.test.ts`（新，mock `@clack/prompts` + `execa`，stub `process.stdin.isTTY`）**
- 无参数 + 非 TTY → 提示 + exit 1，且 `select/multiselect/confirm` **零调用**（S8 exit-13 事故的回归钉）
- 空态向导三分支：输路径（→ 隐形注册 → 主列表）/ 加扫描目录（→ `writeUserConfig` 写盘 + 重扫）/ 退出（exit 0）
- 主列表选中 → 预览 → 确认「是」→ 执行（state + manifest 已改写 + install 恰一次）
- 预览 → 确认「否」/ `isCancel` → 「已取消」+ exit 1 + **零写盘**（除留痕口径见 §8 自决 3）
- 空选中 → 「未选择任何库」+ exit 1
- **计划为空**（勾选全为 `[已链接]`）→ 打印计划 + `无待执行变更` + **`confirm` 零调用** + exit 0
- **零命中前置剔除**：勾选 1 个零命中 + 1 个正常 → 提示行出现、正常项照常执行、`LinkTargetError` 不发生
- **注册值损坏项**：列表标记 + 剔除 + 不连累其余
- 无目标 + `--dry-run` → 打印 dry-run 计划 + 零写盘零子进程 + exit 0
- 空态「添加扫描目录」写盘失败 → 一行错误 + 仍留在向导（不崩不退出）
- `--watch` 透传：交互选中后 watch 行出现（沿用既有 watch 断言形态）
- 三态/B4 在预览之前问完：断言 `select` 调用发生在 `confirm` 之前（顺序断言）

**`tests/unit/unlink-interactive.test.ts`（新）**
- 无参数 + 非 TTY → 提示 + exit 1，零菜单调用
- 列表字段：包名 / 子包去重（多文件）/ 将恢复的 range / `[漂移]`（用 `scanLinkState` 的漂移 fixture 构造）/ `[记录损坏]`
- 「按路径取消…」：在列表 → 并入；不在列表 → 提示 + 不并入且流程继续
- 无已链接项 → 三去向空态 + exit 0
- **corrupt 项前置剔除**：勾选 1 个 `[记录损坏]` + 1 个正常 → 提示行出现、正常项照常执行、`LinkStateCorruptError` 不发生
- **损坏条目读取守卫**：`links[key] = null` / `original: {}` / 值为非字符串 → 列表构建不崩，标 `[记录损坏]`
- 列表构建对 `links[key]` 为 `null` 的 fixture 不抛 TypeError（回归钉）
- 预览 → 确认 → 执行（写序：文件恢复在前、state 删除在后、install 成功才删 state）
- 取消 / 空选中 → exit 1

**回归（S9 开工前的 324 例必须零改动；本轮**实测总数**为 unit 24 文件 / 388 例 + e2e 28 例，取数命令 = 本节标题所记的 `pnpm verify`）**
- `runLink(targets 非空)` 与 `runUnlink(targets 非空 | --all)` 的全部既有断言必须保持绿：这是「内部拆分零对外行为变化」的判据
- link/unlink 的 dry-run **文案逐字断言**既有用例不改（渲染器兼容性判据）
- 既有「无参数占位文案」用例改造为 S9 契约（非 TTY → 新提示 + exit 1）

**e2e（`tests/e2e/cli.e2e.test.ts`，新增 2 例）**
- `lpm link`（非 TTY，无参数）→ exit 1 + 提示文本 + stdout 无菜单残片
- `lpm unlink`（非 TTY，无参数）→ 同上

**真实终端手测（归用户，非自动化）**
- 三屏 CJK 对齐冒烟（§2 裁决 1 的收尾验收）：link 主列表 / unlink 列表 / link 空态向导

---

## 7. 后续衔接

| 消费方 | 依赖的 S9 产出 |
|---|---|
| S10 集合与预设 | link 主列表的虚拟项「全部已注册」「上次链接的」接进同一列表渲染（`groupMultiselect` 的 options 组装点）；`--last`/`--all`/`--preset` 复用 `buildLinkPlan` |
| S11 登记管理 | `lpm forget` 直通 + 「管理注册…」子界面（入口加进 S9 的主列表组装点）；`collectLinkCandidates` 的「已注册组」是其数据源 |
| S12 引导性打磨 | 计划预览的 `renderPlan` 单源（错误即建议全局化的落点之一）；`parsePathInput` 可复用于其它路径输入点 |
| S13 utoopack 适配 | 交互模式确认后走 `executeLinkPlan`，注入点不动 |
| 后续候选（触发信号出现时评估） | repair 的计划渲染与 link/unlink 的 `renderPlan` 同源化（触发信号：S10/S12 任一次需要改预览文案） |

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **「即时提示」的实现**：`clack` 的 `groupMultiselect` / `multiselect` 不提供 toggle 回调，故 [已链接] 的提示落在 **label / hint 文本**（「已链接，将跳过」）与**预览里的「已链接跳过：」行**。PRD §16 的原话是「勾选时界面即时提示」——文本前置严格更强（未勾选即可见），且预览行保证「不等执行后」。若评审要求逐字满足「勾选时提示」，需换 `autocompleteMultiselect` 或自绘。
2. **退出码口径**：空态告知 / 向导选「退出」→ 0；取消 / 空选中 / 确认答否 → 1。理由：前者是「如实告知无事可做」（与 `status` 的 exit 0 同精神），后者是「用户中止了未完成的操作」（与 S7 `LinkCancelledError`、S8 `RepairCancelled` 的 exit 1 同口径）。
3. **交互模式的留痕**：成功/失败仍走既有 `writeRunTrace`；**取消发生在计划阶段（无写盘）→ 不写留痕**，沿用 S7/S8「无动作不写」的早退惯例（`progress.md` T2 Ruling）。落地时区分两种取消（实现期裁定 2）：**闸门取消（预览确认答否 / Ctrl+C）走内联 `return 1`，不写失败留痕**；而 `buildLinkPlan` 内用户在弹出的**三态/B4 让选里主动取消**仍抛既有 `LinkCancelledError` → 走既有 catch → **照常写失败留痕**。另：`collectLinkedItems` 对判定面 `scanLinkState` 用**动态 import**（规避 `status ⇄ unlink` 静态循环依赖，实现期裁定 3）。
4. **加扫描目录后回主列表**：向导内写盘成功后**重新扫描并重渲染主列表**，不退出——否则用户加完目录还得重跑命令。
5. **unlink 空态三去向的 forget 行**：PRD §8.5 字面写三去向，但 S9 期 `lpm forget` 仍是 stub（`registry.ts:15` `plannedSpec: 'S11'`）。保留该行但注「待 S11 上线」——既不违背 PRD，也不引导用户去跑一个未实现的命令。
6. **路径输入用 `clack.text`**（既有先例，`link.ts:214` / `use.ts` 同型），不用 `clack.path`（它带文件浏览器形态，S9 未做对齐冒烟）。
7. **无目标 + `--dry-run`**：进交互、选完后只打印计划不执行、exit 0。理由：`--dry-run` 的语义是「零副作用」，与交互模式组合时应保持最高优先级。
8. **corrupt 项在 unlink 列表照常显示**（标 `[记录损坏]`）且**保持可选**；选中后在构建计划**之前**前置剔除 + 提示（§4.6），而不是让 `LinkStateCorruptError` 炸掉整批。理由：保留可见性与「为什么不能用」的解释路径，同时不连累同批（自审 P1 的裁决；与 §8 自决 9 同族）。
9. **零命中已注册库可选、不禁用**：列表可见、可勾选，选中后在计划阶段前置剔除并提示「先 pnpm add」；不预先禁用——禁用会让用户失去解释路径（PRD §16 否决「已链接项移出列表」的理由同型）。
10. **`collectLinkCandidates` 的 `hitMembers` 只用于排序与标记**，不参与计划构建，**也不参与前置剔除的判定**（后者现取）——这是一处**有意的第二份真相**：展示用的快照可能过期（用户在菜单停留期间改了 package.json），执行用的真相必须现取。时点分工：渲染期快照 → ★ 排序/标记；计划构建前现取 → §4.5 前置剔除。
11. **PRD §8.3「链接的子包」的解读**：按「**声明该库的宿主成员子包**」（`apps/web`、`apps/server`）渲染——依据是 state 的 `original` 键本就是宿主 manifest 路径。若原意是「该 lib 自身 monorepo 里的成员包」，改为从 `cfg.libs[key]` 的目录反查成员即可（成本一行）。
12. **渲染与列表 fixture 含 CJK / 中英混排**（如 `@seedhuang/ai_suit_tool 已链接，将跳过`）：断言缩进正确与「不崩」；逐列对齐由库保证（§2 裁决 1），不在单测里重复验证渲染器的宽度算法。

---

## 9. 评审 Backlog

### 自审（multi-lens-review，2026-09-28，场景 B 技术方案：六手法 + 架构师/资深开发/资深测试/交付运维面板）

**结论先行**：7 轮过完（5 轮有发现：第 1 轮全量 + 第 2/3 轮全量复扫 + 第 4/5 轮复扫；第 6 轮修复项 scoped 复评 + 第 7 轮全量复扫均**零新增**）→ 累计 **3 矛盾（P0）+ 8 盲点（P1）+ 12 优化（P2）**，全部当轮修复。**最危险项 = 第 4 轮抓到的「扫描发现的排除规则把这一组清空」**（它会让 S9 的一个目标项整块失效，而前两轮都以为那组只是「没写全」）。收敛判定：**连续 2 轮零新增 P0/P1 达成**（第 6、7 轮）。

### 矛盾（P0）

| # | 问题 | 轮次 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | §4.2 提到「新增导出 `runLinkPicker`」，§4.3 里没有它的签名——文档自相矛盾 | 1 | **已采纳**：删掉该导出（交互编排不导出，入口即 `runLink` 的空 targets 分支） | §4.2 |
| 2 | §4.4 自立的「三类信息按此顺序输出」与「dry-run 逐字兼容」互斥（既有 dry-run 把「注册 upsert」排第一） | 2 | **已采纳**：删掉自立顺序，改为「沿用各命令既有 dry-run 顺序」，并写明「同一 `PlanView` 渲染 = §13.9 一致性的结构保证」 | §4.4 |
| 3 | §4.9「排除已在成员依赖声明中的键」与「扫描发现零命中剔除」互相打架——按前者，这一组**恒为空**，目标项整块失效 | 4 | **已采纳**：排除只留「已在 `cfg.libs` 注册的键」 | §4.9（含修正说明）+ §6 回归钉 |

### 盲点（P1）

| # | 问题 | 轮次 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | 交互模式下「计划为空」（勾选全为已链接/幂等跳过）的分支未定义——照样问「执行以上计划？」是荒谬的 | 1 | **已采纳**：打印计划 + `无待执行变更` + **不确认** + exit 0 | §4.4 / §4.10 / §6 |
| 2 | 勾选集合里「必然无结果」的项（零命中、注册值损坏）会**连累整批**（既有类是整批中止），违背「反馈前置」 | 1 | **已采纳**：交互模式前置剔除 + 提示，其余照常；直通模式的「遇错即停」不动 | §4.5 / §4.6 / §5 #7 #8 / §6 |
| 3 | unlink 列表构建直接读 `st.links[key].original` 会在条目损坏（`null` / 非对象）时崩 | 1 | **已采纳**：同 `scanLinkState` 同型的 `Object.hasOwn` + 结构守卫；损坏取 `restoreTo: []` + `corrupt: true` | §4.6 / §6 |
| 4 | 用户级 config 的读写失败行为未定义（读失败若被吞 → 静默无扫描发现） | 1 | **已采纳**：读失败透传 `LpmStateParseError`（exit 1）；写失败留在向导 | §4.9 / §5 #9 #10 |
| 5 | 「其他…」/「按路径取消…」的触发时机未定义（`groupMultiselect` 只有提交后才给集合） | 2 | **已采纳**：二者都是「提交后若被勾选才弹输入」，且本身不进最终集合 | §4.5 / §4.6 |
| 6 | 前置剔除只覆盖「已注册」组——**扫描发现项零命中**同样会炸整批（同族遗漏） | 3 | **已采纳**：两组共用同一 `hitMembers` 规则，剔除含 discovered 与手输路径项 | §4.5 表 / §4.9 / §4.3 |
| 7 | 前置剔除若用渲染期快照，用户中途改了 `package.json` 时会误杀或漏杀——正好废掉这条规则的意义 | 5 | **已采纳**：剔除判定**现取** `findDependents`；快照只管排序/标记 | §4.5 / §4.9 / §8 自决 10 |
| 8 | 术语「链接的子包」（PRD §8.3）有两种解读，会渲染成完全不同的东西（宿主成员 vs lib 自身成员） | 1 | **已采纳**：明确取「声明该库的宿主成员子包」，并给出另一种解读的切换成本 | §4.6 表 + §8 自决 11 |

### 优化（P2）处置表

| # | 问题 | 处置 | 落点 |
|---|---|---|---|
| 1 | §4.2 未列 `PathInputError` 的归属 | **已采纳** | §4.2 |
| 2 | 空引号 `""` / `''` 输入未枚举 | **已采纳** | §4.8 / §6 |
| 3 | `scanDirs` 元素非字符串（脏配置）未定义降级 | **已采纳** | §4.9 |
| 4 | 项目级 config/state 读取失败在交互模式下的行为未明说 | **已采纳** | §4.11「前置失败同口径」 |
| 5 | 用户级 config 写回未规定「读-改-写」，将来加字段会被这一处写丢 | **已采纳** | §4.9 |
| 6 | 交互模式下 `last.json` 的更新口径未提 | **已采纳**（写明既有实现：只有拆至清空才写 `writeLast`） | §4.6 |
| 7 | 退出码在三处重复（第二份真相） | **已采纳**：§4.10 为单源，其余为引用 | §4.4 / §4.5 前 / §5 说明 / §4.10 |
| 8 | 执行阶段「零新增写序/子进程」未显式 | **已采纳** | §4.11 |
| 9 | 新增写盘面与回滚路径（交付运维视角）未提 | **已采纳** | §4.4「写盘面」 |
| 10 | 渲染/列表测试无 CJK 与中英混排 fixture | **已采纳** | §6 / §8 自决 12 |
| 11 | 冻结面之外的导出归属（`PathInputError` 放 link.ts）未说明理由 | **已采纳**（命令域错误类归命令文件，S6/S7 先例） | §4.3 |
| 12 | 交互模式选中 N>1 个 link 时是否算「集合级操作」（last 规则） | **已采纳**：由既有执行段按 PRD 规则处理，交互不特判 | §4.6 |

**候选（触发信号出现时再评估）**

| 内容 | 触发信号 |
|---|---|
| 用 `autocompleteMultiselect` 或自绘实现「勾选瞬间即时提示」（clack 无 toggle 回调，现用 label/hint 文本 + 预览行替代） | 用户反馈「看不到 [已链接] 提示」≥ 2 次 |
| `renderPlan` 与 repair 的 `printPlan` 同源化 | S10 / S12 任一次需要改预览文案 |
| 扫描发现支持深度 ≥ 2（现只扫直接子目录） | 用户在 monorepo 里因扫不到库而改用手输路径 ≥ 2 次 |
| 用 `clack.path` 取代 `clack.text` 做路径输入 | 用户反馈路径输入体验差 ≥ 2 次，且 `clack.path` 通过 CJK 冒烟 |

**关闭（理由留痕）**

| 内容 | 关闭理由 |
|---|---|
| 交互模式也先跑一遍 dry-run 再真跑（拿计划文本做预览） | 计划算两遍，且两次之间磁盘变化会造成「预览的与做的不一样」；已由「构建一次 → 闸门 → 执行」结构替代 |
| 禁止选择零命中/损坏项（`disabled`） | 与 PRD §16 否决「已链接项移出列表」的理由同型（丢失解释路径）；改用「可选中 + 计划前剔除 + 提示」 |
| 交互模式为 unlink 增加二次确认 | PRD §8.3 明确「可逆操作不二次确认」，且 §16 关闭了 `--yes` |

### 自洽确认区（攻过但没攻破）

- **并发的双双敲击 / 双终端**：交互模式不新增写序，沿用 S4 原子写与既有幂等规则；`last-run.json` 只保留最近一次（S8 已知代价）。
- **中断恢复**：执行阶段完全复用既有 `executeXxxPlan`，S6/S7 的崩溃恢复测试即覆盖交互路径。
- **CJK 动态重绘**：无 PTY 不可事前实测——已在 §2 裁决 1 显式标为**待验证假设**，并给出真实终端三屏手测作为验收（不假装已验）。
- **交互模式下 `stdin` 是 TTY 而 `stdout` 被重定向**：clack 会把帧写进重定向目标，键位仍可读——行为怪异但极罕见，且与 S8 修复后的 `repair` 同口径（只判 `stdin.isTTY`），本阶段不额外处理。
- **`scanDirs` 指向根目录（如 `D:\`）**：直接子目录扫描会列出很多目录，但候选判定要求「含可解析出 name 的 package.json」，噪音有限；不额外设白名单（YAGNI）。
- **`--watch` 与交互模式组合**：确认后由既有执行段拉起 watch 并驻留（S6 行为），交互层不干预。

---

## 10. 实现期实测与裁定

实施期（T1–T7）在 spec 之外做了 5 处**实现细则裁定**，均不改变对外行为与本节契约，仅把「spec 的文字」落到「能工作的落点」。终态实测 2026-09-28：`pnpm verify` exit 0 = unit 24 文件 / 388 例 + e2e 1 文件 / 28 例。

1. **前置剔除改在 `buildLinkPlan` 内部（`pruneZeroHit`）**——spec §4.5 原文写「在构建计划之前剔除」，实现改为在构建函数**内部**、解析出包名之后判定。**理由**：「零命中」只有在 `resolveTarget` / `resolveMonorepo` 解析出包名后才能判断（B4 让选会弹菜单），放到构建前会让同一个 lib 被解析两次、B4 菜单弹两次。语义仍满足两条硬要求：预览之前判定完毕、不连累同批其它项。直通路径（`pruneZeroHit !== true`）行为一字不变。（对应 §4.5 注）
2. **闸门取消用内联 `return 1`（不写失败留痕），三态/B4 取消不变**——交互模式的「预览确认答否 / Ctrl+C」直接 `return 1`（不抛错 → 不写失败留痕）；而 `buildLinkPlan` 内用户在三态/B4 让选里主动取消仍抛既有 `LinkCancelledError`，走既有 catch → 照常写失败留痕。**理由**：闸门取消是「用户在无写盘的计划阶段按下停止」，沿用 S7/S8「无动作不写留痕」惯例；三态/B4 取消是既有直通契约的一部分，直通路径这一行为不得改动。（对应 §8 自决 3）
3. **`collectLinkedItems` 用动态 import 取判定面**——`const { scanLinkState } = await import('./status.js')`。**理由**：`status.ts` 已静态 import `unlink.ts` 的 `validateEntry` / `LinkStateCorruptError`，unlink 若再静态 import status 会形成 `status ⇄ unlink` 静态循环依赖；动态 import 语义等价，「判定面复用」照旧成立。（对应 §4.6 注 / §8 自决 3）
4. **`unlinkPreflight` 不含 `readState`**——读 state 留在入口（`runUnlink` / `runUnlinkInteractive`），紧跟 `traceRoot` / `tracePm` 赋值之后。**理由**：与 link 侧同形；且 `.lpm/state.json` 损坏时 `catch` 仍能定位 `rootDir` / `pm` 并写失败留痕（若把 `readState` 放进 preflight，损坏会发生在赋值之前 → 丢留痕）。
5. **空计划分支两模式形态差异**——dry-run 沿用 S6 的单行、**无缩进**文案 `无待执行变更`（只打这一行、不列跳过明细）；交互预览打印明细 + **两空格缩进**版 `  无待执行变更`。**理由**：「dry-run 逐字兼容」是硬约束（既有测试断言这些字符串），而预览需要让人看懂「为什么没事可做」。故 §4.4「两模式只差首行」限定为**非空计划**。（对应 §4.4 注）
