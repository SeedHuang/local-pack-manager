# S7 unlink 直通版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `lpm unlink <名字|路径>... [--all] [--dry-run]` 全链路——三态恢复、幂等重跑收敛、崩溃安全顺序（先恢复 → install → 复验/--force → 才删 state）、lstat 复验 + `--force` 重建、拆至清空 last 记录。

**Architecture:** 唯一命令编排层 src/commands/unlink.ts（镜像 link.ts 结构）；core 层扩 rewriter（readDepValues + LOCAL_PROTOCOL_RE 单源）与 install（retryAdvice + force 三件套 + runForceInstall）；state 层零改动；cli.ts 特判接线。行为权威 = spec（docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md），本 plan 与 spec 配套阅读。

**Tech Stack:** TypeScript ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest。运行时依赖零新增（复验用 node:fs realpathSync/lstatSync）。

**Spec:** docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md（2026-09-27 multi-lens 评审收口版）

## Global Constraints

- **禁止一切 Git 写操作**（worktree/分支/commit/push 等）——改动由用户自行 commit（用户全局规则，S1–S6 惯例）。任务收尾只做 `git status --porcelain -uall` 核对，无 commit 步骤
- 终端 Windows PowerShell；无 bash 脚本
- 相对导入一律带 `.js`；node 内置模块具名导入（S1 账本行 7，全局生效）
- **冻结面零改动**：S1 §4.3/§4.4、S3 §4.3、S5 rewriter 7 导出、S6 §4.3 所列公共 API 既有签名不变；新增导出合规（本 plan：rewriter +2、install +3、link 导出面扩展 4 项内部成员、unlink 全新）
- **单文件一次 SearchReplace** 合并 import 与代码改动；编辑后 `npx tsc --noEmit` 分级检查（禁用 GetDiagnostics）
- 测试期子代理运行后必须核对 `git status --porcelain -uall` 与任务清单一致（双 BOM 教训）
- 实现者禁止派生子代理；Task 工具统一默认模型
- 运行时依赖恰 commander / @clack/prompts / execa + node 内置——零新增
- 验证命令：`pnpm typecheck`（tsc --noEmit）/ `pnpm test`（vitest run tests/unit）/ `pnpm test:e2e` / `pnpm verify`（四段串联）；单测定向跑 `pnpm vitest run tests/unit/<file>`
- 真实 yarn/npm 全链不进自动化（PRD §12 行 375 smoke 归用户手测）；e2e 零真实 install（S6 先例——fixture 依赖 `@t/lib` 不可从 registry 装回）
- spec 落盘惯例：本 plan 落 docs/superpowers/plans/2026-09-27-s7-unlink-direct.md；BASE = 7d38504（S6 已提交，工作树干净）

---

### Task 1: rewriter 扩展——readDepValues + LOCAL_PROTOCOL_RE 单源

**Files:**
- Modify: `src/core/rewriter.ts`（新增 2 导出，既有 7 导出零改动）
- Modify: `src/commands/link.ts:8`（import 行并入 LOCAL_PROTOCOL_RE）、`src/commands/link.ts:65`（删私有 const）
- Test: `tests/unit/rewriter.test.ts`（追加 describe）

**Interfaces:**
- Consumes: rewriter.ts 内部既有 `scanManifest`、`safeJsonParse`、`REWRITE_SECTIONS`（私有，同文件直接用）
- Produces（T3 依赖）:
  - `export const LOCAL_PROTOCOL_RE: RegExp`（= `/^(link|file|portal):/`，link.ts 既有字面原样提升）
  - `export function readDepValues(manifestSource: string, pkgName: string): Array<{ section: string; value: string }>`（规范段序 dependencies → devDependencies → optionalDependencies；段内按文件出现序；peer 不入；safeJsonParse 失败的命中跳过）

- [ ] **Step 1: 写失败测试**（tests/unit/rewriter.test.ts 文件顶部 import 区并入 `readDepValues, LOCAL_PROTOCOL_RE`——与该文件既有 import 合并为一次编辑；文件尾部追加）

```ts
describe('readDepValues（S7 §4.3）', () => {
  it('RDV-1：段序规范化——文件中 dev 在前 deps 在后，输出 deps 先', () => {
    const src = '{"devDependencies":{"a":"^2.0.0"},"dependencies":{"a":"^1.0.0"}}'
    expect(readDepValues(src, 'a')).toEqual([
      { section: 'dependencies', value: '^1.0.0' },
      { section: 'devDependencies', value: '^2.0.0' },
    ])
  })
  it('RDV-2：转义 key 命中（F2 解码语义）', () => {
    const src = '{"dependencies":{"@scope\\/pkg":"^1.0.0"}}'
    expect(readDepValues(src, '@scope/pkg')).toEqual([{ section: 'dependencies', value: '^1.0.0' }])
  })
  it('RDV-3：peerDependencies 不入读取面', () => {
    const src = '{"peerDependencies":{"a":"^1.0.0"},"dependencies":{"a":"link:../a"}}'
    expect(readDepValues(src, 'a')).toEqual([{ section: 'dependencies', value: 'link:../a' }])
  })
  it('RDV-4：空命中 → []', () => {
    expect(readDepValues('{"dependencies":{"b":"^1.0.0"}}', 'a')).toEqual([])
  })
  it('RDV-5：多段多命中全出（link 改写后两段同值）', () => {
    const src = '{"dependencies":{"a":"link:../a"},"devDependencies":{"a":"link:../a"}}'
    expect(readDepValues(src, 'a')).toEqual([
      { section: 'dependencies', value: 'link:../a' },
      { section: 'devDependencies', value: 'link:../a' },
    ])
  })
  it('RDV-6：畸形转义 value（闭合但 JSON.parse 失败）跳过不致命', () => {
    const src = '{"dependencies":{"a":"bad\\x31value"}}'
    expect(readDepValues(src, 'a')).toEqual([])
  })
})

describe('LOCAL_PROTOCOL_RE（P1-2 单源提升）', () => {
  it('LP-1：三协议匹配 / 非 protocol 值不匹配', () => {
    expect(LOCAL_PROTOCOL_RE.test('link:../a')).toBe(true)
    expect(LOCAL_PROTOCOL_RE.test('file:./a')).toBe(true)
    expect(LOCAL_PROTOCOL_RE.test('portal:../a')).toBe(true)
    expect(LOCAL_PROTOCOL_RE.test('^1.0.0')).toBe(false)
    expect(LOCAL_PROTOCOL_RE.test('workspace:^')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/rewriter.test.ts`
Expected: FAIL（readDepValues / LOCAL_PROTOCOL_RE 未导出）

- [ ] **Step 3: 实现 rewriter.ts**（一次 SearchReplace：`const REWRITE_SECTIONS` 行之前插入导出常量 + 文件尾部 `findDepEntries` 之后追加 readDepValues——分两个连续区域则分两次**串行** SearchReplace，禁止同轮并行同文件）

