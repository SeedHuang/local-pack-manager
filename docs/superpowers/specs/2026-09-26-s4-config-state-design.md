# S4 · 配置与状态文件层设计文档（spec）

- 日期：2026-09-26
- 状态：待评审
- 路径归类：superpowers architectural（lpm 子项目 spec，S3 的下游）
- 上游：PRD §9「文件与数据」（行 295–313）/ §11 错误处理政策 / §14-S4（行 403）/ 附录 A（B6 = ".lpm/ 不在 .gitignore 会污染团队仓库，修复落点 §9 第 5 条"）；S1 spec §4.4（state 读写 API 冻结签名）、§4.6（演进约定）、§3（分层规则）；S3 spec §4.6（config 读写与原子写契约）、§4.7（S4 剩余范围）
- 依赖：S1、S2、S3（已完成，`pnpm verify` 全绿：unit 91/91 + e2e 11/11，基线 2026-09-26 复跑）
- 评审提示：五个关键裁决已在 brainstorming 拍板（§2 前五行，2026-09-26），无遗留开放决策点

## 0. 流程注记与要素映射

- 位置与结构：沿用 S1–S3 确立的 superpowers 默认（问题 → 方案权衡 → 架构 → 组件 → 数据流 → 错误处理 → 测试）
- **与 S3 §4.7 的衔接**：S4 剩余范围 = readState/writeState/deleteState/readLast/writeLast/readUserConfig/writeUserConfig/ensureGitignoreEntry（S3 spec 行 232）；`LpmConfigParseError` 与 `state/atomic.ts` 按 S3 spec 引用，不重复定义（S3 spec 行 234）；`state-stub.test.ts` 随 8 stub 全部实现而退役
- **T1① 定版（brainstorming 问 4，2026-09-26）**：`writeJsonFileAtomic` tmp 名仅 pid 后缀的同进程并发互撞风险 → **顺手修**（tmp 加随机段），附 S3 spec §4.6 契约回写义务与并发测试（§4.5）
- **T2① 随 S4 补（交接词定版）**：pm 级间穿透组合用例（bun 字段 + pnpm-workspace.yaml → pnpm）列入本 spec 测试清单（§7.2 #17）
- PRD §14 五要素映射：目标→§1；交付物→§4.1；接口定义→§4.2–4.5；测试清单→§7.1–7.2；验收标准→§7.4
- 计划期修订位：留给 writing-plans 自审（S3 先例：修订随 plan 评审一并确认）

## 1. 问题与目标

**问题**：S6/S7 的 link/unlink 需要崩溃安全的状态持久层——`.lpm/state.json` 记录 original range（防永久丢失，PRD §9 幂等规则）与 `.lpm/last.json`（支撑 `--last`）；S11 需要用户级 `~/.lpm/config.json`（scanDirs）；B6（PRD 附录 A）指出 `.lpm/` 不在 .gitignore 会污染团队仓库 → 需要 gitignore 防护（PRD §9 第 5 条）。S1 冻结了 8 个 stub 函数签名，S3 提前实现 config 两项 + 原子写 helper，S4 填充剩余 8 函数并闭环"深层 schema 校验归 S4"遗留项。

**目标**：

1. 8 个 stub 函数按 S1 §4.4 冻结签名实现：readState/writeState/deleteState/readLast/writeLast/readUserConfig/writeUserConfig/ensureGitignoreEntry
2. 全部写入复用 `writeJsonFileAtomic`（原子写 = 临时文件 + rename，PRD §9）；T1① 顺手强化 tmp 名
3. state/last/user 坏 JSON **可见报错**（新增 `LpmStateParseError`）——不静默重置，防 original 丢失（PRD §11 逃生门 + §9 防 original 永久丢失红线）
4. `writeState` 内建 gitignore 防护（自动调用 `ensureGitignoreEntry`，幂等）——B6 修复不依赖 S6 编排层记性
5. 深层 schema 最小校验（S3 spec 行 38/211"归 S4"项闭环）
6. 全程可测：unit 全覆盖（临时目录自建，S3 模式）；依赖零新增

**非目标**（S4 不做）：

- 命令层接线与"首次任何命令未设定则询问"引导（S6/S9）
- `linkedAt` 时间戳生成与 state 写入编排、崩溃安全写入顺序（link = 先落 state → 再改 package.json → install）——S6/S7 编排职责，S4 仅提供读写原语
- last.json 更新规则（PRD §10 表：集合级操作后更新——S10 编排）
- 非 lpm 链接检测、三态恢复、三方核对（S7/S8）
- package.json 文本级改写（S5）
- user config 的交互管理（dir/扫描目录编辑——S11）

