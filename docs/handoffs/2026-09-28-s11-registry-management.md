# Session 交接：lpm → S11 登记管理（2026-09-28）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-28 21:00（Asia/Shanghai，与下方验证基线同一分钟实跑） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | `0f9407d`（`git log --oneline -3` 直读 = `0f9407d docs: 添加 S10 集合与预设的交接文档` / `df908c5 fix(link/unlink): 修复交互模式回归钉并完善扫描发现规则` / `4abf950 feat: 完成 S9 交互层实现…`） |
| 验证基线 | `pnpm verify` exit 0（21:00 实跑）= typecheck **0 错误** + build **成功** + unit **26 文件 / 447 例** + e2e **1 文件 / 33 例** |
| 工作树状态 | **非 clean**（`git status --porcelain -uall` 21:00 实跑 = **5 个 `M` + 5 个 `??`**；**S10 实现改动全部未提交，由用户 commit**，清单见「现状」） |
| 继任自 | docs/handoffs/2026-09-28-s10-collections-presets.md |
| 状态 | 可直开工（S11 范围以 brainstorming 一次一问澄清；开工第一问见「开放问题」1；**开工前先让用户 commit S10 实现**） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 联调管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（PRD 见 docs/prds/2026-09-25-lpm-v1-prd.md）。

## 现状

- 已完成并已提交（master，`git log --oneline -3` 直读自证）：S1+S2 = `1b46580`；S3 = `3adad48`；S4 = `96784dd`；S5 = `2e46fa0`；S6 = `7d38504`；S7 = `cb1e0e0`；S8 = `0b78b49`；S9 = `4abf950`（主交付）+ `df908c5`（OCR 修复波与回归钉）；**S10 交接词文档 = `0f9407d`（用户提交）**
- **S10「集合与预设」实现已完成、逐任务评审通过，但未提交**（工作树面 = 10 项，`git status --porcelain -uall` 21:00 实跑原文）：
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
  - 交付：`lpm save <名>`（八步直通；撞名拒绝；读-改-写绝不丢损坏条目/未知字段；名单排序存盘）；`lpm preset`（无参数列表管理 + 多选删除 + 二次确认，损坏条目可删）/ `lpm preset rm <名>`；`lpm link --last / --all / --preset <名>`（三者互斥、不与位置参数同用；展开期预检「名字不在注册表 / 注册值损坏」= 直通整批停且零写盘；集合级操作**哪怕展开后只有 1 个名字也刷新 last.json**）；link 主列表新增「快捷」组（「全部已注册（N）」「上次链接的（N）」虚拟项，勾选后展开并入集合、失效名字剔除并逐行提示）
  - 结构：`src/commands/preset.ts`（新增：`runSave`/`runPreset`/`readPresets`/`PresetError`/`PresetView`）；`src/commands/link.ts`（`resolveLinkCollection` 三源 + 虚拟项 + `pickLinkTargets` 返回值升级为 `{ targets, collectionLevel }`）；`src/cli.ts`（save/preset 接线 + link 3 option）
  - 质量链：7 任务 SDD 逐任务评审（T4 1 修复轮、T6 1 修复轮，其余 clean）→ T7（本波）文档回写 + `pnpm verify` 全绿
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：HEAD = `0f9407d`（S10 交接词）；**S10 实现改动未提交**（上表 10 项），由用户 commit
- 工作树异常：无。注意两点：① `.superpowers/` 被 `.gitignore` 忽略 —— SDD 账本**不在 git 历史中**，只存在于磁盘；② S9 spec 的 `M` 是本波 T7 的**回写**（§3.1 / §4.3 / §4.5 / §6 四处，见 S10 spec §7 回写清单），属 S10 波段的声明义务，非新功能面

## 过程记录

