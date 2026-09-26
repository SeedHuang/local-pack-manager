# S3 · PM 检测与 use 设计文档（spec）

- 日期：2026-09-25
- 状态：待评审
- 路径归类：superpowers architectural（lpm 子项目 spec，S2 的下游）
- 上游：PRD §7 use 行 / §9.1 / §11 / §12 / §14-S3 / §15；S1 spec §4.3（冻结签名）、§4.4（config 读写签名）、§3（分层规则）；S2 spec §8（lockfile 探测以根为基准）
- 依赖：S1、S2（已完成，`pnpm verify` 全绿：unit 43 + e2e 5）
- 评审提示：三个关键裁决已在 brainstorming 拍板（§2 前三行），剩余 7 个小决策点在 §9

## 0. 流程注记与要素映射

- 位置与结构：沿用 S1/S2 确立的 superpowers 默认（`docs/superpowers/specs/`、问题 → 方案权衡 → 架构 → 组件 → 数据流 → 错误处理 → 测试）
- **与 S1 演进约定的衔接（S1 §4.6）**：`core/pm.ts` stub → 实现；`state/index.ts` 两函数提前实现（S4 范围缩减，回写义务见 §4.7）；`cli.ts` use 命令接线替换 stub；公共 API 新增仅 §4.3 所列，冻结签名零改动
- **分层规则重申（S1 §3）**：`core/*` 运行时不依赖 `state/*`——`resolvePackageManager` 以参数注入 config 设定值，保持 core 纯净
- PRD §14 五要素映射：目标→§1；交付物→§4.1；接口定义→§4.2–4.6；测试清单→§7.1–7.2；验收标准→§7.4
- **计划期修订（2026-09-25，writing-plans 自审发现，随 plan 评审一并确认）**：① §4.3 增补导出 `subdivideYarn`（§4.5 步骤 1 的 yarn 细分机制需对命令层可见）；② §4.5 步骤顺序精化——幂等判定前置于冲突判定，冲突确认只发生在有实际写入时（否则出现"确认后无操作"的荒谬路径）；③ §7.2 增补 resolvePackageManager / lockfile 优先于字段 / WorkspaceNotFound 用例

## 1. 问题与目标

**问题**：S6 起 lpm 要以确定的 PM 执行 install，协议映射（pnpm→`link:` / npm→`file:` / yarn→`link:`·`portal:`）也随 PM 而定。PM 的信号散落三处且强度不同：lockfile（现实，最强）、package.json 的 packageManager 字段（corepack 标准声明，意图）、workspace 清单（间接——仅 `pnpm-workspace.yaml` 可辨，npm/yarn 清单同形必须靠 lockfile 区分，PRD §7 定版）。S1 冻结了 `detectPackageManager` stub，S3 填充为真实现，并交付 `lpm use` 命令（显式设定 + 冲突防护 B2）。

**目标**：

1. `detectPackageManager`：三级推断（lockfile > packageManager 字段 > workspace 清单），yarn 细分 berry/classic，歧义/无证据明确报错（含下一步动作）
2. `lpm use <pnpm|npm|yarn>`：显式设定写入 `lpm.config.json`；与现有 lockfile 冲突 → 警告并确认（承接 PRD review 修复 B2 / §11"警告并确认"）
3. 裸 `lpm use`：自动推断 + 展示依据，不落盘（PRD §9.1 仅"显式设定后写入"）
4. `resolvePackageManager`：显式设定优先、未设定走推断——S6 的唯一 PM 消费入口
5. config 读写两项提前实现（`readProjectConfig`/`writeProjectConfig`，含原子写 helper），S4 范围缩减
6. 全程可测：检测纯逻辑 golden 用例 + 命令行为 e2e；依赖零新增

**非目标**（S3 不做）：

- install 执行与安装参数（`--no-frozen-lockfile` 等，S6）
- 协议映射实现（`mapProtocol`，S5；S3 只产出 `PackageManagerId`）
- "首次任何命令未设定则询问"的跨命令引导钩子（S9 交互层；S3 交付 use 本命令与 resolve 函数原语）
- lockfile 内容解析（仅存在性判定 + yarn.lock 头部 `__metadata` 标记，见 §4.4）
- bun/deno 等其他 PM 的识别（corepack 字段未知名跳过，§4.4）
- config 深层 schema 校验（S4 深化；S3 只做 JSON 解析与对象判定）

