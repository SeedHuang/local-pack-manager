# S2 · 项目发现与 workspace 解析 设计文档（spec）

- 日期：2026-09-25
- 状态：待评审
- 路径归类：superpowers architectural（lpm 子项目 spec，S1 的下游）
- 上游：S1 spec（docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md，§4.3 冻结签名）+ PRD §14-S2 / §13.9 / §11 / §15.4
- 依赖：S1（已完成，`pnpm verify` 全绿）
- 评审提示：**依赖策略默认采纳"选项 A：零新增运行时依赖"**（手写受限 glob + 极简 YAML 子集解析）；用户指令将 glob 语义与错误处理升格为本 spec 的重点章节。若评审时认为应引入现成库（B 方案），推翻此默认即可，§2 已备好权衡记录

## 0. 流程注记与要素映射

- 位置与结构：沿用 S1 确立的 superpowers 默认（`docs/superpowers/specs/`、问题→方案权衡→架构→组件→数据流→错误处理→测试）
- **与 S1 演进约定的衔接（§4.6）**：本 spec 新增 1 个内部支撑文件 `src/core/globmatch.ts`（受限 glob 匹配器，导出纯函数以便 golden 测试）；`src/core/workspace.ts` 为公开面唯一落点（YAML 子集解析为其内部非导出函数）。公共 API 仅新增 3 个错误类，S1 冻结签名零改动
- PRD §14 五要素映射：目标→§1；交付物→§4.1；接口定义→§4.2–4.5；测试清单→§7.1–7.3；验收标准→§7.4

## 1. 问题与目标

**问题**：S1 冻结了三个 stub（`findWorkspaceRoot` / `loadWorkspace` / `findDependents`）。S6 link 的第一步是"定位项目根 + 展开成员 + 命中声明了该依赖的文件"——S2 把这条只读管线填成真实现。PRD 要求 lpm 世界观与 PM 完全一致：**管辖范围 = workspace 清单成员 + 根，清单外不碰**（PRD §4）。

**目标**：

1. `findWorkspaceRoot`：从任意 cwd 向上探测，区分 pnpm workspace / npm·yarn workspace / 单包项目三种根
2. `loadWorkspace`：解析三格式清单 → glob 展开成员（含排除）→ 产出确定序的成员清单
3. `findDependents`：扫描全部成员三类依赖位，产出命中列表（供 S6 改写引擎消费）
4. 全程**只读**：任何失败不改变磁盘状态，重试安全（PRD §11 逃生门的前提）
5. 单测覆盖三清单格式 / glob / 排除（PRD §13.9），glob 语义逐条 golden 测试

**非目标**（S2 不做）：

- PM 检测与 use（S3）——本 spec 不读 lockfile，不做 pnpm/npm/yarn 判定
- peerDependencies 命中与警告（S1 冻结注释：S5/S6 处理）
- catalog / pnpm 独有扩展字段的解析（只读 `packages` 键，其余忽略）
- 传递依赖扫描（只扫成员直接声明，PRD 改写对象即声明处）
- 真实 BFM 联调验证（S6 验收）

## 2. 方案权衡

