# Session 交接：lpm → S12 引导性打磨（2026-09-28）

> 本文件为 **S12 交接词草稿**（S11 收尾任务 T5 生成，2026-09-29）。内容按 S11 交接词模板结构补齐，供 S12 开工前核对修订。

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-29（Asia/Shanghai；验证基线同一时段实跑） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | `27c4d08`（`git log --oneline -3` 直读 = `27c4d08 feat: 完成 S11 注册管理功能实现` / `82e29ef fix: 修复预设名带空格无法命中及last.json刷新逻辑` / `5dabd05 feat: 完成 S10 集合与预设功能实现`）；**S11 主体已提交 `27c4d08`，OCR 修复波（forget.ts / dir.ts / forget-command.test.ts）+ 文档计数修正未提交**（见「未提交面」） |
| 验证基线 | typecheck **0 错误** + build **成功** + unit **28 文件 / 499 例** + e2e **1 文件 / 38 例**（`pnpm verify` exit 0，2026-09-29 实跑；499 = 450 基线 + dir 18 + forget 25（含 OCR 修复波回归钉 FG-25）+ link-interactive 主列表「管理注册…」+6） |
| 继任自 | docs/handoffs/2026-09-28-s11-registry-management.md（S11 交接词）；本文件为其后继 S12 交接词草稿 |
| 状态 | **待 S12 开工前修订定版**（S12 范围以 brainstorming 一次一问澄清；开工第一问见「开放问题」1） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 联调管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（PRD 见 docs/prds/2026-09-25-lpm-v1-prd.md）。

## 现状

- 已交付并提交（master，`git log --oneline` 直读自证）：S1+S2 `1b46580`、S3 `3adad48`、S4 `96784dd`、S5 `2e46fa0`、S6 `7d38504`、S7 `cb1e0e0`、S8 `0b78b49`、S9 `4abf950`+`df908c5`、S10 `5dabd05`+`82e29ef`、**S11 `27c4d08`**（S11 OCR 修复波 + 文档计数修正未提交）
- **S11「登记管理」已全部实现并提交（`27c4d08`）**，交付物：
  - `lpm forget <名字|路径>...` 直通（名字/路径两路解析；须先 unlink 的已链接拦截整批停零写盘；删空保留 `libs: {}`；预设影响「提示但不洗」`printPresetHints`；多 target 去重 Set 化）
  - `lpm forget` 无参数 TTY → 「管理注册…」子界面（`runManageRegistry`：`clack.note` 减法心智隔离标题 + 多选删除 +「按路径删除…」（`parsePathInput` 复用 + 注册表视角路径反查，不 stat）+ `[已链接]` 剔除提示 + `[注册值损坏]` 可删 + 二次确认 + 空删除集合不弹确认 + 删空保留 `libs: {}`）
  - link 主列表「管理注册…」入口（在「其他…」之后；`registered > 0` 才出现；勾选含它 → 返回 `{ kind: 'manage' }` 忽略其它勾选项；`pickLinkTargets` 返回形态升级为联合类型 `{ kind: 'link'; targets; collectionLevel } | { kind: 'manage' } | CANCELLED`，未退回 string[]；`runLinkInteractive` 的 `cfg` 改 `let`，manage 分支返回后重读 cfg 再 continue 重扫）
  - `lpm dir add/rm/ls` 直通 + 无参数交互（纯用户级，管理 `~/.lpm/config.json` 的 `scanDirs`；add 校验同 S9 向导；rm 按值删；ls 跳非字符串元素；交互不二次确认）
  - cli 接线：`forget` / `dir` 从 stub 循环提出来（description 不带「（计划 S11）」后缀）；unlink 空态三去向的 forget 行去注「（待 S11 上线）」
  - 结构：`src/commands/forget.ts`（新）、`src/commands/dir.ts`（新）、`src/commands/link.ts`（管理分支 + 返回升级）、`src/commands/unlink.ts`（去注）、`src/cli.ts`（接线）、`src/commands/registry.ts`（核对无改动）
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：**S11 主体已 commit（`27c4d08`）**；OCR 修复波 3 文件（forget.ts / dir.ts / forget-command.test.ts）+ 文档计数修正 2 文件（S11 spec §10、本交接词）未提交——按全局 Git 写操作禁令由用户自行 commit
- 工作树异常：无。注意：① `.superpowers/` 被 `.gitignore` 忽略 —— SDD 账本不在 git 历史中，只存在于磁盘；② 本交接词草稿与 `.superpowers/sdd/2026-09-28-s11-registry-management.md/task-5-report.md` 是 S11 收尾新增面

