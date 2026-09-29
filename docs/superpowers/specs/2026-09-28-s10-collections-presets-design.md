# S10 集合与预设 —— 设计 spec

- 阶段：S10（PRD §14 行 409：`--last/--all/--preset 互斥、save/preset`；依赖 S6；承接 review 修复 **P1 P2**）
- 上级依据：PRD `docs/prds/2026-09-25-lpm-v1-prd.md` §7 行 255–271（命令全集 / 三者互斥）、§8 行 272–293（主列表虚拟项 / 管理界面先例）、§9 行 295–313（`presets` 字段与四文件）、§10 行 337–344（**last.json 更新规则表**）、§11 行 346–364（错误即建议 / 逃生门）、§13 行 377–387（**验收 4 批量 link 仅 1 次 install、验收 5 unlink --all → link --last 恢复**）、§14 行 389–417、附录 A 行 466–467（P1 / P2）
- 上游 spec：S6 §8 行 450（last.json 已按 §10 规则写入）、S7 §8 行 301（unlink --all 的 last 写入已就位；「--last/--preset 恢复操作消费 readLast」= **link --last 恢复链接集**，即 PRD §13 验收 5 字面）、S9 §4.3（冻结面）、§4.5（主列表组装点与虚拟项预留）、§7 行 455（S10 行）
- 状态：**待用户终审**（PRD §14 行 395：spec 评审通过前不动代码）
- 基线：HEAD `0f9407d`（工作树 clean）；`pnpm verify` exit 0 = typecheck 0 + build + unit **24 文件 / 395 用例** + e2e **1 文件 / 28 用例**（2026-09-28 实跑）

---

## 1. 目标与非目标

### 1.1 目标

把「一批库」当作一等公民：既能**存下来**（预设），也能**按记录再链一次**（上次链接的），让「切回上次的联调现场」不再靠翻 shell 历史。

1. **集合级直通**（PRD §7 行 260）：`lpm link --last` / `--all` / `--preset <名>`，三者互斥且不与位置参数同用；展开成名字数组后**复用既有 `buildLinkPlan`**（计划 / dry-run / 执行全不改）
2. **预设的存与删**（PRD §7 行 264–265）：`lpm save <预设名>`（当前链接集存为预设）、`lpm preset rm <名>`（直通删除）；预设存进**已有**的项目级 `lpm.config.json` 的 `presets` 字段（S4 期已预留），**零新增状态文件**
3. **`lpm preset` 无参数 = 列表管理**（PRD §7 行 265 交互列）：看（名字 + 项数 + 成员）+ 多选删除（二次确认），与 §8.2「管理注册」同形
4. **link 主列表虚拟项**（PRD §8 行 278，S9 划界给 S10）：新增「快捷」组，含「全部已注册」「上次链接的（**无记录则隐藏**）」
5. **last.json 刷新口径补全**（PRD §10 行 341）：集合级操作**一律**刷新——哪怕展开后只有 1 个名字、哪怕全部命中「已链接、跳过」；修掉 S6 落地时「按 target 数 ≥ 2 判」对集合级操作的遗漏

### 1.2 非目标（明确划界，防范围蔓延）

| 不做 | 归属 / 依据 |
|---|---|
| `lpm forget` / `lpm dir` / link 主列表的「管理注册…」子界面 | S11；PRD §14 行 410 |
| `--dry-run` 全面化（含 save / preset）、未知命令模糊纠错、错误即建议全局化 | S12；PRD §14 行 411 |
| 预设菜单里「直接用它链接」（Q6 已否）、预设重命名 | 无 PRD 依据；PRD §8.2「加法/减法心智隔离」反对在管理界面混入执行动作 |
| `lpm unlink --last` / `--preset` | PRD §7 行 261 的 unlink 行只有 `[--all] [--dry-run]`；S7 §8 行 301 的「恢复操作」指 `link --last`（PRD §13 验收 5 字面） |
| 运行留痕（`.lpm/last-run.json`）覆盖 save / preset | S8 §4.3 的 `LastRunTrace.command` 只认 `link`/`unlink`/`repair`（冻结面）；`lpm.config.json` 进 git，`git diff` 即留痕 |
| 新增状态文件 / 新增运行时依赖 | PRD §14 行 391（技术栈定版）；本 spec 只写**已有**的 `presets` 字段 |
| 真 PM（npm / yarn）链路的集合操作验证 | PRD §12 行 375：实验性 PM 走 smoke 手测清单（归用户） |
| 直通路径（带位置参数）既有输出与行为的任何改动 | S6/S7 已验收冻结；本 spec 只**新增**集合级入口与虚拟项 |

---

## 2. 关键裁决（brainstorming 2026-09-28，7 问全收敛）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | S10 交付边界是否含交互侧两块（虚拟项 / `lpm preset` 列表管理） | **两块都做**。PRD §14 行 409 把 `save/preset` 列入 S10 交付物；S9 §7 行 455 已把「虚拟项接进同一列表渲染」明写为 S10 的接续面（组装点已留） | PRD §8 行 278、§14 行 409；S9 spec §7 行 455、§4.5 |
| 2 | `--last` / `--all` / `--preset` 是否进交互 | **只走直通**：拿来就跑，不进任何菜单（仍会弹既有的非 lpm 三选一 / monorepo 让选）。PRD §7 行 260 把三者写在 link 的「直通用法」列；「无参数」才是交互入口（行 260 交互列） | PRD §7 行 260 |
| 3 | 交互勾选多个算不算「link 多个」（刷新 last） | **≥ 2 个即刷新**，只勾 1 个不动（PRD §10 行 342「link 单个（增量）→ 不动」）。**现有代码已满足**（`executeLinkPlan` 按 target 数 ≥ 2 判），S10 只补断言 | PRD §10 行 341–342 |
| 4 | `lpm save` 撞名（PRD 未写） | **拒绝并提示**：报「预设名已存在」+ 两条出路（`lpm preset rm <名>` 先删 / 换名）。理由：覆盖是破坏性且事后无痕；`save` 在 PRD §7 行 264 的交互列是「—」，引入询问会把纯直通命令变半交互 | PRD §7 行 264、§11 行 346（错误即建议）、§16 行 446（直通本无确认环节） |
| 5 | 预设 / 上次记录里出现**已不在注册表**的名字 | **直通 = 整批停 + 报错**（列出全部失效名字，一个都不链，且在任何写盘之前失败）；**交互虚拟项 = 前置剔除 + 提示**（不连累同批其它勾选项）。不对称是刻意的：直通是用户点名（沿用 S6「遇错即停」，直通零副作用更硬），交互是勾选（沿用 S9 §4.5 为「零命中 / 注册值损坏」立的同一条规矩） | PRD §11 行 358（遇错即停 + 先 pnpm add）、S9 §4.5 前置剔除段、§8 自决 9 |
| 6 | `lpm preset` 无参数的菜单能干什么 | **看 + 多选删除**（二次确认），功能等价 `lpm preset rm <名>`；不加「直接执行链接」、不做选中后子菜单。与 PRD §8.2「管理注册」完全对称 | PRD §8 行 279–284、§7 行 265 |
| 7 | 三个开关怎么接到代码里 | **扩 `LinkOptions`**：加 `last?` / `all?` / `preset?` 三个**可选**字段，入口仍只有 `runLink` 一个。`runLink(targets, opts, cwd)` 签名一字不动；三字段缺省时行为与 HEAD 完全一致（既有 39 + 35 例断言即判据） | **松动 S9 §4.3「`LinkOptions` / `UnlinkOptions` 不扩字段」的字面**——该句是 S9 对**自身范围**的界定（原文「本 spec 不改其形参」），非永久禁令；本裁决由用户 2026-09-28 明确拍板；被否的两个方案（新增独立入口 `runLinkCollection` / cli 层展开）与否决理由见 §9「自洽确认区」 |

---

## 3. 数据流

### 3.1 集合级直通（`--last` / `--all` / `--preset <名>`）

```
lpm link --preset 前端   [--watch] [--dry-run]
  ├─ 0. 参数校验（互斥；preset 名非空）——在定位 workspace 之前，零副作用
  ├─ 1. linkPreflight(cwd)          ← S9 既有：findWorkspaceRoot → loadWorkspace → readProjectConfig → PM
  ├─ 2. 展开集合（§4.4）
  │      --all     → Object.keys(cfg.libs)                  （JS 对象键序）
  │      --last    → readLast(rootDir).names
  │      --preset  → readPresets(cfg).entries[名]
  │      ── 统一过一遍展开期预检（名字 ∈ cfg.libs？注册值是字符串？）：有问题项 → 一次性列出 → 报错退出（零写盘）
  ├─ 3. readState(rootDir)          ← S9 既有
  ├─ 4. buildLinkPlan({ targets: names, …, forceLastWrite: true })
  │      ── 计划 / 幂等跳过 / 非 lpm 三选一 / monorepo 让选 / 改写聚合 / peer 警告：全部复用，一行不改
  ├─ 5. dry-run？ → renderPlan(view,'dry-run') 后 exit 0（零写盘零子进程）
  └─ 6. executeLinkPlan → state → package.json → install → **last** → watch → 完成提示
```

