# S11 登记管理 —— 设计 spec

- 阶段：S11（PRD §14 行 410：**forget 直通（名字/路径）+ 交互化（集成进 link 无参数列表的「管理注册…」）、dir、用户级 config**；依赖 **S4 S6 S9**；PRD 行 417：forget 直通仅依赖 S4 S6，交互化依赖 S9）
- 上级依据：PRD `docs/prds/2026-09-25-lpm-v1-prd.md` §7 行 266–267（`lpm forget` / `lpm dir` 命令面）、§8 行 278–284（link 主列表「管理注册…」子界面）、§9 行 303（用户级 `~/.lpm/config.json` 的 `scanDirs`）、§14 行 410 / 417（S11 行）
- 上游 spec：S9 §4.5（A6 表与主列表组装点——「快捷」组已由 S10 接入，「管理注册…」在「其他…」之后、属 S11）、§4.7（unlink 空态三去向的 forget 行「待 S11 上线」）、§7 行 461（S11 行）；S10 §4.10（虚拟项接入与 `collectionLevel` 传导链）、§7（S11 行）
- 状态：**待用户终审**（PRD §14 行 395：spec 评审通过前不动代码）
- 基线：HEAD `82e29ef`（`git status --porcelain -uall` 仅 1 项未提交 = 本交接词终版文档本身，非代码）；`pnpm verify` exit 0 = typecheck 0 + build + unit **26 文件 / 450 例** + e2e **1 文件 / 33 例**（2026-09-28 实跑）

---

## 1. 目标与非目标

### 1.1 目标

把「注册表管理」补齐成完整闭环——能加注册（link 路径分支隐形注册）、能删注册（forget / 管理子界面）、能管扫描目录（dir），让「不再需要的注册」不再只能靠手改 `lpm.config.json`：

1. **`lpm forget <名字|路径>...` 直通**（PRD §7 行 266）：从项目级 `lpm.config.json` 的 `libs` 移除指定注册；**须先 unlink**（已链接的拦截，绝不悄悄既拆线又删档）；名字/路径两路解析；删除后提示预设影响（**不洗**）
2. **「管理注册…」子界面**（PRD §8 行 279–284，forget 的交互化）：集成进 link 无参数主列表，接在「其他…」之后；已注册列表多选删除 +「按路径删除…」+ `[已链接]` 项拦截提示 + 二次确认 + 删除成功提示；**子界面标题与视觉与主列表明显区分**（加法/减法心智隔离）
3. **`lpm forget` 无参数共用同一子界面**（问 4 裁定）：主形态在 link 列表内，无参数进同一个管理子界面；非 TTY 一行提示
4. **`lpm dir`**（PRD §7 行 267）：`add <路径> / rm <路径> / ls` 直通 + 无参数交互管理，管理用户级 `~/.lpm/config.json` 的 `scanDirs`（S9「扫描发现」与空态向导的同一份数据）
5. **接线出 stub**：`src/commands/registry.ts` 的 forget / dir 两条 `plannedSpec: 'S11'` stub 提示面消失

### 1.2 非目标（明确划界，防范围蔓延）

| 不做 | 归属 / 依据 |
|---|---|
| `forget` / `dir` 的 `--dry-run` | S12「--dry-run 全面化」（PRD §14 行 411）；S10 的 save / preset rm 同族同划界 |
| 预设自动清洗（forget 时把预设里的旧名字一并移除） | 问 3 裁定**不洗**——洗了破坏预设完整性，违背 S10 §4.8「不静默丢用户数据」 |
| 修改任何**已链接**状态（拆线） | forget 只删注册；已链接的拦回去 `lpm unlink`（PRD §8.2 行 281「绝不悄悄既拆线又删档」） |
| `last.json` 的任何改动 | forget 不改链接集；last 里的失效名字由 S10 展开期预检（`link --last` 整批停）既有契约兜底，**不刷** |
| 写 `.lpm/last-run.json` 留痕 | `LastRunTrace.command` 枚举是 S8 冻结面（`link`/`unlink`/`repair`）；`lpm.config.json` 进 git，`git diff` 即留痕（S10 spec §1.2 同口径） |
| 新增状态文件 / 新增运行时依赖 | PRD §14 行 391（技术栈定版）；本 spec 只写**已有**的 `libs` / `scanDirs` 字段 |
| 真 PM（npm / yarn）链路验证 | PRD §12 行 375：实验性 PM 走 smoke 手测清单（归用户） |
| `dir` 的扫描发现增强（深度 ≥ 2 / 白名单） | S9 §8 自决候选（触发信号出现时再评估）；本 spec 只做目录管理 |
| 未知命令模糊纠错 / 错误即建议全局化 | S12；PRD §14 行 411 |

---

## 2. 关键裁决（brainstorming 2026-09-28，4 问全收敛）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | forget 交互化边界 | **子界面为主形态 + `lpm forget <名字\|路径>` 直通快捷等价，两条路都做**。主入口 = link 无参数列表的「管理注册…」（用户无需另记 forget 命令）；直通是快捷等价 | PRD §8 行 279–284；S9 裁决 2（入口 + 子界面 + 直通一并归 S11） |
| 2 | `lpm dir` 命令面 | **全量**：`add <路径> / rm <路径> / ls` 直通 + 无参数交互管理（列出多选删除）；`rm` 按**路径值**删；`add` 校验与 S9 空态向导同口径（绝对 + 存在目录） | PRD §7 行 267 交互列「管理」；S9 §4.7 的 addScanDir 先例 |
| 3 | forget 对预设的影响 | **提示但不洗**：forget 删除时若该名字出现在预设里，逐行提示「仍在预设 X、Y 里（已失效）」；**不改预设内容** | S10 §4.8「不静默丢用户数据」；S10 §4.4 既有契约（`link --preset` 整批停报错 + 两条修复出路） |
| 4 | 子界面流程与复用 | **删除后回主列表重扫**（重新 `collectLinkCandidates` 一次即即时反映）；`lpm forget` 无参数 TTY **共用同一子界面**；「按路径删除…」**复用 `parsePathInput`**（格式引导同「其他…」）+ 注册表视角的**路径→注册名反查** | S9 §7 行 461（「已注册组」是其数据源）；S9 §4.8 |

---

## 3. 数据流

### 3.1 `lpm forget` 直通（带 targets）

```
lpm forget <名字|路径>...
  ├─ 0. findWorkspaceRoot(cwd) → readProjectConfig(rootDir)   （缺失 → 视为 { version: 1, libs: {} }）
  ├─ 1. 逐个解析 target（名字 / 路径，§4.6）→ 收集要删的 key
  │       名字分支：Object.hasOwn(cfg.libs, key) → 该 key（注册值是否字符串无关——损坏条目可删）
  │       路径分支：路径→注册名反查（§4.6，不 stat）→ 命中 ≥ 1 个 key
  │       解析失败（名字不存在 / 路径无对应注册）→ 报错整批停，零写盘
  ├─ 2. 已链接拦截：readState(rootDir)；任一要删的 key 在 state.links → 报错整批停，零写盘
  │       「先 lpm unlink」——绝不悄悄既拆线又删档（直通 = 遇错即停，S10 同口径）
  ├─ 3. 全部校验通过 → 一次性写盘：writeProjectConfig(rootDir, { ...cfg, libs: next })
  │       next = { ...cfg.libs } 删去各 key；删空 → 保留 libs: {}（§4.4 要点）
  ├─ 4. stdout「已移除注册：<key>，以后想再联调需重新带路径注册」逐行 → exit 0
  └─ 5. 预设提示（§4.4 要点 4，按预设聚合）——成功提示在前、预设提示在后（与子界面 §4.5 同序）
```

