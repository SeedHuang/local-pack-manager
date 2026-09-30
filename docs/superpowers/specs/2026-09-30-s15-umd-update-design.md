# S15「lpm umd：自研依赖自动更新」spec（2026-09-30）

- 阶段：S15（新子域「依赖更新」第一步；S14 编号已被 S13 spec §9「link/unlink 自动联动」追加记录占用，故本 spec 用 S15）
- 依赖：S2（workspace 解析 findWorkspaceRoot/loadWorkspace/findDependents）、S5（改写引擎 rewriteDepValue/restoreDepValue）、S6（runInstall/buildInstallCommandLine）、S8（运行留痕 buildRunTrace/writeRunTrace/traceFailure）、S12（--dry-run 全局口径、错误模板、非 TTY 拒绝闸门）
- 行为权威：本文档；与 PRD §2 行 31「包发布 / 版本管理 / changelog（未来子域）」、PRD §16「--yes 已关闭」对照见 §9
- 用户决策来源：brainstorming（2026-09-30）：更新程度 = 每库确认一次 + 同轮同库只问一次；扫描范围 = 仅 workspace 清单成员；安装方式 = 升级安装（委托 lpm 判断）

---

## 1. 目标与非目标

### 1.1 背景（用户痛点）

自己开发的库（`lpm.config.json` 的 `libs` 通讯录里记的那些）发布新版本后，项目里还声明着旧版本。手动流程 = `npm view <包> dist-tags.latest` 查版本 → 逐个 package.json 改版本号 → 装依赖。**monorepo 多个子包都要改，更麻烦。** `umd`（update my dependencies）把这段重复劳动一次做掉：查远程最新版 → 找出所有声明它的地方 → 落后的改版本号 → 一次安装生效。

### 1.2 目标

1. **`lpm umd`**：自动查通讯录里所有「自己开发的库」在 npm 上的最新版。
2. **只处理「用的是远程版本」的依赖**：正在本地联调（`.lpm/state.json` 有链接记录）的整库跳过；命中点声明值是本地协议 / workspace 协议的跳过。
3. **版本落后的 → 保留前缀风格改版本号 → 一次 install 生效**（monorepo 全部子包一次搞定）。
4. **交互确认**：每个要升级的库确认一次；**同一轮里同一个库在多个子包出现只问一次**（用户决策）；支持 `--dry-run` / `--yes`。
5. 沿用 lpm 全局口径：`--dry-run`、错误即建议（描述 + 下一步）、运行留痕。

### 1.3 非目标（明确划界，防范围蔓延）

- **不处理「声明范围已满足最新版但 lockfile 装的旧」**（如声明 `^1.0.0`、latest `1.2.0`、已装 `1.0.0`）：那是 `pnpm update <包>` 的职责（不改声明）。umd 只处理「**按声明装不到最新版**」→ 需改声明的情况。完成提示里不展开。
- **不自动处理跨大版本护栏**：用户决策为「每库确认一次」，天然覆盖破坏性升级；不另设特判。
- **不计算复杂写法的「新版本号」**：`link:`/`file:`/`portal:`、`workspace:`、`npm:`、tag（`latest`）、`1.0.x`、多条件 range（`>=1.0.0 <2.0.0`）等**非 exact/`^`/`~` 形态**，无法自动推导保留前缀的新值 → 若已覆盖最新版则视为 `current` 不动，否则单点跳过 + 提示，交用户手工（见 §4.2 `decideUpgrade` 判定顺序）。
- **不碰 lib 自身**：只改消费方 package.json 的声明值；不改 lib 的 package.json / node_modules。
- **不写 `.lpm/state.json`**：umd 不是 link 操作，无「original 恢复」语义，改完即永久生效（回退靠 git，见 §4.5）。
- **不扩展预设 / 集合记忆**：save/preset/last 全不动。
- **不做全局通讯录 / 多项目批量**：只处理当前 workspace。
- **e2e 不依赖真实网络**：happy path 以 unit mock 覆盖；e2e 只走无网络路径（见 §6）。