```ts
// rewriter.ts — 在 const REWRITE_SECTIONS 声明之前插入：

/** 本地协议判定单源（S7 P1-2：link.ts 私有 const 提升为共享导出——协议清单防漂移） */
export const LOCAL_PROTOCOL_RE = /^(link|file|portal):/
```

```ts
// rewriter.ts — 文件尾部追加：

/** 读取 pkgName 在三改写段的全部当前值（S7 §4.3）：规范段序输出、段内按文件出现序；
 *  peer 不入读取面（link 未改 peer，unlink 恢复不碰）；safeJsonParse 失败的命中跳过不致命 */
export function readDepValues(manifestSource: string, pkgName: string): Array<{ section: string; value: string }> {
  const hits = scanManifest(manifestSource, pkgName)
  const out: Array<{ section: string; value: string }> = []
  for (const section of REWRITE_SECTIONS) {
    for (const h of hits) {
      if (h.section !== section) continue
      const v = safeJsonParse(h.literal)
      if (v !== null) out.push({ section, value: v })
    }
  }
  return out
}
```

- [ ] **Step 4: link.ts 切换单源**（一次 SearchReplace 覆盖两个相邻改动区：第 8 行 import 行 + 第 65 行 const 行；两区不相邻则**串行**两次，禁止同轮并行）

```ts
// 第 8 行 import 改为：
import { LOCAL_PROTOCOL_RE, ProtocolPathError, findDepEntries, mapProtocol, rewriteDepValue, type RewriteResult } from '../core/rewriter.js'

// 第 65 行 `const LOCAL_PROTOCOL_RE = /^(link|file|portal):/` 整行删除
```

- [ ] **Step 5: 跑测试确认通过 + 回归**

Run: `pnpm vitest run tests/unit/rewriter.test.ts tests/unit/link-command.test.ts`
Expected: rewriter 全 PASS（含新增 7 it）+ link-command 33/33（行为零变化回归）

- [ ] **Step 6: 编译检查 + 面核对**

Run: `npx tsc --noEmit`；`git status --porcelain -uall`
Expected: tsc 0 错误；改动面恰 = rewriter.ts / link.ts / rewriter.test.ts 三个文件

---

### Task 2: install 扩展——retryAdvice 参数化 + force 三件套

**Files:**
- Modify: `src/core/install.ts`
- Test: `tests/unit/install.test.ts`（追加 it）

**Interfaces:**
- Consumes: 既有 `PM_BINARY`、`buildInstallCommand`、`buildInstallCommandLine`、`InstallError`、`execa`
- Produces（T3 依赖）:
  - `export async function runInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void>`（可选第三参；缺省 = 现 link 向文案——link.ts 调用零改动）
  - `export async function runForceInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void>`（计划期修订 1：spec §4.3 漏列 force 执行体，F3 execa 落点定为此函数）
  - `export function buildForceInstallCommand(pm: PackageManagerId): readonly string[]`（四 PM 同形 `['install','--force']`；yarn-berry 不带 --immutable）
  - `export function buildForceInstallCommandLine(pm: PackageManagerId): string`

- [ ] **Step 1: 写失败测试**（tests/unit/install.test.ts：import 行并入新导出；文件尾部追加 describe——与既有 import 合并为一次编辑）

```ts
// import 行（第 9 行）改为：
import { InstallError, buildForceInstallCommand, buildForceInstallCommandLine, buildInstallCommand, buildInstallCommandLine, detectLibPM, pmExecutable, runForceInstall, runInstall, spawnBuildWatch } from '../../src/core/install.js'

// 文件尾部追加：
describe('buildForceInstallCommand（S7 §4.3）', () => {
  it('T3-9：四 PM 同形 install --force；yarn-berry 不带 --immutable', () => {
    expect(buildForceInstallCommand('pnpm')).toEqual(['install', '--force'])
    expect(buildForceInstallCommand('npm')).toEqual(['install', '--force'])
    expect(buildForceInstallCommand('yarn-classic')).toEqual(['install', '--force'])
    expect(buildForceInstallCommand('yarn-berry')).toEqual(['install', '--force'])
    expect(buildForceInstallCommandLine('pnpm')).toBe('pnpm install --force')
    expect(buildForceInstallCommandLine('yarn-berry')).toBe('yarn install --force')
  })
})

describe('runInstall/runForceInstall retryAdvice（裁决 7）', () => {
  it('T3-10：缺省文案 = link 向（含「重跑 lpm link 会幂等跳过」）', async () => {
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom' })
    try {
      await runInstall(makeDir(), 'pnpm')
      expect.unreachable()
    } catch (e) {
      expect((e as InstallError).message).toContain('重跑 lpm link 会幂等跳过')
    }
  })
  it('T3-11：传入自定义 advice 透传（unlink 向样例）', async () => {
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom' })
    const advice = 'state 已保留（文件已恢复），可直接重跑 lpm unlink——恢复段幂等跳过直达 install'
    try {
      await runInstall(makeDir(), 'pnpm', advice)
      expect.unreachable()
    } catch (e) {
      expect((e as InstallError).message).toContain('可直接重跑 lpm unlink')
      expect((e as InstallError).message).not.toContain('重跑 lpm link')
    }
  })
  it('T3-12：runForceInstall 成功——execa 以 force 参数调用', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runForceInstall(dir, 'npm')
    expect(execa).toHaveBeenCalledWith('npm', ['install', '--force'], { cwd: dir, stdio: ['inherit', 'inherit', 'pipe'] })
  })
  it('T3-13：runForceInstall 失败 → InstallError（command = force 串 + advice 透传）', async () => {
    vi.mocked(execa).mockRejectedValue({ exitCode: 7, stderr: 'EACCES' })
    try {
      await runForceInstall(makeDir(), 'pnpm', '自定义建议')
      expect.unreachable()
    } catch (e) {
      const err = e as InstallError
      expect(err.command).toBe('pnpm install --force')
      expect(err.exitCode).toBe(7)
      expect(err.stderrTail).toBe('EACCES')
      expect(err.message).toContain('自定义建议')
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/install.test.ts`
Expected: 新增 5 it FAIL（导出不存在）；既有 8 it PASS

- [ ] **Step 3: 实现 install.ts**（一次 SearchReplace 覆盖 runInstall 整段 + 尾部追加——runInstall 现有实现段与新增函数连续编排）

