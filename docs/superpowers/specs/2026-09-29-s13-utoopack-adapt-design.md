# S13「umi utoopack 适配注入」spec（2026-09-29）

- 阶段：S13（PRD §14 行 412：`lpm init` 一次性注入 root + peer dedupe alias；**SP0 两轮实测立项**）
- 依赖：S6（lib 注册与 workspace 解析）、S12（--dry-run 全局口径、错误模板、交互拒绝闸门）
- 行为权威：本文档；与 PRD §7 行 268（交互列 = diff 预览确认）、§14 行 412、§15 风险 1（SP0 两轮结论）、§12 行 374–375（真实环境手测口径）、S12 spec §4.4（--dry-run 通用语义）、S12 spec §4.5（交互遇 dry-run 拒绝）对齐
- 交接词：docs/handoffs/2026-09-29-s13-utoopack-adapt.md（本 spec 承接其「开放问题 5–7」全部收敛 + 补充 3 项设计决策）
- **v1 收官：S13 后无 S14**

---

## 1. 目标与非目标

### 1.1 背景（SP0 两轮实测，2026-09-25，BFM + ai_suit_tool）

1. **link: 出根 Module not found**：utoopack 虚拟 FS 锚定 rootDir，`link:` 指向 rootDir 外的 lib 一律解析失败；`utoopack: { root: '../../' }` 扩边界后解析可用。
2. **antd 双实例静默分裂主题**：link 模式下 lib 的 antd 解析到 lib 自己的 devDeps 实例（React 单实例 hooks 不炸），但 lib 组件脱离宿主 ConfigProvider 主题上下文 → 亮色默认样式；**peer dedupe alias（react/react-dom/antd/@ant-design/icons → 宿主实例）后恢复暗色且零报错**。

→ S13 终版机制 = **root 注入 + peer dedupe alias 注入**，两者都是 `lpm init` 一次性注入的**自感知、可摘除**配置片段。

### 1.2 目标

1. **`lpm init`**：向宿主 umi 配置注入标记段，内含 `utoopack.root`（扩边界覆盖已注册 lib）与 `alias`（peer dedupe）两组键。
2. **`lpm uninit`**：按标记段对称摘除注入内容，宿主配置还原。
3. 继承 S12 全局口径：`--dry-run` 打印注入 diff 预览零写盘；TTY diff 预览 + 一次确认；非 TTY 拒绝。

### 1.3 非目标（明确划界，防范围蔓延）

- **不注入 `watch.ignored`**（PRD §14 待验项，v1 不注入；真实环境实测 watch 性能后再定——见 §7）。
- **不做 dedupe 列表动态化**：v1 静态注入（init 时按当下集合计算一次）；lib 加新 peer 后**重跑 `lpm init`**（文档注明）——见裁决 5。
- **不触碰 lib 的 package.json / node_modules**：S13 只改宿主配置；lib 侧零改动。
- **不替代 umi 配置的常规键**：注入段只含 `utoopack` 与 `alias` 两组键，其余宿主配置原样保留。
- **不做真实环境自动化验证**：root 扩界解析、antd 暗色恢复、watch 性能 → 归真实环境手测（PRD §12 行 374–375 同口径；§13 验收清单）。
- **不扩展 `LastRunTrace.command` 联合类型**：init/uninit 不写运行留痕（非回归命令，无失败收敛语义；留痕仅 link/unlink/repair 三命令既有面）。
- **不新建 lpm 状态文件**：注入状态自感知于宿主配置内的标记段（见 §3.1），无 `.lpm/` 新增面。
- **不改既有命令**：status/repair/save/preset/forget/dir/use 及 S12 冻结签名零改动。**例外（S13 收官后扩展）**：link/unlink 增加「成功后自动 init / 全部断开后自动 uninit」联动（见 §9 追加记录 S14）——只增不改，既有 link/unlink 行为与签名不变。

---

## 2. 关键裁决（brainstorming 2026-09-29，开放问题 5–7 + 补充 3 项全收敛）

| # | 问题 | 裁决 |
|---|---|---|
| 1 | 注入对象 | **宿主 umi 配置内嵌标记段**（`/* lpm-inject:start */` … `/* lpm-inject:end */`），uninit 按标记精确摘除 |
| 2 | 交互形态 | init/uninit：TTY 打印注入 diff 预览 + clack.confirm 一次确认（默认否）；`--dry-run` 继承 S12 全局口径（同一份 diff 零写盘 exit 0）；非 TTY 拒绝 |
| 3 | root 覆盖集合 | **宿主目录 + 全部已注册 lib 绝对路径的最近公共祖先**（lib 含未链接）；跨盘符/无公共祖先 → 报错；无已注册 lib → 提示先 link 注册。**注：必须含宿主目录本身**——utoopack.root 是虚拟 FS 根，宿主文件须在 root 内，若只取 libs 的祖先可能把宿主排除在外（libs 常在宿主上级或旁支） |
| 4 | 宿主定位 | **运行目录 + 候选文件名**：`config/config.ts` → `.umirc.ts` → `config/config.js` → `.umirc.js`；找不到 → 报错 |
| 5 | v1 范围 | **静态注入** + 文档注明「lib 加新 peer 后重跑 lpm init」；`watch.ignored` 不注入，真实环境实测后再定（若加，uninit 一并摘除） |
| 6 | 冲突合并 | **宿主已有同名键 → 合并进该键对象体内部**（S14 方案 A 定版）；无同名键 → 对象体末尾追加新键；提示「已有 utoopack/alias 配置，已合并进宿主键；uninit 后可还原」。uninit 摘除注入段后宿主原键**原样保留**（含键内其他配置，无需备份文件）。**注：初版「重复键」「对象展开」两版均因 TS1117/TS2783 废弃——见裁决 6 修订** |

