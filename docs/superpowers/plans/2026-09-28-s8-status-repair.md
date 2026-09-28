# S8 status + repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `lpm status [--json]`（三方核对报告）与 `lpm repair [--dry-run]`（六族异常自修复），并把 node_modules 探查原语提为共用模块、补上跨命令的运行留痕。

**Architecture:** 判定面与执行面分离——`status.ts` 导出 `scanLinkState()`（只读判定，产出 `ScanOutcome`），`status` 只做格式化、`repair` 只做行动（写序：声明改写 → install → 复验/`--force` → 档案对齐 → 留痕，档案最后动）。`node_modules` 的真实形态由 `src/core/nmcheck.ts` 的 `probeNodeModules()` 统一探得（symlink/junction 经 realpath 比对），unlink 侧改调该原语、文案逐字不变。

**Tech Stack:** TypeScript ESM（Node ≥ 22.12）+ commander + @clack/prompts + execa + tsup + vitest；判定用 `node:fs`（lstat/realpath/stat），子进程用 execa。**运行时依赖零新增**。

**Spec:** `docs/superpowers/specs/2026-09-28-s8-status-repair-design.md`（本计划的一切行为以该 spec 为准；冲突时以 spec 为权威）

## Global Constraints

- 技术栈定版：TS ESM + Node ≥ 22.12 + commander + @clack/prompts + execa + tsup + vitest；**运行时依赖零新增**（PRD §14 行 390）
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入
- **禁止一切 Git 写操作**（worktree/分支/commit/push/add）——本计划所有任务**不执行任何 git 命令**，改动由用户自行提交
- 终端 Windows PowerShell；skill 自带 bash 脚本不可用；评审 = reviewer 直读产出文件
- 编辑纪律：**同一文件禁止并行 SearchReplace**；新增 import 与使用它的代码必须合并进**同一次**编辑；编辑后跑 `npx tsc --noEmit` 分级检查（**禁用 GetDiagnostics**，其结果为 TS Server 缓存不可靠）
- Task 工具无 model 参数，统一默认模型；实现者禁止派生子代理
- 每个任务收尾必须核对工作树（`git status --porcelain -uall`，**只读**）
- 冻结签名零改动：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3、S7 §4.3 所列公共 API 的既有签名
- **文案保真**：`unlink` 侧既有输出文案逐字不变（S7 测试断言这些字符串）
- 原子写 = 临时文件 + rename；fs 失败 crash 语义不入错误契约
- 全 lpm 状态文件（state/last/config/last-run）皆「可删除后重建」；逃生三步文案 = `① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install`
- 验证命令：`pnpm verify`（= typecheck && build && unit && e2e）。基线：unit **268**/268（17 文件）+ e2e **21**/21
- 计数链最终定版在收尾任务（Task 5）写入本计划与 spec 回写

---

## 文件结构总览

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/core/nmcheck.ts` | **新增**：`probeNodeModules` + `NmProbe`/`NmStatus`（node_modules 真实形态的唯一探源） | T1 |
| `src/commands/unlink.ts` | 改：`verifyResidue` 薄封装该原语；导出 `validateEntry`；末尾写留痕；O4 计数回滚 | T1 / T2 |
| `src/state/types.ts` | 改：`LastRunTrace` 接口（`.lpm/last-run.json` schema，与其余三类状态文件同处） | T2 |
| `src/state/index.ts` | 改：`lastRunPathOf` + `writeRunTrace` | T2 |
| `src/commands/link.ts` | 改：导出 `ternaryOriginal`/`ABANDON`；末尾写留痕 | T2 |
| `src/commands/status.ts` | **新增**：`scanLinkState`（共用判定面）+ 格式化 + `runStatus` | T3 |
| `src/commands/repair.ts` | **新增**：六族修复编排 + `runRepair` | T4 |
| `src/cli.ts` | 改：status / repair 特判接线 | T3 / T4 |
| `tests/unit/{nmcheck,status-command,repair-command}.test.ts` | **新增** | T1 / T3 / T4 |
| `tests/unit/{unlink-command,link-command,state-files}.test.ts`、`tests/e2e/cli.e2e.test.ts` | 改 | T1–T5 |

---

### Task 1: node_modules 探查原语提取（nmcheck）

**Files:**
- Create: `src/core/nmcheck.ts`
- Create: `tests/unit/nmcheck.test.ts`
- Modify: `src/commands/unlink.ts:95-130`（`verifyResidue` 改为薄封装）
- Modify: `tests/unit/unlink-command.test.ts`（新增 UNL-31 悬空断言）

**Interfaces:**
- Consumes: `node:fs`（`existsSync`/`lstatSync`/`realpathSync`）、`node:path`（`join`/`dirname`/`resolve`）
- Produces:
  ```ts
  export type NmStatus = 'entity' | 'link-to-lib' | 'link-elsewhere' | 'dangling' | 'missing' | 'unknown'
  export interface NmProbe { status: NmStatus; realTarget?: string; note?: string }
  export function probeNodeModules(manifestPath: string, key: string, expectedLibReal: string | null): NmProbe
  ```

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/nmcheck.test.ts`：

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeNodeModules } from '../../src/core/nmcheck.js'