### 3.2 `lpm save` / `lpm preset`

```
lpm save 前端                        lpm preset            lpm preset rm 前端
  ├─ 校验预设名（§4.7）                 ├─ 非 TTY → 一行提示 + exit 1        ├─ readProjectConfig + readPresets
  ├─ findWorkspaceRoot                 ├─ readProjectConfig + readPresets   ├─ 名不在预设表 → 报错 + 列可用
  ├─ readProjectConfig                 ├─ 无任何条目 → 告知 + exit 0        ├─ 删除该键（删空则移除字段）
  ├─ readState → 无/空 → 报错           ├─ clack.multiselect（多选）          ├─ writeProjectConfig（原子写）
  ├─ 撞名 → 报错 + 两条出路              ├─ 空选中 → exit 1                   └─ 打印「已删除预设：xxx」exit 0
  ├─ names = keys(state.links).sort()   ├─ 二次确认（默认否）→ 答否/取消 exit 1
  └─ writeProjectConfig（读-改-写）      └─ 逐个删 → 逐行打印 → exit 0
```

### 3.3 link 主列表（S9 组装点新增「快捷」组）

```
pickLinkTargets(cand, lastNames)          ← lastNames 由 runLinkInteractive 读 readLast 后传入
  ├─ 快捷（N）   「全部已注册（N）」      ← N ≥ 1 时出现
  │              「上次链接的（N）」      ← last.json 存在且 names 非空时出现；两项皆不可用则整组不出现
  ├─ 已注册（N） ← S9 现状
  ├─ 扫描发现（M）← S9 现状
  └─ 其他        ← S9 现状
提交后：含哨兵项 → 展开并入勾选集合（「其他…」先弹输入，同 S9）；展开时过滤失效名字 + 逐行提示
```

---

## 4. 接口与行为契约

### 4.1 命令面

| 命令 | 形态 | 说明 |
|---|---|---|
| `lpm link <名字\|路径>... [--watch] [--dry-run]` | 直通（S6/S9 现状，**零改动**） | — |
| `lpm link --last` | 直通（新） | 链接 last.json 记录的名字集 |
| `lpm link --all` | 直通（新） | 链接全部**已注册** lib（`cfg.libs` 的全部键） |
| `lpm link --preset <名>` | 直通（新） | 链接指定预设 |
| `lpm link`（无参数、无开关） | 交互（S9 现状 + 虚拟项） | §4.10 |
| `lpm save <预设名>` | 直通（新） | 当前链接集存为预设；无参数无交互 |
| `lpm preset` | 交互（新） | 列表管理：看 + 多选删除 |
| `lpm preset rm <名>` | 直通（新） | 删除指定预设 |

`--watch` / `--dry-run` 可与三个集合开关叠加；三个开关彼此互斥、且不与位置参数同用（§4.5）。

### 4.2 分层与文件

```
src/commands/preset.ts    # 新增：save / preset 两条命令 + 预设表守卫（readPresets）+ PresetError
src/commands/link.ts      # 改动：LinkOptions 扩 3 个可选字段；集合展开（内部函数）；虚拟项接入 pickLinkTargets
src/cli.ts                # 改动：link 加 3 个 option；save / preset 从 stub 循环提出来接线
tests/unit/preset-command.test.ts    # 新增
tests/unit/link-collection.test.ts   # 新增
tests/unit/link-interactive.test.ts  # 扩展（虚拟项）
tests/e2e/cli.e2e.test.ts            # 追加集合级与预设的错误路径
```

写入路径单源不变：项目级配置一律走 `writeProjectConfig`（`src/state/index.ts`，原子写）；last 一律走 `readLast` / `writeLast`；计划渲染一律走 `renderPlan`（S9）。

### 4.3 公共 API 面

**冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3、S8 §4.3、S9 §4.3 所列公共 API **签名**不变；`runLink(targets, opts, cwd)` / `runUnlink(targets, opts, cwd)` 形参不变；**直通路径行为零变化**。唯一松动的字面 = S9 §4.3「`LinkOptions` / `UnlinkOptions` 不扩字段」（裁决 7；`LinkOptions` 仅**追加可选字段**，`UnlinkOptions` 不动）。

```ts
// ── src/commands/link.ts（LinkOptions 追加 3 个可选字段；runLink 签名不变）──
export interface LinkOptions {
  watch?: boolean
  dryRun?: boolean
  /** S10：链接 last.json 记录的集合（与 all / preset 三者互斥，且不与位置参数同用） */
  last?: boolean
  /** S10：链接全部已注册的 lib（Object.keys(cfg.libs)） */
  all?: boolean
  /** S10：链接指定预设；空串等同非法（§4.5） */
  preset?: string
}

// ── src/commands/preset.ts（全部新增）──
/** 预设相关错误（命令域；沿用 S6/S7「错误类归命令文件」先例） */
export class PresetError extends Error

/** 预设表守卫后的视图（只读）。顶层 `presets` 存在但非对象 → 抛 PresetError（不吞） */
export interface PresetView {
  /** 原样保留的 presets 对象（含损坏条目与未知字段）——**读-改-写**的写回基线，防保存时丢数据 */
  raw: Record<string, unknown>
  /** 合法条目：预设名 → 名字数组（元素全为字符串；空数组属合法条目） */
  entries: Record<string, string[]>
  /** 损坏条目名：值不是「字符串数组」（non-array / 含非字符串元素） */
  corrupt: string[]
}
export function readPresets(cfg: ProjectLpmConfig | null): PresetView

/** 存预设（当前链接集 → `cfg.presets[名]`）。返回退出码（0/1） */
export async function runSave(name: string, cwd?: string): Promise<number>
/** `lpm preset`：args=[] → 交互列表管理；['rm', 名] → 直通删除。返回退出码（0/1） */
export async function runPreset(args: readonly string[], cwd?: string): Promise<number>
```

**错误传播契约**（两侧各一个 `reportError` 同型 helper，与 link/unlink 现有写法同形）：

- `link.ts` 的 `reportError` 的 `KNOWN` 列表**追加 `PresetError`** —— `lpm link --preset <名>` 会经 `readPresets` 抛该错误（跨命令 import 先例：`unlink.ts` 已 import `link.ts` 的 `resolveTarget`）
- `preset.ts` 内建自己的 `reportError`：`KNOWN` = `PresetError` + `WorkspaceNotFoundError`（`findWorkspaceRoot`）+ `LpmConfigParseError`（`readProjectConfig`）+ `LpmStateParseError`（`readState`）；**其余错误 rethrow**（不吞未知异常，与 link/unlink 同口径）
- 依赖方向单一：`link.ts → preset.ts`；`preset.ts` **不**反向 import link —— 故 `preset rm` 只按**名字**删除，不走 `resolveTarget` 的路径解析（与 PRD §7 行 265 字面「`lpm preset rm <名>`」一致）

### 4.4 集合展开契约

内部函数（**不导出**）：

```ts
// src/commands/link.ts
async function resolveLinkCollection(
  opts: LinkOptions, cfg: ProjectLpmConfig | null, rootDir: string,
): Promise<{ names: string[]; source: 'last' | 'all' | 'preset' }>
```

| 来源 | names | 展开期预检 | 失败（抛 `LinkArgumentError`） |
|---|---|---|---|
| `--all` | `Object.keys(cfg.libs)`（JS 对象键序，即注册写入顺序） | 非空；**每个键的值都是字符串** | 空 → 「当前没有任何已注册的 lib。先 `lpm link <路径>` 注册」 |
| `--last` | `readLast(rootDir).names` | last.json 存在；`names` 非空；**每个元素都在 `cfg.libs` 且注册值是字符串** | 无文件 / 空数组 → 「没有上次链接的记录。先做一次批量 link（一次给 ≥ 2 个目标、或 `--all` / `--preset`）建立记录」 |
| `--preset <名>` | `readPresets(cfg).entries[名]` | 该名存在、合法、非空；**每个元素都在 `cfg.libs` 且注册值是字符串** | 不存在 → 「预设不存在：<名>。可用预设：a、b」（无预设时 → 「当前没有任何预设」）；损坏（∈ `corrupt`）→ 「预设 <名> 内容损坏（应为字符串数组）。可 `lpm preset rm <名>` 删除后重存」；空数组 → 「预设 <名> 是空的。先 `lpm save <名>` 写入内容」 |

> **注：`--last` 的记录只能由 link / unlink 建立，`lpm save` 不写 last.json**（PRD §10 行 337–344 的写入面只有 link 的「多个 / `--last` / `--all` / `--preset`」与 unlink 的「`--all` / 拆至清空」）。故该错误文案**不得**建议用户去 `lpm save`。`lpm save` 建立的是**预设**，要用它得走 `lpm link --preset <名>`。

**展开期预检的两类问题项（都在任何写盘之前判定）**：

1. **名字不在注册表**（`Object.hasOwn(cfg.libs, name)` 为假）—— 场景：该 lib 被 `lpm forget`（S11）移除，或 `lpm.config.json` 被手改
2. **注册值损坏**（`typeof cfg.libs[name] !== 'string'`）—— 场景：`lpm.config.json` 被手改坏（与 S9 §4.5 交互侧的「注册值损坏」同一判定、同一文案族）

