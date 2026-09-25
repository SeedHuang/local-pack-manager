# S3 · PM 检测与 use — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 填充 S1 冻结的 PM 检测 stub（三级推断 + yarn 细分 + 歧义报错），交付 `lpm use` 命令（显式设定 + B2 冲突确认）与 `resolvePackageManager`（S6 唯一 PM 入口），并提前实现 config 读写两项（S4 范围缩减）。

**Architecture:** `core/pm.ts` 为纯检测逻辑（不依赖 state，config 设定值参数注入）；`commands/use.ts` 为唯一编排层（root 定位、冲突判定、clack confirm、输出、落盘决策）；`state/atomic.ts` 原子写 helper（S4 复用）。cli.ts 在 registry 循环内特判 use 接线，命令名单与顺序不变。

**Tech Stack:** TypeScript（NodeNext ESM，Node ≥ 22.12）+ commander 15 + @clack/prompts + vitest 5 + tsup；运行时依赖零新增。

**Spec:** docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md（含 2026-09-25 计划期修订 ①②③，plan 与 spec 同步定稿）

## Global Constraints

- **无任何 git 写操作 / 无 commit 步骤**——用户全局规则，全部改动由用户自行 commit；无 worktree / 无分支
- 相对导入一律带 `.js` 扩展名（NodeNext，TS2835）；目录模块写 `<dir>/index.js`
- Node ≥ 22.12；运行时依赖恰为 commander / @clack/prompts / execa，**零新增**
- 环境为 Windows + PowerShell（终端无 bash；测试内文件操作一律用 node:fs，不用 shell）
- vitest 5 裁决（承袭 S2）：node:fs ESM 命名空间不可 `vi.spyOn`——本 plan 不 mock node:fs，一律临时目录真读真写；Write 类工具会剥 BOM，BOM fixture 一律运行时以 Buffer 拼接写入
- 冻结签名不得改动：S1 §4.3（`PackageManagerId` / `detectPackageManager`）、S1 §4.4（`readProjectConfig` / `writeProjectConfig`）；S3 公共 API 新增仅 S3 spec §4.3 所列
- 错误文案为契约（spec §6 表），测试断言文案关键片段，不得即兴改写
- 每任务收口：`npx tsc --noEmit --pretty 2>&1 | grep "<本任务目录>"` 零错误（本项目当前 tsc 基线 0 错误，任何报错都须修复）；最终全量 `pnpm verify` 四段全绿（typecheck + build + unit + e2e）
- 测试运行命令：单文件 `pnpm vitest run tests/unit/<file>.test.ts`；全套 `pnpm test` / `pnpm test:e2e`

---

### Task 1: config 读写与原子写（S4 两项提前实现）

**Files:**
- Create: `src/state/atomic.ts`
- Modify: `src/state/index.ts`（整文件重写：readProjectConfig/writeProjectConfig 转实现，其余 8 个 stub **逐字保留**）
- Test: `tests/unit/config-io.test.ts`（新建）
- Test: `tests/unit/state-stub.test.ts`（更新：readProjectConfig 移出 stub 断言）

**Interfaces:**
- Consumes: S1 §4.4 冻结签名 `readProjectConfig(rootDir): Promise<ProjectLpmConfig | null>`、`writeProjectConfig(rootDir, cfg): Promise<void>`；`src/state/types.ts` 的 `ProjectLpmConfig`
- Produces: `LpmConfigParseError`（configPath 属性 + message 含"可抛弃重建"）；`writeJsonFileAtomic(filePath: string, value: unknown): void`（S4 复用）；readProjectConfig/writeProjectConfig 真实现（Task 3 消费）

- [ ] **Step 1: 写失败测试 tests/unit/config-io.test.ts**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LpmConfigParseError, readProjectConfig, writeProjectConfig } from '../../src/state/index.js'
import { writeJsonFileAtomic } from '../../src/state/atomic.js'
import type { ProjectLpmConfig } from '../../src/state/types.js'

const dirs: string[] = []
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-cfg-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('readProjectConfig / writeProjectConfig（S1 §4.4 冻结签名）', () => {
  it('用例 14a：roundtrip——写后读一致', async () => {
    const dir = makeProject()
    const cfg: ProjectLpmConfig = { version: 1, packageManager: 'pnpm', libs: { x: '../x' } }
    await writeProjectConfig(dir, cfg)
    expect(await readProjectConfig(dir)).toEqual(cfg)
  })

  it('用例 14b：文件缺失 → null', async () => {
    expect(await readProjectConfig(makeProject())).toBeNull()
  })

  it('用例 14c：坏 JSON → LpmConfigParseError（路径 + 可抛弃重建，§6.5）', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{oops', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as LpmConfigParseError).configPath).toBe(join(dir, 'lpm.config.json'))
    expect((err as Error).message).toContain('不是合法 JSON')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 16：读容忍 BOM（运行时 Buffer 写入 EF BB BF）', async () => {
    const dir = makeProject()
    const body = JSON.stringify({ version: 1, libs: {} })
    writeFileSync(
      join(dir, 'lpm.config.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    )
    expect(await readProjectConfig(dir)).toEqual({ version: 1, libs: {} })
  })
})

describe('writeJsonFileAtomic（原子写 helper，S4 复用）', () => {
  it('用例 15a：写后无 *.tmp 残留，目标可读', () => {
    const dir = makeProject()
    writeJsonFileAtomic(join(dir, 'a.json'), { a: 1 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(join(dir, 'a.json'), 'utf8'))).toEqual({ a: 1 })
  })

  it('用例 15b：目标已存在 → 覆盖成功且无残留', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    writeJsonFileAtomic(p, { a: 1 })
    writeJsonFileAtomic(p, { a: 2 })
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 2 })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 15c：格式——2 空格缩进 + 尾随换行 + 无 BOM', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    writeJsonFileAtomic(p, { a: 1 })
    const raw = readFileSync(p, 'utf8')
    expect(raw).toBe('{\n  "a": 1\n}\n')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)
  })
})
```

- [ ] **Step 2: 运行验证红灯**

Run: `pnpm vitest run tests/unit/config-io.test.ts`
Expected: FAIL——首轮因 `../../src/state/atomic.js` 尚未创建（Step 4 才建）表现为模块解析失败，属预期中间态；Step 4 建成 atomic.ts 后、Step 5 重写 index.ts 前，重跑本步应见 readProjectConfig/writeProjectConfig 相关用例因 stub 抛 `not implemented: readProjectConfig（计划 S4）` / `not implemented: writeProjectConfig（计划 S4）` 失败（TDD 行为级红灯，14a/14b/14c/16 四例）

- [ ] **Step 3: 更新 tests/unit/state-stub.test.ts**（readProjectConfig 已转实现，移出 stub 断言；readState 等其余保留）

```ts
import { describe, expect, it } from 'vitest'
import { readState } from '../../src/state/index.js'

