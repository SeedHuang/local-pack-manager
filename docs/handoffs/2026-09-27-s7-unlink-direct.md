# Session 交接：lpm → S7 unlink 直通版（2026-09-27）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-27（Asia/Shanghai；本 session 自 2026-09-26 跨日延续，S6 主体与 OCR 轮均于 09-26 完成） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | 2e46fa0（`.git/refs/heads/master` 直读 = 2e46fa00fc47aa1b3953f5e19acfeb3bc04b3540，S5 为最后提交）；工作树：**S6 全部改动未提交**——新增 src/core/linkcheck.ts、src/core/install.ts、src/commands/link.ts；修改 src/cli.ts、src/state/atomic.ts、src/core/workspace.ts；测试 5 文件 + fixtures；docs（S6 spec/plan、S1 spec 回写、handoff）+ 仓库根 ocr-out.txt；完整清单以 `git status --porcelain -uall` 实查为准（开工第 1 项） |
| 验证基线 | typecheck 0 + build 成功 + unit 223/223（16 文件）+ e2e 16/16（`pnpm verify` exit 0——S6 OCR 轮收口后由 scoped re-reviewer 独立复跑，记录于 .superpowers/sdd/2026-09-26-s6-link-direct.md/ocr-rereview2.md §结论摘要，2026-09-26；交接时为只读会话未复跑，**开工第 1 项强制复核**） |
| 继任自 | docs/handoffs/2026-09-26-s6-link-direct.md |
| 状态 | 可直开工（无阻塞性开放问题；S7 范围澄清在 brainstorming 环节进行，预期澄清点见「开放问题」节） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（docs/prds/2026-09-25-lpm-v1-prd.md §14 行 404–416）。

## 现状

- 已完成并已提交（master，`.git/logs/HEAD` 直读）：S1+S2 = 1b46580；S3 = 3adad48；S4 = 96784dd；S5 = 2e46fa0
- **S6「link 直通版」完成但未提交**（BASE 2e46fa0，由用户自行 commit）：
  - 交付：`lpm link <名字|路径>... [--watch] [--dry-run]` 全链——linkcheck 前置检查（exports/main 入口解析、name 一致性、node_modules 空检查、build:watch script）、upsert 静默注册、非 lpm 本地链接三选一（head/manual/abandon）、B4 monorepo 根让选、按 manifestPath 分组链式改写（OCR O7）、崩溃安全顺序（先 state → 原子写 package.json → 单次 install → last → watch）、O4 完成提示、dry-run 零副作用
  - 质量链：五任务 SDD 逐任务评审（T2/T3 各 1 fix round 收口）→ 最终全量评审 **APPROVED**（0C/0I/7 Minor 留观，.superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md）→ 用户指令 OCR 评审轮（15 意见 = 1 critical + 4 medium + 10 low；12 修复 + 2 关闭 + 残余 2 条修复；两轮 scoped re-review 全 ADDRESSED，ocr-rereview.md / ocr-rereview2.md）——critical O1：execa 收 PM 逻辑 id（yarn-classic/yarn-berry）必 ENOENT，修为 PM_BINARY 单源 + pmExecutable/buildInstallCommandLine 导出
  - S6 spec 为 4 轮 multi-lens 收敛版（2 P0 + 5 P1 + 5 P2 全闭环，§10 有完整轮次记录 + OCR 轮记录与残余风险段）
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：S6 全部改动（源码/测试/fixtures/文档/ocr-out.txt）**由用户自行 commit**；.superpowers/sdd/2026-09-26-s6-link-direct.md\ 目录 16 份报告为 git-ignored 性质执行记录（S6 handoff 同款先例：提交后可清理，建议保留至 S7 收口）
- 工作树异常：无（最后核对记录：ocr-rereview2.md「未改动任何被审文件」+ 控制者其后仅 spec §10 / ledger 两处文档追加）

## 过程记录