```ts
// install.ts — runInstall 段整体替换为（InstallError 类定义之后）：

/** 组装 InstallError（S6 #16 修正版结构）：首行诊断 + retryAdvice 建议行 */
function installError(command: string, exitCode: number | null, stderrTail: string, advice: string): InstallError {
  return new InstallError(
    command,
    exitCode,
    stderrTail,
    `install 失败（exit ${exitCode ?? '未知'}）：${stderrTail !== '' ? stderrTail : command}\n${advice}`,
  )
}

/** 默认建议（S6 #16 修正版 link 向文案——link 调用零改动；裁决 7） */
function linkRetryAdvice(command: string): string {
  return `state 已保留，重跑 lpm link 会幂等跳过（E1）——重试：修复报错后在 workspace 根重跑一次 ${command}；若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建`
}

/** install 子进程共通执行体（runInstall / runForceInstall 单源——OCR O1 精神：execa 细节不出本文件） */
async function execInstall(binary: string, args: readonly string[], rootDir: string, command: string, advice: string): Promise<void> {
  try {
    await execa(binary, [...args], { cwd: rootDir, stdio: ['inherit', 'inherit', 'pipe'] })
  } catch (err) {
    const e = err as { exitCode?: number | null; stderr?: string | undefined }
    const stderrTail = (e.stderr ?? '').slice(-2000)
    throw installError(command, e.exitCode ?? null, stderrTail, advice)
  }
}

/** 单次 install（workspace 根执行，stdio 继承透传输出——禁止死屏）；失败抛 InstallError。
 *  retryAdvice（S7 裁决 7）：可选建议文案；缺省 = link 向文案 */
export async function runInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void> {
  const command = buildInstallCommandLine(pm)
  await execInstall(PM_BINARY[pm], buildInstallCommand(pm), rootDir, command, retryAdvice ?? linkRetryAdvice(command))
}

/** `--force` 重建（S7 F3：pnpm "Already up to date" 软链残留重建）；失败抛 InstallError（advice 由调用方传 unlink 向文案） */
export async function runForceInstall(rootDir: string, pm: PackageManagerId, retryAdvice?: string): Promise<void> {
  const command = buildForceInstallCommandLine(pm)
  await execInstall(PM_BINARY[pm], buildForceInstallCommand(pm), rootDir, command, retryAdvice ?? linkRetryAdvice(command))
}

export function buildForceInstallCommand(_pm: PackageManagerId): readonly string[] {
  return ['install', '--force']
}

export function buildForceInstallCommandLine(pm: PackageManagerId): string {
  return `${PM_BINARY[pm]} ${buildForceInstallCommand(pm).join(' ')}`
}
```

注意：原 runInstall 体内嵌文案组装逻辑整体移除（由 installError/linkRetryAdvice 承接）；`buildForceInstallCommand` 的 `_pm` 参数保留签名对称（YAGNI：四 PM 同形无需 per-PM 表）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/install.test.ts tests/unit/link-command.test.ts`
Expected: install 13/13 + link-command 33/33（T3-5 既有断言「state 已保留/可抛弃重建」仍过——文案结构保持）

- [ ] **Step 5: 编译检查 + 面核对**

Run: `npx tsc --noEmit`；`git status --porcelain -uall`
Expected: tsc 0；改动面恰 = install.ts / install.test.ts

---

### Task 3: unlink 编排层——src/commands/unlink.ts 全链

**Files:**
- Create: `src/commands/unlink.ts`
- Modify: `src/commands/link.ts`（导出面扩展：resolveTarget/resolveMonorepo/ResolvedTarget/LinkCancelledError 加 export——内部实现零变化；LinkInteractionError kind 联合类型加 `'conflict-ternary'`——spec §5 #5 声明的扩展）
- Test: `tests/unit/unlink-command.test.ts`（新建）

**Interfaces:**
- Consumes: T1 `readDepValues`/`LOCAL_PROTOCOL_RE`；T2 `runInstall(rootDir, pm, advice?)`/`runForceInstall`/`buildForceInstallCommandLine`/`buildInstallCommandLine`/`pmExecutable`；link.ts `resolveTarget(raw, cfg, rootDir, cwd)`/`resolveMonorepo(libDirAbs)`（返回 `{ libDirAbs: string; name: string }`）；state 层 `readState/writeState/deleteState/writeLast/readProjectConfig`；`writeTextFileAtomic`；`restoreDepValue(source, pkgName, originalRange): RewriteResult`
- Produces: `runUnlink(targets: readonly string[], opts: UnlinkOptions, cwd?: string): Promise<number>`、`UnlinkOptions { all?: boolean; dryRun?: boolean }`、`LinkStateCorruptError(key, message)`——T4 cli 接线消费

- [ ] **Step 1: link.ts 导出面扩展**（一次 SearchReplace 覆盖四个声明点：LinkInteractionError kind、LinkCancelledError、ResolvedTarget、resolveTarget、resolveMonorepo——各处分散则**串行**多次，禁止同轮并行同文件）

```ts
// ① kind 联合类型加 conflict-ternary：
export class LinkInteractionError extends Error {
  constructor(public kind: 'member-select' | 'non-lpm-ternary' | 'conflict-ternary', message: string) {
    super(message)
    this.name = 'LinkInteractionError'
  }
}