## 2. 方案权衡（brainstorming 五问定版，2026-09-26）

| 决策点 | 定版 | 被否选项与理由 |
|---|---|---|
| 1. ensureGitignoreEntry 判定与写入 | **归一化匹配 + 直接写入**：读 `<rootDir>/.gitignore` 全部行，任一行经归一化（§4.4）后 === `.lpm` → `'present'`；否则追加一行 `.lpm/`（文件不存在则新建；末尾无换行先补换行）→ `'added'`。不检测 `.git` 目录 | 严格 `.git` 存在性检测：多余分支，创建 .gitignore 无害，函数保持纯文件层语义；git check-ignore 子进程实测：引入 git 可用性依赖 + 进程开销，跨平台环境差异大 |
| 2. state/last/user 坏 JSON 行为 | **新增 `LpmStateParseError`**（构造参数 filePath，message 含路径 + "可修复或直接删除该文件——lpm 状态可抛弃重建"，风格对称 `LpmConfigParseError`）；三读路径坏 JSON/非对象/字段校验失败均抛出 | 复用 `LpmConfigParseError`：类名与参数名 configPath 同"项目级 config"语义绑死，三文件共用语义混杂；宽容当 null/默认值：original 静默丢失 → unlink 无法恢复，直接违背 PRD §11 逃生门设计与 §9"防 original 永久丢失"红线 |
| 3. 深层 schema 校验严格度 | **必需顶层字段最小校验**：config.libs/state.links 应为对象、last.names/user.scanDirs 应为数组（缺失或类型错 → ParseError，文案含字段名）；version 缺失宽容（手工文件兼容）、存在且 ≠ 1 → 报"不支持的版本"；嵌套层（links 内 original/linkedAt）不校验；packageManager 越界维持 S3 宽容路径（resolvePackageManager 按"未设定"处理） | 仅非对象判定（S3 现状平移）："深层校验归 S4"落空，libs 缺失时 S6 消费处运行时炸难懂错误；完整递归校验（含 linkedAt ISO 格式、names 元素类型）：手工文件容错差，违背逃生门精神，过度工程 |
| 4. T1① tmp 同进程并发互撞 | **修**：tmp 名加随机段 `${filePath}.${process.pid}.${randomUUID()}.tmp`；S3 spec §4.6 契约文本回写 + 同进程并发写入测试 | 不修留痕（用户拍板顺手修否决）：写原语是全 CLI 共享底座，强化一次全链路受益，成本一次性；且 S6 批量编排若未来引入并发，互撞是数据损坏级风险 |
| 5. ensureGitignoreEntry 调用时机 | **writeState 内部自动调用**（幂等，二次起 `'present'` 无操作）；独立导出保留，S6 首次 link 可用返回值向用户提示".gitignore 已追加" | 完全分离由 S6 编排显式调用：S6 遗漏调用则 B6 落空——.lpm/ 入库污染团队仓库恰是 B6 关切；"首次创建 .lpm/ 时"的判定逻辑也会散落进编排层 |

## 3. 架构

```
src/state/index.ts    # 8 stub → 实现；LpmStateParseError（与 LpmConfigParseError 同文件，领域错误随使用模块落地）
src/state/atomic.ts   # tmp 名加随机段（T1①）；writeJsonFileAtomic 签名与其余语义不变
```

- 无新增源码模块；分层规则不变：`state/*` 不 import `core/*`（本层亦无 core 依赖），`commands/*` 是唯一编排层（S1 §3）
- S5–S11 均经由 `state/index.ts` 消费；PRD §9"所有 lpm 状态文件的写入均为原子写"由写入共通规约保证（§4.4）
- `tests/unit/state-stub.test.ts` 退役（8 stub 全部实现，not-implemented 断言失去意义）

## 4. 组件与接口

### 4.1 文件清单（交付物）

```
src/state/index.ts               # 8 stub → 实现 + LpmStateParseError
src/state/atomic.ts              # tmp 名加随机段（T1①）
tests/unit/state-files.test.ts   # 新增：state/last/user/gitignore 行为（§7.2）
tests/unit/config-io.test.ts     # 增：atomic 同进程并发写入用例（T1①）
tests/unit/pm.test.ts            # 增：T2① 级间穿透组合用例（1 个）
tests/unit/state-stub.test.ts    # 删除
docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md      # 回写（§4.6 义务①）
docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md  # 回写（§4.6 义务②）
```

