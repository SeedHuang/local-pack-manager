# S11 登记管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实施本 plan。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 补齐注册表管理闭环——`lpm forget` 直通（名字/路径）+「管理注册…」子界面（forget 的交互化，集成进 link 无参数主列表）+ `lpm dir`（用户级 scanDirs 管理）。

**Architecture:** 新建 `src/commands/forget.ts`（直通 + 管理子界面，静态 import link.ts 的 `collectLinkCandidates`/`parsePathInput`）与 `src/commands/dir.ts`（纯用户级，只依赖 state）；link.ts 对 forget.ts 用**动态 import**（避免 `link ⇄ forget` 静态循环，unlink ⇄ status 既解先例）；`runLinkInteractive` 的 `cfg` 改为可重读（`let`）以在子界面删除后重扫时拿到新注册表。

**Tech Stack:** TS ESM + Node ≥22.12 + commander + @clack/prompts 1.8.1 + vitest；运行时依赖零新增。

**Spec:** `docs/superpowers/specs/2026-09-28-s11-registry-management-design.md`（用户终审通过，行为权威——本 plan 从 spec 论证，执行者两份都读）

## Global Constraints

- 禁止一切 Git 写操作（worktree/分支/commit/push），改动由用户自行 commit；任务末尾只做只读 `git status --porcelain -uall` 核对
- 终端 Windows PowerShell；skill 自带 bash 脚本不可用 → brief 载体 = 本 plan + `### Task N:` 标题锚定
- 相对导入一律带 `.js`；目录模块写 `<dir>/index.js`；node 内置模块具名导入
- 冻结面零改动：S1–S10 全部公共 API 签名不变；`runLink`/`runUnlink` 形参不变；`LinkOptions` 不扩字段；`LinkArgumentError` 构造器保持冻结签名；`collectLinkCandidates`/`parsePathInput`/`resolveTarget`/`readPresets`/`persistPresets` 等冻结导出**只消费不改**
- 编辑纪律：同一文件禁止并行 SearchReplace；import 与使用它的代码合并进同一次编辑；编辑后 `npx tsc --noEmit`（**禁用 GetDiagnostics**）；每任务收尾 `npx vitest run <本任务测试文件>` 全绿
- 单源口径：项目级配置一律 `writeProjectConfig`；用户级配置一律 `readUserConfig`/`writeUserConfig`；候选列表走 `collectLinkCandidates`；预设读取走 `readPresets`
- 每任务 reviewer 直读产出文件评审（Spec 对照 + 质量）；评审产物的 diff 用工具自身写文件（`git diff --no-index --output=<file>`），禁止 PowerShell `>` 重定向接原生命令输出
- 实现者禁止派生子代理；子代理同样禁止任何 git 写操作
- `lpm.config.json` 的 `libs` 删空**保留 `libs: {}`**（移除字段会让 `readProjectConfig` 抛 `LpmConfigParseError`——spec P1-1）
- dir 写路径测试一律 mock `node:os` 的 `homedir`（e2e helper 不隔离 HOME，dir 写路径 e2e 禁碰真实 `~/.lpm`）

## Preflight 扫描（任务对 × 共享接口/文件）

| 对 | 共享 | 产出 ↔ 消费 | 结论 |
|---|---|---|---|
| T1 | `src/commands/dir.ts` + `src/cli.ts`（dir 接线）+ `tests/unit/dir-command.test.ts` | `runDir`/`DirError` ↔ 测试 + cli | 同文件严格顺序；dir 不依赖其它新文件 ✓ |
| T2 → T3 | `src/commands/forget.ts` | T2 的 `resolveRegisteredNameByPath`/`resolveForgetKey`/`forgetDirect`/`ForgetError`/`reportError` ↔ T3 的 `runManageRegistry`/`runForget` | 同文件，**严格顺序**（T3 只追加）✓ |
| T2/T3 → T4 | `forget.ts` 导出 `runManageRegistry` | ↔ link.ts 动态 import + ctx 组装 | 签名一致 ✓；link 动态 import 无循环 |
| T4 | `src/commands/link.ts` | `pickLinkTargets` 返回升级 + `runLinkInteractive` `let cfg` + 管理分支 | 同文件相邻区域；**严格顺序** ✓ |
| T4 | `tests/unit/link-interactive.test.ts` | 既有 mock 补 `note` + 新增管理用例 | 同文件；**严格顺序** ✓ |
| T5 | `src/cli.ts` + `src/commands/unlink.ts` + `tests/e2e/cli.e2e.test.ts` | cli 接线 + 空态去注 + e2e 追加 | 同文件；**严格顺序** ✓ |

**关键顺序**：T1 → T2 → T3 → T4 → T5（串行，不可并行）。

---

## Task 1：`lpm dir`（dir.ts + cli 接线 + dir-command.test.ts）

**Files:**
- Create: `src/commands/dir.ts`
- Modify: `src/cli.ts`（dir 接线，从 stub 循环提出来）
- Test: `tests/unit/dir-command.test.ts`

**Interfaces:**
- Consumes: `src/state/index.ts` 的 `readUserConfig`/`writeUserConfig`/`LpmStateParseError`（S4 既有，零改动）；`@clack/prompts` 的 `multiselect`/`isCancel`
- Produces: `export class DirError extends Error`；`export async function runDir(args: readonly string[], _cwd?: string): Promise<number>`（分派：`[]`→交互；`['add', 路径]`/`['rm', 路径]`/`['ls']`；其它→用法错误；`_cwd` 前缀下划线：dir 纯用户级不定位 workspace，参数仅供 cli 位置一致，`noUnusedParameters` 合规）

- [ ] **Step 1: 写失败测试 `tests/unit/dir-command.test.ts`**

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), isCancel: vi.fn(() => false),
}))

import { multiselect, isCancel } from '@clack/prompts'
import { runDir } from '../../src/commands/dir.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-dir-home-'))
  dirs.push(home)
  osMock.home = home
  mkdirSync(join(home, '.lpm'), { recursive: true })
  return home
}
function readUserCfg(home: string): { version: number; scanDirs: unknown[] } {
  const p = join(home, '.lpm', 'config.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as { version: number; scanDirs: unknown[] } : { version: 1, scanDirs: [] }
}
function stubTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true })
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}

beforeEach(() => { osMock.home = ''; vi.clearAllMocks(); vi.mocked(isCancel).mockReturnValue(false) })

