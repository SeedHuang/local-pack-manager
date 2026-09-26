# S5 · 改写引擎设计文档（spec）

- 日期：2026-09-26
- 状态：待评审
- 路径归类：superpowers architectural（lpm 子项目 spec，S2/S3 的下游）
- 上游：PRD §9 行 312（package.json 改写为文本级替换：保持缩进 / key 顺序 / 尾随换行，仅动命中行 value；命中范围 dependencies / devDependencies / optionalDependencies；peerDependencies 不改写仅警告）/ §13.9 行 387（golden file 测试：真实世界样本集 CRLF/LF、BOM、2/4 空格与 tab 缩进、单行依赖块，改写后 byte 级断言仅目标行变化）/ §14 行 404（S5 行：交付物 = 文本级替换、格式保持、三依赖位命中；依赖 S2；承接 B3）/ 附录 A 行 470（B3 = JSON 重序列化破坏格式，修复落点 §9 文本级替换）；S1 spec §4.3 行 235–259（core/rewriter.ts 冻结签名与数据契约，四处均标 stub 由 S5 填充）；S3 spec §8 后续衔接表（PackageManagerId → mapProtocol 协议选择：pnpm→link: / yarn-classic→link: / yarn-berry→portal: / npm→file:）
- 依赖：S2（PRD §14 定版）；实现基线为 S1–S4 已完成（`pnpm verify` 全绿：typecheck 0 + build + unit 122/122 + e2e 11/11，2026-09-26 复跑）
- 评审提示：方案选型 A + 四个关键裁决已在 brainstorming 拍板（§2，2026-09-26），无遗留开放决策点

## 0. 流程注记与要素映射

- 位置与结构：沿用 S1–S4 确立的 superpowers 默认（问题 → 方案权衡 → 架构 → 组件 → 数据流 → 错误处理 → 测试）
- **B3 修复落点声明**：本 spec 是 PRD 附录 A 行 470「B3 = JSON 重序列化破坏 package.json 格式（缩进/key 序）」的修复实现处；「格式保持」不是实现的独立功能，而是「只拼接 value 字面量区间、区间外字节零触碰」的必然结果（§4.4）
- **与 S1 §4.3 的衔接**：core/rewriter.ts 四冻结签名（mapProtocol / RewriteResult / rewriteDepValue / restoreDepValue）+ Protocol 类型由 S5 填充实现，签名逐字不动（§4.2）
- **与 S2/S3 的衔接**：命中校验上游是 S2（findDependents/DepHit），S5 是纯文本引擎不校验命中；唯一跨模块依赖为 `import type { PackageManagerId } from './pm'`（S1 冻结 import 行，S3 产出）
- **与 S4 的衔接**：无直接依赖（S4 spec §8 行 268：读 package.json 不经 state）
- PRD §14 五要素映射：目标→§1；交付物→§4.1；接口定义→§4.2–4.4；测试清单→§7.1–7.2；验收标准→§7.4
- 计划期修订位：留给 writing-plans 自审（S3/S4 先例：修订随 plan 评审一并确认）

## 1. 问题与目标

**问题**：S6 link / S7 unlink 需要把宿主项目 package.json 中依赖值改写为本地协议值（`link:../lib` 等）或恢复 original range。JSON.parse + 重序列化会破坏宿主文件的缩进 / key 顺序 / 行尾 / BOM——正是 B3 指出的破坏（PRD 附录 A 行 470）。因此改写必须是**文本级**的：仅替换命中 value 的字节区间，区间外逐字节保真。S1 已冻结 core/rewriter.ts 的 4 个签名 stub，S5 填充实现。

**目标**：