## 过程记录

- **S11 账本（先读尾部）**：`.superpowers/sdd/2026-09-28-s11-registry-management.md/progress.md` —— Setup 裁定、T1–T5 逐任务记录、实施期裁定（dir 分派在 runDir 内 / forget 交互 ctx 组装含 loadWorkspace / link cfg 重读 / T5 的 R1-1…R1-3）、本任务报告 `task-5-report.md`
- **S11 终态（spec §10 回填 + 最终评审修复波后，2026-09-29）**：unit 28 文件 / 498 例 + e2e 38 例（基线 26 文件 / 450 例 + e2e 33 例 → +2 文件 / +48 例 / e2e +5 例；+48 = dir 18 + forget 24 + link-interactive 主列表「管理注册…」+6——LI-S11-1…5 + 最终评审修复波新增 LI-S11-5b）；实施期裁定 R1-1（e2e forget makeProject 补建中间目录）/ R1-2（UI-8 断言同步去注）/ R1-3（e2e 跑 dist 需先 build）
- 上一阶段：`.superpowers/sdd/2026-09-28-s10-collections-presets.md/`（S10 账本）
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md → 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 2026-09-27-s7-unlink-direct.md → 2026-09-27-s8-status-repair.md → 2026-09-28-s9-interactive.md → 2026-09-28-s10-collections-presets.md → 2026-09-28-s11-registry-management.md → 本文件（S12 继任草稿）

## 本次任务

S12「引导性打磨」（PRD §14 行 411：**--dry-run 全面化 / 未知命令模糊纠错 / 错误即建议全局化**；依赖 S6-S11；承接 review 修复 **O2 O3**）。流程沿用既定（S1–S11 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 `docs/superpowers/specs/<落盘当日>-s12-<topic>-design.md` → spec 自审（multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan → ④ SDD 逐任务实施 → 最终全量评审 → 用户指令触发 OCR 评审轮 → `pnpm verify` 四段。起点：**环节 ①**。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §7 行 270（**未知命令模糊纠错**（如 lpm lnik → 建议 link）。全局支持 --dry-run / --help / --version）
  - §11 行 346–364（**错误即建议**：每条错误带下一步动作；逃生门三步）
  - §13 行 377–387（验收；§13.9 = dry-run 与真实执行计划一致——O2 的依据）
  - §14 行 411（S12 行）+ 附录 A 行 477–478（**O2 --dry-run 全局支持** / **O3 未知命令模糊纠错（lnik → link）**）
- 要读（上游 spec 的 S12 依赖面）：
  - **S11 spec §7**：forget / dir 的 `--dry-run`；错误即建议全局化会复核本 spec 新增的 **12 条文案**（§5 错误表）；forget 直通的「已链接拦截」是「遇错即停」的相邻面
  - **S10 spec §7**：save / preset rm 的 `--dry-run` 与模糊纠错；错误即建议全局化会复核 S10 新增的 **16 条文案**（§5 错误表）；`--last/--all/--preset` 的互斥判定是「模糊纠错」的相邻面
  - **S9 spec §7 行 462**：计划预览的 `renderPlan` 单源（错误即建议全局化的落点之一）；`parsePathInput` 可复用于其它路径输入点
  - **S8 spec §4.5**：repair 的 `--dry-run` 既有形态（S12 复核它是否已满足「全局化」口径）