describe('lpm dir（S11）', () => {
  it('D-1 add：正常 → 写入 scanDirs', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const cap = captureOut()
    const code = await runDir(['add', scan])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toContain(scan)
    expect(cap.out.join('')).toContain(`已加入扫描目录：${scan}`)
  })

  it('D-2 add 去重：重复 add 不重复写', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    captureOut()
    expect(await runDir(['add', scan])).toBe(0)
    expect(await runDir(['add', scan])).toBe(0)
    expect(readUserCfg(home).scanDirs.filter((d) => d === scan)).toHaveLength(1)
  })

  it('D-3 add 校验：非绝对路径 → DirError + 零写盘', async () => {
    const home = makeHome()
    const cap = captureOut()
    const code = await runDir(['add', 'relative/path'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录必须是已存在的绝对路径')
    expect(existsSync(join(home, '.lpm', 'config.json'))).toBe(false)
  })

  it('D-4 add 校验：目录不存在 → DirError', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['add', join(tmpdir(), 'no-such-dir-xyz')])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录必须是已存在的绝对路径')
  })

  it('D-5 add 读-改-写保留未知字段', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [], future: 1 }), 'utf8')
    captureOut()
    expect(await runDir(['add', scan])).toBe(0)
    const cfg = JSON.parse(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')) as { future: number }
    expect(cfg.future).toBe(1)
  })

  it('D-6 rm：按值移除', async () => {
    const home = makeHome()
    const a = 'D:\\Seed\\libs'
    const b = 'D:\\Seed\\other'
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [a, b] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', a])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toEqual([b])
    expect(cap.out.join('')).toContain(`已移除扫描目录：${a}`)
  })

  it('D-7 rm 不在列表 → DirError + 列当前', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', 'D:\\Seed\\nope'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('扫描目录不在列表中')
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\libs'])
  })

  it('D-8 rm 空列表 → 专属文案', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['rm', 'D:\\Seed\\nope'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-9 ls：逐行列出', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 'D:\\Seed\\other'] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('D:\\Seed\\libs\nD:\\Seed\\other')
  })

  it('D-10 ls 空 → 提示 + exit 0', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-11 ls 非字符串元素 → 跳过 + 提示（脏配置降级）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 123] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('跳过无效的扫描目录项（非字符串）：123')
    expect(cap.out.join('')).toContain('D:\\Seed\\libs')
  })

  it('D-12 无参数非 TTY → 提示 + exit 1 + 零 clack 调用', async () => {
    makeHome()
    stubTty(false)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm dir add')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('D-13 无参数 TTY 交互：列出多选删 → 逐行提示 + 文件更新（不二次确认）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs', 'D:\\Seed\\other'] }), 'utf8')
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce(['D:\\Seed\\libs'] as never)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(0)
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\other'])
    expect(cap.out.join('')).toContain('已移除扫描目录：D:\\Seed\\libs')
  })

  it('D-14 无参数 TTY 空列表 → 提示 + exit 0', async () => {
    makeHome()
    stubTty(true)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何扫描目录')
  })

  it('D-15 无参数 TTY 空选中 → exit 1', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    stubTty(true)
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('未选择任何扫描目录')
  })

  it('D-16 无参数 TTY 取消 → 已取消 + exit 1 + 零写盘', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: ['D:\\Seed\\libs'] }), 'utf8')
    stubTty(true)
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    const code = await runDir([])
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('已取消')
    expect(readUserCfg(home).scanDirs).toEqual(['D:\\Seed\\libs'])
  })

  it('D-17 子命令非法 / 缺路径 / 多余参数 → 用法错误', async () => {
    makeHome()
    for (const args of [['bogus'], ['add'], ['rm'], ['add', 'a', 'b']]) {
      const cap = captureOut()
      const code = await runDir(args)
      expect(code).toBe(1)
      expect(cap.err.join('')).toContain('用法：lpm dir add')
    }
  })

  it('D-18 scanDirs 顶层非数组（脏配置）→ 透传 LpmStateParseError（不吞）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: 'oops' }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'])
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('scanDirs 应为数组')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/dir-command.test.ts`
Expected: 全部 FAIL——`Cannot find module '../../src/commands/dir.js'`

- [ ] **Step 3: 写实现 `src/commands/dir.ts`**

```ts
import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import * as clack from '@clack/prompts'
import { LpmStateParseError, readUserConfig, writeUserConfig } from '../state/index.js'

/** dir 相关错误（命令域；沿用「错误类归命令文件」先例） */
export class DirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirError'
  }
}

/** 命令级错误上报（与 link/unlink/preset 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [DirError, LpmStateParseError]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

const DIR_USAGE = 'lpm dir add <路径> | rm <路径> | ls'

/** `lpm dir add <路径>`：校验（绝对 + 存在目录，同 S9 addScanDir）→ 去重 → 读-改-写 */
async function runDirAdd(dir: string): Promise<number> {
  const trimmed = dir.trim()
  let ok = false
  try {
    ok = isAbsolute(trimmed) && existsSync(trimmed) && statSync(trimmed).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    throw new DirError(`扫描目录必须是已存在的绝对路径：${trimmed}。示例：D:\\Seed\\libs`)
  }
  const cur = await readUserConfig()
  if (!cur.scanDirs.includes(trimmed)) {
    await writeUserConfig({ ...cur, scanDirs: [...cur.scanDirs, trimmed] })
  }
  process.stdout.write(`已加入扫描目录：${trimmed}\n`)
  return 0
}

/** `lpm dir rm <路径>`：按值移除（空态与不在列表分别报错） */
async function runDirRm(dir: string): Promise<number> {
  const cur = await readUserConfig()
  if (cur.scanDirs.length === 0) {
    throw new DirError('当前没有任何扫描目录。可用 lpm dir add <路径> 添加')
  }
  if (!cur.scanDirs.includes(dir)) {
    throw new DirError(`扫描目录不在列表中：${dir}。可用 lpm dir ls 查看`)
  }
  await writeUserConfig({ ...cur, scanDirs: cur.scanDirs.filter((d) => d !== dir) })
  process.stdout.write(`已移除扫描目录：${dir}\n`)
  return 0
}

/** `lpm dir ls`：逐行列出（非字符串元素跳过 + 一行提示） */
async function runDirLs(): Promise<number> {
  const cur = await readUserConfig()
  for (const d of cur.scanDirs) {
    if (typeof d !== 'string') process.stdout.write(`跳过无效的扫描目录项（非字符串）：${String(d)}\n`)
  }
  const valid = cur.scanDirs.filter((d) => typeof d === 'string')
  if (valid.length === 0) {
    process.stdout.write('当前没有任何扫描目录。用 lpm dir add <路径> 添加\n')
    return 0
  }
  for (const d of valid) process.stdout.write(`${d}\n`)
  return 0
}

/** `lpm dir`（无参数，TTY）：列出多选删除——可逆操作不二次确认（unlink 先例） */
async function runDirInteractive(): Promise<number> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`当前不是交互终端；直通用法：${DIR_USAGE}\n`)
    return 1
  }
  const cur = await readUserConfig()
  for (const d of cur.scanDirs) {
    if (typeof d !== 'string') process.stdout.write(`跳过无效的扫描目录项（非字符串）：${String(d)}\n`)
  }
  const valid = cur.scanDirs.filter((d) => typeof d === 'string')
  if (valid.length === 0) {
    process.stdout.write('当前没有任何扫描目录。用 lpm dir add <路径> 添加\n')
    return 0
  }
  const picked = await clack.multiselect({
    message: '选择要移除的扫描目录（空格勾选，回车确认）',
    options: valid.map((d) => ({ value: d, label: d })),
    required: false,
  })
  if (clack.isCancel(picked)) { process.stdout.write('已取消\n'); return 1 }
  const chosen = picked as string[]
  if (chosen.length === 0) { process.stdout.write('未选择任何扫描目录\n'); return 1 }
  await writeUserConfig({ ...cur, scanDirs: cur.scanDirs.filter((d) => !chosen.includes(d)) })
  for (const d of chosen) process.stdout.write(`已移除扫描目录：${d}\n`)
  return 0
}

