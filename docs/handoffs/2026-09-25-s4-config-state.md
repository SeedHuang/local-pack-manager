项目：d:\Seed\local-pack-manager —— lpm（Local Pack Manager）CLI：npm 本地 link 联调工具（本地 lib link/unlink 管理），TypeScript + commander，v1 PRD 驱动，按 S1–S13 spec 分期实施（docs/prds/2026-09-25-lpm-v1-prd.md §14）。

现状：
- 已完成并已提交（master，upstream gone）：S1 脚手架 + S2 workspace 解析 = commit 1b46580；S3 PM 检测与 use 全量（含 spec/plan/S1 spec 回写）= commit 3adad48（2026-09-25）。S3 最终全量评审 APPROVED；OCR 评审修复轮（M1/M2/L1/L2）已落地并入该提交。
- 绿色基线（S3 OCR 修复轮完成时复跑，S3 账本行 39）：typecheck 0 + build + unit 91/91 + e2e 11/11。
- ⚠️ 当前工作树有一处未提交意外改动：tests/fixtures/workspace/monorepo-bom/package.json 变成双 BOM
  （字节实测 EF BB BF EF BB BF；HEAD 版为单 BOM；git diff 仅此一处，其余工作树干净）。
  实测 load-workspace.test.ts 1 failed | 18 passed → 修复后应恢复 91/91。
  修复方式待用户授权：git restore 该文件（字节级最干净）；用户自行执行亦可。
  污染归因：2026-09-26 会话的 skill 测试子代理实测 BOM 行为时重写该 fixture 所致（Write 工具剥 BOM +
  PowerShell 补 BOM 对已有 BOM 文件再补一次 = 双 BOM；S2 账本行 26 有该先例）。
- .superpowers/ 已 gitignore；账本/报告不入库。

过程记录（先读进度尾部）：
- d:\Seed\local-pack-manager\.superpowers\sdd\2026-09-25-s3-pm-detection-use.md\progress.md（最新，行 22–39 = deferred minor 分诊 + OCR 修复轮裁决）
- .superpowers\sdd\2026-09-25-s2-workspace-discovery.md\progress.md（行 26 = BOM 写入方法 Ruling；行 38 = "S3 后可清理"预约）
- .superpowers\sdd\2026-09-25-s1-cli-scaffold.md\progress.md（行 3–7 = 全局裁决源头）
- spec/plan 均已随代码提交：docs\superpowers\specs\2026-09-25-s{1,2,3}-*-design.md、docs\superpowers\plans\2026-09-25-s{1,2,3}-*.md

本次任务：S4「配置与状态文件层」（PRD docs/prds/2026-09-25-lpm-v1-prd.md §14 行 403：四文件读写、gitignore 检查；依赖 S1；承接 review 修复 B6）。
严格沿用既定流程：① 先修 fixture 恢复绿色基线 → ② 确认 B6 原文 → ③ brainstorming 澄清（一次一问）→
④ spec 落盘 docs/superpowers/specs/2026-09-25-s4-<topic>-design.md → spec 自审 → 交用户评审（通过前不动代码）→
⑤ writing-plans 出 plan（docs/superpowers/plans/2026-09-25-s4-<topic>.md）→ ⑥ SDD 逐任务实施
（preflight 扫描任务对共享点 → 逐 task 派发子代理，brief = 定向读 plan 对应 Task 节，每任务 reviewer 直读产出文件评审）
→ 最终全量 review → pnpm verify 四段全量复跑。

范围依据：
- PRD docs/prds/2026-09-25-lpm-v1-prd.md §9「文件与数据」（行 295–313）：四文件 schema、原子写与崩溃安全写入顺序、
  重复 link 幂等规则、非 lpm 链接检测；§11 错误处理政策（每条错误含下一步动作）。
- S3 spec docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md：
  §4.6（行 203 起）config 读写契约；§4.7（行 229–234）S4 剩余范围 =
  readState/writeState/deleteState/readLast/writeLast/readUserConfig/writeUserConfig/ensureGitignoreEntry；
  config 深层 schema 校验归 S4；LpmConfigParseError 与 state/atomic.ts 按 S3 spec 引用、不重复定义。
