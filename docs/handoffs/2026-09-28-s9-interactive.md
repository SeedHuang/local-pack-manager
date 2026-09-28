# Session 交接：lpm → S9 交互层（2026-09-28）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-28 16:28（Asia/Shanghai） |
| 项目根 | d:\Seed\local-pack-manager |
| HEAD | `0b78b49`（`git log --oneline -10` 直读 = `0b78b49 feat: S8 运行留痕与节点模块链接状态检查`）；工作树：**clean**（`git status --porcelain -uall` 零输出，2026-09-28 16:28 实跑） |
| 验证基线 | typecheck 0 错误 + build 成功（dist/cli.js 115.28 KB）+ unit **324/324**（20 文件）+ e2e **26/26**（`pnpm verify` exit 0，2026-09-28 16:28 实跑） |
| 继任自 | docs/handoffs/2026-09-27-s8-status-repair.md |
| 状态 | 可直开工（S9 范围澄清在 brainstorming 一次一问展开；预期澄清点见「开放问题」节） |

## 项目定位

d:\Seed\local-pack-manager —— lpm（Local Pack Manager）：本地 lib link/unlink 联调管理 CLI，TypeScript ESM + Node ≥22.12 + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（PRD 见 docs/prds/2026-09-25-lpm-v1-prd.md）。

## 现状

- 已完成并已提交（master，`git log --oneline -10` 直读自证）：S1+S2 = `1b46580`；S3 = `3adad48`；S4 = `96784dd`；S5 = `2e46fa0`；S6 = `7d38504`；S7 = `cb1e0e0`；**S8 = `0b78b49`**
- **S8「status + repair」已完成并已 commit**（`0b78b49`，`git show --stat` 直读：23 文件 +4056/−146）：
  - 交付：`lpm status [--json]`（三方核对：档案 `.lpm/state.json` × 声明 `package.json` × 目录 `node_modules`；报告范围 A′＝注册 ∪ 档案 ∪ 声明为本地链接；六族异常 `drifted`/`install-ineffective`/`orphan`/`stale-link`/`stale-record`/`corrupt`；纯只读；退出码 0=核对完成 / 1=无法核对）+ `lpm repair [--dry-run]`（六族自修复，写序＝声明改写 → install 恰一次 → 复验/至多一次 `--force` → 档案对齐 → 留痕；前三段失败档案零改动；统一前置判定 + 一次确认默认否；非 TTY 且有可执行动作 → exit 1）+ `src/core/nmcheck.ts`（node_modules 探查原语，unlink/status/repair 共用）+ `.lpm/last-run.json` 运行留痕（link/unlink/repair 写，status 不写）+ `src/commands/run-trace.ts`（失败留痕工厂）
  - 质量链：5 任务 SDD 逐任务评审（每任务均过修复轮 + scoped 复评）→ 最终全量评审 **1 Critical + 3 Important + 3 Minor** → 一次修复波（7 项）+ scoped 复评 → 用户指令 **OCR 评审轮**（9 条 = 0 critical/0 high/5 medium/4 low；采纳 7 / 候选 2 / 关闭 0）+ scoped 复评。证据见「过程记录」的 S8 账本与报告
  - 随 `0b78b49` 一并提交：docs/superpowers/specs/2026-09-28-s8-status-repair-design.md、docs/superpowers/plans/2026-09-28-s8-status-repair.md、docs/handoffs/2026-09-27-s8-status-repair.md、ocr-out-s8-review.txt、.trae/rules/ 下两个新规则文件、docs/review/20260927/s6-link-direct-retro.md 的删除
- 验证证据：见元信息表『验证基线』（单源，勿在此重复填写）
- 提交状态：**已 commit**（HEAD 见元信息表；本 session 无未提交项，工作树 clean）
- 工作树异常：无。注意 `.superpowers/` 被 `.gitignore` 忽略（`git check-ignore -v` 实证命中 `.gitignore:4:.superpowers/`）——SDD 账本只存在于磁盘、不在 git 历史中

## 过程记录