---

## 2. 关键裁决（brainstorming 2026-09-30 收敛）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 「落后」定义 | **声明的 range 装不到最新版**才算落后：`semver.satisfies(latest, declared) === false`。`1.0.0` vs latest `1.2.0` → 落后；`^1.0.0` vs `1.2.0` → 不落后（`^` 允许）；`^1.0.0` vs `2.0.0` → 落后（跨大版本）。 |
| 2 | 更新程度 | **获取最新 → 每库确认一次 → 确认才更新**（用户决策）。跨大版本不特判（被确认流程覆盖）。 |
| 3 | 确认粒度（session memory） | **按 lib 聚合，每库只问一次**；同库在多个子包声明 → 一次确认全部应用。实现 = 按 lib 分组 + `approved: Set<string>`（防未来改动引入重复问询）。对应用户「同一个会话中同意过一次，后续遇到相同包升级就不用再问」。 |
| 4 | 扫描范围 | **只扫 workspace 清单成员**（`findDependents`，与 link/unlink 世界观一致）；node_modules / 隐藏目录天然不扫（S2 collectMembers 已排除）。 |
| 5 | 跳过面 | `state.links` 有该 key（正在联调）→ **整库跳过**；命中点 currentValue 是本地协议 / `workspace:` / 无法解析 → **单点跳过 + 提示**。 |
| 6 | 安装方式（委托判断） | **升级安装**：所有改动合并成**一次**普通 install（workspace 根，`runInstall` 已含 `--no-frozen-lockfile`）。不做删 node_modules 的彻底重装——改版本号后普通 install 即更新 lockfile + node_modules，够用；force 重装慢且只对「node_modules 已坏」有意义（那是 `lpm status`/`repair` 的职责）。 |
| 7 | 远程版本查询 | `npm view <pkg> dist-tags.latest`（execa 子进程，cwd=rootDir 让项目 `.npmrc` 的 registry 生效），带超时（15s）。失败（网络/超时/包不存在/输出非版本号）→ **跳过该库 + 警告，不阻断其它库**。 |
| 8 | 新版本号计算 | **保留前缀风格**：exact `1.0.0` → `1.2.0`；`^1.0.0` → `^1.2.0`；`~1.0.0` → `~1.2.0`。其它无法解析写法 → 单点跳过 + 提示。 |
| 9 | 新依赖 | **`semver`**（npm 标准小包，range 判定 / 版本比较）。仅此一个新增运行时依赖（查版本用 node 自带 npm 二进制，不加依赖）。 |
| 10 | 留痕 | **写运行留痕**（`command: 'umd'`，扩展 `LastRunTrace.command` 联合）。umd 与 link/unlink/repair 同族（改写 manifest + 跑 install、有失败收敛语义），**区别于** init/uninit（S13 §1.3：配置类命令不写留痕）。 |
| 11 | 装后验证 | install 后读根 `node_modules/<pkg>/package.json` 的 version，与 latest 不一致 → **警告**；文件不存在 → 跳过（pnpm 可能未 hoist，不误报）。 |
| 12 | 非 TTY | 无 `--yes` 且非 TTY → `UmdInteractionError`（改用 `--yes` / `--dry-run`）。`--yes` 与 PRD §16 已关闭的 link `--yes` **不同源**：link 直通本无确认环节，`--yes` 是伪需求；umd 的逐库确认是用户明确要求的内建环节，`--yes` 服务于脚本 / CI 的非交互出口。 |

---

## 3. 数据流

