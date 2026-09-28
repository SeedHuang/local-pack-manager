# Session 交接：lpm → S10 集合与预设（2026-09-28）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-28 18:28（Asia/Shanghai，与下方验证基线同一分钟实跑） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | `df908c5`（`git log --oneline -3` 直读 = `df908c5 fix(link/unlink): 修复交互模式回归钉并完善扫描发现规则`）；工作树：**clean**（`git status --porcelain -uall` 零输出，18:28 实跑） |
| 验证基线 | typecheck **0 错误** + build **成功** + unit **24 文件 / 395 例** + e2e **1 文件 / 28 例**（`pnpm verify` exit 0，18:28 实跑） |
| 继任自 | docs/handoffs/2026-09-28-s9-interactive.md |
| 状态 | 可直开工（S10 有 4 个开放问题，见「开放问题」节；开工第一问已标注） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 联调管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（PRD 见 docs/prds/2026-09-25-lpm-v1-prd.md）。

## 现状

- 已完成并已提交（master，`git log --oneline -3` 直读自证）：S1+S2 = `1b46580`；S3 = `3adad48`；S4 = `96784dd`；S5 = `2e46fa0`；S6 = `7d38504`；S7 = `cb1e0e0`；S8 = `0b78b49`；**S9 = `4abf950`（主交付）+ `df908c5`（OCR 修复波与回归钉）**
- **S9「交互层」已完成并已提交**（`git show --stat df908c5` 直读：6 文件 +282/−24）：
  - 交付：`lpm link` / `lpm unlink` 的**无参数分支 = 交互入口**（空态向导 / 分组多选 / 「其他…」路径引导 / 「按路径取消…」 / ★ 置顶 / [已链接]·[漂移]·[记录损坏] 标记 / `scanDirs` 扫描发现）+ **执行计划预览**（link/unlink 共用 `src/commands/plan-view.ts` 的 `renderPlan`，两模式只差首行；交互模式预览后一次 `clack.confirm({initialValue:false})`；**闸门取消内联 return 1，不写留痕且零写盘**）+ 非 TTY 一律一行提示 + exit 1
  - 结构：`src/commands/link.ts` 与 `unlink.ts` 各自原地拆成**不导出**的 `xxxPreflight` / `buildXxxPlan` / `planView` / `executeXxxPlan`，`runLink`/`runUnlink` 签名与**直通路径行为零变化**（既有 `link-command.test.ts` 39 例、`unlink-command.test.ts` 35 例**全程零改动**）
  - 新增导出（S9 spec §4.3）：`plan-view.ts` 的 `renderPlan`/`PlanView`/`PlanEntry`/`PlanMode`；`link.ts` 的 `parsePathInput`/`PathInputError`/`collectLinkCandidates`/`LinkCandidate`/`DiscoveredLib`；`unlink.ts` 的 `collectLinkedItems`/`LinkedItem`
  - 质量链：7 任务 SDD 逐任务评审 → 最终全量评审（1 Important 已修 + 2 Important 裁定）→ OCR 评审轮（11 条 = 1 high / 1 medium / 9 low）→ OCR 修复波（6 条 + 7 个回归钉）+ scoped 复评
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：**已 commit**（HEAD 见元信息表；本 session 无未提交项，工作树 clean）
- 工作树异常：无。注意两点：① `.superpowers/` 被 `.gitignore` 忽略 —— SDD 账本**不在 git 历史中**，只存在于磁盘；② `ocr-out-s9-review.txt` **已随 `df908c5` 入库**（该提交 +122 行），后续 OCR 产物是否入库由用户定

## 过程记录

- **S9 账本（先读尾部）**：`.superpowers/sdd/2026-09-28-s9-interactive.md/progress.md` —— 含 Setup 裁定（PF-1…PF-5 / R-LEDGER-1）、T1–T7 逐任务记录与全部 `minor (deferred)` 行、最终全量评审（2 Important + triage 表）、OCR 评审轮实测与两条诚实记录、OCR 修复波的裁定与 scoped 复评结论、以及最新「未提交面」清单
- 同目录报告：`task-1-report.md` … `task-7-report.md`、`task-N-review-package.md`、`final-review-package.md`、`task-final-diff.txt`、`ocr-fix-report.md`、`ocr-cmd.txt`（含 `[ocr] Summary:` 原始行）、`base/`（各任务开工前快照）
- 上一阶段：`.superpowers/sdd/2026-09-27-s8-status-repair.md/`（S8 账本）；更早 S7：`.superpowers/sdd/2026-09-27-s7-unlink-direct.md/`
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md（另有 -0903 同日消歧版）→ 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 2026-09-27-s7-unlink-direct.md → 2026-09-27-s8-status-repair.md → 2026-09-28-s9-interactive.md → 本文件（S10 继任）