const dirs: string[] = []
function mk(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-nmc-'))
  dirs.push(dir)
  for (const f of files) {
    const p = join(dir, f)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '', 'utf8')
  }
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('probeNodeModules', () => {
  it('NMC-1：实体目录 → entity', () => {
    const ws = mk(['apps/web/package.json', 'apps/web/node_modules/@t/lib/index.js'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('entity')
  })
  it('NMC-2：链接指向期望库 → link-to-lib', () => {
    const ws = mk(['apps/web/package.json', 'lib/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('link-to-lib')
    expect(r.realTarget).toBe(join(ws, 'lib'))
  })
  it('NMC-3：链接指向他处 → link-elsewhere', () => {
    const ws = mk(['apps/web/package.json', 'lib/package.json', 'other/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'other'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', join(ws, 'lib'))
    expect(r.status).toBe('link-elsewhere')
  })
  it('NMC-4：悬空链接 → dangling + note 悬空链接', () => {
    const ws = mk(['apps/web/package.json', 'gone/package.json'])
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'gone'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    rmSync(join(ws, 'gone'), { recursive: true, force: true })
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('dangling')
    expect(r.note).toBe('悬空链接')
  })
  it('NMC-5：条目不存在 → missing', () => {
    const ws = mk(['apps/web/package.json'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('missing')
    expect(r.note).toBeUndefined()
  })
  it('NMC-6：条目存在但期望库不可解析 → unknown + note 注册缺失/库已删，无法比对指向', () => {
    const ws = mk(['apps/web/package.json', 'apps/web/node_modules/@t/lib/index.js'])
    const r = probeNodeModules(join(ws, 'apps/web/package.json'), '@t/lib', null)
    expect(r.status).toBe('unknown')
    expect(r.note).toBe('注册缺失/库已删，无法比对指向')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/nmcheck.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/core/nmcheck.js"`

- [ ] **Step 3: 实现**

创建 `src/core/nmcheck.ts`：

```ts
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// node_modules/<key> 真实形态探源（S8 spec §4.3）。只返回事实，异常语义由调用方解释
// （unlink 侧映射见 src/commands/unlink.ts 的 verifyResidue）。

export type NmStatus = 'entity' | 'link-to-lib' | 'link-elsewhere' | 'dangling' | 'missing' | 'unknown'

export interface NmProbe {
  status: NmStatus
  realTarget?: string
  note?: string
}

/** 路径归一（比对用）：反斜杠转正斜杠；Windows 大小写不敏感 */
function normPath(p: string): string {
  const s = resolve(p).replaceAll('\\', '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 链接判定：lstat().isSymbolicLink() 对 junction 返回 false（PRD §10 行 328），
 *  故叠加 realpath 与字面路径比较——junction 的 realpath 会解析到目标目录，二者不等 */
function isLink(nmEntry: string, realTarget: string): boolean {
  if (lstatSync(nmEntry).isSymbolicLink()) return true
  return normPath(realTarget) !== normPath(nmEntry)
}

export function probeNodeModules(manifestPath: string, key: string, expectedLibReal: string | null): NmProbe {
  const nmEntry = join(dirname(manifestPath), 'node_modules', key)
  if (!existsSync(nmEntry)) {
    // existsSync 跟随链接：false = 不存在或悬空——lstat 不跟随，成功即悬空链接
    let dangling = false
    try { lstatSync(nmEntry); dangling = true } catch { dangling = false }
    return dangling ? { status: 'dangling', note: '悬空链接' } : { status: 'missing' }
  }
  let real: string
  try {
    real = realpathSync(nmEntry)
  } catch {
    return { status: 'dangling', note: '悬空链接' }
  }
  // 期望值不可解析（注册缺失/库已删）→ 无法比对；此判定必须先于实体/链接区分，
  // 以保持 S7 unlink 现有行为与文案（UNL-22 断言「存在实体则 ok + 注明」）
  if (expectedLibReal === null) {
    return { status: 'unknown', realTarget: real, note: '注册缺失/库已删，无法比对指向' }
  }
  if (!isLink(nmEntry, real)) return { status: 'entity', realTarget: real }
  return normPath(real) === normPath(expectedLibReal)
    ? { status: 'link-to-lib', realTarget: real }
    : { status: 'link-elsewhere', realTarget: real }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/nmcheck.test.ts`
Expected: PASS（6 例）

- [ ] **Step 5: 改造 unlink.ts（一次编辑：import + 函数体合并）**

在 `src/commands/unlink.ts` 中，**一次** SearchReplace 完成两处改动：① 顶部 import 区加一行；② 替换 `verifyResidue` 函数体。

import 区在 `import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'` 之后插入：

```ts
import { probeNodeModules, type NmProbe } from '../core/nmcheck.js'
```

函数体替换（原 `interface VerifyFinding` 与 `verifyResidue` 整体替换为）：

```ts
interface VerifyFinding { rel: string; nmRel: string; status: 'ok' | 'missing' | 'residue'; note?: string }

/** F 复验（判定走 nmcheck.probeNodeModules；本节只做「事实 → unlink 侧语义」解释，文案逐字不变） */
function verifyResidue(rootDir: string, cfg: ProjectLpmConfig | null, key: string, manifestPaths: string[]): VerifyFinding[] {
  const out: VerifyFinding[] = []
  const registered = cfg?.libs[key]
  const libDirAbs = typeof registered === 'string' ? join(rootDir, ...registered.split('/')) : null
  let libReal: string | null = null
  if (libDirAbs !== null) {
    try { libReal = realpathSync(libDirAbs) } catch { libReal = null }
  }
  for (const mp of manifestPaths) {
    const nmRel = `${toRel(rootDir, dirname(mp))}/node_modules/${key}`
    const probe: NmProbe = probeNodeModules(mp, key, libReal)
    if (probe.status === 'link-to-lib') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '软链残留' })
      continue
    }
    if (probe.status === 'dangling') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '悬空链接' })
      continue
    }
    if (probe.status === 'missing') {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'missing' })
      continue
    }
    // entity / link-elsewhere → ok（无 note）；unknown → ok + 注明
    out.push({ rel: toRel(rootDir, mp), nmRel, status: 'ok', note: probe.note })
  }
  return out
}
```

> 注：原实现里 `lstatSync` 仅用于悬空判定，改造后该职责移入 nmcheck；`existsSync` 仍被 unlink 其他位置使用，**不要删 import**（删了会编译失败）。

- [ ] **Step 6: 跑 unlink 既有用例（迁移等价性证据）**

Run: `npx vitest run tests/unit/unlink-command.test.ts`
Expected: PASS —— 既有 30 例全绿（其中 UNL-20 断言「软链残留」、UNL-22 断言实体 + 注明，即文案逐字未变的证据）

- [ ] **Step 7: 补悬空断言（UNL-31）**

在 `tests/unit/unlink-command.test.ts` 的 `describe('lstat 复验 + --force（裁决 1）')` 块内追加：

```ts
  it('UNL-31：悬空链接 → 复验报「悬空链接」→ force 恰一次', async () => {
    const ws = makeWs({}, STATE_ONE)
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    rmSync(join(ws, 'lpm-lib'), { recursive: true, force: true }) // 目标删除 → 悬空
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2) // install + --force
  })
```

Run: `npx vitest run tests/unit/unlink-command.test.ts`
Expected: PASS（31 例）

- [ ] **Step 8: 分级编译检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/core/nmcheck|src/commands/unlink"`
Expected: 零输出

- [ ] **Step 9: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读，确认只动了上述 4 个文件）
**不执行** `git add` / `git commit`——用户全局 Git 禁令。

---

### Task 2: 运行留痕基础设施 + link/unlink 接入 + S7 顺手项

**Files:**
- Modify: `src/state/types.ts`（追加 `LastRunTrace`）
- Modify: `src/state/index.ts`（追加 `lastRunPathOf` + `writeRunTrace`）
- Modify: `tests/unit/state-files.test.ts`（追加 STR-* 3 例）
- Modify: `src/commands/link.ts`（导出 `ABANDON`/`ternaryOriginal`；末尾写留痕）
- Modify: `src/commands/unlink.ts`（O4 计数回滚；末尾写留痕）
- Modify: `tests/unit/link-command.test.ts`、`tests/unit/unlink-command.test.ts`

**Interfaces:**
- Consumes: `writeJsonFileAtomic`（`src/state/atomic.js`）、`ensureGitignoreEntry`（同文件）、`InstallError`（`src/core/install.js`）
- Produces:
  ```ts
  // src/state/types.ts
  export interface LastRunTrace {
    version: 1
    command: 'link' | 'unlink' | 'repair'
    at: string
    rootDir: string
    packageManager: PackageManagerId
    result: 'ok' | 'failed'
    changes: Array<{ target: string; action: 'rewrite-manifest' | 'delete-entry' | 'upsert-registration'; detail: string }>
    installs: Array<{ command: string; ok: boolean; exitCode: number | null }>
    failure: { command: string; exitCode: number | null; stderrTail: string; message: string } | null
  }
  // src/state/index.ts
  export async function writeRunTrace(rootDir: string, trace: LastRunTrace): Promise<void>
  // src/commands/link.ts（扩为导出）
  export const ABANDON: unique symbol
  export async function ternaryOriginal(rootDir: string, key: string, pkgName: string, hits: DepHit[]): Promise<Map<string, string> | typeof ABANDON>
  ```

- [ ] **Step 1: 写失败测试（state 层）**

在 `tests/unit/state-files.test.ts` 末尾追加：

```ts
describe('writeRunTrace（S8 运行留痕）', () => {
  it('STR-T1：写入 .lpm/last-run.json，内容与入参一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-rt-'))
    dirs.push(dir)
    const trace: LastRunTrace = {
      version: 1, command: 'repair', at: '2026-09-28T10:00:00.000Z', rootDir: dir,
      packageManager: 'pnpm', result: 'failed',
      changes: [{ target: 'apps/web/package.json', action: 'rewrite-manifest', detail: '@t/lib：^1.0.0 → link:../lpm-lib' }],
      installs: [{ command: 'pnpm install --no-frozen-lockfile', ok: false, exitCode: 1 }],
      failure: { command: 'pnpm install --no-frozen-lockfile', exitCode: 1, stderrTail: 'ERR_PNPM', message: 'install 失败' },
    }
    await writeRunTrace(dir, trace)
    const raw = JSON.parse(readFileSync(join(dir, '.lpm', 'last-run.json'), 'utf8'))
    expect(raw).toEqual(trace)
  })
  it('STR-T2：新一次覆盖旧一次（只留最近一次）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-rt-'))
    dirs.push(dir)
    const mk = (cmd: 'link' | 'repair'): LastRunTrace => ({
      version: 1, command: cmd, at: 'x', rootDir: dir, packageManager: 'pnpm', result: 'ok',
      changes: [], installs: [], failure: null,
    })
    await writeRunTrace(dir, mk('link'))
    await writeRunTrace(dir, mk('repair'))
    expect(JSON.parse(readFileSync(join(dir, '.lpm', 'last-run.json'), 'utf8')).command).toBe('repair')
  })
  it('STR-T3：.lpm/ 不存在时自动创建，且写入 .gitignore 防护', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-rt-'))
    dirs.push(dir)
    await writeRunTrace(dir, {
      version: 1, command: 'link', at: 'x', rootDir: dir, packageManager: 'pnpm', result: 'ok',
      changes: [], installs: [], failure: null,
    })
    expect(existsSync(join(dir, '.lpm', 'last-run.json'))).toBe(true)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.lpm')
  })
})
```

（若该文件未导入 `LastRunTrace`/`writeRunTrace`/`mkdtempSync`/`tmpdir`/`existsSync`/`join`/`readFileSync`，在**同一次编辑**里补齐 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/state-files.test.ts`
Expected: FAIL —— `writeRunTrace is not a function` / 导入解析失败

- [ ] **Step 3: 实现 state 层**

`src/state/types.ts` 末尾追加：

```ts
/** 项目级 .lpm/last-run.json（gitignore）—— S8 运行留痕：只留最近一次 */
export interface LastRunTrace {
  version: 1
  command: 'link' | 'unlink' | 'repair'
  at: string                    // ISO 8601
  rootDir: string
  packageManager: PackageManagerId
  result: 'ok' | 'failed'
  /** target = 被改动对象：manifest 相对路径（文件动作）或 lib 名（档案动作） */
  changes: Array<{ target: string; action: 'rewrite-manifest' | 'delete-entry' | 'upsert-registration'; detail: string }>
  installs: Array<{ command: string; ok: boolean; exitCode: number | null }>
  failure: { command: string; exitCode: number | null; stderrTail: string; message: string } | null
}
```

`src/state/index.ts` 追加（`import type { ... LastRunTrace }` 并入既有的一行 type import）：

```ts
function lastRunPathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'last-run.json')
}

/** 运行留痕（S8 spec §4.6）：原子写；与 state 同级做 gitignore 防护（repair 可能在 .lpm/ 尚不存在时写）；
 *  只留最近一次（新写覆盖旧写）。**调用方负责吞异常**——留痕失败绝不影响主流程 */
export async function writeRunTrace(rootDir: string, trace: LastRunTrace): Promise<void> {
  await ensureGitignoreEntry(rootDir)
  const p = lastRunPathOf(rootDir)
  ensureParentDir(p)
  writeJsonFileAtomic(p, trace)
}
```

Run: `npx vitest run tests/unit/state-files.test.ts`
Expected: PASS

- [ ] **Step 4: link.ts 导出 ternaryOriginal / ABANDON（零逻辑改动）**

在 `src/commands/link.ts` 中，一次编辑完成两处：`const ABANDON = Symbol('abandon')` → `export const ABANDON: unique symbol = Symbol('abandon')`；`async function ternaryOriginal(` → `export async function ternaryOriginal(`。

- [ ] **Step 5: unlink.ts 修 O4（放弃时计数回滚）**

在 `runUnlink` 的 `for (const key of requested) {` 循环体**首行**插入两行快照：

```ts
      const idemMark = planIdempotent.length
      const missingMark = planMissing.length
```

并在 `if (planAbandoned.includes(key)) {` 分支的 `totalChanged = restoredTotal` 之后追加：

```ts
        planIdempotent.length = idemMark   // O4：放弃 = 该 lib 零改写 → 计数同步回滚
        planMissing.length = missingMark
```

- [ ] **Step 6: link.ts / unlink.ts 接入留痕**

两文件各自在 `run*` 末尾（成功路径 return 之前）与 `catch` 内失败路径写留痕，共用同一写法。以 unlink 为例（link 同构，command 换 `'link'`）：

```ts
async function traceOf(
  rootDir: string, pm: PackageManagerId, command: 'link' | 'unlink' | 'repair',
  changes: LastRunTrace['changes'], installs: LastRunTrace['installs'], failure: LastRunTrace['failure'],
): Promise<void> {
  try {
    await writeRunTrace(rootDir, {
      version: 1, command, at: new Date().toISOString(), rootDir, packageManager: pm,
      result: failure === null ? 'ok' : 'failed', changes, installs, failure,
    })
  } catch {
    process.stderr.write('警告：运行留痕写入失败（不影响本次结果）\n')
  }
}
```

- 成功路径：`installs` 由本次实际执行的 install / `--force` 次数与结果构造（无子进程则为 `[]`）；`changes` 由本次写盘的 manifest 与档案动作构造；`failure: null`。
- `catch` 路径：`const e = err as { command?: string; exitCode?: number | null; stderrTail?: string }`；若 `err instanceof InstallError` 则填 `e.command`/`e.exitCode`/`e.stderrTail`，否则 `command: ''`、`exitCode: null`、`stderrTail: ''`；`changes`/`installs` 填本次已发生的部分（失败即停语义下通常为空）。

- [ ] **Step 7: 补命令层测试（成功/失败两态留痕）**

- `tests/unit/link-command.test.ts` 追加：link 成功后 `.lpm/last-run.json` 存在且 `command === 'link'`、`result === 'ok'`；install 抛错时 `result === 'failed'` 且 `failure.exitCode` 有值。
- `tests/unit/unlink-command.test.ts` 追加：放弃场景（isCancel true）后 `planIdempotent`/`planMissing` 回滚生效——断言屏幕输出不出现「跳过合计」虚增（用 spy 捕获 stdout 文本）；unlink 成功后留痕 `command === 'unlink'`。

Run: `npx vitest run tests/unit/link-command.test.ts tests/unit/unlink-command.test.ts`
Expected: PASS

- [ ] **Step 8: 全量 unit + 分级编译**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/state|src/commands/link|src/commands/unlink"`
Run: `npx vitest run tests/unit`
Expected: typecheck 零输出；unit 全绿（本任务新增 3 + 3 例）

- [ ] **Step 9: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读）

---

### Task 3: status 命令（共用判定面 + 报告）

**Files:**
- Create: `src/commands/status.ts`
- Create: `tests/unit/status-command.test.ts`
- Modify: `src/cli.ts`（status 特判接线）
- Modify: `tests/e2e/cli.e2e.test.ts`（替换「lpm status（stub）」用例）

**Interfaces:**
- Consumes: `probeNodeModules`/`NmProbe`（T1）、`findDependents`/`Workspace`/`DepHit`（workspace）、`readDepValues`/`LOCAL_PROTOCOL_RE`（rewriter）、`validateEntry`（unlink.ts）、`readState`/`readProjectConfig`、`findWorkspaceRoot`/`loadWorkspace`、`resolvePackageManager`
- Produces（T4 依赖，签名必须逐字一致）:
  ```ts
  export type IssueFamily = 'drifted' | 'install-ineffective' | 'orphan' | 'stale-link' | 'stale-record' | 'corrupt'
  export interface FileScan { manifest: string; manifestPath: string; declared: string; sections: string[]; nm: NmProbe }
  export interface EntryScan {
    key: string; registered: boolean; recorded: boolean; linkedAt?: string
    original?: Record<string, string>; libDirAbs: string | null; libReal: string | null
    files: FileScan[]; issues: IssueFamily[]; notes: string[]
  }
  export interface ScanOutcome {
    entries: EntryScan[]
    total: number; ok: number; issue: number; issueCounts: Record<IssueFamily, number>
  }
  export async function scanLinkState(rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null): Promise<ScanOutcome>
  export interface StatusOptions { json?: boolean }
  export async function runStatus(opts: StatusOptions, cwd?: string): Promise<number>
  ```

- [ ] **Step 1: 写失败测试（判定面优先）**

创建 `tests/unit/status-command.test.ts`（fixture 布局复用 unlink 测试的 `makeWs` 思路，注册 `@t/lib` → `lpm-lib`）：

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(), select: vi.fn(), isCancel: vi.fn(() => false) }))
import { runStatus } from '../../src/commands/status.js'

const dirs: string[] = []
function makeWs(files: Record<string, string> = {}, state?: object, registered = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-st-'))
  dirs.push(dir)
  const full: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: registered ? { '@t/lib': 'lpm-lib' } : {} }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    'apps/web/node_modules/@t/lib/index.js': '',
    ...files,
  }
  for (const [n, c] of Object.entries(full)) {
    const p = join(dir, n)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c, 'utf8')
  }
  if (state !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify(state), 'utf8')
  }
  return dir
}
const ST = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }
function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { chunks.push(String(c)); return true })
  return fn().then((code) => { spy.mockRestore(); return { code, out: chunks.join('') } })
}
afterEach(() => {
  vi.restoreAllMocks()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('status 判定族', () => {
  it('ST-1：正常（注册 + 未链接 + registry + 实体）→ ok，默认输出折叠为汇总', async () => {
    const ws = makeWs()
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('1 正常')
    expect(out).not.toContain('⚠️')
  })
  it('ST-2：漂移（档案记着 + 声明被改回 registry）→ issues 含 drifted，退出码 0', async () => {
    const ws = makeWs({}, ST)
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('漂移')
    expect(out).toContain('lpm repair')
  })
  it('ST-3：装了没生效（档案 + link: + 目录为实体）→ issues 含 install-ineffective', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }) }, ST)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('装了没生效')
  })
  it('ST-4：孤儿（未注册未记档 + 声明为 link:）→ 被集合3纳入且 issues 含 orphan', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }) }, undefined, false)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('孤儿')
  })
  it('ST-5：残留链接（注册 + registry + 目录为链接）→ issues 含 stale-link', async () => {
    const ws = makeWs()
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('残留链接')
  })
  it('ST-6：失效记录（档案键指向不存在文件）→ issues 含 stale-record', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: 'x' } } })
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('失效记录')
  })
  it('ST-7：记录损坏（original 为空对象）→ issues 含 corrupt，且不抛错中断', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: {}, linkedAt: 'x' } } })
    const { code, out } = await capture(() => runStatus({}, ws))
    expect(code).toBe(0)
    expect(out).toContain('记录损坏')
  })
  it('ST-8：--json 输出全量（含正常项）+ 汇总口径 ok+issue=total', async () => {
    const ws = makeWs({}, ST)
    const { out } = await capture(() => runStatus({ json: true }, ws))
    const j = JSON.parse(out)
    expect(j.version).toBe(1)
    expect(j.summary.ok + j.summary.issue).toBe(j.summary.total)
    expect(j.entries[0].issues).toContain('drifted')
    expect(j.entries[0].files[0].nm.status).toBe('link-to-lib')
    expect(out).not.toMatch(/\u001b\[/)
  })
  // 勘误（实现期）：`makeWs` 默认 fixture 的 `apps/web/node_modules/@t/lib` 是**实体目录**，probeNodeModules
  // 必返回 `entity`——故在默认 fixture 下断言 `nm.status === 'link-to-lib'` 不可能成立。要断言 `link-to-lib`，
  // 必须把该条目改造成指向 `lpm-lib` 的 junction：先 `mkdirSync(join(ws,'apps/web/node_modules'), {recursive:true})`
  // 再 `symlinkSync(join(ws,'lpm-lib'), join(ws,'apps/web/node_modules/@t/lib'), 'junction')`（Windows 上 junction
  // 的父目录必须先存在，否则 ENOENT）。实现落定见 tests/unit/status-command.test.ts 的 ST-8。
  it('ST-9：workspace 不存在 → exit 1（无法核对）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-st-'))
    dirs.push(dir)
    const { code } = await capture(() => runStatus({}, dir))
    expect(code).toBe(1)
  })
  it('ST-10：多段命中值不一致 → 代表值取规范段序首段，并输出异值警告', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' }, devDependencies: { '@t/lib': '^1.0.0' } }),
    }, ST)
    const { out } = await capture(() => runStatus({}, ws))
    expect(out).toContain('多段命中值异')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/status-command.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `scanLinkState` + 输出**