- **S8 账本（先读尾部）**：`.superpowers/sdd/2026-09-28-s8-status-repair.md/progress.md` —— 含 Setup/Preflight 裁定表（PF-1…PF-7）、T1–T5 逐任务记录与全部 `minor (deferred)` 行、最终全量评审（1C+3I+3M）与其修复波、OCR 评审轮三态处置表、以及候选项触发信号
- 同目录报告：`task-1-report.md` … `task-5-report.md`、`final-fix-report.md`、`ocr-fix-report.md`
- 上一阶段：`.superpowers/sdd/2026-09-27-s7-unlink-direct.md/`（S7 账本 + 4 条 Ruling + 延后 Minor 清单）
- 历史交接词链：2026-09-25-s4-config-state.md → 2026-09-26-s4-config-state.md（另有 -0903 同日消歧版）→ 2026-09-26-s5-rewrite-engine.md → 2026-09-26-s6-link-direct.md → 2026-09-27-s7-unlink-direct.md → 2026-09-27-s8-status-repair.md → 本文件（S9 继任）

## 本次任务

S9「交互层」（PRD §14 行 408：**link/unlink 交互、空态向导、执行计划预览**；依赖 S6 S7；承接 review 修复 O1）；流程沿用既定（S1–S8 惯例）：① brainstorming 澄清（一次一问）→ ② spec 落盘 `docs/superpowers/specs/<落盘当日>-s9-<topic>-design.md` → spec 自审（multi-lens-review）→ 交用户终审（通过前不动代码）→ ③ writing-plans 出 plan（`docs/superpowers/plans/<落盘当日>-s9-<topic>.md`）→ ④ SDD 逐任务实施（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief 载体＝「plan 文件 + 任务标题锚定」；每任务 reviewer 直读产出文件评审）→ 最终全量（whole-branch）评审 → 用户指令触发 OCR 评审轮 → `pnpm verify` 四段。起点：**环节 ①**。

## 范围依据

- 要读（PRD docs/prds/2026-09-25-lpm-v1-prd.md）：
  - §7 行 255–270（命令全集；**行 260** link 的交互列「分组多选 + 空态向导 + "其他"路径引导 + 列表内管理注册」；**行 261** unlink 的「已链接列表多选（显示恢复去向）+ "按路径取消…"入口」）
  - §8 行 272–293（交互设计原则 + **行 276 起的六个关键界面**：link 主列表 / link 注册管理 / unlink 列表 / 执行计划预览 / 空态 / monorepo 根让选）
  - §14 行 389–417（**行 408** S9 行；**行 391** 技术选型；**行 417** M2 执行顺序）
  - §15 行 419–427（**行 426 第 6 条：@clack/prompts 对 CJK 宽字符边框对齐有已知小问题 → S9 开工前用中文界面冒烟验证，不达标则换 inquirer 或自绘**）
  - §16 行 428+（P2 处置清单：`--yes` 跳过执行计划确认**已关闭**为伪需求——勿重议；v2 候选「link 期间 git stash/restore 自动化」触发信号＝误 commit 事故实际发生）
  - 附录 A 行 482（C2：S11 依赖 S9 但 §14 执行顺序写「可并行」）
- 要读（S8 spec docs/superpowers/specs/2026-09-28-s8-status-repair-design.md）：**§8 后续衔接**（S9 行：status 判定面复用为交互列表状态标记、repair 计划结构复用为执行计划预览）；**§4.3** 的 `scanLinkState` / `ScanOutcome` / `EntryScan` / `FileScan` / `IssueFamily` 导出签名；§4.5 的计划三类信息与 `clack.confirm({initialValue:false})` 先例
- 要读（S7 spec §8 行 295–301 的 S9 行、S6 spec §8 的 S9 行）：无参数交互（S7 仅提示）、冲突二选一交互化升级（`clack.select` 最小交互为基线）、dry-run/执行计划结构复用、B4 让选交互化升级
- 代码先例（勿改，作消费面）：
  - src/commands/link.ts（`runLink` 的 A1 无参数分支**已由 S9 交付交互入口**：TTY → 交互（空态向导 / 分组多选 / 预览 + 一次确认），非 TTY → 一行提示 + exit 1；`ternaryOriginal` 与 `ABANDON` **已导出**，S9 交互直接复用）
  - src/commands/unlink.ts（无参数分支**已由 S9 交付交互入口**（同上形态）；`validateEntry` / `LinkStateCorruptError` / `ESCAPE_HATCH` 已导出；冲突二选一现为最小 `clack.select`）
  - src/commands/status.ts（`scanLinkState` 判定面 + `isLocalish` 单源导出 → unlink 列表 `[漂移]` 标记的数据源）
  - src/commands/repair.ts（统一前置判定 + `printPlan` 三类信息 + `clack.confirm` 默认否 → 执行计划预览的形态先例）
  - src/core/nmcheck.ts（`probeNodeModules`）；src/commands/run-trace.ts（失败留痕工厂）；src/state/index.ts（`buildRunTrace` / `writeRunTrace`）