## 本次任务

S10「集合与预设」（PRD §14 行 409：**--last/--all/--preset 互斥、save/preset**；依赖 S6）；流程沿用既定（S1–S9 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 `docs/superpowers/specs/<落盘当日>-s10-<topic>-design.md` → spec 自审（multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan（`docs/superpowers/plans/<落盘当日>-s10-<topic>.md`）→ ④ SDD 逐任务实施（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief 载体＝「plan 文件 + 任务标题锚定」；每任务 reviewer 直读产出文件评审）→ 最终全量（whole-branch）评审 → 用户指令触发 OCR 评审轮 → `pnpm verify` 四段。起点：**环节 ①**。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §7 行 264–265（`save <预设名>` 与 `preset` / `preset rm <名>`；**行 260 的 link 直通用法里 `--last / --all / --preset <名>` 三者互斥**）
  - §8 行 278（link 主列表的**虚拟项**「全部已注册」「上次链接的（无记录则隐藏）」「其他…」「管理注册…」的分工）
  - §10 行 337–344（**last.json 更新规则表**：link 多个 / --last / --all / --preset → 操作后全部 links 的 keys；link 单个增量 → 不动；unlink --all / 拆至清空 → 清空前完整集合）
  - §13 行 382–383（**验收 4**：批量 link N 库仅执行 1 次 install；**验收 5**：`unlink --all` 后 `lpm link --last` 恢复完整集合、original 逐文件精确还原）
  - §14 行 409（S10 行）+ 行 414–417（M2 执行顺序：S9 → S10 ‖ S11）
- 要读（S9 spec docs/superpowers/specs/2026-09-28-s9-interactive-design.md）：**§4.5**（link 主列表的候选集合与组装点、虚拟项在 S10 接入的预留）、**§4.6**（unlink 列表与 last 口径）、**§7 后续衔接** 的 S10 行（「link 主列表的虚拟项接进同一列表渲染（groupMultiselect 的 options 组装点）；`--last`/`--all`/`--preset` 复用 `buildLinkPlan`」）、**§6 测试清单**、**§10**（实现期裁定）
- 要读（S6 spec docs/superpowers/specs/2026-09-26-s6-link-direct-design.md §8 行 450「S10 集合预设」行）、（S7 spec docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md §8 行 301 同名列）
- 代码先例（勿改，作消费面）：`src/commands/link.ts` 的 `buildLinkPlan`/`linkPlanView`/`pickLinkTargets`（虚拟项与 `--last/--all/--preset` 的接入口）、`src/state/index.ts` 的 `readLast`/`writeLast`（last.json 单源）、`src/commands/link.ts` 的 `resolveTarget`/`ternaryOriginal`、`src/commands/registry.ts`（`save`/`preset` 仍为 stub，见下）
- 勿重做（已实现并已提交）：`src/commands/plan-view.ts`、`link.ts`、`unlink.ts`、`status.ts`、`repair.ts`、`use.ts`、`run-trace.ts`、`src/core/*`（pm/workspace/globmatch/rewriter/linkcheck/install/nmcheck）、`src/state/*`、`cli.ts` 五命令接线。**`save` / `preset` / `forget` / `dir` / `init` / `uninit` 仍为 stub**（证据：`src/commands/registry.ts` 的 `plannedSpec` 字段 = S10/S10/S11/S11/S13/S13；`grep 交互模式随 S9` 在 `src/`、`tests/` 零命中）

## 开放问题