创建 `src/commands/status.ts`，实现要点（完整落地，不留占位）：

```ts
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager } from '../core/pm.js'
import { probeNodeModules, type NmProbe } from '../core/nmcheck.js'
import { LOCAL_PROTOCOL_RE, readDepValues } from '../core/rewriter.js'
import {
  ManifestParseError, WorkspaceNotFoundError, WorkspacePatternError,
  findDependents, findWorkspaceRoot, loadWorkspace, type DepHit, type Workspace,
} from '../core/workspace.js'
import { LpmConfigParseError, LpmStateParseError, readProjectConfig, readState } from '../state/index.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'
import { LinkStateCorruptError, validateEntry } from './unlink.js'

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
/** 裸路径值（npm 允许 "foo": "../foo" 不带协议前缀）——S8 spec 裁决 7 */
const BARE_PATH_RE = /^(\.{1,2}[/\\]|\/|[A-Za-z]:[/\\])/

export type IssueFamily = 'drifted' | 'install-ineffective' | 'orphan' | 'stale-link' | 'stale-record' | 'corrupt'
const FAMILY_ORDER: readonly IssueFamily[] = ['drifted', 'install-ineffective', 'orphan', 'stale-link', 'stale-record', 'corrupt']
/** 屏幕输出用中文族名（§4.4 示例文案） */
const FAMILY_LABEL: Record<IssueFamily, string> = {
  drifted: '漂移', 'install-ineffective': '装了没生效', orphan: '孤儿',
  'stale-link': '残留链接', 'stale-record': '失效记录', corrupt: '记录损坏',
}

function toRel(rootDir: string, abs: string): string { return relative(rootDir, abs).replaceAll('\\', '/') }

/** 三依赖段全值（规范段序；同名多段全部保留） */
function readAllDepValues(manifestPath: string): Map<string, string[]> {
  const raw = readFileSync(manifestPath, 'utf8')
  const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>
  const out = new Map<string, string[]>()
  for (const s of DEP_SECTIONS) {
    const d = parsed[s]
    if (d === null || typeof d !== 'object' || Array.isArray(d)) continue
    for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
      if (typeof v !== 'string') continue
      const list = out.get(name)
      if (list === undefined) out.set(name, [v]); else list.push(v)
    }
  }
  return out
}

function isLocalish(v: string): boolean { return LOCAL_PROTOCOL_RE.test(v) || BARE_PATH_RE.test(v) }
```

