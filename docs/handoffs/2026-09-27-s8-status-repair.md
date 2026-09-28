# Session 交接：lpm → S8 status + repair（2026-09-27）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-27 22:42（Asia/Shanghai） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | cb1e0e0（`git log --oneline -3` 直读 = `cb1e0e0 feat: 实现 unlink 直通版核心功能`）；工作树：clean（`git status --porcelain -uall` 零输出） |
| 验证基线 | typecheck 0 错误 + build 成功（dist/cli.js 78.33 KB）+ unit 268/268（17 文件）+ e2e 21/21（`pnpm verify` exit 0，2026-09-27 22:42 实跑） |
| 继任自 | docs/handoffs/2026-09-27-s7-unlink-direct.md |
| 状态 | 可直开工（无阻塞性开放问题；S8 范围澄清在 brainstorming 环节一次一问展开，预期澄清点见「开放问题」节） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（docs/prds/2026-09-25-lpm-v1-prd.md §14 行 404–416）。

## 现状

- 已完成并已提交（master，`git log --oneline` 直读）：S1+S2 = 1b46580；S3 = 3adad48；S4 = 96784dd；S5 = 2e46fa0；S6 = 7d38504；**S7 = cb1e0e0**
- **S7「unlink 直通版」已完成并已 commit**（cb1e0e0，16 文件 +2971/−25，`git show --stat cb1e0e0` 直读）：
  - 交付：`lpm unlink <名字|路径>... [--all] [--dry-run]` 全链——三态恢复 per-file（link:/file:/portal: → 恢复 original；= original → 幂等跳过；其他 range → 冲突二选一含 isCancel 放弃/非 TTY 报错/dry-run 降级警告）、崩溃安全顺序（先恢复文件 → install 恰一次 → lstat/realpath 复验 + `--force` 重建恰一次 → 才删 state）、拆至清空时 **last 先写（记清空前完整集合）后 deleteState**、条目级 state 损坏校验（LinkStateCorruptError）、`--all` 与 targets 互斥、空 state 幂等退出 0
  - 代码面：新增 src/commands/unlink.ts（420 行）+ tests/unit/unlink-command.test.ts（419 行 / 30 it）；修改 src/cli.ts、src/commands/link.ts（导出面扩展）、src/core/install.ts（runInstall 可选第三参 retryAdvice + runForceInstall + buildForceInstallCommand/Line）、src/core/rewriter.ts（readDepValues + LOCAL_PROTOCOL_RE 由 PROTOCOL_BY_PM 派生）；tests/e2e/cli.e2e.test.ts +5 例
  - 质量链：五任务 SDD 逐任务评审双通过 → 最终全量评审 **With fixes**（0 Critical / 2 Important）→ 一次修复波 + scoped 复评（2/2 ADDRESSED，零新破坏）→ 用户指令 **OCR 评审轮**（7 意见 = 1 high + 2 medium + 4 low；处置 4 修 + 1 文案显性化 + 1 带候选不改 + 1 仅文档）——证据：.superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md 尾部
  - 随 cb1e0e0 一并提交的文档：docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md（364 行）、docs/superpowers/plans/2026-09-27-s7-unlink-direct.md（1279 行）、S1 spec 与 S6 spec 回写 hunk、docs/review/20260927/s6-link-direct-retro.md、仓库根 ocr-out-s7-review.txt
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：已 commit（HEAD cb1e0e0 含全部 S7 改动与文档；本轮无未提交项）
- 工作树异常：无

## 过程记录

- d:\Seed\local-pack-manager\.superpowers\sdd\2026-09-27-s7-unlink-direct.md\progress.md（S7 账本，**先读尾部**：SDD 五任务计数链 223→230→235→264→265→268 + 最终评审分诊 + OCR 轮 O1–O8 三态处置表 + 延后 Minor 清单 + 4 条 Ruling）
- 同目录 12 份：task-1..4-brief.md / task-1..4-report.md / task-3-review-package.txt / task-4-review-package.txt / final-review-package.txt / task-final-fix-report.md
- 上一阶段：.superpowers\sdd\2026-09-26-s6-link-direct.md\（S6 账本 + final-review.md §③ 留观分诊表 + ocr-rereview.md / ocr-rereview2.md）
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md（另有 -0903 同日消歧版）→ 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 2026-09-27-s7-unlink-direct.md → 本文件（S8 继任）

## 本次任务