`src/state/types.ts` 不动（S1 冻结类型：ProjectLpmConfig/LinkState/LastSet/UserLpmConfig）。

### 4.2 冻结签名（S1 §4.4 原文，S4 实现不得改动）

```ts
// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全，防双终端并发写坏）
export async function readState(rootDir: string): Promise<LinkState | null>
export async function writeState(rootDir: string, st: LinkState): Promise<void>
export async function deleteState(rootDir: string): Promise<void>   // links 清空即删文件（兼作 web 片段开关信号）
export async function readLast(rootDir: string): Promise<LastSet | null>
export async function writeLast(rootDir: string, last: LastSet): Promise<void>
export async function readUserConfig(): Promise<UserLpmConfig>      // 文件缺失 → { version: 1, scanDirs: [] }
export async function writeUserConfig(cfg: UserLpmConfig): Promise<void>

/** 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/，未覆盖则追加并告知（PRD §9.5） */
export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'>
```

### 4.3 新增导出

```ts
// src/state/index.ts —— 错误类（与 LpmConfigParseError 同文件同风格；name = 'LpmStateParseError'）
export class LpmStateParseError extends Error {
  constructor(public filePath: string, message: string)
}
```

公共 API 面合计：既有（readProjectConfig/writeProjectConfig/LpmConfigParseError/writeJsonFileAtomic + core/pm.ts 全部）+ 本 spec 新增（8 函数实现 + LpmStateParseError）。冻结签名零改动。

### 4.4 行为契约（逐条）

路径约定：

```
statePath = <rootDir>/.lpm/state.json
lastPath  = <rootDir>/.lpm/last.json
userPath  = join(os.homedir(), '.lpm', 'config.json')
```

**读取共通规约**（readState/readLast/readUserConfig；readProjectConfig 同款已存在）：

```
1. 文件缺失 → null（readUserConfig 例外：→ { version: 1, scanDirs: [] }，S1 冻结注释定版）
2. 读全文 + 剥行首 UTF-8 BOM（charCodeAt(0) === 0xfeff，规约同 S2 §4.2 / S3 §4.6）
3. JSON.parse 失败 → LpmStateParseError
   （message 含路径 + 原因 + 「可修复或直接删除该文件——lpm 状态可抛弃重建」）
4. 非对象（数组/原始值/null）→ LpmStateParseError（「应为 JSON 对象」+ 可抛弃重建尾巴）
5. 深层最小校验（§2 决策 3）——按文件：
   config（readProjectConfig 行为增强，S3 基础上扩展，签名不变）：
     libs 字段缺失或非对象（Array.isArray 视为非对象）→ 「libs 应为对象」
   state：links 字段缺失或非对象（Array.isArray 视为非对象）→ 「links 应为对象」
   last ：names 字段缺失或非数组 → 「names 应为数组」
   user ：scanDirs 字段缺失或非数组 → 「scanDirs 应为数组」
6. version：缺失 → 宽容通过（手工文件兼容）；存在且 !== 1 → 「不支持的版本 <v>（当前仅 version: 1）」
   （校验失败文案均含路径 + 可抛弃重建尾巴）
7. 错误类归属（F2，多透镜评审 2026-09-26）：config 域（readProjectConfig）校验失败 →
   LpmConfigParseError（S3 冻结语义延伸：解析错误 + 结构无效同域）；state/last/user → LpmStateParseError
   （packageManager 越界维持 S3 宽容路径，不属校验失败）
```

**写入共通规约**（writeState/writeLast/writeUserConfig）：

```
1. mkdirSync(目标目录, { recursive: true })——幂等（writeState 的 .lpm/、writeUserConfig 的 ~/.lpm）
2. writeJsonFileAtomic(目标路径, value)——序列化契约由 atomic 保证（2 空格缩进 + 尾随 \n + LF + 无 BOM）
3. fs 失败（EACCES/磁盘满等）保持 crash 语义、不入错误契约（S3 账本行 37 Ruling 承袭）
```

writeState 附加：写入前调用 `ensureGitignoreEntry(rootDir)`（幂等，返回值不向调用方传递——信息性提示由 S6 命令层独立调用获得）。
writeLast 不调用 ensureGitignoreEntry：last.json 仅在 state 存续后才可能被写（.lpm/ 必已存在）；mkdir 仍做（幂等零成本）。
writeUserConfig 不做 gitignore：~/.lpm 不在项目 git 仓库内（home 恰为 git 仓库属病态边缘，YAGNI）。