`scanLinkState` 主体（判定分支逐字照 spec §4.4 表）：

```ts
export async function scanLinkState(rootDir: string, ws: Workspace, cfg: ProjectLpmConfig | null, st: LinkState | null): Promise<ScanOutcome> {
  const keys = new Set<string>()
  for (const k of Object.keys(cfg?.libs ?? {})) keys.add(k)
  for (const k of Object.keys(st?.links ?? {})) keys.add(k)

  const declaredByManifest = new Map<string, Map<string, string[]>>()
  for (const m of ws.members) {
    // 成员清单不可读即失败：不吞错、不降级（透传 ManifestParseError → exit 1，见 spec §4.4 / §6 #5）
    declaredByManifest.set(m.manifestPath, readAllDepValues(m.manifestPath))
  }
  for (const deps of declaredByManifest.values()) {
    for (const [name, vals] of deps) if (vals.some(isLocalish)) keys.add(name)
  }

  const entries: EntryScan[] = []
  for (const key of keys) {
    const libs = cfg?.libs ?? {}
    const hasCfg = Object.hasOwn(libs, key)
    const cfgVal: unknown = hasCfg ? libs[key] : undefined
    const registered = typeof cfgVal === 'string'
    const libDirAbs = registered ? join(rootDir, ...(cfgVal as string).split('/')) : null
    let libReal: string | null = null
    if (libDirAbs !== null) { try { libReal = realpathSync(libDirAbs) } catch { libReal = null } }

    const links = st?.links ?? {}
    const hasSt = Object.hasOwn(links, key)
    let original: Record<string, string> | null = null
    if (hasSt) {
      try { original = validateEntry(key, links[key]) } catch { original = null }
    }
    const recorded = original !== null

    const fileSet = new Set<string>()
    if (original !== null) {
      for (const k of Object.keys(original)) {
        if (k === '') continue
        fileSet.add(join(rootDir, ...k.split('/')))
      }
    }
    let hits: DepHit[] = []
    try { hits = await findDependents(ws, key) } catch { hits = [] }
    for (const h of hits) fileSet.add(h.manifestPath)

    const files: FileScan[] = []
    const issues = new Set<IssueFamily>()
    const notes: string[] = []
    if (hasSt && !recorded) issues.add('corrupt')

    for (const manifestPath of fileSet) {
      const rel = toRel(rootDir, manifestPath)
      const exists = statSyncSafe(manifestPath)
      const all = declaredByManifest.get(manifestPath)?.get(key)
      const declared = all?.[0] ?? ''
      const sections = sectionsOf(manifestPath, key)
      const fileRecorded = original !== null && Object.hasOwn(original, rel)
      const nm: NmProbe = exists ? probeNodeModules(manifestPath, key, libReal) : { status: 'unknown' }
      files.push({ manifest: rel, manifestPath, declared, sections, nm })

      if (!exists) { if (fileRecorded) issues.add('stale-record'); continue }
      if (fileRecorded) {
        if (declared === '') issues.add('stale-record')
        else if (LOCAL_PROTOCOL_RE.test(declared)) { if (nm.status !== 'link-to-lib') issues.add('install-ineffective') }
        else issues.add('drifted')
      } else if (declared !== '' && isLocalish(declared)) {
        issues.add('orphan')
      } else if (declared !== '' && (nm.status === 'link-to-lib' || nm.status === 'link-elsewhere')) {
        issues.add('stale-link')
      }
      if (all !== undefined && all.length >= 2 && new Set(all).size > 1) {
        notes.push(`多段命中值异：${sections.join('、')} 声明不一致，判定以首段 ${declared} 为准`)
      }
    }
    if (fileSet.size === 0 && registered) notes.push('已注册，但当前没有任何子包依赖它')

    entries.push({
      key, registered, recorded,
      linkedAt: hasSt ? (links[key] as { linkedAt?: string }).linkedAt : undefined,
      original: original ?? undefined, libDirAbs, libReal, files,
      issues: FAMILY_ORDER.filter((f) => issues.has(f)),
      notes,
    })
  }

  const issue = entries.filter((e) => e.issues.length > 0).length
  const issueCounts = Object.fromEntries(FAMILY_ORDER.map((f) => [f, 0])) as Record<IssueFamily, number>
  for (const e of entries) for (const f of e.issues) issueCounts[f]++
  return { entries, total: entries.length, ok: entries.length - issue, issue, issueCounts }
}
```