- 当前 `--dry-run` 覆盖现状（S12 摸底起点）：
  - 已支持：`link` / `unlink` / `repair`
  - **未支持**：`save` / `preset rm` / `forget` 直通 / `dir`（S11 spec §1.2 明确把 forget/dir 的 `--dry-run` 划到 S12）
  - `use` / `status` 为无副作用命令（`status` 只读诊断、`use` 的裸调用零写盘——S12 需核定是否给它们定义 `--dry-run` 或明确「不适用」）
- 未知命令当前行为：commander 默认报错（`unknown command 'lnik'`）+ exit ≠ 0（既有 e2e「lpm lnik 未知命令 → exit ≠ 0，stderr 非空」钉的是「非 0 + stderr」，模糊纠错是在此之上加「建议」）
- 代码先例（勿改，作消费面）：`src/commands/link.ts` / `unlink.ts` / `repair.ts` 的 `--dry-run` 分支（`opts.dryRun === true` 时 renderPlan + 零写盘零子进程）、`src/commands/plan-view.ts` 的 `renderPlan(view, mode)` 单源、`src/cli.ts` 的 commander 接线（`--dry-run` option 只在 link/unlink/repair 上声明）、`src/commands/preset.ts` / `forget.ts` / `dir.ts` 的 `runXxx(args, opts)` 形参（**forget/dir 当前没有 opts 参数**——S12 若加 `--dry-run`，需决定是否扩形参；`runForget(targets, cwd?)` / `runDir(args, _cwd?)` 是 S11 新冻结面，扩形参要过评审）
- 勿重做（已实现）：S6–S11 全部命令行为；`renderPlan` 单源；`reportError` 同型 helper（各命令文件内建 KNOWN 列表——S12 的「错误即建议全局化」要复核这些文案是否都带「下一步动作」）

## 开放问题

1. **`--dry-run` 的覆盖口径**：PRD O2 说「--dry-run 全局支持」（§7 行 270），但 `use` / `status` 无副作用、`save` / `preset rm` / `forget` / `dir` 各有写盘面。S12 需澄清：① 全部命令都声明 `--dry-run`（包括无副作用的，行为 = 提示「本命令无写盘动作」？）还是只给「有写盘面但当前未支持」的命令补；② `save` 的 dry-run = 打印「将把 N 个链接存为预设 <名>」？`preset rm` / `forget` / `dir rm` 的 dry-run = 打印将删除清单 + 零写盘？请用户：给出取向。
2. **未知命令模糊纠错的实现位**：commander 的未知命令报错由 `program.parseAsync` 抛出 / stderr 输出——纠错逻辑（编辑距离建议）落在 cli 层（catch commander error 后计算候选）还是 commander 的 `unknownCommand` handler？以及「建议」的输出形态（stderr 追加一行 `最接近的命令：link`？）。请用户：给出取向。
3. **错误即建议全局化**：各命令的 `reportError` KNOWN 列表已保证「打印 message + 建议」——「全局化」是指「复核全部错误文案都带下一步动作」还是「统一错误输出格式（前缀 / 建议行模板）」？复核范围 = S9/S10/S11 新增的 28 条文案 + S6–S8 既有文案。请用户：给出取向。
4. **forget/dir 形参是否扩展**：S11 冻结了 `runForget(targets, cwd?)` / `runDir(args, _cwd?)`。加 `--dry-run` 需要 opts 参数（或第三参 opts）。是扩形参（改 S11 新冻结面，需过评审）还是 cli 层在 action 里预判 `--dry-run` 透传？请用户：给出取向。

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push），改动由用户自行 commit；任务末尾只做只读 `git status --porcelain -uall` 核对
- 终端 Windows PowerShell；skill 自带 bash 脚本不可用 → brief 载体 = 「plan 文件 + `### Task N:` 标题锚定」，评审载体 = 「reviewer 直读产出文件 + 只读 diff」；评审产物的 diff 一律用工具自身写文件（`git diff --no-index --output=<file>`），禁止 PowerShell `>` 重定向接原生命令输出
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts **1.8.1** + execa + tsup + vitest；**运行时依赖零新增**
- spec/plan 落盘惯例 `docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md`
- 冻结签名零改动：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3、S9 §4.3、S10 §4.3、**S11 §4.3**（`runForget(targets, cwd?)` / `runDir(args, _cwd?)` / `runManageRegistry(ctx)` / `ForgetError` / `DirError` / `pickLinkTargets` 联合返回——改动需过评审）
- 编辑纪律：同一文件禁止并行 SearchReplace；import 与使用它的代码合并进同一次编辑；编辑后 `npx tsc --noEmit`（**禁用 GetDiagnostics**）；每任务收尾 `npx vitest run <本任务测试文件>` 全绿
- 单源口径：项目级配置一律 `writeProjectConfig`；用户级配置一律 `readUserConfig`/`writeUserConfig`；候选列表走 `collectLinkCandidates`；预设读写走 `readPresets`；计划渲染走 `renderPlan`（勿再各写一份）；last 单源 = `readLast`/`writeLast`/`refreshLastQuietly`
- 实现者禁止派生子代理；子代理同样禁止任何 git 写操作
- spec 评审通过前不动代码 —— PRD §14 行 395
- SDD workspace 惯例 `.superpowers/sdd/<plan 文件名>/`（含 `progress.md` 账本）；**零 commit 时账本是唯一证据 → 不删**
- 真实 yarn/npm 全链不进自动化（实验性 PM 走 smoke 手测清单，归用户）