命中任一 → **一次性列出全部问题项**再报错：

```
预设 前端 里有 2 个名字已不在注册表：@t/a、@t/b。
  用路径重新注册：lpm link <lib 路径>
  或修掉这个预设：lpm preset rm 前端 后重新 lpm save 前端
```

要点：

- **① 一个都不链**（直通侧口径，裁决 5）
- **② 这两类**失败发生在 `buildLinkPlan` 之前 → **不会**留下任何已落盘的「注册 upsert」（S6 直通语义是 upsert 允许已发生；集合级操作**不继承**这个副作用）
- **③ 其余错误不在此列**：lib 目录已删 / `package.json` 缺失 / 零命中依赖（`LinkTargetError`）/ 非 lpm 本地链接（三选一）等，仍由 `buildLinkPlan` 在**循环中途**抛出——此时**此前合法项的注册 upsert 可能已落盘**（与 S6 直通完全同口径，不回滚）。理由：不引入第二份真相——目录、入口、依赖命中的判定归 `checkLib` / `findDependents`，预检里再写一份必然漂移
- ④ 名字按键字面匹配（`Object.hasOwn`），不做大小写 / 空白规范化（与 S6 `resolveTarget` 的注册名查找同口径）
- ⑤ `last.json` 的 `names` 元素若不是字符串（手改出的脏值）：按「名字不在注册表」处理（`Object.hasOwn` 键化后判假）→ 报错指出该元素，**不崩**
- ⑥ 展开结果不额外去重：`buildLinkPlan` 既有 `seenRaw` / `seenKey` 去重（同写法、同 key 两条路都已覆盖）

### 4.5 互斥与参数校验

在 `runLink` 的**第一行**执行（早于 `linkPreflight`：不定位 workspace、不打印「检测到包管理器」、零写盘）。**判定顺序固定**：三者互斥 → 与位置参数互斥 → `--preset` 名为空：

| 序 | 情形 | 判定 | 结果 |
|---|---|---|---|
| 1 | 三个开关同时给了 ≥ 2 个 | `[opts.last === true, opts.all === true, opts.preset !== undefined]` 中真值数 ≥ 2 | `LinkArgumentError`：「--last / --all / --preset 三者互斥，请只用一个。用法：lpm link --last \| --all \| --preset <名>」 |
| 2 | 开关 + 位置参数同时给 | `targets.length > 0` 且任一开关为真 | `LinkArgumentError`：「--last / --all / --preset 不能与 <名字\|路径> 同时使用；要链接指定目标请直接给名字或路径」 |
| 3 | `--preset` 名为空 / 全空白 | `typeof opts.preset === 'string' && opts.preset.trim() === ''` | `LinkArgumentError`：「--preset 需要一个预设名（用法：lpm link --preset <名>）」 |

三项均 → 退出码 1，且**不读盘不写盘**（`reportError` 打印 message 后 return 1）。`--preset` 后面**没跟值**（`lpm link --preset`）由 commander 自己报「option '--preset <名>' argument missing」→ exit 1，不重复接管。

### 4.6 last.json 刷新口径（PRD §10 行 337–344 的落地表）

**单源口径**：`last` 的值一律是「**操作后** `state.links` 的全部 keys」（`executeLinkPlan` 内重读 state，S6 既有写法）。

| # | 触发 | 刷新？ | 依据 |
|---|---|---|---|
| 1 | `link --last` / `--all` / `--preset <名>` | **刷新**（install 成功后）—— **哪怕展开后只有 1 个名字** | PRD §10 行 341 |
| 2 | 集合级操作但**全部命中「已链接、跳过」**（`aggregated` 为空、不进 `executeLinkPlan`） | **仍刷新**（值 = 当前 links 全集）—— 见实现落点 2 | PRD §10 行 341 字面「操作后全部 links 的 keys」 |
| 3 | 交互勾选「全部已注册」/「上次链接的」等虚拟项 | **刷新**（同 #1 / #2；展开后仅 1 个也刷新） | PRD §10 行 341（三者口径同源） |
| 4 | 直通 `link <A> <B>`（targets ≥ 2 且至少成功 1 个） | 刷新（S6 既有） | PRD §10 行 341 |
| 5 | 交互勾选 ≥ 2 个普通项 | 刷新（**现有代码已满足**，S10 只补断言） | PRD §10 行 341 |
| 6 | 直通 `link <A>` 单个 / 交互只勾 1 个普通项 | 不动 | PRD §10 行 342 |
| 7 | `unlink --all` / 拆至清空 | 刷新为**清空前**完整集合（S7 既有，不动） | PRD §10 行 344 |
| 8 | `--dry-run` / 取消 / 报错中止 | 不动（#2 的例外：零写盘契约优先） | S9 §8 自决 3、PRD §7 行 271 |

**实现落点（两处）**：

1. **有实际动作时**：`LinkPlan`（内部接口，非导出）增字段 `forceLastWrite: boolean`；`executeLinkPlan` 的判定由 `targets.length >= 2` 改为 `(plan.forceLastWrite || targets.length >= 2) && linkedTargets.length >= 1`。直通路径不传该字段（undefined → falsy）→ 行为与 HEAD 逐字一致
2. **无实际动作时（表 #2）**：集合级分支的「计划为空」出口（`plan.aggregated.size === 0` 的 `return 0` 之前、**非 dry-run** 时）补一次 `writeLast(rootDir, { version: 1, names: Object.keys((await readState(rootDir))?.links ?? {}) })`；失败仅警告（与 S6 既有的 last 写失败处置同形）

> **口径的机理（P1 承接）**：`last` 是「**整个链接集的快照**」，不是「本次操作清单」——这正是 PRD §10 行 341 与附录 A 的 P1 修复所确立的语义（老规则在增量 link 下会把「全家桶记忆」冲成单个，所以只认集合级操作、且值取操作后的全集）。因此集合级操作**即便本次没动任何文件**，也要把快照对齐到当前全集（表 #2）——否则用户刚跑完 `link --all`，`last` 还停在旧值（甚至比当前链接集更小），下次 `--last` 恢复出来的就不是他以为的那批。

> **注（一处刻意的不对称）**：直通 `link <A> <B>`（表 #4）在「全部已链接」时仍不写 last —— 这是 S6 已冻结的直通行为（`aggregated` 为空即 `return 0`），S10 不动它。故 `link <A> <B>` 与 `link --all`（同一集合、同样全跳过）在 last 上有一处不对称；裁决：**接受**（直通行为冻结优先；用户想刷新 last 就用集合级开关）。

### 4.7 预设存储契约

- **位置**：项目级 `lpm.config.json` 的 `presets` 字段（进 git，PRD §9 行 297–298）。**本 spec 零新增文件、零新增 `.lpm/` 内容**
- **形状**：`presets: Record<预设名, string[]>`（`types.ts` 的 `ProjectLpmConfig.presets` 已就位）
- **读取守卫（`readPresets`）**——与 S8 §9 自决 9/10「脏值不崩、如实降级」同族，但**读顶层不吞**：
  - `cfg === null` 或 `presets` 缺省 → `{ raw: {}, entries: {}, corrupt: [] }`
  - `presets` 存在但**非对象**（数组 / null / 标量）→ **抛 `PresetError`**（`lpm.config.json` 的 `presets` 应为对象。可手工修正或删除该字段——lpm 状态可抛弃重建）
  - 逐条目：值**不是**「元素全为字符串的数组」→ 进 `corrupt`（**不读其元素**）；否则进 `entries`
  - `raw` 原样保留一切（含 `corrupt` 条目与未知字段）——供**读-改-写**
- **写入**：一律 `writeProjectConfig(rootDir, { ...cfg, presets: next })`（原子写）。**读-改-写**基线 = `{ ...view.raw, [改动键]: 新值 }` —— 保存 / 删除**绝不丢**损坏条目或未知字段
- **排序（存）**：`runSave` 存的名单按 `[...names].sort()` 排序（JS 默认比较 = **UTF-16 code unit 序**，确定性优先）。理由：`lpm.config.json` 进 git，不排序会让名单顺序随 `state.links` 的写入顺序抖动，diff 出现无意义行序变化
- **删空**：删除后 `next` 为空对象 → **移除 `presets` 字段**（保持 config 最小；与 PRD §9 行 301「links 清空即删文件」同精神）
- **回滚方案**（交付/运维视角）：预设写进的是**进 git 的** `lpm.config.json` —— `lpm preset rm` 删错了可用 `git checkout -- lpm.config.json` 恢复；没有任何「删了就找不回」的删除面（对比：`.lpm/` 下的 state/last 才是 gitignore 的）
- **`version`**：不动
- **预设名规则**：`trim()` 后非空，且**不含空白字符**（含空格的名字会让 `lpm preset rm 我的 预设` 被拆成两个参数；建议 `my-preset`）。不满足 → `PresetError`（附一个合法示例）

### 4.8 `lpm save` 行为契约