**裁决 6 的机制说明（S14 方案 A 定版，2026-09-30）**：注入不再产生「第二个同名键」，而是把 `root` / alias peer **合并进宿主同名键的对象体内部**（`/* lpm-inject:start */` … `/* lpm-inject:end */` 标记段包住注入行，插在宿主键 `{` 之后；键体比对象体深一层 → 4 空格缩进）。因此：
- **键只出现一次**——TS1117（重复键）/ TS2783（展开覆盖）从根上消失，不依赖「后定义覆盖」语义；
- 宿主键内的**原有内容原样保留**（如 `utoopack: { root: 'custom' }` 的 `root: 'custom'` 仍在），注入行以标记段包裹、uninit 摘除后宿主键逐字节还原；
- 宿主**无**该键时仍走追加模式（对象体末尾 `buildFragment` 普通键），与 S13 行为一致；
- init 时检测到宿主已有同名键 → 提示「检测到宿主已有 utoopack/alias 配置，已合并进宿主键；uninit 后可还原」。

> **裁决 6 修订（S14 追加，2026-09-30）**：初版用「对象字面量重复键」（`utoopack: {...}` 写两遍）实现后定义覆盖——JS 运行时合法（后者覆盖前者），但宿主 umi 配置是 **TS 文件**（.umirc.ts / config.ts），`defineConfig({...})` 有类型检查，重复键直接报 **TS1117**（An object literal cannot have multiple properties with the same name）。曾改**对象展开** `...{...}`：字面量层面不重复，但宿主已声明同名键时，展开对象里的同名属性被 TS 判为「指定两次、将被覆盖」仍报 **TS2783**——两版都过不了 tsc。**定版 = 合并进宿主键对象体内部**（`injectIntoKey`）：无第二个同名键、无展开，TS 编译零报错（BFM `.umirc.ts` `tsc --noEmit` 实测通过）。

---

## 3. 数据流

### 3.1 标记段形态（注入 / 摘除 / 自感知）

**追加模式**（宿主**无** `utoopack`/`alias` 同名键时，S13 既有行为）：

```
宿主 config/config.ts 注入后：

  export default defineConfig({
    antd: {},
    access: {},
    /* lpm-inject:start */
    utoopack: {
      root: '../..',
    },
    alias: {
      react: 'D:/Seed/BFM/apps/web/node_modules/react',
      antd: 'D:/Seed/BFM/apps/web/node_modules/antd',
    },
    /* lpm-inject:end */
  })
```

**合并模式**（S14 方案 A 定版，宿主**已有**同名键时，如 BFM `.umirc.ts` 的 `utoopack: {}`）：

```
宿主 .umirc.ts 注入后：

  export default defineConfig({
    // ...宿主原有配置...
    utoopack: {/* lpm-inject:start */
      root: '../..',
      /* lpm-inject:end */},
    proxy: { ... },
    /* lpm-inject:start */
    alias: {
      react: 'D:/Seed/BFM/apps/web/node_modules/react',
      antd: 'D:/Seed/BFM/apps/web/node_modules/antd',
    },
    /* lpm-inject:end */
  })
```

> 注：上图示意「宿主对象体无尾逗号」时注入的形态——追加模式补一个逗号作为分隔（`,\n  /* lpm-inject:start */`）。「有尾逗号」「空对象体」两态见 §8 自决 1（本图仅为可读示意，非逐字节规范）。合并模式下注入行以标记段包住、插在宿主键 `{` 之后（键体深一层 → 4 空格缩进），`}` 保持原位（空键体 `{}` 时与 `/* lpm-inject:end */` 紧贴），uninit 摘除后宿主键逐字节还原。

要点：
- **标记段**：`/* lpm-inject:start */` 到 `/* lpm-inject:end */`。追加模式 = 对象体末尾一段（含新键）；合并模式 = 宿主同名键对象体内部一段（仅注入行）。一个文件**可能同时存在两个标记段**（如 utoopack 合并 + alias 追加），uninit 从后往前一次摘除全部。
- 追加模式注入时在标记段**前**补一个逗号（若对象体原末尾已有尾逗号则不补）；摘除时**连同前导逗号**一并删，保证还原后无残留逗号。
- **自感知**：uninit 只需在宿主配置源码中查找 `/* lpm-inject:start */` 标记；找到即已注入，未找到报「未注入」。
- **不产生同名键**（方案 A）：宿主已有 `utoopack`/`alias` 键时合并进该键体内部，全文同名键只出现一次——无 TS1117/TS2783（裁决 6 修订）。

### 3.2 `lpm init` 数据流

```
lpm init [--dry-run]（在宿主 umi 子包目录运行）
  → cli.ts：.option('--dry-run') + action → runInit(cwd, { dryRun })
  → ① 宿主定位：候选文件名（§4.2）→ 找不到 → InitConfigNotFoundError
  → ② 读宿主配置源码 + 定位对象体（locateConfigObject，§4.4）
  → ③ workspace 根 = findWorkspaceRoot(cwd)（宿主是成员子包 → 向上定位）
  → ④ readProjectConfig(rootDir).libs → 空 → 提示先 link 注册
  → ⑤ 计算 root：全部 lib 绝对路径 + 宿主目录的最近公共祖先，相对宿主 cwd 的相对路径（正斜杠）
       跨盘符/无公共祖先 → InitRootError
  → ⑥ 计算 alias：遍历 lib peerDependencies ∩ 宿主直接依赖 → 宿主实例绝对路径（§4.5）
  → ⑦ 检测宿主已有 utoopack/alias 键 → 有则**合并进该键体内部**（无第二个同名键）并提示「已合并进宿主键，uninit 可还原」；无则追加新键
  → ⑧ 构造注入段源码（含 root + alias）→ 组装注入后全文（文本级：原内容 + 末尾插入）
  → ⑨ 交互闸门（§4.6）：
       --dry-run → 打印注入 diff 预览（+ 行）零写盘 return 0
       非 TTY   → InitInteractionError（改用 --dry-run）
       TTY      → 打印 diff 预览 + clack.confirm（默认否）→ 确认才写盘
  → ⑩ 写盘：writeTextFileAtomic(宿主配置路径, 注入后全文) + 完成提示（含「加新 peer 后重跑 init」）
```

### 3.3 `lpm uninit` 数据流

```
lpm uninit [--dry-run]（同目录运行）
  → ① 宿主定位 + ② 读源码 + locateConfigObject
  → ③ 查找 /* lpm-inject:start */：
       未找到 → InitNotInjectedError（I7）
       找到 start 但无 end → InitIncompleteMarkerError（I8，绝不自动摘除）
       完整标记 → ④ 摘除标记段（连同前导逗号）→ 组装摘除后全文
  → ⑤ 交互闸门（同 §4.6，对称）：
       --dry-run → 打印摘除 diff 预览（- 行）零写盘 return 0
       非 TTY   → InitInteractionError
       TTY      → diff 预览 + clack.confirm（默认否）→ 确认才写盘
  → ⑥ 写盘 + 完成提示（「已还原宿主原有配置」/「已摘除注入片段」）
```

