# S12「引导性打磨」spec（2026-09-29）

- 阶段：S12（PRD §14 行 411：**--dry-run 全面化 / 未知命令模糊纠错 / 错误即建议全局化**；承接 review 修复 **O2 O3**）
- 依赖：S6–S11（全部已交付并提交，HEAD `7a3e375`）
- 行为权威：本文档；与 PRD §7 行 270、§11 行 346–364、§13 行 377–387（尤其 §13.9 dry-run 一致性）、§14 行 411、附录 A O2/O3 对齐
- 交接词：docs/handoffs/2026-09-29-s12-s13-completion.md（本 spec 承接其「开放问题 1–4」全部收敛 + 新发现 1 项）

---

## 1. 目标与非目标

### 1.1 目标

1. **--dry-run 全局化（O2）**：给「有写盘面但当前未支持」的直通命令补 `--dry-run`——`save` / `preset rm` / `forget`（直通）/ `dir add|rm`。语义 = 与 link/unlink/repair 的既有 dry-run 完全同构：**校验全跑、打印「将执行」计划、零写盘零子进程**。
2. **未知命令模糊纠错（O3）**：`lpm lnik` → stderr 追加中文建议「最接近的命令：link」。实现位 = cli 层（`exitOverride` + catch + 自写距离函数）。
3. **错误即建议全局化（PRD §11）**：全量复核所有命令 + core 层用户可见 KNOWN 错误文案，统一「描述 + 另起一行的『下一步：』」模板，落成本 spec §5 全量清单。

### 1.2 非目标（明确划界，防范围蔓延）

- **不改 `renderPlan` 内部**（S9 §4.4 单源，只作消费面复用）；**不改任何 `reportError` helper 结构**（KNOWN 列表零改动，只改 message 文案）。
- **不给 `use` / `status` 声明 `--dry-run`**（声明「不适用」= 不声明；用户输入 `--dry-run` 走 commander unknown-option 报错）。
- **不做交互模式的 `--dry-run`**：`lpm forget|preset|dir`（无参数）遇 `--dry-run` → 拒绝 + 提示，不实现。
- **不顺手收敛 S9 final-review parked 项**（死字段 / 重复解析 / clearAllMocks 等）——除「S9 spec §4.4 行 215 措辞回写」外，一律留观（§7）。
- **不新增运行时依赖**（PRD §14 行 391 定版）；**不改 commander 内部**（suggestSimilar 不导出，自写约 20 行距离函数）。
- **不重写既有错误文案的「描述」部分**——只把「下一步动作」拆到独立行；描述逐字保留（保测试子串断言 + 语义）。

---

## 2. 关键裁决（brainstorming 2026-09-29，5 问全收敛）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | `--dry-run` 覆盖口径 | **只补「有写盘面但当前未支持」的直通命令**：save / preset rm / forget（直通）/ dir(add/rm)；use 与 status 声明「不适用」不补。**修正交接词前提**：`lpm use <pm>` 实际写 packageManager 字段（use.ts:118-120），交接词「use 无副作用」不成立——但它是单字段幂等写入 + 冲突已有交互确认，dry-run 收益低，故仍不补 |
| 2 | 未知命令模糊纠错实现位 | **cli 层**：`program.exitOverride()` + `program.showSuggestionAfterError(false)` + catch CommanderError + 自写距离函数，不动 commander 内部 |
| 3 | 错误即建议全局化 | **全量复核**（不止新增 28 条，含 S6–S8 既有与 core 层）+ **统一「描述 + 下一步：」两行模板** + 落成本 spec §5 清单；reportError 结构不变 |
| 4 | forget/dir/save/preset 形参 | **追加第三参 opts（缺省 undefined）**：`runForget(targets, cwd?, opts?)` 等四命令同形；cli 层透传；既有调用（测试直调 `runForget(targets, cwd)`）零影响（S11 §4.3 冻结面经评审扩展） |
| 5 | **新发现**：commander 15 自带英文建议 | 实测 `lnik` 已输出 `(Did you mean link?)`（suggestSimilar，Damerau ≤3 + 相似度 >0.4，未公开导出）。**裁决：`showSuggestionAfterError(false)` 关掉英文建议，自写中文「最接近的命令：」，阈值 ≤3 与 commander 同质**——避免中英文建议重复输出 |

**关键机制实测（2026-09-29 探针，证据留存 `.superpowers/sdd/s12-probe/`）**：
- commander 15 `exitOverride()` 下：`--help` / `--version` 抛 `CommanderError`（`exitCode=0`，内容已打印到 stdout）；未知命令 / 未知选项抛 `exitCode=1`（**报错已由 commander 写入 stderr，见 command.js:1952-1970 `error()` 先 `outputError` 再 `_exit`**）→ catch 只需补建议行 + 返回退出码，不重打报错。
- 故 `--help` 等「正常展示」路径 exit 0 必须保住（catch 内 `err.exitCode === 0 → return 0`）。

---

## 3. 数据流

### 3.1 `--dry-run` 全局化（save / preset rm / forget / dir）