```
lpm save <预设名>
 ① 预设名校验（§4.7）——非法 → PresetError → exit 1
 ② findWorkspaceRoot(cwd) → readProjectConfig(rootDir)（缺失 → 视为 `{ version: 1, libs: {} }`，允许首次创建）
 ③ readState(rootDir)：null 或 `Object.keys(links).length === 0` → PresetError
      「当前没有任何已链接的库，无法存为预设。先 lpm link <名字|路径>」
 ④ 撞名：`Object.hasOwn(view.raw, 名)`（**含损坏条目**）→ PresetError
      「预设名已存在：<名>。先 lpm preset rm <名> 删除，或换一个名字」（裁决 4）
 ⑤ names = Object.keys(state.links).sort()
 ⑥ writeProjectConfig(rootDir, { ...cfg, presets: { ...view.raw, [名]: names } })
 ⑦ stdout：`已保存预设：<名>（N 项：a、b、c）`（N ≥ 1；名单内联列出）
 ⑧ exit 0
```

- 纯直通：**不弹任何菜单**、无 `--dry-run`（S12 面）、**不写 `.lpm/last-run.json`**（§1.2）
- 写盘失败 → **rethrow**（§4.3 错误传播契约，与 link/unlink 同口径）；由 commander 兜底非零退出 + 错误信息
- **不校验名字是否仍注册**：`save` 存的就是 `state.links` 的键（原样）。若某个键已不在 `cfg.libs`（`lpm.config.json` 被手改，或那个 lib 被 `lpm forget` 掉），预设仍会存它——这是**有意的**：不静默丢用户数据；代价是日后 `lpm link --preset <名>` 会以「名字不在注册表」报错（§4.4），而那条文案已含两条修复出路
- **`lpm.config.json` 不存在时允许创建**（第 ② 步的 `{ version: 1, libs: {} }`）：不阻止用户保存；也**不反推 `libs`**（state 里只有 original range，没有 lib 的路径，推不出来）——写出的 `libs: {}` 是诚实的（那份注册表确实是空的），且该文件进 git、随时可改

### 4.9 `lpm preset rm <名>` 与 `lpm preset`（交互）

```
lpm preset rm <名>                       lpm preset（无参数）
 ① readProjectConfig → 缺失 → 报错         ① 非 TTY（process.stdin.isTTY !== true）
      「没有 lpm.config.json，没有任何预设」      → stdout 一行「当前不是交互终端；直通用法：lpm preset rm <名>」+ exit 1（零菜单）
 ② view = readPresets(cfg)                 ② readProjectConfig + readPresets（配置文件坏 → 透传错误 exit 1）
 ③ 名不在 view.raw → PresetError            ③ entries 与 corrupt 皆空 → stdout
      「预设不存在：<名>。可用预设：a、b」          「还没有任何预设。用 lpm save <名字> 把当前链接集存下来」+ exit 0
      （无预设时 →「当前没有任何预设」）        ④ clack.multiselect（多选）：每预设一项
 ④ next = { ...view.raw }；delete next[名]       · 合法：label = `<名>（N 项：a、b、c）`
      删空（无键）→ 移除 presets 字段             · 损坏：label = `<名>  [损坏]` + hint「内容不是字符串数组——删除可修复」
 ⑤ writeProjectConfig(rootDir, {...cfg, presets: next})   ⑤ 空选中提交 → stdout「未选择任何预设」+ exit 1
 ⑥ stdout：`已删除预设：<名>`                ⑥ clack.confirm(`删除这 N 个预设？（删除后需重新 lpm save 才能恢复）`, { initialValue: false })
 ⑦ exit 0                                        → 答否 / isCancel → stdout「已取消」+ exit 1
                                            ⑦ 逐个删除（单次 writeProjectConfig）→ 逐行 stdout「已删除预设：<名>」
                                            ⑧ exit 0
```

要点：① 损坏条目**可被选中删除**——这是修好脏配置的唯一入口（与 S9「corrupt 项照常显示且保持可选」同精神）；② 删除是**有后果操作**（删了要重新 `lpm save`），故二次确认，与 PRD §8.2 的「确认删除前二次确认」同形；③ `lpm preset` 的**非 TTY 退化**与 S9 §4.10 同口径（S8 的 exit-13 事故是反面判例）。

**`lpm preset` 的参数分派（`runPreset` 内部）**：`[]` → 交互；`['rm', 名]` → 直通删除；其它（含 `rm` 缺名、未知子命令、多余参数）→ 报错 + 用法 `lpm preset` / `lpm preset rm <名>`，exit 1。cli 层只做 `[args...]` 透传（校验全在 `runPreset` 内，便于单测）。

### 4.10 虚拟项接入 S9 主列表

**位置**：`pickLinkTargets` 的 groups **最前面**新增「快捷」组（位于「已注册」组之前）。

| 虚拟项 | 出现条件 | 展开为 | 值（哨兵） |
|---|---|---|---|
| `全部已注册（N）` | `cand.registered.length ≥ 1`（N = `cand.registered.length`） | 与「已注册」组显示序一致（★ 命中数降序） | `\u0000__all_registered__` |
| `上次链接的（N）` | **last.json 存在且 `names` 非空**（PRD §8 行 278「无记录则隐藏」；N = `names.length`） | last.json 的 `names`，**过滤掉不在 `cfg.libs` 的** | `\u0000__last__` |

- **N 的口径（渲染期，不做注册表过滤）**：两个 N 都是**列表渲染时**的数据长度（`registered.length` / `lastNames.length`），**不预先剔除失效名字**。理由：S9 §8 自决 10 立了「渲染期快照只管展示、判定在计划期现取」的时点分工；在渲染期过滤会让「上次链接的（3）」显示成其实是 2 的量，也会与 S9 的时点规则打架。失效名字只在**提交后的展开期**剔除并提示（见下）
- 哨兵前缀沿用 S9 `OTHER_OPTION = '\u0000__other__'` 的惯例；`cfg.libs` 的键来自 lib 的 `package.json` `name`，不可能含 NUL
- **两项皆不可用 → 「快捷」组整个不出现**（列表与 HEAD 完全一致）
- 两个虚拟项**本身不是最终勾选项**：提交后展开并入勾选集合，与「其他…」的处理顺序一致（先展开虚拟项、再处理「其他…」的弹输入）
- **失效名字的处理（裁决 5 的交互侧）**：展开时过滤掉不在 `cfg.libs` 的名字，并逐行 stdout 提示
  `⚠️ <key> 已不在注册表，已跳过——请用路径重新注册`
  提示后继续（**不整批停**）；若过滤后集合为空且用户没勾其它项 → 走既有「未选择任何库」exit 1
- **`lastNames` 怎么来**：`runLinkInteractive` 内 `await readLast(rootDir)`（`null` 即无记录），传给（**非导出的**）`pickLinkTargets(cand, lastNames)`。
  **不改 `collectLinkCandidates` 的签名与返回形状**——它是 S9 §4.3 的冻结导出（改动会波及 `link-picker` 既有用例）
- **`collectionLevel` 的传导链（last 刷新的关键）**：非导出的 `pickLinkTargets` 返回值由 `string[]` 改为 `{ targets: string[]; collectionLevel: boolean } | typeof CANCELLED`（`collectionLevel` = 提交集合里含任一虚拟项；空态向导手输路径走 `false`）；随后 `runPlanAndExecute(picked, ctx, collectionLevel)` → `buildLinkPlan({ …, forceLastWrite: collectionLevel })`。
  **契约**（防将来漏传）：**任何新增的集合级入口（如 S11 的 forget 交互复用本函数）都必须显式传 `forceLastWrite`**——这是「谁是集合级操作」的唯一判定点，不允许在 `executeLinkPlan` 里二次推断（否则就是第二份真相）
  （**S11 已核对，2026-09-29**：`pickLinkTargets` 返回形态在 S10 的 `{ targets, collectionLevel }` 之上扩展为联合类型 `{ kind: 'link'; targets; collectionLevel } | { kind: 'manage' } | CANCELLED`（**未退回 `string[]`**）；「管理注册…」勾选走 `{ kind: 'manage' }` 转向管理子界面，**不触** `collectionLevel`/last 传导——管理不是集合级链接入口，S11 的 forget 交互复用的是 `collectLinkCandidates` 而非 `pickLinkTargets`。）

### 4.11 非 TTY 与退出码

| 场景 | 行为 | 退出码 |
|---|---|---|
| `lpm preset` 无参数 + 非 TTY | 一行提示（含 `lpm preset rm <名>`）+ 零菜单零写盘 | 1 |
| `lpm preset` 交互 `clack.isCancel` | `已取消` | 1 |
| 二次确认答否（默认否） | `已取消` | 1 |
| 空选中提交 | `未选择任何预设` | 1 |
| 无任何预设（交互入口） | 告知 + `lpm save` 建议 | 0 |
| `lpm save` / `lpm preset rm` 成功 | 一行结果 | 0 |
| 开关互斥 / 参数非法 / 集合为空 / 名字失效 / 预设不存在或损坏 / 无已链接 | 报错 + 建议 | 1 |
| 展开后的集合级 link 照常执行（`--dry-run` 只打印） | 复用 S6/S9 既有码 | 0 / 1 |

