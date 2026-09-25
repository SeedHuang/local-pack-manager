# S1 CLI 脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 lpm 可运行 CLI 骨架：`lpm --version` 可跑、PRD §7 全部 11 个命令以 stub 注册、workspace/改写引擎/状态层模块骨架与数据契约就位、typecheck/unit/e2e 三层验证基建一条 `pnpm verify` 全绿。

**Architecture:** 单入口 commander program（`buildProgram()` / `run()` 分离 + `import.meta.url` 执行守卫，保证可 import 单测）；业务分两层——`core/*`（workspace 解析 / PM 检测 / 改写引擎，S1 全为 stub）与 `state/*`（四文件数据契约 + 读写 stub）；运行时依赖 external，tsup 产出单入口 `dist/cli.js`。

**Tech Stack:** TypeScript（ESM，Node ≥ 18）+ commander + @clack/prompts + execa + tsup + vitest

**Spec:** docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md（plan 从 spec 出发，执行者须同时读 spec；接口注释与数据契约以 spec §4 为准）

## Global Constraints

- Node ≥ 18；`"type": "module"`（纯 ESM）；本机 Windows + pnpm 验证
- 运行时依赖**仅** commander / @clack/prompts / execa；devDependencies **仅** typescript / tsup / vitest / @types/node
- 版本唯一事实源 = `package.json.version`，经 tsup / vitest `define` 注入 `__LPM_VERSION__`，双路径不得漂移
- 命令全集 11 个（顺序固定）：`use, link, unlink, status, repair, save, preset, forget, dir, init, uninit`
- 退出码契约：0 = help / version / stub 命令；1 = 未知命令（commander 默认）
- 文案全中文；stub 提示格式固定：`lpm <命令> 尚未实现（计划 <spec>）。当前可用：lpm --help`（写入 stderr，不设退出码）
- 不注册 `--dry-run` 占位
- **Git：本 plan 不含任何 commit 步骤**（用户全局 Git 规则：不主动执行 git 写操作，由用户自行提交）
- lpm 自身不发布；bin 名固定 `lpm`

---

### Task 1: 工程底座与版本同源

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tsup.config.ts`
- Create: `.gitignore`
- Create: `src/env.d.ts`
- Create: `src/version.ts`
- Test: `tests/unit/version.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `LPM_VERSION: string`（src/version.ts 导出，后续 cli.ts 与测试消费）；scripts：`build / dev / typecheck / test / test:e2e / verify`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "lpm",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=18" },
  "bin": { "lpm": "dist/cli.js" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run tests/unit",
    "test:e2e": "vitest run tests/e2e",
    "verify": "pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json / vitest.config.ts / tsup.config.ts / .gitignore**

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "noEmit": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests", "*.config.ts"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

export default defineConfig({
  // 与 tsup 同源：版本唯一事实源 = package.json
  define: { __LPM_VERSION__: JSON.stringify(pkg.version) },
  test: { environment: 'node' },
})
```

`tsup.config.ts`：

```ts
import { defineConfig } from 'tsup'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const pkg = nodeRequire('./package.json') as { version: string }

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  // Windows 全局安装由 npm/pnpm 生成 cmd shim（内部调 node），shebang 按惯例保留
  banner: { js: '#!/usr/bin/env node' },
  define: { __LPM_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  clean: true,
  // commander/@clack/prompts/execa 属 dependencies，tsup 自动 external，不打进产物
})
```

`.gitignore`：

```
node_modules/
dist/
```

- [ ] **Step 3: 安装依赖**

Run: `pnpm add commander @clack/prompts execa`
Run: `pnpm add -D typescript tsup vitest @types/node`
Expected: 两条命令成功；package.json 出现 `dependencies`（恰为 3 件）与 `devDependencies`（恰为 4 件），`node_modules/` 就绪

- [ ] **Step 4: 写失败测试 tests/unit/version.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LPM_VERSION } from '../../src/version'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

describe('版本同源', () => {
  it('LPM_VERSION === package.json.version 且为 semver', () => {
    expect(LPM_VERSION).toBe(pkg.version)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
```