- d:\Seed\local-pack-manager\.superpowers\sdd\2026-09-26-s6-link-direct.md\progress.md（S6 账本，**先读尾部**：OCR 评审轮全记录 14 条 Ruling O1–O14 + 残余①② + 计数链 223）
- 同目录：final-review.md（终审 + 留观分诊表 §③）、ocr-fix-report.md、ocr-rereview.md、ocr-fix2-report.md、ocr-rereview2.md、task-1~5-report/review.md（五任务过程）
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md → 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 本文件（S7 继任）
- spec/plan 落盘（未提交）：docs\superpowers\specs\2026-09-26-s6-link-direct-design.md（行为权威；§4.3 导出面 / §4.4 A–K 契约 / §6 错误表 17 条 / §8 后续衔接表 / §9 自决细节 / §10 评审 Backlog）、docs\superpowers\plans\2026-09-26-s6-link-direct.md（计划期修订 11 条；Task 3/4 代码块为执行前历史文本，以 spec 为权威）

## 本次任务

S7「unlink 直通版」（PRD docs/prds/2026-09-25-lpm-v1-prd.md §14 行 406：三态恢复、幂等、崩溃安全顺序；依赖 S6；承接 B1 P1）。流程沿用既定（S1–S6 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 docs/superpowers/specs/<落盘当日>-s7-<topic>-design.md → spec 自审（可用 multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan（docs/superpowers/plans/<落盘当日>-s7-<topic>.md）→ ④ SDD 逐任务实施（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief = 定向读 plan 对应 Task 节；每任务 reviewer 直读产出文件评审）→ 最终全量 review → pnpm verify 四段。起点：环节 ①。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §6.2 行 111–145（unlink 直通时序图：三态判定 alt 分支 / install 一次 / links 清空删文件 + 记 last / install 失败 state 保留）
  - §7 行 261（命令面：`lpm unlink <名字|路径>... [--all] [--dry-run]`；交互层归 S9）
  - §9 行 306（崩溃安全写入顺序 unlink 侧：**先恢复文件 → install 成功 → 才删 state**，失败重跑幂等）
  - §10 行 315–344（重点：三方核对矩阵 + **pnpm "Already up to date" 陷阱（行 324：unlink 在 install 后必须 lstat 验证 node_modules 实际指向，残留时 --force 重建）** + 软链判定 Windows 兼容（junction）+ 行 330–334 unlink 三态恢复 + 行 336–344 last.json 更新规则表：unlink 单个不动 / --all 与拆至清空记清空前完整集合）
  - §11 行 356–365（错误表：install 失败保留 state + 逃生门三步）
  - §12 行 375–385（smoke 手测清单 unlink 相关项：行 381 git diff 恢复原样 / 行 383 --all 后 --last 恢复 / 行 385 手动升级触发三态确认）
  - §14 行 406（S7 行）+ 附录 A 行 468（**B1 = unlink 无脑回写 original 会覆盖手动升级的 range → §10 三态恢复**）
- 要读（S6 spec docs/superpowers/specs/2026-09-26-s6-link-direct-design.md）：
  - §8 后续衔接表 S7 unlink 行（行 445）：`writeTextFileAtomic` 恢复写回复用；崩溃安全顺序镜像；InstallError 文案基线；**三态恢复的 original 单值边界（§4.4 E6a 注记）在 S7 收敛**
  - §9 自决细节 3（行 458）：同文件同 lib 多段命中原值异 → original 记首个命中值（S4 schema 单值限制；S7 期收敛）
  - 行 15：state 层嵌套不校验（S4 §2 决策 3）——S7 读 `entry.original`，嵌套防御归 S7（S4 spec §8 行 270）
  - 行 40：lstat 复验与 `--force` 重建归属（S7/S8，见开放问题 1）
  - §4.4 G1（original 键格式：`'<相对根>/package.json'`，根命中为 `package.json`）与 E5（每 manifest 每 target 恰一次改写、链式应用）——unlink 恢复的镜像参照
