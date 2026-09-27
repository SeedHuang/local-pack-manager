# S6 · link 直通版设计文档（spec）

- 日期：2026-09-26
- 状态：待评审
- 路径归类：superpowers architectural（lpm 子项目 spec，S3/S4/S5 的下游）
- 上游：PRD §6.1 行 74–110（link 直通时序与幂等分支）/ §6.3 行 148–183（link 交互——交互层归 S9，边界见 §2 裁决 1）/ §7 行 260（命令行：`lpm link <名字|路径>... [--watch] [--dry-run]`）/ §8 行 272–294（交互设计原则：错误即建议、禁止死屏；§8.6 B4 列成员让选）/ §9 行 295–313（崩溃安全写入顺序「先落 state → 再改 package.json → install」+ 重复 link 幂等规则 + 非 lpm 链接检测三选一）/ §10 行 337–344（last.json 更新规则）/ §11 行 346–365（错误表）/ §14 行 405（S6 行：前置检查、注册 upsert、批量改写、单次 install、--watch、完成提示；依赖 S3 S4 S5）/ 附录 A 行 471–480（B4 = lib 路径可能是 monorepo 根无 package.json；B5 = dist/ 存在性检查对无构建 lib 误报 → 按 exports/main 解析入口；B7 = lib 改包名后通讯录 key 失效 → name ≠ key 提示；O4 = link 成功后输出被修改文件清单；O5 = 目标不在任何成员依赖中 → 明确「先 pnpm add」出口）
- 依赖：S3（PM 检测：`resolvePackageManager` 唯一 PM 入口 → install 命令构造）、S4（`readState` 幂等判定 / `writeState` 内建 gitignore 防护 / `linkedAt` 由 S6 生成 ISO 8601 / `readProjectConfig`+`writeProjectConfig` upsert）、S5（`mapProtocol` + `rewriteDepValue` + `findDepEntries`——peer 警告数据源 + O4 段清单）；实现基线 2e46fa0（S1–S5 已 commit，`pnpm verify` 全绿：typecheck 0 + build + unit 158/158 + e2e 11/11，2026-09-26 17:53 复跑）
- 评审提示：六个关键裁决已在 brainstorming 拍板（§2，2026-09-26），无遗留开放决策点；§9 列实现期自决细节（非决策，评审可否决）

## 0. 流程注记与要素映射

- 位置与结构：沿用 S1–S5 确立的 superpowers 默认（问题 → 方案权衡 → 架构 → 组件 → 数据流 → 错误处理 → 测试）
- **B4/B5/B7/O4/O5 修复落点声明**：本 spec 是 PRD 附录 A 五项的修复实现处——B4 → §4.4 B（monorepo 根两形态让选）；B5 → §4.4 C 入口解析（exports/main，不查 dist 存在性）；B7 → §4.4 C name-mismatch + §6 错误表；O4 → §4.4 J 完成提示；O5 → §4.4 E3 零命中报错
- **与 S3 的衔接**（S3 spec §8 行 324）：`resolvePackageManager`（唯一 PM 入口）→ install 命令构造（§4.3 buildInstallCommand）；detected 结果向用户提示一行（§4.4 A7）
- **与 S4 的衔接**（S4 spec §8 行 269）：`readState` 幂等判定（§4.4 E1）/ `writeState` 内建 gitignore 防护（S6 不重复做）/ `linkedAt` 由 S6 生成 `new Date().toISOString()`（§4.4 G2）；state 层嵌套不校验（S4 §2 决策 3）——S6 不读 `entry.original`（幂等跳过不触碰条目内容），嵌套防御归 S7（S4 spec §8 行 270）
- **与 S5 的衔接**（S5 spec §8 行 273）：`mapProtocol`（协议值）/ `rewriteDepValue`（改写）/ `findDepEntries`（peer 警告数据源 + O4 段清单）；**manifest 文本读写 IO 与 install 编排归 S6**（本 spec）；消费提示（F5）：changedKeys/unchangedKeys 形如 "段名.包名" 而包名可含点——整体展示，禁止按 '.' 切分（§4.4 J1）
- **PRD §6.1 时序对齐**：幂等分支 → upsert → 前置检查 → workspace 命中 → 落 state → 改写 → install → --watch → 完成提示（§4.4 E 流程步骤与行 89–108 一一对应）
- PRD §14 五要素映射：目标→§1；交付物→§4.1；接口定义→§4.3–4.4；测试清单→§7.1–7.3；验收标准→§7.4
- 计划期修订位：留给 writing-plans 自审（S3/S4/S5 先例：修订随 plan 评审一并确认）

## 1. 问题与目标

**问题**：S2 提供命中扫描、S5 提供文本改写、S4 提供状态文件层、S3 提供 PM 检测——但没有任何东西把它们串成「`lpm link <名字|路径>...`」这条端到端链路。S6 交付 link 直通版：前置检查、注册 upsert、批量改写、单次 install、--watch、完成提示（PRD §14 行 405），并承接 B4/B5/B7/O4/O5 五项评审修复。

**目标**：

1. 命令契约：`lpm link [targets...] [--watch] [--dry-run]`；targets 混合接受注册名与路径（§4.4 A）
2. 前置检查（§4.4 C）：存在性 → package.json → 入口产物（**按 exports/main 解析——B5 修复**，不查 dist 存在性）→ name 一致性（B7）→ lib node_modules 空检查 → `build:watch` script 存在性（仅 --watch 时）
3. B4 修复（§4.4 B）：lib 路径是 monorepo 根（两形态）→ @clack 列成员包让选（S6 承接的最小交互之一，非 TTY 报错）
4. 非 lpm 链接检测三选一（§4.4 F，PRD §9 行 310）：当前值已是本地协议且 state 无条目 → git HEAD 读原值 / 手动输入 / 放弃（S6 承接的最小交互之二；dry-run 降级纯警告）
5. 注册 upsert 静默（§4.4 D）；重复 link 幂等跳过（§4.4 E1，C1 防 original 永久丢失）
6. 批量改写（§4.4 E）：零命中报 O5「先 pnpm add」；全部改写在内存聚合后按 PRD §9 定版顺序落盘——**先 state → 再 package.json（文本级原子写）→ 单次 install**（per-PM flags，§2 裁决 3）；install 失败 → state 保留可重跑（§11）
7. --watch（§4.4 H）：install 成功后用 lib 自身 PM 拉起 `build:watch` 子进程（前台 stdio 继承，Ctrl+C 同时终止）；lib 缺 script → 前置检查报错拦截
8. O4 完成提示（§4.4 J）+ last.json 写入（§4.4 I，PRD §10 行 341 link 多个规则）
9. --dry-run 执行计划（§4.4 K）：兑现 S1 spec §1 行 31 预裁决（--dry-run 随首个带执行计划的命令引入）；PRD §13.9 一致性校验入验收（§7.4 #7）

**非目标**（S6 不做）：

- 交互模式（无参数的主列表 / 空态向导 / 路径格式引导 / 管理注册——S9；S6 无参数仅提示用法）；执行计划预览确认界面（S9）
- unlink / 三态恢复 / 崩溃安全恢复顺序（S7）；lstat 复验与 `--force` 重建（PRD §11 行 361——S7/S8 落地）；status 三方核对（S8）
- `--last` / `--all` / `--preset` / `save` / `preset`（S10——本 spec 仅按 §10 规则**写** last.json）
- 真实 install 全链自动化测试（PRD §12：pnpm 全链为 BFM 人工验收，实验性 PM smoke 手测清单）
- peer 警告的交互化呈现（S6 输出警告行，S9 升级）；resolutions / overrides 等段（S5 非目标延续，不扫描不改写）
- 传递依赖（只处理直接声明，S2 非目标延续）

## 2. 方案权衡（brainstorming 六问定版，2026-09-26）