describe('state stub', () => {
  it('readState reject 且符合 not-implemented 约定（readProjectConfig/writeProjectConfig 已由 S3 提前实现）', async () => {
    await expect(readState('C:/nowhere')).rejects.toThrow(/^not implemented: readState（计划 S4）$/)
  })
})
```

- [ ] **Step 4: 实现 src/state/atomic.ts（新建）**

```ts
import { renameSync, writeFileSync } from 'node:fs'

/** 原子写 JSON（PRD §9 崩溃安全：临时文件 + rename 覆盖；S3 spec §4.6，S4 的 state/last/user 写入复用）。
 *  序列化契约：JSON.stringify(value, null, 2) + 尾随换行；LF；无 BOM。
 *  tmp 名含 pid 后缀——防双终端并发写同一目标时互踩临时文件。 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, filePath) // Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING 语义）
}
```

- [ ] **Step 5: 重写 src/state/index.ts（整文件；readProjectConfig/writeProjectConfig 转实现，其余 8 个 stub 逐字保留不动）**

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types.js'
import { writeJsonFileAtomic } from './atomic.js'

/** lpm.config.json 不是合法 JSON（S3 引入；深层 schema 校验由 S4 深化） */
export class LpmConfigParseError extends Error {
  constructor(public configPath: string, message: string) {
    super(message)
    this.name = 'LpmConfigParseError'
  }
}

function configPathOf(rootDir: string): string {
  return join(rootDir, 'lpm.config.json')
}