| 决策点 | 定版 | 被否选项与理由 |
|---|---|---|
| glob + YAML 依赖策略 | **A：零新增依赖**——手写受限 glob 匹配器（`src/core/globmatch.ts`，纯函数导出）+ 极简 YAML 子集解析（workspace.ts 内部函数） | B：引入 tinyglobby+yaml——兼容性最稳，但违背 PRD §14"无其他运行时依赖——lpm 自身要轻"，且需连带修订 S1 验收 5；C：只引 yaml——YAML 方言深，库省心，但 glob 手写后仍需同等 golden 测试，两害取其轻不如统一手写+统一测试策略。A 的风险（语法长尾不支持）由 §5 语义精确化 + §6 明确报错（绝不静默当字面量）+ §7 golden 测试三重兜底 |
| 成员发现方式 | **全树遍历 + 模式过滤**：walker 遍历 rootDir 目录树（跳过 node_modules 与点目录），对每个目录的相对路径跑模式匹配，命中且含 package.json 者为成员 | 模式驱动下钻（按 pattern 逐段走目录）：快但实现复杂、负模式与 `**` 零段语义易错；monorepo 规模小，全树遍历成本可忽略 |
| 错误策略 | **结构/语法错误 → 明确报错（带下一步动作）；语义空结果 → 合法值**（patterns 非空但零命中 = 合法，members=[root]） | 容错跳过（坏清单当空清单）：会把"清单写错"伪装成"没有成员"，下游 S6 报"目标不在任何成员依赖中"——误导方向，违背 PRD"错误即建议" |
| 大小写 | pattern 字面量段**大小写敏感**，与 PM 行为一致；大小写写错 → 零命中（合法空结果），不猜 | Windows 大小写折叠"智能匹配"：不可预测，违反 PRD §15.4"可测"要求 |
| 成员清单读取次数 | loadWorkspace 为 name 读一次、findDependents 为命中再读一次（不缓存） | Workspace 内缓存 manifest 内容：冻结类型无此字段，双读成本可忽略 |
| Windows 容错 | 读取清单统一**去 UTF-8 BOM** 后 JSON.parse；YAML 按行解析时容忍 `\r\n` | 原样 parse：Windows 编辑器常写 BOM，会让合法清单误报"解析失败"（PRD §15.4 风险面） |

## 3. 架构

```
cli 层（不变，S2 无命令面变化）
   └─ core/workspace.ts        # S2 填充：findWorkspaceRoot / loadWorkspace / findDependents
        ├─ 内部：parsePackagesYaml()      # 极简 YAML 子集（非导出）
        └─ core/globmatch.ts    # S2 新增：matchWorkspacePattern(pattern, relDir) 纯函数（导出，供 golden 测试）
```