```
lpm umd [--dry-run] [--yes]（在项目任意目录运行；workspace 向上定位）
  → cli.ts：.option('--dry-run') .option('--yes') + action → runUmd(opts, cwd)
  → ① workspace：findWorkspaceRoot(cwd) → loadWorkspace(rootDir) → ws
  → ② config：readProjectConfig(rootDir) → libs
        config 缺失 / libs 空 → stdout 提示「先 lpm link 注册」（exit 0，空态即向导）
  → ③ state：readState(rootDir) → links（正在联调的 key 集合）
  → ④ PM：resolvePackageManager(rootDir, cfg.packageManager)（install 用）
  → ⑤ 未链接的每个 lib（按 config 顺序，串行）：
        queryLatestVersion(pkgName) → latest
        失败 → stdout 警告「查询失败，跳过该库」→ 继续下一个
  → ⑥ 对每个 (pkg, latest)：findDependents(ws, pkg) → 命中点
        逐点 decideUpgrade(currentValue, latest) → 三态：
          skip   → 单点跳过 + 提示（本地协议 / workspace: / 无法解析）
          current→ 忽略（已满足最新）
          behind → 候选（next = 保留前缀的新声明值）
        同一 manifest 内同一 pkg 多命中点判定不一致 → 整文件跳过 + 提示（§4.3 一致性规则）
  → ⑦ 聚合计划（按 lib 分组；每项 = manifest 相对路径 + 段 + from → to）
  → ⑧ 交互闸门（§4.4）：
        --dry-run   → 打印计划 + install 命令 → exit 0（零写盘零子进程）
        无候选      → 「没有需要更新的依赖」→ exit 0
        非 TTY 且无 --yes → UmdInteractionError
        TTY / --yes → 每库确认一次（clack.confirm；--yes 全跳过；Esc → 中止 exit 1；否 → 跳过该库）
  → ⑨ 写盘：对每个命中 manifest 用 rewriteDepValue(source, pkg, next) 计算新全文
        → writeTextFileAtomic(manifestPath, newContent)
  → ⑩ install：runInstall(rootDir, pm)（一次）
        失败 → InstallError 上报；**注意：不要重跑 lpm umd 试图收敛**——已最新的库会判定
        current → 无候选 → 不触发 install；正确收敛路径 = 在 workspace 根直接重跑一次
        install 命令（版本号已写入 package.json，语义已定）
  → ⑪ 验证：读根 node_modules/<pkg>/package.json version ≠ latest → stderr 警告
  → ⑫ 完成提示（改了哪些文件、from → to、勿提交、回退命令）+ writeRunTrace(command: 'umd')
```

---

## 4. 接口与行为契约

### 4.1 命令面

| 命令 | 参数 | 直通用法 | 交互（无参数） |
|---|---|---|---|
| `lpm umd` | `--dry-run`（预览）`--yes`（跳过逐库确认） | `lpm umd --dry-run` / `lpm umd --yes` | TTY：计划预览 + 逐库确认 |

- **无位置参数**（`allowExcessArguments(false)`）。
- 交互列 = **逐库确认**（用户决策），与 repair 的「预览 + 一次确认」同族，但确认粒度是**每库一次**（session memory）。

### 4.2 公共 API 面（S15 新增；均含单元测试可测的纯逻辑）

```ts
// src/commands/umd.ts（新文件）
export interface UmdOptions { dryRun?: boolean; yes?: boolean }
export async function runUmd(opts: UmdOptions, cwd: string = process.cwd()): Promise<number>

// src/core/remote.ts（新文件）
export class RemoteQueryError extends Error {
  constructor(public pkgName: string, message: string) { ... }
}
/** 查 pkg 在 npm 上的 latest dist-tag；cwd 缺省 process.cwd()（让项目 .npmrc registry 生效）；
 *  超时（缺省 15s）→ RemoteQueryError；stdout 非合法 semver → RemoteQueryError */
export async function queryLatestVersion(pkgName: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<string>

// src/core/upgrade.ts（新文件，纯函数，核心单测面）
export type UpgradeDecision =
  | { kind: 'behind'; next: string }   // 落后；next = 保留前缀的新声明值
  | { kind: 'current' }                // 已满足最新（含声明本身无法解析时? 否——无法解析归 skip）
  | { kind: 'skip'; reason: 'local-protocol' | 'workspace-protocol' | 'unparseable' | 'unsupported-shape' }
/** 判定单个命中点的升级决策 */
export function decideUpgrade(declared: string, latest: string): UpgradeDecision
```