/** `lpm dir` 入口（分派在内部，便于单测）；`_cwd` 仅供 cli 位置一致，dir 纯用户级不定位 workspace */
export async function runDir(args: readonly string[], _cwd: string = process.cwd()): Promise<number> {
  try {
    if (args.length === 0) return await runDirInteractive()
    if (args[0] === 'add' && args.length === 2) return await runDirAdd(args[1] as string)
    if (args[0] === 'rm' && args.length === 2) return await runDirRm(args[1] as string)
    if (args[0] === 'ls' && args.length === 1) return await runDirLs()
    throw new DirError(`用法：${DIR_USAGE}`)
  } catch (err) {
    return reportError(err)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/dir-command.test.ts`
Expected: 全部 PASS（D-1…D-18，18 例）

- [ ] **Step 5: cli.ts 接线（dir 从 stub 循环提出来）**

在 `src/cli.ts` 的 `if (meta.name === 'preset')` 块之后、`program.command(meta.name)...` stub 循环之前插入：

```ts
    // S11：dir 接线（无参数 → 交互；add/rm/ls → 直通；分派在 runDir 内）
    if (meta.name === 'dir') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'add <路径> | rm <路径> | ls')
        .action(async (args: string[]) => {
          process.exitCode = await runDir(args)
        })
      continue
    }
```

并在文件顶部 import 行 `import { runPreset, runSave } from './commands/preset.js'` 之后新增：

```ts
import { runDir } from './commands/dir.js'
```

（同一文件只发一次 SearchReplace——把 import 与接线合并进两次独立编辑也可以，但**同一次编辑内完成 import 变更与代码变更**，见 Global Constraints 编辑纪律。）

- [ ] **Step 6: 编译 + 全量单测确认零回归**

Run: `npx tsc --noEmit`（预期 0 错误）→ `npx vitest run tests/unit/dir-command.test.ts`（18 passed）
Run: `git status --porcelain -uall`（只读核对工作树面 = 本任务新增 `src/commands/dir.ts`、`tests/unit/dir-command.test.ts`、`M src/cli.ts` + 文档）

---

## Task 2：`lpm forget` 直通（forget.ts 骨架 + 直通分支 + forget-command.test.ts 直通部分）

**Files:**
- Create: `src/commands/forget.ts`（本任务：`ForgetError`/`reportError`/`resolveRegisteredNameByPath`/`resolveForgetKey`/`forgetDirect` + `runForget` 直通分支；交互分支占位返回非 TTY 提示）
- Test: `tests/unit/forget-command.test.ts`（直通部分）

**Interfaces:**
- Consumes: `src/core/workspace.js` 的 `findWorkspaceRoot`/`WorkspaceNotFoundError`；`src/state/index.js` 的 `readProjectConfig`/`readState`/`writeProjectConfig`/`LpmConfigParseError`/`LpmStateParseError`；`src/commands/preset.js` 的 `readPresets`；`node:path` 的 `join`/`resolve`/`isAbsolute`
- Produces: `export class ForgetError`；`export async function runForget(targets: readonly string[], cwd?: string): Promise<number>`（本任务先实现 `targets` 非空直通分支与空数组非 TTY 分支，空数组 TTY 分支留 T3——**T3 前先占位**返回 1 并 TODO 注释，避免 T2 引未定义函数）；内部 `resolveRegisteredNameByPath`/`resolveForgetKey`/`forgetDirect`

- [ ] **Step 1: 写失败测试 `tests/unit/forget-command.test.ts`（直通部分）**

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})
vi.mock('@clack/prompts', () => ({
  multiselect: vi.fn(), text: vi.fn(), confirm: vi.fn(), note: vi.fn(), isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { runForget } from '../../src/commands/forget.js'

const dirs: string[] = []
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** workspace：apps/web 依赖 @t/lib；libs 由各用例 registerLib 显式写 */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-fg-'))
  dirs.push(ws)
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'ws-root', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'apps/web'\n",
    'pnpm-lock.yaml': '',
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
    ...files,
  }
  for (const [name, content] of Object.entries(base)) {
    const p = join(ws, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return ws
}
function registerLib(ws: string, key: string, rel: string): void {
  const p = join(ws, 'lpm.config.json')
  const cfg = JSON.parse(readFileSync(p, 'utf8')) as { libs: Record<string, string> }
  cfg.libs[key] = rel
  writeFileSync(p, JSON.stringify(cfg), 'utf8')
}
function readLibs(ws: string): Record<string, string> {
  return (JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { libs: Record<string, string> }).libs
}
function stubTty(v: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: v, configurable: true })
}
function captureOut(): { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err.push(String(c)); return true })
  return { out, err }
}
beforeEach(() => { vi.clearAllMocks() })

describe('lpm forget 直通（S11）', () => {
  it('FG-1 名字删除：正常 → libs 键消失、其它键保留、文案逐字', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(cap.out.join('')).toContain('已移除注册：@t/a，以后想再联调需重新带路径注册')
  })

  it('FG-2 路径删除：相对路径 → 反查命中', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const cap = captureOut()
    const code = await runForget(['libs/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-3 路径删除：目录不存在也能删（反查不 stat 的钉）', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/gone')   // libs/gone 目录不存在
    const code = await runForget(['libs/gone'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
  })

  it('FG-4 两路混用（名字 + 路径）→ 一并删', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const code = await runForget(['@t/a', 'libs/b'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
  })

  it('FG-5 多 target 去重（名字 + 指向同一注册的路径）→ 只提示一次', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const cap = captureOut()
    const code = await runForget(['@t/a', 'libs/a'], ws)
    expect(code).toBe(0)
    const lines = cap.out.join('').split('\n').filter((l) => l.includes('已移除注册：@t/a'))
    expect(lines).toHaveLength(1)
  })

  it('FG-6 已链接拦截：key ∈ state.links → 报错 + config byte 级零写盘', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }) })
    registerLib(ws, '@t/a', 'libs/a')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('先 lpm unlink @t/a')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-7 名字不存在 → 报错 + 列出可用 + 零写盘', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/nope'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('注册不存在：@t/nope')
    expect(cap.err.join('')).toContain('已注册：@t/a')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-8 无注册 → 专属文案', async () => {
    const ws = makeWs()
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('当前没有任何已注册的 lib')
  })

  it('FG-9 删空保留 libs: {}（回归钉：移除字段会让 readProjectConfig 抛错）', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { libs: Record<string, string> }
    expect(cfg.libs).toEqual({})
  })

  it('FG-10 预设提示不洗：key 在某预设 → 提示行出现 + 预设 byte 级不变', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' }, presets: { 前端: ['@t/a', '@t/b'] } }) })
    const beforeCfg = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('⚠️ @t/a 仍在预设 前端 里（已失效）')
    // 删除后 config 只应改 libs，presets 原样
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { presets: Record<string, string[]> }
    expect(cfg.presets['前端']).toEqual(['@t/a', '@t/b'])
    expect(beforeCfg).toContain('前端')
  })

  it('FG-11 预设提示按预设聚合：一个预设含多个被删 key → 只提示一次', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' }, presets: { 前端: ['@t/a', '@t/b'] } }) })
    const cap = captureOut()
    const code = await runForget(['@t/a', '@t/b'], ws)
    expect(code).toBe(0)
    const lines = cap.out.join('').split('\n').filter((l) => l.includes('仍在预设 前端 里'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('@t/a、@t/b')
  })

  it('FG-12 损坏注册值条目 → 可删（修脏路径）', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 123, '@t/b': 'libs/b' } }) })
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
  })

  it('FG-13 读-改-写：config 含未知字段 → 删除后未知字段保留', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' }, future: 1 }) })
    const code = await runForget(['@t/a'], ws)
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8')) as { future: number }
    expect(cfg.future).toBe(1)
  })

  it('FG-14 多 target 全校验通过才写盘：合法 + 已链接混合 → 整批停零写盘', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/b': { original: {}, linkedAt: 'x' } } }) })
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a', '@t/b'], ws)
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('先 lpm unlink @t/b')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('FG-15 无参数非 TTY → 提示 + exit 1 + 零 clack 调用', async () => {
    const ws = makeWs()
    stubTty(false)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('当前不是交互终端；直通用法：lpm forget <名字|路径>')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: 全部 FAIL——`Cannot find module '../../src/commands/forget.js'`

- [ ] **Step 3: 写实现 `src/commands/forget.ts`（直通部分）**

```ts
import { isAbsolute, join, resolve } from 'node:path'
import { findWorkspaceRoot, WorkspaceNotFoundError } from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  readProjectConfig,
  readState,
  writeProjectConfig,
} from '../state/index.js'
import type { ProjectLpmConfig } from '../state/types.js'
import { readPresets } from './preset.js'