### 4.12 与既有编排的对接

```
runLink(targets, opts, cwd)
  ├─ 0. 【S10 新增】参数校验（§4.5）——零副作用
  ├─ targets 非空 → 直通（HEAD 一字不变）
  ├─ targets 空 && 任一开关 → 【S10 新增】集合级直通（§4.4 → buildLinkPlan(forceLastWrite:true) → …）
  └─ targets 空 && 无开关 → runLinkInteractive（S9 现状；新增「快捷」组与失效剔除）
```

- `executeLinkPlan` 的唯一行为改动 = last 判定加 `plan.forceLastWrite`（§4.6）；其余写序（state → package.json → install → last → watch → 提示 → 留痕）不变
- 集合级分支的「计划为空」出口按 §4.6 #2 补一次 `writeLast`（**非 dry-run** 时）——这是本 spec 的第二处落点；**直通路径不走它**（`link <A> <B>` 全跳过时仍不写 last，S6 行为冻结）
- `linkPlanView` / `renderPlan` / `parsePathInput` / `collectLinkCandidates` / `collectLinkedItems` / `unlink.ts` / `status.ts` / `repair.ts` **一行不改**
- 既有 `link-command.test.ts`（39 例）与 `unlink-command.test.ts`（35 例）**零改动**即为「直通行为未变」的判据

---

## 5. 错误表（新增项；既有错误类透传）

| # | 场景 | 文案要点（含下一步动作） | 类 | 退出码 |
|---|---|---|---|---|
| 1 | 三个开关同时给 ≥ 2 个 | `--last / --all / --preset 三者互斥，请只用一个。用法：lpm link --last \| --all \| --preset <名>` | `LinkArgumentError` | 1 |
| 2 | 开关 + 位置参数同用 | `--last / --all / --preset 不能与 <名字\|路径> 同时使用；要链接指定目标请直接给名字或路径` | `LinkArgumentError` | 1 |
| 3 | `--preset` 名为空 | `--preset 需要一个预设名（用法：lpm link --preset <名>）` | `LinkArgumentError` | 1 |
| 4 | `--last` 无记录 / 记录为空 | `没有上次链接的记录。先做一次批量 link（一次给 ≥ 2 个目标、或 --all / --preset）建立记录`（**不提 lpm save**——它写的是预设，不是 last，见 §4.4 注） | `LinkArgumentError` | 1 |
| 5 | `--all` 无已注册 | `当前没有任何已注册的 lib。先 lpm link <路径> 注册` | `LinkArgumentError` | 1 |
| 6 | `--preset <名>` 不存在 | `预设不存在：<名>。可用预设：a、b`（无预设时 → `当前没有任何预设。先 lpm save <名字>`） | `LinkArgumentError` | 1 |
| 7 | `--preset <名>` 损坏（∈ `corrupt`） | `预设 <名> 内容损坏（应为字符串数组）。可 lpm preset rm <名> 删除后重存` | `LinkArgumentError` | 1 |
| 8 | `--preset <名>` 空数组 | `预设 <名> 是空的。先 lpm save <名> 写入内容` | `LinkArgumentError` | 1 |
| 9 | 集合里有**名字不在注册表** / **注册值损坏**（直通） | `<来源>里有 N 个问题项：a、b` + 两条出路（用路径重新注册 / `lpm preset rm` 后重存）；**一个都不链**，且在任何写盘之前中止 | `LinkArgumentError` | 1 |
| 10 | `lpm save` 无已链接 | `当前没有任何已链接的库，无法存为预设。先 lpm link <名字\|路径>` | `PresetError` | 1 |
| 11 | `lpm save` 撞名 | `预设名已存在：<名>。先 lpm preset rm <名> 删除，或换一个名字` | `PresetError` | 1 |
| 12 | 预设名非法（空 / 含空白） | `预设名不能为空，且不能包含空白字符（示例：my-preset）` | `PresetError` | 1 |
| 13 | `preset rm` 名不存在 | `预设不存在：<名>。可用预设：a、b` | `PresetError` | 1 |
| 14 | `preset rm` 但**没有 `lpm.config.json`** | `没有 lpm.config.json，没有任何预设（该文件进 git，可由版本库恢复）` | `PresetError` | 1 |
| 15 | `presets` 顶层非对象 | `lpm.config.json 的 presets 应为对象。可手工修正或删除该字段——lpm 状态可抛弃重建` | `PresetError` | 1 |
| 16 | `lpm preset` 子命令非法 / `rm` 缺名 / 多余参数 | 用法提示：`lpm preset`（列表管理）/ `lpm preset rm <名>` | `PresetError` | 1 |

---

## 6. 测试清单（取数命令 = `pnpm verify`）

**`tests/unit/preset-command.test.ts`（新）**
- `readPresets` 守卫：`cfg=null` / 无 `presets` → 空视图；`presets` 为数组 / null / 标量 → **抛 `PresetError`（不吞）**；值非数组 / 含非字符串元素 → 进 `corrupt` 且**不进 `entries`**；未知字段与损坏条目在 `raw` 中**原样保留**
- `save`：正常（名单 = `state.links` 的 keys 且已按 `[...names].sort()` 排序）；`state.json` 缺失 → 报错；`links` 为空 → 报错；**撞名 → 报错且 `lpm.config.json` byte 级不变**；预设名非法（`''` / `' '` / `'a b'`）→ 报错；**预设名含 CJK（如 `前端`）能存能删能用**；**读-改-写**：已有其它预设 + 一个损坏条目时保存 → 两者都还在；`lpm.config.json` 不存在时能创建且 `libs` 不丢（`libs: {}`）
- `save` 的原样口径：`state.links` 的键不在 `cfg.libs` 时**照样存进预设**（不静默丢数据）；随后 `link --preset` 会以「不在注册表」报错（两个用例配对，钉住这条有意的不一致）
- `preset rm`：正常 → 文件里该键消失、其它键保留；删**最后一个** → `presets` 字段整体移除；不存在 → 报错 + 列出可用；**没有 `lpm.config.json`** → 报错（不崩）；**删损坏条目 → 成功**（修复路径）
- `lpm preset` 交互（mock `@clack/prompts`）：无任何预设 → 提示 + exit 0 + **零 clack 调用**；非 TTY → 提示 + exit 1 + **零 clack 调用**（S8 exit-13 事故同族回归钉）；多选删除 → 二次确认 → 文件更新 + 逐行提示；空选中 → exit 1 + 文件不变；答否 / `isCancel` → `已取消` + exit 1 + **byte 级零写盘**；损坏条目 label 含 `[损坏]` 且可被选中删除

**`tests/unit/link-collection.test.ts`（新）**
- `--last`：正常展开 → 链接成功 + last 刷新；**N=1 的钉**（预设/记录里只有 1 个名字时也刷新，钉 `forceLastWrite`）；无 `last.json` / `names` 为 `[]` → 报错 exit 1 + **零写盘**；`names` 含**非字符串元素**（手改脏值）→ 报错指出该元素、**不崩**
- **集合级全跳过仍刷新（§4.6 #2）**：`--last` 的成员**全部已链接** → 计划为空 → last 仍被刷新为「当前 links 全集」（构造：先前用另一条路径多链了一个库，断言 last 从旧集合变为当前全集）
- `--all`：展开 = `cfg.libs` 全部键；**N 个库 → install 恰一次**（PRD §13 验收 4）；无已注册 → 报错
- `--preset`：正常；不存在 → 报错 + 列出可用预设；损坏 → 报错；空数组 → 报错
- **展开期预检两类问题项**：① 名字不在注册表（2 个失效 + 1 个正常）② 注册值损坏（`cfg.libs` 手改成非字符串）→ 各自：报错、文案列出问题项、**config / state / 各 manifest byte 级全不变**、零子进程
- **非预检类的中途失败**（钉住 §4.4 要点③ 的收窄）：集合里含「已注册但零命中依赖」→ `LinkTargetError` 整批停（文案含「先 pnpm add」）；此时**先前合法项的注册 upsert 已落盘**（断言与 S6 直通同口径，不做回滚）
- 互斥：`--last --all` / `--all --preset x` / `--all @t/lib` / `--preset ""` → 各自报错 exit 1 + 零写盘 + 零子进程
- 叠加：`--all --dry-run` → 首行逐字 `dry-run 执行计划（不落任何盘、不执行任何子进程）：` + 零写盘零子进程（**含「全跳过」时也不写 last**）；`--all --watch` → watch 行出现
- **PRD §13 验收 5 闭环**：`link A B C` → `unlink --all` → `link --last` → `state.links` 的 keys == {A,B,C} 且各 manifest 的 range 与**最初**一致（unit，install mock）
- 回归：直通 `link <A> <B>` 刷新 last / `link <A>` 不刷新 / **`link <A> <B>` 全已链接时仍不写 last**（S6 行为冻结）