| # | 决策点 | 定版 | 被否选项与理由 |
|---|---|---|---|
| 1 | S6/S9 交互边界 | **流程必需决策点入 S6**：B4 成员让选 + 非 lpm 链接三选一（@clack 最小交互，非 TTY 报错退出）；upsert 静默登记（对齐 PRD §6.3「注册动作对用户隐形」）；install 输出透传（不包 spinner）。执行计划预览 / 主列表 / 空态向导归 S9 | S6 纯零交互：monorepo 根 lib 与手动 link 过的项目都无法用直通版，B4/O5 承接项落空；执行计划预览也入 S6：与 PRD「细节在 S9 spec」（§8 行 276）拆分意图冲突，S6 体量失控 |
| 2 | --watch 机制 | **PRD §5 行 66 已定版**（lpm 无监听，仅拉起 lib 的 `build:watch` 子进程，前台运行 Ctrl+C 同终止——不存在 fs.watch vs 轮询选型；交接词中该推断系误读）。S6 补定：用 **lib 自身 PM** 跑（lib 目录 lockfile 探测：pnpm-lock→pnpm，yarn.lock→subdivideYarn，package-lock→npm；无证据回退 npm run），execa 前台 stdio 继承；lib 缺 `build:watch` script → 前置检查报错拦截 | 永远 `npm run`：零检测逻辑但 lib 脚本内 pnpm 特性（pnpm exec 等）会失效，错误面隐蔽；不拉子进程仅提示：与 PRD §5 交付语义不符（功能形同虚设） |
| 3 | install 命令构造 | **全部显式关闭冻结**（per-PM flags 表单源，§4.3 buildInstallCommand）：pnpm→`install --no-frozen-lockfile`（PRD §6.1 行 103 字面）；npm→`install`；yarn-classic→`install --no-frozen-lockfile`；yarn-berry→`install --no-immutable`。本地/CI 行为一致，不依赖环境探测 | 仅 pnpm 加 flag（PRD 字面）：yarn 在 CI 环境（CI 变量存在）默认 frozen/immutable，manifest 刚被 lpm 改过会直接失败 |
| 4 | --dry-run 是否入 S6 | **入 S6**（S1 spec §1 行 31 预裁决「随首个带执行计划的命令（S6 link）引入」）：跑完全部只读段后打印执行计划，零写盘零子进程；非 lpm 三选一降级纯警告（不落 state 无污染风险）；PRD §13.9 一致性校验随验收覆盖 | 推后 S9/S12：需回写勘误 S1 spec 预裁决，PRD §13.9 验收挂起 |
| 5 | last.json 写入 | **入 S6**（PRD §10 行 341）：单条命令 targets ≥ 2 且至少成功 1 个 → install 成功后 `writeLast(操作后 state.links 全部 keys)`；单参数 link 不动 last；写失败仅警告不致命。S10 交付时无行为断层 | 推 S10：S6–S9 期间 last.json 永远为空，S10 上线时 --last 无存量记录 |
| 6 | O4 完成提示格式 | **按文件分组明细**（§4.4 J1）：每个 manifest 一段列 changedKeys 逐条「段名.包名：原值 → 新协议值」（F5：整体展示禁切分）；幂等命中汇总；peer 命中警告段；末尾固定防误 commit 提示。纯文本中文与既有输出风格一致 | 仅文件清单：信息过少，用户需自行 git diff；默认简 + --verbose：多一个 flag 面，v1 YAGNI |

## 3. 架构

```
src/commands/link.ts     # 编排主流程 + 交互点（B4 让选 / 非 lpm 三选一）+ upsert + state 编排 + O4/last 提示
src/core/linkcheck.ts    # 前置检查纯函数 + LibCheckError（B4 之外的 lib 校验）
src/core/install.ts      # install/watch 子进程构造（execa）+ buildInstallCommand 单源表 + lib PM 探测
src/state/atomic.ts      # 追加 writeTextFileAtomic（文本级原子写，package.json 写回用）
src/core/workspace.ts    # 追加 listWorkspaceMembers（B4 形态 A：无 package.json 的 pnpm monorepo 根列成员）
src/cli.ts               # link 接线（S3 use 特判先例）
```

- 分层规则不变（S1 §3）：`commands/*` → `core/*` + `state/*` 单向；`core/linkcheck.ts`、`core/install.ts` 不依赖 `state/*`；`core/install.ts` 依赖 `core/pm.js`（复用 `subdivideYarn`）与 execa（既有运行时依赖，零新增）
- 命令层先例 S3 `use.ts`：`runLink()` 返回退出码（0/1），cwd 参数化保可测；core 错误类 message 首行即文案，命令层 stderr 透传（S2 spec §6 先例）
- 交互函数内聚于 commands/link.ts（S3 confirmOverride 先例：非 TTY 走显式分支，clack 可 mock）
- S5 引擎 7 导出冻结面零改动；`listWorkspaceMembers` / `writeTextFileAtomic` 为既有文件**新增导出**（沿 S3 spec §4.3 公共 API 新增约定：冻结面零改动，允许新增）

## 4. 组件与接口

### 4.1 文件清单（交付物）

```
src/commands/link.ts            # 新增：runLink 编排 + 交互 + 提示
src/core/linkcheck.ts           # 新增：checkLib + LibCheckError
src/core/install.ts             # 新增：buildInstallCommand / runInstall / InstallError / detectLibPM / spawnBuildWatch
src/state/atomic.ts             # 追加导出：writeTextFileAtomic
src/core/workspace.ts           # 追加导出：listWorkspaceMembers
src/cli.ts                      # 修改：link 接线（特判分支，S3 use 先例）
tests/unit/linkcheck.test.ts    # 新增
tests/unit/install.test.ts      # 新增
tests/unit/link-command.test.ts # 新增
tests/unit/state-files.test.ts  # 追加 writeTextFileAtomic 用例
tests/unit/load-workspace.test.ts # 追加 listWorkspaceMembers 用例
tests/e2e/cli.e2e.test.ts       # 追加 link 用例
docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md # 回写（§4.5 义务）
```

### 4.2 消费面（既有导出，零改动）

- S5 `core/rewriter.ts`（恰 7 导出封闭面）：`mapProtocol(pm, libDirAbs, manifestDirAbs)` → 协议值；`rewriteDepValue(source, pkgName, targetValue)` → RewriteResult；`findDepEntries(source, pkgName)` → 段名数组（peer 警告 + O4 数据源）；`ProtocolPathError`（跨盘符透传）
- S2 `core/workspace.ts`：`findWorkspaceRoot` / `loadWorkspace`（manifestFormat 判 monorepo 形态 B）/ `findDependents(ws, pkgName)` → DepHit[]（命中与 currentValue 来源）
- S3 `core/pm.ts`：`resolvePackageManager(rootDir, configPM)` → PMResolution（唯一 PM 入口）；`subdivideYarn(rootDir)`（lib PM 探测复用）；`PackageManagerId`
- S4 `state/index.ts`：`readProjectConfig` / `writeProjectConfig`（upsert）；`readState` / `writeState`（幂等判定与落盘，writeState 内建 gitignore 防护）；`readLast` / `writeLast`；`ensureGitignoreEntry`（经 writeState 内建，S6 不直调）
- S4 `state/types.ts`：`ProjectLpmConfig` / `LinkState` / `LastSet`（冻结 schema）
- `state/atomic.ts`：`writeJsonFileAtomic`（config/state 写入既用）

### 4.3 新增导出（公共 API 新增约定：冻结面零改动，允许新增）