1. S1 §4.3 冻结签名逐字实现：`mapProtocol` / `RewriteResult` / `rewriteDepValue` / `restoreDepValue`（含 `Protocol` 类型导出）
2. 文本级替换保格式（B3 修复）：仅拼接 value 字面量区间——BOM / CRLF-LF（含混合行尾）/ 缩进 / key 顺序 / 尾随换行 byte 级保真
3. 命中范围三段（dependencies / devDependencies / optionalDependencies）逐段全改（裁定③）；值已等于目标 → `unchangedKeys`（幂等）；peerDependencies 不改写（PRD §9 行 312）
4. peerDependencies 警告的数据源：新增纯查询导出 `findDepEntries`（裁定①）——S6 警告与 O4 完成提示复用
5. mapProtocol 协议映射（S3 §8 四 pm）+ 相对路径换算（正斜杠、`./` 前缀、永不输出绝对路径）；无法相对化（Windows 跨盘符）→ 新增 `ProtocolPathError`（裁定④）
6. 全程可测：golden file 内联字符串样本（裁定②）byte 级断言；依赖零新增（PRD §14 行 391）

**非目标**（S5 不做）：

- 命中校验（该 manifest 是否依赖该包——S2 `findDependents`/`DepHit` 上游职责）；仅 peer 命中时是否/如何警告用户的编排与文案（S6 命令层 / S9 交互层）
- package.json 文件读/写 IO 与 install 编排（纯函数进出 `string`；读写与执行顺序归 S6/S7）
- 非 lpm 管理的本地链接检测三选一（PRD §9 行 310——S6 link 前置检查）
- 三态恢复语义（unlink 时 range 被手动升级——S7）；drift/orphan 状态判定与三方核对（S8）
- node_modules / lockfile 触碰（install 归 S6/S7）
- peerDependencies 以外段的警告策略（resolutions / overrides 等不扫描不改写不警告——PRD 命中范围仅四段）

## 2. 方案权衡（brainstorming 定版，2026-09-26）

| 决策点 | 定版 | 被否选项与理由 |
|---|---|---|
| 0. 改写算法 | **单遍字符扫描 + value 字面量区间拼接**（字符串感知 + 花括号深度计数 + 字面量全等比对，§4.4） | JSON.parse + 重序列化：恰是 B3 要修的破坏本身；引入格式保持 JSON AST 库（jsonc-parser 等）：新增运行时依赖，违反 PRD §14「无其他运行时依赖」 |
| 1. peer 警告通道 | **新增纯查询导出 `findDepEntries(manifestSource, pkgName): string[]`**（返回包名出现的全部段名含 peerDependencies） | RewriteResult 加字段：违反 S1 冻结签名「不得改动」；peer 命中塞 unchangedKeys：污染「值已等于目标（幂等命中）」冻结语义，S6 无法区分幂等与跳过；推迟 S6 再定：S6 期才发现 S5 产出不够用可能返工 rewriter |
| 2. golden 样本载体 | **内联字符串样本**（`tests/unit/rewriter-samples.ts`，模板字符串逐字节控制） | 磁盘 fixture（沿用 tests/fixtures/workspace/ 惯例）：git autocrlf / 编辑器规范化 / Write 工具剥 BOM、PowerShell 对已有 BOM 文件二次补出双 BOM（S2 账本行 26 Ruling，2026-09-26 双 BOM 教训）使 byte 级断言天然脆弱，且需 .gitattributes 锁定 + Node 脚本生成两个额外部件；PRD「真实世界样本集」重在特征覆盖（CRLF/BOM/缩进/单行块）而非必须是磁盘文件 |
| 3. 多段命中语义 | **全部命中段都改**，changedKeys 逐段记录（如 `["dependencies.x", "devDependencies.x"]`） | 仅改优先级最高段：偏离 PRD「命中范围三段」字面语义，且需额外优先级规则文档化，行为可预测性差 |
| 4. mapProtocol 跨盘符 | **新增错误类 `ProtocolPathError`**（Windows 跨盘符 path.relative 退化为绝对路径时抛出，message 含两路径） | 普通 Error：调用方（S6）无法类型化区分「无法相对化」与其他内部错误，违背 core 错误类惯例（WorkspaceNotFoundError/ManifestParseError 同款）；静默返回绝对路径：违反 PRD「永不输出绝对路径」红线 |

## 3. 架构

```
src/core/rewriter.ts   # S1 §4.3 四冻结 stub → 实现；+ findDepEntries + ProtocolPathError（新增导出）
```