```
lpm <cmd> <args> --dry-run
  → cli.ts 声明 --dry-run + action 透传 { dryRun }
  → runXxx(args, cwd, { dryRun: true })
    → 前置校验全跑（参数 / 存在性 / 拦截类检查）——与真实执行逐条一致（PRD §13.9：dry-run 骗人比没有更糟）
      ├─ 校验失败 → 既有错误（exit 1），与真实执行同一文案同一码
      └─ 校验通过 → dry-run 分支：
           ├─ 用「与真实执行同一份 next 值」构造计划视图（PlanView）
           ├─ renderPlan(view, 'dry-run') 打印（零写盘零子进程）
           └─ return 0
```

「与真实执行同一份 next 值」是 §13.9 一致性的结构保证：**写盘分支与打印分支共享同一个 next 值计算**（如 forget 的 `next.libs`、preset rm 的 `next` 预设表），打印在前、写盘在后，dry-run 只走打印不走写盘。

### 3.2 未知命令模糊纠错

```
lpm lnik
  → program.exitOverride()：commander 不再 process.exit，改抛 CommanderError
  → catch：
      err.exitCode === 0（--help/--version）→ return 0（内容 commander 已打印）
      err.code === 'commander.unknownCommand'：
        正则从 err.message 提取命令词 'lnik'
        → suggestCommand('lnik', COMMANDS 名列表) 自写 Damerau-Levenshtein ≤3
        → 命中：stderr 追加「最接近的命令：link」（并列多个用、连接）
        → 未命中：不追加
      → return 1
  其它 CommanderError（unknown option 等）→ 直接 return 1（报错 commander 已打印）
```

### 3.3 错误输出统一模板

```
错误产生 → throw XxxError(message)
  → reportError（各命令文件，KNOWN 列表零改动）
  → process.stderr.write(`${message}\n`)
  → message 内嵌「\n下一步：」→ 输出两行：

  <错误描述>。
  下一步：<可执行的下一步动作>
```

模板只作用于 **reportError 打出的 KNOWN 错误**（stderr + exit 1）；非错误分支提示（「已取消」「未选择任何注册」「非交互终端提示」等 stdout 文案）不套模板。

---

## 4. 接口与行为契约

### 4.1 命令面（--dry-run 声明面）

| 命令 | --dry-run 声明 | 行为 |
|---|---|---|
| link / unlink / repair | 已有（S6/S7/S8） | 不变 |
| save | **新增** `.option('--dry-run', ...)` | §4.4 |
| preset（`rm <名>`） | **新增** | §4.4 |
| forget（`[targets...]`） | **新增** | §4.4 |
| dir（`add/rm`） | **新增** | §4.4 |
| use / status | **不声明** | `lpm status --dry-run` → commander `error: unknown option '--dry-run'` + exit 1（与其它未知选项同口径） |

### 4.2 分层与文件

| 文件 | 改动 |
|---|---|
| `src/cli.ts` | ① 四个命令各加 `.option('--dry-run', '仅打印执行计划，不落盘不执行')` + action 透传；② `buildProgram` 加 `exitOverride()` + `showSuggestionAfterError(false)`；③ `run()` 包 try/catch（§4.6）；④ `suggestCommand` 函数（导出，供单测） |
| `src/commands/preset.ts` | `runSave` / `runPreset` 扩第三参 opts；dry-run 分支；错误文案套模板 |
| `src/commands/forget.ts` | `runForget` 扩第三参 opts；dry-run 分支；交互分支遇 dry-run 拒绝；错误文案套模板 |
| `src/commands/dir.ts` | `runDir` 扩第三参 opts；dry-run 分支；交互分支遇 dry-run 拒绝；错误文案套模板 |
| `src/commands/link.ts` / `unlink.ts` / `repair.ts` / `use.ts` | 仅错误文案套模板（结构零改动） |
| `src/core/workspace.ts` / `pm.ts` / `linkcheck.ts` / `rewriter.ts` / `install.ts` / `state/index.ts` | 仅错误文案套模板（结构零改动；`ProtocolPathError` 补缺失的下一步） |
| 测试 | §6 |
| `docs/superpowers/specs/2026-09-28-s9-interactive-design.md` | §4.4 行 215「dry-run 空分支」措辞回写（§4.9） |

### 4.3 公共 API 面（S11 §4.3 冻结面扩展，经评审授权）

既有调用全部兼容（第三参缺省 undefined）；`opts` 未传时行为与 S11 完全一致。

```ts
// 原冻结签名 → S12 扩展（追加可选第三参，不破坏既有调用）
export async function runSave(name: string, cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
export async function runPreset(args: readonly string[], cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
export async function runForget(targets: readonly string[], cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
export async function runDir(args: readonly string[], _cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
```

cli.ts 接线：`runForget(targets, undefined, { dryRun: options.dryRun })` 等（第二参传 undefined 走默认）。

### 4.4 `--dry-run` 各命令契约

通用：**校验全跑**（与真实执行逐条一致）；校验通过 → 计划打印（renderPlan，标准首行）+ 零写盘 + exit 0；校验失败 → 与真实执行同文案同 exit 1。