- 勿重做（S3 已实现并提交）：src/state/index.ts 的 readProjectConfig/writeProjectConfig/LpmConfigParseError、
  src/state/atomic.ts（writeJsonFileAtomic 含失败语义）、src/core/pm.ts 全部导出、src/commands/use.ts 与 cli.ts use 接线。

开放问题：
1. B6 原文（开工第一问）：PRD §14 行 403 引用但磁盘无定义——考古证据：工作树 grep "B6" 仅 §14 一行；
   git log -S"B6" 证明自 f851d61 引入后未变化；git grep 于 6a511b5 版同样仅表格行——定义只存在于当时的
   PRD 评审对话。请用户给出 B6 原文，或确认"B6 已被 §9 现行定版内容覆盖，无需额外承接"。
   （agent 侧最佳推断：B6 = §9.5 gitignore 检查追加，依据 S4 交付物列明"gitignore 检查"与 §9.5 内容对应——待用户确认。）
2. 双 BOM 修复授权：git restore 属用户 Git 写禁令范围，需用户明确授权或用户自行执行。

既定约束（不要重新讨论、不要重新选型）：
- 禁止一切 Git 写操作（worktree/分支/commit/push/restore 等），改动由用户自行 commit —— 用户全局 Git 规则（S1 账本行 4 起承袭）
- 终端为 Windows PowerShell，skill 自带 bash 脚本不可用；review = reviewer 直读产出文件（S1 账本行 5）
- 相对导入一律带 .js；目录模块写 <dir>/index.js（S1 账本行 7，全局生效）
- 技术选型定版：TS ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest，
  运行时依赖零新增（PRD §14 行 391）；S2 依赖策略 A = 手写受限 glob + 极简 YAML
- spec/plan 落盘路径惯例 docs/superpowers/{specs,plans}/YYYY-MM-DD-s<N>-*.md（S1–S3 既成事实）
- 原子写 = 临时文件 + rename；writeProjectConfig 的 fs 失败保持 crash 语义、不入错误契约
  （S3 账本行 37 Ruling，S12 错误即建议全局化时统一收敛）
- Task 工具无 model 参数，统一默认模型（S1 账本行 6）
- 测试期子代理运行后必须核对 git status——本次双 BOM 污染即为测试子代理副作用所致（2026-09-26 教训）

遗留裁决与留观项（来源 S3 账本行 22–39 分诊，均与 S4 相关）：
- T1①：writeJsonFileAtomic tmp 名仅 pid 后缀，同进程并发写同目标理论互撞 → S4 复用 atomic 时决策（修或不修均留痕）
- T1②：readProjectConfig async 函数内同步 fs → 冻结签名所致，演进走 S1 spec §4.6
- T2①：pm 级间穿透组合用例（bun 字段 + pnpm-workspace.yaml → pnpm）→ S4 深化时补
- OCR L3（BOM 剥除三处重复）/ L4（PM token 三处声明）：留观（L3 动 S2 冻结文件；L4 v1 不加新 PM）
- 最终评审 M1/M2：pm.test 防御分支子态（读取失败/切分失败）留观
- 文案/断言增强类（T3③ 依据前缀 → S12；T4① e2e 22 stderr 增强 → S9+）：不在 S4 范围，勿顺手做

开工前先做：
1. git status 确认 HEAD = 3adad48、仅 fixture 一处 modified；经用户授权后 git restore
   tests/fixtures/workspace/monorepo-bom/package.json，重跑 pnpm vitest run tests/unit/load-workspace.test.ts
   确认 19/19，再跑 pnpm verify 确认 unit 91/91 + e2e 11/11
2. 读 .superpowers/sdd/2026-09-25-s3-pm-detection-use.md/progress.md 全文（重点行 22–39 分诊与裁决）
3. 读 PRD docs/prds/2026-09-25-lpm-v1-prd.md §9「文件与数据」+ §14 S4 行；读 S3 spec §4.6/§4.7
   （docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md）
4. 读 src/state/index.ts 与 src/state/atomic.ts 现行实现，盘点 S4 可直接复用的面
5. 向用户提出开工第一问（B6 原文，见开放问题 1）；随后进入 brainstorming 一次一问澄清 S4 范围