---

## 4. 接口与行为契约

### 4.1 命令面

| 命令 | --dry-run 声明 | 直通用法 | 交互（无参数） |
|---|---|---|---|
| `lpm init` | **新增** `.option('--dry-run', ...)` | `lpm init --dry-run`（预览） | TTY：diff 预览 + 一次确认 |
| `lpm uninit` | **新增** | `lpm uninit --dry-run`（预览） | TTY：diff 预览 + 一次确认 |

- 两者均**无位置参数**（`allowExcessArguments(false)`；PRD §7 直通列无 `<参数>` 字样）。
- 交互列 = **diff 预览确认**（PRD §7 行 268），与 repair 同族（确认型命令），但预览内容是**行级 diff**（`+`/`-`）而非执行计划——因为注入/摘除是改 TS 源码片段，diff 比计划更直观（§4.7）。

### 4.2 宿主配置文件定位（运行目录 + 候选文件名）

候选文件名按序探测（相对运行目录 cwd，存在即命中）：

```
config/config.ts → .umirc.ts → config/config.js → .umirc.js
```

- 命中 → 返回该文件绝对路径。
- 全部不存在 → `InitConfigNotFoundError`：描述 `未找到 umi 配置文件（已检查 config/config.ts、.umirc.ts、config/config.js、.umirc.js）。` / 下一步：`请在含 umi 配置的项目目录运行 lpm init`。

> 说明：`config/config.ts` 为 umi 3/4 默认约定（多行配置）；`.umirc.ts` 为单文件配置；后两个为 JS 变体。真实环境（BFM）若形态不同，在真实环境手测时对齐补候选名（§7）。

### 4.3 公共 API 面（S13 新增；init/uninit 原为 stub，非冻结签名）

S12 §4.3 形态照搬（第三参 opts 缺省 undefined；既有调用零影响）：

```ts
// src/commands/init.ts（新文件）
export async function runInit(cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
export async function runUninit(cwd?: string, opts?: { dryRun?: boolean }): Promise<number>
```

cli.ts 接线（新增两处特判，仿 repair）：

```ts
if (meta.name === 'init') {
  program.command(meta.name).description(meta.summary)
    .option('--dry-run', '仅打印注入 diff 预览，不落盘')
    .allowExcessArguments(false)
    .action(async (options: { dryRun?: boolean }) => {
      process.exitCode = await runInit(undefined, { dryRun: options.dryRun })
    })
  continue
}
// uninit 同构：.command(meta.name) ... runUninit(undefined, { dryRun: options.dryRun })
```

- registry.ts 的 init/uninit 两条 `CommandMeta` 已存在（S1），description 去掉「计划 S13」后缀（stub → 真实，同 use/link 特判惯例）。
- 相对导入带 `.js`；`src/commands/init.ts` 目录模块直接单文件。

### 4.4 核心原语（导出，供单测）

**`locateConfigObject(source: string): { start: number; end: number } | null`**

定位宿主配置对象体的起止括号下标：优先匹配 `defineConfig(`，其次 `export default {`，取其后的第一个 `{` 开始，括号配对计数到闭合 `}`（规则细节见 §8 自决 2——允许 `defineConfig(` 与 `{` 之间换行）。

- 必须跳过字符串字面量与注释内的括号/引号（复用 rewriter `closingQuote` 的字符串感知思路 + 行/块注释跳过）。
- 找不到 `{` 或括号不闭合 → 返回 `null` → `InitConfigShapeError`：描述 `无法定位 umi 配置对象体。` / 下一步：`确认配置文件以 export default defineConfig({ 或 export default { 开头`。

**`commonAncestor(absPaths: string[]): string`**

求一组绝对路径的最近公共祖先目录（逐字符公共前缀，截到最后一个路径分隔符）。返回目录绝对路径（正斜杠归一化）。供 root 计算。

**`toRelSlashes(fromDir: string, toDir: string): string`**

`path.relative(fromDir, toDir)` + `.replaceAll('\\', '/')`；**若 `relative` 结果退化为绝对路径（Windows 跨盘符）→ 抛 `InitRootError`**（复用 rewriter 的跨盘符检测语义：`isAbsolute(rel) || /(^|\/)[a-zA-Z]:(\/|$)/.test(rel)`）。

### 4.5 root 与 alias 计算

**root 值**：

```
rootDir = workspace 根（findWorkspaceRoot(cwd)）
libDirs = Object.values(readProjectConfig(rootDir).libs)
          .map((rel) => resolve(rootDir, rel))        // lib 绝对路径（全部已注册，含未链接）
target  = commonAncestor([cwd, ...libDirs])            // 宿主 + 全部 lib 的最近公共祖先
root    = toRelSlashes(cwd, target)                    // 如 '../..'（正斜杠，无尾 '/'; target===cwd → '.'）
```

- `libs` 为空 → 直接提示（见 §5 错误表「无已注册 lib」），不进入注入。
- 跨盘符（如 lib 在 C:、宿主在 D:）→ `toRelSlashes` 抛 `InitRootError`。

**alias 集合**（peer dedupe，§1.1 背景 2）：

```
hostPkg  = 读宿主 package.json（resolve(cwd, 'package.json')）→ { dependencies, devDependencies }
hostDeps = new Set([...dependencies 键, ...devDependencies 键])        // 直接依赖面
for each libDir（全部已注册）:
  libPkg  = 读 libDir/package.json → peerDependencies 键（可缺省 → 空）
  for each peer ∈ libPkg.peerDependencies 键 ∩ hostDeps:
    alias[peer] = resolve(cwd, 'node_modules', peer).replaceAll('\\', '/')
                  // **绝对路径**（正斜杠）——SP0 实测「宿主实例绝对路径」修复；
                  // 不走 toRelSlashes（那是相对路径 + 跨盘符护栏，alias 语义不需要）；
                  // resolve 不要求路径存在（pnpm 软链会自洽）
```