**deleteState(rootDir)**：

```
rmSync(statePath, { force: true })——文件缺失幂等成功
只删 state.json；不动 last.json、不删 .lpm/ 目录（PRD §9.2「links 清空即删文件」字面）
幂等性支撑 PRD §9 崩溃安全写入顺序：unlink = 先恢复文件 → install 成功 → 才删 state（失败重跑幂等）
```

**ensureGitignoreEntry(rootDir)**（返回 `'present' | 'added'`）：

```
1. gitignore = <rootDir>/.gitignore
2. 存在 → 读全文 + 剥行首 UTF-8 BOM（记事本等工具常产生 BOM；规约与 lpm 家族其余读路径一致，F4 采纳），
   逐行归一化判定：
   归一化 = trim → 循环剥前导 '/' 或前导 '**/'、剥尾随 '/' 或 '/*' 或 '/**' 至稳定 → 与 '.lpm' 全等比较
   任一行命中 → 'present'（文件零改动退出）
   命中示例（12 种）：.lpm、.lpm/、/.lpm、/.lpm/、.lpm/*、/.lpm/*、.lpm/**、/.lpm/**、**/.lpm、**/.lpm/、**/.lpm/*、**/.lpm/**
   不命中示例：.lpmx（不同名）、.foo/.lpm（仅忽略子路径，不覆盖根级——误判 present 会让 B6 防护失效）、
              !.lpm/（负模式 = 明确不忽略，不算覆盖）
3. 未命中 → 追加：
   文件不存在 → 写入 '.lpm/\n'（UTF-8 无 BOM）
   存在 → 读原文；末尾无 '\n' 先补 '\n'；追加 '.lpm/\n'；writeFileSync 直接写
   （.gitignore 是宿主项目文件而非 lpm 状态文件，不入 PRD §9 原子写承诺；追加写坏可由 git 恢复）
   → 'added'
```

### 4.5 atomic 修订契约（T1①）

```
tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`   # node:crypto randomUUID
```

- 同目录保证 rename 同盘（不变）；pid + uuid 组合同时防双终端并发互踩与同进程并发互撞
- 其余语义全部不变：JSON.stringify(value, null, 2) + '\n'；undefined → TypeError 不落盘；写入/rename 失败 → 清理孤儿 tmp 后原错误重抛；Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING）
- 并发契约：同进程并发（Promise.all）写同一目标 → 各自成功、无 tmp 残留、终值为其中一次的完整内容（不保证先写者胜——文件系统级 last-writer-wins）

### 4.6 回写义务（S1 §4.6 演进约定）

1. **S1 spec §4.4**：标题「state 读写 API（S4 填充；readProjectConfig/writeProjectConfig 已由 S3 提前实现…）」→ 改注 8 函数已由 S4 实现；`ensureGitignoreEntry` 行的 `// stub` 注释移除；§7 行为表中 state-stub.test.ts 行加退役注记（S4 删除该文件）
2. **S3 spec §4.6**（两条）：
   a. 原子写 helper 契约的 tmp 行「tmp = <filePath>.<pid>.tmp（同目录保证 rename 同盘；pid 后缀防双终端并发互踩——PRD §9 动机）」→ 按 §4.5 新契约更新（T1① 落痕）
   b. readProjectConfig 契约块的「最小类型判定，非深层 schema 校验——S4 深化」注记 → 改注「深层最小校验（libs/version）已由 S4 补（S4 spec §4.4 规约 5–7）」（F1 闭环落痕）

## 5. 数据流

```
S6 link   ：findWorkspaceRoot → readState（已有条目 → 幂等跳过，original 不重读）
           → writeState（自动 mkdir + gitignore 防护）→ 改 package.json（S5）→ install
S7 unlink ：恢复 range（S5）→ install 成功 → deleteState（幂等，失败重跑安全）
S8 status ：readState 只读（三方核对的第一方）
S10 集合  ：readLast / writeLast（更新规则编排在 S10，PRD §10 表）
S11 管理  ：readUserConfig / writeUserConfig（scanDirs）
```

## 6. 错误处理（逐条——PRD §11 每条含下一步动作）