**`tests/unit/link-interactive.test.ts`（扩展）**
- 「快捷」组：`registered ≥ 1` 时出现「全部已注册」；无 `last.json` 时**不出现**「上次链接的」；有 last 时出现
- **N 的显示口径**：`last.json` 有 3 个名字、其中 1 个不在 `cfg.libs` → label 显示 `上次链接的（3）`（渲染期不过滤），提交后才提示剔除
- 勾「全部已注册」→ 展开为全部注册键 → 计划含全部（且 install 恰一次）
- 勾「上次链接的」→ 展开；其中含失效名字 → 逐行剔除提示 + 其余照常 + **不报错**（钉住与直通侧的不对称）
- 虚拟项 + 手勾普通项混选 → 去重后计划正确
- 虚拟项触发的 last 刷新：展开后**仅 1 个**名字时也刷新（钉 `forceLastWrite` 传导链）
- 两项皆不可用（无注册且无 last）→ 「快捷」组不出现（列表结构与 HEAD 一致）

**`tests/e2e/cli.e2e.test.ts`（追加）**

> **fixture 前提**：S9 那 2 例之所以能在裸目录跑，是因为它们的判定（非 TTY 闸门）位于一切前置之前。本波 5 例的判定位置不同：**第 1、2、5 例需要真实 workspace fixture**（临时目录 + `lpm.config.json` 的 `libs` + 可选的 `.lpm/state.json` / `last.json`），否则会在 `findWorkspaceRoot` 就报「未找到项目根」，断言目标（无 last 记录 / 预设不存在 / 无已链接）根本走不到；**第 3 例（互斥）与第 4 例（`lpm preset` 非 TTY）的判定都在前置之前**，裸目录也能成立——为复用 helper 与执行一致，仍统一建 fixture。

- `lpm link --last`（无 `last.json`）→ exit 1 + 提示串（且**不含** `lpm save` 字样——§4.4 注的回归钉）
- `lpm link --preset nope` → exit 1 + 提示串
- `lpm link --all --last` → exit 1 + 互斥提示串
- `lpm preset`（非 TTY）→ exit 1 + 提示串 + stdout 无菜单残片
- `lpm save x`（无链接）→ exit 1 + 提示串

**真实终端手测（归用户，非自动化）**
- `lpm preset` 菜单（含损坏条目的 `[损坏]` label）与 link 主列表「快捷」组的中文对齐 / 长行换行（复用 S9 §2 裁决 1 的三屏手测口径）

**回归（S10 开工前的 24 文件 / 395 例 + e2e 1 文件 / 28 例必须零改动；取数命令 `pnpm verify`）**
- `link-command.test.ts`（39 例）与 `unlink-command.test.ts`（35 例）**零改动** = 直通行为未变的判据
- `plan-view.test.ts` / `link-picker.test.ts` / `unlink-interactive.test.ts` 零改动（本 spec 不动这些函数的签名）

---

## 7. 后续衔接

| 消费方 | 依赖的 S10 产出 |
|---|---|
| S11 登记管理 | ① `lpm forget` 会把名字从注册表移除，**预设里的旧名字随之失效** → S10 的失效策略（直通整批停 + 两条修复出路）是 S11 必须一并复核的面；② link 主列表的「管理注册…」入口加在同一个 `pickLinkTargets` 组装点（S10 新加的「快捷」组也在那里，组的顺序：快捷 → 已注册 → 扫描发现 → 其他 → 管理注册…）；③ `pickLinkTargets` 的返回值已改为 `{ targets, collectionLevel }`，S11 接手时不要退回 `string[]`（**已落地（S11 回写，2026-09-29）**：① forget 删除时对预设旧名字「提示但不洗」（`printPresetHints`，预设内容 byte 级不变）；②「管理注册…」已接入主列表且位于「其他…」之后；③ 返回形态升级为联合类型（见 §4.10 注），未退回 `string[]`） |
| S12 引导性打磨 | `save` / `preset rm` 的 `--dry-run` 与模糊纠错；错误即建议全局化会复核 S10 新增的 16 条文案；`--last/--all/--preset` 的互斥判定是「模糊纠错」的相邻面 |
| S13 utoopack 适配 | 不受影响（集合级操作复用 `executeLinkPlan`，注入点不动） |
| 后续候选 | 预设的「直接执行」入口（Q6 已否；触发信号：实际敲 `lpm link --preset` ≥ 2 次/周）；预设重命名 |

**落地后必须做的「回头扫一遍声明它的地方」**（用户全局规则；与实施同波完成，不得推迟到收口之后）：

1. **S9 spec §4.5 的 A6 表**：补一行「快捷组（S10 追加）」；§3.1 数据流与 §6 测试清单里对主列表的描述同步
2. **S9 spec §4.3 的「`LinkOptions` / `UnlinkOptions` 不扩字段」**：标注「S10 已按裁决 7 追加 3 个可选字段（`UnlinkOptions` 仍未扩）」，避免下一位读者以为该句仍是现状
3. **`src/commands/registry.ts` 的 `plannedSpec`**：`save` / `preset` 接线后不再走 stub 循环 → 这两条的「计划 S10」提示面消失，检查 `COMMANDS` 里有没有残留的过期描述
4. **S6 §8 行 450 / S7 §8 行 301 的 S10 行**：核对「已就位」类表述与 S10 实际交付一致；S7 那句「`--last`/`--preset` 恢复操作」必须明确为 **link 侧开关**（不是 unlink 的）

---

## 8. 实现期自决细节（非决策，评审可否决）

1. **预设名禁空白**（§4.7）。理由：`lpm preset rm 我的 预设` 会被 shell 拆成两个参数，CLI 侧无法可靠区分「名字含空格」与「多给了参数」。若评审要求支持含空格的预设名，需同时改 cli 接线与文档——成本一行，换来「必须加引号」的使用负担。
2. **保存时按 `[...names].sort()` 排序**（§4.7）。若评审要求保持 `state.links` 的顺序，把 `.sort()` 去掉即可——代价是 `lpm.config.json` 的 diff 会随 state 写入顺序抖动。
3. **删除最后一个预设 → 移除 `presets` 字段**（§4.7）。若评审要求保留空对象 `{}`，改一处判定即可。
4. **交互侧失效名字 = 前置剔除（不整批停）**，与直通侧不对称（§4.10）。若评审要求两侧统一为「整批停」，改法 = 展开时不过滤、让 `buildLinkPlan` 里的 `resolveTarget` 自然报错（提示语会退化为 S6 既有的「未知注册名/路径不存在…已注册：…」）。
5. **`save` / `preset rm` 不写 `.lpm/last-run.json`**（§1.2）。若评审要求留痕，需扩 `LastRunTrace.command` 的枚举（触及 S8 §4.3 冻结面），且要给 save 定义「changes 记什么」。
6. **`lpm preset` 的选项 label 内联名单**（`<名>（3 项：a、b、c）`）：预设项数大时行会很长，交给 clack 的宽度换行（S9 §8 自决 12 同口径），不额外做截断或折叠。
7. **`lpm preset` 用 `clack.multiselect`**（不需要分组），与 S9 unlink 侧同型（S9 的 link 侧才用 `groupMultiselect`）。
8. **重复给同一个开关**（`lpm link --preset a --preset b`）：commander 只保留最后一个，**不额外接管**报错（多写一个 flag 的成本比收益高——见 §9 P2-6）。同理 `--last --last` 无害。

---

## 9. 评审 Backlog

### 自审（multi-lens-review，2026-09-28，场景 B 技术方案：六手法 + 架构师 / 资深开发 / 资深测试 / 交付运维面板）

**结论先行**：4 轮过完（第 1 轮全量 + 第 2 轮复扫与修复 diff 自审 + 第 3 轮全量复读 + 第 4 轮复扫），累计 **2 矛盾（P0）+ 9 盲点（P1）+ 17 优化（P2）**，全部当轮修复。**最危险项 = P0-2**：§4.6 的表格写「集合级操作一律刷新 last」，紧接着的注却写「全部幂等跳过时不刷新，且与刷新无观测差异」——后者是错的（links 里可能有本次操作没碰到的名字，刷新会把它纳入，故两者可观测地不同），它会让用户跑完 `lpm link --all` 后 `last` 仍是旧集合。收敛判定：**第 3、4 轮连续零新增 P0/P1**（第 1、2 轮均有新增）。

**本轮自审暴露的一个流程问题（如实记录）**：第 1 轮的 P0-2 修复曾在本节登记为「已修」，但**实际没有写进文件**——直到第 2 轮的一次编辑因「search 内容不存在」报错才暴露。归因 = **修复纪律缺失**（改完没回读验证就登记）。教训：**每处修复后必须回读该段落确认落地，再登记**；本 spec 后续的每一处修复都按此执行。

### 矛盾（P0）