## 2. 方案权衡

| 决策点 | 定版 | 被否选项与理由 |
|---|---|---|
| "packageManager 字段"语义 | **package.json 的 corepack 字段**（如 `"pnpm@12.6.0"` / `"yarn@4.1.0"`）；lpm.config.json 的设定**不参与检测阶梯**——显式设定在实际执行（S6 install）时优先于检测结果，冲突警告只在 use 时发生一次 | config 设定字段参与检测 rank 2：显式设定会被 lockfile 压过（`lpm use pnpm` 后项目仍有 package-lock.json 时检测结果仍 npm），与"冲突警告"条款语义重叠；且检测被迫依赖 S4 未就位的读取层。生态惯例（corepack / 主流检测工具均为 lockfile > corepack 字段 > 清单） |
| S3/S4 边界 | **S3 按冻结签名提前实现 `readProjectConfig`/`writeProjectConfig`**（含原子写 helper），S4 范围缩减为 state/last/user config/gitignore | 调序先 S4 后 S3：偏离本次"S3 直达"指令，且 S4 的 use 无关部分先行；use 不落盘：违反 PRD §9.1"显式设定后写入"定版语义 |
| 冲突处理（B2） | **clack confirm（TTY）**；拒绝/取消 → "已取消，未变更"退出 0；**非 TTY → 直接拒绝执行**并报错退出 1（安全侧） | 直通报错不确认：比 PRD §11"警告并确认"多一层硬门槛，丢失终端下的低摩擦确认；仅警告不确认：弱于 PRD 定版 |
| yarn 细分实现 | `.yarnrc.yml` 存在 → berry；否则读 yarn.lock **头部 4KB** 含 `__metadata` → berry；否则 classic（PRD §7 字面） | 全文读 yarn.lock：大仓 lock 可达 MB 级；berry 格式的 `__metadata` 恒在文件头部，头部读足够 |
| 检测证据返回 | 新增 `detectPackageManagerDetailed` 返回 `{pm, evidence}`；冻结的 `detectPackageManager` 保留为其单行包装 | 改冻结签名塞证据：S1 §4.3 不得改动；use 层自行重收集：检测逻辑双份漂移 |
| 测试 fixture | **临时目录运行时自建**（信号文件均为空壳或单行，构造即建） | 提交 fixtures 树：S2 因清单/golden 复杂才提交；S3 信号文件无重样本价值，建树无增益 |
| use 参数面 | commander `.choices(['pnpm','npm','yarn'])`；yarn 细分自动（口径同检测）；不开放 `yarn-classic`/`yarn-berry` 显式 token（PRD 定版三 token） | 开放四 token：超出 PRD 命令面，YAGNI；自由 string 自校验：重复 commander 能力 |

## 3. 架构

```
cli.ts（use 特判接线，其余命令维持 stub 循环）
   └─ commands/use.ts          # S3 新增：use 命令行为（编排层：root 定位、冲突判定、confirm、输出、落盘决策）
        ├─ core/pm.ts          # S3 填充：detectPackageManager / detectPackageManagerDetailed / resolvePackageManager / 2 错误类
        └─ state/index.ts      # S3 提前填充：readProjectConfig / writeProjectConfig（其余 stub 不动）
             └─ state/atomic.ts # S3 新增：原子写 helper（S4 复用）
```

- 依赖方向：`commands/use.ts` → `core/pm.ts` + `state/index.ts`（命令是唯一编排层）；`core/pm.ts` 不 import `state/*`（S1 §3 分层规则，config 设定值经参数注入）；`state/*` 不 import `core/*`
- `cli.ts` 接线：registry 循环内特判 `meta.name === 'use'` → 注册 `.argument('<pm>')` + `.choices` + 真实 action（description 不再带"计划 S3"后缀）；命令名单与顺序不变（`program.test.ts` 契约保持）
- `state/atomic.ts`：临时文件 + rename（PRD §9 崩溃安全）；S4 的 state/last/user 写入复用同一 helper