- 要读（S4 spec §8 行 269–270：readState/writeState/deleteState 衔接与嵌套防御归 S7）；（S5 spec §4.4：restoreDepValue 行为契约）
- 代码先例（勿改，作消费面）：src/commands/link.ts（S6 编排全景先例——E1 解析/幂等跳过/三选一/分组改写/崩溃顺序/last/O4 提示/reportError 单通道）、src/core/install.ts（runInstall/InstallError/pmExecutable/buildInstallCommandLine——**PM 映射单源，勿复制**）、src/core/rewriter.ts（restoreDepValue 恢复原 range；keys "段名.包名" 整体构造禁按 '.' 切分；peer 段不在改写面故 unlink 亦不碰）、src/state/index.ts（12 导出，含 deleteState 行 134 / readLast 行 139 / writeLast 行 151）、src/core/linkcheck.ts、src/cli.ts（命令注册惯例）
- 勿重做（已实现，1b46580/3adad48/96784dd/2e46fa0 + S6 未提交改动）：pm.ts、workspace.ts（含 listWorkspaceMembers/validatePatterns）、globmatch.ts、rewriter.ts 7 导出冻结面、state/index.ts、atomic.ts（writeTextFileAtomic/writeJsonFileAtomic）、linkcheck.ts、install.ts、commands/{use,link}.ts、cli.ts use/link 接线

## 开放问题

无阻塞性问题（S7 尚未开工，范围澄清在 brainstorming 一次一问展开，均带推断依据）：

1. **lstat 复验 + --force 重建的分期归属**——PRD §10 行 324 字面「lpm 的 **unlink** 在 install 后必须 lstat 验证 node_modules 实际指向」且 §11 行 361 列为错误路径处置，但 S6 spec §8 行 446 将「lstat 复验与 --force 重建」记为 S8 承接；推断：unlink 路径的 lstat 复验与 `--force` 重建入 S7（PRD 字面在 unlink 场景），status 的三方核对矩阵归 S8——brainstorming 第一问确认
2. `--all` 与 last.json 集合记录是否入 S7——推断：入（PRD §10 last 表「unlink --all / 拆至清空 → 清空前的完整集合」是 unlink 行为本体；`--last/--preset` 的**恢复**操作才归 S10）
3. 三态判定粒度——推断 per-file（state.original 按 manifestPath 键存原值，PRD §10 行 331「state 记录的文件已不存在 → 跳过该文件 + 警告」佐证）
4. E6a 单值边界收敛形态——推断：同文件多段原值异时恢复全部段写回首个命中 original（S4 schema 限制下唯一可行），spec 期定版提示文案
5. state 条目嵌套/损坏的防御形态（S4 §8 行 270 归 S7）——推断：读 entry.original 时校验 + 指向 PRD §11 行 364 手工逃生三步
6. `--dry-run` 形态——推断：照 S6 §4.4 K 计划数据结构复用（S9 执行计划预览同源）
7. install 失败的 state 保留与重跑提示——S6 错误表 #16 文案基线直接镜像（.superpowers 账本 OCR 轮 O1 教训：展示串一律走 buildInstallCommandLine 单源）

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push 等），改动由用户自行 commit —— 用户全局 Git 规则（S1 账本起承袭，S2–S6 惯例实证）
- 终端 Windows PowerShell，skill 自带 bash 脚本不可用；review = reviewer 直读产出文件（S1 账本行 5）
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入（S1 账本行 7，全局生效）
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest，**运行时依赖零新增**（PRD §14 行 391）—— lstat 用 node:fs，子进程用 execa
- spec/plan 落盘惯例 docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md，日期取落盘当天（S1–S6 既成事实）
- 冻结签名零改动：S1 spec §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3 所列公共 API 不得改动；新增导出沿用「公共 API 冻结面约定」——S7 新增导出同规（S6 先例：writeTextFileAtomic/listWorkspaceMembers/linkcheck 5 件/install 8 件/link 5 件）
- 原子写 = 临时文件 + rename；fs 失败 crash 语义不入错误契约（S3 账本 Ruling，S12 收敛）
- Task 工具无 model 参数，统一默认模型（S1 账本行 6）；实现者禁止派生子代理（S6 账本 Ruling）
- 测试期子代理运行后必须核对 git status（双 BOM 教训）；单文件一次 SearchReplace 合并 import 与代码；编辑后 `npx tsc --noEmit` 分级检查（S5 账本 Ruling，全局规则同款）
- spec 评审通过前不动代码（PRD §14 行 395）
- 崩溃安全顺序 unlink 侧为 PRD §9 行 306 定版：**先恢复文件 → install 成功 → 才删 state**（links 清空则删 state 文件 + 记 last），失败重跑幂等——S6 spec §8 行 445 镜像约定
- S6 产出消费契约（勿复制勿绕过）：install 命令串/展示一律走 install.ts 单源（PM_BINARY/buildInstallCommandLine——OCR O1 教训：PM 逻辑 id ≠ 可执行名）；package.json 恢复写回用 writeTextFileAtomic（文本级保真，BOM/CRLF/缩进零破坏）；original 键格式 `'<相对根>/package.json'`（根命中 `package.json`——S6 G1/F14）；last.json 只在集合级操作后更新（PRD §10 last 表）；peer 段不在改写面（link 未改，unlink 恢复不碰）
- 真实 yarn/npm 全链不进自动化（PRD §12 行 375：smoke 手测清单归用户；S6 O1 修复仅 mock 单测验证，S7 沿用同口径）