- [ ] **Step 5: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——无法解析 `../../src/version`（模块不存在）

- [ ] **Step 6: 写最小实现**

`src/env.d.ts`：

```ts
declare const __LPM_VERSION__: string
```

`src/version.ts`：

```ts
export const LPM_VERSION = __LPM_VERSION__
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS（1 个用例）
Run: `pnpm typecheck`
Expected: 无输出（0 错误）

---

### Task 2: 命令注册表

**Files:**
- Create: `src/commands/registry.ts`
- Test: `tests/unit/registry.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `interface CommandMeta { name: string; summary: string; plannedSpec: string }`、`COMMANDS: CommandMeta[]`（11 项，顺序 = Global Constraints 固定顺序；Task 3 的 cli.ts / stub.ts 消费）

- [ ] **Step 1: 写失败测试 tests/unit/registry.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../../src/commands/registry'

const EXPECTED = [
  'use', 'link', 'unlink', 'status', 'repair',
  'save', 'preset', 'forget', 'dir', 'init', 'uninit',
]

describe('命令注册表', () => {
  it('覆盖 PRD §7 全集 11 个，无重复，顺序固定', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(EXPECTED)
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(11)
  })

  it('每项含中文 summary 与 plannedSpec', () => {
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.plannedSpec).toMatch(/^S\d+/)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——无法解析 `../../src/commands/registry`

- [ ] **Step 3: 写实现 src/commands/registry.ts**

```ts
export interface CommandMeta {
  name: string
  summary: string        // help 一句话中文描述
  plannedSpec: string    // stub 提示用
}

export const COMMANDS: CommandMeta[] = [
  { name: 'use',     summary: '设定或自动推断包管理器',     plannedSpec: 'S3' },
  { name: 'link',    summary: '把依赖切到本地目录联调',     plannedSpec: 'S6' },
  { name: 'unlink',  summary: '恢复 registry 版本',        plannedSpec: 'S7' },
  { name: 'status',  summary: '三方核对链接状态',           plannedSpec: 'S8' },
  { name: 'repair',  summary: '修复漂移与孤儿状态',         plannedSpec: 'S8' },
  { name: 'save',    summary: '当前链接集存为预设',         plannedSpec: 'S10' },
  { name: 'preset',  summary: '预设管理',                  plannedSpec: 'S10' },
  { name: 'forget',  summary: '移除 lib 注册',              plannedSpec: 'S11' },
  { name: 'dir',     summary: '用户级扫描目录管理',         plannedSpec: 'S11' },
  { name: 'init',    summary: '注入 web 自感知配置片段',     plannedSpec: 'S13' },
  { name: 'uninit',  summary: '摘除 web 自感知配置片段',     plannedSpec: 'S13' },
]
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS（3 个用例：版本 1 + 注册表 2）
Run: `pnpm typecheck`
Expected: 无输出

---

### Task 3: 命令层组装（stub + cli 入口）

**Files:**
- Create: `src/commands/stub.ts`
- Create: `src/cli.ts`
- Test: `tests/unit/stub.test.ts`
- Test: `tests/unit/program.test.ts`

**Interfaces:**
- Consumes: `COMMANDS` / `CommandMeta`（Task 2）、`LPM_VERSION`（Task 1）
- Produces: `notImplemented(meta: CommandMeta): void`（stderr 提示，不设退出码）；`buildProgram(): Command`；`run(argv: string[]): Promise<number>`——Task 5 的 e2e 与后续 S2+ 消费

- [ ] **Step 1: 写失败测试 tests/unit/stub.test.ts**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMANDS } from '../../src/commands/registry'
import { notImplemented } from '../../src/commands/stub'

describe('stub 行为', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.exitCode
  })

  it('任取 2 个命令：stderr 含"尚未实现"与 plannedSpec，且不设非零退出码', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const samples = [COMMANDS[0], COMMANDS[3]] // use + status

    for (const meta of samples) {
      stderr.mockClear()
      notImplemented(meta)
      const out = stderr.mock.calls.map((c) => String(c[0])).join('')
      expect(out).toContain(`lpm ${meta.name} 尚未实现`)
      expect(out).toContain(meta.plannedSpec)
      expect(out).toContain('lpm --help')
    }
    expect(process.exitCode ?? 0).toBe(0)
  })
})
```

- [ ] **Step 2: 写失败测试 tests/unit/program.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli'
import { COMMANDS } from '../../src/commands/registry'

describe('program 组装', () => {
  it('注册命令名单与 COMMANDS 一致', () => {
    const program = buildProgram()
    expect(program.commands.map((c) => c.name())).toEqual(COMMANDS.map((c) => c.name))
  })

  it('含 --version 选项', () => {
    const longs = buildProgram().options.map((o) => o.long)
    expect(longs).toContain('--version')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——无法解析 `../../src/commands/stub` 与 `../../src/cli`

- [ ] **Step 4: 写实现 src/commands/stub.ts**

```ts
import type { CommandMeta } from './registry'

export function notImplemented(meta: CommandMeta): void {
  // 只提示，不设退出码（spec §6：stub 统一退出码 0）
  process.stderr.write(`lpm ${meta.name} 尚未实现（计划 ${meta.plannedSpec}）。当前可用：lpm --help\n`)
}
```

- [ ] **Step 5: 写实现 src/cli.ts**

```ts
import { Command } from 'commander'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COMMANDS } from './commands/registry'
import { notImplemented } from './commands/stub'
import { LPM_VERSION } from './version'

export function buildProgram(): Command {
  const program = new Command()
  program.name('lpm').description('npm 本地 link 联调 CLI').version(LPM_VERSION)

  for (const meta of COMMANDS) {
    program
      .command(meta.name)
      .description(`${meta.summary}（计划 ${meta.plannedSpec}）`)
      .action(() => notImplemented(meta))
  }
  return program
}

export async function run(argv: string[]): Promise<number> {
  const program = buildProgram()

  // spec §4.5 行为契约：无参数 → stdout help，退出码 0
  //（commander 对"有子命令但未给子命令"的默认行为是 stderr + exit 1，必须显式接管）
  if (argv.length === 0) {
    program.outputHelp()
    return 0
  }

  await program.parseAsync(argv, { from: 'user' })
  return process.exitCode ?? 0
}

// 直接执行时才 run()，被 import（测试）时不执行；
// 两侧 realpath 归一，防 Windows 路径大小写差异
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2))
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS（6 个用例：版本 1 + 注册表 2 + stub 1 + program 2）
Run: `pnpm typecheck`
Expected: 无输出

---

### Task 4: core 与 state 模块骨架（数据契约 + stub）

**Files:**
- Create: `src/core/pm.ts`
- Create: `src/core/workspace.ts`
- Create: `src/core/rewriter.ts`
- Create: `src/state/types.ts`
- Create: `src/state/index.ts`
- Test: `tests/unit/state-stub.test.ts`

**Interfaces:**
- Consumes: 无运行时依赖（跨文件仅 type-only：types.ts 引 PackageManagerId，rewriter.ts 引 PackageManagerId）
- Produces（全部为 stub，签名冻结，S2–S5 填充）：`PackageManagerId`、`detectPackageManager(rootDir)`；`PackageJsonInfo`、`Workspace`、`findWorkspaceRoot(startDir)`、`loadWorkspace(rootDir)`、`DepHit`、`findDependents(ws, pkgName)`；`Protocol`、`mapProtocol(pm, libDirAbs, manifestDirAbs)`、`RewriteResult`、`rewriteDepValue(manifestSource, pkgName, targetValue)`、`restoreDepValue(manifestSource, pkgName, originalRange)`；`ProjectLpmConfig` / `LinkState` / `LastSet` / `UserLpmConfig`；10 个 state 读写函数
- 所有 stub 函数体统一为 `throw new Error('not implemented: <函数名>（计划 S<x>）')`

- [ ] **Step 1: 写失败测试 tests/unit/state-stub.test.ts**

```ts
import { describe, expect, it } from 'vitest'
import { readProjectConfig, readState } from '../../src/state'

describe('state stub', () => {
  it('readState / readProjectConfig reject 且符合 not-implemented 约定', async () => {
    await expect(readState('C:/nowhere')).rejects.toThrow(
      /^not implemented: readState（计划 S4）$/,
    )
    await expect(readProjectConfig('C:/nowhere')).rejects.toThrow(
      /^not implemented: readProjectConfig（计划 S4）$/,
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test`
Expected: FAIL——无法解析 `../../src/state`

- [ ] **Step 3: 写 src/state/types.ts**

```ts
import type { PackageManagerId } from '../core/pm'

/** 项目级 lpm.config.json（进 git）—— PRD §9.1 */
export interface ProjectLpmConfig {
  version: 1
  packageManager?: PackageManagerId        // lpm use 显式设定后写入；未设定缺省
  libs: Record<string, string>             // lib 名 → 相对 workspace 根路径（正斜杠）
  presets?: Record<string, string[]>       // 预设名 → lib 名列表
}

/** 项目级 .lpm/state.json（gitignore）—— PRD §9.2 */
export interface LinkState {
  version: 1
  links: Record<string, {
    original: Record<string, string>       // "<相对根>/package.json" → 原 range
    linkedAt: string                       // ISO 8601
  }>
}

/** 项目级 .lpm/last.json（gitignore）—— PRD §9.3 */
export interface LastSet { version: 1; names: string[] }

/** 用户级 ~/.lpm/config.json —— PRD §9.4 */
export interface UserLpmConfig { version: 1; scanDirs: string[] }   // 绝对路径
```

- [ ] **Step 4: 写 src/state/index.ts**

```ts
import type { LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types'

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——S4 实现，S1 全为 stub
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  throw new Error('not implemented: readProjectConfig（计划 S4）')
}

export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  throw new Error('not implemented: writeProjectConfig（计划 S4）')
}

export async function readState(rootDir: string): Promise<LinkState | null> {
  throw new Error('not implemented: readState（计划 S4）')
}

export async function writeState(rootDir: string, st: LinkState): Promise<void> {
  throw new Error('not implemented: writeState（计划 S4）')
}

export async function deleteState(rootDir: string): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）
  throw new Error('not implemented: deleteState（计划 S4）')
}

export async function readLast(rootDir: string): Promise<LastSet | null> {
  throw new Error('not implemented: readLast（计划 S4）')
}

export async function writeLast(rootDir: string, last: LastSet): Promise<void> {
  throw new Error('not implemented: writeLast（计划 S4）')
}

export async function readUserConfig(): Promise<UserLpmConfig> {
  // 文件缺失 → { version: 1, scanDirs: [] }
  throw new Error('not implemented: readUserConfig（计划 S4）')
}

export async function writeUserConfig(cfg: UserLpmConfig): Promise<void> {
  throw new Error('not implemented: writeUserConfig（计划 S4）')
}

export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'> {
  // 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/（PRD §9.5）
  throw new Error('not implemented: ensureGitignoreEntry（计划 S4）')
}
```

- [ ] **Step 5: 写 src/core/pm.ts**

```ts
export type PackageManagerId = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry'

// 推断优先级（lockfile > packageManager 字段 > workspace 清单）与 berry/classic 判定见 PRD §7，S3 实现
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId> {
  throw new Error('not implemented: detectPackageManager（计划 S3）')
}
```

- [ ] **Step 6: 写 src/core/workspace.ts**

```ts
export interface PackageJsonInfo {
  dir: string            // 包目录绝对路径
  manifestPath: string   // package.json 绝对路径
  name: string           // 包 name（缺失时为空串）
  isRoot: boolean
}

export interface Workspace {
  rootDir: string
  manifestFormat: 'pnpm-workspace' | 'package-json' | 'single'   // single = 非 monorepo
  members: PackageJsonInfo[]                                     // 含根自身
}

/** 从 startDir 向上探测：
 *  遇 pnpm-workspace.yaml 或含 workspaces 字段的 package.json → 即 workspace 根；
 *  否则第一个含 package.json 的目录即根（单包项目）；
 *  至盘根未命中 → 抛 WorkspaceNotFound（提示"请在项目目录内运行"） */
export async function findWorkspaceRoot(startDir: string): Promise<string> {
  throw new Error('not implemented: findWorkspaceRoot（计划 S2）')
}

/** 清单解析 + glob 展开成员（含排除），PRD §14-S2 */
export async function loadWorkspace(rootDir: string): Promise<Workspace> {
  throw new Error('not implemented: loadWorkspace（计划 S2）')
}

export interface DepHit {
  manifestPath: string
  section: 'dependencies' | 'devDependencies' | 'optionalDependencies'
  currentValue: string    // 当前 range 字面值
}

/** 扫描全部成员（含根）三类依赖位，返回声明了 pkgName 的命中；
 *  peerDependencies 不进命中（仅警告，S5/S6 处理） */
export async function findDependents(ws: Workspace, pkgName: string): Promise<DepHit[]> {
  throw new Error('not implemented: findDependents（计划 S2）')
}
```

- [ ] **Step 7: 写 src/core/rewriter.ts**

```ts
import type { PackageManagerId } from './pm'

export type Protocol = 'link' | 'portal' | 'file'

/** PRD §5 协议映射：pnpm | yarn-classic → link:，yarn-berry → portal:，npm → file:；
 *  返回完整依赖值（协议前缀 + 相对路径），相对路径基于 manifest 所在目录换算，
 *  正斜杠，永不输出绝对路径 */
export function mapProtocol(pm: PackageManagerId, libDirAbs: string, manifestDirAbs: string): string {
  throw new Error('not implemented: mapProtocol（计划 S5）')
}

export interface RewriteResult {
  content: string          // 改写后全文
  changedKeys: string[]    // "段名.包名"
  unchangedKeys: string[]  // 值已等于目标（幂等命中）
}

/** 文本级替换（PRD §9）：保持缩进 / key 顺序 / 尾随换行 / CRLF-LF / BOM；
 *  仅动命中行的 value；命中段：dependencies / devDependencies / optionalDependencies */
export function rewriteDepValue(manifestSource: string, pkgName: string, targetValue: string): RewriteResult {
  throw new Error('not implemented: rewriteDepValue（计划 S5）')
}

/** unlink 恢复原 range，格式保持语义同上 */
export function restoreDepValue(manifestSource: string, pkgName: string, originalRange: string): RewriteResult {
  throw new Error('not implemented: restoreDepValue（计划 S5）')
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS（7 个用例）
Run: `pnpm typecheck`
Expected: 无输出（跨文件类型互引全部通过）

---

### Task 5: 构建产物与 e2e 冒烟（收口）

**Files:**
- Create: `tests/e2e/helpers.ts`
- Create: `tests/e2e/cli.e2e.test.ts`
- Build output: `dist/cli.js`（不手工创建，由 `pnpm build` 生成）

**Interfaces:**
- Consumes: `dist/cli.js`（tsup 产物，Task 1-4 全部源文件）
- Produces: e2e harness `runCli(args: string[], cwd?: string)`（后续 S2+ 的 e2e 复用）；`pnpm verify` 全绿 = spec §7.4 验收 1

- [ ] **Step 1: 写失败测试 tests/e2e/helpers.ts**

```ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

const distCli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runCli(args: string[], cwd?: string): Promise<CliResult> {
  // 前置 pnpm build；dist 缺失必须显式报错，不允许静默跳过（spec §7.1）
  if (!existsSync(distCli)) {
    throw new Error('dist/cli.js 不存在，请先运行 pnpm build')
  }
  const r = await execa('node', [distCli, ...args], { cwd, reject: false })
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
}
```

- [ ] **Step 2: 写失败测试 tests/e2e/cli.e2e.test.ts**

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { runCli } from './helpers'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

const COMMAND_NAMES = [
  'use', 'link', 'unlink', 'status', 'repair',
  'save', 'preset', 'forget', 'dir', 'init', 'uninit',
]

// 工作目录用临时目录（spec §7.3）；S1 stub 不读工作区，任意存在目录皆可
const cwd = os.tmpdir()

describe('lpm CLI e2e', () => {
  it('--version：exit 0，stdout 为纯 semver 且与 package.json 一致', async () => {
    const r = await runCli(['--version'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(pkg.version)
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('--help：exit 0，列出全部 11 个命令', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.exitCode).toBe(0)
    for (const name of COMMAND_NAMES) {
      expect(r.stdout).toContain(name)
    }
  })

  it('无参数：exit 0，stdout 含 help/Usage', async () => {
    const r = await runCli([], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage/i)
  })

  it('lpm status（stub）：exit 0，stderr 含尚未实现与 S8', async () => {
    const r = await runCli(['status'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('尚未实现')
    expect(r.stderr).toContain('S8')
  })

  it('lpm lnik（未知命令）：exit ≠ 0，stderr 非空', async () => {
    const r = await runCli(['lnik'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 运行 e2e 确认失败**

Run: `pnpm test:e2e`
Expected: FAIL——`dist/cli.js 不存在，请先运行 pnpm build`

- [ ] **Step 4: 构建**

Run: `pnpm build`
Expected: tsup 成功，生成 `dist/cli.js`（首行 `#!/usr/bin/env node`）与 sourcemap

- [ ] **Step 5: 运行 e2e 确认通过**

Run: `pnpm test:e2e`
Expected: PASS（5 个用例）

> 备注：若 `--version` 断言失败（commander 输出带程序名前缀或退出码非 0，与 spec"纯 semver / exit 0"契约不符），不放宽断言——改为在 `buildProgram` 中用显式 handler 输出 `LPM_VERSION` 并返回 0，重跑本步直至通过，并在完成报告中记录该偏差。

- [ ] **Step 6: 全量收口**

Run: `pnpm verify`
Expected: typecheck → build → unit(7) → e2e(5) 全绿，一条命令通过（spec §7.4 验收 1/2/3 达成）

---

## Self-Review 记录

1. **Spec 覆盖**：§4.1 文件清单 15 项 → Task 1（5 项配置 + version/env.d.ts）、Task 2（registry）、Task 3（stub/cli）、Task 4（core×3 + state×2）、Task 5（tests/e2e）；§7.2 五个 unit 文件 → Task 1-4；§7.3 五个 e2e 用例 → Task 5；§7.4 验收 1/2/3 → Task 5 Step 6，验收 4/5 由 Task 1（依赖约束）+ 评审把关。无缺口
2. **占位符扫描**：所有代码步骤均含完整代码；`<安装时最新稳定版>` 由 `pnpm add` 动态解决（Global Constraints 约束依赖名单）——非占位
3. **类型一致性**：`CommandMeta`（Task 2 定义 → Task 3 消费）、`LPM_VERSION`（Task 1 → Task 3）、`PackageManagerId`（Task 4 内部互引）、`runCli`/`CliResult`（Task 5 内部）签名一致；stub 抛错文案与 state-stub.test.ts 正则一致