配套小工具（同文件）：

```ts
function statSyncSafe(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}
function sectionsOf(manifestPath: string, key: string): string[] {
  try { return readDepValues(readFileSync(manifestPath, 'utf8'), key).map((v) => v.section) }
  catch { return [] }
}
```

`runStatus`：workspace + cfg + PM + state 读取（KNOWN 错误类 → stderr + return 1）；调 `scanLinkState`；`opts.json` 时 `process.stdout.write(JSON.stringify(payload, null, 2) + '\n')`，否则逐条打印异常（族名 + 档案记录 + 每个文件的声明值与期望值 + `→ 修复：lpm repair`）+ 正常项折叠一行。**退出码恒 0**（除非「无法核对」）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/status-command.test.ts`
Expected: PASS（10 例）

- [ ] **Step 5: CLI 接线**

`src/cli.ts` 在 unlink 分支之后、stub 兜底之前插入：

```ts
    // S8：status 只读诊断接线（description 不带计划后缀）
    if (meta.name === 'status') {
      program
        .command(meta.name)
        .description(meta.summary)
        .option('--json', '输出结构化 JSON（供脚本与 E2E 消费）')
        .allowExcessArguments(false)
        .action(async (options: { json?: boolean }) => {
          process.exitCode = await runStatus(options)
        })
      continue
    }