1. **S10 交付边界是否含「交互侧」的两块**：PRD §8 行 278 的虚拟项「全部已注册」「上次链接的」（S9 已划界给 S10）、以及 `lpm preset`（无参数）的「列表管理」交互？推断：**都含**——依据 PRD §14 行 409 的 S10 交付物列了 `save/preset`，且 S9 spec §7 明确把虚拟项与 `--last/--all/--preset` 列为 S10 的接续面（列表组装点已留）。请用户：确认 / 纠正。
2. **`--last` / `--all` / `--preset` 是否只走直通（不进交互）**？推断：**是**——PRD §7 行 260 把三者列在 link 的「直通用法」列，且三者互斥的校验已在 S6 落地为直通语义（`link.ts` 的 `--last/--all/--preset` 解析）。请用户：确认 / 纠正。
3. **交互模式选中 N>1 个 lib 是否算「link 多个」从而更新 last.json**？推断：**是**（PRD §10 行 341 的表行「link 多个 → 操作后全部 links 的 keys」），与 S9 在 unlink 侧记的口径同型（S9 spec §4.6：交互选中 N>1 由既有规则处理）。请用户：确认 / 纠正。
4. **`lpm save` 的冲突语义**：预设名已存在时的行为（覆盖 / 拒绝 / 询问）PRD 未写。推断：**询问或拒绝并提示**（与「错误即建议」原则一致；覆盖属破坏性）——请用户：给出取向（这条会成为 spec 的一处关键裁决）。

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push），改动由用户自行 commit —— 用户全局 Git 规则；S2–S9 惯例实证（S9 已由用户提交为 `4abf950` + `df908c5`）
- 终端 Windows PowerShell；**skill 自带 bash 脚本不可用**（`sdd-workspace` / `task-brief` / `review-package` 均不可用）→ brief 载体＝「plan 文件 + 任务标题锚定」，评审载体＝「reviewer 直读产出文件 + 只读 diff」——出处：S8 账本 Setup 裁定 + S9 账本 Setup 裁定 1–3
- **评审产物的 diff 一律用工具自身写文件**（`git diff --no-index --output=<file>`）：用 PowerShell `>` 重定向接原生命令输出会写 BOM 且**静默丢行**（S9 账本记录：T2 637/967、T4 248/250）——S9 已踩并被 scoped 复核补回，勿再犯
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入 —— S1 账本，全局生效
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts **1.8.1** + execa + tsup + vitest；**运行时依赖零新增** —— PRD §14 行 391
- spec/plan 落盘惯例 `docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md`，日期取落盘当天 —— S1–S9 既成事实
- 冻结签名零改动：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3、**S9 §4.3** 所列公共 API；S9 的 `runLink`/`runUnlink` 签名与**直通路径行为**亦已冻结（既有 39 + 35 例断言即判据）
- 编辑纪律：同一文件禁止并行 SearchReplace；import 与使用它的代码合并进同一次编辑；编辑后 `npx tsc --noEmit`（**禁用 GetDiagnostics**）
- Task 工具无 model 参数，统一默认模型；实现者禁止派生子代理；子代理同样禁止任何 git 写操作 —— S9 账本 R-LEDGER-1（harness 无法续发消息 → fix 轮用「全新实现者 + report 文件即记忆」替代升档）
- spec 评审通过前不动代码 —— PRD §14 行 395
- SDD workspace 惯例 `.superpowers/sdd/<plan 文件名>/`（含 `progress.md` 账本）；**零 commit 时账本是唯一证据 → 不删** —— S7/S8/S9 账本 Ruling
- **OCR 评审轮的实测成本与形态**（S9 实测，勿凭规则想象）：`--from <BASE> --to <HEAD>` 需**已提交**的区间（零 commit 时实测回「No files changed.」）；S9 那轮 diff 模式 = **3 文件 / 11 条 / ~5.07M tokens / 5m46s**，**未降反升**（S6 workspace 基线 3.39M），且**只审了 3 个文件**（5 个测试文件与 e2e 未覆盖）——`.trae/rules/ocr-review-diff-mode.md` 的成本假设待复核；命令行与 `[ocr] Summary:` 必须落盘 `.superpowers/sdd/<slug>.md/ocr-cmd.txt`
- 单源口径（勿复制）：install 命令行展示走 `buildInstallCommandLine` / `buildForceInstallCommandLine`；package.json 写回走 `writeTextFileAtomic`；本地协议判定走 `rewriter.ts` 的 `LOCAL_PROTOCOL_RE` 与 `status.ts` 的 `isLocalish`；node_modules 形态判定走 `nmcheck.ts` 的 `probeNodeModules`；留痕构造走 `buildRunTrace` / `run-trace.ts` 的 `traceFailure`；**计划渲染走 S9 新增的 `plan-view.ts` 的 `renderPlan`（link/unlink 共用，勿再各写一份）**；**候选/已链接列表走 `collectLinkCandidates` / `collectLinkedItems`**
- 真实 yarn/npm 全链不进自动化（实验性 PM 走 smoke 手测清单，归用户） —— PRD §12 行 374–375；S6–S9 同口径

## 遗留裁决与留观项