## 4. 组件与接口

### 4.1 文件清单（交付物）

```
src/core/pm.ts                   # S1 stub → 实现：检测逻辑 + 2 错误类 + resolve
src/commands/use.ts              # 新增：use 命令行为
src/state/index.ts               # S1 stub → readProjectConfig/writeProjectConfig 提前实现 + LpmConfigParseError
src/state/atomic.ts              # 新增：原子写 helper
src/cli.ts                       # use 特判接线
tests/unit/pm.test.ts            # 检测 golden（§4.4 契约 ↔ 用例双向映射）
tests/unit/use-command.test.ts   # use 行为（confirm 以 vi.mock('@clack/prompts') 注入）
tests/unit/config-io.test.ts     # config 读写 + 原子写
tests/unit/state-stub.test.ts    # 更新：readProjectConfig 移出 stub 断言（readState 等其余保留）
tests/e2e/cli.e2e.test.ts        # 更新：新增 use 真实行为用例（含非 TTY 冲突路径）
```

### 4.2 冻结签名（S1 §4.3 原文，S3 实现不得改动）

```ts
export type PackageManagerId = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry'
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId>
```

### 4.3 新增导出

```ts
// src/core/pm.ts —— 错误类（均 extends Error，name = 类名）
export class PMAmbiguousError extends Error {
  // found = 发现的 lockfile 文件名数组，固定顺序 pnpm-lock.yaml → package-lock.json → yarn.lock
  constructor(public found: string[], message: string)
}
export class PMUnresolvedError extends Error {}

// 证据模型（use 展示用）
export type PMEvidence =
  | { kind: 'lockfile'; file: string }
  | { kind: 'corepack-field'; value: string }
  | { kind: 'workspace-manifest'; file: 'pnpm-workspace.yaml' }
export interface DetectResult { pm: PackageManagerId; evidence: PMEvidence }

// 详细检测（真身）；detectPackageManager = (await detectPackageManagerDetailed(rootDir)).pm 单行包装
export async function detectPackageManagerDetailed(rootDir: string): Promise<DetectResult>

// yarn 细分（§4.4 a/b/c 口径；lockfile 级命中 yarn.lock 与显式 lpm use yarn 共用）：
// .yarnrc.yml 存在 → yarn-berry；否则 yarn.lock 头部 4KB 含 __metadata → yarn-berry；
// 否则（含 yarn.lock 缺失/读取失败）→ yarn-classic
export function subdivideYarn(rootDir: string): 'yarn-classic' | 'yarn-berry'

// S6 唯一消费入口：显式设定优先，未设定走推断
export type PMResolution =
  | { source: 'config'; pm: PackageManagerId }
  | ({ source: 'detected' } & DetectResult)
export async function resolvePackageManager(
  rootDir: string,
  configPM: PackageManagerId | undefined,   // 调用方读 config 后注入（core 不依赖 state）
): Promise<PMResolution>

// src/state/index.ts —— 错误类（领域错误随使用模块落地，S2 先例）
export class LpmConfigParseError extends Error {
  constructor(public configPath: string, message: string)
}

// src/state/atomic.ts —— 原子写 helper
export function writeJsonFileAtomic(filePath: string, value: unknown): void
```

`resolvePackageManager` 契约：`configPM` 为四值之一 → `{source:'config', pm}`，不做任何探测；`configPM` 为 undefined 或运行时越界值（如手改 config 混入脏值）→ 按"未设定"处理走推断（宽容，深层校验归 S4）。

### 4.4 detectPackageManagerDetailed 行为契约（逐条）

探测基准：**rootDir 本层，不向上**（S2 §8：lockfile 探测以根为基准）。