- `alias` 为空（无交集）→ **注入段仍含 `utoopack.root`，`alias: {}` 省略不注入**（空对象无意义）；提示「未检测到需要 dedupe 的 peer（lib peer ∩ 宿主直接依赖 为空）」。
- 宿主 `package.json` 缺失 → `InitHostPkgError`：描述 `未找到宿主 package.json：<cwd>。` / 下一步：`确认在含 package.json 的项目目录运行 lpm init`。
- **alias 目标路径的探测顺序（pnpm hoist 落点，§8 自决 11）**：先查 `resolve(cwd, 'node_modules', peer)`，不存在则查 `resolve(rootDir, 'node_modules', peer)`（pnpm 可能把 peer hoist 到 workspace 根 node_modules）；两者都无 → 该 peer 跳过 + 提示（declared 但未安装，非 lpm 职责）。**取「实际存在」的那一个**，避免 alias 指向虚位路径。

### 4.6 交互闸门（init / uninit 对称；继承 S12 §4.5）

| 条件 | 行为 |
|---|---|
| `--dry-run` | 打印 diff 预览（§4.7）零写盘 exit 0 |
| 非 `--dry-run` 且 非 TTY | `InitInteractionError`：`需交互确认注入/摘除计划。\n下一步：改用 lpm init --dry-run 查看预览`（uninit 同文，命令名随命令）exit 1 |
| 非 `--dry-run` 且 TTY | 打印 diff 预览 + `clack.confirm({ message: '执行以上注入？（写入 <宿主配置路径>）', initialValue: false })`（**uninit 时 message 为 `执行以上摘除？（写入 <宿主配置路径>）`**）→ 取消 / 否 → 「已取消」exit 1；是 → 写盘 exit 0 |