- 无新增源码模块：S1 §4.3 已预留落点；分层规则不变（S1 §3）——`core/*` 不依赖 `state/*`，rewriter 对 `core/pm` 仅有类型导入（S1 冻结 import 行）
- 纯函数层：无 IO、无子进程、无日志；S6/S7 编排层负责文件读写与 install（§5）
- 扫描器为模块内私有实现（不导出）：findDepEntries / rewriteDepValue / restoreDepValue 三者共用同一扫描器，行为单源

## 4. 组件与接口

### 4.1 文件清单（交付物）

```
src/core/rewriter.ts             # 4 冻结 stub → 实现 + findDepEntries + ProtocolPathError
tests/unit/rewriter-samples.ts   # 新增：golden 内联样本集（§4.5，纯数据模块供测试 import）
tests/unit/rewriter.test.ts      # 新增：golden 断言 + 全行为契约（§7.2）
docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md   # 回写（§4.6 义务）
```

样本集独立成文件的理由：样本矩阵预估 300+ 行测试数据，与断言逻辑分离便于评审与维度盘点；vitest 仅收集 `*.test.ts`，samples 模块不受影响。若 plan 期评估体量偏小可合并进 rewriter.test.ts（计划期修订位）。

### 4.2 冻结签名（S1 §4.3 原文，S5 实现不得改动）

```ts
import type { PackageManagerId } from './pm'

export type Protocol = 'link' | 'portal' | 'file'

/** PRD §5 协议映射：pnpm | yarn-classic → link:，yarn-berry → portal:，npm → file:；
 *  返回完整依赖值（协议前缀 + 相对路径），相对路径基于 manifest 所在目录换算，
 *  正斜杠，永不输出绝对路径 */
export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string

export interface RewriteResult {
  content: string          // 改写后全文
  changedKeys: string[]    // "段名.包名"
  unchangedKeys: string[]  // 值已等于目标（幂等命中）
}

/** 文本级替换（PRD §9）：保持缩进 / key 顺序 / 尾随换行 / CRLF-LF / BOM；
 *  仅动命中行的 value；命中段：dependencies / devDependencies / optionalDependencies */
export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult

/** unlink 恢复原 range，格式保持语义同上 */
export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult
```

### 4.3 新增导出（沿用 S3 spec §4.3 公共 API 冻结面约定：冻结面零改动，允许新增）

```ts
// src/core/rewriter.ts —— 构造风格与 core 既有错误类同款（parameter properties + this.name 赋值）
/** mapProtocol 无法相对化（Windows 跨盘符，path.relative 退化为绝对路径）时抛出 */
export class ProtocolPathError extends Error {
  constructor(public libDirAbs: string, public manifestDirAbs: string, message: string)
}

/** pkgName 在 manifest 中出现的全部依赖段名——S6 警告「peerDependencies 不改写」与
 *  O4 完成提示段清单的数据源（裁定①）；纯查询不改写不报错 */
export function findDepEntries(manifestSource: string, pkgName: string): string[]
```

公共 API 面合计：冻结 5 导出（Protocol / mapProtocol / RewriteResult / rewriteDepValue / restoreDepValue）+ 本 spec 新增 2（findDepEntries / ProtocolPathError）= **7 导出封闭面**。扫描器不导出。

### 4.4 行为契约（逐条）

**mapProtocol(pm, libDirAbs, manifestDirAbs)**：

```
1. 协议前缀（S3 spec §8 定版）：pnpm → 'link:'、yarn-classic → 'link:'、yarn-berry → 'portal:'、npm → 'file:'
2. 相对路径 = path.relative(manifestDirAbs, libDirAbs)；输入可为反斜杠形态（Windows 惯例），输出统一正斜杠（F4 措辞修正，与 §7.2 #2 对齐）；path 模块按平台默认解析——v1 以 Windows 为主环境，POSIX 上的 Windows 形态路径属跨平台 CI 议题，超出 v1 范围（F8 假设显式化）
3. 结果不以 './' 或 '../' 段开头（段感知 /^\.\.?($|\/)/，OCR 修复轮精化：'.libs/foo' 这类点开头目录亦补前缀，防产出非法 'file:.libs/foo'）→ 补 './' 前缀（如 'libs/foo' → './libs/foo'）；结果为空串（同目录）→ './'
4. 结果为绝对路径（Windows 跨盘符时 path.relative 退化为盘符开头绝对路径；判定：
   path.isAbsolute(rel) || /(^|\/)[a-zA-Z]:(\/|$)/ 双兜底——OCR 修复轮尾锚定精化，防误伤 POSIX 合法含冒号目录名）→ 抛 ProtocolPathError（message 含两路径）
5. 返回 协议前缀 + 相对路径（如 'link:../lib'、'file:./libs/foo'）
   步骤 3/4 联合保证「永不输出绝对路径」（PRD 红线）
```