/** S3 提前实现（S3 spec §4.6）：缺失 → null；坏 JSON → LpmConfigParseError；不做深层 schema 校验（S4 深化） */
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  const p = configPathOf(rootDir)
  if (!existsSync(p)) return null
  const source = readFileSync(p, 'utf8')
  // 剥行首 UTF-8 BOM（规约同 S2 spec §4.2）
  const stripped = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  try {
    return JSON.parse(stripped) as ProjectLpmConfig
  } catch (err) {
    throw new LpmConfigParseError(
      p,
      `${p} 不是合法 JSON（${(err as Error).message}）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
}

/** S3 提前实现（S3 spec §4.6）：原子写（PRD §9） */
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  writeJsonFileAtomic(configPathOf(rootDir), cfg)
}

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——以下为 S4 范围 stub
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

- [ ] **Step 6: 运行验证绿灯**

Run: `pnpm vitest run tests/unit/config-io.test.ts tests/unit/state-stub.test.ts`
Expected: PASS（config-io 7 用例 + state-stub 1 用例）

- [ ] **Step 7: 定向 typecheck**

Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/state\|tests/unit/config-io"`
Expected: 无输出（零错误）

---

### Task 2: PM 检测核心（core/pm.ts 填充）

**Files:**
- Modify: `src/core/pm.ts`（整文件重写：stub → 实现）
- Test: `tests/unit/pm.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯 fs + 类型）；`PackageManagerId` 为 S1 §4.3 冻结类型（保留原定义位置与字面）
- Produces: `detectPackageManager`（冻结签名，单行包装）；`detectPackageManagerDetailed(rootDir): Promise<DetectResult>`；`resolvePackageManager(rootDir, configPM): Promise<PMResolution>`；`subdivideYarn(rootDir): 'yarn-classic' | 'yarn-berry'`；`PMAmbiguousError(found, message)` / `PMUnresolvedError(message)`；类型 `PMEvidence` / `DetectResult` / `PMResolution`（Task 3 消费）

- [ ] **Step 1: 写失败测试 tests/unit/pm.test.ts**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  detectPackageManager,
  detectPackageManagerDetailed,
  PMAmbiguousError,
  PMUnresolvedError,
  resolvePackageManager,
  type PackageManagerId,
} from '../../src/core/pm.js'

const dirs: string[] = []
function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-pm-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('detectPackageManagerDetailed：lockfile 级（§4.4 级 1）', () => {
  it('用例 1：单 pnpm-lock.yaml → pnpm（evidence lockfile）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await detectPackageManagerDetailed(dir)
    expect(r.pm).toBe('pnpm')
    expect(r.evidence).toEqual({ kind: 'lockfile', file: 'pnpm-lock.yaml' })
  })

  it('用例 1b：单 package-lock.json → npm', async () => {
    const dir = makeProject({ 'package-lock.json': '' })
    const r = await detectPackageManagerDetailed(dir)
    expect(r.pm).toBe('npm')
    expect(r.evidence).toEqual({ kind: 'lockfile', file: 'package-lock.json' })
  })

  it('用例 1c：lockfile 优先于 corepack 字段（pnpm-lock + packageManager npm → pnpm）', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'package.json': JSON.stringify({ packageManager: 'npm@10.8.0' }),
    })
    expect((await detectPackageManagerDetailed(dir)).pm).toBe('pnpm')
  })
})

describe('detectPackageManagerDetailed：yarn 细分（§4.4 a/b/c）', () => {
  it('用例 2a：.yarnrc.yml 存在 → yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' })
    const r = await detectPackageManagerDetailed(dir)
    expect(r.pm).toBe('yarn-berry')
    expect(r.evidence).toEqual({ kind: 'lockfile', file: 'yarn.lock' })
  })

  it('用例 2b：yarn.lock 头部含 __metadata → yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '__metadata:\nversion: "8"\n\n# yarn lockfile v1\n' })
    expect((await detectPackageManagerDetailed(dir)).pm).toBe('yarn-berry')
  })

  it('用例 2c：yarn.lock 无 __metadata → yarn-classic', async () => {
    const dir = makeProject({
      'yarn.lock': 'THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n\n# yarn lockfile v1\n',
    })
    expect((await detectPackageManagerDetailed(dir)).pm).toBe('yarn-classic')
  })

  it('用例 2d：__metadata 在头部 4KB 之外 → yarn-classic', async () => {
    const dir = makeProject({ 'yarn.lock': 'x'.repeat(4500) + '__metadata' })
    expect((await detectPackageManagerDetailed(dir)).pm).toBe('yarn-classic')
  })

  it('用例 2e：yarn.lock 为目录（读失败 EISDIR）→ yarn-classic（§6.8）', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, 'yarn.lock'))
    expect((await detectPackageManagerDetailed(dir)).pm).toBe('yarn-classic')
  })
})

describe('detectPackageManagerDetailed：歧义（§4.4 级 1 命中 ≥2）', () => {
  it.each([
    { files: ['pnpm-lock.yaml', 'package-lock.json'] },
    { files: ['pnpm-lock.yaml', 'yarn.lock'] },
    { files: ['package-lock.json', 'yarn.lock'] },
    { files: ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] },
  ])('用例 3：$files 共存 → PMAmbiguousError，found 固定顺序（§6.1）', async ({ files }) => {
    const dir = makeProject(Object.fromEntries(files.map((f) => [f, ''])))
    const err = await detectPackageManagerDetailed(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PMAmbiguousError)
    expect((err as PMAmbiguousError).found).toEqual(files)
    expect((err as Error).message).toContain('歧义')
    expect((err as Error).message).toContain('lpm use')
  })
})

describe('detectPackageManagerDetailed：corepack 字段级（§4.4 级 2）', () => {
  it.each([
    { field: 'pnpm@12.6.0', pm: 'pnpm' },
    { field: 'npm@10.8.0', pm: 'npm' },
    { field: 'yarn@1.22.19', pm: 'yarn-classic' },
    { field: 'yarn@4.1.0', pm: 'yarn-berry' },
    { field: 'yarn@4.1.0+sha224.6b5e9', pm: 'yarn-berry' },
  ])('用例 4：$field → $pm', async ({ field, pm }) => {
    const dir = makeProject({ 'package.json': JSON.stringify({ packageManager: field }) })
    const r = await detectPackageManagerDetailed(dir)
    expect(r.pm).toBe(pm)
    expect(r.evidence).toEqual({ kind: 'corepack-field', value: field })
  })

  it('用例 4b：字段为未知 PM（bun）→ 无信号 → PMUnresolvedError', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ packageManager: 'bun@1.1.0' }) })
    await expect(detectPackageManagerDetailed(dir)).rejects.toBeInstanceOf(PMUnresolvedError)
  })

  it('用例 4c：字段非 string / JSON 坏 / package.json 缺失 → 无信号', async () => {
    const a = makeProject({ 'package.json': JSON.stringify({ packageManager: 42 }) })
    const b = makeProject({ 'package.json': 'not json' })
    const c = makeProject()
    for (const dir of [a, b, c]) {
      await expect(detectPackageManagerDetailed(dir)).rejects.toBeInstanceOf(PMUnresolvedError)
    }
  })
})

describe('detectPackageManagerDetailed：清单级与无证据（§4.4 级 3/4）', () => {
  it('用例 5：pnpm-workspace.yaml 存在（无 lockfile 无字段）→ pnpm', async () => {
    const dir = makeProject({ 'pnpm-workspace.yaml': 'packages:\n  - apps/*\n' })
    const r = await detectPackageManagerDetailed(dir)
    expect(r.pm).toBe('pnpm')
    expect(r.evidence).toEqual({ kind: 'workspace-manifest', file: 'pnpm-workspace.yaml' })
  })

  it('用例 6：仅 package.json workspaces 字段 → PMUnresolvedError（npm/yarn 同形不可辨）', async () => {
    const dir = makeProject({ 'package.json': JSON.stringify({ workspaces: ['apps/*'] }) })
    const err = await detectPackageManagerDetailed(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PMUnresolvedError)
    expect((err as Error).message).toContain('lpm use')
  })

  it('用例 7：全空目录 → PMUnresolvedError', async () => {
    const dir = makeProject()
    await expect(detectPackageManagerDetailed(dir)).rejects.toBeInstanceOf(PMUnresolvedError)
  })

  it('用例 8：rootDir 不向上探测（子目录 lockfile 不影响）', async () => {
    const dir = makeProject({ 'sub/pnpm-lock.yaml': '' })
    await expect(detectPackageManagerDetailed(dir)).rejects.toBeInstanceOf(PMUnresolvedError)
  })
})

describe('detectPackageManager 与 resolvePackageManager', () => {
  it('用例 9：detectPackageManager 与 detailed.pm 一致', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    expect(await detectPackageManager(dir)).toBe((await detectPackageManagerDetailed(dir)).pm)
  })

  it('用例 9b：resolvePackageManager——config 四值之一 → source config 且不探测（空目录也成功）', async () => {
    const dir = makeProject() // 空目录：若探测必然抛 PMUnresolvedError
    expect(await resolvePackageManager(dir, 'npm')).toEqual({ source: 'config', pm: 'npm' })
  })

  it('用例 9c：resolvePackageManager——undefined / 运行时越界值 → 走推断', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    expect(await resolvePackageManager(dir, undefined)).toEqual({
      source: 'detected',
      pm: 'pnpm',
      evidence: { kind: 'lockfile', file: 'pnpm-lock.yaml' },
    })
    const empty = makeProject()
    await expect(
      resolvePackageManager(empty, 'bun' as unknown as PackageManagerId),
    ).rejects.toBeInstanceOf(PMUnresolvedError)
  })
})
```

- [ ] **Step 2: 运行验证红灯**

Run: `pnpm vitest run tests/unit/pm.test.ts`
Expected: FAIL——`detectPackageManager` 当前为 stub，`not implemented: detectPackageManager（计划 S3）`

- [ ] **Step 3: 重写 src/core/pm.ts（整文件；`PackageManagerId` 类型定义逐字保留）**

```ts
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManagerId = 'pnpm' | 'npm' | 'yarn-classic' | 'yarn-berry'

// 推断优先级（lockfile > packageManager 字段 > workspace 清单）与 berry/classic 判定见 PRD §7；
// 行为契约见 S3 spec §4.4

/** 多 lockfile 共存 → 判定歧义（S3 spec §6.1）。found 固定顺序 pnpm-lock.yaml → package-lock.json → yarn.lock */
export class PMAmbiguousError extends Error {
  constructor(public found: string[], message: string) {
    super(message)
    this.name = 'PMAmbiguousError'
  }
}

/** 无任何可推断证据（S3 spec §6.2） */
export class PMUnresolvedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PMUnresolvedError'
  }
}

export type PMEvidence =
  | { kind: 'lockfile'; file: string }
  | { kind: 'corepack-field'; value: string }
  | { kind: 'workspace-manifest'; file: 'pnpm-workspace.yaml' }

export interface DetectResult {
  pm: PackageManagerId
  evidence: PMEvidence
}

const LOCKFILE_ORDER = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'] as const
type LockfileName = (typeof LOCKFILE_ORDER)[number]
const PM_BY_LOCKFILE: Record<Exclude<LockfileName, 'yarn.lock'>, 'pnpm' | 'npm'> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
}

const YARN_LOCK_HEAD_BYTES = 4096

/** yarn 细分（S3 spec §4.4 a/b/c）：.yarnrc.yml 存在 → berry；否则 yarn.lock 头部 4KB 含 __metadata → berry；
 *  否则（含 yarn.lock 缺失/读取失败）→ classic（PRD"否则 classic"字面）。
 *  lockfile 级命中 yarn.lock 与显式 `lpm use yarn` 共用本口径。 */
export function subdivideYarn(rootDir: string): 'yarn-classic' | 'yarn-berry' {
  if (existsSync(join(rootDir, '.yarnrc.yml'))) return 'yarn-berry'
  try {
    const fd = openSync(join(rootDir, 'yarn.lock'), 'r')
    try {
      const buf = Buffer.alloc(YARN_LOCK_HEAD_BYTES)
      const bytesRead = readSync(fd, buf, 0, YARN_LOCK_HEAD_BYTES, 0)
      return buf.toString('utf8', 0, bytesRead).includes('__metadata') ? 'yarn-berry' : 'yarn-classic'
    } finally {
      closeSync(fd)
    }
  } catch {
    return 'yarn-classic'
  }
}

/** 读 package.json 的 packageManager（corepack）字段 → PM。
 *  返回 null = 无信号（缺失/读取失败/JSON 坏/字段缺失或非 string/未知名/切分失败——宽容策略，§4.4 级 2） */
function readCorepackField(rootDir: string): { pm: PackageManagerId; raw: string } | null {
  const manifestPath = join(rootDir, 'package.json')
  if (!existsSync(manifestPath)) return null
  let parsed: unknown
  try {
    const source = readFileSync(manifestPath, 'utf8')
    const stripped = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = (parsed as Record<string, unknown>)['packageManager']
  if (typeof raw !== 'string') return null
  const at = raw.indexOf('@')
  if (at <= 0) return null
  const name = raw.slice(0, at)
  if (name === 'pnpm') return { pm: 'pnpm', raw }
  if (name === 'npm') return { pm: 'npm', raw }
  if (name === 'yarn') {
    const major = Number.parseInt(raw.slice(at + 1), 10)
    return { pm: Number.isFinite(major) && major >= 2 ? 'yarn-berry' : 'yarn-classic', raw }
  }
  return null
}

/** 详细检测（S3 spec §4.4 逐条契约；探测基准 rootDir 本层，不向上）。
 *  三级推断：lockfile > corepack 字段 > workspace 清单（仅 pnpm-workspace.yaml 可辨，PRD §7 定版） */
export async function detectPackageManagerDetailed(rootDir: string): Promise<DetectResult> {
  // 1. lockfile 级：存在性探测，不读内容
  const found = LOCKFILE_ORDER.filter((f) => existsSync(join(rootDir, f)))
  if (found.length >= 2) {
    throw new PMAmbiguousError(
      [...found],
      `检测到多个 lockfile（${found.join(', ')}），包管理器判定歧义。请手动指定：lpm use <pnpm|npm|yarn>`,
    )
  }
  if (found.length === 1) {
    const file = found[0]
    if (file === 'yarn.lock') {
      return { pm: subdivideYarn(rootDir), evidence: { kind: 'lockfile', file } }
    }
    return { pm: PM_BY_LOCKFILE[file], evidence: { kind: 'lockfile', file } }
  }

  // 2. corepack 字段级
  const field = readCorepackField(rootDir)
  if (field !== null) {
    return { pm: field.pm, evidence: { kind: 'corepack-field', value: field.raw } }
  }

  // 3. 清单级：package.json workspaces 不作信号（npm/yarn 同形不可辨）
  if (existsSync(join(rootDir, 'pnpm-workspace.yaml'))) {
    return { pm: 'pnpm', evidence: { kind: 'workspace-manifest', file: 'pnpm-workspace.yaml' } }
  }

  throw new PMUnresolvedError(
    '无法推断包管理器（未发现 lockfile、packageManager 字段或 pnpm-workspace.yaml）。请手动指定：lpm use <pnpm|npm|yarn>',
  )
}

/** S1 §4.3 冻结签名——detectPackageManagerDetailed 的单行包装 */
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId> {
  return (await detectPackageManagerDetailed(rootDir)).pm
}

export type PMResolution =
  | { source: 'config'; pm: PackageManagerId }
  | ({ source: 'detected' } & DetectResult)

const VALID_PM_IDS: readonly string[] = ['pnpm', 'npm', 'yarn-classic', 'yarn-berry']

/** S6 唯一 PM 消费入口（S3 spec §4.3）：显式设定优先（不探测）；未设定/运行时越界值 → 走推断。
 *  configPM 由调用方读 config 后注入——core 不依赖 state（S1 §3 分层规则）。 */
export async function resolvePackageManager(
  rootDir: string,
  configPM: PackageManagerId | undefined,
): Promise<PMResolution> {
  if (configPM !== undefined && VALID_PM_IDS.includes(configPM)) {
    return { source: 'config', pm: configPM }
  }
  return { source: 'detected', ...(await detectPackageManagerDetailed(rootDir)) }
}
```

- [ ] **Step 4: 运行验证绿灯**

Run: `pnpm vitest run tests/unit/pm.test.ts`
Expected: PASS（用例 1–9c 共 26 个 it）

- [ ] **Step 5: 定向 typecheck**

Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/core\|tests/unit/pm"`
Expected: 无输出（零错误）

---

### Task 3: use 命令与 cli 接线

**Files:**
- Create: `src/commands/use.ts`
- Modify: `src/cli.ts`（整文件重写：use 特判接线，其余不变）
- Test: `tests/unit/use-command.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `readProjectConfig`/`writeProjectConfig`；Task 2 的 `detectPackageManagerDetailed`/`subdivideYarn`/`PMAmbiguousError`/`PMUnresolvedError`/`PackageManagerId`；S2 的 `findWorkspaceRoot`（`WorkspaceNotFoundError`，kind `'start-dir-missing'`）；`@clack/prompts` 的 `confirm`/`isCancel`
- Produces: `runUse(pm: 'pnpm'|'npm'|'yarn'|undefined, cwd?: string): Promise<number>`（返回退出码 0/1；cwd 参数默认 `process.cwd()`，供单测注入）；`type UseToken`（Task 4 无直接消费，e2e 走真实产物）

- [ ] **Step 1: 写失败测试 tests/unit/use-command.test.ts**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
}))

import { confirm, isCancel } from '@clack/prompts'
import { runUse } from '../../src/commands/use.js'

// use 命令内部 findWorkspaceRoot(cwd)：临时目录必含 package.json（单包 fallback 根即临时目录自身，S2 §4.4.5）
const dirs: string[] = []
function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-use-'))
  dirs.push(dir)
  const full = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
  for (const [name, content] of Object.entries(full)) {
    writeFileSync(join(dir, name), content, 'utf8')
  }
  return dir
}
function cfgFile(dir: string): string {
  return join(dir, 'lpm.config.json')
}
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
function captureOut() {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return {
    stdout: () => out.mock.calls.map((c) => String(c[0])).join(''),
    stderr: () => err.mock.calls.map((c) => String(c[0])).join(''),
  }
}

beforeEach(() => {
  vi.mocked(confirm).mockReset()
  vi.mocked(isCancel).mockReset()
  vi.mocked(isCancel).mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('显式 lpm use <pm>（spec §4.5）', () => {
  it('用例 10a：config 缺失 → 新建并写入（pnpm）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const cap = captureOut()
    const code = await runUse('pnpm', dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('已设定包管理器：pnpm')
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8'))).toMatchObject({
      version: 1,
      packageManager: 'pnpm',
      libs: {},
    })
  })

  it('用例 10b：use yarn + __metadata → 写入 yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '__metadata:\n' })
    const code = await runUse('yarn', dir)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('yarn-berry')
  })

  it('用例 10c：use yarn 无细分证据 → 写入 yarn-classic', async () => {
    const dir = makeProject({ 'yarn.lock': '# yarn lockfile v1\n' })
    await runUse('yarn', dir)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('yarn-classic')
  })

  it('用例 11：幂等——已设定同值不写（mtime 不变，§6.6）', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    })
    const before = statSync(cfgFile(dir)).mtimeMs
    const cap = captureOut()
    const code = await runUse('pnpm', dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('包管理器已设定为 pnpm')
    expect(statSync(cfgFile(dir)).mtimeMs).toBe(before)
  })
})

describe('冲突（B2，spec §4.5 步骤 3–4 / §6.3–6.4）', () => {
  it('用例 12a：TTY + confirm 拒绝 → 未变更退出 0，不写', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(true)
    vi.mocked(confirm).mockResolvedValue(false)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(0)
    expect(cap.stderr()).toContain('冲突')
    expect(cap.stdout()).toContain('已取消，未变更')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })

  it('用例 12b：TTY + confirm 同意 → 写入并回显冲突继续', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(true)
    vi.mocked(confirm).mockResolvedValue(true)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(0)
    expect(JSON.parse(readFileSync(cfgFile(dir), 'utf8')).packageManager).toBe('npm')
    expect(cap.stdout()).toContain('冲突，已按你的选择继续')
  })

  it('用例 12c：非 TTY → 报错退出 1，不写（§6.4）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    stubTty(undefined)
    const cap = captureOut()
    const code = await runUse('npm', dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('无法交互确认')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })
})

describe('裸 lpm use（spec §4.5）', () => {
  it('用例 13a：已有设定 → 仅显示设定，不跑检测', async () => {
    const dir = makeProject({
      'pnpm-lock.yaml': '',
      'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'npm', libs: {} }),
    })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('当前设定：npm')
    expect(cap.stdout()).not.toContain('检测到包管理器')
  })

  it('用例 13b：无设定检测成功 → 显示依据，不落盘（§9.1 仅显式写入）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('检测到包管理器：pnpm')
    expect(cap.stdout()).toContain('pnpm-lock.yaml')
    expect(cap.stdout()).toContain('如需固化设定')
    expect(existsSync(cfgFile(dir))).toBe(false)
  })

  it('用例 13c：歧义 → 错误退出 1（§6.1）', async () => {
    const dir = makeProject({ 'package-lock.json': '', 'yarn.lock': '' })
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('歧义')
    expect(cap.stderr()).toContain('lpm use')
  })

  it('用例 13d：无证据 → 错误退出 1（§6.2）', async () => {
    const dir = makeProject()
    const cap = captureOut()
    const code = await runUse(undefined, dir)
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('无法推断包管理器')
  })

  it('用例 13e：cwd 不存在 → WorkspaceNotFoundError 接住，退出 1（§6.9）', async () => {
    const cap = captureOut()
    const code = await runUse('pnpm', join(tmpdir(), 'lpm-no-such-dir-x9z7'))
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('路径不存在')
  })
})
```

- [ ] **Step 2: 运行验证红灯**

Run: `pnpm vitest run tests/unit/use-command.test.ts`
Expected: FAIL——`../../src/commands/use.js` 模块不存在（导入失败）

- [ ] **Step 3: 新建 src/commands/use.ts**

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as clack from '@clack/prompts'
import {
  detectPackageManagerDetailed,
  PMAmbiguousError,
  PMUnresolvedError,
  subdivideYarn,
  type PackageManagerId,
  type PMEvidence,
} from '../core/pm.js'
import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace.js'
import { readProjectConfig, writeProjectConfig } from '../state/index.js'
import type { ProjectLpmConfig } from '../state/types.js'

export type UseToken = 'pnpm' | 'npm' | 'yarn'

const LOCKFILE_BY_TOKEN: Record<UseToken, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
}

type ConfirmResult = 'confirmed' | 'declined' | 'no-tty'

async function confirmOverride(message: string): Promise<ConfirmResult> {
  if (!process.stdin.isTTY) return 'no-tty' // 非 TTY 无法交互（spec §4.5 步骤 4）
  const answer = await clack.confirm({ message })
  if (clack.isCancel(answer)) return 'declined'
  return answer === true ? 'confirmed' : 'declined'
}

function evidenceText(ev: PMEvidence): string {
  if (ev.kind === 'lockfile') return ev.file
  if (ev.kind === 'corepack-field') return `package.json packageManager 字段 ${ev.value}`
  return 'pnpm-workspace.yaml'
}

/** use 命令行为（S3 spec §4.5）。pm 缺省 = 裸 use：自动推断展示，不落盘（PRD §9.1 仅显式写入）。
 *  cwd 参数化仅为可测性；cli.ts 以默认值调用，行为等价于 findWorkspaceRoot(process.cwd())。 */
export async function runUse(pm: UseToken | undefined, cwd: string = process.cwd()): Promise<number> {
  let rootDir: string
  try {
    rootDir = await findWorkspaceRoot(cwd)
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
  return pm === undefined ? runBare(rootDir) : runExplicit(rootDir, pm)
}

async function runBare(rootDir: string): Promise<number> {
  const cfg = await readProjectConfig(rootDir)
  const configured = cfg?.packageManager
  if (configured !== undefined && configured !== null) {
    // 含运行时越界值（手改 config）——仅显示，深层校验归 S4
    process.stdout.write(`当前设定：${String(configured)}\n`)
    return 0
  }
  try {
    const r = await detectPackageManagerDetailed(rootDir)
    process.stdout.write(`检测到包管理器：${r.pm}（依据：${evidenceText(r.evidence)}）\n`)
    process.stdout.write('如需固化设定：lpm use <pnpm|npm|yarn>\n')
    return 0
  } catch (err) {
    if (err instanceof PMAmbiguousError || err instanceof PMUnresolvedError) {
      process.stderr.write(`${(err as Error).message}\n`)
      return 1
    }
    throw err
  }
}

async function runExplicit(rootDir: string, pm: UseToken): Promise<number> {
  const target: PackageManagerId = pm === 'yarn' ? subdivideYarn(rootDir) : pm
  const cfg = await readProjectConfig(rootDir)

  // 幂等前置（spec §4.5 步骤 2）：已设定同值不写，冲突确认只发生在有实际写入时
  if (cfg?.packageManager === target) {
    process.stdout.write(`包管理器已设定为 ${target}\n`)
    return 0
  }

  // 冲突判定（B2 口径，spec §4.5 步骤 3）：指定 PM 缺自家 lockfile 且存在他类 lockfile
  const ownLockfile = LOCKFILE_BY_TOKEN[pm]
  const others = Object.values(LOCKFILE_BY_TOKEN).filter(
    (f) => f !== ownLockfile && existsSync(join(rootDir, f)),
  )
  const hasConflict = !existsSync(join(rootDir, ownLockfile)) && others.length > 0

  if (hasConflict) {
    process.stderr.write(`警告：项目现有 lockfile（${others.join(', ')}）与指定的 ${pm} 冲突。\n`)
    const c = await confirmOverride(`仍要使用 ${pm}？`)
    if (c === 'no-tty') {
      process.stderr.write(
        '与现有 lockfile 冲突，且当前环境无法交互确认。请改在终端运行，或先移除冲突 lockfile\n',
      )
      return 1
    }
    if (c === 'declined') {
      process.stdout.write('已取消，未变更\n')
      return 0
    }
  }

  const next: ProjectLpmConfig = cfg ?? { version: 1, libs: {} }
  next.packageManager = target
  await writeProjectConfig(rootDir, next)
  const suffix = hasConflict ? `（与 ${others.join(', ')} 冲突，已按你的选择继续）` : ''
  process.stdout.write(`已设定包管理器：${target}${suffix}\n`)
  return 0
}
```

- [ ] **Step 4: 重写 src/cli.ts（整文件；仅 use 分支新增，其余逐字保留）**

```ts
import { Command, Argument } from 'commander'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { COMMANDS } from './commands/registry.js'
import { notImplemented } from './commands/stub.js'
import { runUse } from './commands/use.js'
import { LPM_VERSION } from './version.js'

export function buildProgram(): Command {
  const program = new Command()
  program.name('lpm').description('npm 本地 link 联调 CLI').version(LPM_VERSION)

  for (const meta of COMMANDS) {
    // S3：use 为首个真实命令，特判接线（description 不带计划后缀）；其余命令维持 stub 循环（S1 §4.5）
    if (meta.name === 'use') {
      program
        .command(meta.name)
        .description(meta.summary)
        .addArgument(new Argument('[pm]', 'pnpm | npm | yarn').choices(['pnpm', 'npm', 'yarn']))
        .action(async (pm: 'pnpm' | 'npm' | 'yarn' | undefined) => {
          process.exitCode = await runUse(pm)
        })
      continue
    }
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
  // @types/node ≥22 中 exitCode 为 number | string | undefined，收敛为 number（契约 0/1）
  return Number(process.exitCode ?? 0)
}

// 直接执行时才 run()，被 import（测试）时不执行；
// 两侧 realpath 归一，防 Windows 路径大小写差异
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2))
}
```

- [ ] **Step 5: 运行验证绿灯**

Run: `pnpm vitest run tests/unit/use-command.test.ts`
Expected: PASS（用例 10a–13e 共 12 个 it）

- [ ] **Step 6: 全量 unit 回归 + 定向 typecheck**

Run: `pnpm test`
Expected: PASS（既有 42 + 新增 pm 26 + config-io 7 + state-stub 1 + use-command 12 = 88 用例）

Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands\|src/cli"`
Expected: 无输出（零错误）