- **S10 账本（先读尾部）**：`.superpowers/sdd/2026-09-28-s10-collections-presets.md/progress.md` —— Setup 裁定、T1–T6 逐任务记录（含 R2-1 / R2-2 / R3-1 / R4-1 / R6-1 / R6-2 / R6-3 全部实施期裁定与 `minor (deferred)` 行）、T7 报告
- 同目录报告：`task-1-report.md` … `task-7-report.md`、`task-N-review-package.md`、`base/`（各任务开工前快照）
- 上一阶段：`.superpowers/sdd/2026-09-28-s9-interactive.md/`（S9 账本）
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md（另有 -0903 同日消歧版）→ 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 2026-09-27-s7-unlink-direct.md → 2026-09-27-s8-status-repair.md → 2026-09-28-s9-interactive.md → 2026-09-28-s10-collections-presets.md → 本文件（S11 继任）

## 本次任务

S11「登记管理」（PRD §14 行 410：**forget 直通（名字/路径）+ 交互化（集成进 link 无参数列表的「管理注册…」）、dir、用户级 config**；依赖 **S4 S6 S9**）；流程沿用既定（S1–S10 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 `docs/superpowers/specs/<落盘当日>-s11-<topic>-design.md` → spec 自审（multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan → ④ SDD 逐任务实施（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief 载体＝「plan 文件 + 任务标题锚定」；每任务 reviewer 直读产出文件评审）→ 最终全量评审 → 用户指令触发 OCR 评审轮 → `pnpm verify` 四段。起点：**环节 ①**。PRD §14 行 417：S11 的 forget 交互化部分依赖 S9（现已在 S9/S10 全部就绪），直通部分仅依赖 S4 S6。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §7 行 266–267（`lpm forget <名字|路径>`（须先 unlink）交互列 =「已注册未链接列表多选」；`lpm dir add <路径> / rm / ls`（用户级扫描目录）交互列 =「管理」）
  - §8 行 278–284（**link 主列表的「管理注册…」子界面 = forget 的交互化**：已注册列表多选删除 +「按路径删除…」（格式引导同「其他…」）+ 勾中 `[已链接]` 项**阻止并提示**「先 lpm unlink，或改用 lpm unlink」——绝不悄悄既拆线又删档 + 确认删除前二次确认 + 删除成功提示「已移除注册：@x/y…」；**子界面标题与视觉模式须与主列表明显区分**——加法/减法心智隔离）
  - §9 行 303（用户级 `~/.lpm/config.json` 的 `scanDirs` 写盘面，S4 已落地 `readUserConfig`/`writeUserConfig` 原语）
  - §14 行 410（S11 行）+ 行 417（M2 执行顺序：S9 → S10 ‖ S11；forget 直通仅依赖 S4 S6，可提前开工）
- 要读（S9 spec docs/superpowers/specs/2026-09-28-s9-interactive-design.md）：**§4.5**（A6 表与主列表组装点——「快捷」组已由 S10 接入，「管理注册…」在「其他…」之后、属 S11）、**§7 行 461**（S11 行：「`lpm forget` 直通 + 「管理注册…」子界面（入口加进 S9 的主列表组装点）；`collectLinkCandidates` 的「已注册组」是其数据源」）
- 要读（S10 spec docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md）：**§4.7–§4.9**（preset 读写面与 `reportError` KNOWN 先例——命令域错误类归命令文件）、**§4.10**（虚拟项接入与 `collectionLevel` 传导链）、**§7 的 S11 行**、**§10**（实现期实测与裁定，含全部 R 裁定）
- **S10 新接口（S11 接手时勿退回旧形态）**：
  1. **`pickLinkTargets` 返回 `{ targets: string[]; collectionLevel: boolean } | typeof CANCELLED`**（S10 spec §4.10）——S11 的 forget 交互若复用本函数，**必须显式传 `forceLastWrite`/`collectionLevel`**（契约：任何新增集合级入口都必须显式传，不允许在 `executeLinkPlan` 里二次推断）；**勿退回 `string[]`**
  2. **「快捷」组与「管理注册…」的组装顺序**：**快捷 → 已注册 → 扫描发现 → 其他 → 管理注册…**（「管理注册…」接在「其他…」之后；S9 §4.5 A6 表 + §7 S11 行）
  3. **`readPresets` 的失效名字策略**：`lpm forget` 会让预设里的旧名字失效 → S10 §4.4 展开期预检「名字不在注册表」= **直通整批停**（一个都不链、零写盘）；forget 的删除语义须与它对齐（forget 后 `lpm link --preset <含旧名的预设>` 会整批报错，是既有契约，非缺陷）