## 遗留裁决与留观项

- **S11 终态（spec §10，2026-09-29）**：实施期裁定 R1-1（e2e forget makeProject 补建中间目录）/ R1-2（UI-8 断言同步去注）/ R1-3（e2e 跑 dist 需先 build）；未提交面原文见 S11 spec §10 与 `task-5-report.md` §6
- **S11 新增的真实终端手测项（归用户，无 PTY 不可自动化）**：① link 主列表「管理注册…」项与「管理注册…」子界面（`clack.note` box + 多选列表）的 CJK 对齐 / 长行换行（复用 S9 §2 裁决 1 的三屏手测口径）；② `lpm forget` 直通在真实 TTY 的输出观感（S11 spec §6）
- **S9 final-review parked（S11 未顺手收敛）**：`LinkPlan.planAbandoned` 与 `UnlinkPlan.targets` / `UnlinkPlan.cwd` 三个死字段；`unlink.ts` 的「target→key 解析」在 `pickLinkedKeys` 与 `buildUnlinkPlan` 里近乎逐字重复；`unlinkPreflight` 与交互入口各调一次 `loadWorkspace`；`[注册值损坏]` 只在 hint、label 无该前缀；link 侧 dry-run 缺整段黄金断言；两入口 catch 块 6 行重复；测试 mock 头用 `vi.clearAllMocks()`（建议 `resetAllMocks`）—— 收敛时机：S12 若复用列表/计划渲染，顺手收敛最省
- **S9 未覆盖分支清单**：`addScanDir` 的失败分支、「加目录→重扫→列表出现」、`promptPaths`/`promptUnlinkPaths` 3 次重试耗尽、交互内三态/B4 取消的失败留痕
- **CJK 三屏手测见证范围**：结论 = A1（用户判定「对齐 OK」），但「真实 lib 的 hint 渲染」与「扫描发现组的 ★」两面未被亲眼验证；S10/S11 又新增真实终端面（见上）——下次带真实 lib 的手测一并对齐
- **S9 spec §4.4 行 215 措辞待回写**：该行把「dry-run 空分支 = 单行无缩进」写成通用规则，实际只描述 link（unlink 是「dry-run 首行 + 缩进行」）→ 应按命令分别描述（S10/S11 未顺手改，继续挂）
- **S10 各 minor (deferred) 摘要**：T1 `presets: {}` 空对象分支无显式测试；T2 SV 用例缺「损坏条目撞名」钉子；T3 E2E-S10-4 命名观感、PR-8 只钉 multiselect 未钉 confirm、`stubTty` 用后不还原；T4 LC-8/LC-9 snapshot 未含 state.json；T5 集合级 dry-run + 全跳过不写 last 无专属钉；T6 VI-9 标题判别力有限、VI-8 属「补断言」型弱钉
- **OCR 评审轮的诚实记录（S9/S10）**：覆盖率缺口（S9/S10 轮只实际审了 3 个文件，新测试文件与 e2e 未被实际评审）；`.trae/rules/ocr-review-diff-mode.md` 的成本假设两例未兑现（S9 5.07M / S10 4.82M tokens，diff 模式并未「降一个数量级」）——该规则的 token 假设待正式复核修订
- **S6/S7 留观**：S6「`listWorkspaceMembers` 形态 A 不含根成员」（S6 最终评审 N-5）；S7「`runForceInstall` 缺省 advice 为 link 向」「`--force` 叠加防冻结 flag（O7）」
- **语义变化备查**：`lpm link ./lib @t/lib --dry-run` 这类「先路径后同名包名」输入，现为「静默去重」（S9 账本 OCR 修复波复评备注）
- **S11 后续候选（触发信号出现时评估）**：`lpm forget` 直通支持按索引删注册（用户表达「想按列表序号删」≥ 2 次）；dir 的扫描发现增强（S9 §8 候选）