- 依赖方向不变：workspace.ts → globmatch.ts（同层 core 内引用，无反向）；不触碰 commands/* 与 state/*
- 数据全部只读：三个导出函数只做 fs 读操作（existsSync/readFileSync/readdirSync）
- 错误类定义在 `core/workspace.ts`（领域错误随首个使用它的模块落地，符合 S1 spec §6"由实现 spec 自行引入"）

## 4. 组件与接口

### 4.1 文件清单（交付物）

```
src/core/
├─ globmatch.ts        # 新增：受限 glob 匹配器（纯函数，无 IO）
└─ workspace.ts        # S1 stub → 实现：三个导出函数 + 3 个错误类 + 内部 YAML 子集解析
tests/
├─ unit/
│  ├─ globmatch.test.ts         # 语义 golden（§5 逐条 ↔ 测试双向映射）
│  ├─ find-workspace-root.test.ts
│  ├─ load-workspace.test.ts
│  └─ find-dependents.test.ts
└─ fixtures/workspace/          # 提交到库内的 fixture 树（golden 可读、跨平台稳定）
   ├─ monorepo-pnpm/            # pnpm-workspace.yaml：块列表+引号值+排除+catalog 同存
   ├─ monorepo-npm/             # package.json workspaces：数组 form
   ├─ monorepo-npm-object/      # package.json workspaces：{ packages: [...] } form（yarn classic）
   ├─ monorepo-empty-patterns/  # pnpm-workspace.yaml 无 packages 键（本仓库自身即真实样本）
   ├─ single-package/           # 单包项目
   └─ broken/…                  # 坏 JSON / 坏 YAML / 非法 pattern 各一
```

### 4.2 冻结签名（S1 §4.3 原文，S2 实现不得改动）

```ts
// 返回值语义不变，此处仅重申
findWorkspaceRoot(startDir: string): Promise<string>
loadWorkspace(rootDir: string): Promise<Workspace>
findDependents(ws: Workspace, pkgName: string): Promise<DepHit[]>
// PackageJsonInfo { dir; manifestPath; name（缺失为空串）; isRoot }
// Workspace { rootDir; manifestFormat: 'pnpm-workspace' | 'package-json' | 'single'; members（含根） }
// DepHit { manifestPath; section: 'dependencies' | 'devDependencies' | 'optionalDependencies'; currentValue }
```

**manifest 读取规约（约束 4.4/4.5/4.6 全部读清单处）**：`readFileSync` 后**剥掉行首 UTF-8 BOM** 再 `JSON.parse`——Windows 编辑器常写 BOM，不去除会把合法清单误判为解析失败；本规约仅作用于读取，不影响 S5 改写时的 BOM 保留契约。

### 4.3 新增导出：错误类与匹配器

```ts
// src/core/workspace.ts —— 三个错误类（均 extends Error，name = 类名）
export class WorkspaceNotFoundError extends Error {
  constructor(public kind: 'start-dir-missing' | 'root-not-found' | 'invalid-root', message: string)
}
export class ManifestParseError extends Error {   // JSON 语法错 / YAML 子集解析失败
  constructor(public manifestPath: string, message: string)
}
export class WorkspacePatternError extends Error { // 不支持的 glob 语法
  constructor(public pattern: string, public manifestPath: string, message: string)
}

// src/core/globmatch.ts —— 匹配器（纯函数；pattern 语法非法时抛 WorkspacePatternError，
// 此时 pattern 与 message 已填、manifestPath 置空串；loadWorkspace 捕获后以填充
// manifestPath 的同类新错误重抛——错误类型不丢失，定位信息补全）
export function matchWorkspacePattern(pattern: string, relDir: string): boolean
```

### 4.4 findWorkspaceRoot 行为契约

1. 从 `startDir` 起**含自身**逐级向上（`path.dirname` 步进，至盘根止）
2. 目录含 `pnpm-workspace.yaml` → 即根（后续 `manifestFormat` 将为 `'pnpm-workspace'`）
3. 目录含 `package.json` 且 workspaces 字段可解析为数组或 `{ packages: 数组 }`（**含空数组**）→ 即根（`'package-json'`）；JSON 解析失败 → 不算标记，继续向上
4. 同目录两种标记并存 → 优先按 2（pnpm 世界观）；**树上不同层级的标记，最近者优先**（嵌套 workspace 场景取内层）
5. 走到盘根无任何标记 → 回退：**walk 过程中遇到的第一个（最近的）含 package.json 目录**即根（单包项目，`'single'`）
6. 盘根亦无 package.json → `WorkspaceNotFoundError('root-not-found')`
7. `startDir` 不是存在的目录 → `WorkspaceNotFoundError('start-dir-missing')`
8. 纯结构性探测：本函数**不返回格式**，格式判定在 loadWorkspace（单一事实源，避免两处判定漂移）

### 4.5 loadWorkspace 行为契约

```
loadWorkspace(rootDir):
  1. 读 <rootDir>/package.json（按 4.2 读取规约去 BOM）—— 缺失 → WorkspaceNotFoundError('invalid-root')；
     JSON 语法错 → ManifestParseError
  2. 判定 format 与 patterns（与 4.4 的判定规则一致）：
     pnpm-workspace.yaml 存在 → 'pnpm-workspace'，patterns = parsePackagesYaml(源)
     否则 workspaces 为数组或 { packages: 数组 } → 'package-json'，patterns = 数组
        （workspaces 字段存在但既非数组也非该对象形态 → 视为无 workspaces，防止脏字段伪装成清单）
     否则 → 'single'，patterns = []
  3. 成员展开：
     members = [root（isRoot: true，name 读根 manifest）]
     patterns 非空 → 先对全部 pattern 做语法校验（任何一个非法即抛 WorkspacePatternError，
       错误前置、一次报全），再 walker 遍历 rootDir 目录树（DFS、每层字典序、深度无限）：
       - 跳过：node_modules（硬编码，任何 pattern 无法匹配进来）、点目录（任何层级的 .开头目录）
       - 不跟随目录符号链接（防环）
       - 每个目录的相对路径（posix）依次过 patterns：先取全部正模式并集，再依序应用 !负模式剔除
       - 命中目录若含 package.json → PackageJsonInfo { isRoot: false, name 读其 manifest }
       - 命中目录不含 package.json → 非成员，但**继续下钻**（后代仍可能命中，与 pnpm 行为一致）
     patterns 为空 → 仅 root（'single' 或"无 packages 键"的 pnpm workspace）
  4. 返回 Workspace { rootDir, manifestFormat, members }（root 恒在首位，其余 DFS 字典序）
```

错误：成员 manifest JSON 坏 → `ManifestParseError`；pattern 语法非法 → `WorkspacePatternError`（§4.3 的重抛机制补全 manifestPath 定位）。

### 4.6 findDependents 行为契约

```
findDependents(ws, pkgName):
  遍历 ws.members（含根）各 manifestPath（读取规约同 4.2：去 BOM）：
    依次查 dependencies → devDependencies → optionalDependencies 三段
    pkgName 为键精确匹配（不做 scope 通配、不读 peerDependencies）
    命中 → DepHit { manifestPath, section, currentValue: 该键的值字面量 }
  同一 manifest 多段命中 → 多条 DepHit（按上述段顺序）；同段同键天然唯一（JSON 对象）
  manifest 读取/解析失败 → ManifestParseError（传播，不静默跳过）
  空 deps / 缺段 → 合法，无命中
```

### 4.7 接口演进回写义务

本 spec 落地后，S1 spec §4.1 文件清单与 §4.3 接口定义需同步补记：globmatch.ts 新文件、3 个错误类导出（在 S2 的 plan 实施完成后回写，保持 spec 与代码一致——S1 §4.6 约定）。

## 5. glob 语义（受限模式语言，逐条契约）

**匹配对象**：目录的相对路径（相对 rootDir，一律 posix 正斜杠，如 `packages/server`、`apps/web`）；root 自身相对路径为空串，**永不参与模式匹配**（root 恒为成员）。

**输入规范化**：pattern 与目录路径中的 `\` 一律先替换为 `/`（Windows 容错）；pattern 尾随 `/` 去除（`packages/*/` ≡ `packages/*`）。

**段语法**（pattern 按 `/` 切段）：

| 语法 | 含义 | 示例 |
|---|---|---|
| 字面量段 | 精确匹配一个段（大小写敏感） | `packages`、`apps` |
| `*`（独立段） | 匹配**恰好一个**段（段内任意字符；不含 `/`） | `packages/*` → `packages/server` ✓，`packages/a/b` ✗ |
| `**`（独立段） | 匹配**零或多**个段 | `packages/**` → `packages`、`packages/a`、`packages/a/b` 均命中 |
| `!` 前缀（整个 pattern 级） | 负模式：从正匹配并集中剔除 | `!packages/legacy` |
| 段内混合（如 `app*`、`a**b`） | **不支持** → `WorkspacePatternError`（绝不静默当字面量） | — |

**关键语义裁定**：

1. `a/**` 匹配 `a` 自身及全部后代（`**` 可展开为零段，与 micromatch/minimatch 一致）；`a` 自身是否成为成员仍取决于它是否含 package.json
2. 裸 `**` 匹配 root 下全部后代目录
3. 裸 `*` 匹配 root 下第一层目录
4. 点目录不进入候选集（walker 跳过），因此 pattern 无需也无法匹配 `.xxx` 目录——有意收窄，golden 测试锁定
5. `node_modules` 硬编码排除，优先级高于一切 pattern（正负模式都进不来）
6. 负模式不影响正模式的下钻；引用不存在路径的负模式 = no-op，不报错
7. 多正模式取并集；成员按"首次被任一正模式命中"的去重顺序输出
8. 不支持 micromatch 其余语法：`?`、`[abc]`、`{a,b}`、`+(…)`、`@(…)`、`\` 转义、段内 `*`（如 `app*`）——一律 `WorkspacePatternError`，报错文案列出支持集（错误即建议）

**YAML 子集（parsePackagesYaml）**——只提取 `packages` 键，其余键（catalog、allowBuilds 等）整体忽略：

1. 按行解析，容忍 `\r\n` 行尾（Windows）；仅识别第 0 列的 `packages:` 键行；其后、下一个第 0 列键行之前的**恰好 2 空格缩进**的 `- 值` 行为列表项（pnpm 官方 prettier 风格）
2. 值可被单/双引号包裹（成对去引号；不闭合 → `ManifestParseError`）；不支持值内转义
3. 流列表形态 `packages: ['a', b]` 支持（单行、逗号分隔、可选引号）
4. 行注释：`#` 开头的整行忽略；未加引号值中的行内 `#` 截断注释（引号内 `#` 保留）
5. 无 `packages` 键 / `packages:` 后为空 → patterns = `[]`（本仓库自身的 pnpm-workspace.yaml 即此形态的真实样本）
6. `packages:` 后跟非列表标量、或列表项缩进 ≠ 2 空格 → `ManifestParseError`（宁报错不猜测——防 catalog 项混入成员列表）

## 6. 错误处理策略（逐条契约，全部含下一步动作——PRD §11）

| # | 触发 | 错误类型（kind） | 提示文案（中文，含建议） |
|---|---|---|---|
| 1 | `startDir` 不是存在的目录 | `WorkspaceNotFoundError`('start-dir-missing') | `路径不存在：<startDir>。请检查路径后重试。` |
| 2 | 盘根内既无 workspace 标记也无 package.json | `WorkspaceNotFoundError`('root-not-found') | `未找到项目根（未发现 workspace 清单或 package.json）。请进入项目目录后运行 lpm。` |
| 3 | loadWorkspace 的 rootDir 缺 package.json | `WorkspaceNotFoundError`('invalid-root') | `<rootDir> 不是有效的项目根（缺 package.json）。请以 findWorkspaceRoot 的返回值为根。` |
| 4 | 任一 package.json JSON 语法错 | `ManifestParseError` | `清单解析失败：<manifestPath>（<原因>）。请修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状。` |
| 5 | pnpm-workspace.yaml 子集解析失败（缩进/引号/结构） | `ManifestParseError` | `pnpm-workspace.yaml 解析失败：<path>（<原因>）。lpm 仅支持 pnpm 默认风格的 packages 列表（2 空格缩进）；复杂 YAML 请简化后重试。` |
| 6 | pattern 含不支持语法 | `WorkspacePatternError` | `不支持的 workspace pattern "<p>"（<清单路径>）。支持：字面量段、*（单段）、**（独立段）、!排除；不支持 ?、[...]、{a,b}、\ 转义、段内混合。请修改清单中的该 pattern。` |
| 7 | 上述之外的一切 | 原样上抛 | S2 不设全局兜底（命令层的"错误即建议"全局化在 S12） |

**策略性原则**（评审重点）：

- **只读保证**：S2 三个函数零写操作，任何错误后磁盘状态不变、重试幂等（PRD §11 逃生门的结构性前提）
- **报错优于猜测**：语法/结构问题一律抛错（宁可停止，不给下游喂错误的成员列表）；只有"语义上的空"（patterns 非空零命中、无 packages 键）是合法结果
- **不静默跳过**：坏成员 manifest 不跳过（那会让 S6 漏改一个声明文件却不自知）；唯一"跳过"是 walker 的规则性排除（node_modules / 点目录 / 符号链接不跟随），属语义而非容错
- 错误类均 `extends Error` 且 `name` = 类名，message 首行即上述文案——S6 起命令层可直接透传

## 7. 测试与验收

### 7.1 分层

- unit：globmatch 纯函数 golden（无 IO）；三个导出函数用 `tests/fixtures/workspace/` 提交式 fixture 树（跨平台路径稳定、golden 可读）
- e2e：**无新增**（S2 无命令面变化，11 个命令仍为 stub）；`pnpm verify` 全链回归即为门禁

### 7.2 unit 清单

| 文件 | 用例 | 断言要点 |
|---|---|---|
| globmatch.test.ts | §5 语义表逐条 golden | 每行语义 ≥1 正例 + 1 反例；`a/**` 含 a 自身；`**` 全后代；尾随斜杠/反斜杠规范化；8 类不支持语法逐一抛 `WorkspacePatternError` |
| find-workspace-root.test.ts | 根探测 | monorepo 内子包 cwd→根；单包 cwd→自身；标记在上层且 cwd 于无 package.json 的中间目录→上层根；双标记最近优先；同目录双标记→pnpm 优先；盘根无标记→root-not-found；startDir 不存在→start-dir-missing；空数组 workspaces 算标记 |
| load-workspace.test.ts | 三格式展开 | pnpm 块列表+引号+排除+catalog 同存→正确 members 序；无 packages 键→仅 root；npm 数组 form；npm 对象 form；空数组→仅 root；single；node_modules/点目录永不入选（即使 pattern 直指）；命中目录无 package.json 时后代仍可命中；DFS 字典序 + root 首位；坏成员 JSON→ManifestParseError；非法 pattern→WorkspacePatternError（先整体校验）；零命中→合法 members=[root]；带 BOM 的根 manifest→正常解析 |
| find-dependents.test.ts | 命中扫描 | 三段各命中；同 manifest 多段多命中（段序）；peer 不产出 hit；空/缺段合法；两成员同名声明→两条 hit；坏 manifest→传播 ManifestParseError；currentValue 为字面量原样 |

### 7.3 fixture 树（提交进库）

见 §4.1；`broken/` 下三个坏样本（坏 JSON / 坏 YAML / 非法 pattern）供错误路径测试复用。

### 7.4 验收标准

1. `pnpm verify` 全绿（typecheck + build + unit 含新增 + e2e 回归），本机 Windows 通过
2. §5 语义表与 globmatch.test.ts 用例**双向映射齐全**（每条语义至少一正一反）
3. §6 错误表逐条有触发测试，断言错误类型 + kind + 文案关键片段（含下一步动作）
4. 三 manifestFormat fixture 展开结果与 golden 一致（members 内容与顺序）
5. 公共接口与 S1 §4.3 冻结签名逐字一致；新增导出仅 §4.3 所列
6. 依赖白名单不变：运行时依赖恰为 commander / @clack/prompts / execa（零新增）

## 8. 后续衔接

| 消费方 | 依赖的 S2 产出 |
|---|---|
| S3 PM 检测与 use | rootDir 定位（lockfile 探测以根为基准）|
| S5 改写引擎 | DepHit.manifestPath / section / currentValue（改写对象）|
| S6 link 直通 | 全链：findWorkspaceRoot → loadWorkspace → findDependents → upsert/改写 |

本 spec 评审通过后：invoke **writing-plans** 出 S2 implementation plan → SDD 逐任务实施（同 S1 流程）。

## 9. 待评审决策点

1. **依赖策略 A（默认采纳）**：零新增依赖、手写受限 glob + YAML 子集——若你倾向 B（tinyglobby+yaml）请在此推翻
2. `a/**` 含 `a` 自身的语义（§5.1，与 micromatch 一致）
3. 点目录永不入选（§5.4，有意收窄）
4. 缩进 ≠ 2 空格的 YAML 列表项报错（§5 YAML.6，宁严勿吞）
5. 大小写敏感匹配、大小写错→零命中合法（§2）