// ② 内部信号错误导出（unlink 复用 B4 让选取消处理）：
export class LinkCancelledError extends Error {

// ③ 解析链导出（unlink 路径分支复用）：
export interface ResolvedTarget { key: string; libDirAbs: string; source: 'name' | 'path' }
export async function resolveTarget(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): Promise<ResolvedTarget> {
export async function resolveMonorepo(libDirAbs: string): Promise<{ libDirAbs: string; name: string }> {
```

- [ ] **Step 2: 写失败测试**（tests/unit/unlink-command.test.ts 新建全量）

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { isCancel, select } from '@clack/prompts'
import {
  LinkStateCorruptError,
  runUnlink,
} from '../../src/commands/unlink.js'

const dirs: string[] = []
function makeWs(files: Record<string, string> = {}, state?: object, last?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-unlk-'))
  dirs.push(dir)
  const full: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib/lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }),
    // registry 实体形态（复验 ok——realpath 为自身 ≠ libDirAbs）：默认无 force 干扰，force 场景用例特化覆盖
    'apps/web/node_modules/@t/lib/.keep': '',
    ...files,
  }
  for (const [name, content] of Object.entries(full)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  if (state !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), JSON.stringify(state), 'utf8')
  }
  if (last !== undefined) {
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'last.json'), JSON.stringify(last), 'utf8')
  }
  return dir
}
const STATE_ONE = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }
function stubTty(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}
afterEach(() => {
  vi.mocked(execa).mockReset()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('参数与解析', () => {
  it('UNL-1：无参数无 --all → 用法提示 exit 1', async () => {
    const ws = makeWs()
    const r = await runUnlink([], {})
    expect(r).toBe(1)
  })
  it('UNL-2：--all 与显式 targets 互斥 → exit 1 + stderr', async () => {
    const ws = makeWs({}, STATE_ONE)
    const r = await runUnlink(['@t/lib'], { all: true }, ws)
    expect(r).toBe(1)
  })
  it('UNL-3：名字分支未链接 → 「未链接：x，跳过」exit 0 零写盘', async () => {
    const ws = makeWs()
    const r = await runUnlink(['ghost'], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
  })
  it('UNL-26：路径分支——注册路径解析出 key；不存在路径 → exit 1', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink([join(ws, 'lpm-lib')], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    const r2 = await runUnlink([join(ws, 'no-such-dir')], {}, ws)
    expect(r2).toBe(1)
  })
})

describe('三态恢复（per-file）', () => {
  it('UNL-4：态1 恢复——pkg link: → ^1.0.0 + install 恰一次 + 条目删除', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(execa).toHaveBeenCalledWith('pnpm', ['install', '--no-frozen-lockfile'], expect.objectContaining({ cwd: ws }))
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/lib'])
  })
  it('UNL-5：态2 幂等跳过——pkg 已 ^1.0.0 → pkg byte 不变 + install 恰一次（重跑收敛）+ 条目删除', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }) }, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }))
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-6：态3 冲突非 TTY → LinkInteractionError + state 保留 + pkg 不变', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
  })
  it('UNL-7：态3 冲突 TTY 选「用当前」→ 零改写 + install 恰一次 + 条目删除', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('current')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-8：态3 冲突 TTY 选「用 original」→ 恢复', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('original')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
  })
  it('UNL-9：态3 isCancel → 放弃（条目保留 + pkg 不变 + 无 install）', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    stubTty(true)
    vi.mocked(select).mockResolvedValue('current')
    vi.mocked(isCancel).mockReturnValue(true)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toContain('^2.0.0')
  })
  it('UNL-24：同 key 去重（名字 + 同路径两写法）→ 第二处跳过计数', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib', join(ws, 'lpm-lib')], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1)
  })
  it('UNL-10：文件不存在 → 跳过警告 + 条目删除照常', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0', 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-11：全文件缺失 → 条目保留 + 无 install + exit 0', async () => {
    const ws = makeWs({}, { version: 1, links: { '@t/lib': { original: { 'apps/gone/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } })
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8')).links['@t/lib']).toBeDefined()
  })
  it('UNL-23：多 target 同文件链式恢复（两 lib 一 manifest）', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }) },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/web/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    writeFileSync(join(ws, 'apps/web/package.json'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib', '@t/libb': 'link:../lpm-libb' } }), 'utf8')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib', '@t/libb'], {}, ws)
    expect(r).toBe(0)
    const pkg = JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8'))
    expect(pkg.dependencies['@t/lib']).toBe('^1.0.0')
    expect(pkg.dependencies['@t/libb']).toBe('^2.0.0')
    expect(execa).toHaveBeenCalledTimes(1)
  })
})

describe('崩溃安全与 state/last', () => {
  it('UNL-13：install 失败 → InstallError + state 保留 + 文件已恢复', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom' })
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(1)
    expect(JSON.parse(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).dependencies['@t/lib']).toBe('^1.0.0')
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })
  it('UNL-14：重跑收敛——UNL-13 场景再跑 → 零改写 + install 再调 + 条目删除', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockRejectedValueOnce({ exitCode: 1, stderr: 'boom' })
    await runUnlink(['@t/lib'], {}, ws)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const pkgBefore = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(pkgBefore)
    expect(execa).toHaveBeenCalledTimes(2)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
  })
  it('UNL-15：--all 多 key 拆至清空 → last 记清空前完整集合 + state 文件删除', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }) },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/web/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink([], { all: true }, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(ws, '.lpm', 'last.json'), 'utf8')).names).toEqual(['@t/lib', '@t/libb'])
  })
  it('UNL-16：部分恢复（2 key 删 1）→ last 不动 + state 剩余条目', async () => {
    const ws = makeWs(
      { 'lpm-libb/package.json': JSON.stringify({ name: '@t/libb', main: './index.js' }) },
      { version: 1, links: {
        '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
        '@t/libb': { original: { 'apps/other/package.json': '^2.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' },
      } },
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
    const st = JSON.parse(readFileSync(join(ws, '.lpm', 'state.json'), 'utf8'))
    expect(st.links['@t/lib']).toBeUndefined()
    expect(st.links['@t/libb']).toBeDefined()
  })
  it('UNL-17：--all 空 state → 「无已链接项」exit 0', async () => {
    const ws = makeWs()
    const r = await runUnlink([], { all: true }, ws)
    expect(r).toBe(0)
  })
})

describe('条目校验（裁决 5）', () => {
  it('UNL-12：损坏四形态 → LinkStateCorruptError + exit 1（缺失/非对象/空对象/值空串）', async () => {
    const cases = [
      { version: 1, links: { '@t/lib': { linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: 'oops', linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: {}, linkedAt: 'x' } } },
      { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '' }, linkedAt: 'x' } } },
    ]
    for (const state of cases) {
      const ws = makeWs({}, state)
      const r = await runUnlink(['@t/lib'], {}, ws)
      expect(r).toBe(1)
    }
  })
})

describe('--dry-run（裁决 6）', () => {
  it('UNL-18：计划逐行输出 + 零写盘零子进程', async () => {
    const ws = makeWs({}, STATE_ONE)
    const pkgBefore = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runUnlink(['@t/lib'], { dryRun: true }, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(pkgBefore)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })
  it('UNL-19：dry-run 冲突降级警告继续', async () => {
    const ws = makeWs({ 'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^2.0.0' } }) }, STATE_ONE)
    const r = await runUnlink(['@t/lib'], { dryRun: true }, ws)
    expect(r).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'state.json'))).toBe(true)
  })
})

describe('lstat 复验 + --force（裁决 1）', () => {
  it('UNL-20：真实软链残留 → force 恰一次 → 复验未过警告（mock 不真重建）exit 0', async () => {
    const ws = makeWs({}, STATE_ONE)
    // 默认 registry 实体替换为指向 lib 的 junction（残留形态）
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    mkdirSync(join(ws, 'apps/web/node_modules'), { recursive: true })
    symlinkSync(join(ws, 'lpm-lib'), join(ws, 'apps/web/node_modules/@t/lib'), 'junction')
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2) // install + force 恰一次
    expect(execa).toHaveBeenNthCalledWith(2, 'pnpm', ['install', '--force'], expect.objectContaining({ cwd: ws }))
  })
  it('UNL-21：复验缺失 → force；force 后仍缺失 → 警告不阻塞', async () => {
    const ws = makeWs({}, STATE_ONE)
    rmSync(join(ws, 'apps/web/node_modules/@t/lib'), { recursive: true, force: true })
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(2)
  })
  it('UNL-22：注册缺失（cfg.libs 无 key）→ 存在实体则 ok + 注明，无 force', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }) }, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
    expect(execa).toHaveBeenCalledTimes(1) // 仅 install——实体存在，指向比对跳过注明
  })
})

describe('完成提示（J/I）', () => {
  it('UNL-25：恢复完成计数与逐行明细', async () => {
    const ws = makeWs({}, STATE_ONE)
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const r = await runUnlink(['@t/lib'], {}, ws)
    expect(r).toBe(0)
  })
})
```

（UNL 系列共 22 it（UNL-1…24 编号，7/8/9/24 补位后计数以实跑为准）；TTY select 路径经 @clack/prompts mock 全覆盖——镜像 link-command.test.ts 既有惯例；unlink 测试文件不 mock git——unlink 全链无 git 调用。）

- [ ] **Step 2b: link-command 顺手补 3 it（S6 final-review N-7/M-4——spec 目标 8 承载）**（tests/unit/link-command.test.ts 尾部追加；复用该文件既有 makeWs/makeLib/stubTty/captureOut/stateOf 工厂与 execa beforeEach mock）

```ts
describe('S6 留观补测（N-7/M-4）', () => {
  it('N7-22：§7.2 #22 批量遇错即停——good+bad 混批 → exit 1 零写盘', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const before = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    const r = await runLink([lib, join(ws, 'no-such-dir')], {}, ws)
    expect(r).toBe(1)
    expect(stateOf(ws)).toBeNull() // 聚合在内存——遇错即停零写盘
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toBe(before)
  })
  it('N7-13：§7.2 #13 同 key 去重——注册名 + 同 lib 路径 → 跳过合计含去重 1 处', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(
      join(ws, 'lpm.config.json'),
      JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPathOf(ws, lib) } }),
      'utf8',
    )
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    const out = captureOut()
    const r = await runLink(['@t/lib', lib], {}, ws)
    expect(r).toBe(0)
    expect(out.stdout()).toContain('已链接跳过：1 处') // dedupSkipped 计入 J2
    out.clear()
  })
  it('N7-20：§7.2 #20 --watch dry-run → watch 行断言', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const out = captureOut()
    const r = await runLink([lib], { watch: true, dryRun: true }, ws)
    expect(r).toBe(0)
    expect(out.stdout()).toContain('watch：拉起')
    expect(out.stdout()).toContain('run build:watch')
    out.clear()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run tests/unit/unlink-command.test.ts`
Expected: FAIL（unlink.js 模块不存在）

- [ ] **Step 4: 实现 src/commands/unlink.ts**（新建全量）

```ts
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import * as clack from '@clack/prompts'
import { LibCheckError } from '../core/linkcheck.js'
import {
  InstallError,
  buildForceInstallCommandLine,
  buildInstallCommandLine,
  pmExecutable,
  runForceInstall,
  runInstall,
} from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager } from '../core/pm.js'
import { LOCAL_PROTOCOL_RE, readDepValues, restoreDepValue, type RewriteResult } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findWorkspaceRoot,
  loadWorkspace,
  type Workspace,
} from '../core/workspace.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  deleteState,
  readProjectConfig,
  readState,
  writeLast,
  writeState,
} from '../state/index.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'
import { LinkArgumentError, LinkCancelledError, LinkInteractionError, resolveMonorepo, resolveTarget } from './link.js'

// unlink 直通版编排（S7 spec §4.4）。行为权威 = spec；崩溃安全顺序（PRD §9 行 306）：
// 先恢复文件 → install → 复验/--force → 才删 state（last 先写后删——评审 P1-1）。

export interface UnlinkOptions { all?: boolean; dryRun?: boolean }

export class LinkStateCorruptError extends Error {
  constructor(public key: string, message: string) {
    super(message)
    this.name = 'LinkStateCorruptError'
  }
}

interface RestoreHit { manifestPath: string; pkgName: string; original: string; fromValue: string; section: string }
interface FileAgg { content: string; hits: RestoreHit[]; changedCount: number }

function toRel(rootDir: string, abs: string): string {
  return relative(rootDir, abs).replaceAll('\\', '/')
}

const ESCAPE_HATCH = '若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建'

/** unlink 向 install 失败建议（裁决 7：重跑语义与 link 相反且真实有效——PRD §6.2 行 143） */
const UNLINK_RETRY_ADVICE = `state 已保留（文件已恢复），可直接重跑 lpm unlink——恢复段幂等跳过直达 install；${ESCAPE_HATCH}`

function reportError(err: unknown): number {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkStateCorruptError,
    InstallError,
  ]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

/** C 条目校验（裁决 5）：original 为对象、非空、键值全非空 string；损坏 → LinkStateCorruptError */
function validateEntry(key: string, entry: LinkState['links'][string] | undefined): Record<string, string> {
  if (entry === undefined) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 缺失。手工逃生三步：${ESCAPE_HATCH}`)
  }
  const o = entry.original
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 不是对象。手工逃生三步：${ESCAPE_HATCH}`)
  }
  const keys = Object.keys(o)
  if (keys.length === 0) {
    throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original 为空对象。手工逃生三步：${ESCAPE_HATCH}`)
  }
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k]
    if (typeof v !== 'string' || v === '') {
      throw new LinkStateCorruptError(key, `state 条目损坏：${key} 的 original["${k}"] 应为非空字符串。手工逃生三步：${ESCAPE_HATCH}`)
    }
  }
  return o as Record<string, string>
}