```

（`import { runStatus } from './commands/status.js'` 并入 import 区同一次编辑。）

- [ ] **Step 6: e2e 替换 stub 用例**

`tests/e2e/cli.e2e.test.ts` 中把「lpm status（stub）：exit 0，stderr 含尚未实现与 S8」替换为：

```ts
  it('E2E-ST1：lpm status --json 在 fixture 上输出结构化全量', async () => {
    const ws = mkFixture()   // 复用本文件既有 fixture 构造
    const r = await runCli(['status', '--json'], ws)
    expect(r.exitCode).toBe(0)
    const j = JSON.parse(r.stdout)
    expect(j.version).toBe(1)
    expect(Array.isArray(j.entries)).toBe(true)
  })
  it('E2E-ST2：--help status 行无「（计划 S8）」后缀', async () => {
    const r = await runCli(['--help'])
    expect(r.stdout).not.toContain('三方核对链接状态（计划 S8）')
  })
```

- [ ] **Step 7: 编译 + 测试 + 收尾**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/status|src/cli"`
Run: `pnpm build ; npx vitest run tests/unit tests/e2e`
Expected: 零编译错误；全绿
Run: `git status --porcelain -uall`（只读）

---

### Task 4: repair 命令（六族自修复）

**Files:**
- Create: `src/commands/repair.ts`
- Create: `tests/unit/repair-command.test.ts`
- Modify: `src/cli.ts`（repair 特判接线）
- Modify: `tests/e2e/cli.e2e.test.ts`（repair dry-run / 非 TTY 用例）

**Interfaces:**
- Consumes: `scanLinkState`/`ScanOutcome`/`EntryScan`/`FileScan`（T3）、`probeNodeModules`（T1）、`writeRunTrace`（T2）、`ternaryOriginal`/`ABANDON`（T2）、`mapProtocol`/`restoreDepValue`/`LOCAL_PROTOCOL_RE`、`runInstall`/`runForceInstall`/`buildInstallCommandLine`/`buildForceInstallCommandLine`、`writeTextFileAtomic`、`readState`/`writeState`/`deleteState`/`readProjectConfig`/`writeProjectConfig`、`validateEntry`
- Produces:
  ```ts
  export interface RepairOptions { dryRun?: boolean }
  export class RepairInteractionError extends Error { constructor(message: string) }
  export async function runRepair(opts: RepairOptions, cwd?: string): Promise<number>
  ```

- [ ] **Step 1: 写失败测试（六族动作 + 写序）**

创建 `tests/unit/repair-command.test.ts`（fixture 与 status 测试同构；`execa` 与 `@clack/prompts` 均 mock）：

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('@clack/prompts', () => ({ confirm: vi.fn(async () => true), select: vi.fn(), text: vi.fn(), isCancel: vi.fn(() => false) }))
import { execa } from 'execa'
import { confirm, isCancel, select } from '@clack/prompts'
import { RepairInteractionError, runRepair } from '../../src/commands/repair.js'

// makeWs 与 status 测试同构（见 Task 3 Step 1）；此处省略重复代码
const ST = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: 'x' } } }
function stubTty(value: boolean | undefined): void { Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true }) }
afterEach(() => {
  vi.mocked(execa).mockReset(); vi.mocked(confirm).mockClear(); stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('repair 无异常与 dry-run', () => {
  it('REP-1：无异常 → 「无异常，无需修复」exit 0，不进入交互、零子进程', async () => {
    const ws = makeWs()   // 注册 + registry + 实体：正常
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })
  it('REP-2：--dry-run → 打印计划、零写盘零子进程', async () => {
    const ws = makeWs({}, ST)   // 漂移
    const r = await runRepair({ dryRun: true }, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^1.0.0')
  })
})

describe('漂移族三支（裁决 14/15）', () => {
  it('REP-3：声明值 == original → 直接恢复链接 + install 恰一次 + 档案不动', async () => {
    const ws = makeWs({}, ST)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('link:../lpm-lib')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^1.0.0')
  })
  it('REP-4：声明值 ≠ original（手改过）→ 二选一「保留当前值」→ 新 original 落盘', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, ST)
    vi.mocked(select).mockResolvedValue('keep-current' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^2.0.0')
  })
  it('REP-5：注册缺失的漂移 → 不入计划、降级提示、零子进程', async () => {
    const ws = makeWs({}, ST, false)   // cfg.libs 空
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
})

describe('孤儿族（裁决 6/16）', () => {
  it('REP-6：兄弟声明有正式版本号 → 自动采用（不再让用户重填）→ 恢复 + install', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }),
      'apps/other/package.json': JSON.stringify({ name: 'other', dependencies: { '@t/lib': '^1.0.0' } }),
    }, undefined, false)
    vi.mocked(select).mockResolvedValue('restore-registry' as never)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('REP-7：纳入管理但 lib 目录不存在 → 菜单不出现②（select 不被调用）', async () => {
    const ws = makeWs({
      'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../no-such-lib' } }),
    }, undefined, false)
    vi.mocked(select).mockResolvedValue('restore-registry' as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(0)
    const opts = vi.mocked(select).mock.calls[0][0] as { options: Array<{ value: string }> }
    expect(opts.options.some((o) => o.value === 'adopt')).toBe(false)
  })
})