| # | 问题 | 触发序列 / 证据 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | `--last` 无记录时的错误文案建议用户「或 `lpm save <名字>` 建立记录」——**`lpm save` 根本不写 last.json**（PRD §10 行 337–344 的写入面只有 link 的集合级/多个与 unlink 的 `--all`/拆至清空）→ 用户按提示跑一条不解决问题的命令，`--last` 依旧失败 | `lpm link --last`（无记录）→ 照文案跑 `lpm save 前端` → 再跑 `--last` → **仍然报错** | **已采纳**：文案改为「先做一次批量 link（一次给 ≥ 2 个目标、或 `--all` / `--preset`）建立记录」，并加一条注说明 save 与 last 是两套记录；§6 补 e2e 断言「该提示串里不含 `lpm save`」 | §4.4 注 + §5 #4 + §6 |
| 2 | §4.6 表（「集合级一律刷新」）与 §4.6 注（「全跳过时不刷新、无观测差异」）自相矛盾；且后者与 PRD §10 行 341 字面不符 | `link --all`（links={A,B}，写 last=[A,B]）→ 单独 `link C`（增量，PRD 行 342：last 不动，仍 [A,B]）→ 再跑 `link --last`（展开 [A,B]，两者都已链接 → **全跳过**）→ 旧实现：不进 `executeLinkPlan` → last 仍 [A,B]；而 PRD §10 行 341 要求「操作后全部 links 的 keys」= [A,B,C]。**差异在下一步显现**：之后 `unlink C` 再跑 `link --last`，按 PRD 口径 C 应被一并恢复，旧实现不会 | **已采纳**：表新增 #2「集合级操作全部命中跳过时**仍刷新**（值 = 当前 links 全集）」，并写清两处实现落点与 dry-run/中止的例外；删掉「无观测差异」的说法 | §4.6 表 #2 + 实现落点 2 + §4.12 + §6 |

### 盲点（P1）

| # | 问题 | 触发序列 / 证据 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | §4.4 承诺「失败发生在任何写盘之前」，但只覆盖「名字不在注册表」这一类；**注册值损坏**（`cfg.libs[k]` 非字符串）不在预检内 → 错误在 `buildLinkPlan` 循环中途抛出，此前合法项的注册 upsert 已落盘，与承诺矛盾 | `lpm link --all`，`cfg.libs = { '@t/a': '../../a', '@t/b': 123 }` → 循环先处理 `@t/a` 并写盘 upsert → 到 `@t/b` 抛 `LinkArgumentError` | **已采纳**（两条）：① 展开期预检补第二类「注册值损坏」（与 S9 §4.5 交互侧同判定、同文案族）；② 把承诺**收窄为事实**——明确「其余错误（目录缺失 / 零命中依赖 / 非 lpm 三选一）仍在中途抛出，此前 upsert 已落盘、不回滚（与 S6 直通同口径）」，并给出「不引入第二份真相」的理由 | §4.4 两类预检 + 要点②③ + §6 |
| 2 | 虚拟项「上次链接的（N）」的 **N 口径未定义**（过滤失效名字前还是后） | `last.json` 有 3 个名字、其中 1 个已被 forget → label 显示 3 还是 2？ | **已采纳**：N = 渲染期数据长度（`lastNames.length`），**不做注册表过滤**——与 S9 §8 自决 10「渲染期快照只管展示、判定在计划期现取」的时点分工一致；失效名字只在提交后的展开期剔除并提示 | §4.10 表 + N 口径条 + §6 |
| 3 | `preset.ts` 的**错误传播契约缺失**：`runSave` / `runPreset` 只写了「返回 0/1」，没说哪些错误类透传、哪些 rethrow、由谁打印 | `lpm save x` 在 workspace 外执行 → `WorkspaceNotFoundError` 谁来打印？ | **已采纳**：§4.3 增「错误传播契约」——`preset.ts` 内建 `reportError`（KNOWN = `PresetError` + `WorkspaceNotFoundError` + `LpmConfigParseError` + `LpmStateParseError`），其余 rethrow；`link.ts` 的 KNOWN 追加 `PresetError` | §4.3 |
| 4 | **`collectionLevel` 的传导链未写**：只说「勾了虚拟项就按集合级处理」，没说 `pickLinkTargets` 的返回值要改、由谁传给 `buildLinkPlan` | 实现者可能把 `forceLastWrite` 漏掉，或退回到在 `executeLinkPlan` 里二次推断 | **已采纳**：写明返回值改为 `{ targets, collectionLevel }`、`runPlanAndExecute(picked, ctx, collectionLevel)` → `buildLinkPlan({ …, forceLastWrite })`，并立「集合级判定只此一处」的契约（防 S11 复用本函数时漏传） | §4.10 传导链条 + §7（S11 行） |
| 5 | §6 的 e2e 用例**没写 fixture 前提**：S9 那 2 例能裸跑是因为非 TTY 闸门在一切前置之前；而 `lpm link --last` **没有**那样的前置闸门 → 在裸目录会先报「未找到项目根」而不是「没有上次链接的记录」，用例会假失败 | `lpm link --last` 在无 workspace 的临时目录 → 报的是 workspace 错误 | **已采纳**：§6 e2e 段增 fixture 前提（临时 workspace + `libs` + 可选 state/last，复用既有 e2e helper） | §6 |

### 优化（P2）处置表

| # | 问题 | 处置 | 落点 / 理由 |
|---|---|---|---|
| 1 | `resolveLinkCollection` 返回值里的 `label` 字段正文零引用（未定义的多余字段） | **已采纳**（删除） | §4.4 签名；YAGNI |
| 2 | 「`--all` 展开顺序 = 注册顺序」是个未验证的断言（JS 对象对整数类键会重排） | **已采纳**（措辞弱化为「JS 对象键序」） | §4.4 表 + §4.10 表 |
| 3 | 「字典序」的中文表述与 `.sort()` 的 UTF-16 code unit 语义不等价 | **已采纳**（写明 `.sort()` 语义） | §4.7 + §8 自决 2 |
| 4 | `preset rm` 重复删除报错，而非幂等成功 | **关闭**：PRD §7 行 265 无幂等要求；报错 + 列出可用预设更利于发现拼写错误（GNU `rm` 同型）；幂等会让「删错了名字」静默无感 | §5 #13 |
| 5 | `save` / `preset rm` 的读-改-写不防**丢失更新**（双终端同时保存 → 后者覆盖前者） | **关闭**：与 S6 的 state 读-改-写同族；PRD §9 行 306 只承诺「原子写防写坏」不承诺防丢更新；触发信号 = 真实发生一次丢失更新 | §4.7（写入条） |
| 6 | `--preset a --preset b` 静默取后者（commander 语义） | **候选**：触发信号 = 误用真实发生 ≥ 2 次 | §8 自决 8 |
| 7 | §5 错误表缺「没有 `lpm.config.json` 时 `preset rm`」一行 | **已采纳** | §5 #14 |
| 8 | `save` 不校验名字是否仍注册（会造出日后报错的预设） | **已采纳**（补说明 + 配对用例，钉住这条有意的不一致） | §4.8 + §6 |
| 9 | §6 缺「预设名含 CJK」用例 | **已采纳** | §6 |
| 10 | §6 缺「真实终端手测（归用户）」一行 | **已采纳** | §6 |
| 11 | §4.7 缺**回滚方案**（交付/运维必问 3） | **已采纳**（`git checkout -- lpm.config.json`） | §4.7 |
| 12 | `last.json` 的 `names` 元素非字符串（手改脏值）行为未定义 | **已采纳**（按「名字不在注册表」处理、不崩） | §4.4 要点⑤ + §6 |
| 13 | §4.5 三项校验的**判定顺序**未固定 | **已采纳**（固定为：三者互斥 → 与位置参数互斥 → 名为空） | §4.5 |
| 14 | 「全部已注册」虚拟项与 `clack.groupMultiselect` 的**组级全选**功能重复 | **关闭**：PRD §8 行 278 字面要求该虚拟项；额外价值 = 与「上次链接的」并列成「快捷」组的可发现性与命名 | §4.10 |
| 15 | S9 spec §4.5 的 A6 表未含「快捷」组（跨 spec 的声明面） | **已采纳**（列入实施期回写义务，与实施同波完成） | §7 回写清单 1 |

### 第 2 轮（复扫 + 修复 diff 自审 + 同族扫描）

| # | 级别 | 问题 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | P1 | §6 的 e2e fixture 前提把例号判错（把「`lpm save x` 无链接」列为可从裸目录起步）——它其实**需要** workspace，否则先撞 `findWorkspaceRoot`；而真正不需要 fixture 的是「互斥」那一例 | 已采纳：按「判定位置」重分组——需 fixture：第 1、2、5 例；不需要：第 3 例（互斥，判定在 preflight 之前）、第 4 例（非 TTY，判定在一切之前） | §6 |
| 2 | P1 | §2 裁决 7 写「被否方案见 §9 自审记录」，而 §9 通篇没有该内容 → 悬空引用 | 已采纳：改指 §9「自洽确认区」，并在那里补上两个被否方案与否决理由 | §2 裁决 7、§9 自洽确认区 |
| 3 | P1 | §9 的 P0-2 证据序列（`link A B C` → `unlink A` → `link --last`）**举的例子其实不触发该缺陷**（那一步有改写动作、会正常刷新）→ 评审报告的核心证据不成立 | 已采纳：换为能观测到差异的序列（`link --all` → `link C` → `link --last`；差异在随后的 `unlink C` + `--last` 显现） | §9 P0-2 行 |
| 4 | P1 | 第 1 轮的 P0-2 修复已在本节登记「已修」，但**实际未写入文件**（分块编辑时漏掉那一块）——由一次编辑报「search 内容不存在」才暴露 | 已采纳：补写 §4.6 的表 #2 / 实现落点 2 / 机理注；并立「修复后回读验证再登记」的纪律（见本节首段） | §4.6、本节首段 |