| 命令 | dry-run 计划输出（renderPlan 渲染） | 备注 |
|---|---|---|
| `save <名> --dry-run` | `dry-run 执行计划（不落任何盘、不执行任何子进程）：`<br>　`将保存预设：<名>（N 项：a、b、c）` | 无链接 / 撞名照样报错（真实执行会拦） |
| `preset rm <名> --dry-run` | 同上首行<br>　`将删除预设：<名>` | 无 config / 名不存在照样报错 |
| `forget <名字\|路径>... --dry-run` | 同上首行<br>　`将移除注册：a、b` | 已链接照样拦截报错；**不打印预设提示**（见 §8 自决 5） |
| `dir add <路径> --dry-run` | 同上首行<br>　`将加入扫描目录：<路径>` | 校验失败照样报错 |
| `dir rm <路径> --dry-run` | 同上首行<br>　`将移除扫描目录：<路径>` | 空态 / 不在列表照样报错 |
| `dir ls --dry-run` | 照常列出（只读，--dry-run 无影响） | — |

### 4.5 交互分支遇 `--dry-run`

`lpm forget --dry-run` / `lpm preset --dry-run` / `lpm dir --dry-run`（均无参数）→ stderr：

```
--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：lpm <cmd> <直通用法> --dry-run
```

- exit 1 + **零 clack 调用**（拒绝发生在进入交互分支之前）。
- 理由：交互模式本身有确认/预览，`--dry-run` 无意义；静默忽略 flag = 撒谎（flag 无效却不报），显式拒绝更诚实。

### 4.6 未知命令模糊纠错契约

1. `buildProgram`：`program.exitOverride()` + `program.showSuggestionAfterError(false)`（关 commander 英文建议）。
2. `run()` 包 try/catch：
   - `err instanceof CommanderError`：
     - `err.exitCode === 0` → return 0（help/version 内容 commander 已打印到 stdout）。
     - `err.code === 'commander.unknownCommand'` → 正则 `/'([^']+)'/` 从 `err.message` 提取命令词 → `suggestCommand` → 命中则 stderr 追加 `最接近的命令：<candidates.join('、')>`；未命中不追加。→ return 1。
     - 其它 CommanderError → return 1（报错 commander 已打印到 stderr，不重打）。
   - 非 CommanderError → rethrow。
3. `suggestCommand(raw, candidates)`（导出，供单测）：自写 **Damerau-Levenshtein**（与 commander 同质，含 transposition），阈值 ≤3；多个同距离候选全列；candidates 缺省 = `COMMANDS.map(c => c.name)`（11 个）。
4. 既有 e2e「`lpm lnik` → exit ≠ 0 + stderr 非空」保持；追加「stderr 含『最接近的命令：link』」。
5. 退出码：真实错误一律 1；help/version 一律 0（回归钉）。

### 4.7 错误输出统一模板契约

**模板**：`<错误描述>。\n下一步：<可执行的下一步动作>`

| 规则 | 说明 |
|---|---|
| 描述部分 | **逐字保留现状**（不动字、不动标点内的既有信息）——保测试子串断言 + 语义 |
| 动作部分 | 从现状内嵌建议拆出，独立成「下一步：」行；「下一步」前以「。」收尾描述 |
| 缺动作 | 复核发现缺「下一步动作」的 → **补齐**（如 `ProtocolPathError`） |
| 禁重复 | 描述与下一步不重复内容；一条错误只出现一次「下一步：」 |
| 前缀 | 描述行**不加**「错误：」前缀（commander 报错自带 `error:` 前缀，stderr 报错行自明；避免全量改第一行） |
| 结构 | `reportError` / KNOWN 列表 / 输出通道零改动；只改 message 字符串（内嵌 `\n下一步：`） |
| 范围 | 全部命令 + core 层用户可见 KNOWN 错误（§5 清单）；非错误分支提示不套模板 |

### 4.8 非 TTY 与退出码

- dry-run 计划输出到 stdout；建议行 / 报错行输出到 stderr。
- 退出码：dry-run 成功 = 0；dry-run 校验失败 = 1（与真实执行一致）；交互遇 dry-run 拒绝 = 1；help/version = 0；未知命令 = 1。
- `--dry-run` 无任何 TTY 依赖（直通模式本无交互）。

### 4.9 与既有编排的对接

- **S9 spec §4.4 行 215 措辞回写**（遗留项，S12 触碰 dry-run 顺手修）：该行把「dry-run 空分支 = 单行无缩进」写成通用规则，实际只描述 link（unlink 是「dry-run 首行 + 缩进行」）→ 按命令分别描述。
- **S13 衔接**：S12 定稿的 `--dry-run` 全局口径是 S13 `lpm init --dry-run` 的继承面（§7）。
- `renderPlan` / `reportError` / 冻结签名零改动原则承袭 S9/S10/S11。

---

## 5. 错误表（统一模板全量清单；取数命令 = 代码 grep + 逐条对照）

> 下表每条 = 现状文案要点 → 统一后模板（描述 / 下一步）。「描述」逐字保留现状第一句；「下一步」为拆出/补齐的动作行。**实施时以本表为唯一改写依据**，未列条目不得改动。

### 5.1 preset.ts（`PresetError`，7 条）