| # | 场景 | 行为 | 文案关键片段 |
|---|---|---|---|
| 1 | config/state/last/user 坏 JSON | 解析错误（命令层接线归 S6+，与 S3 M2 先例同构）。错误类分域（§4.4 规约 7）：config → `LpmConfigParseError`；state/last/user → `LpmStateParseError` | 「<路径> 不是合法 JSON（<原因>）。可修复或直接删除该文件——lpm 状态可抛弃重建」 |
| 2 | config/state/last/user 非对象 | 同 #1 分域 | 「<路径> 不是合法的 lpm 状态/配置文件（应为 JSON 对象）。可修复或直接删除…」 |
| 3 | config.libs / state.links / last.names / user.scanDirs 缺失或类型错 | 同 #1 分域 | 「<路径> 的 <字段> 应为 <对象/数组>。可修复或直接删除…」 |
| 4 | version 存在且 ≠ 1（四文件同规约） | 同 #1 分域 | 「<路径> 版本 <v> 不受支持（当前仅 version: 1）。…」 |
| 5 | readUserConfig 文件缺失 | 返回默认 `{ version: 1, scanDirs: [] }`（非错误） | — |
| 6 | deleteState 文件缺失 | 幂等成功（非错误） | — |
| 7 | .gitignore 已覆盖 .lpm/ | 返回 'present'，零改动（非错误）；未覆盖 → 追加 → 'added'（提示归 S6 命令层） | — |
| 8 | 读写 fs 失败（EACCES/磁盘满/rename 占用/路径被占为它物如 EISDIR） | crash 语义，不入契约（S3 Ruling 承袭，S12 统一收敛） | — |

## 7. 测试与验收

### 7.1 分层

- unit：state/last/user 读写与 gitignore 行为（临时目录自建，S3 模式）；atomic 并发用例并入 config-io.test.ts；pm 穿透用例并入 pm.test.ts
- e2e：**无新增**——S4 为纯库层，无命令消费面（11 例回归不变）
- user config 隔离：`readUserConfig/writeUserConfig` 无 rootDir 参数（S1 冻结签名），测试经 `vi.mock('node:os')` 将 homedir 指向临时目录（importOriginal 保留 tmpdir 真实实现；S2 T2 mock 先例 + S3 confirm mock 先例同构）

### 7.2 unit 清单（每条 §4.4 契约至少一正一反）

state-files.test.ts：

1. readState：缺失 → null；roundtrip（写后读一致）
2. readState：坏 JSON → `LpmStateParseError`（断言 filePath + message 含「可抛弃重建」）；非对象（数组/原始值）→ 同
3. readState：links 缺失 / links 非对象（含数组）→ `LpmStateParseError`
4. readState：version 缺失宽容通过；version ≠ 1 → 报「不支持的版本」
5. readState：BOM 容忍（Buffer EF BB BF 前缀，config-io 用例 16 同款）
6. writeState：自动 mkdir（.lpm/ 不存在时创建）；原子写（无 *.tmp 残留）
7. writeState：首写触发 .gitignore 追加（未覆盖 → 内容含 .lpm/ 行）；次写幂等（不重复追加）
8. deleteState：删除成功；文件缺失幂等；last.json 不受影响
9. readLast：缺失 → null；roundtrip；names 缺失/非数组 → `LpmStateParseError`
10. writeLast：mkdir + 原子写；不调用 ensureGitignoreEntry（不追加 .gitignore，§4.4 差异点）
11. readUserConfig：缺失 → `{ version: 1, scanDirs: [] }`；roundtrip；scanDirs 缺失/非数组 → 报错；坏 JSON → 报错；version ≠ 1 → 报错
12. writeUserConfig：homedir 隔离下 mkdir ~/.lpm + 原子写
13. ensureGitignoreEntry：不存在 → 新建 `.lpm/\n` → 'added'；存在未覆盖 → 追加（末尾有/无换行两态）；已覆盖 → 12 种常见写法参数化命中 → 'present' 且内容不变；反例 .lpmx / .foo/.lpm / !.lpm/ → 未覆盖；带 BOM 的 .gitignore（首行 .lpm/）→ 'present' 且不重复追加（F4）

config-io.test.ts 增：

14. atomic 同进程并发（T1①）：Promise.all 两次写同目标 → 双成功、无 tmp 残留、终值为两次之一（§4.5 并发契约）
14b. readProjectConfig 深层校验（F1/F2，S3 遗留闭环）：libs 缺失/非对象 → `LpmConfigParseError`（「libs 应为对象」）；version 存在且 ≠ 1 → 同类报错；libs 齐全 + version 缺失 → 宽容通过

pm.test.ts 增：

15. T2① 穿透组合：package.json packageManager 'bun@1' + pnpm-workspace.yaml（无 lockfile）→ pnpm（evidence workspace-manifest——级间穿透：字段级未命中继续清单级）