- 勿重做（已实现并已提交）：pm.ts、workspace.ts、globmatch.ts、rewriter.ts、state/*、atomic.ts、linkcheck.ts、install.ts、commands/{use,link,unlink,status,repair}.ts、cli.ts 五命令接线（use/link/unlink/status/repair 已实现；save/preset/forget/dir/init/uninit 仍为 stub）

## 开放问题

1. **S9 交付边界是否包含 forget 的交互化？** 推断：**不含**——PRD §14 行 410 把 forget 交互化归 S11，且行 417 说明「S11 的 forget 交互化部分依赖 S9」；S9 只做 link/unlink 无参数交互 + 空态向导 + 执行计划预览。请用户：确认 / 纠正。
2. **交互库（@clack/prompts）是否需重选？** 推断：**先按 PRD §15 行 426 跑一次中文界面冒烟（CJK 宽字符边框对齐）再定**——不达标才换 inquirer 或自绘。**开工第一问**（PRD 已把它列为 S9 前置）。请用户：确认冒烟范围（哪几个界面算达标）/ 纠正。
3. **执行计划预览复用哪一份计划结构？** 推断：以 S6 §4.4 K 计划（upsert/改写明细）与 S8 repair 的 `printPlan` 三类信息为形态基准，抽成 S9 统一的「执行计划预览」数据形状。请用户：确认是否要求五命令（link/unlink/repair）预览完全同构。
4. **无参数交互是否覆盖 status/repair？** 推断：**不覆盖**——PRD §7 行 262–263 明确 status 交互列为「—」、repair 为「交互确认」（已在 S8 落地一次确认）。请用户：确认 / 纠正。
5. **交互模式与 `--dry-run` 的关系**：推断：交互流程内的「执行计划预览」即预览环节，用户无需再手打 `--dry-run`（PRD §8 行 280 已把它作为交互流程一环）；直通模式仍保留 `--dry-run`。请用户：确认 / 纠正。

## 既定约束（不要重新讨论、不要重新选型）

- 禁止一切 Git 写操作（worktree/分支/commit/push），改动由用户自行 commit —— 用户全局 Git 规则；S2–S8 惯例实证（本 session 的 S8 已由用户 commit 为 `0b78b49`）
- 终端 Windows PowerShell；**skill 自带 bash 脚本不可用**（`sdd-workspace` / `task-brief` / `review-package` 均不可用）→ brief 载体＝「plan 文件 + 任务标题锚定」，评审载体＝「reviewer 直读产出文件」——出处：`.superpowers/sdd/2026-09-28-s8-status-repair.md/progress.md` Setup 裁定
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入 —— S1 账本，全局生效
- 技术栈定版：TS ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest；**运行时依赖零新增** —— PRD §14 行 391
- spec/plan 落盘惯例 `docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md`，日期取落盘当天 —— S1–S8 既成事实
- 冻结签名零改动：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、**S8 §4.3** 所列公共 API；新增导出沿用「公共 API 冻结面约定」
- 编辑纪律：同一文件禁止并行 SearchReplace；import 与使用它的代码合并进同一次编辑；编辑后 `npx tsc --noEmit` 分级检查（**禁用 GetDiagnostics**，其结果为 TS Server 缓存）
- Task 工具无 model 参数，统一默认模型；实现者禁止派生子代理；子代理同样禁止任何 git 写操作
- spec 评审通过前不动代码 —— PRD §14 行 395
- SDD workspace 惯例 `.superpowers/sdd/<plan 文件名>/`（含 `progress.md` 账本）；**本轮零 commit 时账本是唯一证据 → 不删 workspace** —— S7/S8 账本 Ruling
- `--yes` 跳过执行计划确认已**关闭**为伪需求 —— PRD §16 关闭项
- 真实 yarn/npm 全链不进自动化（实验性 PM 走 smoke 手测清单，归用户） —— PRD §12 行 374；S6/S7/S8 同口径
- 单源口径（勿复制）：install 命令行展示走 `buildInstallCommandLine` / `buildForceInstallCommandLine`；package.json 写回走 `writeTextFileAtomic`（文本级保真 BOM/CRLF/缩进）；本地协议判定走 `rewriter.ts` 的 `LOCAL_PROTOCOL_RE` 与 `status.ts` 的 `isLocalish`；node_modules 形态判定走 `nmcheck.ts` 的 `probeNodeModules`；留痕构造走 `buildRunTrace` / `run-trace.ts` 的 `traceFailure` —— S8 spec §8 与账本

## 遗留裁决与留观项

- **S8 OCR 候选 2 条**：① `'.lpm/state.json'` 字面量硬编码 3 处（触发信号：`.lpm/` 布局或留痕 `target` 语义变更）；② `planOrphan` 每孤儿文件各求一次原值（触发信号：同一孤儿库被两个成员目录声明且无兄弟来源 ≥ 2 次）—— 来源：S8 账本 OCR 轮节 + S8 spec §10 OCR 表；收敛时机：触发信号出现时
- **S8 deferred minors**（来源：S8 账本各 Task 的 `minor (deferred)` 行）：`--json` 为 spec 示例超集、屏幕文案未与 §4.4 示例逐字一致、ST-3…ST-7 只断屏幕文案、REP-19 的 `ProtocolPathError` 文案由测试注入、「计划三类信息/stale-link 当前指向/失败 stderrTail 内容/确认语文案」无断言 —— 收敛时机：S9 若复用 status 输出与 repair 计划，**顺手补断言最省**
- **S7 延后 Minor**（来源：`.superpowers/sdd/2026-09-27-s7-unlink-direct.md/progress.md` 尾部）：dry-run「剩余 N 条」非逐条递减 / `runForceInstall` 缺省 advice 为 link 向 / `buildForceInstallCommand` 为对称占位参 / 测试缺口（UNL-25 弱断言、无 unlink 层 BOM-CRLF 端到端、E2E-7/8 弱断言）—— 收敛时机：**S9 必然触碰 `src/commands/unlink.ts` 的无参数分支**，届时最省
- **S7 spec §10 候选**：O1 分段判定（同 manifest 多段中被手动改一段；触发信号 ≥2 次，评估时须与 S7 §4.4 D3 及 S4 schema 单值限制一并评估）；O7 `--force` 叠加防冻结 flag（触发信号：CI 冻结配置下重建失败真实发生）
- **S6 留观 N-5**（`listWorkspaceMembers` 形态 A 不含根成员）—— 来源：`.superpowers/sdd/2026-09-26-s6-link-direct.md/final-review.md §③`
- **S12 远期窗口（S9 不处理）**：atomic catch 内 `rmSync` 掩盖原错误、atomic 两函数核心重复、错误建议全局化、T3③ 依据前缀文案
- **PRD 附录 A 行 482 的 C2**（S11 依赖 S9 但 §14 执行顺序写「可并行」）—— S9 收口时留意是否需回写 §14

## 开工前先做

1. `git status --porcelain -uall` + `git log --oneline -10` 确认 HEAD = `0b78b49` 且工作树 clean（预期：零输出 + 上述提交链）；跑 `pnpm verify` 复核基线（预期 typecheck 0 + build + unit 324/324（20 文件）+ e2e 26/26，exit 0）
2. 读 `.superpowers/sdd/2026-09-28-s8-status-repair.md/progress.md` 尾部（S8 全部裁定 + 所有 `minor (deferred)` 行 + OCR 轮三态处置表 + 候选触发信号）
3. 读 PRD §8 行 272–293（六个关键界面）+ §7 行 260–261（link/unlink 的交互列）+ §15 行 426（CJK 冒烟前置）+ §16 行 428+（`--yes` 已关闭）
4. 读 S8 spec §8 衔接表 + S7 spec §8 行 295–301 + S6 spec §8 的 S9 行（三处衔接约定）
5. 读代码先例：`src/commands/link.ts` 的 A1 无参数分支与 `src/commands/unlink.ts` 的无参数分支 + `src/commands/status.ts` 的 `scanLinkState`/`EntryScan` 导出面 + `src/commands/repair.ts` 的 `printPlan` 与确认流程（执行计划预览形态先例）
6. 进入 brainstorming 一次一问澄清 S9 范围（**第一问 = PRD §15 行 426 的中文界面冒烟与交互库选型**；预期澄清点见「开放问题」1–5）

## 开场话术

读 docs/handoffs/2026-09-28-s9-interactive.md，按交接词继续：S9「交互层」spec 期开工。注意：S8 已由用户 commit（HEAD 0b78b49），工作树 clean，可直接开工。