S8「status + repair」（PRD docs/prds/2026-09-25-lpm-v1-prd.md §14 行 407：**三方核对矩阵、drift/orphan 修复**；依赖 S6 S7；承接 B8）。流程沿用既定（S1–S7 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 docs/superpowers/specs/<落盘当日>-s8-<topic>-design.md → spec 自审（可用 multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan（docs/superpowers/plans/<落盘当日>-s8-<topic>.md）→ ④ SDD 逐任务实施（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief 由 plan 对应 Task 节提取；每任务 reviewer 直读产出文件评审）→ 最终全量（whole-branch）评审 → 用户指令触发 OCR 评审轮 → pnpm verify 四段。起点：环节 ①。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §7 行 262–263（命令面定版：`lpm status [--json]`——「JSON 供脚本与 E2E 测试消费」；`lpm repair`——「交互确认」）
  - §10 行 314–344（重点：**三方核对矩阵 5 行 行 318–324**（含 行 324「linked + link:... + node_modules 实体/旧指向 → install 未生效 → 提示重跑 install」）+ pnpm "Already up to date" 陷阱 行 326 + 软链判定 Windows 兼容（junction 回退）行 328 + unlink 三态 行 330–335 + last 表 行 337–344）
  - §11 行 346–364（错误表：install 未生效 → lstat 复验 + `--force` 重建 行 361；repair 无法处理/state 损坏 → **手工逃生三步** 行 362 + 逃生门原则 行 364）
  - §13 行 376–386（**验收 6 行 383**「漂移场景（手动 git checkout package.json）被 status 正确报告，repair 可清」；行 386 明确 1/3/4/5/6/7 为自动可验证，2/8 人工）
  - §14 行 407（S8 行）+ 附录 A 行 475（**B8 = 三方核对的 node_modules 判定未落地 → §10 状态表第三列 + lstat 要求**）
  - §12 行 374（软链判定兼容 symlink 与 junction；实验性 PM 走 smoke 手测清单）
- 要读（S7 spec docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md）：
  - §8 行 295–301（后续衔接：S8 消费 S7 的 **realpath 判定形态可复用** + LinkStateCorruptError 语义 + drift 中间态判定面）
  - §9 行 303–314 自决 5（全文件缺失 key 条目保留 → **S8 repair 收敛**——本阶段直接相关）
  - §10 行 316+（评审 Backlog：OCR 轮 O1–O8 三态处置 + 候选 O1 分段判定 / O4 计数回滚 / O7 force flag）
- 要读（S6 spec docs/superpowers/specs/2026-09-26-s6-link-direct-design.md §8 行 441–449）：衔接表 S8 行 446 记载「lstat 复验与 `--force` 重建未在 S6 落地——S8 三方核对承接」——**注意该条已在 S7 unlink 侧落地**（cb1e0e0），S8 只承接三方核对**矩阵判定**，见「开放问题」1
- 代码先例（勿改，作消费面）：
  - src/commands/unlink.ts（全文；**verifyResidue 行 95–130 为 realpath 判定原语，当前私有**——S8 三方核对需同款判定，见开放问题 2；崩溃安全编排与 reportError 单通道先例）
  - src/commands/link.ts（link 编排先例；导出面含 resolveTarget / resolveMonorepo / ResolvedTarget / LinkCancelledError / LinkInteractionError（kind 含 'conflict-ternary'）——S7 已导出）
  - src/core/install.ts（runInstall(rootDir, pm, retryAdvice?)、runForceInstall、buildInstallCommandLine、buildForceInstallCommandLine、detectLibPM、pmExecutable——**PM 映射与命令行展示单源，勿复制**）
  - src/core/rewriter.ts（readDepValues、LOCAL_PROTOCOL_RE（由 PROTOCOL_BY_PM 派生）、restoreDepValue、mapProtocol、findDepEntries）
  - src/core/linkcheck.ts（checkLib / LibCheckError——三方核对不需前置检查，但错误文案基线可参照）
  - src/core/workspace.ts（findWorkspaceRoot / loadWorkspace / findDependents / listWorkspaceMembers / validatePatterns）
  - src/state/index.ts（12 导出：readState/writeState/deleteState/readLast/writeLast/readProjectConfig/writeProjectConfig/readUserConfig/writeUserConfig/ensureGitignoreEntry + 两类 ParseError）+ src/state/atomic.ts（writeTextFileAtomic/writeJsonFileAtomic）+ src/state/types.ts（LinkState/LastSet/ProjectLpmConfig）
  - src/commands/registry.ts 行 11–12（status summary「三方核对链接状态」/ repair summary「修复漂移与孤儿状态」，plannedSpec = 'S8'——接线时走特判分支去掉「（计划 S8）」后缀，S3/S6/S7 惯例）