| # | 场景 | 统一后模板（描述 / 下一步） |
|---|---|---|
| P1 | presets 顶层非对象 | 描述：`lpm.config.json 的 presets 应为对象。` / 下一步：`手工修正该字段，或删除 presets 后重新 lpm save——lpm 状态可抛弃重建` |
| P2 | 预设名非法 | 描述：`预设名不能为空，且不能包含空白字符。` / 下一步：`改用不含空白的名字，如 my-preset` |
| P3 | save 无已链接 | 描述：`当前没有任何已链接的库，无法存为预设。` / 下一步：`先 lpm link <名字\|路径> 建立链接` |
| P4 | save 撞名 | 描述：`预设名已存在：<名>。` / 下一步：`先 lpm preset rm <名> 删除，或换一个名字` |
| P5 | preset rm 无 config | 描述：`没有 lpm.config.json，没有任何预设。` / 下一步：`该文件进 git，可由版本库恢复` |
| P6 | preset rm 名不存在 | 描述：`预设不存在：<名>。` / 下一步：`可用预设：a、b`（无任何预设 → `当前没有任何预设。先 lpm save <名字> 建立`） |
| P7 | 用法错误 | 描述：`用法错误。` / 下一步：`lpm preset（列表管理）/ lpm preset rm <名>` |

### 5.2 forget.ts（`ForgetError`，2 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| F1 | 名字/路径未命中 | 描述：`注册不存在：<raw>。` / 下一步：`检查拼写后重试；已注册：a、b`（无注册 → 描述：`当前没有任何已注册的 lib。` / 下一步：`用 lpm link <路径> 注册`） |
| F2 | 已链接 | 描述：`<key> 当前已链接。` / 下一步：`先 lpm unlink <key> 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档` |

### 5.3 dir.ts（`DirError`，4 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| D1 | add 校验失败 | 描述：`扫描目录必须是已存在的绝对路径：<input>。` / 下一步：`示例：D:\Seed\libs` |
| D2 | rm 空态 | 描述：`当前没有任何扫描目录。` / 下一步：`用 lpm dir add <路径> 添加` |
| D3 | rm 不在列表 | 描述：`扫描目录不在列表中：<dir>。` / 下一步：`用 lpm dir ls 查看当前列表` |
| D4 | 用法错误 | 描述：`用法错误。` / 下一步：`lpm dir add <路径> \| rm <路径> \| ls` |

### 5.4 core/workspace.ts（`ManifestParseError` 3 条 + `WorkspaceNotFoundError` 3 条 + `WorkspacePatternError` 1 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| W1 | manifest 无法读取 | 描述：`清单解析失败：<path>（无法读取文件）。` / 下一步：`确认文件存在且可读后重试` |
| W2 | manifest JSON 坏 | 描述：`清单解析失败：<path>（<原因>）。` / 下一步：`修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状` |
| W3 | manifest 根值非对象 | 描述：`清单解析失败：<path>（根值不是 JSON 对象）。` / 下一步：`修正 JSON 语法后重试` |
| W4 | start 路径缺失 | 描述：`路径不存在：<startDir>。` / 下一步：`请检查路径后重试` |
| W5 | 项目根未找到 | 描述：`未找到项目根（未发现 workspace 清单或 package.json）。` / 下一步：`请进入项目目录后运行 lpm` |
| W6 | 无效根 | 描述：`<rootDir> 不是有效的项目根（缺 package.json）。` / 下一步：`请以 findWorkspaceRoot 的返回值为根` |
| W7 | workspace pattern 非法 | 描述：`不支持的 workspace pattern "<p>"（<原因>）。` / 下一步：`支持：字面量段、*（单段）、**（独立段）、!排除；不支持 ?、[...]、{a,b}、\ 转义、段内混合。请修改清单中的该 pattern` |

### 5.5 core/pm.ts（2 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| M1 | PM 歧义 | 描述：`检测到多个 lockfile（a、b），包管理器判定歧义。` / 下一步：`手动指定：lpm use <pnpm\|npm\|yarn>` |
| M2 | PM 无法推断 | 描述：`无法推断包管理器（未发现 lockfile、packageManager 字段或 pnpm-workspace.yaml）。` / 下一步：`手动指定：lpm use <pnpm\|npm\|yarn>` |

### 5.6 state/index.ts（`LpmConfigParseError` / `LpmStateParseError` 共用 4 条模板）

| # | 场景 | 统一后模板 |
|---|---|---|
| S1 | JSON 坏 | 描述：`<filePath> 不是合法 JSON（<原因>）。` / 下一步：`可修复或直接删除该文件——lpm 状态可抛弃重建` |
| S2 | 非对象 | 描述：`<filePath> 不是合法的 lpm 状态/配置文件（应为 JSON 对象）。` / 下一步：`可修复或直接删除该文件——lpm 状态可抛弃重建` |
| S3 | 顶层字段类型错 | 描述：`<filePath> 的 <field> 应为对象/数组。` / 下一步：`可修复或直接删除该文件——lpm 状态可抛弃重建` |
| S4 | version 不受支持 | 描述：`<filePath> 版本 <v> 不受支持（当前仅 version: 1）。` / 下一步：`可修复或直接删除该文件——lpm 状态可抛弃重建` |