- **S9 最终全量评审的 parked（来源：`.superpowers/sdd/2026-09-28-s9-interactive.md/final-review-package.md` 与 `progress.md` 尾部）**：`LinkPlan.planAbandoned` 与 `UnlinkPlan.targets` / `UnlinkPlan.cwd` 三个**死字段**；`unlink.ts` 的「target→key 解析」在 `pickLinkedKeys` 与 `buildUnlinkPlan` 里**近乎逐字重复**（漂移风险）；`unlinkPreflight` 与交互入口**各调一次 `loadWorkspace`**；`[注册值损坏]` 只在 hint、label 无该前缀（spec §4.5 写的是「标」）；**link 侧 dry-run 缺整段黄金断言**（unlink 侧 UI-16 是 `toBe` 整段）；两入口 catch 块 6 行重复；测试 mock 头用 `vi.clearAllMocks()`（建议 `resetAllMocks`，防 once 队列串场）—— 收敛时机：S10 若复用列表/计划渲染，顺手收敛最省
- **S9 未覆盖分支清单**（来源：final review「What the tests still cannot catch」）：`addScanDir` 的失败分支、「加目录→重扫→列表出现」、`promptPaths`/`promptUnlinkPaths` 3 次重试耗尽、`keep.length === 0`（全 corrupt 剔除）、交互内三态/B4 取消的失败留痕 —— 收敛时机：下次触碰对应函数时补
- **语义变化备查**：`lpm link ./lib @t/lib --dry-run` 这类「先路径后同名包名」输入，现为「静默去重」（改动前第二个 target 抛 `LinkArgumentError`）——方向是让 dry-run 与真实执行对齐，无既有用例覆盖（来源：S9 账本 OCR 修复波复评备注）
- **spec 措辞待回写 1 条**：S9 spec §4.4 第 215 行把「dry-run 空分支 = 单行无缩进」写成通用规则，实际只描述 **link**（unlink 是「dry-run 首行 + 缩进行」）→ 应按命令分别描述（来源：S9 账本 OCR 修复波 scoped 复评 out-of-scope 备注）
- **CJK 三屏手测结论 = A1（用户 2026-09-28 判定「对齐 OK」）**，但**见证范围有限**：夹具里 `cfg.libs['@t/lib']` 指向的 `../../lpm-lib` 目录不存在（该缺陷在本 session 已向用户说明），因此「真实 lib 的 hint 渲染」与「扫描发现组的 ★」这两面**未被亲眼验证** —— 收敛时机：下次带真实 lib 的手测，或 S10 触达同一渲染代码时
- **S10 相关的 S6/S7 留观**：S6「`listWorkspaceMembers` 形态 A 不含根成员」（S6 最终评审 N-5）；S7「`runForceInstall` 缺省 advice 为 link 向」「`--force` 叠加防冻结 flag（O7）」—— 来源：`.superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md §③`、`.superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md` 尾部

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -3` 确认 HEAD = `df908c5` 且工作树 clean（预期：零输出 + 上述提交链）；跑 `pnpm verify` 复核基线（预期 typecheck 0 + build 成功 + unit 24 文件/395 例 + e2e 1 文件/28 例，exit 0）
2. 读 `.superpowers/sdd/2026-09-28-s9-interactive.md/progress.md` **尾部**（S9 全部裁定、`minor (deferred)` 行、最终评审 triage、OCR 轮实测与两条诚实记录、修复波结论、未提交面清单）
3. 读 PRD 的 §7 行 264–265、§8 行 278、§10 行 337–344、§13 行 382–383、§14 行 409 与 414–417
4. 读 S9 spec 的 §4.5 / §4.6 / §7（S10 行）/ §6 / §10，以及 S6 spec §8 行 450、S7 spec §8 行 301 的 S10 行
5. 读代码先例：`src/commands/link.ts` 的 `buildLinkPlan`/`linkPlanView`/`pickLinkTargets`（虚拟项接入口）、`src/state/index.ts` 的 `readLast`/`writeLast`、`src/commands/registry.ts`（`save`/`preset` 的 stub 现状）
6. 进入 brainstorming 一次一问澄清 S10 范围（**开工第一问 = 开放问题 1 的交付边界**；预期澄清点见「开放问题」1–4）

## 开场话术

读 docs/handoffs/2026-09-28-s10-collections-presets.md，按交接词继续：S10「集合与预设」spec 期开工。注意：S9 已由用户 commit（HEAD df908c5，工作树 clean），可直接开工。