**rewriteDepValue / restoreDepValue（同一引擎，restoreDepValue = 对 originalRange 复用 rewriteDepValue，不造第二实现）**：

```
扫描器（单遍、字符串感知）：
  - 字符串状态机：进入 '"' 字面量后跳过内容；字符串内遇 '\' 跳过下一字符（任意转义对，标准
    JSON 转义语义——F1：仅按 '\"' 特判会漏判 "a\\" 尾反斜杠字面量的真实结束，深度计数漂移）
    ——防 scripts 值内花括号/引号字样干扰
  - 花括号深度计数（仅字符串外）：深度 1 的字符串 key 为顶层段键
  - 所有 key 比对（段键与包名 key）先经 JSON 转义解码再 ===（F2：合法转义写法如 "@scope\/pkg"
    ——部分序列化器如 PHP json_encode 默认产物——不得漏命中；与 value 幂等判定的 JSON.parse 同解码语义）
  - 段键 ∈ { dependencies, devDependencies, optionalDependencies, peerDependencies } → 进入段体（深度 2）；
    四段名单与协议映射各以模块内常量单源定义（F6，防多处清单漂移成第二份真相）
  - 段体内字符串字面量（解码后）与 pkgName 全等，且后随 ':' + 字符串字面量 value → 记为命中点
  - 同名段（重复段键）与段内同名 key 重复出现（病态但真实，F3）：全部命中点均改写；keys 按
    "段名.包名" 去重——任一命中点需改写 → changedKeys 记一次，全部幂等 → unchangedKeys 记一次。
    注：同名异值文件的 rewrite→restore 不保证 byte 级还原（state.original 取自 JSON.parse 末位胜出值）
    ——病态输入边界明示，不设分支
改写（仅三改段；peerDependencies 段命中点不改写——PRD §9 行 312「不改写仅警告」，警告数据经 findDepEntries 查询）：
  - 命中点 value 字面量区间拼接替换为 JSON.stringify(targetValue)（合法 JSON 字面量，含转义兜底）
  - 幂等判定：原 value 字面量 JSON.parse 后 === targetValue → 记 unchangedKeys（"段名.包名"），字节零改动
  - 多段命中逐段全改（裁定③），changedKeys 逐段记录 "段名.包名"（同段可与其他段并存）
  - 同段/跨段多命中点均逐点处理（重复 key/段语义见扫描器 F3 条）
保真（B3 修复落点）：
  - 仅 value 字面量区间被替换；区间外全部字节（BOM / 行尾含混合行尾 / 缩进 / key 顺序 / 尾随换行）byte 级原样
零改动路径（均非错误）：
  - pkgName 零命中（含仅 peer 命中）→ content 原样返回、changedKeys/unchangedKeys 皆空
    （命中校验是 S2 DepHit / S6 上游职责；JSON 合法性由 S2 ManifestParseError 把关——文本引擎容错任意文本）
  - 命中点 value 非字符串字面量（畸形，如 "x": {}）→ 视为未命中不动
```

**findDepEntries(manifestSource, pkgName)**：

```
复用同一扫描器，扫四段（三改段 + peerDependencies），返回命中段名（重复段去重，F3 同族）
顺序固定：dependencies → devDependencies → optionalDependencies → peerDependencies
零命中 → []；不改写、不报错、不触碰 content
```

### 4.5 golden 内联样本集（裁定②，PRD §13.9 行 387 维度全量）

样本形态：`{ name, source, pkgName, targetValue, expectedContent, changedKeys, unchangedKeys }`（expectedContent 手写 golden，评审可读；双 keys 数组精确断言；restore roundtrip 作为辅助断言）。维度矩阵（每维度 ≥1 样本，具体条数 plan 期核算）：