- 勿重做（已实现，1b46580/3adad48/96784dd/2e46fa0/7d38504/cb1e0e0）：pm.ts、workspace.ts（含 listWorkspaceMembers/validatePatterns）、globmatch.ts、rewriter.ts 导出面、state/*、atomic.ts、linkcheck.ts、install.ts、commands/{use,link,unlink}.ts、cli.ts 四命令接线（use/link/unlink 已实现，其余 stub）

## 开放问题

S8 尚未开工，范围澄清在 brainstorming 一次一问展开；以下均带推断依据，供确认或纠正：

1. **repair 的写动作边界**（**开工第一问**）——PRD §10 行 324 对「install 未生效」只说「提示重跑 install」，而 S7 已在 unlink 侧落地 lstat 复验 + `--force` 重建；S8 的 repair 是否自带写动作（改声明 → install → 必要时 `--force` → state 对齐），还是仅输出建议。推断：**repair 具备写动作**（PRD §13 行 383「repair 可清」+ §11 行 361 的处置动作字面），复用 runInstall / runForceInstall；S7 spec §8 行 299 亦记载「realpath 判定形态可复用」
2. **verifyResidue 的提取归属**——现为 src/commands/unlink.ts 行 95–130 私有函数，S8 三方核对需同款 realpath/junction 判定。推断：**提取为 core 模块**（如 src/core/nmcheck.ts）或由 unlink.ts 导出，供 link/unlink/status/repair 共用；代价：需改动 S7 已提交文件（属重构，须 spec 定版并复核 S7 测试零回归）
3. **status --json 的 schema 形态**——PRD §7 行 262 仅说「JSON 供脚本与 E2E 测试消费」，无字段定义。推断：顶层 `{ version, rootDir, entries: [...] }`，每 entry `{ key, state: 'linked'|'none', pkgValues: [{ section, value }], nm: { status: 'ok'|'missing'|'residue'|'junction'|'unknown', target?, note? }, verdict: 'linked'|'registry'|'drifted'|'orphan'|'install-ineffective', suggestions: string[] }`
4. **drift / orphan 的修复语义**——PRD 行 322（linked + registry range → 提示 unlink / repair）与 行 323（无 state + link: → repair 问用户 / 从 git 恢复）。推断：drift → repair 重新 link（用 mapProtocol 重写协议值 + install）；orphan → 复用 S6 三选一通道（git HEAD / 手动输入 / 放弃，S6 spec §4.4 F + link.ts 先例）取得 original 后补 state 或恢复文件
5. **验收 6 的自动化形态**——PRD 行 383/386 要求自动可验证。推断：fixture 构造 §10 矩阵五形态 → status 断言 verdict、repair 断言写盘与 state 变化（镜像 S6 §7.4 验收 7 的 dry-run 一致性做法）
6. **矩阵行 行 324（install 未生效）复用通道**——推断：S8 直接复用 S7 的 `--force` 通道（core 单源），不新写第二份判定/子进程构造

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push 等），改动由用户自行 commit —— 用户全局 Git 规则（S1 账本起承袭，S2–S7 惯例实证）
- 终端 Windows PowerShell，skill 自带 bash 脚本不可用；review = reviewer 直读产出文件（S1 账本行 5）
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入（S1 账本行 7，全局生效）
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest，**运行时依赖零新增**（PRD §14 行 390）——S8 判定用 node:fs（lstat/realpath/stat），子进程用 execa
- spec/plan 落盘惯例 docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md，日期取落盘当天（S1–S7 既成事实）
- 冻结签名零改动：S1 spec §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3 所列公共 API 不得改动；新增导出沿用「公共 API 冻结面约定」
- 原子写 = 临时文件 + rename；fs 失败 crash 语义不入错误契约（S3 账本 Ruling，S12 收敛）
- Task 工具无 model 参数，统一默认模型（S1 账本行 6）；实现者禁止派生子代理（S6 账本 Ruling）
- 测试期子代理运行后必须核对 git status（双 BOM 教训）；单文件一次 SearchReplace 合并 import 与代码；编辑后 `npx tsc --noEmit` 分级检查（S5 账本 Ruling，全局规则同款）
- spec 评审通过前不动代码（PRD §14 行 395）
- 崩溃安全顺序：link 侧 = 先 state → 改 package.json → install；unlink 侧 = 先恢复文件 → install → 复验/`--force` → 才删 state（PRD §9 行 306；S7 已落地 cb1e0e0）——**S8 repair 的写序须自定并写进 spec**（推断：改声明 → install → 复验 → 对齐 state）
- 全 lpm 状态文件（state/last/config）皆「可删除重建」（PRD §11 行 364 逃生门原则）；repair 无法处理时文案必须指向手工逃生三步（PRD 行 362）
- S7 产出消费契约（勿复制勿绕过）：install 命令行展示一律走 buildInstallCommandLine / buildForceInstallCommandLine（PM_BINARY 单源——OCR O1 教训）；package.json 写回用 writeTextFileAtomic（文本级保真 BOM/CRLF/缩进）；本地协议判定用 LOCAL_PROTOCOL_RE（由 PROTOCOL_BY_PM 派生，勿再写字面量）；state.original 键格式 `'<相对根>/package.json'`（根命中 `'package.json'`）；peer 段不在改写面
- 真实 yarn/npm 全链不进自动化（PRD §12 行 374：smoke 手测清单归用户；S6/S7 同口径）

## 遗留裁决与留观项（与 S8 相关者）

- S7 延后 Minor（来源：.superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md 尾部；收敛时机：S8 期或下次触碰 src/commands/unlink.ts）：dry-run「剩余 N 条」非逐条递减 / 放弃时 planIdempotent·planMissing 未回滚（= OCR O4）/ runForceInstall 缺省 advice 为 link 向 / buildForceInstallCommand(_pm) 为对称占位参 / 测试缺口（UNL-25 仅断 exit code、无 unlink 层 BOM-CRLF 端到端、E2E-7/8 仅断 exit code）/ state 键 `..` 路径穿越（纵深防御，威胁模型外）
- S7 spec §10 候选（触发信号再评估）：**O1 分段判定**（同 manifest 多段中被手动改一段；触发 ≥2 次，届时须与 §4.4 D3 及 S4 schema 单值限制一并评估）/ **O7 force 叠加防冻结 flag**（CI 冻结配置下重建失败）
- S7 spec §9 自决 5：全文件缺失 key 条目保留 —— 收敛时机：**S8 repair**（本阶段直接相关）
- S6 留观（来源：.superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md §③）：N-6 / N-4 已在 S7 落位（S6 spec §7.4 #4 补词 LinkTargetError、§4.4 C4 空名豁免句，随 cb1e0e0 提交）；N-5（listWorkspaceMembers 形态 A 不含根成员）留观
- S12 远期窗口（S8 不处理）：atomic catch 内 rmSync 掩盖原错误、atomic 两函数核心重复、错误建议全局化、T3③ 依据前缀文案

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -3` 确认 HEAD = cb1e0e0 且工作树 clean；跑 `pnpm verify` 复核基线（预期 typecheck 0 + build + unit 268/268（17 文件）+ e2e 21/21，exit 0）
2. 读 .superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md 尾部（SDD 五任务计数链 + 最终评审分诊 + OCR 轮 O1–O8 处置表 + 延后 Minor + 4 条 Ruling）与 .superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md §③ 留观分诊表
3. 读 PRD §7 行 262–263 + §10 行 314–344 + §11 行 346–364 + §13 行 376–386 + §14 行 407 + 附录 A 行 475；读 S7 spec §8 行 295–301 + §9 行 303–314 + §10 行 316+；读 S6 spec §8 行 441–449
4. 读 src/commands/unlink.ts（重点 verifyResidue 行 95–130 与崩溃安全编排）+ src/core/install.ts + src/core/rewriter.ts（readDepValues/LOCAL_PROTOCOL_RE）+ src/state/index.ts 导出面 + src/commands/registry.ts 行 11–12
5. 进入 brainstorming 一次一问澄清 S8 范围（问题 1「repair 写动作边界」为开工第一问；预期澄清点见「开放问题」节 1–6）

## 开场话术

读 docs/handoffs/2026-09-27-s8-status-repair.md，按交接词继续：S8「status + repair」spec 期开工。注意：S7 已由用户 commit（HEAD cb1e0e0），工作树 clean，可直接开工。