interface VerifyFinding { rel: string; nmRel: string; status: 'ok' | 'missing' | 'residue'; note?: string }

/** F 复验（realpath 比对——兼容 symlink 与 junction，PRD 行 328；悬空/库删/注册缺全部 try/catch 兜底） */
function verifyResidue(rootDir: string, cfg: ProjectLpmConfig | null, key: string, manifestPaths: string[]): VerifyFinding[] {
  const out: VerifyFinding[] = []
  const registered = cfg?.libs[key]
  const libDirAbs = typeof registered === 'string' ? join(rootDir, ...registered.split('/')) : null
  let libReal: string | null = null
  if (libDirAbs !== null) {
    try { libReal = realpathSync(libDirAbs) } catch { libReal = null }
  }
  for (const mp of manifestPaths) {
    const nmEntry = join(dirname(mp), 'node_modules', key)
    const nmRel = `${toRel(rootDir, dirname(mp))}/node_modules/${key}`
    if (!existsSync(nmEntry)) {
      // existsSync 跟随链接：false = 不存在或悬空——lstat 不跟随，成功即悬空链接
      let dangling = false
      try { lstatSync(nmEntry); dangling = true } catch { dangling = false }
      out.push({ rel: toRel(rootDir, mp), nmRel, status: dangling ? 'residue' : 'missing', note: dangling ? '悬空链接' : undefined })
      continue
    }
    let real: string
    try { real = realpathSync(nmEntry) } catch {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '悬空链接' })
      continue
    }
    if (libReal !== null && real === libReal) {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'residue', note: '软链残留' })
      continue
    }
    if (libReal === null) {
      out.push({ rel: toRel(rootDir, mp), nmRel, status: 'ok', note: '注册缺失/库已删，无法比对指向' })
      continue
    }
    out.push({ rel: toRel(rootDir, mp), nmRel, status: 'ok' })
  }
  return out
}

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}
// （注：verifyResidue 内联同款判定，lstatExists 保留为语义命名的私有 helper——实施时二选一，避免双份）