- 代码先例（勿改，作消费面）：`src/commands/registry.ts`（**forget/dir 仍为 stub**，`plannedSpec: 'S11'` —— 元数据「stub 提示用」，接线后即消失，不是过期描述）、`src/commands/link.ts` 的 `pickLinkTargets` / `runLinkInteractive` / `collectLinkCandidates`（S9 §4.3 冻结导出）、`src/state/index.ts` 的 `readUserConfig` / `writeUserConfig`（dir 的读写面）、`src/commands/preset.ts` 的 `readPresets` / `reportError`（错误类归命令文件先例）
- 勿重做（已实现）：S10 的 save / preset / 集合级直通 / 「快捷」组虚拟项；S9 的交互框架（分组多选 / 空态向导 / 执行计划预览 / 非 TTY 退化）、`src/commands/plan-view.ts` 渲染器

## 开放问题

1. **`lpm forget` 的交互化边界**：PRD §7 行 266 交互列写「已注册未链接列表多选」，PRD §8 行 279 写「link 注册管理子界面」（列表内删除注册 = forget 的交互化，含「按路径删除…」）；S9 裁决 2 已把「入口 + 子界面 + forget 直通」一并归 S11。推断：**以 §8 的「管理注册…」子界面为主形态**（用户无需另记 forget 命令），`lpm forget` 直通为快捷等价。请用户：确认 / 纠正（开工第一问）。
2. **`lpm dir` 的命令面**：`dir add <路径> / rm / ls` 的路径口径（用户级 `~/.lpm/config.json` 的 `scanDirs`）、`rm` 按值还是按索引删、与 S9 空态向导「添加扫描目录」写盘面的关系（S9 spec §4.4「写盘面」注：可手删、也可由 S11 的 `lpm dir rm` 撤销）。请用户：给出取向。
3. **`lpm forget` 对预设的影响**：forget 后预设里的旧名字失效（`lpm link --preset` 已按 S10 §4.4 整批停报错）；forget 侧是否在删除时**提示**（不洗）预设里的旧名字？推断：**不洗**（S10 §4.8「不静默丢用户数据」精神；洗了反而破坏预设完整性）。请用户：确认 / 纠正。
4. **交互化与 `collectLinkCandidates` 的复用**：S9 §7 行 461 说「已注册组」是子界面数据源——子界面删除后主列表即时反映的刷新机制（重新 collect 一次即可）；「按路径删除…」是否复用 `parsePathInput`/`resolveTarget` 解析（推断：是，格式引导同「其他…」）。

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push），改动由用户自行 commit —— 用户全局 Git 规则；S2–S10 惯例实证（S10 的 HEAD `0f9407d` 与后续 S10 实现提交均出自用户）
- 终端 Windows PowerShell；**skill 自带 bash 脚本不可用**（`sdd-workspace` / `task-brief` / `review-package` 均不可用）→ brief 载体＝「plan 文件 + 任务标题锚定」，评审载体＝「reviewer 直读产出文件 + 只读 diff」；**评审产物的 diff 一律用工具自身写文件**（`git diff --no-index --output=<file>`），禁止 PowerShell `>` 重定向接原生命令输出（写 BOM + 静默丢行，S9 账本实踩）——出处：S8/S9/S10 账本 Setup 裁定
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入 —— S1 账本，全局生效
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts **1.8.1** + execa + tsup + vitest；**运行时依赖零新增** —— PRD §14 行 391
- spec/plan 落盘惯例 `docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md`，日期取落盘当天 —— S1–S10 既成事实
- 冻结签名零改动：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3、**S9 §4.3**（含 `runLink`/`runUnlink` 签名与直通路径行为、`parsePathInput`/`collectLinkCandidates`/`collectLinkedItems`/`renderPlan` 等全部新增导出）、**S10 §4.3**（`LinkOptions` 追加的 `last?`/`all?`/`preset?` 3 个可选字段——缺省行为与 S9 交付态一致；`UnlinkOptions` 未扩）
- 编辑纪律：同一文件禁止并行 SearchReplace；import 与使用它的代码合并进同一次编辑；编辑后 `npx tsc --noEmit`（**禁用 GetDiagnostics**）
- Task 工具无 model 参数，统一默认模型；实现者禁止派生子代理；子代理同样禁止任何 git 写操作 —— S9 账本 R-LEDGER-1
- spec 评审通过前不动代码 —— PRD §14 行 395
- SDD workspace 惯例 `.superpowers/sdd/<plan 文件名>/`（含 `progress.md` 账本）；**零 commit 时账本是唯一证据 → 不删** —— S7/S8/S9/S10 账本 Ruling
- 单源口径（勿复制）：install 命令行展示走 `buildInstallCommandLine` / `buildForceInstallCommandLine`；package.json 写回走 `writeTextFileAtomic`；本地协议判定走 `rewriter.ts` 的 `LOCAL_PROTOCOL_RE` 与 `status.ts` 的 `isLocalish`；node_modules 形态判定走 `nmcheck.ts` 的 `probeNodeModules`；留痕构造走 `buildRunTrace` / `run-trace.ts` 的 `traceFailure`；**计划渲染走 `plan-view.ts` 的 `renderPlan`（勿再各写一份）**；**候选/已链接列表走 `collectLinkCandidates` / `collectLinkedItems`**；**last 单源 = `readLast` / `writeLast`；预设读写 = `readPresets` / `writeProjectConfig` 读-改-写（绝不丢损坏条目/未知字段）**
- 真实 yarn/npm 全链不进自动化（实验性 PM 走 smoke 手测清单，归用户） —— PRD §12 行 374–375；S6–S10 同口径