### 5.7 core/linkcheck.ts（`LibCheckError`，9 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| L1 | dir 缺失 | 描述：`路径不存在或不是目录：<abs>。` / 下一步：`支持绝对路径、相对路径（相对当前目录）；含空格请加引号` |
| L2 | 非 npm 包 | 描述：`<abs> 不是 npm 包（缺 package.json）。` / 下一步：`确认路径指向包目录` |
| L3 | manifest 无法读取 | 描述：`<path> 无法读取。` / 下一步：`确认文件可读后重试` |
| L4 | manifest JSON 坏 | 描述：`<path> 不是合法 JSON（<原因>）。` / 下一步：`修正后重试` |
| L5 | manifest 根值非对象 | 描述：`<path> 不是合法的 package.json（根值不是 JSON 对象）。` / 下一步：`修正后重试` |
| L6 | name ≠ key | 描述：`lib 实际 name（<n>）≠ 通讯录 key（<k>）。` / 下一步：`更新 lpm.config.json 中 libs 键为 <n> 后重试` |
| L7 | 入口产物缺失 | 描述：`入口产物缺失：<entry>。` / 下一步：`先 build 或起 build:watch 后重试` |
| L8 | node_modules 空 | 描述：`<abs> 的 node_modules 为空。` / 下一步：`先在 <abs> 执行包管理器 install` |
| L9 | 缺 build:watch | 描述：`<abs> 缺 build:watch script。` / 下一步：`在 lib package.json 的 scripts 补充后重试，或去掉 --watch` |

### 5.8 core/rewriter.ts + install.ts（2 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| R1 | `ProtocolPathError`（**缺下一步，本轮补**） | 描述：`无法生成相对路径（跨盘符？）：libDir=<a> manifestDir=<b>。` / 下一步：`Windows 无法跨盘符写相对路径——将 lib 与项目放到同一盘符后重试` |
| R2 | `InstallError` | 描述：`install 失败（exit <c>）：<tail>。` / 下一步：`<retryAdvice>`（link/unlink 向 advice 原样保留） |

### 5.9 commands/link.ts（`LinkArgumentError` 9 条 + `LinkInteractionError` 2 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| A1 | 三开关互斥 | 描述：`--last / --all / --preset 三者互斥。` / 下一步：`请只用一个。用法：lpm link --last \| --all \| --preset <名>` |
| A2 | 开关+位置参数 | 描述：`--last / --all / --preset 不能与 <名字\|路径> 同时使用。` / 下一步：`要链接指定目标请直接给名字或路径` |
| A3 | --preset 空名 | 描述：`--preset 需要一个预设名。` / 下一步：`用法：lpm link --preset <名>` |
| A4 | --last 无记录 | 描述：`没有上次链接的记录。` / 下一步：`先做一次批量 link（一次给 ≥ 2 个目标、或 --all / --preset）建立记录` |
| A5 | --all 无已注册 | 描述：`当前没有任何已注册的 lib。` / 下一步：`先 lpm link <路径> 注册` |
| A6 | --preset 不存在 | 描述：`预设不存在：<名>。` / 下一步：`可用预设：a、b`（无预设 → `当前没有任何预设。先 lpm save <名字>`） |
| A7 | --preset 损坏 | 描述：`预设 <名> 内容损坏（应为字符串数组）。` / 下一步：`可 lpm preset rm <名> 删除后重存` |
| A8 | --preset 空数组 | 描述：`预设 <名> 是空的。` / 下一步：`先 lpm save <名> 写入内容` |
| A9 | 集合问题项 | 描述：`<来源>里有 N 个问题项：a、b。` / 下一步：`用路径重新注册，或 lpm preset rm 后重存`（原两条出路原样保留） |
| A10 | 名字形态非路径且未命中 | 描述：`未知注册名/路径不存在：<raw>。` / 下一步：`已注册：a、b；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册` |
| A11 | 路径目录不存在 | 描述：`未知注册名/路径不存在：<raw>。` / 下一步：`已注册：a、b；若为路径请确认目录存在；若为注册名请检查拼写或先注册` |
| A12 | `LinkTargetError` 零命中依赖 | 描述：`<name> 不在任何成员依赖中。` / 下一步：`先在引用方执行 pnpm add <name> 再 link` |
| I1 | monorepo 根选成员 | 描述：`<abs> 是 monorepo 根，需要选择成员包：可选成员 a、b。` / 下一步：`当前环境无法交互——请直接使用成员路径，如 lpm link <成员路径>` |
| I2 | 非 lpm 本地链接 | 描述：`检测到非 lpm 管理的本地链接（<rel>），需交互确认原始 range。` / 下一步：`手动恢复该文件原值后重试，或先 lpm link --dry-run 查看` |

### 5.10 commands/unlink.ts + repair.ts（2 条）

| # | 场景 | 统一后模板 |
|---|---|---|
| U1 | `LinkStateCorruptError` | 描述：`state 条目损坏：<key> 的 original 缺失。` / 下一步：`手工逃生三步：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建` |
| U2 | `RepairInteractionError` | 描述：`需交互确认修复计划。` / 下一步：`改用 lpm repair --dry-run 查看计划` |

> 清单合计约 **45 条**（预设 7 + forget 2 + dir 4 + workspace 7 + pm 2 + state 4 + linkcheck 9 + rewriter/install 2 + link 14 + unlink/repair 2）。实施时 grep 逐条对照，**未列条目零改动**。

---

## 6. 测试清单（取数命令 = `pnpm verify`）