export async function runUnlink(targets: readonly string[], opts: UnlinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数（--all 除外——spec §4.1）
  if (targets.length === 0 && opts.all !== true) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm unlink <名字|路径>... [--all] [--dry-run]\n')
    return 1
  }
  try {
    // A2 互斥（spec §5 #3）
    if (opts.all === true && targets.length > 0) {
      throw new LinkArgumentError('--all', '--all 与显式目标互斥')
    }
    // A workspace + PM（镜像 S6 A5）
    const rootDir = await findWorkspaceRoot(cwd)
    const ws: Workspace = await loadWorkspace(rootDir)
    const cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
    const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
    const pm = pmResolution.pm
    if (pmResolution.source === 'detected') {
      process.stdout.write(`检测到包管理器：${pm}（未 lpm use 固化）\n`)
    }
    const st: LinkState | null = await readState(rootDir)
    void ws
    // G5：--all 空 state → 无已链接项 exit 0（幂等不报错）
    if (opts.all === true && Object.keys(st?.links ?? {}).length === 0) {
      process.stdout.write('无已链接项\n')
      return 0
    }

    // B target 解析（--all → state 全量 keys；显式 → 逐个解析 + 去重）
    const seenRaw = new Set<string>()
    const seenKey = new Set<string>()
    let dedupSkipped = 0
    const requested: string[] = []
    if (opts.all === true) {
      requested.push(...Object.keys(st?.links ?? {}))
    } else {
      for (const raw of targets) {
        if (seenRaw.has(raw)) continue
        seenRaw.add(raw)
        const rt = await resolveTarget(raw, cfg, rootDir, cwd)
        let key: string
        if (rt.source === 'name') {
          key = rt.key
        } else {
          const mr = await resolveMonorepo(rt.libDirAbs)
          key = mr.name !== '' ? mr.name : toRel(rootDir, mr.libDirAbs)
        }
        if (seenKey.has(key)) { dedupSkipped++; continue }
        seenKey.add(key)
        requested.push(key)
      }
    }

    // C/D 逐 key 校验 + 逐文件三态（聚合在内存——遇错即停零写盘）
    const aggregated = new Map<string, FileAgg>()
    const pendingDelete: string[] = []
    const verifyManifests = new Map<string, string[]>() // key → manifestPaths（复验面 = 待删集全部 original 键）
    const planSkipped: string[] = []       // 未链接跳过
    const planAbandoned: string[] = []     // 冲突放弃
    const planIdempotent: Array<{ key: string; rel: string }> = [] // 已恢复跳过（key, file）
    const planMissing: string[] = []       // 文件不存在警告
    const planConflicts: string[] = []     // dry-run 冲突降级行
    let totalChanged = 0
    let restoredKeyCount = 0               // 有恢复动作的 key 数（O4 镜像 N）

    for (const key of requested) {
      const entry = st?.links[key]
      if (entry === undefined) {
        process.stdout.write(`未链接：${key}，跳过\n`)
        planSkipped.push(key)
        continue
      }
      const original = validateEntry(key, entry)
      // per-key 快照（isCancel 放弃 → 内存回滚——放弃语义 = 该 lib 零改写）
      const snapshot = new Map([...aggregated].map(([k, v]) => [k, { content: v.content, hits: [...v.hits], changedCount: v.changedCount }] as const))
      let anyRestored = false
      let allMissing = true
      const keyManifestPaths: string[] = []

      for (const [origKey, origValue] of Object.entries(original)) {
        const manifestPath = join(rootDir, ...origKey.split('/'))
        keyManifestPaths.push(manifestPath)
        if (!existsSync(manifestPath)) {
          process.stderr.write(`警告：文件不存在，跳过恢复：${origKey}\n`)
          planMissing.push(origKey)
          continue
        }
        allMissing = false
        const rel = toRel(rootDir, manifestPath)
        let agg = aggregated.get(manifestPath)
        if (agg === undefined) {
          agg = { content: readFileSync(manifestPath, 'utf8'), hits: [], changedCount: 0 }
          aggregated.set(manifestPath, agg)
        }
        const values = readDepValues(agg.content, key)
        const representative = values[0]?.value ?? ''
        if (representative === '') {
          // 文件内无命中段（依赖已被手动移除）→ 幂等跳过（计划期修订 2）
          planIdempotent.push({ key, rel })
          continue
        }
        if (LOCAL_PROTOCOL_RE.test(representative)) {
          // 态1 恢复（全段写回——裁决 4）
          const result: RewriteResult = restoreDepValue(agg.content, key, origValue)
          agg.content = result.content
          agg.changedCount += result.changedKeys.length
          totalChanged += result.changedKeys.length
          for (const h of values) {
            agg.hits.push({ manifestPath, pkgName: key, original: origValue, fromValue: h.value, section: h.section })
          }
          anyRestored = true
          if (values.length >= 2 && new Set(values.map((v) => v.value)).size > 1) {
            process.stderr.write(`警告：${rel} 多段命中值异，全段写回 ${origValue}\n`)
          }
        } else if (representative === origValue) {
          // 态2 幂等跳过（零改写；key 仍进待删集——重跑收敛，G1）
          planIdempotent.push({ key, rel })
        } else {
          // 态3 冲突二选一（B1 防护核心）
          if (opts.dryRun === true) {
            planConflicts.push(`${rel}（当前 ${representative} vs original ${origValue}）`)
            continue
          }
          if (!process.stdin.isTTY) {
            throw new LinkInteractionError('conflict-ternary', `检测到手动改动（${rel}：当前 ${representative} vs original ${origValue}），需交互确认。请手动处理该文件后重试，或先 lpm unlink --dry-run 查看`)
          }
          const picked = await clack.select({
            message: `检测到手动改动（${rel}），选择处理方式`,
            options: [
              { value: 'current', label: `用当前 ${representative}（保留手动升级）` },
              { value: 'original', label: `用 original ${origValue}（恢复）` },
            ],
          })
          if (clack.isCancel(picked)) {
            process.stdout.write(`已放弃：${key}（state 条目保留）\n`)
            planAbandoned.push(key)
            break
          }
          if (picked === 'original') {
            const result = restoreDepValue(agg.content, key, origValue)
            agg.content = result.content
            agg.changedCount += result.changedKeys.length
            totalChanged += result.changedKeys.length
            for (const h of values) {
              agg.hits.push({ manifestPath, pkgName: key, original: origValue, fromValue: h.value, section: h.section })
            }
            anyRestored = true
          }
          // picked === 'current' → 该文件该 key 零改写；key 仍进待删集（G1）
        }
      }

      if (planAbandoned.includes(key)) {
        // 内存回滚（放弃 = 该 lib 零改写）
        aggregated.clear()
        let restoredTotal = 0
        for (const [k, v] of snapshot) {
          aggregated.set(k, { content: v.content, hits: [...v.hits], changedCount: v.changedCount })
          restoredTotal += v.changedCount
        }
        totalChanged = restoredTotal
        continue
      }
      if (allMissing) continue // 全文件缺失 → 条目保留（自决 5），不进待删集
      pendingDelete.push(key)
      if (anyRestored) restoredKeyCount++
      verifyManifests.set(key, keyManifestPaths)
    }

    // H dry-run（裁决 6；镜像 S6 K）
    if (opts.dryRun === true) {
      process.stdout.write('dry-run 执行计划（不落任何盘、不执行任何子进程）：\n')
      for (const [mp, agg] of aggregated) {
        if (agg.hits.length === 0) continue
        process.stdout.write(`  恢复 ${toRel(rootDir, mp)}:\n`)
        for (const h of agg.hits) {
          process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}\n`)
        }
      }
      for (const p of planIdempotent) process.stdout.write(`  已恢复跳过：${p.key}（${p.rel} 值已等于 original）\n`)
      for (const k of planSkipped) process.stdout.write(`  未链接跳过：${k}\n`)
      for (const c of planConflicts) process.stdout.write(`  冲突需确认：${c}——真实执行时将询问\n`)
      for (const m of planMissing) process.stdout.write(`  文件不存在警告：${m}\n`)
      const remainCount = (st?.links ? Object.keys(st.links).length : 0) - pendingDelete.length
      if (pendingDelete.length > 0) {
        if (remainCount === 0) {
          process.stdout.write(`  state：清空——last 记 ${JSON.stringify(Object.keys(st?.links ?? {}))} → 删 state 文件\n`)
        } else {
          for (const k of pendingDelete) process.stdout.write(`  state：删除 ${k}（剩余 ${remainCount} 条）\n`)
        }
        process.stdout.write(`  install：${buildInstallCommandLine(pm)}（workspace 根）\n`)
        process.stdout.write(`  复验：node_modules 实际指向（残留/缺失将 ${buildForceInstallCommandLine(pm)} 重建）\n`)
      }
      if (aggregated.size === 0 && pendingDelete.length === 0 && planConflicts.length === 0 && planMissing.length === 0 && planSkipped.length === 0) {
        process.stdout.write('  无待执行变更\n')
      }
      return 0
    }

    // E1 先恢复文件（零改写文件不写盘——byte 保真）
    for (const [mp, agg] of aggregated) {
      if (agg.changedCount === 0) continue
      writeTextFileAtomic(mp, agg.content)
    }

    // E2 install 恰一次（待删集非空——恢复/幂等跳过/用当前 三类覆盖）
    if (pendingDelete.length > 0) {
      await runInstall(rootDir, pm, UNLINK_RETRY_ADVICE)
    }

    // F 复验 + --force（恰一次重建 + 恰一次复验；--force 在删 state 之前）
    if (pendingDelete.length > 0) {
      const findings: VerifyFinding[] = []
      for (const [key, mps] of verifyManifests) {
        findings.push(...verifyResidue(rootDir, cfg, key, mps))
      }
      const bad = findings.filter((f) => f.status !== 'ok')
      if (bad.length > 0) {
        for (const f of bad) {
          process.stdout.write(`警告：node_modules ${f.status === 'residue' ? `残留（${f.note ?? '软链残留'}）` : '缺失'}：${f.nmRel}——${buildForceInstallCommandLine(pm)} 重建\n`)
        }
        await runForceInstall(rootDir, pm, UNLINK_RETRY_ADVICE)
        const recheck: VerifyFinding[] = []
        for (const [key, mps] of verifyManifests) {
          recheck.push(...verifyResidue(rootDir, cfg, key, mps))
        }
        for (const f of recheck) {
          if (f.status !== 'ok') {
            process.stderr.write(`警告：node_modules 复验未通过：${f.nmRel}（${f.status === 'residue' ? '残留' : '缺失'}）；lpm status（S8）可进一步诊断\n`)
          } else if (findings.some((b) => b.rel === f.rel && b.nmRel === f.nmRel)) {
            process.stdout.write(`已重建：${f.nmRel}\n`)
          }
        }
      } else {
        for (const f of findings) {
          if (f.note !== undefined) process.stdout.write(`复验注明：${f.nmRel}（${f.note}）\n`)
        }
      }
    }

    // G 删 state（install 成功后才到此处——崩溃顺序保证）+ last（先写后删——评审 P1-1）
    const beforeKeys = Object.keys(st?.links ?? {})
    const remaining: LinkState['links'] = {}
    for (const k of beforeKeys) {
      if (!pendingDelete.includes(k)) remaining[k] = (st?.links[k]) as LinkState['links'][string]
    }
    if (Object.keys(remaining).length === 0 && pendingDelete.length > 0) {
      await writeLast(rootDir, { version: 1, names: beforeKeys }) // 清空前完整集合
      await deleteState(rootDir)
    } else if (pendingDelete.length > 0) {
      await writeState(rootDir, { version: 1, links: remaining })
    }

    // I/J 完成提示（O4 镜像 + PRD 行 145）
    process.stdout.write(`恢复完成：${restoredKeyCount} 个 lib，${totalChanged} 处声明恢复：\n`)
    for (const [mp, agg] of aggregated) {
      if (agg.hits.length === 0) continue
      process.stdout.write(`  ${toRel(rootDir, mp)}:\n`)
      for (const h of agg.hits) {
        process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.original}\n`)
      }
    }
    const skippedTotal = planSkipped.length + planAbandoned.length + dedupSkipped + planIdempotent.length
    if (skippedTotal > 0) process.stdout.write(`  跳过合计：${skippedTotal} 处\n`)
    process.stdout.write('以上 package.json 已恢复原 range（多数场景与 git 基线一致；冲突选「用当前」的文件保留手动改动）；建议重启 dev server 使依赖变更生效。\n')
    return 0
  } catch (err) {
    if (err instanceof LinkCancelledError) {
      process.stderr.write('已取消\n')
      return 1
    }
    return reportError(err)
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run tests/unit/unlink-command.test.ts`
Expected: 全 PASS（迭代修复至绿；每轮修复遵守单文件一次 SearchReplace + tsc 分级检查）

- [ ] **Step 6: 全量回归 + 编译 + 面核对**

Run: `pnpm typecheck && pnpm test`；`git status --porcelain -uall`
Expected: unit 全绿（223 + T1 7 + T2 5 + T3 ≈25（UNL 22 + LKC 3）= ≈260）；改动面 = unlink.ts / unlink-command.test.ts / link-command.test.ts / link.ts（T3 Step 1 导出扩展）

---

### Task 4: cli 接线 + e2e + 文档回写

**Files:**
- Modify: `src/cli.ts`（unlink 特判分支）
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 describe）
- Modify: `docs/superpowers/specs/2026-09-27-s7-unlink-direct-design.md`（D 节补句——计划期修订 2）
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（§5 命令流 + 分层表注记——hunk 见 Step 3）
- Modify: `docs/superpowers/specs/2026-09-26-s6-link-direct-design.md`（§4.3 runInstall 签名注记 + §7.4 #4 补词 LinkTargetError（N-6））
- Modify: `src/core/linkcheck.ts` spec 注记落 spec 文件（N-4 空名豁免句——改 S6 spec，非代码）

**Interfaces:**
- Consumes: T3 `runUnlink(targets, options)`、`UnlinkOptions`
- Produces: `lpm unlink` 可执行命令（build 后 dist 生效）；e2e 4 用例

- [ ] **Step 1: cli.ts 接线**（link 特判分支之后插入——一次 SearchReplace）

```ts
    // S7：unlink 直通版接线（同 use/link 特判；description 不带计划后缀）
    if (meta.name === 'unlink') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--all', '取消全部已链接依赖')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { all?: boolean; dryRun?: boolean }) => {
          process.exitCode = await runUnlink(targets, options)
        })
      continue
    }