```ts
// src/core/linkcheck.ts
export type LibCheckKind =
  | 'dir-missing' | 'manifest-missing' | 'manifest-invalid'
  | 'entry-missing' | 'name-mismatch' | 'node-modules-empty' | 'watch-script-missing'

export class LibCheckError extends Error {
  constructor(
    public kind: LibCheckKind,
    public libDirAbs: string,
    message: string,
  ) // name = 'LibCheckError'，message 首行即用户文案（S2 错误类惯例）
}

export interface LibCheckOk {
  name: string          // lib package.json name（缺失为空串）
  manifestPath: string  // lib package.json 绝对路径
}
export interface LibCheckOptions {
  expectedName?: string | null        // 通讯录 key（B7 判定）；null/缺省跳过 name 一致性检查
  expectWatchScript?: boolean         // --watch 时为 true（Ruling ②）
}
/** 前置检查纯函数（B5 修复落点）。步骤序与错误 kind 见 §4.4 C。 */
export function checkLib(libDirAbs: string, opts: LibCheckOptions = {}): LibCheckOk

// src/core/install.ts
/** per-PM install 参数单源表（§2 裁决 3）。pnpm→['install','--no-frozen-lockfile']；
 *  npm→['install']；yarn-classic→['install','--no-frozen-lockfile']；yarn-berry→['install','--no-immutable'] */
export function buildInstallCommand(pm: PackageManagerId): readonly string[]

/** PM 逻辑 id → 可执行文件名（展示与子进程构造共用单源） */
export function pmExecutable(pm: PackageManagerId): string
/** 可直接重跑的完整 install 命令行（`<可执行名> install <flags>`）——runInstall 诊断串与 dry-run 计划共用 */
export function buildInstallCommandLine(pm: PackageManagerId): string

/** PM 逻辑 id → 可执行文件名单源映射（OCR O1）：pnpm→'pnpm'、npm→'npm'、
 *  yarn-classic/yarn-berry→'yarn'——逻辑 id 非可执行文件名，install/watch 的 execa 调用
 *  与 InstallError.command 展示统一经此映射（否则 yarn 项目 ENOENT 恒定失败）
 *  const PM_BINARY: Record<PackageManagerId, string> */

export class InstallError extends Error {
  constructor(
    public command: string,       // 展示用完整命令行
    public exitCode: number | null,
    public stderrTail: string,    // 子进程 stderr 末尾（≤2000 字符）
    message: string,
  ) // message 首行含「state 已保留」+ 重跑/逃生门建议（§6）
}
/** 单次 install（workspace 根执行，stdio 继承透传输出——禁止死屏）；失败抛 InstallError */
export async function runInstall(rootDir: string, pm: PackageManagerId): Promise<void>
// 注记（S7 回写，S7 spec §4.3）：S7 起增加可选第三参 retryAdvice（缺省 = link 向文案，既有调用零改动）

/** lib 自身 PM 探测（§2 裁决 2）：lib 目录 lockfile——pnpm-lock→pnpm；yarn.lock→subdivideYarn；
 *  package-lock→npm；无证据 → 'npm'（回退）；多 lockfile 共存按 pnpm-lock > yarn.lock > package-lock
 *  首个命中（对齐 S3 LOCKFILE_ORDER 探测精神） */
export function detectLibPM(libDirAbs: string): PackageManagerId

/** 拉起 lib 的 build:watch 子进程：<pm> run build:watch，cwd=libDir，stdio 继承，前台。
 *  前置检查已保证 script 存在；调用方经 exited 驻留、kill 终止、failure 出警告（§4.4 H）。
 *  failure：resolve 为子进程失败原因（spawn 失败/非零退出），正常退出 → null——H7 警告数据源（计划期修订 3） */
export interface WatchProcess {
  pid: number
  exited: Promise<void>
  kill: () => void
  failure: Promise<unknown | null>
}
export function spawnBuildWatch(libDirAbs: string, pm: PackageManagerId): WatchProcess

// src/state/atomic.ts（追加）
/** 文本级原子写（writeJsonFileAtomic 同款 tmp 命名 pid+uuid + rename；content 逐字节 utf8 落盘，
 *  无 BOM/换行/转义转换——package.json 格式保真由 S5 引擎产出保证）；失败清理孤儿 tmp 后原错误重抛 */
export function writeTextFileAtomic(filePath: string, content: string): void

// src/core/workspace.ts（追加）
/** B4 形态 A：lib 路径是无 package.json 的 pnpm monorepo 根（本地有 pnpm-workspace.yaml）→
 *  解析 packages patterns 展开成员（复用 parsePackagesYaml 与 walk 逻辑，行为同 loadWorkspace）。
 *  无 pnpm-workspace.yaml → 抛 WorkspaceNotFoundError('invalid-root')；成员展开复用 loadWorkspace 的
 *  命中并集 + 负模式剔除 + manifest 严格读取语义。npm/yarn workspaces 根必有 package.json，不适用本形态 */
export async function listWorkspaceMembers(rootDir: string): Promise<PackageJsonInfo[]>

// src/commands/link.ts
export interface LinkOptions { watch?: boolean; dryRun?: boolean }

/** targets 解析失败（未注册名 / 非路径形态 / libs 值非串），message 首行即用户文案（§6 #12） */
export class LinkArgumentError extends Error {
  constructor(public target: string, message: string) // name = 'LinkArgumentError'
}

/** 流程必需决策点在非 TTY 环境无法进行（§6 #13/#14） */
export class LinkInteractionError extends Error {
  constructor(public kind: 'member-select' | 'non-lpm-ternary', message: string) // name = 'LinkInteractionError'
}

/** O5 零命中（<name> 不在任何成员依赖中），message 首行即用户文案（§6 #17）——计划期修订 4 */
export class LinkTargetError extends Error {
  constructor(public pkgName: string, message: string) // name = 'LinkTargetError'（OCR O3：字段 pkgName，避 Error.name 占用）
}

/** link 命令行为（§4.4 流程）。cwd 参数化仅为可测性；cli.ts 以默认值调用。返回退出码 0/1 */
export async function runLink(targets: readonly string[], opts: LinkOptions, cwd?: string): Promise<number>
```

### 4.4 行为契约（逐条）

#### A. 参数与入口