`decideUpgrade` 判定顺序（逐条短路，契约锁定）：
1. `declared` 以 `link:` / `file:` / `portal:` 开头（复用 `LOCAL_PROTOCOL_RE`）→ `skip('local-protocol')`
2. `declared` 以 `workspace:` / `npm:` 开头 → `skip('workspace-protocol')`
3. `semver.validRange(declared) === null` → `skip('unparseable')`（覆盖 `latest`、空串、畸形）
4. `semver.satisfies(latest, declared) === true` → `current`（覆盖 `*`、`^1.0.0` 满足 `1.2.0` 等）
5. 计算新值：`declared` 为 exact（`semver.valid`）→ `latest`；以 `^` 或 `~` 开头且剩余部分是合法 exact 版本 → `^${latest}` / `~${latest}`；**其它形态（如 `1.0.x`、多条件 range）→ `skip('unsupported-shape')`**
6. 否则 → `{ kind: 'behind', next }`

### 4.3 一致性与跳过的契约

**同一 manifest 内同一 pkg 的多个命中点**（dependencies / devDependencies / optionalDependencies 多段出现）：
- `rewriteDepValue` 的粒度是**整包**（一次性替换该 pkg 的全部出现值）——因此 umd 的判定粒度也必须收敛到包级，避免「一段 behind 一段 current」时误改。
- 规则：同一 manifest 内同一 pkg 的所有命中点须**全部 `behind`（且 next 相同）**才自动改；**任一命中点是 `skip`**，或 **behind/current 混合** → 该文件**整体跳过 + 提示**（交用户手工对齐，安全优先）。
- 实际出现概率极低（正常项目同包同文件只会写一个版本），此规则只防罕见脏数据被误动。

### 4.4 交互闸门

| 条件 | 行为 |
|---|---|
| `--dry-run` | 打印计划 + install 命令 → exit 0（零写盘零子进程） |
| 无候选 | stdout `没有需要更新的依赖。`（说明见 §4.5）→ exit 0 |
| 非 `--dry-run` 且非 TTY 且无 `--yes` | `UmdInteractionError`：`需逐库确认升级。\n下一步：改用 lpm umd --yes 直接更新，或 lpm umd --dry-run 查看预览` → exit 1 |
| TTY 且无 `--yes` | 打印计划预览 → **逐库确认**：`clack.confirm({ message: '更新 <pkg> 到 <latest>？（<N> 个文件 <M> 处声明）', initialValue: false })` → 是 → 应用该库全部命中点；否 → 跳过该库；Esc（isCancel）→ 中止整个命令 exit 1 |
| `--yes` | 跳过全部确认，直接应用所有候选（非 TTY 可用） |

- **session memory**：候选已按 lib 聚合，`approved: Set<string>` 记录本轮已确认的库——同库多处声明一次确认全部应用（用户决策；聚合已保证每库只问一次，Set 防未来代码改动引入重复问询）。
- 全部候选被否 → `未更新任何依赖` → exit 0（用户主动选择，非错误）。

### 4.5 完成提示与「无落后」说明

- 完成提示（与 link 同风格，`勿提交` 措辞一致）：
  ```
  更新完成：N 个库、M 个文件、K 处声明已更新版本号：
    apps/web/package.json:
      dependencies.@seedhuang/ai_suit_tool：1.0.0 → 1.2.0
  已执行 1 次安装：pnpm install --no-frozen-lockfile
  以上 package.json 已修改，请勿提交；如需回退：git checkout -- <受影响>/package.json 后重跑一次 install
  ```
  - **install 命令串动态生成**：用 `buildInstallCommandLine(pm)`（按检测到的 PM 输出），上例仅为 pnpm 形态示例——不允许硬编码 pnpm。