/** forget 相关错误（命令域；沿用「错误类归命令文件」先例） */
export class ForgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgetError'
  }
}

/** 命令级错误上报（与 link/unlink/preset 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [ForgetError, WorkspaceNotFoundError, LpmConfigParseError, LpmStateParseError]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

const FORGET_USAGE = 'lpm forget <名字|路径>'

function registeredList(cfg: ProjectLpmConfig | null): string {
  const keys = Object.keys(cfg?.libs ?? {})
  return keys.length > 0 ? keys.join('、') : '（无）'
}

/** 路径 → 注册名反查（注册表视角，不 stat；spec §4.6）：命中 0 → []; 命中 ≥1 → 全部。
 *  win32 大小写不敏感（spec P2-9）：Windows FS 大小写不敏感但 JS 字符串比较敏感。 */
function resolveRegisteredNameByPath(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): string[] {
  const target = resolve(cwd, raw)
  const norm = process.platform === 'win32' ? target.toLowerCase() : target
  const out: string[] = []
  for (const [key, rel] of Object.entries(cfg?.libs ?? {})) {
    if (typeof rel !== 'string') continue // 注册值损坏：反查不出路径，但其 key 仍可被名字分支删
    const abs = join(rootDir, ...rel.split('/'))
    const absNorm = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (absNorm === norm) out.push(key)
  }
  return out
}

/** 单个 target 解析（名字分支查表 / 路径分支反查；spec §4.4）：返回命中的 key 数组 */
function resolveForgetKey(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): string[] {
  if (cfg !== null && Object.hasOwn(cfg.libs, raw)) return [raw]
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
  if (!looksLikePath) {
    throw new ForgetError(
      Object.keys(cfg?.libs ?? {}).length === 0
        ? '当前没有任何已注册的 lib。用 lpm link <路径> 注册'
        : `注册不存在：${raw}。已注册：${registeredList(cfg)}`,
    )
  }
  const hits = resolveRegisteredNameByPath(raw, cfg, rootDir, cwd)
  if (hits.length === 0) {
    throw new ForgetError(
      Object.keys(cfg?.libs ?? {}).length === 0
        ? '当前没有任何已注册的 lib。用 lpm link <路径> 注册'
        : `注册不存在：${raw}。已注册：${registeredList(cfg)}`,
    )
  }
  return hits
}

/** 预设提示（spec §4.4 要点 4，按预设聚合、不洗）——直通与子界面共用 */
function printPresetHints(cfg: ProjectLpmConfig | null, deleted: ReadonlySet<string>): void {
  const view = readPresets(cfg)
  for (const [presetName, members] of Object.entries(view.entries)) {
    const hit = members.filter((m) => deleted.has(m))
    if (hit.length > 0) {
      process.stdout.write(
        `⚠️ ${hit.join('、')} 仍在预设 ${presetName} 里（已失效）——lpm link --preset 会整批报错；可 lpm preset rm ${presetName} 删除该预设\n`,
      )
    }
  }
}

/** 直通删除（spec §4.4）：先全部校验通过再一次性写盘；删空保留 libs: {} */
async function forgetDirect(targets: readonly string[], rootDir: string, cwd: string): Promise<number> {
  const cfg = await readProjectConfig(rootDir)
  const st = await readState(rootDir)
  // 1. 解析 + 去重（Set 化，spec §8 自决 9）
  const keys: string[] = []
  const seen = new Set<string>()
  for (const raw of targets) {
    for (const key of resolveForgetKey(raw, cfg, rootDir, cwd)) {
      if (!seen.has(key)) { seen.add(key); keys.push(key) }
    }
  }
  // 2. 已链接拦截（整批停；drift 也算已链接——state 有条目即拦）
  for (const key of keys) {
    if (Object.hasOwn(st?.links ?? {}, key)) {
      throw new ForgetError(`${key} 当前已链接。先 lpm unlink ${key} 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档`)
    }
  }
  // 3. 写盘（删空保留 libs: {}——移除字段会让 readProjectConfig 抛错）
  const next: Record<string, string> = { ...(cfg?.libs ?? {}) }
  for (const key of keys) delete next[key]
  await writeProjectConfig(rootDir, { ...(cfg ?? { version: 1, libs: {} }), libs: next })
  // 4. 成功提示（在前）→ 预设提示（在后）
  for (const key of keys) process.stdout.write(`已移除注册：${key}，以后想再联调需重新带路径注册\n`)
  printPresetHints(cfg, seen)
  return 0
}