```
detectPackageManagerDetailed(rootDir):
  1. lockfile 级：探测 rootDir 下三文件存在性（不读内容）
     - pnpm-lock.yaml → pnpm；package-lock.json → npm；yarn.lock → yarn（待细分）
     - 命中恰好一个：
         pnpm / npm → 返回 evidence {kind:'lockfile', file}
         yarn → yarn 细分（见下）后返回
     - 命中 ≥2 → PMAmbiguousError(found=[按 pnpm→npm→yarn 固定顺序的文件名])
  2. corepack 字段级：读 rootDir/package.json 的 packageManager 字段
     - package.json 缺失 / 读取失败 / JSON 坏 / 字段缺失 / 字段非 string → 视为无信号，继续
       （检测器宽容：宁 unresolved 不误报）
     - 字段格式 <name>@<version>（容许 +sha… 后缀）：按第一个 '@' 切分 name 与 version
         name === 'pnpm' → pnpm；name === 'npm' → npm
         name === 'yarn' → version 主版本号可解析且 ≥2 → yarn-berry；否则 yarn-classic
         name 其他（bun/deno/…）或切分失败 → 视为无信号，继续
     - 命中 → 返回 evidence {kind:'corepack-field', value: 字段原文}
  3. 清单级：rootDir/pnpm-workspace.yaml 存在 → pnpm，evidence {kind:'workspace-manifest'}
     （package.json workspaces 字段不作为信号——npm/yarn 同形不可辨，PRD §7 定版）
  4. 全无 → PMUnresolvedError
```

yarn 细分（lockfile 级命中 yarn.lock，或显式 `lpm use yarn` 时）：

```
  a. rootDir/.yarnrc.yml 存在 → yarn-berry
  b. yarn.lock 头部 ≤4096 字节含 "__metadata" → yarn-berry
  c. yarn.lock 读取失败 / 无标记 → yarn-classic（PRD"否则 classic"字面）
```

### 4.5 use 命令行为契约

注册：`lpm use [pm]`，`.choices(['pnpm','npm','yarn'])`——非三值 → commander 报错退出 1（沿用未知命令退出码契约）。

rootDir 定位：`findWorkspaceRoot(process.cwd())`（S2 产出；实现签名 `runUse(pm?, cwd = process.cwd())`，cwd 参数化仅供单测注入，行为不变）；`WorkspaceNotFoundError` → stderr + 退出 1（S2 文案）。

**显式 `lpm use <pm>`**：

```
1. readProjectConfig(rootDir)；yarn 指定 → 以 subdivideYarn(rootDir) 得目标 id（§4.4 细分口径，无任何 yarn 证据 → classic）
2. 幂等：config.packageManager 已 === 目标 id（含 yarn 细分后的具体值）→ 「包管理器已设定为 <id>」退出 0，不写
   （幂等前置——冲突确认只发生在有实际写入时，计划期修订 ②）
3. 冲突判定（B2 口径，决策点 2）：指定 PM 对应的 lockfile 是否存在于 rootDir
   - 对应关系：pnpm↔pnpm-lock.yaml；npm↔package-lock.json；yarn↔yarn.lock
   - 指定 PM 的 lockfile 存在 → 无冲突（含多 lockfile 共存：自家 lockfile 即证据支持）
   - 指定 PM 的 lockfile 不存在，且其他 lockfile 存在 → 冲突
   - 无任何 lockfile → 无冲突
4. 冲突 → stderr 警告（列出现有 lockfile 与指定 PM）+ clack confirm「仍要使用 <pm>？」
   - 选择否 / Esc·Ctrl+C 取消 → stdout「已取消，未变更」退出 0
   - 非 TTY（stdin 非 TTY，confirm 无法交互）→ 报错退出 1，文案见 §6.4
5. 写入：cfg = config ?? { version: 1, libs: {} }；cfg.packageManager = 目标 id；writeProjectConfig(rootDir, cfg)
6. 输出 stdout「已设定包管理器：<id>」（步骤 4 确认过 → 附「（与 <lockfile 名> 冲突，已按你的选择继续）」）；退出 0
```

**裸 `lpm use`**：

```
1. readProjectConfig → config.packageManager 有值（含运行时越界值）→ 仅显示「当前设定：<id>」退出 0
   （不跑检测：信息价值低、失败面大——决策点 4）
2. 无设定 → detectPackageManagerDetailed(rootDir)：
   - 成功 → stdout「检测到包管理器：<pm>（依据：<lockfile 名 / 字段原文 / pnpm-workspace.yaml>）」
     + 「如需固化设定：lpm use <pnpm|npm|yarn>」；退出 0，不落盘（PRD §9.1 仅显式写入）
   - PMAmbiguousError / PMUnresolvedError → stderr 错误文案，退出 1
```