- 「无落后」说明（stdout，帮助用户理解为何没动）：
  ```
  没有需要更新的依赖。
  （已声明的版本范围均能装到最新版；若实际安装的版本滞后，请用 <pm> update <包名>）
  ```
- 单点跳过提示（stdout，非错误）：`<相对 manifest> 的 <pkg> 声明 <value> 无法自动解析（本地协议 / workspace / 复杂写法），已跳过——请手动处理`
- 单库查询失败提示（stdout，非错误）：`查询 <pkg> 远程版本失败，已跳过该库（不阻断其它库）`

### 4.6 命令接线（cli.ts + registry.ts）

```ts
// cli.ts（新增特判，仿 repair 接线）
if (meta.name === 'umd') {
  program.command(meta.name).description(meta.summary)
    .option('--dry-run', '仅打印执行计划，不落盘不执行')
    .option('--yes', '跳过逐库确认，直接更新')
    .allowExcessArguments(false)
    .action(async (options: { dryRun?: boolean; yes?: boolean }) => {
      process.exitCode = await runUmd({ dryRun: options.dryRun, yes: options.yes })
    })
  continue
}

// registry.ts（COMMANDS 追加一条）
{ name: 'umd', summary: '把自研库的远程依赖更新到 npm 最新版' }
```

- 相对导入带 `.js`（ESM 惯例）。

### 4.7 写盘与原子性