### 7.3 e2e 清单

既有 11 例回归不变（含 use 真实行为 6 例 + 脚手架 5 例）；无新增。

### 7.4 验收标准

1. `pnpm verify` 全绿（typecheck + build + unit 含新增 + e2e 11），本机 Windows 通过
2. §4.4 契约逐条 ↔ state-files.test.ts + config-io.test.ts（14/14b）双向映射齐全（每条至少一正一反）
3. S1 §4.4 冻结签名逐字一致；公共 API 恰为既有面 + 8 函数实现 + LpmStateParseError
4. 依赖白名单不变：运行时依赖恰为 commander / @clack/prompts / execa（node:crypto/node:os 为内置，零新增）
5. S1/S3 spec 回写完成（§4.6 两条义务）
6. state-stub.test.ts 退役删除；unit 总数 = 91 − 1 + 新增（精确计数 plan 期核算，测试代码为权威——S3 先例）

## 8. 后续衔接

| 消费方 | 依赖的 S4 产出 |
|---|---|
| S5 改写引擎 | 无直接依赖（读 package.json 不经 state） |
| S6 link | readState 幂等判定 / writeState（内建 gitignore 防护）/ linkedAt 由 S6 生成（ISO 8601） |
| S7 unlink | deleteState 幂等（崩溃安全顺序：恢复 → install → 删 state）；消费提示：嵌套层不校验（§2 决策 3），S7 读 `entry.original` 前需自带防御（缺失走 repair/逃生门，多透镜评审 F7 候选） |
| S8 status/repair | readState 只读 |
| S10 集合 | readLast / writeLast |
| S11 登记 | readUserConfig / writeUserConfig |

本 spec 评审通过后：invoke **writing-plans** 出 S4 implementation plan → SDD 逐任务实施（同 S1–S3 流程）。

## 9. 待评审决策点

无开放决策——五个关键裁决已在 brainstorming 拍板（§2）。实现期自决细节（非决策，评审可否决）：deleteState 用 `rmSync({ force: true })`；.gitignore 追加用直接 `writeFileSync`（宿主项目文件不入原子写承诺）；user config 测试经 `vi.mock('node:os')` 隔离 homedir；readUserConfig 默认值常量就地定义（不导出）。

## 10. 评审 Backlog（多透镜评审 2026-09-26，两轮收敛）

六手法 + 场景 B 角色面板（架构师/资深开发/资深测试/交付运维）全过。发现 1 矛盾 + 1 复合盲点 + 8 优化；P0/P1 已全部修复（F1/F2 → §4.4 规约 5–7、§6 表、§7.2 14b、§4.6 义务 2b；F7 候选提示落 §8 S7 行），手法 3 复跑无新增。P2 显式处置如下：

**已采纳**：

| # | 问题 | 落点 |
|---|---|---|
| F3 | §6 #8"写入 fs 失败"未涵盖读失败（EISDIR 等） | §6 #8 扩为"读写 fs 失败" |
| F4 | .gitignore 带 BOM 时首行 .lpm 判定失效（lpm 家族读路径一致性） | §4.4 ensureGitignoreEntry 步骤 2 剥 BOM + §7.2 #13 用例 |

**已关闭**：

| # | 问题 | 理由 |
|---|---|---|
| F5 | 双终端同时首次 writeState → .gitignore 双行 | git 语义仍忽略 .lpm/、功能无害、概率极低，用户可自行清理 |
| F6 | writeState 运行时接受 version≠1 落盘 | TS `LinkState.version: 1` 字面类型编译期锁死；内部库非公共包 |
| F8 | CRLF .gitignore 追加 LF 行混合换行 | git 容忍混合换行；CRLF 探测与按文件换行风格写入属过度工程 |
| F9 | 进程崩溃时孤儿 tmp 永久残留（uuid 名不复用） | .lpm/ 不入库、读路径不消费 tmp、功能无害；非崩溃路径已由 S3 catch 清理覆盖 |

**候选**：

| # | 问题 | 触发信号 |
|---|---|---|
| F7 | readState 嵌套不校验 → S7 消费 `entry.original` 前需防御 | S7 spec 编写期确认消费点防御方案（已在 §8 衔接表预留提示） |
| F10 | vi.mock('node:os') 拦截 ESM 命名导入在 vitest 5 待实证 | plan 期红灯验证；若 mock 失效改用 USERPROFILE 环境注入（S2 T2 先例同构） |