/** `lpm forget` 入口：[] → 非 TTY 提示 / TTY 进子界面（T3 实现）；[targets...] → 直通 */
export async function runForget(targets: readonly string[], cwd: string = process.cwd()): Promise<number> {
  try {
    if (targets.length === 0) {
      if (process.stdin.isTTY !== true) {
        process.stdout.write(`当前不是交互终端；直通用法：${FORGET_USAGE}\n`)
        return 1
      }
      // TODO(S11 T3)：runManageRegistry 交互分支在 Task 3 实现
      throw new ForgetError('交互子界面待 Task 3 上线')
    }
    const rootDir = await findWorkspaceRoot(cwd)
    return await forgetDirect(targets, rootDir, cwd)
  } catch (err) {
    return reportError(err)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: FG-1…FG-15 全 PASS（**注意 FG-15 无参数非 TTY 直接走非 TTY 分支，不经 TODO 分支**）

- [ ] **Step 5: 编译 + 回归**

Run: `npx tsc --noEmit`（预期 0 错误）→ `npx vitest run tests/unit`（既有 26 文件全部仍绿——直通路径零行为变化）
Run: `git status --porcelain -uall`（只读核对）

---

## Task 3：`lpm forget` 管理子界面（runManageRegistry + 无参数 TTY 分支）

**Files:**
- Modify: `src/commands/forget.ts`（追加 `runManageRegistry`；`runForget` 的 TTY 分支替换 TODO）
- Test: `tests/unit/forget-command.test.ts`（追加交互 describe）

**Interfaces:**
- Consumes: T2 的 `resolveRegisteredNameByPath`/`forgetDirect` 已就位；`src/commands/link.js` 的 `collectLinkCandidates`/`parsePathInput`（**冻结导出，静态 import**）；`src/core/workspace.js` 的 `loadWorkspace`/`Workspace` 类型；`@clack/prompts` 的 `note`/`multiselect`/`text`/`confirm`/`isCancel`
- Produces: `export interface ManageRegistryCtx { rootDir: string; cwd: string; ws: Workspace; cfg: ProjectLpmConfig | null; st: LinkState | null }`；`export async function runManageRegistry(ctx: ManageRegistryCtx): Promise<'back'>`（spec §4.3——ctx **不含 scanDirs**，内部 `readUserConfig()` 现读，P1-7）

- [ ] **Step 1: 追加失败测试（交互 describe）**

在 `tests/unit/forget-command.test.ts` 追加：

```ts
import { loadWorkspace } from '../../src/core/workspace.js'   // 追加 import（与 runForget 同次编辑合并）
import { multiselect, text, confirm, note, isCancel } from '@clack/prompts'
```

（把上面的 import 合并进 Step 1 的既有 import 区，避免同文件并行编辑。）

```ts
describe('lpm forget 交互（S11）', () => {
  async function setupInteractive(files: Record<string, string> = {}): Promise<{ ws: string; home: string }> {
    stubTty(true)
    const home = mkdtempSync(join(tmpdir(), 'lpm-fg-home-'))
    dirs.push(home)
    osMock.home = home
    mkdirSync(join(home, '.lpm'), { recursive: true })
    const ws = makeWs(files)
    return { ws, home }
  }

  it('FG-16 子界面：多选删 → 二次确认 → 文件更新 + 逐行提示', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(note).toHaveBeenCalled()
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-17 子界面：[已链接] 项勾选 → 剔除提示、其余照常', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a', '@t/b': 'libs/b' } }), '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a', '@t/b'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })   // 已链接的 @t/a 被剔除，@t/b 被删
    expect(cap.out.join('')).toContain('⚠️ @t/a 当前已链接。先 lpm unlink @t/a')
    expect(cap.out.join('')).toContain('已移除注册：@t/b')
  })

  it('FG-18 子界面：按路径删除 → 命中并入', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__forget_path__'] as never)
    vi.mocked(text).mockResolvedValueOnce('libs/a' as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({})
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })

  it('FG-19 子界面：按路径删除 → 未命中 → 提示不并入', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['\u0000__forget_path__'] as never)
    vi.mocked(text).mockResolvedValueOnce('libs/nope' as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('未找到与 libs/nope 匹配的已注册 lib')
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })   // 未命中 → 删除集合空 → 不写盘
  })

  it('FG-20 子界面：二次确认答否 → 已取消 + 零写盘', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(false as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('已取消')
    expect(readLibs(ws)).toEqual({ '@t/a': 'libs/a' })
  })

  it('FG-21 子界面：空删除集合 → 未选择任何注册 + 不弹二次确认', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('未选择任何注册')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('FG-22 子界面：取消 → 已取消 + 返回', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 'libs/a' } }) })
    vi.mocked(isCancel).mockReturnValueOnce(true)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('已取消')
  })

  it('FG-23 子界面空态（无注册）→ 提示 + 返回 0 + 不弹菜单', async () => {
    const { ws } = await setupInteractive()
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('当前没有任何已注册的 lib')
    expect(multiselect).not.toHaveBeenCalled()
  })

  it('FG-24 子界面：[注册值损坏] 项可删（修脏路径）', async () => {
    const { ws } = await setupInteractive({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/a': 123, '@t/b': 'libs/b' } }) })
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)
    vi.mocked(confirm).mockResolvedValueOnce(true as never)
    const cap = captureOut()
    const code = await runForget([], ws)
    expect(code).toBe(0)
    expect(readLibs(ws)).toEqual({ '@t/b': 'libs/b' })
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: FG-16…FG-24 FAIL——`runForget` TTY 分支抛「交互子界面待 Task 3 上线」

- [ ] **Step 3: 实现 `runManageRegistry` + 替换 `runForget` TTY 分支**

追加 import（与实现代码合并进**同一次**编辑——import 变更与代码变更一次 SearchReplace）：

```ts
import * as clack from '@clack/prompts'
import { loadWorkspace, type Workspace } from '../core/workspace.js'
import type { LinkState } from '../state/types.js'
import { readUserConfig } from '../state/index.js'   // 追加到既有 state import
import { collectLinkCandidates, parsePathInput } from './link.js'
```

新增：

```ts
export interface ManageRegistryCtx {
  rootDir: string
  cwd: string
  ws: Workspace
  cfg: ProjectLpmConfig | null
  st: LinkState | null
}

/** 「按路径删除…」虚拟项哨兵（NUL 前缀，沿用 OTHER_OPTION / S10 哨兵惯例；包名不可能含 NUL） */
const FORGET_PATH_OPTION = '\u0000__forget_path__'

/** 「管理注册…」子界面（forget 的交互化；spec §4.5）。正常流程一律返回 'back'。
 *  注：ctx 不含 scanDirs——内部 readUserConfig() 现读（P1-7）；子界面只用 registered 部分。 */
export async function runManageRegistry(ctx: ManageRegistryCtx): Promise<'back'> {
  const { scanDirs } = await readUserConfig()
  const cand = await collectLinkCandidates(ctx.rootDir, ctx.ws, ctx.cfg, ctx.st, scanDirs)
  if (cand.registered.length === 0) {
    process.stdout.write('当前没有任何已注册的 lib。用 lpm link <路径> 注册\n')
    return 'back'
  }
  // 减法心智隔离（spec §4.5）：标题与视觉与主列表明显区分
  clack.note('⚠️ 注册管理（减法操作）：删除注册不会取消任何链接；已链接的库请先 lpm unlink', '注册管理')
  const options = cand.registered.map((c) => ({
    value: c.key,
    label: c.linked ? `${c.key}  [已链接]` : c.cfgIntact ? c.key : `${c.key}  [注册值损坏]`,
    hint: c.linked ? '先 lpm unlink，或改用 lpm unlink' : c.cfgIntact ? c.rel : '修正 lpm.config.json 或删除（修脏路径）',
  }))
  options.push({ value: FORGET_PATH_OPTION, label: '按路径删除…（手输路径）', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' })
  const picked = await clack.multiselect({ message: '选择要删除的注册（空格勾选，回车确认）', options, required: false })
  if (clack.isCancel(picked)) { process.stdout.write('已取消\n'); return 'back' }
  const chosen = picked as string[]
  // 4a. 已链接项剔除 + 提示（绝不悄悄既拆线又删档）
  const deleteKeys = new Set<string>()
  for (const key of chosen) {
    if (key === FORGET_PATH_OPTION) continue
    const item = cand.registered.find((c) => c.key === key)
    if (item?.linked) {
      process.stdout.write(`⚠️ ${key} 当前已链接。先 lpm unlink ${key}，或改用 lpm unlink\n`)
      continue
    }
    deleteKeys.add(key)
  }
  // 4b. 按路径删除…（parsePathInput 格式引导同「其他…」；3 次重试镜像 promptPaths）
  if (chosen.includes(FORGET_PATH_OPTION)) {
    for (let i = 0; i < 3; i++) {
      const inp = await clack.text({ message: '输入要删除的路径（多个用空格分隔，含空格加引号）' })
      if (clack.isCancel(inp)) { process.stdout.write('已取消\n'); return 'back' }
      try {
        const raws = parsePathInput(String(inp))
        for (const raw of raws) {
          const hits = resolveRegisteredNameByPath(raw, ctx.cfg, ctx.rootDir, ctx.cwd)
          if (hits.length === 0) {
            process.stdout.write(`未找到与 ${raw} 匹配的已注册 lib。可用 lpm link <路径> 注册\n`)
            continue
          }
          for (const key of hits) {
            const item = cand.registered.find((c) => c.key === key)
            if (item?.linked) {
              process.stdout.write(`⚠️ ${key} 当前已链接。先 lpm unlink ${key}，或改用 lpm unlink\n`)
            } else {
              deleteKeys.add(key)
            }
          }
        }
        break
      } catch (err) {
        process.stderr.write(`${(err as Error).message}。请用绝对路径或相对路径；多个路径用空格分隔，含空格请加引号\n`)
      }
    }
  }
  // 5. 空删除集合（不弹二次确认）
  if (deleteKeys.size === 0) { process.stdout.write('未选择任何注册\n'); return 'back' }
  // 6. 二次确认（有后果操作，PRD §8.2）
  const ok = await clack.confirm({
    message: `删除这 ${deleteKeys.size} 个注册？（删除后需重新带路径注册）`,
    initialValue: false,
  })
  if (clack.isCancel(ok) || ok !== true) { process.stdout.write('已取消\n'); return 'back' }
  // 7. 执行删除（删空保留 libs: {}）+ 8. 成功提示 + 9. 预设提示
  const next: Record<string, string> = { ...(ctx.cfg?.libs ?? {}) }
  for (const key of deleteKeys) delete next[key]
  await writeProjectConfig(ctx.rootDir, { ...(ctx.cfg ?? { version: 1, libs: {} }), libs: next })
  for (const key of deleteKeys) process.stdout.write(`已移除注册：${key}，以后想再联调需重新带路径注册\n`)
  printPresetHints(ctx.cfg, deleteKeys)
  return 'back'
}
```

把 `runForget` 的空数组 TTY 分支替换为：

```ts
    if (targets.length === 0) {
      if (process.stdin.isTTY !== true) {
        process.stdout.write(`当前不是交互终端；直通用法：${FORGET_USAGE}\n`)
        return 1
      }
      const rootDir = await findWorkspaceRoot(cwd)
      const ws = await loadWorkspace(rootDir)   // collectLinkCandidates 必需（spec P1-6）
      const cfg = await readProjectConfig(rootDir)
      const st = await readState(rootDir)
      await runManageRegistry({ rootDir, cwd, ws, cfg, st })
      return 0
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: FG-1…FG-24 全 PASS（24 例）

- [ ] **Step 5: 编译 + 回归**

Run: `npx tsc --noEmit`（预期 0 错误——注意 `forget.ts` 静态 import `link.ts`，link 未改、无循环）
Run: `npx vitest run tests/unit`（既有 26 文件仍全绿）
Run: `git status --porcelain -uall`（只读核对）

---

## Task 4：link.ts 对接（pickLinkTargets 升级 + 「管理注册…」 + cfg 重读）

**Files:**
- Modify: `src/commands/link.ts`（`pickLinkTargets` 返回值升级 + 管理哨兵项；`runLinkInteractive` 的 `cfg` 改 `let` + manage 分支）
- Test: `tests/unit/link-interactive.test.ts`（既有 mock 补 `note` + 新增管理用例）

**Interfaces:**
- Consumes: T3 的 `runManageRegistry`（`forget.ts` 导出）——本任务用**动态 import**（`await import('./forget.js')`，避免 `link ⇄ forget` 静态循环）；既有 `collectLinkCandidates`/`pickLinkTargets`/`runPlanAndExecute`（本文件内）
- Produces: `pickLinkTargets` 返回升级为 `{ kind: 'link'; targets: string[]; collectionLevel: boolean } | { kind: 'manage' } | typeof CANCELLED`（spec §4.3，**未退回 string[]**）；`runLinkInteractive` 的 manage 分支（spec P1-5：manage 返回后重读 `cfg` 再 continue）

- [ ] **Step 1: 改既有测试 mock + 追加失败测试**

先在 `tests/unit/link-interactive.test.ts` 顶部 mock（第 11-13 行）补 `note` 与 `multiselect`（**两个都要**——子界面真跑时会调 `clack.note` 与 `clack.multiselect`，缺了会 `is not a function`）：

```ts
vi.mock('@clack/prompts', () => ({
  select: vi.fn(), groupMultiselect: vi.fn(), confirm: vi.fn(), text: vi.fn(), note: vi.fn(), multiselect: vi.fn(), isCancel: vi.fn(() => false),
}))
```

并把既有 `import { select, groupMultiselect, confirm, text, isCancel } from '@clack/prompts'` 行改为（加 `note`、`multiselect`）：

```ts
import { select, groupMultiselect, confirm, text, note, multiselect, isCancel } from '@clack/prompts'
```

追加用例（文件末尾，新的 `describe('link 主列表「管理注册…」（S11）', ...)`）：

```ts
describe('link 主列表「管理注册…」（S11）', () => {
  it('LI-S11-1：registered > 0 时「管理注册…」出现在「其他…」之后', async () => {
    const lib = makeLib()
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect).mockResolvedValueOnce(['\u0000__manage__'] as never)
    vi.mocked(isCancel).mockReturnValueOnce(true)   // 第一轮即取消 → 不进子界面（零副作用可断言 options）
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    const groups = vi.mocked(groupMultiselect).mock.calls[0]?.[0] as { options: Record<string, unknown[]> }
    const keys = Object.keys(groups.options)
    expect(keys).toContain('管理')
    expect(keys.indexOf('管理')).toBeGreaterThan(keys.indexOf('其他'))
    expect(note).not.toHaveBeenCalled()   // 未真正进子界面
  })

  it('LI-S11-2：勾选「管理注册…」→ 进入子界面 → 完成后重扫重渲染', async () => {
    const lib = makeLib()
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect)
      .mockResolvedValueOnce(['\u0000__manage__'] as never)   // 第一轮：进管理
      .mockResolvedValueOnce([] as never)                     // 第二轮：子界面返回后重扫，主列表空选
    vi.mocked(multiselect).mockResolvedValueOnce([] as never) // 子界面空删除集合 → 返回 'back'
    vi.mocked(isCancel).mockReturnValue(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)                                   // 第二轮空选 → 未选择任何库
    expect(groupMultiselect).toHaveBeenCalledTimes(2)      // 子界面完成后确实重扫重渲染
    expect(cap.out.join('')).toContain('未选择任何注册')     // 子界面确实跑过（空删除集合提示）
  })

  it('LI-S11-3：子界面删除注册后重扫拿到新注册表（钉 cfg 重读，spec P1-5）', async () => {
    const libA = makeLib('@t/a')
    const libB = makeLib('@t/b')
    const ws = makeWs()
    registerLib(ws, '@t/a', libA)
    registerLib(ws, '@t/b', libB)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect)
      .mockResolvedValueOnce(['\u0000__manage__'] as never)   // 第一轮：进管理
      .mockResolvedValueOnce([] as never)                     // 第二轮：主列表空选 → 未选择任何库
    vi.mocked(multiselect).mockResolvedValueOnce(['@t/a'] as never)   // 子界面多选删 @t/a
    vi.mocked(confirm).mockResolvedValueOnce(true as never)           // 子界面二次确认
    vi.mocked(isCancel).mockReturnValue(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).toContain('已移除注册：@t/a')
    // 钉：第二轮 collectLinkCandidates 拿到的 registered 不含 @t/a
    // （若实现沿用 preflight 旧 cfg，@t/a 仍会出现在第二轮主列表——断言必红）
    const groups2 = vi.mocked(groupMultiselect).mock.calls[1]?.[0] as { options: Record<string, Array<{ value: string }>> }
    const allValues = Object.values(groups2.options).flat().map((o) => o.value)
    expect(allValues).not.toContain('@t/a')
    expect(allValues).toContain('@t/b')
  })

  it('LI-S11-4：勾选「管理注册…」+ 其它项 → 忽略其它项（只进管理，不混入链接意图）', async () => {
    const lib = makeLib()
    const ws = makeWs()
    registerLib(ws, '@t/lib', lib)
    stubTty(true); makeHome()
    vi.mocked(groupMultiselect)
      .mockResolvedValueOnce(['\u0000__manage__', '@t/lib'] as never)   // 同时勾了链接项 + 管理项
      .mockResolvedValueOnce([] as never)
    vi.mocked(multiselect).mockResolvedValueOnce([] as never)   // 子界面空删除集合
    vi.mocked(isCancel).mockReturnValue(false)
    const cap = captureOut()
    const code = await runLink([], {}, ws)
    expect(code).toBe(1)
    expect(cap.out.join('')).not.toContain('执行计划预览：')   // 未进入链接执行管线
    expect(confirm).not.toHaveBeenCalled()                    // 子界面空删除集合不弹二次确认
  })

  it('LI-S11-5：registered === 0 时走空态向导（主列表与「管理注册…」均不出现）', async () => {
    const ws = makeWs()   // libs 为空
    stubTty(true); makeHome()
    vi.mocked(select).mockResolvedValueOnce('quit' as never)
    const code = await runLink([], {}, ws)
    expect(code).toBe(0)
    expect(groupMultiselect).not.toHaveBeenCalled()   // 主列表（含管理项）根本没渲染
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/link-interactive.test.ts`
Expected: LI-S11-1…5 FAIL（当前无「管理」组、无 kind 分支），且既有用例可能因 mock 缺 `note` 报错（若进子界面）——mock 先补上

- [ ] **Step 3: 实现 link.ts 对接**

在 `src/commands/link.ts` 的哨兵区（`ALL_REGISTERED`/`LAST_LINKED` 旁）追加：

```ts
/** S11「管理注册…」虚拟项哨兵（NUL 前缀，包名不可能含 NUL——沿用既有哨兵惯例） */
const MANAGE_OPTION = '\u0000__manage__'
```

在 `pickLinkTargets` 的「其他…」组之后追加「管理」组（**在「其他…」之后**，spec §4.5）：

```ts
  groups['其他'] = [{ value: OTHER_OPTION, label: '其他…（手输路径）', hint: '绝对 / 相对 / 多个用空格分隔 / 含空格加引号' }]
  // S11「管理注册…」：减法操作入口，在「其他…」之后；无注册时隐藏（spec §4.5 / §8 自决 5）
  if (cand.registered.length > 0) {
    groups['管理'] = [{ value: MANAGE_OPTION, label: '管理注册…', hint: '删除 lib 注册（已链接的请先 unlink）' }]
  }
```

在 `pickLinkTargets` 的提交后处理开头（拿到 `pickedArr` 之后、`collectionLevel` 计算之前）插入：

```ts
  // S11：勾选含「管理注册…」→ 转向管理（忽略其它勾选项；管理是流程转向，不混入链接意图——spec P1-2）
  if (pickedArr.includes(MANAGE_OPTION)) return { kind: 'manage' }
```

把返回值改为联合类型（函数返回类型 + 两个 return）：

```ts
async function pickLinkTargets(
  cand: { registered: LinkCandidate[]; discovered: DiscoveredLib[] },
  lastNames: readonly string[],
): Promise<{ kind: 'link'; targets: string[]; collectionLevel: boolean } | { kind: 'manage' } | typeof CANCELLED> {
```
```ts
  return { kind: 'link', targets: values, collectionLevel }
```

改 `runLinkInteractive`：`cfg` 由 preflight 解构的 const 改为可重读 `let`，manage 分支重读后 continue：

```ts
  try {
    const pre = await linkPreflight(cwd)
    const { rootDir, ws, pm } = pre
    let cfg = pre.cfg                                   // S11：必须可重读（子界面删除会写盘 lpm.config.json——spec P1-5）
    traceRoot = rootDir
    tracePm = pm
    const st = await readState(rootDir)
    const lastNames = (await readLast(rootDir))?.names ?? []
    for (;;) {
      const { scanDirs } = await readUserConfig()
      const cand = await collectLinkCandidates(rootDir, ws, cfg, st, scanDirs)
      if (cand.registered.length > 0 || cand.discovered.length > 0) {
        for (const n of cand.scanNotes) process.stdout.write(`${n}\n`)
        const picked = await pickLinkTargets(cand, lastNames)
        if (picked === CANCELLED) { process.stdout.write('已取消\n'); return 1 }
        if (picked.kind === 'manage') {
          // S11：进入注册管理子界面（动态 import 规避 link ⇄ forget 静态循环）；返回后重读 cfg 再重扫
          const { runManageRegistry } = await import('./forget.js')
          await runManageRegistry({ rootDir, cwd, ws, cfg, st })
          cfg = await readProjectConfig(rootDir)   // ★ 子界面已删注册——重读，否则 collectLinkCandidates 用旧 cfg（spec P1-5）
          continue
        }
        if (picked.targets.length === 0) { process.stdout.write('未选择任何库\n'); return 1 }
        return await runPlanAndExecute(picked.targets, { opts, rootDir, cwd, ws, cfg, pm, st, traceChanges, traceInstalls }, picked.collectionLevel)
      }
      // 空态向导分支（S9 现状，一行不改）……
    }
  } catch (err) {
```

> 注意：`pickLinkTargets` 返回联合类型后，`picked.targets` 只有在 `kind === 'link'` 分支才可访问——TS 的 discriminated union 收窄由 `if (picked.kind === 'manage') {...continue}` 保证（continue 之后 TS 知道 `kind === 'link'`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/link-interactive.test.ts`
Expected: 既有 29 例 + LI-S11-1…5 全 PASS（34 例）；`pickLinkTargets` 形态变化不破坏既有（既有 mock 返回值无 MANAGE_OPTION → 走 `{ kind: 'link' }`）

- [ ] **Step 5: 编译 + 回归**

Run: `npx tsc --noEmit`（预期 0 错误）
Run: `npx vitest run tests/unit`（全部 26 文件 + 新增的 dir/forget 全绿）
Run: `git status --porcelain -uall`（只读核对）

---

## Task 5：cli 接线 + unlink 空态 + e2e + 文档回写 + 终态验证

**Files:**
- Modify: `src/cli.ts`（forget 接线）
- Modify: `src/commands/unlink.ts`（空态三去向的 forget 行去掉「（待 S11 上线）」）
- Modify: `tests/e2e/cli.e2e.test.ts`（追加 5 例）
- Docs: 回写清单（spec §7 1–7 项）

**Interfaces:**
- Consumes: T1–T4 的 `runDir`/`runForget`；`src/commands/registry.ts` 核对（forget/dir 接线后 stub 循环不再到达它们——`plannedSpec` 字段保留无害，**registry.ts 无需代码改动**，仅核对）
- Produces: 全命令可经 cli 调用；e2e 证据；文档声明面同步

- [ ] **Step 1: cli.ts 接线（forget）**

在 `src/cli.ts` 的 dir 块（T1 已加）之后插入：

```ts
    // S11：forget 接线（无参数 → 交互；[targets...] → 直通删除）
    if (meta.name === 'forget') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .action(async (targets: string[]) => {
          process.exitCode = await runForget(targets)
        })
      continue
    }
```

并在顶部 import（`import { runDir } from './commands/dir.js'` 附近）追加：

```ts
import { runForget } from './commands/forget.js'
```

（import 与接线合并进同一次编辑。）

- [ ] **Step 2: unlink.ts 空态去注（含测试断言同步——R1-2）**

把 `src/commands/unlink.ts` 第 617 行：

```ts
      process.stdout.write('  lpm forget  移除 lib 注册（待 S11 上线）\n')
```

改为：

```ts
      process.stdout.write('  lpm forget  移除 lib 注册\n')
```

**同步**：`tests/unit/unlink-interactive.test.ts` 的 UI-8 用例（断言 unlink 空态三去向输出）若含「（待 S11 上线）」字样，一并去掉——否则 `pnpm verify` 会 1 failed（实现期实测 R1-2）。

- [ ] **Step 3: 追加 e2e（`tests/e2e/cli.e2e.test.ts`）**

在文件末尾追加（复用既有 `runCli` 与 `mkdtempSync` 模式；forget 需真实 workspace fixture——判定位置在 findWorkspaceRoot 之后；dir 纯用户级但**不写真实 `~/.lpm`**，只测不写盘的面）：

```ts
describe('lpm forget e2e（S11）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-e2e-forget-'))
    made.push(dir)
    const full: Record<string, string> = { 'package.json': JSON.stringify({ name: 'proj' }), ...files }
    for (const [name, content] of Object.entries(full)) {
      // R1-1：`.lpm/state.json` 等嵌套路径需先建中间目录（S6/S7 fixture 惯例）
      const p = join(dir, name)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, content, 'utf8')
    }
    return dir
  }
  afterEach(() => { while (made.length > 0) rmSync(made.pop() as string, { recursive: true, force: true }) })

  it('E2E-S11-1：forget 非 TTY 无参数 → exit 1 + 提示 + 无菜单残片', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }) })
    const r = await runCli(['forget'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm forget <名字|路径>')
    expect(r.stdout).not.toContain('已移除注册')
  })

  it('E2E-S11-2：forget 不存在 → exit 1 + 注册不存在', async () => {
    const dir = makeProject({ 'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }) })
    const r = await runCli(['forget', 'nope'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('注册不存在：nope')
  })

  it('E2E-S11-3：forget 已链接 → exit 1 + 先 unlink 提示', async () => {
    const dir = makeProject({
      'lpm.config.json': JSON.stringify({ version: 1, libs: { '@t/a': 'libs/a' } }),
      '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }),
    })
    const r = await runCli(['forget', '@t/a'], dir)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('先 lpm unlink @t/a')
  })
})

describe('lpm dir e2e（S11）', () => {
  it('E2E-S11-4：dir 非 TTY 无参数 → exit 1 + 提示 + 无菜单残片（不写真实 ~/.lpm）', async () => {
    const r = await runCli(['dir'])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('当前不是交互终端；直通用法：lpm dir add <路径>')
    expect(r.stdout).not.toContain('已移除扫描目录')
  })

  it('E2E-S11-5：dir 非法子命令 → exit 1 + 用法串（不写盘）', async () => {
    const r = await runCli(['dir', 'bogus'])
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('用法：lpm dir add')
  })
})
```

- [ ] **Step 4: 跑 e2e + 全量 verify**

Run: `npx vitest run tests/e2e`
Expected: 既有 33 例 + E2E-S11-1…5 全 PASS（38 例）
Run: `pnpm verify`
Expected: exit 0 = typecheck 0 + build 成功 + unit（26 + dir18 + forget24 + link-interactive 扩展）+ e2e 38 例

- [ ] **Step 5: 文档回写（「回头扫一遍声明它的地方」——用户全局规则，与实施同波完成）**

逐条执行 spec §7 回写清单：

1. `src/commands/unlink.ts` 空态三去向 forget 行去注（已在本任务 Step 2 完成）
2. `docs/superpowers/specs/2026-09-28-s9-interactive-design.md` §4.7 空态 forget 行「（待 S11 上线）」→ 更新为已上线；§1.2 非目标表「注册管理 → S11」→ 标注已落地；§4.5 A6 表 + §3.1 A8 + §6 测试清单补「管理注册…」项（顺序：快捷 → 已注册 → 扫描发现 → 其他 → 管理注册…）
3. `docs/superpowers/specs/2026-09-28-s10-collections-presets-design.md` §4.10 / §7 的 S11 行 → 核对「管理注册…」已接入 + `pickLinkTargets` 返回形态升级（`{ targets, collectionLevel }` → 联合类型，未退回 string[]）
4. `src/commands/registry.ts` → 核对 forget/dir 接线后 stub 循环不再到达，`plannedSpec` 字段保留无害，**无代码改动**；确认 `COMMANDS` 无残留过期描述
5. 本 spec §10 回填（终态计数 + 实施期裁定 + 未提交面原文）

每处改完**回读确认落地**再登记（S10 账本立下的修复纪律）。

- [ ] **Step 6: 终态验证 + 交接词**

Run: `pnpm verify`（终态，全绿）
Run: `git status --porcelain -uall`（只读，记录未提交面原文）
生成 `docs/handoffs/2026-09-28-s12-<topic>.md` 交接词（S12 范围 = 引导性打磨：--dry-run 全面化 / 未知命令模糊纠错 / 错误即建议全局化——PRD §14 行 411；本 spec §7 已列 S12 依赖面）