### 3.2 「管理注册…」子界面（forget 的交互化）

```
入口 A：link 无参数主列表勾选「管理注册…」→ runLinkInteractive 调 runManageRegistry → 返回后**重读 cfg**（§4.9，P1-5）→ continue 重扫
入口 B：lpm forget 无参数（TTY）→ runForget 直接调 runManageRegistry → 'back' → return 0

runManageRegistry(ctx)
  ├─ 0. scanDirs 内部现读（`(await readUserConfig()).scanDirs`——ctx 不带 scanDirs，见 §4.3 注；子界面只用 registered，scanDirs 仅作 collectLinkCandidates 的必需参数）
  ├─ 1. cand = await collectLinkCandidates(rootDir, ws, cfg, st, scanDirs)   （只读数据源，冻结导出）
  ├─ 2. cand.registered 为空 → 提示「当前没有任何已注册的 lib。用 lpm link <路径> 注册」→ 返回 'back'
  ├─ 3. clack.note 标题（§4.5：减法心智隔离）
  ├─ 4. clack.multiselect 多选：
  │       未链接项 label = 包名 +（hint = 相对路径）
  │       [已链接]项 label = 包名 [已链接] + hint「先 lpm unlink，或改用 lpm unlink」——可勾选但提交后剔除
  │       [注册值损坏]项 label = 包名 [注册值损坏] + hint「修正 lpm.config.json 或删除」——可勾选删除（修脏路径）
  │       「按路径删除…」虚拟项（提交后弹输入）
  ├─ 5. 提交后：
  │       a. 已链接项逐行「⚠️ <key> 当前已链接。先 lpm unlink <key>，或改用 lpm unlink」→ 从删除集合剔除
  │       b. 勾了「按路径删除…」→ clack.text → parsePathInput（3 次重试）→ 每路径反查注册名
  │           命中注册表 → 并入删除集合；未命中 → 「未找到与 <path> 匹配的已注册 lib」不并入
  ├─ 6. 删除集合为空 → 「未选择任何注册」→ 返回 'back'
  ├─ 7. 二次确认：clack.confirm(`删除这 N 个注册？（删除后需重新带路径注册）`, { initialValue: false })
  │       答否 / isCancel → 「已取消」→ 返回 'back'（零写盘）
  ├─ 8. 执行删除：writeProjectConfig 一次（删空保留 libs: {}）→ 逐行「已移除注册：<key>，以后想再联调需重新带路径注册」
  ├─ 9. 预设提示（同直通）逐行
  └─ 10. 返回 'back'（调用方：link 主列表 continue 重扫 / forget 无参数 return 0）
```

### 3.3 `lpm dir`

```
lpm dir add <路径>            lpm dir rm <路径>        lpm dir ls          lpm dir（无参数，TTY）
  ├─ 纯用户级：不定位 workspace            ├─ readUserConfig               ├─ readUserConfig         ├─ 非 TTY → 提示直通用法 + exit 1
  ├─ readUserConfig            ├─ scanDirs 不含该值 → 报错+列当前 ├─ scanDirs 空 → 提示+exit 0  ├─ readUserConfig
  ├─ 校验：绝对 + 存在目录（同 S9）         ├─ 读-改-写移除该值              ├─ 逐行列出（跳非字符串）    ├─ 空 → 提示「用 lpm dir add」+ exit 0
  ├─ 去重后写回                 └─ 「已移除扫描目录：<path>」exit 0      └─ exit 0                 ├─ clack.multiselect 多选删除
  └─ 「已加入扫描目录：<path>」exit 0                                                             ├─ 可逆操作不二次确认（unlink 先例）
                                                                                                └─ 逐行「已移除扫描目录：<path>」exit 0
```

---

## 4. 接口与行为契约

### 4.1 命令面

| 命令 | 形态 | 说明 |
|---|---|---|
| `lpm forget <名字\|路径>...` | 直通（新） | 移除注册；**须先 unlink**；名字/路径两路解析 |
| `lpm forget`（无参数） | 交互（新） | 非 TTY → 一行提示 + exit 1；TTY → 「管理注册…」子界面（§4.5） |
| `lpm dir add <路径>` | 直通（新） | 加入用户级 `scanDirs`（校验同 S9 向导） |
| `lpm dir rm <路径>` | 直通（新） | 按路径值从 `scanDirs` 移除 |
| `lpm dir ls` | 直通（新） | 列出当前 `scanDirs` |
| `lpm dir`（无参数） | 交互（新） | 非 TTY → 一行提示 + exit 1；TTY → 列出多选删除 |

`forget` 用变长 `[targets...]`（与 link/unlink 直通同型；交互是多选，直通多给几个是无害快捷——§8 自决 1）。`dir` 的参数分派全在 `runDir` 内（`[]` / `['add', 路径]` / `['rm', 路径]` / `['ls']`，其它报用法错误），cli 层只做 `[args...]` 透传（preset 先例，便于单测）。

### 4.2 分层与文件

```
src/commands/forget.ts   # 新增：runForget（直通 + 无参数交互入口）+ runManageRegistry（管理子界面，导出供 link.ts）+ ForgetError + reportError
src/commands/dir.ts      # 新增：runDir（分派 + add/rm/ls + 无参数交互）+ DirError + reportError
src/commands/link.ts     # 改动：pickLinkTargets 返回值升级 + 「管理注册…」虚拟项 + runLinkInteractive 对接（动态 import forget.js）
src/commands/unlink.ts   # 改动：空态三去向的 forget 行去掉「（待 S11 上线）」
src/cli.ts               # 改动：forget / dir 从 stub 循环提出来接线
src/commands/registry.ts # 改动：forget / dir 的 plannedSpec 提示面消失
tests/unit/forget-command.test.ts  # 新增
tests/unit/dir-command.test.ts     # 新增
tests/unit/link-interactive.test.ts # 扩展：「管理注册…」项
tests/e2e/cli.e2e.test.ts          # 追加（见 §6）
```

依赖方向：`forget.ts` 静态 import `link.ts` 的 `collectLinkCandidates` / `parsePathInput`；`link.ts` 对 `forget.ts` 用**动态 import**（`await import('./forget.js').runManageRegistry(...)`，勾选「管理注册…」时才加载）——避免 `link ⇄ forget` 静态循环（unlink ⇄ status 的既解先例：unlink 动态 import status）。`dir.ts` 只依赖 `src/state/index.ts`，无环。

写入路径单源不变：项目级配置一律 `writeProjectConfig`（原子写）；用户级配置一律 `readUserConfig` / `writeUserConfig`（原子写）；候选列表走 `collectLinkCandidates`。

### 4.3 公共 API 面

**冻结面零改动**：S1–S10 所列公共 API **签名不变**；`runLink` / `runUnlink` 形参不变；`LinkOptions` 不扩字段；`LinkArgumentError` 构造器保持冻结签名。`collectLinkCandidates` / `parsePathInput` / `resolveTarget` 等 S9 §4.3 冻结导出**只消费不改**。