**`tests/unit/fuzzy-suggest.test.ts`（新，直调 cli.ts 导出的 `suggestCommand`）**
- `lnik` → `['link']`（transposition，距离 2）；`staus` → `['status']`（距离 1）；`unlnk` → `['unlink']`（距离 1）
- 阈值边界：距离 ≤3 命中（`linnnk` → `link`，距离 2）；距离 >3 → `[]`（如 `zzzzzz`，对所有命令距离 ≥6）
- 并列：自定义 candidates 传入同距离两个候选 → 全列（`join('、')` 顺序稳定）
- candidates 缺省 = COMMANDS 11 名；`--help`/`-h` 等 option 形态不进候选（suggestCommand 只处理裸词）

**`tests/e2e/cli.e2e.test.ts`（追加）**
- `lpm lnik` → 既有「exit ≠ 0 + stderr 非空」保持 + 新增「stderr 含『最接近的命令：link』」
- `lpm staus` → stderr 含「最接近的命令：status」（可选冒烟）
- **`lpm --help` → exit 0 + stdout 含 Usage**（回归钉：exitOverride 不破坏 help）
- **`lpm --version` → exit 0 + stdout 含版本号**（回归钉）
- `lpm save <名> --dry-run` → exit 0 + 首行 `dry-run 执行计划（不落任何盘、不执行任何子进程）：`（冒烟）

**`tests/unit/forget-command.test.ts`（追加）**
- 直通 `--dry-run`：正常 → `将移除注册：a、b` + `lpm.config.json` **byte 级零写盘** + exit 0
- 直通 `--dry-run` + 已链接 → 照样拦截（F2 文案）+ 零写盘 + exit 1（与真实执行一致）
- 无参数 + `--dry-run` → 「仅直通模式适用」+ exit 1 + **零 clack 调用**
- 既有 FG 断言整条 message 的同步为两行模板（子串断言保留）

**`tests/unit/dir-command.test.ts`（追加）**
- `add --dry-run` → `将加入扫描目录：<路径>` + 用户配置 **byte 级零写盘** + exit 0
- `rm --dry-run` → `将移除扫描目录：<路径>` + 零写盘 + exit 0；不在列表 → 照样报错 + 零写盘
- `ls --dry-run` → 照常列出
- 无参数 + `--dry-run` → 「仅直通模式适用」+ exit 1 + 零 clack 调用
- 既有 D 断言整条 message 的同步为两行模板

**`tests/unit/preset-command.test.ts`（追加）**
- `save --dry-run` → `将保存预设：<名>（N 项：…）` + `lpm.config.json` **byte 级零写盘** + exit 0；撞名 / 无链接 → 照样报错 + 零写盘
- `preset rm <名> --dry-run` → `将删除预设：<名>` + 零写盘 + exit 0；名不存在 → 照样报错 + 零写盘
- 无参数 + `--dry-run` → 「仅直通模式适用」+ exit 1 + 零 clack 调用
- 既有断言整条 message 的同步为两行模板

**错误模板复核（贯穿各既有测试文件）**
- 全量 grep `throw new` 对照 §5 清单逐条：描述逐字保留、下一步独立成行、缺动作已补（R1 `ProtocolPathError`）
- 断言整条 message 的测试 `toBe/toEqual` 同步为两行；断言子串 `toContain` 的零改动（描述保留）

---

## 7. 后续衔接

| 消费方 | 依赖的 S12 产出 |
|---|---|
| **S13 umi utoopack 适配** | `--dry-run` 全局口径继承：`lpm init --dry-run` = 打印注入 diff 预览零写盘（§4.4 通用语义）；`lpm init` TTY diff 预览确认 + 一次确认的交互形态（S13 开放问题 5 到阶段二澄清） |
| S9 final-review parked（**留观，不纳入 S12**） | 死字段 / 重复解析 / clearAllMocks 等 7 项——S12 不改 renderPlan 内部、不改 reportError 结构，无顺手落点；继续留观 |
| S9 spec §4.4 行 215 | **本阶段回写**（§4.9）——「dry-run 空分支」措辞按命令分别描述 |
| 后续候选 | 未知命令建议的选项级纠错（`--lastt` → 建议 `--last`）——commander 自带 unknownOption 建议已关闭，若用户反馈需要再评估 |

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **renderPlan 复用于简单命令 dry-run 输出**：save/preset/forget/dir 构造最小 `PlanView`（单条 `line` 或 `group` + `install: null` + `watch: []`）走 `renderPlan(view, 'dry-run')`——统一首行 + 2 空格缩进，与 link/unlink dry-run 同视觉；**renderPlan 内部零改动**（S9 单源契约）。
2. **`suggestCommand` 留在 cli.ts 并导出**（用户选「cli 层」不抽独立文件）：`export function suggestCommand(raw: string, candidates?: readonly string[]): string[]`，纯函数可单测；COMMANDS 名列表缺省。
3. **「另起一行」的实现**：message 字符串内嵌 `\n下一步：`，`reportError` 仍 `stderr.write(message + '\n')`——结构零改动。
4. **交互分支遇 --dry-run 拒绝的措辞**（§4.5）按命令带各自直通用法。
5. **forget dry-run 不打印预设提示**：`printPresetHints` 的「已失效」措辞只在删除落盘后成立；dry-run 下打印会误导（什么都没删却说失效）→ dry-run 分支跳过。
6. **`dir ls --dry-run` 只读无影响**：不拒绝、不特殊处理，照常列出。
7. **use/status 不声明 --dry-run**：commander unknown-option 兜底（`error: unknown option '--dry-run'` exit 1），不额外接友好提示。
8. **exitOverride 的 help/version 处理**：catch 内 `err.exitCode === 0 → return 0`（内容 commander 已打印），保证 `--help`/`--version` 回归。
9. **suggestCommand 阈值 ≤3 与 commander 同质**（用户裁决 5）：`lnik→link` 距离 2（transposition）、`staus→status` 距离 1、远词不中。
10. **测试断言迁移**：整条 message 断言（`toBe`/`toEqual`/`toMatch(/^…$/)`）→ 改两行模板；子串断言（`toContain`）零改动——描述逐字保留是前提。
11. **`dir add` 幂等 quirk 与 dry-run 一致性**：目录已存在时真实执行**零写盘但照样打印**「已加入扫描目录：X」（既有幂等行为）——dry-run 打印「将加入扫描目录：X」与之**报告层面一致**；dry-run 不做「已存在」特判（避免与真实执行报告错位）。
12. **`showSuggestionAfterError(false)` 的连带效应**：commander 源码 command.js:2130 门控确认——未知**选项**（`--lastt`）也一并失去英文建议。已知取舍：选项级中文纠错列为 §7 后续候选，不纳入本阶段。
13. **建议候选含 stub 命令（init/uninit）**：`lpm lini` → 建议 `init`（stub 会打印「计划 S13」）。指向存在命令比无建议好，接受。