- 改写写盘用 `writeTextFileAtomic(manifestPath, newContent)`（[atomic.ts](file:///d:/Seed/local-pack-manager/src/state/atomic.ts) 既有原语，与 link 同）。
- 崩溃安全：**先全部改写写完 → 再 install**。install 失败 / 中断时版本号已在 package.json 里（语义已定）。**注意：重跑 `lpm umd` 不会触发 install**（已最新 → 无候选 → 不跑安装）；收敛路径 = 在 workspace 根**直接重跑一次 install 命令**（`runInstall` 的 `--no-frozen-lockfile` 会按新声明重新解析）。

---

## 5. 错误表（统一模板，继承 S12 §4.7；reportError 结构零改动）

| # | 错误类 | 场景 | 描述 / 下一步 |
|---|---|---|---|
| U1 | `RemoteQueryError` | npm view 失败 / 超时 / 输出非版本号 / 包不存在 | `查不到 <pkg> 在远程仓库的最新版本（<原因>）。下一步：检查网络与 registry 配置；可手动 npm view <pkg> dist-tags.latest 验证；确认包名正确` |
| U2 | `UmdInteractionError` | 非 TTY 且无 `--yes` | `需逐库确认升级。下一步：改用 lpm umd --yes 直接更新，或 lpm umd --dry-run 查看预览` |
| U3 | （复用）`InstallError` | install 失败 | `install 失败（exit <code>）：<stderr 尾>。下一步：修复报错后在 workspace 根重跑一次 <install 命令>（版本号已写入 package.json；不要重跑 lpm umd——已最新的库会跳过、不会触发安装）` |

非错误提示（exit 0）：
- 无已注册 lib：`当前没有任何已注册的 lib。下一步：先 lpm link <路径> 注册`
- 无落后依赖：§4.5「没有需要更新的依赖」

**KNOWN 列表**（reportError）：`RemoteQueryError`、`UmdInteractionError`、`InstallError` + 复用的 `WorkspaceNotFoundError` / `ManifestParseError` / `LpmConfigParseError` / `LpmStateParseError` / `PMAmbiguousError` / `PMUnresolvedError`（umd 调 findWorkspaceRoot、读 config/state、resolvePackageManager）。exit 1。

---

## 6. 测试清单（取数命令 = `pnpm verify`）

**`tests/unit/upgrade.test.ts`（新）——`decideUpgrade` 判定矩阵（核心单测面）**
- exact：`1.0.0` vs `1.2.0` → behind/next `1.2.0`；`1.2.0` vs `1.2.0` → current；`1.2.0` vs `1.1.0` → current（latest 不应更旧，防御性）
- `^`：`^1.0.0` vs `1.2.0` → current（已满足）；`^1.0.0` vs `2.0.0` → behind/next `^2.0.0`；`^1.0.0` vs `1.0.0` → current
- `~`：`~1.0.0` vs `1.0.9` → current；`~1.0.0` vs `1.1.0` → behind/next `~1.1.0`
- 跨大版本：`1.0.0` vs `2.0.0` → behind/next `2.0.0`（确认流程覆盖，不特判）
- skip：`link:../x` / `file:./x` / `portal:../x` → local-protocol；`workspace:*` / `npm:foo@^1` → workspace-protocol；`latest` / `''` → unparseable；`>=1.0.0 <2.0.0` vs `2.0.0` → unsupported-shape（validRange 通过、satisfies false、非 exact/^/~ 形态）；`1.0.x` vs `1.2.0` → unsupported-shape
- 多条件 range 已覆盖最新：`>=1.0.0 <2.0.0` vs `1.2.0` → current（不跳过——satisfies true）
- `*` → current（validRange 通过且满足一切）
- 边界：`0.0.0` vs `0.0.1` → behind；`0.0.1` vs `0.0.0` → current

**`tests/unit/remote.test.ts`（新）——`queryLatestVersion`（mock execa）**
- 正常输出 `1.2.0\n` → 返回 `1.2.0`；带空白 → trim；非 semver 输出（`1.2` / `foo` / 空串）→ RemoteQueryError；非零退出码 → RemoteQueryError；超时 → RemoteQueryError
- cwd 传递到 execa（项目 .npmrc registry 生效的契约）

**`tests/unit/umd-command.test.ts`（新）——`runUmd` 编排（mock queryLatestVersion + clack + runInstall + findDependents）**
- 无 lib → 提示 + exit 0 + 零写盘
- 有 lib 正在联调（state.links 有 key）→ 整库跳过 + 提示
- 混合（2 远程 1 链接）→ 只处理远程；落后的 → 候选
- session memory：同库在 2 个成员声明 → `clack.confirm` 调用次数 = 库数（1），改写写盘 2 处
- `--yes` → 零 confirm 调用
- `--dry-run` → 打印计划 + 零写盘 + 零 install + exit 0
- 非 TTY 且无 `--yes` → UmdInteractionError + exit 1
- 确认后 → 改写写盘 + install 恰一次 + 完成提示 + trace 写入
- 同文件同包多段判定不一致（behind + current / 任一 skip）→ 整文件跳过 + 提示，零改写
- 单库查询失败 → 警告 + 继续其它库
- `LastRunTrace.command === 'umd'` 断言（联合类型扩展生效）

**`tests/unit/stub.test.ts`（既有）**：umd 从 stub 清单移除（如有引用）。

**`tests/e2e/cli.e2e.test.ts`（追加，仅无网络路径）**
- `COMMAND_NAMES` 加 `umd`；`--help` 列出 12 个命令（原断言 `11 个` → 更新为 12）
- 临时项目（无 lpm.config.json）跑 `lpm umd` → exit 0 + stdout 含「先 lpm link」
- 临时项目（有 libs 但无真实网络不触发——无 libs 路径即可）——**happy path 不进 e2e**（需真实 npm / install，unit mock 已覆盖）

---

## 7. 后续衔接

| 消费方 | 依赖的 S15 产出 |
|---|---|
| PRD §2「版本管理（未来子域）」 | umd 落地版本管理子域第一步；后续 v2 候选可扩展（见 §9 Backlog） |
| S13 §9「v1 收官」 | 本 spec 为 v1 之后新子域，编号 S15（S14 已被 link/unlink 联动追加记录占用） |
| PRD §16「--yes 已关闭」 | 对照记录见 §9（不同源：umd 的确认是内建环节，--yes 是非交互出口） |

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **semver 依赖版本**：^7（当前主版本，Node 22 兼容）。
2. **npm view 执行**：`execa('npm', ['view', pkgName, 'dist-tags.latest'], { cwd: rootDir, timeout: 15000, reject: false })`；stdout trim 后 `semver.valid` 校验。scoped 包名（`@scope/pkg`）经 execa args 数组传参，无 shell 转义问题。
3. **串行查询**（§3 ⑤）：简单、输出有序；lib 数量通常个位数，查询非瓶颈，不做并发。
4. **一致性规则实现**（§4.3）：按 `manifestPath` 分组命中点，组内全部 `behind` 且 next 相同才写；否则整文件跳过 + 提示。
5. **计划预览渲染**：优先复用 `renderPlan`（与 link 同族：改动清单 + install 命令）。注意 S13 §4.7「renderPlan 单源契约限 link/unlink」备注——若评审认为越界，退化为 umd.ts 内私有打印（仿 init.ts `printInjectDiff`），两案实现成本相近。
6. **装后验证读取面**：根 `node_modules/<pkg>/package.json` 的 version；`semver.eq(version, latest)` 为 false → 警告；文件不存在 → 跳过（pnpm 可能未 hoist，不误报）。
7. **e2e 不加 mock seam**：happy path 以 unit mock 覆盖（生产代码不引入测试专用环境变量）。
8. **完成提示「勿提交」措辞**：与 link 完成提示逐字同风格（§4.5）。
9. **reportError 的 KNOWN 列表**：按 §5 追加两个新错误类 + 复用清单，结构零改动（S13 同款做法）。
10. **state/types.ts 的 `LastRunTrace.command`**：`'link' | 'unlink' | 'repair'` → 追加 `'umd'`；`changes.action` 复用 `'rewrite-manifest'`（不新增 action 值）。
11. **查询源与安装源的 registry 视角假设（显式化）**：版本查询走 `npm view`（读 npm 配置链：项目 `.npmrc` → 用户 `~/.npmrc` → 全局），安装走检测到的 PM（pnpm/npm/yarn 同样读 `.npmrc` 的 registry 键）——**通常共享同一 `.npmrc` 故两源一致**。仅当用户为 npm 与 PM 分别配了不同 registry（如 npm 直连、pnpm 走镜像）时，查询版本可能不代表实际安装源；该假设已显式记录，真实场景踩中再按「以检测 PM 的 view/info 命令查询」迭代。

---

## 9. 评审 Backlog

> 自审（multi-lens-review）结果、修复对照、终审意见在此追加。

### 与既有记录的对照（2026-09-30，防误读）

| 引用 | 关系 |
|---|---|
| PRD §16「--yes 跳过执行计划确认 | 已关闭（伪需求）」 | **不同源**。link 直通本无确认环节，`--yes` 无意义故关闭；umd 的逐库确认是用户明确要求的内建环节（S15 裁决 2/3），`--yes` 是脚本 / CI 的非交互出口。不冲突。 |
| PRD §2 行 31「包发布 / 版本管理 / changelog（未来子域）」 | umd 是版本管理子域第一步；范围仅「消费方声明版本更新」，不含发布 / changelog（S15 非目标已划界）。 |
| S13 §1.3「不扩展 LastRunTrace.command：init/uninit 不写留痕」 | umd 与 init/uninit 不同族：umd 改写 manifest + 跑 install、有失败收敛语义（与 link/unlink/repair 同），故写留痕并扩展联合（S15 裁决 10）。 |

### multi-lens-review 自审（2026-09-30，场景 B 技术方案：六手法 + 架构师/资深开发/资深测试/交付运维面板）

**结论**：1 盲点（P1）+ 5 优化（P2）。最危险项 = U-1——install 失败/中断后「重跑 umd 收敛」的误导建议，且被复制到三处**互相一致地错**（手法 3 跨章节矩阵的价值正在于此：三处同错是系统性错误，不是笔误）。

| # | 级别 | 来源透镜 | 问题 | 处置 |
|---|---|---|---|---|
| U-1 | P1 盲点 | 手法 1（中断恢复）+ 手法 3（跨章节矩阵） | install 失败后 package.json 已改，重跑 umd 判定全部 current → 不触发 install，node_modules 残留旧版；spec 三处（§3 ⑩ / §4.7 / §5 U3）一致写着「重跑 umd 幂等收敛」 | **已修**：三处改为「直接在 workspace 根重跑 install 命令」（版本号已写入，语义已定；重跑 umd 不会触发安装）；修复后手法 3 重跑确认三处一致、同族扫描（link/unlink 有 state 兜底不受影响）零新增 |
| U-2 | P2 | 手法 3（引用×定义） | §4.5 完成提示硬编码 `pnpm install --no-frozen-lockfile`，与 `buildInstallCommandLine(pm)` 动态语义冲突（第二真相风险） | 采纳 → §4.5 加注「install 命令串动态生成，不允许硬编码 pnpm」 |
| U-3 | P2 | 手法 5（假设显式化） | 版本查询走 npm view（npm registry 视角）、安装走检测 PM（pnpm registry 视角）——npm 与 PM 配不同 registry 时两源不一致，未显式记录 | 采纳 → §8 自决 11 显式化 + 触发信号（真实踩中再按「以检测 PM 的 view/info 查询」迭代） |
| U-4 | P2 | 手法 5（决策隐含假设） | 并发双 umd 同跑未定义（原子写 + pnpm 锁基本兜底，与 link 同级别风险） | 候选 → 触发信号：实际发生 ≥ 1 次 |
| U-5 | P2 | 手法 4（输入枚举） | libs 空 key 等脏配置 → findDependents 静默零命中 | 候选 → 触发信号：实际发生（lpm link 注册写入侧已防非空 key） |

**自洽确认区（攻过但没攻破）**：
- 手法 1 幂等/交叉：umd→umd（bump 后 current 跳过）；umd→link→umd（state.links 整库跳过）；umd→link→unlink→umd（unlink 还原的正是 bump 后的版本 → current）；非 lpm 手动 link → local-protocol 单点跳过。全走通。
- 手法 2 字段审计：**零新增持久化字段**（只写 package.json 与 last-run.json 既有面；`approved` Set 为内存级，无生命周期残留）。
- 手法 6 可逆性：改 package.json + install 均可逆（git + 重装），逐库确认策略与可逆性一致；无不可逆操作。
- 角色面板：架构师（remote/upgrade/umd 三单元职责各一句话可述、错误传播明确）；资深测试（upgrade 纯函数矩阵 + 复用既有 rewrite golden，验收标注清楚）；交付运维（last-run.json 诊断入口 + git 回滚路径齐备）。

**收敛判定**：第 1 轮六手法全过 = 1 P1 + 5 P2；修复后第 2 轮（手法 3 重跑 + 同族扫描）零新增 P0/P1，修复未引入新结构；P2 仅记录不阻塞 → 判定收敛（第 3 轮边际收益骤降，按收敛协议停）。

### 待评审点（实现前需确认）

1. **「落后」定义只覆盖「声明装不到最新」**（裁决 1）：`^1.0.0` 且已装 `1.0.0` 不算落后——若用户期望 umd 也处理「已装滞后」（改走 `pm update` 而非改声明），需在此追加一个 `--update` 语义，超出当前范围（S15 非目标）。
2. **同文件同包多段判定不一致 → 整文件跳过**（§4.3）：安全优先；若评审认为应「逐段处理」，需扩展 `rewriteDepValue` 支持按段替换（超出现有引擎能力，成本高，倾向保持跳过 + 提示）。
3. **计划预览渲染**（§8 自决 5）：复用 `renderPlan` vs 私有打印。