1. **无参数**：stdout 提示「交互模式随 S9 上线；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]」，exit 1
2. **target 判定**（逐个）：`config.libs[target]` 存在且为 string → 名字分支（libDir = 根 + 该相对路径）；存在但**非 string**（手改 config）→ LinkArgumentError（文案：注册值损坏，请修正 lpm.config.json 中 <target> 的值）；否则 target 含 `/` 或 `\` 或以 `.` 开头或 `isAbsolute` → 路径分支；否则 → LinkArgumentError（文案：未知注册名 + 「若为路径请使用路径写法（绝对/相对/含空格加引号）」）
3. **路径分支归一化**：相对 cwd → `path.resolve` → `isDirectory` 校验；**校验失败 → LinkArgumentError（双提示文案：路径不存在 + 「若为注册名请检查拼写或先注册（libs 键）；已注册：<清单>」）**——未注册 scoped 包名（如 `@scope/pkg` 含 `/`）会进入路径分支，此文案兜底防误导；校验通过后相对化一律相对 workspace 根、正斜杠
4. **PM 解析**：`resolvePackageManager(rootDir, config.packageManager)`；`source === 'detected'` → stdout 一行「检测到包管理器：<pm>（未 lpm use 固化）」（不阻断）
5. **workspace**：`findWorkspaceRoot(cwd)` → `loadWorkspace(rootDir)`（错误透传）
6. **互斥与组合**：`--dry-run` 与 `--watch` 可同给——dry-run 优先（仅打印 watch 计划，不拉子进程）
7. **退出码**：成功 0；任一错误 1（错误信息 stderr，正文 stdout——S3 use 先例）

#### B. B4 monorepo 根分支（修复落点，先于 checkLib）

1. **形态 A**（PRD 附录 A 行 471 字面）：libDir 无 package.json 且本地有 `pnpm-workspace.yaml` → `listWorkspaceMembers(libDir)` 展开成员
2. **形态 B**：libDir 有 package.json 且 `loadWorkspace(libDir).manifestFormat !== 'single'` → `loadWorkspace(libDir).members`
3. **让选**：TTY → `@clack/prompts` select 列全部成员（含根自身，根标记「（根）」），选定成员的 dir 作为 libDirAbs 继续（其 name/manifestPath 随之切换）；用户取消（clack isCancel）→ stderr「已取消」exit 1；非 TTY → 报错：列出成员名清单 + 建议「直接使用成员路径注册，如 lpm link <成员路径>」，exit 1
4. 形态 A 中 libDir 无 pnpm-workspace.yaml → 不入 B4 分支，交 checkLib 报 `manifest-missing`（「不是 npm 包」）
5. dry-run 下 B4 让选照常发生（只读操作）

#### C. 前置检查（checkLib，B5/B7 修复落点）

按序执行，任一失败即抛 LibCheckError（停止该 target；批量中其余 target 不再继续——**遇错即停**，见 §4.4 E8）：

1. `isDirectory(libDirAbs)` 否 → `dir-missing`（文案含路径写法提示——PRD §11 行 352）
2. package.json 不存在 → `manifest-missing`（「不是 npm 包——请确认路径指向包目录」）
3. JSON.parse（剥 BOM）失败 → `manifest-invalid`（文案含解析错误位置）
4. **name 一致性（B7）**：`expectedName` 非空且 lib name ≠ expectedName → `name-mismatch`（文案：「lib 实际 name（<name>）≠ 通讯录 key（<key>）。请更新 lpm.config.json 中 libs 键为 <name> 后重试」——PRD §11 行 357 字面：报错 + 下一步建议，不自动改注册）
   - 空名豁免（N-4）：lib name 为空串时跳过 name-mismatch 检查（空名 lib 无法被依赖引用，D1/D7 自洽豁免）
5. **入口产物（B5）**：按 `exports` → `main` 顺序解析入口——exports 存在：收集 '.' 主入口的全部字符串路径候选（直接字符串，或 import / require / node / default 子键中的字符串值）；无 exports → 取 `main`；候选含目录结尾（无扩展名）时试 `index.js`。**全部候选文件均不存在** → `entry-missing`（文案「先 build 或起 build:watch」）；**无法取得任何候选**（无 exports 无 main，或仅 types）→ 跳过检查（CSS/类型包等无入口约定合法——B5「无构建 lib 误报」的豁免面）
6. **node_modules 空检查**：`libDir/node_modules` 不存在或存在但 readdir 为空 → `node-modules-empty`（文案「先在 <lib路径> 执行包管理器 install」——PRD §11 行 355）
7. `expectWatchScript` 且 `scripts['build:watch']` 缺失或非 string → `watch-script-missing`（文案「<lib> 缺 build:watch script；请在 lib package.json 补充后重试，或去掉 --watch」）

#### D. 注册 upsert（静默，Ruling 1）

1. **key 确定**：名字分支 key = target 本身；路径分支 key = lib 实际 name（幂等判定前预读，checkLib 复核；name 为空串 → 用相对根路径作 key，plan 期细化文案）
2. upsert：`readProjectConfig` → `cfg.libs[key] = 相对根路径（正斜杠）` → `writeProjectConfig`；已存在同值 → 不写（幂等）
3. 路径分支若 libs 中存在**不同 key 同路径**的旧条目 → 不清理、不提示（forget/管理注册归 S11；§9 自决细节 2）
4. B4 让选后 upsert key = 成员 name（同路径分支规则）
5. upsert 发生在改写之前（PRD §6.1 行 93 时序）；dry-run 只打印 upsert 计划不落盘

#### E. 主流程与幂等（PRD §6.1 时序对齐）

1. **幂等判定（C1，尽早）**：key 可确定即判定——名字分支在 target 判定后立即（先于 B4/checkLib）；路径分支在 B4 与 **name 预读**后（读 lib package.json 提取 name；读取/解析失败 → 跳过幂等判定，由 manifest 读取报错（ManifestParseError，§6 #2））。`readState(rootDir)?.links[key]` 存在 → stdout「已链接：<key>，跳过（保留原 original 条目）」→ 该 target 结束（**绝不从 package.json 现读 original 覆盖**——PRD §9 行 308）；批量中混入已链接项 → 跳过继续其余；全部 target 均已链接 → 无改写、**不执行 install**，exit 0
2. **workspace 命中**：`findDependents(ws, name)` → DepHit[]（name = lib 实际 name——命中按包名而非注册 key）
3. **O5 零命中**：命中为空 → 报错（文案：「<name> 不在任何成员依赖中。先在引用方执行 pnpm add <name> 再 link」——PRD §11 行 358 / O5），exit 1
4. **非 lpm 链接检测**（PRD §9 行 310，在命中后改写前）：任一命中文件 currentValue 匹配 `/^(link|file|portal):/` 且 state 无该 key 条目 →
   - TTY：`@clack/prompts` select 三选一——① 从 git HEAD 读原值（逐命中文件 `git show HEAD:<相对仓库根路径>`；**全部文件均能取得非本地协议原值**才可用，任一失败该选项禁用并列出原因）② 手动输入原 range（clack text；单值应用该 target 全部命中文件）③ 放弃（跳过该 target，提示后继续批量其余）；select 用户取消（clack isCancel）→ 视同③放弃
   - 非 TTY：报错 exit 1（文案：检测到非 lpm 管理的本地链接，需交互确认；请手动恢复该文件原值后重试，或用 --dry-run 查看）
   - dry-run：降级纯警告「检测到非 lpm 管理的本地链接（dry-run 不记录 original）」继续只读流程
5. **改写聚合（内存，全 target 全文件）**：逐 DepHit → `mapProtocol(pm, libDirAbs, dirname(manifestPath))`（ProtocolPathError 透传）→ 按 **manifestPath 分组链式应用** `rewriteDepValue`——同一 manifest 被多个 target 命中时（如 web 同时依赖 libA 与 libB），后改者基于前改者的 content 继续改写，最终每 manifest 恰一个 content（防后写覆盖先写）；**每 manifest 每 target 恰一次 `rewriteDepValue`**（同 manifest 多段命中——同包同时出现在 dependencies 与 devDependencies 等——按 manifestPath 分组聚合，展示明细仍逐段列出，防重复改写与 J2 计数虚增；OCR O7）；peer 命中数据 = 逐 target 在其应用时点的 source 上 `findDepEntries(source, name)` 含 'peerDependencies' 者；**同 key 重复 target 去重**（如 `lpm link A A`）→ 仅处理一次，第二处静默跳过
6. **崩溃安全落盘顺序**（PRD §9 行 306 定版）：
   a. `writeState(rootDir, ...)`——links[key] = { original: { '<相对根>/package.json': 原值 }, linkedAt: `new Date().toISOString()` }；同文件同 lib 多段命中原值异 → original 记**首个命中值**（S4 schema 单值限制；§9 自决细节 3，S7 收敛）
   b. 逐文件 `writeTextFileAtomic(manifestPath, result.content)`
   c. **单次 install**：`runInstall(rootDir, pm)`（全部 target 共用一次；Ruling 3 flags 表）；失败 → InstallError（state 保留，§6）exit 1
7. **install 成功后**：last 写入（§4.4 I）→ --watch 拉起（§4.4 H）→ O4 完成提示（§4.4 J）
8. **遇错即停语义**：逐 target 顺序处理，任一 target 在「改写聚合完成前」出错 → 立即报错 exit 1，**无 state / package.json 写盘**（聚合在内存；config upsert 已发生的条目保留——注册无害且幂等，重跑免重复注册）；聚合完成后写盘段失败 → 按 §6 对应条目处置，中间态语义见下注

   > **崩溃中间态语义（PRD §13.9「重跑收敛」的本 spec 口径）**：写入序列中断（「state 已写/pkg 未改」「pkg 已改/install 未跑」等）后重跑 lpm link → 按 E1 幂等跳过，结果**稳定无腐化**（state 条目原样、original 零损失、无半途追加写入）；此时系统处于 PRD §10 的 drifted 形态（行 322「linked + registry range」/ 行 324「install 未生效」），由 S8 status/repair 收敛。link 重跑不做强收敛——C1 防 original 永久丢失（PRD §9 行 308）优先于重跑便利，跳过改写为 PRD 字面；S8 未交付前的手工恢复走 §6 #16 逃生门。

#### F. 非 lpm 三选一补充

1. git HEAD 读取：`git show HEAD:<relPath>`（relPath 相对 git 仓库根，`git rev-parse --show-toplevel` 定位；git 不存在/无仓库 → 不可用时该选项不出现（原因经 stderr 列出））
2. 选项①取得的原值若仍是本地协议 → 该文件视为不可用（禁用①并列原因）
3. 手动输入值 trim 后空串 → 重新提示；**输入值匹配 `/^(link|file|portal):/`（本地协议）→ 拒绝并重新提示**（文案：原 range 不应为本地协议值——否则 unlink 会「恢复」成 link 路径；计入 3 次上限）；3 次耗尽或 clack text 取消（isCancel）→ 视同放弃
4. 放弃的 target：不落 state、不改 package.json（original 零记录）；config 注册已发生（D5 时序在前）→ 保留并提示「已放弃：<key>（注册已保留，本次未链接）」——对齐 E8 config 例外语义（注册无害幂等，重跑免重复注册）；若全部 target 均放弃 → exit 0（state/pkg 无改动，无 install）

#### G. state 写入契约

1. `original` 键格式：`<相对 workspace 根>/package.json`（正斜杠；S4 types 注释「<相对路径>/package.json」）；命中文件为 workspace 根自身（relDir 空串）→ 键为 `package.json`（无前导斜杠）
2. `linkedAt`：S6 生成 ISO 8601（`new Date().toISOString()`——S4 spec §8 行 269 定版落点）
3. `writeState` 内建 gitignore 防护（S4 实现，S6 不重复）；首次创建 .lpm/ 的提示行为随 writeState 内建语义（S4 spec §4.4）
4. 同一命令多 target → state 一次性合并写入（单次 writeState 含全部新增条目，减少中间态窗口）

#### H. --watch 契约（Ruling 2）

1. 触发条件：`--watch` 且非 dry-run 且 install 成功
2. 逐本次**成功链接**的 lib 拉起：`spawnBuildWatch(libDirAbs, detectLibPM(libDirAbs))`（多 lib 多子进程，顺序拉起）
3. 拉起前 stdout 逐行「watch：<相对 lib 路径>（<可执行名> run build:watch，pid）」
4. 全部拉起后 lpm 前台驻留至全部子进程退出（`Promise.all(exited)`）；子进程自然退出 → lpm 随之退出
5. Ctrl+C：stdio 继承共享控制台，信号原生传播至子进程；lpm 侧兜底——SIGINT handler 对未退出子进程逐一 `kill()` 后退出，**退出码 0**（PRD §5「link 状态不受影响」——非错误终止）
6. dry-run + --watch：仅打印「将拉起 build:watch：<lib 清单>」，不拉起
7. 单个子进程 spawn 失败（PM 可执行文件缺失等）→ stderr 警告「build:watch 拉起失败：<原因>（链接本身不受影响）」→ 继续拉起其余并驻留存活子进程；退出码不变（链接已成功，watch 为辅助能力）

#### I. last.json 契约（Ruling 5，PRD §10 行 341）

1. 条件：`targets.length >= 2` 且本命令至少成功链接 1 个 → install 成功后 `writeLast(rootDir, { version: 1, names: Object.keys((await readState(rootDir)).links) })`
2. 单参数 link → 不动 last；写失败 → stderr 警告「last.json 写入失败（不影响链接）」不改变退出码
3. 全部已链接跳过（无 install）→ 不写 last（无集合变化）

#### J. O4 完成提示（Ruling 6，PRD 附录 A 行 479）

1. 形态（纯文本中文，stdout）：

```
链接完成：N 个 lib，M 处声明改写：
  <相对根>/package.json:
    dependencies.<pkg>：<原值> → <协议值>        ← changedKeys 逐条（"段名.包名" 整体展示，禁按 '.' 切分——F5）
  已链接跳过：K 处                               ← 幂等/unchanged 汇总
  警告：peerDependencies 命中不改写：<相对根>/package.json（<pkg>）   ← findDepEntries 含 peer 者逐文件