describe('写序与交互闸门', () => {
  it('REP-8：install 失败 → 档案零改动（崩溃安全）', async () => {
    const ws = makeWs({}, ST)
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('boom'), { exitCode: 1, stderr: 'ERR' }))
    const r = await runRepair({}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, '.lpm/state.json'), 'utf8')).links['@t/lib'].original['apps/web/package.json']).toBe('^1.0.0')
  })
  it('REP-9：非 TTY 且有待修项 → RepairInteractionError exit 1', async () => {
    const ws = makeWs({}, ST)
    stubTty(false)
    const r = await runRepair({}, ws)
    expect(r).toBe(1)
  })
  it('REP-10：确认取消（isCancel）→ 零写盘 exit 1，但已写入失败留痕', async () => {
    const ws = makeWs({}, ST)
    vi.mocked(confirm).mockResolvedValue(false as never)
    vi.mocked(isCancel).mockReturnValue(true as never)
    const r = await runRepair({}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'last-run.json'))).toBe(true)
  })
  it('REP-11：确认默认值为 false（防误按回车执行不可逆动作）', async () => {
    const ws = makeWs({}, ST)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runRepair({}, ws)
    const cfgArg = vi.mocked(confirm).mock.calls[0][0] as { initialValue?: boolean }
    expect(cfgArg.initialValue).toBe(false)
  })
})
```

> **勘误（实现期，T4）**：上面用例有三处与实现不符，已按实测修正（落定见 `tests/unit/repair-command.test.ts`）：
> ① **交互类用例需 `stubTty(true)`**——vitest 下 `process.stdin.isTTY` 为 `undefined`（非 TTY），凡走 confirm/select 的用例（REP-3/4/6/8/10/11/12…）须先 `stubTty(true)` 才会进入交互路径，否则直接抛 `RepairInteractionError`。
> ② **断言值应为 `link:../../lpm-lib`**（不是 `link:../lpm-lib`）——fixture 里 lib 在 workspace 根（`lpm-lib`）、成员在 `apps/web`，`path.relative('apps/web','lpm-lib')` = `../../lpm-lib`；REP-3 的断言按此修正。
> ③ **兄弟来源用例的 `apps/other` 必须是 workspace 成员**——`pnpm-workspace.yaml` 用 `apps/*`（`findDependents` 只扫成员），REP-6 的 `apps/other/package.json` 才可能被当作兄弟来源。
>
> **新增用例主题（fix round 1，REP-14…REP-20）**：REP-14 多成员同时 adopt → 档案 `original` 按键合并保留两个文件键与原值；REP-15 `stale-record` 整条删除（计划与留痕 detail 含被删原值）；REP-16 `stale-record` 文件级出局；REP-17 `corrupt` 删条目 + 提示重跑 + 留痕 detail 含被删原值；REP-18 多兄弟值不一致 → 降级到下一级来源；REP-19 漂移 `mapProtocol` 跨盘符 → `ProtocolPathError` exit 1；REP-20 注册在但库目录已删（`libReal=null`）→ 降级提示指向 `lpm link`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/repair-command.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 repair**

`src/commands/repair.ts` 骨架（判定复用 `scanLinkState`，动作按 spec §4.5）：

```ts
export class RepairInteractionError extends Error {
  constructor(message: string) { super(message); this.name = 'RepairInteractionError' }
}

export async function runRepair(opts: RepairOptions, cwd: string = process.cwd()): Promise<number> {
  try {
    const rootDir = await findWorkspaceRoot(cwd)
    const ws = await loadWorkspace(rootDir)
    const cfg = await readProjectConfig(rootDir)
    const { pm } = await resolvePackageManager(rootDir, cfg?.packageManager)
    const st = await readState(rootDir)
    const scan = await scanLinkState(rootDir, ws, cfg, st)

    const plans = await buildPlan(rootDir, ws, cfg, st, scan)   // 见下
    if (plans.actions.length === 0 && plans.hints.length > 0) { /* 仅提示（如漂移缺 lib 路径）→ 打印 + exit 0 */ }
    if (plans.actions.length === 0) { process.stdout.write('无异常，无需修复\n'); return 0 }
    if (opts.dryRun === true) { printPlan(plans); return 0 }
    if (!process.stdin.isTTY) throw new RepairInteractionError('需交互确认修复计划。请改用 lpm repair --dry-run 查看计划')
    printPlan(plans)
    const ok = await clack.confirm({ message: '执行以上修复？', initialValue: false })
    if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 1 }
    return await execute(plans, rootDir, pm, st)   // 写序见下
  } catch (err) {
    if (err instanceof LinkCancelledError) { process.stderr.write('已取消\n'); return 1 }
    return reportError(err)
  }
}
```

**`buildPlan`**（统一前置判定；逐库按族产动作）：

1. `corrupt` 条目 → 动作 `delete-entry`（提示「若声明仍是本地链接，重跑 lpm repair」）
2. `stale-record` → 动作 `delete-entry`（文件级；记录原值进 `detail`）
3. `drifted`：
   - `libDirAbs === null` 或 `libReal === null` → **不入计划**，进 `hints`（提示先 `lpm link <路径>`）
   - `declared === original[rel]` → 动作 `rewrite-manifest`（目标值 `mapProtocol(pm, libDirAbs, dirname(manifestPath))`）
   - 否则 → `clack.select` 二选一（`keep-current` / `keep-original`）；`keep-current` 时额外动作 `update-original`（写回 state）
4. `install-ineffective` / `stale-link` → 无需改写，仅标记 `needInstall`
5. `orphan`：
   - 取原值：① 同库其他声明文件中的非本地值（**多个不一致则不采用**）→ ② `ternaryOriginal`（git HEAD / 手动输入 / 放弃）
   - `clack.select` 二选一：`restore-registry`（动作 `rewrite-manifest` 到原值 + `needInstall`）／`adopt`（**仅当 lib 目录存在且含 package.json**；动作 `upsert-registration` + `append-state-entry`，若目录探测非 `link-to-lib` 则加 `needInstall`）
   - 取不到原值 → 菜单只给 `adopt`（且需目录有效）；`ABANDON` → 跳过该库

**`execute`**（写序 = 裁决 11，档案最后动）：

```ts
async function execute(plans: Plan, rootDir: string, pm: PackageManagerId, st: LinkState | null): Promise<number> {
  const installs: LastRunTrace['installs'] = []
  const changes: LastRunTrace['changes'] = []
  // 第一段：声明改写（内存聚合后逐文件 writeTextFileAtomic）
  for (const a of plans.rewrites) { writeTextFileAtomic(a.manifestPath, applyRewrite(a)); changes.push({ target: a.rel, action: 'rewrite-manifest', detail: a.detail }) }
  // 第二段：install 恰一次（存在改写 / install-ineffective / stale-link / 孤儿②链接未生效）
  if (plans.needInstall) {
    const line = buildInstallCommandLine(pm)
    try { await runInstall(rootDir, pm, REPAIR_RETRY_ADVICE); installs.push({ command: line, ok: true, exitCode: 0 }) }
    catch (err) { await trace(rootDir, pm, changes, [...installs, { command: line, ok: false, exitCode: exitOf(err) }], failureOf(err, line)); throw err }
  }
  // 第三段：复验 + --force 恰一次
  const bad = plans.verifyTargets.flatMap((t) => verifyOne(rootDir, t))
  if (bad.length > 0) {
    const fl = buildForceInstallCommandLine(pm)
    try { await runForceInstall(rootDir, pm, REPAIR_RETRY_ADVICE); installs.push({ command: fl, ok: true, exitCode: 0 }) }
    catch (err) { await trace(...); throw err }
    for (const f of plans.verifyTargets.flatMap((t) => verifyOne(rootDir, t))) if (f.status !== 'ok') process.stderr.write(`警告：node_modules 复验未通过：${f.nmRel}；lpm status 可进一步诊断\n`)
  }
  // 第四段：档案对齐（state/config）
  for (const a of plans.entryDeletes) { /* 删条目或文件级记录；changes.push({ target: a.key, action: 'delete-entry', detail: a.detail }) */ }
  for (const a of plans.upserts) { /* 注册 upsert；changes.push({ target: a.key, action: 'upsert-registration', detail: a.detail }) */ }
  for (const a of plans.originalUpdates) { /* 更新 state.original */ }
  await writeState/deleteState/writeProjectConfig(...)
  // 第五段：留痕（成功）
  await trace(rootDir, pm, changes, installs, null)
  return 0
}
```

> `REPAIR_RETRY_ADVICE` 文案：`state 已保留（档案未改动），重跑 lpm repair 会重新收敛；${ESCAPE_HATCH}`（`ESCAPE_HATCH` 与 unlink 同文案，实现时从 unlink 或本地常量取一份，勿复制两份字符串——若需共享则从 `unlink.ts` 导出）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/repair-command.test.ts`
Expected: PASS（11 例）