### 4.6 config 读写契约（S1 §4.4 提前实现两项）

```
readProjectConfig(rootDir):
  <rootDir>/lpm.config.json 不存在 → null
  存在 → 读 + 剥行首 UTF-8 BOM（规约同 S2 §4.2）+ JSON.parse
    JSON 坏 → LpmConfigParseError（message 含路径 + 下一步动作，§6.5）
    非对象（数组/原始值/null）→ LpmConfigParseError「应为 JSON 对象」（OCR 修复轮 2026-09-25 增补：
      非对象配置会让下游属性赋值/序列化静默失败；深层最小校验（libs 对象 / version）已由 S4 补——
      S4 spec §4.4 规约 5–7，非对象文案统一为「lpm 状态/配置文件」措辞）
    成功 → 返回 as ProjectLpmConfig

writeProjectConfig(rootDir, cfg):
  writeJsonFileAtomic(<rootDir>/lpm.config.json, cfg)
  序列化：JSON.stringify(cfg, null, 2) + '\n'；LF；无 BOM
```

原子写 helper 契约（`writeJsonFileAtomic`）：

```
1. tmp = <filePath>.<pid>.<uuid>.tmp（同目录保证 rename 同盘；pid 防双终端并发互踩 + uuid 防同进程并发互撞
   ——PRD §9 动机 + S4 T1① 强化，uuid 实际覆盖 worker_threads 共享 pid 场景）
2. 完整内容写入 tmp
3. renameSync(tmp, filePath)   # Node 在 Windows 对已存在目标可覆盖（MoveFileEx REPLACE_EXISTING 语义）
失败语义（OCR 修复轮 2026-09-25 增补）：value 序列化为 undefined（如传入 undefined）→ TypeError 不落盘；
写入/rename 失败 → 清理孤儿 tmp 后原错误重抛（防残留 <pid>.tmp 垃圾文件）
```

### 4.7 回写义务（S1 §4.6 演进约定）

- S1 §4.3：`core/pm.ts` 由"stub（S3 填充）"改注"已实现（S3）"
- S1 §4.4：`readProjectConfig`/`writeProjectConfig` 改注"已实现（S3 提前）"；S4 剩余范围 = readState/writeState/deleteState/readLast/writeLast/readUserConfig/writeUserConfig/ensureGitignoreEntry
- S1 §4.5 行为契约表：use 行的 stub 行为（stderr"尚未实现"退出 0）失效，由本 spec §4.5 取代——S1 spec 加注记
- `LpmConfigParseError` 与 `state/atomic.ts` 归入 S4 范围基线（S4 spec 落地时按本 spec 引用，不重复定义）

## 5. 数据流

```
显式 use：cwd → findWorkspaceRoot → readProjectConfig → lockfile 存在性检查
         →（冲突？警告 + confirm）→ writeProjectConfig → 输出
裸 use：  cwd → findWorkspaceRoot → readProjectConfig →（有设定？仅显示）
         → detectPackageManagerDetailed → 输出（不落盘）
S6 消费：readProjectConfig(rootDir).packageManager → resolvePackageManager(rootDir, configPM)
         → pm → mapProtocol(S5) / install 命令构造(S6)
```

## 6. 错误处理（逐条，全部含下一步动作——PRD §11）