| # | 维度 | 覆盖点 |
|---|---|---|
| 1 | 基线 | LF + 2 空格 + 尾随换行 |
| 2 | 行尾 | CRLF；混合行尾（同文件 CRLF/LF 混杂，逐行原样保留） |
| 3 | 缩进 | 4 空格；tab |
| 4 | BOM | BOM+LF；BOM+CRLF（BOM 字节保留断言） |
| 5 | 单行 | 单行依赖块（段体在一行）；整文件单行（minified） |
| 6 | 尾随换行 | 无尾随换行 |
| 7 | key 序 | 乱序 / devDependencies 在 dependencies 前 |
| 8 | 包名 | @scope/package |
| 9 | 多段命中 | dependencies + devDependencies 同包（裁定③） |
| 10 | 仅 peer | 零改写 + findDepEntries 数据源 |
| 11 | 幂等 | 值已等于目标 → unchangedKeys |
| 12 | 空段 | "dependencies": {} |
| 13 | 值形态 | workspace:* / catalog: / 已是本地协议 file:../x（纯引擎照改，无策略） |
| 14 | 转义与重复（评审轮新增） | key 含 `\/` 转义（"@scope\/pkg" 命中且转义形态 byte 保留，F2）；value 含尾反斜杠 `"a\\"`（F1 扫描器守护）；段内重复 key / 重复段全改写 + keys 去重（F3） |
| 15 | optionalDependencies 命中（OCR 修复轮补维） | 三改段全覆盖（dependencies / devDependencies / optionalDependencies 各有正向 golden） |

### 4.6 回写义务（S1 §4.6 演进约定）

1. **S1 spec §4.3 core/rewriter.ts 节**：标题注记「（S5 填充）」→ 改注已由 S5 实现；mapProtocol / rewriteDepValue / restoreDepValue 三行的 `// stub` 注释移除（S4 回写 §4.4 先例同款）
2. 回写仅动 S1 spec 上述节；RewriteResult 接口定义无 stub 注释不动

## 5. 数据流

```
S6 link  ：findDependents（S2 命中校验）→ 读 manifest 全文（IO 归 S6）
           → findDepEntries（仅 peer 命中 → 警告跳过；三段命中 → 继续）
           → mapProtocol（pm → 协议值 link:../lib 等）
           → rewriteDepValue 逐 manifest 改写 → 写回文件（IO 归 S6）→ install（S6）
S7 unlink ：readState（S4）取 original → 读 manifest → restoreDepValue 恢复 → 写回 → install → deleteState
S8 status ：三方核对需 pkg 当前值——值级查询不在 S5 导出面（§8 衔接表注记，S8 期再议）
```

## 6. 错误处理（逐条）

| # | 场景 | 行为 | 文案关键片段 |
|---|---|---|---|
| 1 | mapProtocol 跨盘符无法相对化 | 抛 `ProtocolPathError`（S5 唯一错误源） | message 含 libDirAbs 与 manifestDirAbs 两路径 + 「无法生成相对路径（跨盘符？）」（具体措辞实现期定，含两路径为硬要求） |
| 2 | manifestSource 为任意文本（含坏 JSON） | 不报错——文本引擎容错（B3 反面教训：引擎不依赖 JSON 可解析性）；JSON 合法性由 S2 ManifestParseError 在更上游把关 | — |
| 3 | pkgName 零命中 / 仅 peer 命中 | 非错误：content 原样 + 双数组空（命中校验 S2/S6 职责，裁定①的警告路径） | — |
| 4 | 命中点 value 非字符串字面量（畸形） | 非错误：视为未命中不动 | — |
| 5 | targetValue 含需转义字符 | JSON.stringify 生成合法字面量（正常路径，非错误） | — |

无 IO/子进程错误面（纯函数）；fs 失败 crash 语义不适用（S3 账本行 37 Ruling 的 IO 归属在 S6/S7 编排层）。

## 7. 测试与验收

### 7.1 分层