---

## 9. 评审 Backlog

> 自审（multi-lens-review）结果、修复对照、终审意见在此追加；未自审前本节为空。

### 自审（multi-lens-review，2026-09-29，场景 B 技术方案：六手法 + 架构师 / 资深开发 / 资深测试 / 交付运维面板）

**结论**：0 矛盾 / 1 盲点（已修）/ 3 优化（已处置）。

| # | 级别 | 来源透镜 | 问题 | 处置 |
|---|---|---|---|---|
| S-1 | P1 盲点 | 手法 3（自洽） | §6 阈值边界例子「`linnnnk` → 距离 >3 不中」算错——`linnnnk` 到 `link` 距离 2（插入 2 个 n），≤3 会命中。例子与断言矛盾 | **已修**：改 `zzzzzz`（对所有命令距离 ≥6）+ 补 ≤3 命中正例 `linnnk` |
| S-2 | P2 | 手法 1（操作序列） | `dir add` 幂等 quirk：已存在目录真实执行零写盘但照样打印「已加入」——dry-run「将加入」与其报告一致，但未显式声明，实现者可能纠结是否特判 | 采纳 → §8 自决 11 |
| S-3 | P2 | 手法 5（平台机制断言） | `showSuggestionAfterError(false)` 连带关闭未知**选项**的英文建议（源码 2130 行门控确认），spec 未声明此取舍 | 采纳 → §8 自决 12（选项级纠错列 §7 候选） |
| S-4 | P2 | 资深开发 2（接管时刻） | 建议候选含 stub 命令 init/uninit，`lpm lini` 会建议指向未实现的 stub | 采纳 → §8 自决 13（指向存在命令可接受） |

**自洽确认区（攻过但没攻破）**：
- 手法 3 表格一致性：§1.2 非目标 ↔ §2 裁决 1 ↔ §4.1 命令面（use/status 不声明）三处一致；阈值 ≤3 在 §2/§4.6/§8 三处一致；R1 补下一步 ↔ §4.7 缺动作补齐 ↔ §5.8 一致。
- 手法 3 验收×现状：commander 15 `error()` 先写 stderr 再抛（command.js:1952-1970）、`exitOverride` 下 help/version 抛 exitCode=0、`suggestSimilar` 未导出——三处均**实测/源码验证**（探针留存 `.superpowers/sdd/s12-probe/`），非假设。
- 手法 1 幂等/中断：dry-run 零写盘零子进程，重跑/交叉/中断均无状态可污染；真实执行路径零改动。
- 手法 2 字段审计：dry-run 只读（readProjectConfig/readState/readUserConfig）复用同一 next 值计算，无新增持久化字段。
- 手法 4 输入枚举：save 缺参（commander missing-argument）、forget 空 targets、dir rm 缺路径、`--dryrun` 错拼、交互 + dry-run——均有定义行为。
- 手法 6 可逆性：preset rm / forget / dir rm 均不可逆直通操作 → 补 dry-run 预览；交互变体自带确认，无确认策略变更。
- 角色面板：架构师（无第二真相：renderPlan/reportError 单源保留，§5 错误表为唯一改写依据）；资深开发（接管时刻 corrupt 配置均走既有守卫代码）；资深测试（零写盘 byte 级黄金断言 + help/version 回归钉）；交付运维（exit 码 + stderr 文案统一，无部署面）。

---

## 10. 实现期实测与裁定

### 逐任务裁定（T1–T7，零 commit，改动用户待提交）