---

### Task 4: e2e、S1 spec 回写与 verify 收口

**Files:**
- Modify: `tests/e2e/cli.e2e.test.ts`（整文件重写：新增 use describe 块，既有五例逐字保留）
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（回写义务 5 处编辑，对应 S3 spec §4.7 的 4 条义务）

**Interfaces:**
- Consumes: Task 3 的完整命令接线（经 `pnpm build` 产物 dist/cli.js 验证）
- Produces: 无新接口；S1 spec 回写完成 = S3 验收 6 达成

- [ ] **Step 1: 重写 tests/e2e/cli.e2e.test.ts（既有五例逐字保留 + 新增 use describe）**

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from './helpers.js'

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

// S3 e2e（spec §7.3）：临时目录含 package.json（findWorkspaceRoot 单包 fallback 根即临时目录自身）；
// spawn 即非 TTY——§6.4 非 TTY 冲突拒绝分支恰好在此实证，confirm 路径不进 e2e（unit 层 mock 覆盖）
describe('lpm use e2e（S3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-use-'))
    made.push(dir)
    const full = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  it('用例 17：use pnpm → exit 0，config 写入 pnpm', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'pnpm'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('已设定包管理器：pnpm')
    expect(JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8'))).toMatchObject({
      packageManager: 'pnpm',
    })
  })

  it('用例 18：裸 use → 检测展示，config 未创建', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('检测到包管理器：pnpm')
    expect(r.stdout).toContain('如需固化设定')
    expect(existsSync(join(dir, 'lpm.config.json'))).toBe(false)
  })

  it('用例 19：裸 use 多 lockfile → 歧义退出 1（§6.1）', async () => {
    const dir = makeProject({ 'package-lock.json': '', 'yarn.lock': '' })
    const r = await runCli(['use'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('歧义')
    expect(r.stderr).toContain('lpm use')
  })

  it('用例 20：use npm 冲突（非 TTY）→ 退出 1，config 未创建（§6.4）', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'npm'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('冲突')
    expect(r.stderr).toContain('无法交互确认')
    expect(existsSync(join(dir, 'lpm.config.json'))).toBe(false)
  })

  it('用例 21：use yarn（yarn.lock 头部 __metadata）→ config 写入 yarn-berry', async () => {
    const dir = makeProject({ 'yarn.lock': '__metadata:\nversion: "8"\n' })
    const r = await runCli(['use', 'yarn'], dir)
    expect(r.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).packageManager).toBe(
      'yarn-berry',
    )
  })

  it('用例 22：use abc → commander choices 拒绝，exit ≠ 0', async () => {
    const dir = makeProject({ 'pnpm-lock.yaml': '' })
    const r = await runCli(['use', 'abc'], dir)
    expect(r.exitCode).not.toBe(0)
  })
})
```

- [ ] **Step 2: 构建 + 运行 e2e**

Run: `pnpm build`
Expected: 成功产出 dist/cli.js

Run: `pnpm test:e2e`
Expected: PASS（既有 5 例 + 新增 6 例 = 11 个 it）

- [ ] **Step 3: S1 spec 回写（5 处 SearchReplace，须逐个顺序执行——同一文件禁止并行编辑）**

对 `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`：

回写 ①（§4.3 标题行）——old_str：

````
**core/pm.ts**（S3 填充）：
````

new_str：

````
**core/pm.ts**（S3 已填充；新增导出 detectPackageManagerDetailed / resolvePackageManager / subdivideYarn / PMAmbiguousError / PMUnresolvedError 与类型 PMEvidence / DetectResult / PMResolution，见 S3 spec §4.3）：
````

回写 ②（§4.3 代码块 stub 注释行）——old_str：

````
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId>  // stub
````

new_str：

````
export async function detectPackageManager(rootDir: string): Promise<PackageManagerId>  // S3 已实现（detectPackageManagerDetailed 的单行包装）
````

回写 ③（§4.4 标题行）——old_str：

````
### 4.4 state 读写 API（S4 填充）—— src/state/index.ts
````

new_str：

````
### 4.4 state 读写 API（S4 填充；readProjectConfig/writeProjectConfig 已由 S3 提前实现，含原子写 helper src/state/atomic.ts 与 LpmConfigParseError）—— src/state/index.ts
````

回写 ④（§4.4 代码块两行加注）——old_str：

````
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null>   // null = 未初始化
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void>
````

new_str：

````
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null>   // null = 未初始化；S3 提前实现
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void>   // S3 提前实现（原子写）
````

回写 ⑤（§4.5 行为契约表后加注；old_str 取表中"已注册命令"行 + 其后空行 + "选项注册"行首）——old_str：

````
| `lpm <已注册命令> ...` | — | `lpm <命令> 尚未实现（计划 <spec>）。当前可用：lpm --help` | 0（stub 契约，见 §6） |
````

new_str：

````
| `lpm <已注册命令> ...` | — | `lpm <命令> 尚未实现（计划 <spec>）。当前可用：lpm --help` | 0（stub 契约，见 §6） |

> 注（S3 回写）：`lpm use` 已实现为真实命令（行为契约见 S3 spec §4.5），上表"已注册命令 → stub"行对 use 不再适用；其余命令仍走 stub 契约。
````

- [ ] **Step 4: 全量 verify 收口**

Run: `pnpm verify`
Expected: 四段全绿——typecheck 0 错误 + build 成功 + unit（88 用例）+ e2e（11 用例）

- [ ] **Step 5: 汇报**

向控制器报告：任务完成情况、verify 四段结果、与 plan 的任何偏差（含逐字约束核对：冻结签名零改动、依赖零新增、S1 回写 5 处落位）。**不执行任何 git 操作。**

---

## Self-Review 记录

1. **Spec 覆盖**：§4.4 检测契约→Task 2（用例 1–9 与契约逐条对应，含计划期修订新增 1b/9b/9c）；§4.5 use 命令→Task 3（10a–13e）；§4.6 config 读写→Task 1（14–16）；§6 错误表 1–9→Task 2（3/4b/4c/2e）+ Task 3（12a–c/13c–e/14c）+ Task 4 e2e（19/20）；§4.7 回写义务→Task 4 Step 3；S4 剩余 stub 保留→Task 1 Step 5 逐字给出
2. **Placeholder 扫描**：无 TBD/TODO；所有代码步骤均给出整文件或逐字片段
3. **类型一致性**：`runUse(pm, cwd)` 签名 Task 3 定义 = Task 3 测试消费 = cli.ts 消费；`subdivideYarn` 返回类型 `'yarn-classic' | 'yarn-berry'` 与 spec §4.3 计划期修订 ① 一致；`PMAmbiguousError.found` 顺序（pnpm→npm→yarn）在实现常量 `LOCKFILE_ORDER` 与用例 3 断言两侧一致；`LpmConfigParseError.configPath` 在 Task 1 实现/测试两侧一致
4. **计划期修订落位**：spec §4.3 已含 subdivideYarn、§4.5 已幂等前置（Task 3 实现注释同步）、§7.2 已含 9b/9c——plan 与 spec 同步，无漂移