```ts
// ── src/commands/forget.ts（全部新增）──
/** forget 相关错误（命令域；沿用「错误类归命令文件」先例） */
export class ForgetError extends Error

/** 管理子界面的上下文（link 主列表与 forget 无参数入口共用） */
export interface ManageRegistryCtx {
  rootDir: string
  cwd: string
  ws: Workspace
  cfg: ProjectLpmConfig | null
  st: LinkState | null
}

/** 「管理注册…」子界面（forget 的交互化）。正常流程一律返回 'back'（调用方：
 *  link 主列表 → continue 重扫；forget 无参数 → 当 0 处理）。错误抛 ForgetError / 透传。
 *  注：ctx **不含 scanDirs**——子界面内部 `readUserConfig()` 现读（子界面只用
 *  `collectLinkCandidates` 的 registered 部分，scanDirs 仅是函数必需参数；自审 P1-7）。 */
export async function runManageRegistry(ctx: ManageRegistryCtx): Promise<'back'>

/** `lpm forget` 入口：[] → 非 TTY 提示 / TTY 进子界面；[targets...] → 直通删除。返回退出码（0/1） */
export async function runForget(targets: readonly string[], cwd?: string): Promise<number>

// ── src/commands/dir.ts（全部新增）──
export class DirError extends Error
/** `lpm dir` 入口（分派在内部，便于单测）：[] → 交互；['add', 路径] / ['rm', 路径] / ['ls']；其它 → 用法错误 */
export async function runDir(args: readonly string[], cwd?: string): Promise<number>

// ── src/commands/link.ts（唯一改动面：非导出的 pickLinkTargets）──
// 返回值在 S10 的 { targets, collectionLevel } 之上扩展为联合类型（**未退回 string[]**）：
type PickLinkResult =
  | { kind: 'link'; targets: string[]; collectionLevel: boolean }   // S10 形态（新增 kind 字段）
  | { kind: 'manage' }                                             // 勾选「管理注册…」→ 转向管理
  | typeof CANCELLED
```

**错误传播契约**：

- `forget.ts` 内建 `reportError`：`KNOWN` = `ForgetError` + `WorkspaceNotFoundError`（`findWorkspaceRoot`）+ `LpmConfigParseError`（`readProjectConfig`）+ `LpmStateParseError`（`readState`）；**其余 rethrow**（与 link/unlink/preset 同口径）
- `dir.ts` 内建 `reportError`：`KNOWN` = `DirError` + `LpmStateParseError`（`readUserConfig` / `writeUserConfig` 分域）；**其余 rethrow**；`dir` 不定位 workspace，无 `WorkspaceNotFoundError` 面
- 写盘失败（`writeProjectConfig` / `writeUserConfig` 的 fs 失败）一律 **rethrow**，由 commander 兜底非零退出（S10 R2-2 同口径：§4.3 总则优先于任何「包装成命令域错误」的措辞）

### 4.4 `lpm forget` 直通契约

**解析（两路，共用一个内部函数 `resolveForgetKey`）**：