## 未提交面

（S11 主体已 commit `27c4d08`；剩余 = OCR 修复波 3 文件 + 文档计数修正 2 文件，由用户 commit。S12 开工前请先让用户提交或核对以下工作树面——来自 `git status --porcelain -uall`，2026-09-29 实跑）

```
 M docs/handoffs/2026-09-28-s12-guiding-polish.md
 M docs/superpowers/specs/2026-09-28-s11-registry-management-design.md
 M src/commands/dir.ts
 M src/commands/forget.ts
 M tests/unit/forget-command.test.ts
```

> 说明：`src/commands/dir.ts` / `forget.ts` / `forget-command.test.ts` 是 OCR 修复波的 3 个文件（KNOWN 补齐 + printPresetHints 容忍 + optionMeta/notFound helper + dir rm trim + validScanDirs + FG-25 回归钉）；两份文档是终态计数修正（499 例）。其余 S11 文件已在 `27c4d08` 内提交。

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -3` 确认 S11 提交状态（预期：HEAD = `27c4d08`；工作树仅剩 OCR 修复波 3 文件 + 文档计数修正 2 文件，未提交面见上）
2. 读 `.superpowers/sdd/2026-09-28-s11-registry-management.md/progress.md` **尾部**（Setup 裁定、T1–T5 记录与实施期裁定 R1-1…R1-3、终态计数）
3. 读 PRD §7 行 270、§11 行 346–364、§13 行 377–387、§14 行 411、附录 A 行 477–478
4. 读 S9 spec §7 行 462、S10 spec §7、S11 spec §7（三份 spec 的 S12 依赖面）
5. 摸清 `--dry-run` 覆盖现状（link/unlink/repair 已支持；save/preset rm/forget/dir 未支持）与 commander 未知命令默认行为（既有 e2e「lnik → exit ≠ 0」钉）
6. 进入 brainstorming 一次一问澄清 S12 范围（**开工第一问 = 开放问题 1 的 `--dry-run` 覆盖口径**；预期澄清点见「开放问题」1–4）

## 开场话术

读 docs/handoffs/2026-09-28-s12-guiding-polish.md，按交接词继续：S12「引导性打磨」spec 期开工。注意：S11「登记管理」已全部实现并提交（`27c4d08`），终态 `pnpm verify` exit 0 = unit 28 文件 / 499 例 + e2e 38 例；**仅 OCR 修复波 3 文件 + 文档计数修正 2 文件待 commit**——开工第一问先确认 S11 提交状态，再进 S12 范围澄清。