## 遗留裁决与留观项（与 S7 相关者）

- **S7 期顺手补 3 it**（S6 final-review N-7/M-4 分诊）：link-command 用例缺口——§7.2 #22 批量遇错即停反例 / #13 同 key 去重反例 / #20 watch 行断言——建议在 S7 写 unlink 编排测试时于 link-command.test.ts 顺手补（final-review.md §③ 分诊表）
- E6a original 单值边界：S7 spec 期收敛（S6 spec §9 行 458）
- state 嵌套防御：S7 读 entry.original 时落地（S4 spec §8 行 270）
- S6 spec 瑕疵顺手项：§7.4 #4 括号漏列 LinkTargetError（final-review N-6，补一词）；linkcheck 空 name 豁免 spec 补句（N-4，S7+ spec 维护顺手）
- O1 残留：真实 yarn 项目实跑 install 未实测（PRD §12 smoke 归用户手测，非 S7 自动化范围）
- S12 远期窗口（S7 不处理）：atomic catch 内 rmSync 掩盖原错误、atomic 两函数核心重复（OCR O13）、错误建议全局化、T3③ 依据前缀文案

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -3` 确认 HEAD 与未提交面（若用户已 commit S6，HEAD 前移属正常，以新 HEAD 为 BASE）；跑 `pnpm verify` 复核基线（预期 typecheck 0 + build + unit 223/223 + e2e 16/16）
2. 读 .superpowers/sdd/2026-09-26-s6-link-direct.md/progress.md 尾部（OCR 轮 14 条 Ruling + 计数链 223）与 final-review.md §③ 留观分诊表
3. 读 PRD §6.2 行 111–145 + §9 行 306 + §10 行 315–344 + §11 行 356–365 + §14 行 406 + 附录 A 行 468；读 S6 spec §8 衔接表 + §9 自决细节 + §4.4 E5/G1（恢复镜像参照）
4. 读 src/commands/link.ts（编排先例全文）+ src/core/install.ts + src/core/rewriter.ts（restoreDepValue 签名）+ src/state/index.ts 导出面（deleteState/readLast/writeLast）
5. 进入 brainstorming 一次一问澄清 S7 范围（预期澄清点见「开放问题」节，问题 1 为分期归属第一问）

## 开场话术

读 docs/handoffs/2026-09-27-s7-unlink-direct.md，按交接词继续：S7「unlink 直通版」spec 期开工。注意：S6 改动尚未 commit，先按交接词「开工前先做」第 1 项处理。