| 输入形态 | 判定 | 结果 |
|---|---|---|
| 名字（`Object.hasOwn(cfg.libs, raw)`） | 直接命中 | key = raw（注册值是否字符串无关——**损坏条目可删**，修脏路径） |
| 路径（其余：含 `/` 或 `\` 或 `.` 开头或绝对） | 路径→注册名反查（§4.6） | 命中 ≥ 1 → 全部 key；命中 0 → `ForgetError` |
| 名字与路径都未命中 | — | `ForgetError`：「注册不存在：<raw>。已注册：a、b」（无注册 → 「当前没有任何已注册的 lib。用 lpm link <路径> 注册」） |

**判定顺序（直通，遇错即停整批、零写盘）**：

1. **解析**：任一 target 解析失败 → 整批停，零写盘
2. **已链接拦截**：任一 key ∈ `state.links` → 整批停，零写盘——`<key> 当前已链接。先 lpm unlink <key> 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档`。判定用 `Object.hasOwn(state.links, key)`（drift 也算已链接：state 有条目即拦）
3. **写盘**：`next = { ...cfg.libs }` 逐个 `delete` → `writeProjectConfig(rootDir, { ...cfg, libs: next })`（读-改-写，不丢未知字段）
   - **删空保留 `libs: {}`**（不能像 preset 删空移除字段——`readProjectConfig` 强制 `libs` 为对象（`{ field: 'libs', kind: 'object' }`），移除字段会让后续任何读配置的命令抛 `LpmConfigParseError`）
4. **预设提示（不洗）**：遍历 `readPresets(cfg).entries`，每预设收集「本次被删且在其中的 key」；命中 ≥ 1 → 该预设打一行
   `⚠️ <key1>、<key2> 仍在预设 <X> 里（已失效）——lpm link --preset 会整批报错；可 lpm preset rm <X> 删除该预设`
   - 只查**合法** `entries`；损坏条目（`corrupt`）不读元素，不提示（其 label 已标 `[损坏]`）
   - **不改预设内容**（问 3 裁定不洗）
5. **成功提示**（逐行，PRD §8.2 行 283 文案）：`已移除注册：<key>，以后想再联调需重新带路径注册` → exit 0

要点：

- 不 stat、不改 state、不改 last、不写 last-run 留痕（§1.2）
- 直通**不弹任何菜单**（纯直通；已链接拦截用错误拒绝，不进入交互）
- 名字按键字面匹配（`Object.hasOwn`），不做大小写 / 空白规范化（与 S6 `resolveTarget` 同口径）
- **多 target 解析出的 key 去重（Set 化）**：名字 + 路径指向同一注册（或两个路径指向同一目录）→ 只删一次、只提示一次（§8 自决 9）
- **预设提示按预设聚合**：一个预设含多个被删 key → 该预设只提示一次（§8 自决 9）
- 与 S10 契约对齐：forget 后 `lpm link --preset <含旧名的预设>` 整批停报错 = **既有契约，非缺陷**（S10 §4.4）；`--last` 同理

### 4.5 「管理注册…」子界面契约

**主列表接入（link.ts）**：

- `pickLinkTargets` 的 groups 追加「管理注册…」项（在「其他…」之后），哨兵 `'\u0000__manage__'`（NUL 前缀，沿用 `OTHER_OPTION` / S10 哨兵惯例）
- 出现条件：`cand.registered.length > 0`（无注册时进管理无意义，且与「全部已注册（N）N≥1 才出现」同规则）；label = `管理注册…`，hint = `删除 lib 注册（已链接的请先 unlink）`
- **勾选集合含「管理注册…」→ 返回 `{ kind: 'manage' }`，忽略其它勾选项**（管理是流程转向，不混入链接意图）；该哨兵**本身不是最终 target**
- 返回值在 S10 形态上扩展（§4.3），`collectionLevel` 契约不变（管理不是集合级链接入口，不涉及 last 传导）

**子界面行为（runManageRegistry）**：

- **数据源**：`collectLinkCandidates(rootDir, ws, cfg, st, scanDirs).registered`（冻结导出；含 `linked` / `cfgIntact` / `hitMembers`）；`scanDirs` 由子界面**内部现读**（`(await readUserConfig()).scanDirs`——ctx 不含该字段，见 §4.3 注）
- **标题与视觉区分（减法心智隔离）**：进入先 `clack.note` 打一个 box：
  `⚠️ 注册管理（减法操作）：删除注册不会取消任何链接；已链接的库请先 lpm unlink`
  （S9 §2 裁决 1 实测 `note`/`box` 的 CJK 逐列对齐可用）
- **列表项**（`clack.multiselect`，不分组）：

| 项 | label | hint | 提交后处理 |
|---|---|---|---|
| 未链接注册 | `包名` | 相对路径 | 并入删除集合 |
| `[已链接]` | `包名  [已链接]` | `先 lpm unlink，或改用 lpm unlink` | **剔除 + 逐行提示**，绝不悄悄既拆线又删档 |
| `[注册值损坏]` | `包名  [注册值损坏]` | `修正 lpm.config.json 或删除（修脏路径）` | 可删（同 preset corrupt 可删精神） |

- **「按路径删除…」虚拟项**（哨兵 `'\u0000__forget_path__'`）：提交后若被勾选 → `clack.text` → `parsePathInput`（格式引导同「其他…」）→ 每路径走 §4.6 反查 → 命中并入删除集合 / 未命中逐条「未找到与 <path> 匹配的已注册 lib。可用 lpm link <路径> 注册」不并入；解析失败重试 ≤3 次（镜像 `promptPaths` 先例）
- **删除集合去重（Set 化）**：勾选项 +「按路径删除…」命中同一 key → 合并，只删一次只提示一次（§8 自决 9）
- **空删除集合**（一个没勾 / 全被已链接剔除）→ 「未选择任何注册」→ 返回 `'back'`（**不弹二次确认**）
- **二次确认**（有后果操作，PRD §8.2 行 282）：`clack.confirm({ message: '删除这 N 个注册？（删除后需重新带路径注册）', initialValue: false })` → 答否 / `isCancel` → 「已取消」→ 返回 `'back'`（**零写盘**）
- **执行**：`next = { ...cfg.libs }` 删各 key → 一次 `writeProjectConfig`（删空保留 `libs: {}`）→ 逐行「已移除注册：<key>，以后想再联调需重新带路径注册」→ 预设提示（§4.4 要点 4，按预设聚合）→ 返回 `'back'`
- **空态**（`registered` 为空）→ 提示「当前没有任何已注册的 lib。用 lpm link <路径> 注册」→ 返回 `'back'`

**返回语义**：正常流程一律返回 `'back'`。调用方：link 主列表 `runLinkInteractive` 的 `for(;;)` 循环里 `continue`（重扫重渲染，子界面删除即时反映）；`lpm forget` 无参数把它当 0。错误抛 `ForgetError` / 透传（由外层 catch / `reportError` 处理）。

**非 TTY**：子界面不可达——link 主列表本身非 TTY 已被拒；`lpm forget` 无参数非 TTY 在 `runForget` 入口拒绝（§4.8）。

### 4.6 路径→注册名反查（注册表视角，不 stat）

```ts
// src/commands/forget.ts（内部，不导出）
function resolveRegisteredNameByPath(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): string[]
```

- 输入 `raw` 归一化为绝对路径：`resolve(cwd, raw)`（相对路径以 cwd 为基准，与 link 直通同口径）
- 遍历 `Object.entries(cfg?.libs ?? {})`：`join(rootDir, ...rel.split('/'))`（注册值是正斜杠相对根路径，与 `resolveTarget` 的名字分支同写法）归一化后与输入绝对路径比较
- **不 stat**（forget 场景目录可能已删/不存在——这恰是 forget 的用途之一；纯路径字符串比较）
- 命中 0 → `[]`（调用方报「未找到匹配注册」）；命中 ≥ 1（两个注册名指向同一目录的手改场景）→ **全部**返回（删除全部命中，提示全部）
- **平台大小写（win32）**：比较用平台归一化——`process.platform === 'win32'` 时比较前两侧 `toLowerCase()`。理由：Windows 文件系统大小写不敏感，但 JS 字符串比较敏感；不做归一化会让 `lpm forget d:\seed\libs` 漏匹配注册值 `D:\Seed\libs`（P2-9）
- 与 `resolveTarget` 的**区别**：`resolveTarget` 的路径分支要求目录存在（`isDirectory`）且只给目录不给注册名——forget 不用它做反查；复用面仅限「名字分支查表」的 `Object.hasOwn` 判定（在 `resolveForgetKey` 内内联）

### 4.7 `lpm dir` 契约

**纯用户级，不定位 workspace**：`readUserConfig` / `writeUserConfig` 是 `~/.lpm/config.json` 的原子读写（S4 已落地）；本命令在任何目录可跑。

| 子命令 | 行为 | 退出码 |
|---|---|---|
| `add <路径>` | 校验：绝对 + 已存在目录（`isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory()`，同 S9 `addScanDir`）→ `readUserConfig` → `scanDirs.includes` 去重 → `writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, dir] })`（读-改-写保留未知字段）→ `已加入扫描目录：<dir>` | 0 |
| `rm <路径>` | `readUserConfig` → 不在 `scanDirs` → `DirError`「扫描目录不在列表中：<path>。可用 lpm dir ls 查看」（空 → 「当前没有任何扫描目录」）→ 移除该值（**按值**，读-改-写）→ `已移除扫描目录：<path>` | 0 / 1 |
| `ls` | `readUserConfig` → 空 → 「当前没有任何扫描目录。用 lpm dir add <路径> 添加」exit 0 → 逐行列出（**跳过非字符串元素** + 一行提示「跳过无效的扫描目录项（非字符串）：…」，S9 §4.9 同族） | 0 |
| （无参数，TTY） | 空 → 提示「用 lpm dir add <路径>」+ exit 0 → `clack.multiselect` 列出多选删除（每项 = 路径；**非字符串元素跳过**）→ 空选中 → 「未选择任何扫描目录」+ exit 1 → 取消 → 「已取消」+ exit 1 → **可逆操作不二次确认**（unlink 先例，PRD §8.3）→ 逐行「已移除扫描目录：<path>」 | 0 / 1 |
| （无参数，非 TTY） | 一行提示「当前不是交互终端；直通用法：lpm dir add <路径> \| rm <路径> \| ls」+ exit 1（零菜单零写盘） | 1 |
| 子命令非法 / `add` `rm` 缺路径 / 多余参数 | 用法错误「用法：lpm dir add <路径> \| rm <路径> \| ls」 | 1 |

要点：

- **读-改-写**：`add` / `rm` / 交互删除都基于 `readUserConfig` 返回的原对象扩展（保留未知字段，S9 §4.9 同族）
- **add 校验失败** → `DirError`「扫描目录必须是已存在的绝对路径：<input>。示例：D:\Seed\libs」
- `scanDirs` 顶层非数组（脏配置）→ `readUserConfig` 抛 `LpmStateParseError` → 透传 exit 1（与 S9 §4.9 读失败透传同口径，不吞）
- **与 S9 空态向导的关系**：向导「添加扫描目录」写的是同一份 `scanDirs`；S11 的 `dir rm` 是它的撤销面（S9 spec §4.4 注），两处共享同一份数据，无第二份真相

### 4.8 非 TTY 与退出码

| 场景 | 行为 | 退出码 |
|---|---|---|
| `lpm forget` 无参数 + 非 TTY | 一行提示含直通用法（`当前不是交互终端；直通用法：lpm forget <名字\|路径>`）+ 零菜单零写盘 | 1 |
| `lpm dir` 无参数 + 非 TTY | 一行提示含直通用法（§4.7）+ 零菜单零写盘 | 1 |
| 子界面二次确认答否 / `isCancel` | `已取消`（返回主列表 / exit） | 1（或返回 `'back'` 由调用方定） |
| 子界面空删除集合 | `未选择任何注册` | 1（返回 `'back'`） |
| 子界面空态（无注册） | 提示 + 返回 `'back'` | 0 |
| forget 直通成功 | 逐行 `已移除注册：…` | 0 |
| forget 直通解析失败 / 已链接拦截 | 报错 + 下一步动作（§5） | 1 |
| dir 各直通成功 | 一行结果 | 0 |
| dir 用法错误 / add 校验失败 / rm 不存在 | 报错 + 用法 | 1 |

> **本表是退出码口径的唯一来源**（§5 为引用）。子界面返回 `'back'` 时，最终退出码由**调用方**决定：link 主列表继续交互（最终由后续流程定）；`lpm forget` 无参数把 `'back'` 当 0。

### 4.9 与既有编排的对接

```
runLinkInteractive（S9/S10 现状 + S11）
  const pre = await linkPreflight(cwd)          // { rootDir, ws, cfg, pm }
  const { rootDir, ws, pm } = pre
  let cfg = pre.cfg                             // ⚠️ 必须是 let（可重读）——子界面删除会写盘 lpm.config.json
  for (;;) {
    const { scanDirs } = await readUserConfig()               // 每次现读（S9 现状）
    cand = collectLinkCandidates(rootDir, ws, cfg, st, scanDirs)
    picked = pickLinkTargets(cand, lastNames)                 // 返回值升级为 PickLinkResult
    picked.kind === 'manage'
      → await import('./forget.js').runManageRegistry({ rootDir, cwd, ws, cfg, st })
      → cfg = await readProjectConfig(rootDir)    // ★ 重读：collectLinkCandidates 用旧 cfg，已删注册仍显示（自审 P1-5）
      → continue                                  //   重扫重渲染（子界面删除即时反映）
    picked.kind === 'link' → runPlanAndExecute(picked.targets, ctx, picked.collectionLevel)   // S10 现状
  }
  // 注：子界面不改 state → st 无需刷新；scanDirs 每次现读 → 唯一需重读的是 cfg