- **T1**（cli.ts + fuzzy-suggest.test.ts + cli.e2e）：`suggestCommand`（Damerau ≤3）导出；`exitOverride` + `showSuggestionAfterError(false)` + run() catch；e2e lnik 追加「最接近的命令：link」断言 + staus 新例；`--help`/`--version` 既有用例即 exitOverride 回归钉。fuzzy 7/7、e2e 39/39。
- **T2**（forget.ts + cli forget 块 + forget-command.test.ts）：`runForget` 扩第三参；`forgetDirect` dry-run 分支（renderPlan 打印 + 零写盘）；交互遇 dry-run 拒绝；F1/F2 模板。forget 28/28。
- **T3**（dir.ts + cli dir 块 + dir-command.test.ts）：`runDir` 扩第三参；add/rm dry-run；ls 只读不受影响；交互拒绝；D1–D4 模板。dir 22/22。
  - **Ruling T3-1（控制方）**：实现者 e2e 跑在**未重建的旧 dist** 上（T1 建的 dist 不含 dir 改动），E2E-S11-5 断言 `用法：lpm dir add` 在旧消息「碰巧通过」→ 控制方修复断言为 `下一步：lpm dir add`（D4 新文案的下一步行）+ 重建 dist + 全量复核。**教训：e2e 必须先 `pnpm build`**（S11 R1-3 同族，本阶段再次实证）。
- **T4**（preset.ts + cli save/preset 块 + preset-command.test.ts + cli.e2e）：`runSave`/`runPreset`/`runPresetRm` 扩第三参；dry-run 分支；交互拒绝；P1–P7 模板；同步 preset-command.test.ts:195 `用法：lpm preset` → `下一步：lpm preset`；E2E-S12-1 冒烟（save describe 的 makeProject 不建中间目录 → 先 mkdir 再写 state，S11 R1-1 同族）。preset 29/29、e2e 40/40。
- **T5**（link/unlink/repair 15 条模板）：A1–A12、I1–I2、U1、U2；描述逐字保留，既有 19 处断言（含 e2e E2E-S10-1/2/3、E2E-3）全为描述子串断言零改动存活。unit 29/517。
- **T6**（core 26 条模板 + R1 补下一步）：
  - **Ruling T6-1**：`validatePatterns` 重抛注入点 `e.message.replace('）。支持：', …)` 因 W7 拆行失配 → 注入目标同步为 `）。\n下一步：支持：`，OCR O5 的「清单定位」功能保持（load-workspace 测试为证）。
  - **Ruling T6-2**：linkcheck.test.ts T2-6 断言 `'请更新 lpm.config.json'` 因 L6 动作拆行（「请」并入下一步句）变红 → 同步为 `'更新 lpm.config.json 中 libs 键'`。
- **T7**（S9 spec 行 217 措辞回写 + 终态验证 + 文档收口）：S9 spec「dry-run 空分支 = 单行无缩进」按命令分别描述（link 单行无缩进 / unlink renderPlan 首行 + 缩进行 + `  无待执行变更` 补行判据）。

### 终态实测（T7 后，controller 实跑 `pnpm verify`）

- **exit 0 = typecheck 0 + build 成功 + unit 29 文件 / 517 例 + e2e 1 文件 / 40 例**
- 计数对照：S11 基线 28/499 + 38 → +1 文件（fuzzy-suggest）/ +18 例（7 fuzzy + 3 forget + 4 dir + 4 preset）/ e2e +2 例（staus + E2E-S12-1；lnik 就地扩断言）
- 未提交面（用户待 commit）：14 个 ` M`（cli.ts、commands/{dir,forget,link,preset,repair,unlink}.ts、core/{globmatch,install,linkcheck,pm,rewriter,workspace}.ts、state/index.ts、tests/e2e/cli.e2e.test.ts、tests/unit/{dir,forget,linkcheck,preset}-command.test.ts、docs/superpowers/specs/2026-09-28-s9-interactive-design.md）+ 4 个 `??`（plan、S12 spec、fuzzy-suggest.test.ts、2026-09-29-s12-s13-completion.md 交接词）
- 冻结面零触碰：`renderPlan` / 各 `reportError` helper / `runLink`/`runUnlink` 签名 / `atomic.ts`——git diff 逐一核实

### OCR 评审轮

- 运行（diff 模式，用户提交 `6f645e2` 后）：`ocr review --audience agent --background "<S12 上下文>" --from 7a3e3752908a4bce42f6ae1a2b11087174100da9 --to 6f645e2f657cf34a1086d05f8db0312817bb0f1e --exclude "docs/**,**/*.md" --output .../ocr-out-s12-review.txt`（命令行 + Summary 落盘 `ocr-cmd.txt`）
- 结果：**14 file(s) / 8 comment(s) / ~4.86M tokens / 6m21s**；0 critical / 0 high
- **修复波（controller 直改，8 意见全处置）**：7 ADDRESSED——① dir add `--dry-run` 校验前短路 bug（改先读配置再短路 + 回归钉 S12-D-DR5）；② unlink `LinkStateCorruptError` 三分支 + `conflict-ternary` + `--all 互斥`；③ workspace `yamlError` + `listWorkspaceMembers` invalid-root；④ link `注册值损坏` + LibCheckError；⑤ cli `length<=1` 守卫注释。1 P2 候选（OCR-8 交互拒绝消息抽 helper，触发信号 = 第四个命令接入）
- **终态（修复波后，controller 实跑 `pnpm verify`）**：exit 0 = typecheck 0 + build + unit **29 文件 / 518 例** + e2e **1 文件 / 40 例**
- 修复波未提交面：`M` 6 项（unlink.ts、workspace.ts、link.ts、dir.ts、cli.ts、dir-command.test.ts），用户待 commit