以上 package.json 已修改，请勿提交；lpm unlink 可恢复原状。
```

2. N/M/K 计数口径：N = 去重后 key 数；M = changedKeys 全 target 求和；K = 跳过 target 数（含去重跳过）+ unchangedKeys 求和
3. dry-run 不输出本提示（输出执行计划，§4.4 K）

#### K. --dry-run 契约（Ruling 4）

1. 跑完全部只读段（target 解析 / B4 让选 / checkLib / upsert 计算 / findDependents / 幂等判定 / 非 lpm 检测降级警告 / 改写模拟）后输出执行计划（stdout）：

```
dry-run 执行计划（不落任何盘、不执行任何子进程）：
  注册 upsert：<key> → <相对路径>（新增/更新）          ← 逐 target
  改写 <相对根>/package.json:
    dependencies.<pkg>：<原值> → <协议值>
  已链接跳过：<key>                                    ← 混入已链接 target 时逐行列出
  peer 警告：<相对根>/package.json（<pkg>）
  install：<可执行名> install <flags>（workspace 根）
  watch：拉起 <lib 相对路径> 的 build:watch（<可执行名> run build:watch）   ← 仅 --watch
```

2. 零副作用硬约束：不写 config / state / package.json / last / .gitignore，不执行任何子进程（install/git 均不跑）；B4 让选照常（只读决策）；非 lpm 三选一降级纯警告（E4 dry-run 分支，不交互）
3. 全部已链接 → 计划体为空 + 「无待执行变更」；O5/前置检查错误照常报错（dry-run 也要求参数有效）

#### L. cli.ts 接线

1. `buildProgram()` 内 link 特判分支（S3 use 先例）：`program.command('link').description('把依赖切到本地目录联调').argument('[targets...]', '注册名或路径').option('--watch', ...).option('--dry-run', ...)` → `process.exitCode = await runLink(targets, opts)`
2. description 不带「（计划 S6）」后缀（同 use 处置）；其余命令 stub 循环不动

### 4.5 回写义务（S1 §4.6 演进约定）

1. S1 spec 分层表（行 406）`commands/*` 行注记：S6 起 link 已实现（use/link 真实命令 + 其余 stub）
2. S1 spec 中 link 相关 stub/计划注记（§4.5 COMMANDS 注册示例、§5 命令调用流的「S1 全为 stub」表述）——同步为 use/link 已接线的现状；具体 hunk 清单 plan 期盘点定版（S5 先例 4 hunk）
3. 回写为纯文档操作，随 Task 实施逐字落位，评审核验

## 5. 数据流

```
argv → cli.ts（link 特判）→ runLink(targets, opts, cwd)
  ├─ targets.length === 0 → 提示用法 exit 1                      （§4.4 A1）
  ├─ findWorkspaceRoot(cwd) → loadWorkspace → rootDir/ws
  ├─ readProjectConfig → resolvePackageManager                    （A4）
  ├─ 逐 target（顺序，遇错即停——E8）:
  │   ├─ target 判定（名字/路径/错误）                              （A2）
  │   ├─ 名字分支：key = target → 幂等判定 → 已链接则跳过            （E1）
  │   ├─ B4 分支（两形态让选 → libDirAbs + name）                    （B）
  │   ├─ 路径分支：key = name → 幂等判定 → 已链接则跳过              （E1）
  │   ├─ checkLib（entry/name-mismatch/node_modules/watch-script）  （C）
  │   ├─ upsert（静默写 config）                                    （D）
  │   ├─ findDependents(ws, name) → 零命中 O5 报错                  （E2/E3）
  │   ├─ 非 lpm 检测 → 三选一/警告/跳过                              （E4/F）
  │   └─ 改写聚合（mapProtocol + rewriteDepValue + findDepEntries） （E5）
  ├─ 聚合全部 target 完成:
  │   ├─ writeState（original + linkedAt，单次合并写）               （G/E6a）
  │   ├─ 逐文件 writeTextFileAtomic                                 （E6b）
  │   ├─ runInstall（单次，rootDir，flags 表）                       （E6c）
  │   ├─ writeLast（targets ≥ 2）                                   （I）
  │   ├─ spawnBuildWatch × N + 前台驻留                             （H）
  │   └─ O4 完成提示                                                （J）
  └─ dry-run：以上只读段跑完后输出执行计划，零写盘零子进程            （K）
```

## 6. 错误处理（逐条——每条含下一步动作，PRD §11）

| # | 错误 | 触发 | 文案关键片段（下一步动作） | 退出码 |
|---|---|---|---|---|
| 1 | WorkspaceNotFoundError | findWorkspaceRoot/loadWorkspace | S2 文案透传（「请进入项目目录后运行 lpm」等） | 1 |
| 2 | ManifestParseError | loadWorkspace / findDependents / lib manifest 严格读 | S2 文案透传（「请修正 JSON 语法后重试」） | 1 |
| 3 | PMAmbiguousError / PMUnresolvedError | resolvePackageManager detected 分支 | S3 文案透传（「请手动指定：lpm use <pnpm\|npm\|yarn>」） | 1 |
| 4 | LpmConfigParseError / LpmStateParseError | read/writeProjectConfig、readState/writeLast | S4 文案透传（「可修复或直接删除该文件——lpm 状态可抛弃重建」） | 1 |
| 5 | LibCheckError: dir-missing | checkLib 步骤 1 | 「路径不存在：<dir>。支持绝对路径、相对路径（相对当前目录）；含空格请加引号」 | 1 |
| 6 | LibCheckError: manifest-missing | 步骤 2（含 B4 形态 A 无 yaml 兜底） | 「<dir> 不是 npm 包（缺 package.json）。请确认路径指向包目录」 | 1 |
| 7 | LibCheckError: manifest-invalid | 步骤 3 | 「<manifest> 不是合法 JSON（<原因>）。请修正后重试」 | 1 |
| 8 | LibCheckError: name-mismatch（B7） | 步骤 4 | 「lib 实际 name（<n>）≠ 通讯录 key（<k>）。请更新 lpm.config.json 中 libs 键为 <n> 后重试」 | 1 |
| 9 | LibCheckError: entry-missing（B5） | 步骤 5 | 「入口产物缺失：<entry>。先 build 或起 build:watch 后重试」 | 1 |
| 10 | LibCheckError: node-modules-empty | 步骤 6 | 「<lib> 的 node_modules 为空。先在 <lib路径> 执行包管理器 install」 | 1 |
| 11 | LibCheckError: watch-script-missing | 步骤 7 | 「<lib> 缺 build:watch script。请在 lib package.json 补充后重试，或去掉 --watch」 | 1 |
| 12 | LinkArgumentError | 未注册名 / 非路径形态 / libs 值非串 / 路径分支目录不存在（含未注册 scoped 名误路由，A3） | 「未知注册名/路径不存在：<t>。已注册：<清单>；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册」 | 1 |
| 13 | LinkInteractionError: member-select | B4 让选非 TTY | 「<dir> 是 monorepo 根，需要选择成员包：可选成员 <清单>。当前环境无法交互——请直接使用成员路径，如 lpm link <成员路径>」 | 1 |
| 14 | LinkInteractionError: non-lpm-ternary | 非 lpm 三选一非 TTY | 「检测到非 lpm 管理的本地链接（<file>），需交互确认原始 range。请手动恢复该文件原值后重试，或先 lpm link --dry-run 查看」 | 1 |
| 15 | ProtocolPathError | mapProtocol 跨盘符 | S5 文案透传（「无法生成相对路径（跨盘符？）」） | 1 |
| 16 | InstallError | runInstall 失败（exit ≠ 0 / spawn 失败） | 「install 失败（exit <code>）：<stderrTail>。state 已保留，重跑 lpm link 会幂等跳过（E1）——重试：修复报错后在 workspace 根重跑一次 <install 命令行>；若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建」 | 1 |
| 17 | LinkTargetError | O5 零命中（findDependents 空） | 「<name> 不在任何成员依赖中。先在引用方执行 pnpm add <name> 再 link」 | 1 |

通用：错误信息走 stderr；错误后已产生的合法中间态以「幂等重跑稳定无腐化」为恢复路径（E8 崩溃中间态语义——drift 由 S8 收敛）；任何异常态提示均指向逃生门原则（PRD §11 行 364）。

## 7. 测试与验收

### 7.1 分层

- **unit**（vitest，临时目录 fixture + `vi.mock('execa')` / clack 注入）：linkcheck 纯函数、buildInstallCommand 表、runLink 编排（含崩溃恢复状态构造法——PRD §13.9）、writeTextFileAtomic、listWorkspaceMembers
- **e2e**（构建产物 CLI，真实 fs 临时项目）：直通链路的 dry-run / 幂等 / 错误路径（真实 install 不进自动化——PRD §12，人工验收）
- 交互路径：clack 函数 mock（S3 use-command.test.ts 先例）+ 非 TTY 分支直测

### 7.2 unit 清单（每条契约至少一正一反）

1. 无参数 → 提示文案 + exit 1（A1）
2. target 判定：注册名命中 / 未注册名报错 #12 / 路径形态（绝对、相对 `./`、含 `\`）/ **未注册 scoped 名（`@scope/pkg`）→ 路径分支 → 目录不存在 → #12 双提示（非 dir-missing 误导）** / 名字与路径歧义优先注册名 / libs 值非串 → #12（A2/A3）
3. PM 解析：config 设定直用 / detected 提示行 / PMAmbiguous 透传（A4）
4. B4 形态 A：无 package.json + pnpm-workspace.yaml → 成员展开 + 让选选定成员 libDir；非 TTY → #13（B1/B3）
5. B4 形态 B：有 package.json + workspaces → 让选；single 格式不触发（B2）
6. listWorkspaceMembers：正常展开（含负模式）/ 无 pnpm-workspace.yaml → invalid-root（§4.3）
7. checkLib 七 kind 逐条正反（C1–C7）；B5 豁免面：无 exports 无 main → 通过；仅 types exports → 通过；exports.default 指向缺失文件 → entry-missing；main 指向目录 → 试 index.js
8. upsert：新 key 写入 / 同值幂等不写 / 路径分支 key = lib name（D1/D2）
9. 幂等判定：state 有条目 → 跳过且**不触发 checkLib/install**（C1 顺序实证：名字分支先于 B4/checkLib 判定）；批量混入已链接 → 其余继续；全部已链接 → 零写盘零 install exit 0（E1）
10. 非 lpm：本地协议 + 无条目 → TTY 三选一各分支（git HEAD 成功 / 手动输入应用全文件 / **手动输入本地协议值 → 拒绝重提示** / 放弃跳过 / select 取消视同放弃）；非 TTY → #14；dry-run → 警告继续（E4/F）
11. git HEAD 选项可用性：部分文件取值失败 → ①禁用；取到本地协议 → 禁用（F1/F2）
12. O5：零命中报错文案含「先 pnpm add」（E3）
13. 改写聚合：mapProtocol 正确传 manifestDir（成员子目录相对化）；ProtocolPathError 透传；peer 命中进入警告数据；**同文件多 target 链式改写**（web 依赖 libA+libB → 两处改写共存于最终 content，无相互覆盖）；同 key 重复 target 去重只处理一次（E5）
14. 崩溃恢复状态构造法（PRD §13.9，收敛口径 = E8 注「稳定无腐化」）：构造「state 已写 / pkg 未改」与「pkg 已改 / install 未跑」两中间态 → 重跑 lpm link 均为幂等跳过（state 条目 byte 级原样、original 零损失、pkg 零追加写入、零 install）；断言**不腐化**而非强收敛——drift 交 S8（PRD §10 行 322/324）
15. 落盘顺序：install（execa mock）被调用时 state.json 与被改写 package.json 均已包含新值（E6 a/b 先于 c 的关键不变量；a↔b 内部顺序由 spec E6 契约与实现走查保证）；install 恰一次（多 target 单次）；install 失败 → InstallError 文案含「state 已保留」且 state 内容未被回滚删除（E6/#16）
16. writeState 合并写：多 target 单次调用、original 键正斜杠格式、linkedAt 为 ISO 8601（G1/G2/G4）
17. writeTextFileAtomic：正常写回（byte 级 content）/ rename 失败清理 tmp 且原错误重抛 / CRLF+BOM 内容逐字节保真（§4.3）
18. last：targets=2 成功 → names = 操作后全集；targets=1 → 不写；写失败 → 警告 + 退出码不变；全跳过 → 不写（I）
19. watch：spawn 参数（pm/libDir/script）/ 多 lib 多子进程 / dry-run 不拉起只打印 / 单个 spawn 失败警告且退出码不变（H）
20. dry-run：零写盘（config/state/pkg/last/gitignore 均未变——mtime+内容断言）+ 计划含 upsert/改写明细/已链接跳过行/install 命令/watch 行（K）
21. O4 输出：changedKeys 逐条原值→新值、跳过汇总、peer 警告行、防误 commit 尾行（J）
22. 遇错即停：第 2 个 target checkLib 失败 → exit 1 且 state/pkg **零写盘**（config 允许含第 1 个 target 的注册——E8 例外声明）（E8）

### 7.3 e2e 清单（构建产物，临时项目 fixture）

1. `lpm link --dry-run <路径>`：输出执行计划 + 项目目录（config/state/pkg/gitignore）byte 级零变化
2. `lpm link`（无参数）：提示文案 + exit 1
3. `lpm link <未注册名>`：#12 文案 + exit 1
4. `lpm link <已链接路径>`（预置 state）：「已链接」提示 + 零变化 + exit 0
5. `lpm --help` 含 link 行且不带「（计划 S6）」；既有 11 例回归不变

### 7.4 验收标准

1. `pnpm verify` 全绿（typecheck 0 + build + unit 含新增 + e2e 含新增），本机 Windows 通过；计数链定版 unit **223** = 158 基线 + T1 7 + T2 17 + T3 8 + T4 33（T2 +1 / T3 +1 / T4 +3 为 OCR 修复轮及残余修复新增，含残余① T4-33）+ e2e **16**（11 + 5）——计划期修订 5（T3 评审 I-1 修订 +1）与计划期修订 11（OCR 修复轮 + 残余①②）
2. §4.4 契约 ↔ 用例双向映射齐全（每条至少一正一反）
3. §6 错误表 17 条逐条有触发测试（断言错误类型/退出码/文案关键片段；#3 #4 #15 经透传路径覆盖）
4. 冻结面核验：S5 rewriter 恰 7 导出、S2 workspace 既有导出、S3 pm 既有导出、S4 state 既有导出逐字零改动；新增导出仅 §4.3 所列（writeTextFileAtomic / listWorkspaceMembers / linkcheck 三件 / install 四件 / runLink+LinkOptions+LinkArgumentError+LinkInteractionError+LinkTargetError）
5. 依赖白名单不变：运行时依赖恰为 commander / @clack/prompts / execa（零新增；git 为 system 命令调用，非依赖）
6. S1 spec 回写完成（§4.5 义务，hunk 清单 plan 期定）
7. **dry-run 一致性校验（PRD §13.9）**：同一 fixture 下 dry-run 计划中的改写明细/upsert 清单 == 真实执行后的实际文件变化集合（自动化断言，unit 编排层实现——install mock 后真实写盘）

## 8. 后续衔接

| 消费方 | 依赖的 S6 产出 |
|---|---|
| S7 unlink | `writeTextFileAtomic`（恢复写回复用）；崩溃安全顺序镜像（恢复 → install 成功 → 才删 state）；InstallError 文案基线；三态恢复的 original 单值边界（§4.4 E6a 注记）在 S7 收敛 |
| S8 status/repair | lstat 复验与 `--force` 重建未在 S6 落地（§1 非目标）——S8 三方核对承接；install 未生效场景（PRD §10 行 324）S8 判定 |
| S9 交互层 | 无参数交互模式（S6 仅提示）；B4 让选与三选一的交互化升级（S6 最小交互为基线）；执行计划预览可复用 §4.4 K 计划数据结构 |
| S10 集合预设 | last.json 已按 §10 规则写入（link 多个）；--last/--all/--preset 消费 readLast |

本 spec 评审通过后：invoke **writing-plans** 出 S6 implementation plan → SDD 逐任务实施（同 S1–S5 流程）。

## 9. 待评审决策点

无开放决策——六个关键裁决已在 brainstorming 拍板（§2）。实现期自决细节（非决策，评审可否决）：

1. B7 报错不自动 upsert（PRD §11 行 357「提示更新注册」字面——报错 + 建议，用户手改 config）
2. 路径分支 upsert 后**不同 key 同路径**的旧条目不清理不提示（forget/管理注册归 S11）
3. 同文件同 lib 多段命中原值异 → original 记首个命中值（S4 schema 单值限制；S7 期收敛）
4. 无参数 exit 1（非 0——「缺参数」按错误处理；S1 stub 期 exit 0 惯例不适用于已实现命令）
5. watch 驻留 `Promise.all(exited)` + SIGINT 兜底 kill，Ctrl+C 退出码 0（非错误终止）
6. git HEAD 选项①以「全部命中文件均能取得非本地协议原值」为可用性门槛（部分可用 → 禁用并注明，引导②/③）
7. 路径分支 name 为空串 → upsert key 用相对根路径（罕见形态，plan 期细化文案）
8. **崩溃中间态收敛口径（PRD §13.9 与 §9 行 308 的张力裁决，评审重点关注）**：幂等跳过为 PRD §9 行 308 字面（state 有条目 → 跳过改写），故「state 已写/pkg 未改」「pkg 已改/install 未跑」两中间态重跑 lpm link 为稳定无腐化而非强收敛——drift 归 S8 status/repair（PRD §10 行 322/324 本就如此分工）。若评审希望 link 重跑即收敛，需放宽 §9 行 308（如「pkg 当前值 ≠ 协议值时允许用 state 内 original 重改写」），代价是幂等规则复杂化 + C1 保护面重推导——本 spec 取 PRD 字面

候选（触发信号出现时再评估）：

9. 双终端并发 link 的 read-merge-write 互覆盖（后写进程覆盖先写进程的 state 条目；原子写仅保证文件不损坏）——重跑 link 幂等补齐收敛；触发信号：该场景真实发生 ≥ 2 次，再评估文件锁或重读重试

## 10. 评审 Backlog（multi-lens-review 2026-09-26，4 轮收敛）

场景 B 面板（架构师 / 资深开发 / 资深测试 / 交付运维）× 六手法全过，共 4 轮：第 1 轮发现 2 P0 + 4 P1 + 4 P2（F1–F10）并全部修复；第 2 轮手法 3 复跑发现 1 P1（F11，修复引入面交叉——放弃路径 × upsert 时序）并修复；第 3 轮全修改区复跑零新增；**第 4 轮（用户指令复跑，手法 4 输入值域枚举与手法 2 读取点合法性深挖）发现 2 P1 + 1 P2（F12–F14）并全部修复**；第 4 轮修复后手法 3 重跑 + 同族扫描零新增 P0/P1。成分归因：F1/F2/F3/F4/F5/F11/F13 = 流程缺失（操作序列推演未覆盖聚合覆盖语义/前置段写盘 × 放弃路径交叉；一致性矩阵未做 §4.3↔§6 清单核对与 dry-run 分支交叉核对；输入空间枚举未覆盖 scoped 名路由与路径分支失败分支）；F6 = 知识缺失（clack isCancel 取消语义为交互惯例，未入必问清单）；F12 = 假设未显式化（「手动输入值默认为合法 registry range」隐含前提未列）；F14/P2 = 知识缺失补齐。

**P0/P1 修复对照**：

| # | 级别 | 问题（触发序列） | 修复落点 |
|---|---|---|---|
| F1 | P0 | 同文件多 target 改写互相覆盖：`lpm link libA libB` 且 web/package.json 同依赖两者 → E6b 后写者基于原始 content 冲掉先链接者改写，state 已记链接 → 漂移且 O4 谎报 | §4.4 E5 改按 manifestPath 分组链式应用（后改者基于前改者 content）+ §7.2 #13 用例 |
| F2 | P0 | E8「遇错即停零写盘」与 D5 upsert 先行落盘矛盾（批量第 2 target 失败时 config 已写入第 1 target） | §4.4 E8 措辞改为「无 state/pkg 写盘，config 已注册条目保留（无害幂等）」+ §7.2 #22 同步 |
| F3 | P1 | §6 表引用 LinkArgumentError/LinkInteractionError 但 §4.3 新增导出清单缺二者（§7.4 #4 冻结面验收自相违反） | §4.3 补两错误类签名 + §7.4 #4 括号同步 |
| F4 | P1 | 路径分支幂等判定需要 name，但 D1 称 name 为 checkLib 产出（时序倒置） | §4.4 E1 补「name 预读（读取失败跳过幂等判定交 checkLib 报错）」+ D1 措辞同步 |
| F5 | P1 | K2「三选一交互照常」与 E4 dry-run「降级纯警告」矛盾 | §4.4 K2 改为「B4 让选照常；三选一降级纯警告（E4）」 |
| F6 | P1 | clack isCancel（用户 Esc 取消）三处交互均未定义行为 | B3（让选取消 → exit 1「已取消」）/ E4（select 取消 → 视同放弃）/ F3（text 取消 → 视同放弃）补齐 + §7.2 #10 用例 |
| F11 | P1 | 第 2 轮手法 3 复跑发现：F4「放弃 target 不注册」与 D5 upsert 时序矛盾（放弃发生时注册已落盘） | §4.4 F4 措辞改为「不落 state/pkg（original 零记录），config 注册保留并对齐 E8 例外语义」 |
| F12 | P1 | 第 4 轮：三选一选项②手动输入未校验本地协议——误输入 `link:../foo` 被持久化为 original，unlink 将「恢复」成 link 路径（恰为 PRD §9 行 310 要防的污染经手动通道绕过） | §4.4 F3 输入值本地协议校验（拒绝重提示，计入 3 次上限）+ §7.2 #10 用例 |
| F13 | P1 | 第 4 轮：未注册 scoped 包名（`@scope/pkg` 含 `/`，本项目真实形态）误入路径分支 → A3 isDirectory 失败行为未定义且 dir-missing 文案误导（把注册名当路径报） | §4.4 A3 校验失败显式化 LinkArgumentError + 双提示文案 + §6 #12 触发/文案同步 + §7.2 #2 用例 |

**P2 已采纳**：

| # | 问题 | 落点 |
|---|---|---|
| F7 | 重复 target（`lpm link A A`）行为未定义（无害冗余但计数虚高） | §4.4 E5 聚合按 key 去重 + §7.2 #13 |
| F8 | config.libs[target] 非 string（手改 config）未定义（空相对路径把 workspace 根当 lib） | §4.4 A2 类型防御 + §7.2 #2 |
| F9 | detectLibPM 多 lockfile 共存优先序未定义 | §4.3 注释：pnpm-lock > yarn.lock > package-lock 首个命中 |
| F14 | 第 4 轮：workspace 根自身命中时 relDir 空串 → original 键成 `/package.json`（前导斜杠） | §4.4 G1 补定义：根命中键为 `package.json`（无前导斜杠） |

**P2 候选**：

| # | 问题 | 触发信号 |
|---|---|---|
| F10 | 双终端并发 link 的 read-merge-write 互覆盖（原子写仅防文件损坏） | §9 候选 9：真实发生 ≥ 2 次 |

**P2 已关闭**：无。

**第 4 轮修复后收敛确认**：全部修复后手法 3 重跑（§2 裁决 ↔ §4.4 契约、§4.3 ↔ §6 错误表双向齐全、§7.2 ↔ §4.4 双向映射、计数链算术、F4↔D5/I1/E8 交叉、J2↔J1 口径、F12↔F2 校验单源同一正则、F13↔#12 触发穷举、F14↔J1 展示格式）+ F1–F14 逐项同族扫描（同文件多写盘点唯一 ✓；前置段写盘仅 config 一处且 E8/F4 两处声明一致 ✓；clack 交互点三处全覆盖 ✓；前置读取仅路径分支一处 ✓；dry-run 交互点穷举 B4/三选一两处 ✓；放弃路径 config 语义与 E8 单源对齐 ✓；**original 写入通道穷举三项——DepHit 现读/git HEAD/手动输入，后两者均经本地协议校验 ✓**；**含分隔符 target 路由歧义仅 scoped 名一形，A3 双提示兜底 ✓**）——零新增 P0/P1，收敛。

**OCR 评审轮（2026-09-26，open-code-review）**：S6 交付（unit 218 + e2e 16 全绿）后 OCR 评审出 15 条意见——严重度分布 **1 critical + 4 medium + 10 low**（以 `ocr-out.txt` 原文逐条分级为准；O11 一条合并 link.ts 两处 finding）。控制者逐条亲验后三态处置：**12 修复 + 2 关闭**（O12 自文档化优先保留、O13 归 S12 延后重构）。

**关键触发序列（O1 critical / O2、O3 medium）**：

- **O1（critical，install.ts:37）**：`PackageManagerId` 是逻辑 id（`'yarn-classic'` / `'yarn-berry'`），被直接当可执行文件名传 execa → 不存在同名可执行文件，yarn 项目 `lpm link` 的 install 报 `InstallError`、`--watch` 每次打印「拉起失败」（ENOENT）。触发序列：任一 yarn（classic/berry）workspace 执行 `lpm link <路径>`（实时或 `--watch`）即恒定失败。
- **O2（medium，link.ts:197-199）**：`headUsable=false` 时 head 选项仍以 `value:'head'` 出现在三选一列表 → 选中返回部分/空 `headValues`，经 E5 fallback `originals.get(...) ?? h.currentValue` 把当前 `link:`/`file:`/`portal:` 值写入 `state.original`，静默击穿 PRD §9 行 310 防线（恰为 manual 分支显式拒绝的结局）。触发序列：非 lpm 本地链接 + git HEAD 通道不可用（无 git / 文件未入库 / HEAD 值仍为本地协议）+ 用户在列表选中 head。
- **O3（medium，link.ts:51-53）**：`LinkTargetError` 参数属性 `public name` 被构造体 `this.name = 'LinkTargetError'` 覆盖（参数属性在 `super()` 后赋值，类名赋值后覆盖）→ 调用方读 `err.name` 恒为类名而非包名。触发序列：O5 零命中路径构造该错误后读取 `name` 字段。

**三态处置表**：

| OCR# | 文件:行 | 级别 | 处置 | 落点 |
|---|---|---|---|---|
| O1 | install.ts:37 | critical | 修复 | PM_BINARY id→可执行名单源；runInstall/spawnBuildWatch/`command` 统一；T3-8 |
| O2 | link.ts:197-199 | medium | 修复 | 不可用时该选项不出现（原因经 stderr 列出）；T4-28 |
| O3 | link.ts:51-53 | medium | 修复 | 字段改名 `pkgName`（位置参数不变） |
| O4 | link.ts:405 | medium | 修复 | dry-run flags 改 `buildInstallCommand(pm).join(' ')` 单源 |
| O5 | workspace.ts:365 | medium | 修复 | `validatePatterns` 单源 helper（loadWorkspace/listWorkspaceMembers 共用）；load-workspace 23 用例回归 |
| O6 | link.ts:103 | low | 修复 | `Object.hasOwn` 自有属性判定；T4-31 |
| O7 | link.ts:365-366 | low | 修复 | 按 manifestPath 分组，每 manifest 每 target 恰一次 `rewriteDepValue`；T4-32 |
| O8 | linkcheck.ts:112 | low | 修复 | `!= null` → 显式类型判定（严格相等规约） |
| O9 | linkcheck.ts:60-63 | low | 修复 | 重写 `collectEntryCandidates`（去死分支 + 兼容 exports 顶层条件简写）；T2-17 |
| O10 | install.ts:16-17 | low | 修复 | `buildInstallCommand` 返回防御拷贝 |
| O11 | link.ts:7 / 70 | low | 修复 | 删死导入 `type PackageManagerId` + 死字段 `LinkedTarget.key` |
| O12 | install.ts:57-58 | low | 关闭 | package-lock 显式分支保留（自文档化优先，fallback 冗余可接受） |
| O13 | atomic.ts:29-38 | low | 关闭（延后） | 两函数核心重复不重构，归 S12 |
| O14 | link.ts:293 | low | 修复 | 嵌套三元展开为 if/else |

修复轮计数链：unit 218 → **222**（T2 +1 = T2-17 / T3 +1 = T3-8 / T4 +2 = T4-31、T4-32）；e2e 16 不变。逐条处置与验证输出见 plan「计划期修订 11」与 `.superpowers/sdd/2026-09-26-s6-link-direct.md/ocr-fix-report.md`。

**残余风险（2026-09-26，修复轮 re-review 报出，控制者裁定修复）**：O1 的期望形态只覆盖 install.ts 三处，link.ts 的 dry-run install 行与两处 watch 行仍展示逻辑 id（`yarn-berry install …` / `yarn-berry run build:watch` 不可直接重跑——与 O1 同族且触 PRD §13.9「dry-run 骗人比没有更糟」红线）。裁定：install.ts 追加导出 `pmExecutable` / `buildInstallCommandLine`（PM_BINARY 单源），link.ts 三处展示与 `runInstall` 诊断串统一走该单源；新增 T4-33 守护。计数链 222 → **223**（T4 32 → 33）。判定与验证见 `.superpowers/sdd/2026-09-26-s6-link-direct.md/ocr-rereview2.md`。