runForget(targets, cwd)
  ├─ targets 空 → 非 TTY 提示 exit 1
  │   TTY → 组装 ctx（findWorkspaceRoot → loadWorkspace → readProjectConfig → readState，
  │          ws 来自 loadWorkspace——collectLinkCandidates 必需，漏了会拿不到已注册组）
  │        → runManageRegistry(ctx) → 'back' → return 0
  └─ targets 非空 → 直通（§4.4）
```

- `executeLinkPlan` / `renderPlan` / `buildLinkPlan` / `collectLinkedItems` 等**一行不改**
- `runLink` / `runUnlink` 签名零改动
- 直通路径（link/unlink 带 target）行为零变化——既有 450 例零改动即判据

---

## 5. 错误表（新增项；既有错误类透传）

| # | 场景 | 文案要点（含下一步动作） | 类 | 退出码 |
|---|---|---|---|---|
| 1 | forget 名字/路径不存在（直通） | `注册不存在：<raw>。已注册：a、b`（无注册 → `当前没有任何已注册的 lib。用 lpm link <路径> 注册`） | `ForgetError` | 1 |
| 2 | forget 已链接（直通） | `<key> 当前已链接。先 lpm unlink <key> 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档` | `ForgetError` | 1 |
| 3 | forget 无参数 + 非 TTY | `当前不是交互终端；直通用法：lpm forget <名字\|路径>` | 非错误（分支） | 1 |
| 4 | 子界面勾了 `[已链接]` 项 | `⚠️ <key> 当前已链接。先 lpm unlink <key>，或改用 lpm unlink`（剔除，其余照常） | 交互内提示 | 不终止 |
| 5 | 「按路径删除…」路径未命中注册 | `未找到与 <path> 匹配的已注册 lib。可用 lpm link <路径> 注册` | 交互内提示 | 不终止 |
| 6 | 子界面路径输入解析失败 | `路径格式无法解析（<原因>）。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号` | 交互内重试（≤3 次） | 不终止 |
| 7 | 子界面二次确认答否 / 取消 / 空删除集合 | `已取消` / `未选择任何注册` | 非错误（分支） | 1（返回 `'back'`） |
| 8 | dir add 校验失败 | `扫描目录必须是已存在的绝对路径：<input>。示例：D:\Seed\libs` | `DirError` | 1 |
| 9 | dir rm 不存在 | `扫描目录不在列表中：<path>。可用 lpm dir ls 查看`（空 → `当前没有任何扫描目录`） | `DirError` | 1 |
| 10 | dir 子命令非法 / 缺路径 / 多余参数 | `用法：lpm dir add <路径> \| rm <路径> \| ls` | `DirError` | 1 |
| 11 | dir 无参数 + 非 TTY | `当前不是交互终端；直通用法：lpm dir add <路径> \| rm <路径> \| ls` | 非错误（分支） | 1 |
| 12 | forget/dir 写盘失败 | 既有 `writeProjectConfig` / `writeUserConfig` 错误 rethrow（§4.3 契约），由 commander 兜底 | rethrow | 1 |

> 退出码口径单源见 §4.8；本表为引用。

---

## 6. 测试清单（取数命令 = `pnpm verify`）

**`tests/unit/forget-command.test.ts`（新，mock `@clack/prompts` + `execa`，stub `process.stdin.isTTY`）**

- 直通名字：正常删 → `cfg.libs` 该键消失、其它键保留、`已移除注册：…` 文案逐字
- 直通路径：输入相对/绝对路径 → 反查命中 → 删对应注册名；**目录不存在也能删**（反查不 stat 的钉）
- 直通两路混用（名字 + 路径）→ 一并删
- **多 target 去重（钉 §8 自决 9）**：名字 + 指向同一注册的路径 → `已移除注册` 只打印一次
- **已链接拦截**：key ∈ state.links → 报错 + **config byte 级零写盘** + exit 1
- **名字不存在** → 报错 + 列出可用 + 零写盘；无注册 → 专属文案
- **删空保留 `libs: {}`**：删最后一个 → `lpm.config.json` 仍含 `libs: {}`（**移除字段会导致 `readProjectConfig` 抛 `LpmConfigParseError`——回归钉**）
- **预设提示不洗**：key 在某预设 → 提示行出现 + **预设内容 byte 级不变**；key 不在任何预设 → 无提示行
- 损坏注册值条目（`cfg.libs[k]` 非字符串）→ 可删（修脏路径）
- 读-改-写：config 含未知字段 → 删除后未知字段保留
- 多 target 全校验通过才写盘：合法 + 已链接混合 → 整批停零写盘（直通 = 遇错即停）
- 无参数交互（TTY）：`collectLinkCandidates` 数据源 → 列表项 `[已链接]` / `[注册值损坏]` 标记 → 多选删 → 二次确认 → 文件更新 + 逐行提示；`[已链接]` 勾选 → 剔除提示其余照常；「按路径删除…」→ 命中并入 / 未命中提示不并入；答否 / `isCancel` / 空删除集合 → `'back'` + 零写盘；空态（无注册）→ 提示 + `'back'`
- 无参数非 TTY → 提示 + exit 1 + 零 clack 调用（S8 exit-13 事故同族回归钉）

**`tests/unit/dir-command.test.ts`（新，mock `node:os` 的 `homedir` → 临时目录，避免污染真实 `~/.lpm`）**

- `add`：正常（写入 `scanDirs`）；**去重**（重复 add 不重复写）；非绝对路径 → 报错；不存在目录 → 报错；读-改-写保留未知字段
- `rm`：正常（按值移除）；不在列表 → 报错 + 列当前；空列表 → 专属文案
- `ls`：逐行列出；空 → 提示 + exit 0；**非字符串元素跳过 + 提示**（脏配置降级）
- 无参数交互（TTY）：列出多选删 → 逐行提示 + 文件更新；空 → 提示 + exit 0；空选中 → exit 1；取消 → `已取消` + exit 1；**不二次确认**（可逆操作钉）
- 无参数非 TTY → 提示 + exit 1 + 零 clack 调用
- 子命令非法 / `add` `rm` 缺路径 / 多余参数 → 用法错误
- 顶层 `scanDirs` 非数组（脏配置）→ 透传 `LpmStateParseError`（不吞）

**`tests/unit/link-interactive.test.ts`（扩展）**

- 主列表「管理注册…」项：`registered > 0` 时出现且位于「其他…」之后；`registered === 0` 时**不出现**
- 勾选「管理注册…」→ 返回 `{ kind: 'manage' }` → 进入子界面（动态 import mock）→ 子界面完成后 `continue` 重扫（第二次 `collectLinkCandidates` 调用出现）
- **重扫拿到新注册表（钉 cfg 重读，自审 P1-5）**：fixture 初始 registered = [a, b]，子界面删 a → 重扫后第二次 `collectLinkCandidates` 的 registered **不含 a**（若实现沿用 preflight 的旧 cfg，此断言必红）
- 勾选「管理注册…」+ 其它项 → **忽略其它项**（只进管理，不混入链接意图）
- 回归：「快捷」组 / 普通项勾选 → 返回 `{ kind: 'link'; targets; collectionLevel }`（S10 的 `targets` / `collectionLevel` 语义**原样保留**，未退回 `string[]`——S10 契约回归钉）

**`tests/e2e/cli.e2e.test.ts`（追加）**

> fixture 前提：forget 的判定位置（findWorkspaceRoot / cfg.libs）在裸目录会先报「未找到项目根」——需真实 workspace fixture（临时目录 + `lpm.config.json` 的 `libs` + 可选的 `.lpm/state.json`）。dir 是纯用户级（不定位 workspace），但**不能污染真实 `~/.lpm`**——e2e helper 不隔离 HOME，故 dir 只测**不写盘**的面（非 TTY 提示 / 用法错误 / 用法错误路径），写路径全归 unit（mock homedir）。

- `lpm forget`（非 TTY，无参数）→ exit 1 + 提示串 + stdout 无菜单残片
- `lpm forget nope`（不存在，workspace fixture）→ exit 1 + 「注册不存在」提示串
- `lpm forget` 已链接（fixture：`state.json` 含该 key）→ exit 1 + 「先 lpm unlink」提示串
- `lpm dir`（非 TTY，无参数）→ exit 1 + 提示串 + stdout 无菜单残片
- `lpm dir bogus`（非法子命令）→ exit 1 + 用法串

**真实终端手测（归用户，非自动化）**

- link 主列表含「管理注册…」项与「管理注册…」子界面（`clack.note` box + 多选列表）的 CJK 对齐 / 长行换行（复用 S9 §2 裁决 1 的三屏手测口径）
- `lpm forget` 直通在真实 TTY 的输出观感

**回归（S11 开工前的 26 文件 / 450 例 + e2e 33 例必须零改动；取数命令 `pnpm verify`）**

- `link-command.test.ts`（39 例）`unlink-command.test.ts`（35 例）`link-collection.test.ts` 零改动 = 直通行为未变的判据
- `link-interactive.test.ts` 既有 29 例除「扩展用例」外零改动（`pickLinkTargets` 返回值形态变化会波及 `{ kind: 'link' }` 解构处——按 §4.9 处理，断言目标不变）

---

## 7. 后续衔接

| 消费方 | 依赖的 S11 产出 |
|---|---|
| S12 引导性打磨 | `forget` / `dir` 的 `--dry-run`；错误即建议全局化会复核本 spec 新增的 12 条文案；forget 直通的「已链接拦截」是「遇错即停」的相邻面 |
| S13 utoopack 适配 | 不受影响（forget/dir 不触碰 install 注入点） |
| 后续候选 | `lpm forget` 直通支持按索引删注册（触发信号：用户表达「想按列表序号删」≥ 2 次）；dir 的扫描发现增强（S9 §8 候选） |

**回滚方案（交付/运维视角）**：本 spec 的两个写盘面都可逆或可恢复——① 注册删除（`lpm.config.json` 的 `libs` 删键）：进 git，`git checkout -- lpm.config.json` 恢复，或用 `lpm link <路径>` 重新注册（后者是正常路径）；② 扫描目录删除（用户级 `~/.lpm/config.json` 的 `scanDirs`）：`lpm dir add <路径>` 随时加回（本 spec §1.2 已把「可逆」作为 dir 交互不二次确认的依据）。没有任何「删了就找不回」的面。

**落地后必须做的「回头扫一遍声明它的地方」**（用户全局规则；与实施同波完成，不得推迟到收口之后）：

1. **`src/commands/unlink.ts` 空态三去向**的 forget 行：`lpm forget  移除 lib 注册（待 S11 上线）` → 去掉「（待 S11 上线）」
2. **S9 spec §4.7 空态**的 forget 行注「待 S11 上线」→ 更新为已上线
3. **S9 spec §1.2 非目标表**「注册管理 → S11」→ 标注已落地
4. **S9 spec §4.5 A6 表 + §3.1 A8 数据流 + §6 测试清单**的主列表描述 → 补「管理注册…」项（顺序：快捷 → 已注册 → 扫描发现 → 其他 → 管理注册…）
5. **S10 spec §4.10 / §7 的 S11 行** → 核对「管理注册…」已接入与 `pickLinkTargets` 返回形态的升级（`{ targets, collectionLevel }` → 联合类型，未退回 string[]）
6. **`src/commands/registry.ts`**：forget / dir 接线后不再走 stub 循环 → 这两条的「计划 S11」提示面消失，检查 `COMMANDS` 残留描述
7. **S9 spec §4.7 的「写盘面」注**（「可手删、也可由 S11 的 `lpm dir rm` 撤销」）→ 核对已由 S11 兑现

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **`lpm forget` 用变长 `[targets...]`**（PRD 字面写单数 `<名字|路径>`）。理由：与 link/unlink 直通同型；交互是多选删除，直通多给几个是无害快捷；若评审要求严格单数，改 cli 接线为 `<target>` 并把 `runForget` 的多 target 分支报用法错误即可（成本一行）。
2. **forget 直通 = 先全部校验通过再一次性写盘**（比 link 直通的「循环中途遇错不回滚」更原子）。理由：forget 的校验（存在性 / 已链接）都是纯内存判定，可前置；删除是有后果操作，能整批零写盘就更谨慎。link 直通的「不回滚」是目录/依赖中途失败场景，forget 无此场景。
3. **子界面 `[已链接]` 项照常显示可勾选、提交后剔除**（不预先 disabled）。理由：与 S9 §8 自决 8/9 同族（保留可见性与解释路径，「为什么不能用」要在界面可见）；clack 无 toggle 回调，拦截落在 label/hint 文本 + 提交后提示。
4. **`lpm dir` 交互删除不二次确认**。理由：扫描目录删除可逆（`dir add` 随时加回），PRD §8.3「可逆操作不二次确认」先例（unlink）；若评审要求与 preset 一致加二次确认，加一个 `clack.confirm` 即可。
5. **「管理注册…」出现条件 = `registered > 0`**（无注册时隐藏）。理由：无注册进管理无意义（子界面也是空态提示）；与「全部已注册（N）N≥1 才出现」同规则。
6. **路径→注册名反查不 stat**。理由：forget 的用途之一就是删掉目录已消失的注册；`resolveTarget` 的路径分支要求目录存在，不适合。
7. **forget 直通多 target 时，已链接拦截整批停**（交互侧是剔除不连累）。不对称与 S10 的失效名字策略同源（直通 = 用户点名遇错即停，交互 = 前置剔除）。
8. **预设提示只查合法 `entries`**（损坏条目不读元素）。理由：`readPresets` 对损坏条目**不读其元素**（S10 §4.7 守卫），提示面遵守同一守卫。
9. **多 target / 混合来源的删除集合 Set 化去重**（直通与子界面同）。理由：名字 + 路径可能指向同一注册、两个路径可能指向同一目录（手改 config）、子界面勾选 +「按路径删除…」可能命中同一 key——去重让删除只发生一次、成功提示与预设提示只出现一次，且「已链接拦截」不会对同一 key 报两遍。代价：无。

---

## 9. 评审 Backlog

### 自审（multi-lens-review，2026-09-28，场景 B 技术方案：六手法 + 架构师 / 资深开发 / 资深测试 / 交付运维面板）

**结论先行**：自审发现 **1 个矛盾（P0）+ 7 个盲点（P1）+ 9 个优化（P2）**，全部当轮修复。**最危险项 = P1-5**：子界面删除注册后返回主列表，若沿用 preflight 的旧 `cfg` 快照重扫，`collectLinkCandidates` 拿到的仍是旧注册表——「删除」在用户眼里像没生效（已删的注册还在列表里，勾选即触发「未知注册名/路径不存在」）。收敛判定详见下方记录。

### 矛盾（P0）

| # | 问题 | 触发序列 / 证据 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | §4.7 的 dir `rm` 文案写「扫描目录不在列表中」而 e2e/unit 的 fixture 若用户级 config 缺失（`readUserConfig` 返回空数组）时，`rm` 应先报「当前没有任何扫描目录」——两种空态文案未统一为单一判据 | 裸环境 `lpm dir rm D:\x` → config 缺失 → scanDirs=[] → 应报「当前没有任何扫描目录」还是「不在列表中」？ | **已采纳**：空态（`scanDirs` 为空）→「当前没有任何扫描目录」；非空但不在 →「不在列表中 + 列出当前」 | §4.7 + §5 #9 |

### 盲点（P1）

| # | 问题 | 触发序列 / 证据 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | **forget 删空后若移除 `libs` 字段，会让 `readProjectConfig` 抛 `LpmConfigParseError`**（`{ field: 'libs', kind: 'object' }` 强校验）——若按 S10 preset 的「删空移除字段」惯例复制到 libs，所有读配置的命令都会崩 | `lpm forget` 删最后一个注册 → 移除 libs 字段 → 下次 `lpm link` / `lpm status` 直接抛「lpm.config.json 的 libs 应为对象」 | **已采纳**：显式立「删空保留 `libs: {}`」契约（§4.4 要点 3 + §8 自决），并加 unit 回归钉 | §4.4 + §6 |
| 2 | **「管理注册…」勾选集合的处理顺序未定义**（与「其他…」弹输入的先后）——若两者都被勾选，谁先？ | 用户同时勾「其他…」和「管理注册…」 | **已采纳**：勾选含「管理注册…」→ **直接转向管理，忽略其它勾选项**（管理是流程转向，不混入链接意图），不进「其他…」弹输入 | §4.5 + §6 |
| 3 | **`runManageRegistry` 的数据源与 `cfg` 在子界面执行删除后的一致性**：删除基于 `ctx.cfg` 的当前值，但子界面停留期间若其它进程改了 `lpm.config.json`（丢失更新） | 双终端同时 forget 不同注册 → 后者覆盖前者 | **已采纳**：与 S10 §8 自决 5 同族——PRD §9 行 306 只承诺原子写防写坏，不承诺防丢更新；读-改-写基线 = 进入子界面时读到的 cfg。触发信号 = 真实发生一次丢失更新（记入 §7 候选） | §4.5 + §7 |
| 4 | **dir 的 e2e 若直接跑写路径会污染真实 `~/.lpm/config.json`**（e2e helper 不隔离 HOME） | `lpm dir add` e2e → 写入真实用户主目录配置 | **已采纳**：dir e2e 只测**不写盘**的面（非 TTY / 用法错误）；写路径全归 unit（mock `node:os` 的 `homedir`） | §6 e2e 前提块 |
| 5 | **子界面删除注册后主列表不反映**：`runLinkInteractive` 的 `cfg` 是 preflight 的 const 闭包，`collectLinkCandidates` 用旧 `cfg` 的 `libs` 组装「已注册组」——「删除后重扫」拿到的仍是旧注册表 | `lpm link`（无参数）→ 进「管理注册…」删掉 `@t/a` → 返回主列表 → `@t/a` 仍在列表里（勾选会触发「未知注册名/路径不存在」） | **已采纳**：`runLinkInteractive` 的 `cfg` 改为可重读（`let`），manage 分支返回后 `cfg = await readProjectConfig(rootDir)` 再 `continue`（唯一需重刷的是 cfg——子界面不改 state、scanDirs 每次现读）；§6 补「重扫 registered 不含已删项」回归钉 | §4.9 + §6 |
| 6 | **`runForget` 无参数交互组装 ctx 需要 `ws`（loadWorkspace）**——`collectLinkCandidates` 必需参数，漏了会拿不到「已注册组」 | 实现者按「forget 只删注册」的直觉只做 findWorkspaceRoot + readProjectConfig + readState，忘 loadWorkspace → 子界面 registered 恒空 | **已采纳**：§4.9 的 `runForget` 无参数分支显式列出 ctx 组装（findWorkspaceRoot → loadWorkspace → readProjectConfig → readState） | §4.9 |
| 7 | **`ManageRegistryCtx` 缺 `scanDirs`，但子界面调 `collectLinkCandidates` 需要该参数**——ctx 与数据源调用签名不自洽（手法 3 复跑发现） | 实现者按 ctx 类型写 `collectLinkCandidates(rootDir, ws, cfg, st, ctx.scanDirs)` → TS 报「属性不存在」或漏参 | **已采纳**：子界面**内部现读** `(await readUserConfig()).scanDirs`（ctx 保持 `{ rootDir, cwd, ws, cfg, st }`；子界面只用 registered，scanDirs 仅是函数必需参数） | §3.2 + §4.3 + §4.5 |

### 优化（P2）处置表

| # | 问题 | 处置 | 落点 |
|---|---|---|---|
| 1 | forget 直通多 target 的回滚语义未在 §4.4 数据流写明 | 已采纳（§4.4 判定顺序：全部校验通过才写盘，先删的不回滚） | §4.4 |
| 2 | 子界面「按路径删除…」的 3 次重试耗尽行为未写明 | 已采纳（耗尽 → 放弃该输入，流程继续，镜像 `promptPaths`） | §4.5 |
| 3 | `resolveRegisteredNameByPath` 的 Windows 路径归一化（`\` vs `/`）未写明 | 已采纳（`resolve` + 注册值 `split('/')` 后 `join` 与 `resolveTarget` 同写法；`path.resolve` 已归一化分隔符） | §4.6 |
| 4 | dir `add` 与 S9 `addScanDir` 的校验重复（第二份真相风险） | 已采纳（本 spec 不抽公共函数——S9 `addScanDir` 是 link.ts 内部函数不导出；若未来三处校验再重复，再抽） | §4.7 + 实现期自决 |
| 5 | 子界面返回 `'back'` 的退出码由调用方决定，可能在两处漂移 | 已采纳（§4.8 注明确：link 主列表继续交互 / forget 无参数当 0） | §4.8 |
| 6 | 未写明「管理注册…」勾选后其它勾选项的处置在测试里的钉子 | 已采纳（§6 加「勾选管理+其它项 → 忽略其它项」） | §6 |
| 7 | forget 直通 / 子界面删除集合的去重未定义（名字 + 路径可能命中同一 key） | 已采纳（Set 化去重，§8 自决 9） | §4.4 + §4.5 + §8 |
| 8 | 缺回滚方案段（交付/运维必问 3） | 已采纳（两个写盘面都可逆/可 git 恢复） | §7 |
| 9 | 反查的 Windows 大小写（`d:\seed\libs` vs 注册值 `D:\Seed\libs`） | 已采纳（win32 比较前 `toLowerCase()`，S6 `resolveTarget` 走 `isDirectory` 天然大小写不敏感，反查是字符串比较故需显式归一化） | §4.6 |

### 自洽确认区（攻过但没攻破）

- **forget 不改 last / 不改 state / 不写留痕**：forget 只删注册（`lpm.config.json`），不触碰链接集与运行留痕——`last.json` 里的失效名字由 S10 展开期预检兜底（既有契约），`last-run.json` 的 command 枚举是 S8 冻结面（S10 同款裁定）。不是遗漏，是划界。
- **子界面删除后返回主列表重扫的即时反映**：`collectLinkCandidates` 是只读纯函数，重扫一次即拿到新注册表——**前提是重扫用的是重读后的 `cfg`**（P1-5）；若沿用 preflight 的旧 cfg 快照，重扫拿到的是旧注册表。该前提已由 §4.9「manage 分支后重读 cfg」显式保证，并在 §6 立回归钉。
- **`lpm forget` 直通与交互的不对称**（直通整批停 / 交互剔除不连累）：与 S10 失效名字策略同源（直通 = 用户点名遇错即停，交互 = 前置剔除反馈前置），不是遗漏。
- **forget 直通对损坏注册值条目**：`Object.hasOwn` 即删（不要求值是字符串）——删掉损坏条目正是修脏路径之一（与 preset corrupt 可删同精神），且删掉后该名字消失，`resolveTarget` / S10 预检不再误报。
- **「按路径删除…」与直通路径解析的同一份反查**：共用 `resolveRegisteredNameByPath`，避免两处实现漂移。
- **`lpm forget` 多 target 直通对已链接的判定**：`Object.hasOwn(state.links, key)` 是唯一判定点（drift 也算已链接），与 S9 unlink 列表的「已链接项」同源。
- **`state.json` 损坏时 forget 直通**：`readState` 抛 `LpmStateParseError` → 透传报错（exit 1），不降级为「视为未链接」——降级会让「其实已链接的注册」被删掉而 state 残留孤儿条目（拆线又删档的反面：删档不拆线）。提示用户先修复 state（S8 repair / 逃生门三步），这是 S9 §4.11「前置失败同口径」的既有语义。

### 修复对照表

| 问题 | 落点 |
|---|---|
| P0-1 dir rm 空态/不在列表文案统一 | §4.7 + §5 #9 |
| P1-1 forget 删空保留 `libs: {}` | §4.4 要点 3 + §6 回归钉 |
| P1-2 管理勾选忽略其它项 + 不进「其他…」 | §4.5 + §6 |
| P1-3 子界面丢失更新（S10 同族关闭） | §4.5 + §7 候选 |
| P1-4 dir e2e 不污染真实 HOME | §6 e2e 前提块 |
| P1-5 子界面删除后主列表不反映（cfg 闭包） | §4.9 + §6 回归钉 |
| P1-6 forget 无参数 ctx 组装缺 loadWorkspace | §4.9 |
| P1-7 ctx 缺 scanDirs（子界面内部现读） | §3.2 + §4.3 + §4.5 |
| P2-1…P2-9 | 见 P2 处置表 |

**收敛判定**：第 1 轮（全量六手法 + 角色面板）发现 P0-1 + P1-1…4 + P2-1…6；第 2 轮（修复 diff 自审 + 手法 3 重跑）发现 P1-5 / P1-6 / P2-7 / P2-8；第 3 轮（手法 3 复扫）发现 P1-7 / P2-9 并修复；第 4 轮（全量复扫，含交叉点同步）**零新增 P0/P1**（P2 不阻塞收敛）。**连续 2 轮零新增 P0/P1 达成**（第 3、4 轮），收敛。

---

## 10. 实现期实测与裁定

**终态计数**（`pnpm verify` 实跑，2026-09-29；最终全量评审修复波后）：exit 0 = typecheck **0 错误** + build **成功** + unit **28 文件 / 498 例** + e2e **1 文件 / 38 例**。开工前基线（S11 交接词，2026-09-28 22:06 实跑）为 unit 26 文件 / 450 例 + e2e 1 文件 / 33 例 → 终态 +2 文件（`dir-command.test.ts` / `forget-command.test.ts`）、unit +48 例（dir 18 + forget 24 + link-interactive 主列表「管理注册…」+6：LI-S11-1…5 + 最终评审修复波新增 LI-S11-5b）、e2e +5 例（E2E-S11-1…5）。取数命令 = `pnpm verify`。

**实施期细则裁定**：

- **R1-1**（plan 缺陷，T5）：plan 的 e2e forget 块 `makeProject` 只 `writeFileSync`、不建中间目录——`E2E-S11-3` 的 `.lpm/state.json` fixture 报 `ENOENT`（`.lpm` 目录不存在）。已按 S6/S7 e2e fixture 惯例补 `mkdirSync(join(p, '..'), { recursive: true })`。代价：无。
- **R1-2**（plan 波及面，T5）：unlink 空态去注的 plan 只列了 `unlink.ts` 源码改动，未列对应 **unit 断言**——`unlink-interactive.test.ts` 的 UI-8 断言 `'待 S11 上线'` 在去注后必红。已同步更新为断言 `'移除 lib 注册'` + `not.toContain('待 S11 上线')`。代价：无（该断言本就只验证空态三去向文案）。
- **R1-3**（环境，T5）：e2e 跑的是 `dist/cli.js`（`tests/e2e/helpers.ts` 前置 build 检查）——首次直接跑 `npx vitest run tests/e2e` 用旧 dist（forget/dir 仍是 stub）致 5 例失败；先 `pnpm build` 后再跑全绿。这不是缺陷，是 e2e 对构建产物的固有依赖（`pnpm verify` 的 build 段排在 e2e 之前）。

**未提交面**（`git status --porcelain -uall` 原文，2026-09-29 实跑；S11 全程零 commit，改动由用户 commit）：

```
 M docs/handoffs/2026-09-28-s11-registry-management.md
 M docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md
 M docs/superpowers/specs/2026-09-28-s9-interactive-design.md
 M src/cli.ts
 M src/commands/link.ts
 M src/commands/unlink.ts
 M tests/e2e/cli.e2e.test.ts
 M tests/unit/link-interactive.test.ts
 M tests/unit/unlink-interactive.test.ts
?? docs/handoffs/2026-09-28-s12-guiding-polish.md
?? docs/superpowers/plans/2026-09-28-s11-registry-management.md
?? docs/superpowers/specs/2026-09-28-s11-registry-management-design.md
?? src/commands/dir.ts
?? src/commands/forget.ts
?? tests/unit/dir-command.test.ts
?? tests/unit/forget-command.test.ts
```