| # | 场景 | 行为与退出码 | 文案关键片段 |
|---|---|---|---|
| 1 | 多 lockfile 共存（裸 use / resolve 推断路径） | `PMAmbiguousError` → stderr，退出 1 | 「检测到多个 lockfile（<found 逗号列出>），包管理器判定歧义。请手动指定：lpm use <pnpm\|npm\|yarn>」 |
| 2 | 无任何证据 | `PMUnresolvedError` → stderr，退出 1 | 「无法推断包管理器（未发现 lockfile、packageManager 字段或 pnpm-workspace.yaml）。请手动指定：lpm use <pnpm\|npm\|yarn>」 |
| 3 | 显式 use 与 lockfile 冲突（TTY，拒绝/取消） | 警告 + confirm；取消 → stdout「已取消，未变更」，退出 0 | 「…与现有 lockfile 冲突…仍要使用 <pm>？」 |
| 4 | 同上（非 TTY） | 报错退出 1 | 「与现有 lockfile 冲突，且当前环境无法交互确认。请改在终端运行，或先移除冲突 lockfile」 |
| 5 | config 坏 JSON / 非对象 | `LpmConfigParseError` → stderr，退出 1 | 「<路径> 不是合法 JSON（<原因>）」/「<路径> 不是合法的 lpm 状态/配置文件（应为 JSON 对象）」（S4 统一措辞），均含「可修复或直接删除该文件——lpm 状态可抛弃重建」 |
| 6 | 幂等设定 | 「包管理器已设定为 <id>」，退出 0，无写入 | — |
| 7 | corepack 字段含未知 PM 名（bun 等）/解析失败 | 跳过该信号继续后续级（非错误） | — |
| 8 | yarn.lock 读失败且无 .yarnrc.yml | 按 yarn-classic（PRD"否则 classic"字面） | — |
| 9 | cwd 不在任何项目内 | `WorkspaceNotFoundError` 传播 → stderr，退出 1 | S2 文案（请在项目目录内运行） |

## 7. 测试与验收

### 7.1 分层

- unit：core/pm 检测 golden（临时目录自建信号文件）；config 读写与原子写；use 行为（`vi.mock('@clack/prompts')` 注入 confirm 结果，TTY 分支在 unit 层覆盖）
- e2e：spawn `node dist/cli.js`，临时目录作 cwd（S1 模式）；**confirm 路径不进 e2e——spawn 即非 TTY，恰好实证 §6.4 非 TTY 拒绝分支**

### 7.2 unit 清单（每条 §4.4 契约至少一正一反）

pm.test.ts：

1. 单 pnpm-lock.yaml → pnpm；单 package-lock.json → npm；单 yarn.lock → 细分路径
1b. lockfile 优先于 corepack 字段：pnpm-lock.yaml + packageManager 'npm@x' → pnpm
2. yarn 细分：.yarnrc.yml 存在 → berry；无 .yarnrc.yml + yarn.lock 头部含 `__metadata` → berry；两者皆无 → classic；yarn.lock 头部无标记（标记若在 4KB 外不触发）；yarn.lock 为目录（读失败 EISDIR，可构造）→ classic（§6.8）
3. 多 lockfile 组合（pnpm+npm / pnpm+yarn / npm+yarn / 三全）→ `PMAmbiguousError`，断言 found 内容与固定顺序
4. corepack 字段：pnpm@x → pnpm；npm@x → npm；yarn@1.22 → classic；yarn@4.1 → berry；yarn@4.1+sha → berry；bun@x / 非 string 字段 / JSON 坏 / package.json 缺失 → 无信号继续
5. pnpm-workspace.yaml 存在（无 lockfile 无字段）→ pnpm
6. 仅 package.json workspaces 字段、无其他信号 → `PMUnresolvedError`
7. 全空目录 → `PMUnresolvedError`
8. rootDir 不向上探测：子目录放置 lockfile 不影响 rootDir 层结果
9. `detectPackageManager` 与 `detectPackageManagerDetailed` 结果一致
9b. `resolvePackageManager`：configPM 为四值之一 → `{source:'config'}` 且不做任何探测（空目录也成功）；undefined / 运行时越界值 → 走推断路径
9c. §6.9：cwd 不存在 → `runUse` 捕获 `WorkspaceNotFoundError`（start-dir-missing）→ 退出 1 + stderr（S2 文案「路径不存在」）

use-command.test.ts：

10. 显式设定写 config（config 缺失时新建 `{version:1, libs:{}}`）；`use yarn` 按细分口径写入 classic/berry
11. 幂等：已设定同值 → 不写（config mtime/内容不变）退出 0
12. 冲突（TTY，confirm mock）：拒绝 → 「未变更」退出 0 且不写；同意 → 写入且输出含冲突回显；非 TTY → 报错退出 1
13. 裸 use：有设定 → 仅显示设定；无设定检测成功 → 显示依据不落盘；歧义/无证据 → 错误退出 1