- unit：rewriter.test.ts（golden 断言 + 行为契约 + mapProtocol + findDepEntries + 错误）；样本集 rewriter-samples.ts（§4.5）
- e2e：**无新增**——S5 为纯库层，无命令消费面（11 例回归不变）

### 7.2 unit 清单（每条契约至少一正一反）

mapProtocol：

1. 四 pm 映射：pnpm→`link:` / yarn-classic→`link:` / yarn-berry→`portal:` / npm→`file:`（`../lib` 形态全过）
2. 相对换算基准 = manifestDir：lib 为上级目录 / 子目录 / 同级多形态；Windows 反斜杠输入 → 正斜杠输出
3. `./` 前缀规则：不以 `.` 开头补 `./`；同目录 → `./`
4. 跨盘符（`C:\...` → `D:\...`）→ ProtocolPathError（断言 libDirAbs/manifestDirAbs 属性 + message 含两路径）

rewrite / restore（golden 矩阵 §4.5 逐样本：content byte 级 === expectedContent + changedKeys/unchangedKeys 精确断言）：

5. 基线 LF / 2 空格 / 尾随换行（#1）
6. CRLF / 混合行尾（#2）
7. 4 空格 / tab（#3）
8. BOM 两态（#4，BOM 字节保留断言）
9. 单行依赖块 / 整文件单行（#5）
10. 无尾随换行 / key 乱序 / @scope（#6–8）
11. 多段命中（#9，裁定③：双段 changedKeys）
12. 仅 peer 命中（#10）→ 零改动 + 双数组空
13. 幂等命中（#11）→ unchangedKeys + 字节不动
14. 空段 / 值形态三例（#12–13，含已本地协议照改）；optionalDependencies 命中（#15，OCR 修复轮补维——三改段全覆盖）
15. restore roundtrip：rewrite 后 restoreDepValue(content, pkg, 原值字面量) === source（byte 级还原，辅助断言）
16. 零命中 → content 原样双空（含空串 / 纯空白 manifestSource，F7）；命中点 value 非字符串字面量 → 不动（§4.4 零改动路径）
17. 字符串感知守护：scripts 值含 `"dependencies"` 字样或花括号的 manifest 不误判段（扫描器状态机回归用例）

findDepEntries：

18. 四段全命中 → 顺序断言（固定顺序）；仅 peer 命中；零命中 → []
19. 转义与重复（§4.5 #14）：`\/` 转义 key 命中改写且 key 转义形态 byte 保留；`"a\\"` 尾反斜杠 value 改写不误扫；段内重复 key / 重复段全改写 + keys 去重（F1/F2/F3）

### 7.3 e2e 清单

既有 11 例回归不变；无新增。

### 7.4 验收标准

1. `pnpm verify` 全绿（typecheck + build + unit 含新增 + e2e 11），本机 Windows 通过
2. §4.4 契约 ↔ §7.2 用例双向映射齐全；golden 矩阵 §4.5 维度全量覆盖（每维度 ≥1 样本）
3. S1 §4.3 冻结签名逐字一致；公共 API 恰为冻结 5 导出 + findDepEntries + ProtocolPathError = 7 导出封闭面（扫描器不导出）
4. 依赖白名单不变：运行时依赖零新增（rewriter 仅 node:path + `import type PackageManagerId`）
5. S1 spec 回写完成（§4.6 义务，stub 注记清理）
6. unit 总数 = 122 + 新增（精确计数 plan 期核算，测试代码为权威——S3/S4 先例）

## 8. 后续衔接

| 消费方 | 依赖的 S5 产出 |
|---|---|
| S6 link | mapProtocol（协议值）+ rewriteDepValue（改写）+ findDepEntries（peer 警告数据源 + O4 完成提示段清单）；manifest 文本读写 IO 与 install 编排归 S6。消费提示（F5）：changedKeys/unchangedKeys 形如 "段名.包名" 而包名可含点（如 lodash.chunk）——按段名前缀匹配或整体展示，禁止按 '.' 切分 |
| S7 unlink | restoreDepValue（恢复 original）；写回与崩溃安全顺序（恢复 → install → 删 state）归 S7 |
| S8 status/repair | 三方核对需 pkg 当前**值**——值级查询不在本 spec 导出面（findDepEntries 仅段名）；S8 spec 编写期确认是否新增查询导出（YAGNI 预留位，届时沿用公共 API 新增约定） |
| S9 交互 | 无直接（警告文案归命令/交互层） |