- 闸门三态与 repair `runRepair` 的 `interactive`/isTTY 判定完全同构（[repair.ts](file:///d:/Seed/local-pack-manager/src/commands/repair.ts#L499-L530) 现成样板）。
- 零 clack 调用条件：`--dry-run` 或非 TTY 时，`confirm` 决不触发。

### 4.7 diff 预览渲染（init / uninit 专属，不动 renderPlan）

```ts
// src/commands/init.ts 内私有函数（不导出，不接 renderPlan——S9 单源契约限 link/unlink）
function printInjectDiff(hostPath: string, beforeLines: string[], afterLines: string[], mode: 'inject' | 'remove'): void
```

- 首行：`init dry-run 执行计划（不落任何盘、不执行任何子进程）：`（init --dry-run）／`uninit dry-run 执行计划（不落任何盘、不执行任何子进程）：`（uninit --dry-run）。TTY 确认时首行 `注入计划：`／`摘除计划：`。
- 次行：`  文件：<hostPath>`。
- 其后：行级 diff——新增行前 `+ `、删除行前 `- `、未变行 `  `。**只 diff 注入段覆盖的区间**（对象体），不做全文件 diff（宿主其余行不算改动）。
- 退出码：dry-run 成功 = 0；校验失败 = 1（同真实执行）；交互取消 = 1；help/version = 0。

### 4.8 写盘与原子性

- 注入/摘除写盘用 `writeTextFileAtomic(hostConfigPath, newContent)`（[atomic.ts](file:///d:/Seed/local-pack-manager/src/state/atomic.ts) 既有原语，文本原子写）。
- **幂等**：`lpm init` 时若已存在标记段 → `InitAlreadyInjectedError`：描述 `宿主配置已注入 lpm 片段。` / 下一步：`先 lpm uninit 摘除后再重新注入`。`lpm uninit` 时无标记段 → `InitNotInjectedError`（§5）。
- **标记段不完整（有 start 无 end）**：uninit 检测到 start 但未找到 end → **报 `InitIncompleteMarkerError`（I8）**：描述 `检测到不完整的 lpm 注入标记（缺结束标记）。` / 下一步：`请手工删除 config 中残留的 /* lpm-inject:start */ 后重试`——**绝不自动摘除不完整标记**（可能误删宿主配置），交用户手工处置。

### 4.9 完成提示（非错误，stdout）

- init 成功：
  ```
  已注入 utoopack 适配片段：<hostPath>
    root：<root 值>（覆盖 N 个已注册 lib 的公共祖先）
    dedupe：<M> 个 peer（a、b、…）
  若 lib 后续新增 peer，请重跑 lpm init 重新注入。
  ```
  - `M=0`（无交集，alias 未注入）→ dedupe 行改为 `未检测到需要 dedupe 的 peer（lib peer ∩ 宿主直接依赖 为空），仅注入 root`。
- uninit 成功：
  ```
  已摘除 utoopack 适配片段：<hostPath>（宿主原有 utoopack/alias 配置已还原）
  ```

---

## 5. 错误表（统一模板，继承 S12 §4.7；reportError 结构零改动）

| # | 错误类 | 场景 | 描述 / 下一步 |
|---|---|---|---|
| I1 | `InitConfigNotFoundError` | 宿主配置文件未找到 | `未找到 umi 配置文件（已检查 config/config.ts、.umirc.ts、config/config.js、.umirc.js）：<cwd>。` / `请在含 umi 配置的项目目录运行 lpm init`（**OCR L5 修复波**：消息并入 cwd，便于定位扫描目录） |
| I2 | `InitConfigShapeError` | 对象体无法定位 | `无法定位 umi 配置对象体。` / `确认配置文件以 export default defineConfig({ 或 export default { 开头` |
| I3 | `InitRootError` | root 计算跨盘符/无公共祖先 | `无法计算 utoopack.root（跨盘符或无公共祖先）：lib=<libs 清单>。` / `将 lib 与宿主放到同一盘符、或调整目录结构后重试` |
| I4 | `InitHostPkgError` | 宿主 package.json 缺失 | `未找到宿主 package.json：<cwd>。` / `确认在含 package.json 的项目目录运行 lpm init` |
| I5 | `InitInteractionError` | 非 TTY 需交互 | `需交互确认注入/摘除计划。` / `改用 lpm <init\|uninit> --dry-run 查看预览` |
| I6 | `InitAlreadyInjectedError` | init 已注入 | `宿主配置已注入 lpm 片段。` / `先 lpm uninit 摘除后再重新注入` |
| I7 | `InitNotInjectedError` | uninit 未注入 | `未检测到 lpm 注入片段。` / `先运行 lpm init 注入` |
| I8 | `InitIncompleteMarkerError` | 标记段不完整（有 start 无 end） | `检测到不完整的 lpm 注入标记（缺结束标记）。` / `请手工删除 config 中残留的 /* lpm-inject:start */ 后重试` |

- **无已注册 lib**（非错误，stdout 提示）：`当前没有任何已注册的 lib。\n下一步：先 lpm link <路径> 注册后再 init`（exit 0，不进入注入；与 link `--all` 空态同措辞口径）。
- 错误统一经 `reportError`（KNOWN 列表 = 上述 8 类 I1–I8 + 复用的 `WorkspaceNotFoundError`/`ManifestParseError`/`LpmConfigParseError`，因 init 调 findWorkspaceRoot 且读宿主 package.json 与 lpm.config.json）→ stderr + exit 1。**宿主不在任何 workspace 内时 findWorkspaceRoot 抛 `WorkspaceNotFoundError`**，入 KNOWN 套模板（描述沿用 W5，下一步 `请进入项目目录后运行 lpm`）→ exit 1。

---

## 6. 测试清单（取数命令 = `pnpm verify`）

**`tests/unit/init-root.test.ts`（新）——root / 公共祖先 / 相对路径计算**
- `commonAncestor`：同盘多 lib → 最近公共目录；单 lib → 其父目录；跨盘符输入 → 行为定义（返回盘符根或按实现约定，测试锁死）
- `toRelSlashes`：同级 `'.'`；上级 `'..'`/`'../..'`；正斜杠输出；Windows 跨盘符 → 抛 `InitRootError`
- root 集成：`{ cwd, libs }` 样本 → 期望 root 值（如 cwd=`D:/app/apps/web`、libs=`D:/app/libs/a`、`D:/app/libs/b` → 公共祖先 `D:/app` → root=`../../`；lib 含宿主同盘外目录等）

**`tests/unit/init-locate.test.ts`（新）——宿主定位 + 对象体定位**
- 候选文件名按序：`config/config.ts` 优先于 `.umirc.ts`；全部缺失 → `InitConfigNotFoundError`
- `locateConfigObject` golden：`export default defineConfig({...})` 多行；`export default {` 单行紧凑；字符串内 `{`/`}`（如 `antd: { theme: '{}' }`）；块注释/行注释内括号；嵌套对象；括号不闭合 → null；无 defineConfig → null
- 已注入检测：含 `/* lpm-inject:start */` → init 报 `I6`、uninit 可摘除
- **不完整标记**：仅含 `/* lpm-inject:start */` 无 end → uninit 报 `I8` + 零写盘（绝不自动摘除）

**`tests/unit/init-alias.test.ts`（新）——peer dedupe 集合计算**
- lib peer ∩ 宿主直接依赖 → alias 键集；空交集 → alias 省略；宿主 package.json 缺失 → `I4`；lib 无 peerDependencies → 空
- **探测顺序（§8 自决 11）**：peer 在 cwd/node_modules → 取该路径；仅在 rootDir/node_modules → 取该路径；两者皆无 → 跳过 + 提示

**`tests/unit/init-inject.test.ts`（新）——文本级注入/摘除（golden，仿 rewriter-samples）**
- 注入（追加模式）：对象体末尾插入标记段——三态分别断言：**空对象体**（`{}` → 无前置逗号）、**无尾逗号**（补逗号）、**有尾逗号**（复用原逗号）
- 合并模式（S14 方案 A）：宿主已有 `utoopack`/`alias` 键 → `injectIntoKey` 把 root/alias peer 合并进键体内部（`locateTopLevelKeyObject` 命中），**全文同名键只出现一次**；uninit 摘除 → 宿主键**逐字节还原**（含空键体 `{}`，**关键还原断言**）
- 追加模式遮蔽（legacy 路径）：宿主已有同名键但走追加 → uninit 摘除后宿主键保留原样
- 摘除：标记段连同注入时补的逗号删除。**byte 往返恒等（inject(uninject(x)) === x）仅在「宿主无尾逗号」fixture 上断言**；「宿主有尾逗号」fixture 断言摘除后为语义等价（原尾逗号被消费，语法合法），**不**断言 byte 恒等——见 §8 自决 1
- **多标记段一次摘除**：合并 + 追加并存（如 utoopack 合并 + alias 追加）→ `findAllMarkers` 找全、从后往前一次摘净
- CRLF/LF 保持；缩进保持；尾随换行保持（复用 rewriter 格式保持约定）

**`tests/unit/init-command.test.ts`（新）——runInit/runUninit 编排**
- `init --dry-run`：正常 → 首行 `init dry-run 执行计划…` + `+ ` 注入行 + 宿主配置 **byte 级零写盘** + exit 0
- `init` TTY：mock clack.confirm=true → 写盘 + 完成提示；false → 「已取消」+ 零写盘 exit 1
- `init` 非 TTY：`I5` 文案 + exit 1 + 零 clack 调用
- `init` 无已注册 lib → 提示 + 零写盘 exit 0
- `init` 已注入 → `I6` + 零写盘
- `uninit --dry-run`：`- ` 摘除行 + 零写盘 + exit 0；`uninit` 未注入 → `I7`；`uninit` TTY 确认 → 还原 + 提示
- 错误模板断言：I1–I8 逐条 `toContain('下一步：')`（描述子串断言）

**`tests/unit/stub.test.ts`（既有）**：init/uninit 从 stub 清单移除（不再是 `notImplemented`）→ 断言同步（如有引用）。

**`tests/e2e/cli.e2e.test.ts`（追加冒烟）**
- `lpm init --dry-run`（临时宿主：`config/config.ts` + 假 lib 注册 + 假 workspace）→ exit 0 + stdout 含 `init dry-run` + 宿主配置零写盘
- `lpm uninit --dry-run`（未注入）→ exit 1 + stderr 含 `未检测到 lpm 注入片段`
- 既有 `lpm --help` 回归钉保持（init/uninit 现为真实命令，help 列表不变）

**真实环境手测（归用户，不自动化；PRD §12 同口径）**
- BFM + ai_suit_tool：init 后 root 扩界解析可用（link 的 lib import 不报 Module not found）
- antd 暗色恢复（dedupe alias 生效、零报错）
- watch 性能：root 扩大后 dev server watch 是否明显变慢 → 决定后续是否注入 `watch.ignored`（§7）

---

## 7. 后续衔接

| 消费方 | 依赖的 S13 产出 |
|---|---|
| PRD §15 风险 1 收口 | SP0 结论「root 注入 + peer dedupe alias」由 S13 落地为可执行命令；真实环境手测后更新风险状态 |
| **待验项（真实环境手测后处置）** | ① root 扩大后 watch 性能 → 若变慢，下一波注入 `watch.ignored`（uninit 一并摘除）；② dedupe 列表动态化 → 当前以「重跑 init」约定承接，若真实使用痛感明显再评估自动重算 |
| S12 §7「S13 衔接」 | `--dry-run` 全局口径由 init/uninit 继承（§4.6/§4.7 已落实） |
| v1 收官 | S13 完成后 PRD §14 阶段表全部走完 → 用户收口（无 S14） |

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **标记段与前置逗号的精确规则（含空对象体与尾逗号两边界，golden 测试锁死）**：
   - 注入时先定位对象体闭合 `}`，取「最后一个非空白字符」。
   - **空对象体**（`{}`，即 `{` 后紧跟 `}`）：直接插入 `\n  /* lpm-inject:start */\n  <keys>\n  /* lpm-inject:end */\n`（**无前置逗号**——空对象无前键，加逗号产生非法 `{,`）。
   - **非空且末尾无尾逗号**（最后一个非空白字符 ≠ `,`）：插入 `,\n  /* lpm-inject:start */\n  <keys>\n  /* lpm-inject:end */\n`（补一个逗号作分隔）。
   - **非空且末尾有尾逗号**（最后一个非空白字符 = `,`）：直接插入 `\n  /* lpm-inject:start */\n  <keys>\n  /* lpm-inject:end */\n`（复用既有尾逗号作分隔，不补逗号）。
   - 摘除时从 `/* lpm-inject:start */` 定位，删到 `/* lpm-inject:end */` 行尾；**随后把「前一个非空白字符若是 `,` 则删除」**——即注入时补的逗号被删掉；但**若那是宿主原有的尾逗号，删除会使宿主配置少一个尾逗号**（语义等价、语法合法、git diff 一行）。见 §6 golden 断言对该边界如何表述（**byte 往返恒等仅在「宿主无尾逗号」fixture 上断言**）。
   - **合并模式（S14 方案 A，`injectIntoKey`）**：定位宿主同名键对象体（`locateTopLevelKeyObject`），在键体内插入标记段（键体比对象体深一层 → 每行 4 空格缩进）。**空键体**（`{}`）→ 无前置逗号、无前导 `\n`，start 标记与 `{` 紧贴、`}` 保持原位与 end 标记紧贴——保证 uninit 摘除后逐字节还原回 `{}`。**非空键体** → 同对象体三态逗号规则（补 `,` 分隔或复用尾逗号）。摘除逻辑同追加模式（前一个非空白字符是 `,` 则连逗号删；否则摘到前一非空白字符之后，吞掉标记行自身缩进——否则空键体合并段会残留 `{    }`，那 4 空格是 start 标记行的缩进、不属于宿主原内容）。
2. **`locateConfigObject` 的起始定位**：优先匹配 `defineConfig(`，其次 `export default {`；两者皆无 → `I2`。括号配对跳过字符串（含转义）与 `//`、`/* */`、`/** */` 注释。返回最外层对象体 `{` 与 `}` 的下标；`{` 后紧跟 `}`（空体）也须正确返回。
3. **root 值规范化**：`toRelSlashes` 输出 `target === cwd` 时用 `'.'`；不输出尾 `/`；Windows 盘符保留大写（不强制小写）。
4. **宿主「直接依赖」读取面**：`dependencies` + `devDependencies` 两段键并入 hostDeps（umi 项目 antd 常见于 dependencies，devDeps 也计入稳妥）；`peerDependencies` 不计入宿主面。
5. **lib peer 读取失败**：单个 lib 的 package.json 不可读 → 该 lib 跳过 dedupe 计算（不致命），不阻断 root 注入。
6. **不写运行留痕**：init/uninit 不调 `buildRunTrace`/`writeRunTrace`（§1.3 非目标）；`LastRunTrace.command` 联合类型不加值。
7. **diff 预览的区间**：只 diff 对象体（从 `locateConfigObject` 的 start 到 end 的源码行），前缀行（import/export 声明）不改动、不显示。
8. **e2e 冒烟先 `pnpm build`**：S12 T3-1 教训——e2e 走 dist/cli.js，必须先重建（实现 plan 内建）。
9. **交互拒绝消息**：S12 OCR-8（P2 候选）「rejectInteractiveDryRun helper 抽离」的触发信号 = **第四个命令接入 dry-run 时**——S13 init/uninit 即第四、五个接入。**本阶段顺手抽 helper**（`src/commands/reject-interactive.ts` 或 init.ts 内导出），forget/preset/dir/init/uninit 五处共用；若评审认为越界则退回只做 init/uninit 两处局部文案。
10. **`InitRootError` 的 libs 清单展示**：只列 lib 相对路径前若干条（如 ≤3 + 计数），避免超长报错。
11. **alias 目标路径探测（§4.5）**：先 `cwd/node_modules/<peer>`，后 `rootDir/node_modules/<peer>`（pnpm hoist 落点）；两者皆无 → 跳过该 peer + 提示。**取实际存在者**，不指向虚位路径。
12. **宿主配置源码的 BOM 剥离**：读宿主配置文件后，`stripBom`（复用 workspace.ts 的 `stripBom` 逻辑）再定位对象体——防 BOM 前缀干扰首行定位；写盘时**不写回 BOM**（剥离后的原文写回，与 rewriter 的 BOM 处理口径一致：S5 改写后不保留 BOM）。

---

## 9. 评审 Backlog

> 自审（multi-lens-review）结果、修复对照、终审意见在此追加。

### 自审（multi-lens-review，2026-09-29，场景 B 技术方案：六手法 + 架构师/资深开发/资深测试/交付运维面板）

**结论**：1 矛盾 / 4 盲点（全部已修）/ 3 优化（全部已处置）。最危险项 = S-1（§6 与 §8 对「有尾逗号宿主」的往返恒等断言互相打架——若放任会让实现者在两个互相矛盾的契约里二选一）。

| # | 级别 | 来源透镜 | 问题 | 处置 |
|---|---|---|---|---|
| S-1 | P0 矛盾 | 手法 1 + 手法 3 | §6 golden「往返恒等（byte 级）」与 §8 摘除规则在「宿主对象体原有尾逗号」时冲突：按 §8 摘除会连带删掉原尾逗号 → 往返非 byte 恒等。两处规定打架 | **已修**：§8 自决 1 明确「有尾逗号」态复用原逗号；§6 golden 断言改为「byte 恒等仅在无尾逗号 fixture 断言，有尾逗号断言语义等价」 |
| S-2 | P1 盲点 | 手法 1（操作序列/接管时刻） | 标记段不完整（有 start 无 end）时 uninit 行为未定义——自动摘除可能误删宿主配置 | **已修**：新增 I8 `InitIncompleteMarkerError`，绝不自动摘除，交用户手工处置；§3.3/§4.8/§5/§6 同步 |
| S-3 | P1 盲点 | 手法 3（一致性） | §4.5 alias 函数名 `toRelSlashesAbs` 未在 §4.4 定义；且 alias 语义是**绝对路径**，却用相对路径函数名——接口矛盾 | **已修**：改为 `resolve(cwd,'node_modules',peer).replaceAll('\\','/')`，并注明不走 toRelSlashes |
| S-4 | P1 盲点 | 手法 5（平台机制断言） | pnpm 可能把 peer hoist 到 workspace 根 node_modules（非宿主 node_modules）——alias 只指 cwd/node_modules 会落空指向虚位路径 | **已修**：§4.5 + §8 自决 11 定义探测顺序（cwd → rootDir，取实际存在者） |
| S-5 | P1 盲点 | 手法 3（引用×定义） | §5 KNOWN 列表遗漏 `WorkspaceNotFoundError`——宿主不在 workspace 内 findWorkspaceRoot 抛错不被捕获 | **已修**：入 KNOWN 套模板（W5 描述 + 请进入项目目录） |
| S-6 | P2 | 手法 4（输入枚举） | 宿主配置源码 BOM 前缀干扰首行定位；写盘 BOM 口径未定义 | 采纳 → §8 自决 12（stripBom + 不写回，对齐 S5） |
| S-7 | P2 | 手法 4（输入枚举） | §6 root 示例 `../../../` 算错（D:/app/apps/web → 公共祖先 D:/app → 应为 `../../`）——错误示例会误导实现 | **已修**：示例改正为 `../../` |
| S-8 | P2 | 手法 3（一致性） | §3.1 示意图「无尾逗号补逗号」形态与 §8 精确规则（空体/有尾逗号两态）未声明示意性质 | 采纳 → §3.1 加注（图为可读示意，非逐字节规范） |

**自洽确认区（攻过但没攻破）**：
- 手法 3 表格一致性：§2 裁决 1–6 ↔ §4 接口 ↔ §5 错误表 ↔ §6 测试逐条对齐（裁决 3 root 含宿主目录 ↔ §4.5 公式含 cwd ↔ §6 root 示例）；§4.6 交互闸门三态 ↔ §2 裁决 2 ↔ S12 §4.5 一致。
- 手法 1 幂等/中断：init 已注入 → I6；uninit 未注入 → I7；写盘全走 writeTextFileAtomic（原子写）→ 中断重跑收敛。
- 手法 2 字段审计：S13 **零新增持久化字段**（无 .lpm 文件面、不扩 LastRunTrace.command）；注入状态自感知于宿主配置标记段——无字段生命周期残留风险。
- 手法 6 可逆性：init（注入）与 uninit（摘除）互逆，均有 TTY 确认；**合并进键设计**（S14 方案 A 定版：不产生第二个同名键，注入行以标记段包裹、插进宿主键体内）保证 uninit 后宿主原键自动恢复——无不可逆操作。
- 角色面板：架构师（locateConfigObject 单一职责、reportError 结构零改动、无第二真相——§8 自决为唯一逐字节规范）；资深测试（golden fixture 覆盖 CRLF/LF、BOM、空体、尾逗号、单行紧凑、遮蔽、不完整标记；e2e 先 build 内建）；交付运维（回滚 = uninit / git，诊断 = 错误模板）。

### 实现期裁定（T6 收口，2026-09-29）

- **OCR-8（S12 P2 候选「rejectInteractiveDryRun helper 抽离」）不触发**：该重构的触发信号 = 第四个命令接入「交互遇 --dry-run 拒绝」；而 init/uninit 遇 `--dry-run` 是**正常预览**（不是拒绝），其拒绝形态是**非 TTY**（与 repair 同构）——语义与「交互遇 --dry-run 拒绝」不同，故 §8 自决 9 的「顺手抽」经实现期裁定**否决**。五处共用待未来真正接入「交互遇 --dry-run 拒绝」的第五个命令时再抽。
- **§8 自决 1–12 全部按 plan 落地**，含三处实现期修正（均由 T4/T5 收敛、测试锁定）：
  1. **alias 键无引号**：`buildFragment` 输出 `  ${k}: '${v}',`（键不带引号），与 plan Task 4 草案 `  '${k}': '${v}',` 不同——alias 目标以简单标识符为常，省引号更贴近 umi 惯例；golden 断言 `react: 'D:/h/node_modules/react'` 锁定。
  2. **单层缩进**（§8 自决 1 形态）：`injectFragment` 插入形态为 `'\n' + indented`（indented 每行 2 空格）；plan 草案 `'\n  ' + indented` 会造成双层（4 空格）缩进，实现期收敛为单层 2 空格，与 §3.1 示意一致。
  3. **byte 恒等仅无尾逗号宿主**（§6/§8 自决 1）：`removeFragment` 的 byte 往返恒等断言只在「宿主无尾逗号」fixture 上做；「宿主有尾逗号」fixture 断言语义等价（原尾逗号被消费）。
  4. **方案 A 合并进键体（S14 定版，2026-09-30）**：`injectIntoKey` 键体内容每行 4 空格缩进（比对象体 2 空格深一层）；**空键体 `{}`** 注入时无前导 `\n`、start 标记与 `{` 紧贴（`}` 保持原位），保证摘除逐字节还原回 `{}`；`removeFragment` 摘除时若无前导逗号则摘到**前一非空白字符之后**（吞掉标记行自身缩进），避免残留 `{    }`。

### OCR 修复波裁定（用户提交 `8619bd1` 后执行，2026-09-29）

- **OCR 轮结果**：diff 模式 `30a535a..8619bd1`，3 代码文件 / 14 意见 / 0 critical / 2 high / 3 medium / 9 low（~1.57M tokens / 3m10s；完整命令行与 Summary 落盘账本）。
- **ADDRESSED（11）**：H1 alias 键加引号（`JS_IDENT_RE`，react-dom/@ant-design/icons 等非标识符包名）；H2 反引号模板字符串（`skipTemplate` + `${...}` 插值递归 + 共享 `skipIgnorable` dispatch 单源）；M1 `hasShadow` → `hasTopLevelKeys`（对象体深度 0 键扫描，注释/字符串/嵌套对象不误报）；M2 `buildAliasMap` 返回 `{ alias, skipped }` + `runInit` 打印「peer 已声明未安装」提示；M3 POSIX 公共前缀到根返回 `'/'`；L1/L2 死 import；L4 init 不完整标记报 I8（不再报 I6 指到会撞 I8 的 uninit）；L5 I1 消息并入 cwd（§5 表已同步）；L6 deps/devDeps 补 `!Array.isArray`；L8 扫描 dispatch 重复随 H2 合并。
- **驳回（2）**：L3 `clack.isCancel(ok)` 冗余——与既有 repair/link 交互惯例一致（S9 spec §8.2 先例），保持；L9 BOM 写回——§8 自决 12 有意设计（与 S5 口径一致）。
- **候选（1）**：L7 runInit/runUninit 编排重复抽 helper——触发信号 = 第三个对称命令出现。
- **修复波后终态**：`pnpm verify` exit 0 = typecheck 0 + build + unit **34 文件 / 579 例**（573 + 6 新用例）+ e2e **1 文件 / 42 例**。改动（5 个 `M`）留待用户 commit。

### S14 追加记录：link/unlink 自动联动（2026-09-30，用户提需）

**背景**：S13 的 init/uninit 是独立手动命令——「脚本得有人想起来跑它」的毛病复发（link 后忘 init → dev 报 Module not found；unlink 后忘 uninit → 配置残留）。用户提需：link 后自动 init、unlink 全部断开后自动 uninit。

**设计（只增不改，S13 全部冻结签名/原语零改动）**：

1. **新增 workspace 级宿主定位** `findHostConfigInWorkspace(ws)`（utoopack.ts）：遍历 workspace 成员（含根），候选文件名按序，返回 `{ dir, hostPath }`——link/unlink 在 workspace 根运行，umi 配置可能在成员子包（如 `web/.umirc.ts`），须按成员目录找而非 cwd。
2. **新增自动联动函数**（init.ts）：
   - `locateHostConfigInWs(rootDir)`：loadWorkspace + findHostConfigInWorkspace
   - `autoInitAfterLink(rootDir)`：复用 S13 原语（buildRootValue/buildAliasMap + S14 一站式 `injectAdaptation`——按宿主有无同名键自动「合并进键」或「追加新键」），跳过交互闸门直接写入；幂等（已注入 → already-injected）；非 umi 宿主 → no-umi-host；无 lib → no-libs；失败吞错返回 reason（不阻断 link 主流程）
   - `autoUninitAfterUnlinkAll(rootDir)`：复用 removeFragment；未注入 → not-injected；**不完整标记绝不自动摘除（I8 铁律）**→ stderr 警告交用户手工；失败吞错
3. **触发点**（成功路径，dry-run 天然不触发）：
   - link：**所有执行路径**之后都自愈补注入——`executeLinkPlan`（install 之后、watch 之前，watch 前台驻留会阻塞注入）＋ **直通/交互两处「计划为空」出口**（全部命中「已链接、跳过」的空跑）。抽 `ensureAutoInitAfterLink` 助手（link.ts）：无条件调用 `autoInitAfterLink`，其幂等自守（已注入/非 umi 宿主/无已注册 lib 均静默跳过）。**自愈语义**：手动 `lpm uninit` 摘掉注入后链接仍开着时，重跑 `lpm link`（哪怕空跑）即补回注入——`lpm init` 只看已注册 lib、不看链接状态，联动判断随之对齐
   - unlink：`executeUnlinkPlan` 的「全部断开（state 清空）」分支——部分断开不摘除（可能还有 lib 在联调）
4. **失败语义**：联动失败只 stderr 警告 + 提示手动 `lpm init`/`lpm uninit`，不影响 link/unlink 退出码（联动是附加动作，主流程已完成）。

**测试**：`tests/unit/init-auto.test.ts`（新，11 例）——宿主定位（子包命中/无宿主）、自动注入（成功/幂等/合并提示/非 umi/无 lib）、自动摘除（成功/未注入/不完整标记 I8/非 umi）；`tests/unit/init-inject.test.ts` 增 6 例方案 A 合并模式（合计 20 例）；`tests/unit/link-command.test.ts` 增 1 例 S14 自愈回归（空跑 link --all 补注入）。**终态实测（取数命令 `npx vitest run tests/unit`）**：unit **35 文件 / 599 例**；`npx vitest run tests/e2e` = **1 文件 / 42 例**；合计 36 文件 / 641 例，exit 0。

**真实环境验证（BFM + ai_suit_tool，2026-09-30）**：`lpm unlink`（唯一库）→ 自动摘除 `.umirc.ts` 的 lpm-inject 段、用户原 `utoopack: {}` 保留；`lpm link --watch` → 自动注入成功、tokens.css 被本地库正确解析；`pnpm dev` 全量编译通过，health 200。**方案 A 复验（同日）**：宿主 `utoopack: {}` 时 re-init 走合并进键（`root` 并入键体、alias 追加，全文单 utoopack 键），`web` 目录 `npx tsc --noEmit` 零错误（无 TS1117/TS2783）；`lpm uninit --dry-run` 预览摘除后宿主键逐字节还原 `{}`。

**待验项顺延**（S13 §7 不变）：watch 性能、dedupe 动态化。