```

（import 区并入 `import { runUnlink } from './commands/unlink.js'`——与既有 import 合并同一次编辑。）

- [ ] **Step 2: e2e 追加**（cli.e2e.test.ts 尾部追加 describe；复用 runCli helper 与 makeProject 惯例——零真实 install 场景）

```ts
describe('lpm unlink e2e（S7 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-unlink-e2e-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => {
    while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true })
  })

  const WS_FILES = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': 'lpm-lib/lib' } }),
    'lpm-lib/package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../lpm-lib' } }),
  }
  const STATE_ONE = { version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }

  it('E2E-6 dry-run：计划输出恢复明细 + install/复验行 + 项目 byte 级零变化', async () => {
    const ws = makeProject({ ...WS_FILES, '.lpm/state.json': JSON.stringify(STATE_ONE) })
    const before = readFileSync(join(ws, 'apps/web/package.json'), 'utf8')
    const r = await runCli(['unlink', '--dry-run', '@t/lib'], ws)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('dry-run 执行计划')
    expect(r.stdout).toContain('恢复 apps/web/package.json')
    expect(r.stdout).toContain('dependencies.@t/lib：link:../lpm-lib → ^1.0.0')
    expect(r.stdout).toContain('install：pnpm install --no-frozen-lockfile')
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })

  it('E2E-7 未链接名字：跳过 exit 0（spawn 即非 TTY 不触发交互）', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['unlink', 'ghost'], ws)
    expect(r.exitCode).toBe(0)
  })

  it('E2E-8 --all 空 state：无已链接项 exit 0', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['unlink', '--all'], ws)
    expect(r.exitCode).toBe(0)
  })

  it('E2E-9 --all 与 targets 互斥：exit 1', async () => {
    const ws = makeProject({ ...WS_FILES, '.lpm/state.json': JSON.stringify(STATE_ONE) })
    const r = await runCli(['unlink', '--all', '@t/lib'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('互斥')
  })

  it('E2E-10 --help unlink 行无「（计划 S7）」后缀', async () => {
    const r = await runCli(['--help'], os.tmpdir())
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('恢复 registry 版本') // registry.ts unlink summary 实值
    expect(r.stdout).not.toContain('恢复 registry 版本（计划 S7）')
  })
})
```

（e2e 计数 +5 = 21。）

- [ ] **Step 3: 文档回写**（全部为文档编辑，逐字落位）

1. S7 spec `§4.4 D` 追加句（计划期修订 2）：「文件内无命中段（依赖已被手动移除）→ 视为幂等跳过（零改写，文件所在 key 照常进待删集）」
2. S7 spec `§7 e2e` 行同步实况：全链 git-diff 用例不进 e2e（零真实 install 惯例 + `@t/lib` 不可 registry 装回），由 unit mock（UNL-4/13/14）+ PRD §12 smoke 手测覆盖；e2e = dry-run/未链接/--all 空/互斥/help 5 例
3. S1 spec `§5` 命令调用流与分层表 `commands/*` 行注记：use/link/unlink 已实现（S3/S6/S7），其余 stub——hunk 措辞镜像 S6 回写先例
4. S6 spec `§4.3` runInstall 行注记：S7 起增加可选第三参 retryAdvice（缺省 link 向文案，既有调用零改动）；`§7.4 #4` 括号清单补词 LinkTargetError（N-6）；`§4.4 C4` 附近补一句「lib name 为空串时跳过 name-mismatch 检查（空名 lib 无法被依赖引用，D1/D7 自洽豁免）」（N-4）

- [ ] **Step 4: 构建与 e2e 验证**

Run: `pnpm build && pnpm test:e2e`
Expected: build success；e2e 21/21

- [ ] **Step 5: 全量回归 + 面核对**

Run: `pnpm typecheck && pnpm test`；`git status --porcelain -uall`
Expected: 全绿；改动面 = cli.ts / cli.e2e.test.ts / 三个 spec 文档

---

### Task 5: 全量终验

**Files:** 无代码改动（验证 + 账本记录）

**Interfaces:**
- Consumes: T1–T4 全部产出
- Produces: 验证证据（pnpm verify 四段 + 计数链 + 工作树核对）

- [ ] **Step 1: 四段全量**

Run: `pnpm verify`
Expected: exit 0——typecheck 0 + build success + unit 全绿（计数链见下表）+ e2e 21/21

- [ ] **Step 2: 计数链三方对照**

计数链预估（实况以 vitest 输出为准）：unit 223（S6 基线）+ T1 7（RDV 6 + LP 1）+ T2 5（T3-9…13）+ T3 ≈25（UNL 22 + LKC 3）= ≈260 / 17 文件；e2e 16 + 5 = 21。对照 spec §6 验收 1 与本表，偏差需在任务报告说明

- [ ] **Step 3: 工作树核对 + 交付清单**

Run: `git status --porcelain -uall`；`git log --oneline -3`
Expected: 改动面与 T1–T4 清单完全一致（预期：src/commands/unlink.ts 新增、src/commands/link.ts、src/core/rewriter.ts、src/core/install.ts、src/cli.ts、tests/unit/{rewriter,install,unlink-command,link-command}.test.ts、tests/e2e/cli.e2e.test.ts、docs/superpowers/specs/ 三份）；HEAD 仍 7d38504（零 commit——用户自行提交）

- [ ] **Step 4: 验收对照（spec §6 九条逐条）**

1 verify 全绿 ✓（Step 1）/ 2 三态自动化 ✓（UNL-4/5/6）/ 3 崩溃顺序与重跑收敛 ✓（UNL-13/14）/ 4 --all 拆至清空 last ✓（UNL-15/16）/ 5 复验 + force ✓（UNL-20/21/22）/ 6 dry-run 零副作用 ✓（UNL-18/19 + E2E-6）/ 7 依赖白名单 ✓（package.json 零改动——git status 核对）/ 8 回写义务 ✓（T4 Step 3）/ 9 dry-run 一致性 ✓（UNL-18 计划行 vs UNL-4 实际恢复同构断言——若 plan 期判定需独立 it 则补）

---

## 计划期修订记录（实施中追加）

| # | 修订 | 依据 |
|---|---|---|
| 1 | install.ts 新增 runForceInstall 导出（spec §4.3 漏列 force 执行体——F3 的 execa 落点定此） | spec F3 execa 细节 + 分层惯例（子进程归 core） |
| 2 | 文件内无命中段（依赖被手动移除）→ 幂等跳过 + key 照常进待删集；spec D 节 T4 回写补句 | spec D 节三态未覆盖「当前值不存在」形态（multi-lens 手法 4 补漏） |
| 3 | TTY select 冲突路径 unit 全覆盖——unlink-command.test.ts 镜像 link-command.test.ts 的 @clack/prompts mock 惯例（原降级预案取消） | link-command.test.ts 既有 clack mock 实证 |
| 4 | e2e 口径收敛：全链 git-diff 用例不进 e2e（零真实 install 惯例），spec §7 e2e 行 T4 回写同步 | S6 e2e 先例 + PRD §12 行 375 + fixture 依赖不可 registry 装回 |
| 5 | S6 留观补测 3 it（N-7/M-4：#22/#13/#20）由 T3 Step 2b 承载（spec 目标 8） | spec 目标 8 + S6 final-review §③ 分诊表 |