本 spec 评审通过后：invoke **writing-plans** 出 S5 implementation plan → SDD 逐任务实施（同 S1–S4 流程）。

## 9. 待评审决策点

无开放决策——方案选型 A + 四个关键裁决已在 brainstorming 拍板（§2）。实现期自决细节（非决策，评审可否决）：幂等判定用语义比对（value 字面量子串 JSON.parse 后 === targetValue）而非字面量文本比对；跨盘符判定 `path.isAbsolute(rel) || /(^|\/)[a-zA-Z]:(\/|$)/` 双兜底（OCR 修复轮尾锚定精化）；样本集独立 rewriter-samples.ts（plan 期可复核合并）；ProtocolPathError message 具体措辞（含两路径为硬要求）；协议值同目录返回 `./` 短路径（`file:./` 形态合法）。

## 10. 评审 Backlog

六手法 + 场景 B 角色面板（架构师/资深开发/资深测试/交付运维）全过（2026-09-26）。发现 0 P0 + 3 P1 + 7 P2；P1 全部修复、P2 三态处置如下；修复后手法 3 复跑 + 逐项同族扫描 + 第 2 轮全过，零新增 P0/P1，两轮收敛。

**P1 修复对照**：

| # | 问题（触发序列/证据） | 修复落点 |
|---|---|---|
| F1 | 扫描器转义契约欠定：仅写「'\"' 转义不截断」，未覆盖 \\ 等任意转义对——按字面实现遇 "a\\"（尾反斜杠字面量，Windows 路径值真实形态）会把真实结束引号误判为转义引号，字符串吞越界 → 深度计数漂移 | §4.4 扫描器第 1 条：字符串内遇 '\' 跳过下一字符（任意转义对） |
| F2 | key 比对未定义转义解码：合法 JSON 转义写法 "@scope\/pkg"（PHP json_encode 默认等产物）原样比对漏命中 → S2 parse 级命中与 S5 文本级零改写不一致（link 流程静默没改） | §4.4 扫描器：段键与包名 key 比对均先经 JSON 转义解码；§4.5 #14 + §7.2 #19 用例 |
| F3 | 段内同名 key 重复出现行为未定义（原句「段内 JSON 语义同名单 key」语义含糊）；同族扫描补抓：重复顶层段键同样未定义 | §4.4 扫描器末条：全命中点改写 + keys 去重 + 同名异值 roundtrip 边界注记；findDepEntries 段名去重；§4.5 #14 + §7.2 #19 |

**P2 已采纳**：

| # | 问题 | 修复落点 |
|---|---|---|
| F4 | §4.4 step 2「输入输出均为正斜杠」与 §7.2 #2 矛盾 | 改「输入可为反斜杠形态，输出统一正斜杠」 |
| F5 | "段名.包名" 与含点包名（lodash.chunk 真实存在于 npm）按 '.' 切分歧义 | §8 S6 行消费提示：按段名前缀匹配或整体展示，禁按 '.' 切分 |
| F6 | 段名/协议映射多清单无单源要求（第二份真相风险） | §4.4：模块内常量单源定义 |
| F7 | 空串/纯空白 manifestSource 输入未显式用例 | §7.2 #16 扩 |
| F8 | 平台默认 path 解析假设未显式化 | §4.4 step 2 注记：v1 Windows 主环境，跨平台 CI 超 v1 范围 |

**P2 已关闭**：

| # | 问题 | 理由 |
|---|---|---|
| F10 | 同名异值文件 restore 不保证 byte 级还原 | JSON.parse 末位胜出语义与文本级全改写本质冲突；病态输入，边界已在 §4.4 注记，不设分支 |

**P2 候选**：

| # | 问题 | 触发信号 |
|---|---|---|
| F9 | `\\?\` 长路径前缀输入可能被误判绝对路径抛 ProtocolPathError | 长路径形态真实出现 ≥1 次（届时入口归一化剥前缀） |