- [ ] **Step 5: CLI 接线 + e2e**

`src/cli.ts` 在 status 分支后插入 repair 分支（`.option('--dry-run', ...)`、`.allowExcessArguments(false)`、`action → runRepair(options)`）。

`tests/e2e/cli.e2e.test.ts` 追加：

```ts
  it('E2E-RP1：lpm repair --dry-run 计划明细 + 项目 byte 级零变化', async () => {
    const ws = mkFixture()   // 复用本文件既有 fixture 构造
    const before = snapshot(ws)   // 复用/新增：读所有 package.json 原文
    const r = await runCli(['repair', '--dry-run'], ws)
    expect(r.exitCode).toBe(0)
    expect(snapshot(ws)).toEqual(before)
  })
  it('E2E-RP2：无异常时 lpm repair 早退 exit 0（不交互）', async () => {
    const r = await runCli(['repair'], mkFixture())
    expect(r.exitCode).toBe(0)
  })
  it('E2E-RP3：--help repair 行无「（计划 S8）」后缀', async () => {
    const r = await runCli(['--help'])
    expect(r.stdout).not.toContain('修复漂移与孤儿状态（计划 S8）')
  })
```

- [ ] **Step 6: 编译 + 全量测试 + 收尾**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/commands/repair|src/cli"`
Run: `pnpm build ; npx vitest run tests/unit tests/e2e`
Run: `git status --porcelain -uall`（只读）

---

### Task 5: 验收 6 自动化 + 全链验证 + 文档回写

**Files:**
- Modify: `tests/e2e/cli.e2e.test.ts`（验收 6 全链用例）
- Modify: `docs/superpowers/specs/2026-09-28-s8-status-repair-design.md`（计数链与实测结果回写）
- Modify: `tests/unit/unlink-command.test.ts`（若计数因 O4 修复变化，同步注释口径）

**Interfaces:**
- Consumes: 前四任务全部产出
- Produces: 计数链定版（unit 总数 / e2e 总数）+ 验收 6 自动化证据

- [ ] **Step 1: 写验收 6 全链用例**

`tests/e2e/cli.e2e.test.ts` 追加（构造漂移 → status 报出 → repair 清除；install 用 `--dry-run` 或 env 开关避免真实安装——本仓库零真实 install 惯例）：

```ts
  it('E2E-ACC6：漂移被 status 报出、repair 可清（验收 6 自动化）', async () => {
    const ws = mkFixture({ drifted: true })           // 档案记着链接、声明已改回 registry（= 手动 git checkout 的等价形态）
    const s1 = await runCli(['status', '--json'], ws)
    expect(s1.exitCode).toBe(0)
    expect(JSON.parse(s1.stdout).entries[0].issues).toContain('drifted')

    const plan = await runCli(['repair', '--dry-run'], ws)
    expect(plan.stdout).toContain('link:')

    // 真实修复路径由 unit（REP-3）覆盖（install 走 mock）；e2e 只断言计划与只读一致性
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
```

- [ ] **Step 2: 全量验证（四段）**

Run: `pnpm verify`
Expected: typecheck 0 错误 + build 成功 + unit 全绿 + e2e 全绿，exit 0

- [ ] **Step 3: 计数链定版**

记录实测：**`pnpm verify` 实测定版（2026-09-28，exit 0）：unit 20 文件 / 317 用例；e2e 1 文件 / 26 用例**（含本阶段新增 E2E-ACC6）。基线：unit 268 / e2e 21。已写入本计划 Task 5 与本 spec §7、§10「实现期实测」。

- [ ] **Step 4: spec 回写**

在 spec 回写：① §7 测试清单补实测计数；② §10 补「实现期实测」小节（与 spec 的偏差、实测固化的口径）；③ 若实现期发现 spec 与代码冲突，按 S1–S7 惯例以 spec 为权威并回写 spec 的对应 hunk。

- [ ] **Step 5: 收尾（不执行 git）**

Run: `git status --porcelain -uall`（只读，列出全部改动文件供用户提交）

---

## 收尾与后续（不属任何单任务）

- **最终全量评审（whole-branch）**：MERGE_BASE = `cb1e0e0`，reviewer 直读产出文件；判定 With fixes 则修一波并 scoped 复评（S6/S7 惯例）
- **OCR 评审轮**：**由用户指令触发**，非自动执行（`ocr-out-s8-review.txt`）
- **交接词**：S8 收口后写 `docs/handoffs/2026-09-28-s9-*.md`（S1–S7 惯例）
- **不清理** `.superpowers/sdd/2026-09-27-s7-unlink-direct.md`（S7 账本 Ruling + 本 spec §11 #5）

---

## Self-Review 记录（writing-plans 第 4 步）

**1. Spec 覆盖对照**

| Spec 章节 | 落点任务 |
|---|---|
| §4.3 `probeNodeModules` | T1 |
| §4.3 `writeRunTrace` / `LastRunTrace` | T2 |
| §4.3 `validateEntry` 导出 / `ABANDON` / `ternaryOriginal` 导出 | T2（T3/T4 消费） |
| §4.4 范围 A′ / 代表值口径 / 判定表 7 行 / 汇总口径 / 屏幕输出 / `--json` / 退出码 | T3 |
| §4.5 六族动作 / 孤儿三级取值 / 统一前置判定 / 计划三类信息 / confirm 默认 false / `--dry-run` / 无异常早退 | T4 |
| §4.6 留痕写入方（link/unlink/repair）与失败处理 | T2（link/unlink）+ T4（repair） |
| §5 六族矩阵 | T3（判定）+ T4（动作） |
| §6 错误表（含 ProtocolPathError、`LpmStateParseError`） | T3/T4 的 `reportError` KNOWN 列表 |
| §7 测试清单 | T1–T5 各步 |
| §9 自决 1–10 | T1（自决 1）/ T2（自决 6）/ T3（自决 2/3/7/8/9/10）/ T4（自决 4/5） |
| §10 候选与关闭项 | 不实现（记录在 spec） |
| §11 #1 O4 计数回滚 | T2 Step 5 |
| §11 #4 link/unlink 留痕 | T2 Step 6 |
| 验收 6 自动化 | T5 Step 1 |

**2. 占位符扫描**：无 TBD/TODO；所有代码步均给真实代码；`buildPlan`/`execute` 以「要点 + 骨架 + 逐条规则」形式给出（规则逐条可判定，无「自行补充」话术）。

**3. 类型一致性核对**：`probeNodeModules(manifestPath, key, expectedLibReal)` 三处调用（T1 unlink、T3 status、T4 repair）签名一致；`scanLinkState(rootDir, ws, cfg, st)` 在 T3 产出、T4 消费一致；`EntryScan.libDirAbs/libReal/files[].manifestPath/original` 为 T4 所依赖字段，T3 实现均已产出；`NmStatus` 六值在 T1 定义、T3 判定与 T4 动作中引用一致；`LastRunTrace.changes[].action` 三值（`rewrite-manifest`/`delete-entry`/`upsert-registration`）在 T2 定义、T4 使用一致。