### 第 3 轮（全量复读 + 交叉点同步检查）

| # | 级别 | 问题 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | P2 | §3.1 数据流图的 `--all` 仍写「（顺序 = 注册顺序）」——没随第 1 轮 P2-2 的措辞弱化同步（同族的交叉点漏改） | 已采纳 | §3.1 |
| 2 | P2 | §3.1 的展开期预检只写「名字 ∈ cfg.libs」——没随第 1 轮 P1-1 的修复补上「注册值损坏」（同一交叉点漏改） | 已采纳 | §3.1 |

### 第 4 轮（复扫）

全量复读（含 §3 图 × §4 契约 × §5 表 × §6 清单 × §9 记录五处交叉点）→ **零新增 P0/P1/P2**。**收敛判定达成**：第 3、4 轮连续零新增 P0/P1（P2 不阻塞收敛）。

### 自洽确认区（攻过但没攻破）

- **裁决 7 的两个被否方案**（brainstorming 当场呈现、用户否决）：① **新增独立入口 `runLinkCollection`**（`LinkOptions` 一字不动）—— 缺点：link 从此有两个入口，且「`--all` 不能与 `@t/lib` 同用」这种用户可见报错会落到 cli 接线层（那里现在只接线、不承载业务语义）；② **cli 层把开关展开成名字数组再调既有 `runLink`** —— **有硬伤**：展开后就认不出「这是集合级操作」，做不到 PRD §10 行 341 的「`--preset` 一律刷新 last（哪怕只有 1 个名字）」，还会把 workspace 发现重复跑一次。
- **`link <A> <B>`（全跳过）不写 last vs `link --all`（同集合、全跳过）会写** —— 不对称**已被显式裁定接受**（§4.6 注）：直通行为是 S6 冻结面，优先级高于口径统一；用户想刷新 last 用集合级开关即可。这不是遗漏，是取舍。
- **集合级操作仍会弹菜单**（非 lpm 本地链接三选一 / monorepo 让选）—— 与「只走直通」不矛盾：裁决 2 的「直通」指**不进主列表**，这三选一是 S6/S9 直通路径本就有的既有交互，集合级复用同一条路。
- **`save` 存的是 `state.links` 的键（含 drift 项）** —— 与 S9 unlink 列表的「已链接项」同源（都以 state.links 键为准），口径一致，非新定义。
- **哨兵值碰撞**：`cfg.libs` 的键来自 lib 的 `package.json` `name`（npm 包名不可能含 NUL）→ `\u0000__…__` 无碰撞风险。
- **`--dry-run` + 集合级全跳过**：不写 last（§4.6 表 #8 的例外）——零写盘契约优先级更高，与 S9 §8 自决 7 一致。
- **`lpm preset` 的非 TTY 检查先于读配置**：与 S9 link/unlink 交互入口同序（非 TTY 时即使配置是坏的也只打印一行提示）——刻意如此，避免在 CI 里抛配置错。
- **commander 兜底的两处**：`lpm link --preset`（缺值）与 `lpm save`（缺位置参数）由 commander 自己报错 → 不重复接管，也不违背「错误即建议」（commander 的错已含用法）。
- **`--all` 与 `cfg.libs` 里「已注册但零命中依赖」**：整批停（`LinkTargetError`）——与 Q5 裁决（直通整批停）同口径，且该失败在中途发生、可能留下 upsert（已由 P1-1 的收窄措辞覆盖，非遗漏）。

### 修复对照表

| 问题 | 落点（本 spec 章节） |
|---|---|
| P0-1 `--last` 文案误导去 `lpm save` | §4.4 注、§5 #4、§6 e2e 断言 |
| P0-2 集合级全跳过不刷新的自相矛盾 | §4.6 表 #2 + 实现落点 2、§4.12、§6 |
| P1-1 写盘前承诺过宽 + 缺「注册值损坏」预检 | §4.4 两类预检 / 要点②③、§5 #9、§6 |
| P1-2 虚拟项 N 口径 | §4.10 表 + N 口径条、§6 |
| P1-3 `preset.ts` 错误传播契约 | §4.3 错误传播契约 |
| P1-4 `collectionLevel` 传导链 | §4.10 传导链条、§7 S11 行 |
| P1-5 e2e fixture 前提 | §6 e2e 前提块 |
| P1-6 e2e fixture 的例号判错（第 2 轮表 #1） | §6（按判定位置重分组） |
| P1-7 §2 裁决 7 悬空引用（第 2 轮表 #2） | §2 裁决 7 → §9 自洽确认区 |
| P1-8 §9 P0-2 证据序列不成立（第 2 轮表 #3） | §9 P0-2 行 |
| P1-9 第 1 轮的修复未落地（第 2 轮表 #4 暴露） | §4.6 + §9 首段（修复回读纪律） |
| P2-1…P2-15 | 见 P2 处置表「落点」列 |
| P2-16 / P2-17 §3.1 两处交叉点未同步（第 3 轮表） | §3.1 |

---

## 10. 实现期实测与裁定

**终态计数**（`pnpm verify` 实跑，2026-09-28 21:00）：exit 0 = typecheck **0 错误** + build **成功** + unit **26 文件 / 447 例** + e2e **1 文件 / 33 例**。开工前基线（本 session 实测）为 unit 24 文件 / 395 例 + e2e 1 文件 / 28 例 → 终态 +2 文件（`preset-command.test.ts` / `link-collection.test.ts`）、unit +52 例、e2e +5 例（E2E-S10-4 / E2E-S10-5 / `--last` 无记录、互斥 2 例）。

**实施期细则裁定**：

- **R2-1**（plan 缺陷，T2）：计划写盘代码 `{ ...view.raw, [name]: sorted }` 在严格 tsc 下不满足 `presets: Record<string, string[]>` → 计划已就地加 `as Record<string, string[]>` 断言。代价：若未来字段类型漂移 tsc 不再报（低风险）；运行时零变化（SV-5 损坏条目保留断言照常通过）。
- **R2-2**（spec 内部矛盾，T2 评审）：§4.8 原写「写盘失败 → `PresetError` 包装」与 §4.3 错误传播总则「其余 rethrow（与 link/unlink 同口径）」冲突 → **裁定 §4.3 优先**：`writeProjectConfig` 的 fs 失败 rethrow，由 commander 兜底非零退出 + 错误信息。代价：save 写盘失败提示为 commander 格式而非 lpm 干净格式（与既有命令一致，可接受）。T7 已统一 §4.8 措辞。
- **R3-1**（plan 文本缺陷，T3）：mock 代码块写了 `import { beforeEach }` 与 `import { vi }` 两条独立 vitest import → 计划已就地合并为单条。代价：无。
- **R4-1**（冻结面冲突，T4）：`LinkArgumentError` 构造器签名 `(target, message)` 是 **S6 §4.3 冻结面**，单参调用报 TS2554 → **回退构造器、保持冻结签名**，S10 调用点改双参 `new LinkArgumentError('', '文案')`（`.target` 在 src/ 零消费者）。代价：若未来有代码读 `.target` 会把 `''` 当目标（当前零消费者，低风险）。
- **R6-1**（plan 文本缺陷，T6）：计划测试代码用 `cap.stdout()`，既有 `captureOut()` 返回 `{ out, err }` → 已就地改为 `cap.out.join('')`。代价：无。
- **R6-2**（plan 参考计数笔误，T6）：「27 文件 / 447 例」应为 **26 文件 / 447 例**（基线 24 + 2 新文件）→ 已就地修正计划。代价：无。
- **R6-3**（实现 vs spec 措辞，T6 评审）：「全部已注册（N）」虚拟项展开序，实现按 `cand.registered.map(c => c.key)`（★ 命中数降序 = 显示序），spec 原写「JS 对象键序」→ **裁定改 spec 措辞为「与『已注册』组显示序一致（★ 命中数降序）」**。T7 已回写 §4.10 表；核对 §4.4 的「JS 对象键序」指 `--all` 直通（= `Object.keys(cfg.libs)`，实现一致），与虚拟项不同源，无需同步。代价：无。

**未提交面**（`git status --porcelain -uall` 原文，2026-09-28 21:00 实跑；S10 全程零 commit，HEAD = `0f9407d` = 用户提交的 S10 交接词文档，S10 实现改动由用户 commit）：

```
 M docs/superpowers/specs/2026-09-28-s9-interactive-design.md
 M src/cli.ts
 M src/commands/link.ts
 M tests/e2e/cli.e2e.test.ts
 M tests/unit/link-interactive.test.ts
?? docs/superpowers/plans/2026-09-28-s10-collections-presets.md
?? docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md
?? src/commands/preset.ts
?? tests/unit/link-collection.test.ts
?? tests/unit/preset-command.test.ts
```