## 遗留裁决与留观项

- **S9 final-review parked（来源：`.superpowers/sdd/2026-09-28-s9-interactive.md/final-review-package.md` 与 `progress.md` 尾部）**：`LinkPlan.planAbandoned` 与 `UnlinkPlan.targets` / `UnlinkPlan.cwd` 三个**死字段**；`unlink.ts` 的「target→key 解析」在 `pickLinkedKeys` 与 `buildUnlinkPlan` 里**近乎逐字重复**（漂移风险）；`unlinkPreflight` 与交互入口**各调一次 `loadWorkspace`**；`[注册值损坏]` 只在 hint、label 无该前缀（spec §4.5 写的是「标」）；**link 侧 dry-run 缺整段黄金断言**（unlink 侧 UI-16 是 `toBe` 整段）；两入口 catch 块 6 行重复；测试 mock 头用 `vi.clearAllMocks()`（建议 `resetAllMocks`，防 once 队列串场）—— 收敛时机：S11 若复用列表/计划渲染，顺手收敛最省
- **S9 未覆盖分支清单**（来源：final review「What the tests still cannot catch」）：`addScanDir` 的失败分支、「加目录→重扫→列表出现」、`promptPaths`/`promptUnlinkPaths` 3 次重试耗尽、`keep.length === 0`（全 corrupt 剔除）、交互内三态/B4 取消的失败留痕 —— 收敛时机：下次触碰对应函数时补
- **CJK 三屏手测见证范围**：结论 = A1（用户 2026-09-28 判定「对齐 OK」），但夹具 `cfg.libs['@t/lib']` 指向的 `../../lpm-lib` 目录不存在 → 「真实 lib 的 hint 渲染」与「扫描发现组的 ★」两面**未被亲眼验证**；S10 又新增两个真实终端面（见下条）—— 下次带真实 lib 的手测一并对齐
- **S9 spec §4.4 行 215 措辞待回写**：该行把「dry-run 空分支 = 单行无缩进」写成通用规则，实际只描述 **link**（unlink 是「dry-run 首行 + 缩进行」）→ 应按命令分别描述（S10 T7 未顺手改，继续挂）
- **S10 新增的真实终端手测项（归用户，无 PTY 不可自动化）**：① `lpm preset` 菜单含 `[损坏]` label 的中文对齐 / 长行换行；② link 主列表「快捷」组的中文对齐 / 长行换行；③ `lpm link --preset`（缺值）的 commander 兜底报错（S10 T4 ⚠️ 项，未自动覆盖）
- **S10 各 minor (deferred) 摘要**（来源：S10 账本 progress.md）：T1 `presets: {}` 空对象分支无显式测试（与缺省路径同返回，风险极低）；T2 SV 用例缺「损坏条目撞名」钉子（实现判 `view.raw` 正确）；T3 E2E-S10-4 落在名为 save 的 describe 块内（命名观感，零功能影响）、PR-8 只钉 multiselect 未调用未钉 confirm（流程上必然未调用）、`stubTty` 用后不还原（vitest 按文件隔离 worker，无跨文件泄漏）；T4 LC-8/LC-9 snapshot 未含 state.json（观察性注记，断言范围已充分）；**T5 LC-16 声称钉「合法项 upsert 已落盘」实际只钉「未回滚」**（fixture 把全部键预先写入 cfg.libs 且路径一致 → `isNew` 恒 false；修复方向：让一个合法项的注册值 ≠ 实际相对路径使 `isNew=true`——**列入最终评审 triage**）；T5 集合级 dry-run + 全跳过不写 last 无专属钉（实现正确）；T6 VI-9 标题「去重后只链一次」判别力有限（真实价值 = 钉哨兵不泄漏进 targets）、VI-8 属「补断言」型弱钉
- **S6/S7 留观（S10 相关）**：S6「`listWorkspaceMembers` 形态 A 不含根成员」（S6 最终评审 N-5）；S7「`runForceInstall` 缺省 advice 为 link 向」「`--force` 叠加防冻结 flag（O7）」—— 来源：`.superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md §③`、`.superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md` 尾部
- **语义变化备查**：`lpm link ./lib @t/lib --dry-run` 这类「先路径后同名包名」输入，现为「静默去重」（改动前第二个 target 抛 `LinkArgumentError`）——方向是让 dry-run 与真实执行对齐，无既有用例覆盖（来源：S9 账本 OCR 修复波复评备注）

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -3` 确认 HEAD = `0f9407d` 且工作树面 = S10 的 10 项（5 `M` + 5 `??`，见「现状」）；**先请用户 commit S10 实现改动再开工**（S10 交付完整、`pnpm verify` 全绿，可直接提交）；跑 `pnpm verify` 复核基线（预期 typecheck 0 + build 成功 + unit 26 文件/447 例 + e2e 1 文件/33 例，exit 0）
2. 读 `.superpowers/sdd/2026-09-28-s10-collections-presets.md/progress.md` **尾部**（Setup 裁定、T1–T6 记录与全部 `minor (deferred)` 行、R2-1…R6-3 实施期裁定、T7 报告）
3. 读 PRD §7 行 266–267、§8 行 278–284、§9 行 303、§14 行 410 与 417
4. 读 S9 spec §4.5 / §7 行 461、S10 spec §4.7–§4.10 / §7 / §10
5. 读代码先例：`src/commands/registry.ts`（forget/dir 的 stub 现状）、`src/commands/link.ts` 的 `pickLinkTargets` / `runLinkInteractive` / `collectLinkCandidates`、`src/state/index.ts` 的 `readUserConfig` / `writeUserConfig`、`src/commands/preset.ts` 的 `readPresets`
6. 进入 brainstorming 一次一问澄清 S11 范围（**开工第一问 = 开放问题 1 的交互化边界**；预期澄清点见「开放问题」1–4）

## 开场话术

读 docs/handoffs/2026-09-28-s11-registry-management.md，按交接词继续：S11「登记管理」spec 期开工。注意：① S10 实现改动**未提交**（HEAD `0f9407d`，工作树 10 项未提交面），开工前先由用户 commit；② S11 的 forget 交互化依赖 S9/S10 的主列表组装点——「快捷」组已就位，S11 在「其他…」之后接入「管理注册…」，`pickLinkTargets` 已升级为 `{ targets, collectionLevel }`，接手时勿退回 `string[]`。