config-io.test.ts：

14. roundtrip（写后读一致）；缺失 → null；坏 JSON → `LpmConfigParseError`（断言 message 含路径与"可抛弃重建"）
15. 原子写：写后无 `*.tmp` 残留；目标已存在覆盖成功；格式（2 空格缩进 + 尾随 `\n` + 无 BOM）
16. 读容忍 BOM（带 BOM 的合法 config 可解析）

### 7.3 e2e 清单（temp cwd）

17. `use pnpm`（pnpm-lock 存在）→ exit 0，stdout 含「已设定」，lpm.config.json 存在且 `packageManager==='pnpm'`
18. 裸 `use`（pnpm-lock 存在）→ exit 0，stdout 含「检测到包管理器：pnpm」，config 未创建
19. 裸 `use`（package-lock.json + yarn.lock 共存）→ exit 1，stderr 含「歧义」与「lpm use」
20. `use npm`（pnpm-lock 存在 → 非 TTY 冲突）→ exit 1，stderr 含「无法交互确认」，config 未创建
21. `use yarn`（yarn.lock 头部含 `__metadata`）→ config.packageManager === 'yarn-berry'
22. `use abc` → exit ≠ 0（commander choices 拒绝）
23. 既有 e2e 五例回归不变（--version / --help / 无参数 / status stub / 未知命令）

### 7.4 验收标准

1. `pnpm verify` 全绿（typecheck + build + unit 含新增 + e2e 含新增），本机 Windows 通过
2. §4.4 契约逐条 ↔ pm.test.ts 双向映射齐全（每条至少一正一反）
3. §6 错误表逐条有触发测试（断言错误类型 / 退出码 / 文案关键片段——1–5、8、9 必测；6–7 随行为用例覆盖）
4. S1 §4.3/§4.4 冻结签名逐字一致；公共 API 新增仅 §4.3 所列
5. 依赖白名单不变：运行时依赖恰为 commander / @clack/prompts / execa（零新增）
6. S1 spec 回写完成（§4.7 四条义务）

## 8. 后续衔接

| 消费方 | 依赖的 S3 产出 |
|---|---|
| S5 改写引擎 | `PackageManagerId` → `mapProtocol` 协议选择（link/portal/file） |
| S6 link/unlink | `resolvePackageManager`（唯一 PM 入口）→ install 命令构造 |
| S4 状态层 | `readProjectConfig`/`writeProjectConfig` 已就位；`state/atomic.ts` 复用；S4 范围缩减基线 |
| S9 交互层 | 「首次任何命令未设定则询问」钩子基于 `resolvePackageManager` 语义扩展 |

本 spec 评审通过后：invoke **writing-plans** 出 S3 implementation plan → SDD 逐任务实施（同 S1/S2 流程）。

## 9. 待评审决策点

1. 无任何证据时**报错**（推荐，宁缺勿猜——猜错 PM 的 install 代价远大于一次显式指定）vs 默认某 PM
2. 冲突判定口径：指定 PM **缺自家 lockfile 且存在他类 lockfile**（推荐——共存迁移期自家 lockfile 在即视为支持）vs 存在任何他类 lockfile 即警告（共存期每次 use 都确认，烦）
3. 裸 use **不落盘**（推荐，PRD §9.1"显式设定后写入"字面）vs 推断结果也固化写入
4. 裸 use 已有设定时**仅显示设定、不再跑检测**（推荐，信息价值低失败面大）vs 设定 + 检测结果并显
5. corepack 字段**宽松解析**：未知 PM 名/切分失败 → 视为无信号继续（推荐，宁 unresolved 不误报）vs 严格报错
6. yarn.lock 读失败 → **classic**（PRD"否则 classic"字面）vs 报错
7. use 仅收 `pnpm|npm|yarn` 三 token（PRD 定版），不开放 `yarn-classic`/`yarn-berry` 显式 token
