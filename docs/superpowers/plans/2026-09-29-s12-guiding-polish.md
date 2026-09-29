# S12「引导性打磨」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 按本仓库 SDD 惯例（S11 账本 Setup 裁定）执行：brief 载体 = 本 plan 文件 + `### Task N:` 标题锚定；零 commit（用户全局 Git 写操作禁令），实现者报告不含 commit，每任务收尾用只读 `git status --porcelain -uall` 核对；禁止派生子代理；子代理同样禁止任何 git 写操作。可用 `superpowers:executing-plans` / `superpowers:subagent-driven-development` 流程，但以本段裁定为准。

**Goal:** 完成 S12 三块交付——`--dry-run` 全局化（save/preset rm/forget/dir）、未知命令模糊纠错（中文建议）、错误即建议全局化（45 条文案统一模板），并回写 S9 spec 措辞。

**Architecture:** 三个正交改动面——① dry-run：四命令扩第三参 `opts?: { dryRun?: boolean }`，校验全跑后「同一份 next 值」分支打印计划（复用 `renderPlan`）或写盘；② 模糊纠错：cli 层 `exitOverride()` + `showSuggestionAfterError(false)` + catch CommanderError + 自写 Damerau-Levenshtein（≤3）输出中文建议；③ 错误模板：只改 message 字符串（描述逐字保留，动作拆到 `\n下一步：` 行），`reportError` 结构零改动。

**Tech Stack:** TypeScript ESM + Node ≥22.12 + commander 15 + vitest（沿用）；零新增运行时依赖。

**Spec:** docs/superpowers/specs/2026-09-29-s12-guiding-polish-design.md（行为权威；§5 错误表为文案唯一改写依据）

## Global Constraints

- **零 commit**：改动不提交，用户自行提交；每任务收尾 `git status --porcelain -uall` 记录未提交面。
- **编辑纪律**：同一文件禁止并行 SearchReplace；import 与使用合并进同一次编辑；编辑后跑 `npx tsc --noEmit`（禁用 GetDiagnostics，TS Server 缓存不可靠）。
- **相对导入一律带 `.js`**；目录模块写 `<dir>/index.js`。
- **冻结面零改动**：`renderPlan` / 各 `reportError` helper / S1–S11 §4.3 既有签名（本 plan 只对 runSave/runPreset/runForget/runDir **追加**第三参，不删不改既有参数）。
- **错误文案**：只改 message 字符串；「描述」逐字保留现状第一句，动作拆到「下一步：」行；`reportError` 结构/KNOWN 列表零改动。
- **验证命令**：任务内 scoped 检查 `npx tsc --noEmit --pretty 2>&1 | grep "<改动目录>"`；每任务收尾跑该任务相关测试文件；T7 终态跑 `pnpm verify`。
- **SDD workspace**：`.superpowers/sdd/2026-09-29-s12-guiding-polish.md/progress.md` 记录每任务（零 commit 时账本是唯一证据，不删）。
- 交互遇 `--dry-run` 拒绝文案模板：`--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：<用法> --dry-run`（stderr + exit 1 + 零 clack 调用）。

---

### Task 1: 未知命令模糊纠错（cli.ts + fuzzy-suggest.test.ts + cli.e2e）

**Files:**
- Modify: `src/cli.ts`（buildProgram 加 `exitOverride`/`showSuggestionAfterError(false)`；新增导出 `suggestCommand`；`run()` 包 try/catch）
- Create: `tests/unit/fuzzy-suggest.test.ts`
- Modify: `tests/e2e/cli.e2e.test.ts`（lnik 断言补建议行；新增 staus 例）

**Interfaces:**
- Produces: `export function suggestCommand(raw: string, candidates?: readonly string[]): string[]`（T1 后全局可用；T2–T4 不依赖）

- [ ] **Step 1: 写失败测试** `tests/unit/fuzzy-suggest.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { suggestCommand } from '../../src/cli.js'

describe('suggestCommand（S12 spec §4.6：Damerau-Levenshtein ≤3）', () => {
  it('lnik → link（transposition，距离 2）', () => {
    expect(suggestCommand('lnik', ['link', 'unlink', 'status'])).toEqual(['link'])
  })
  it('staus → status（距离 1）', () => {
    expect(suggestCommand('staus', ['link', 'unlink', 'status'])).toEqual(['status'])
  })
  it('unlnk → unlink（距离 1）', () => {
    expect(suggestCommand('unlnk', ['link', 'unlink', 'status'])).toEqual(['unlink'])
  })
  it('阈值 ≤3 命中（linnnk → link，距离 2）', () => {
    expect(suggestCommand('linnnk', ['link', 'unlink', 'status'])).toEqual(['link'])
  })
  it('距离 >3 → []（zzzzzz 对所有命令距离 ≥6）', () => {
    expect(suggestCommand('zzzzzz', ['link', 'unlink', 'status'])).toEqual([])
  })
  it('并列同距离全列（savv → save、savvy 距离各 1）', () => {
    expect(suggestCommand('savv', ['save', 'savvy'])).toEqual(['save', 'savvy'])
  })
  it('candidates 缺省 = 全部注册命令名（COMMANDS 11 个）', () => {
    expect(suggestCommand('lnik')).toContain('link')
  })
})
```

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/fuzzy-suggest.test.ts`
Expected: FAIL（`suggestCommand` 未导出 / not defined）

- [ ] **Step 3: 实现 `suggestCommand` + cli 接线**

`src/cli.ts`：
- import 行改：`import { Command, Argument, CommanderError } from 'commander'`
- `buildProgram` 内 `program.name('lpm').description(...).version(LPM_VERSION)` 之后加：

```ts
  // S12 §4.6：commander 改抛异常（不直接 process.exit）；关闭其英文 (Did you mean…?) 建议，改用自写中文建议
  program.exitOverride()
  program.showSuggestionAfterError(false)
```

- 文件内新增导出（放在 `buildProgram` 之前）：

```ts
/** 未知命令模糊纠错（S12 spec §4.6）：Damerau-Levenshtein ≤3（与 commander 同质，含 transposition）。
 *  返回全部同距离候选（按名排序）；candidates 缺省 = 全部注册命令名。纯函数，供单测。 */
export function suggestCommand(raw: string, candidates: readonly string[] = COMMANDS.map((c) => c.name)): string[] {
  const MAX = 3
  const dist = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))
    for (let i = 0; i <= a.length; i++) d[i]![0] = i
    for (let j = 0; j <= b.length; j++) d[0]![j] = j
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
        }
      }
    }
    return d[a.length]![b.length]!
  }
  let best = MAX
  const hits: string[] = []
  for (const c of candidates) {
    if (c.length <= 1) continue
    const dd = dist(raw, c)
    if (dd < best) { best = dd; hits.length = 0; hits.push(c) }
    else if (dd === best) hits.push(c)
  }
  return hits.sort()
}
```

- `run()` 改造（整体替换 parseAsync 段）：

```ts
  try {
    await program.parseAsync(argv, { from: 'user' })
    // @types/node ≥22 中 exitCode 为 number | string | undefined，收敛为 number（契约 0/1）
    return Number(process.exitCode ?? 0)
  } catch (err) {
    if (err instanceof CommanderError) {
      // exitOverride 下 --help/--version 抛 exitCode=0（内容 commander 已打印到 stdout）→ 正常结束
      if (err.exitCode === 0) return 0
      // 报错内容（error: unknown command 'lnik' 等）commander 已写入 stderr（command.js error() 先 outputError 再 _exit）
      if (err.code === 'commander.unknownCommand') {
        const raw = /'([^']+)'/.exec(err.message)?.[1]
        if (raw !== undefined) {
          const sim = suggestCommand(raw)
          if (sim.length > 0) process.stderr.write(`最接近的命令：${sim.join('、')}\n`)
        }
      }
      return 1
    }
    throw err
  }
```

- [ ] **Step 4: 跑测试验证通过**

Run: `npx vitest run tests/unit/fuzzy-suggest.test.ts`
Expected: 7 passed

Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/cli"`
Expected: 零输出

- [ ] **Step 5: e2e 断言**

`tests/e2e/cli.e2e.test.ts` 既有 `lpm lnik` 用例内追加一行：

```ts
  it('lpm lnik（未知命令）：exit ≠ 0，stderr 非空且含中文建议', async () => {
    const r = await runCli(['lnik'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
    expect(r.stderr).toContain('最接近的命令：link')
  })

  it('lpm staus（未知命令错拼）：stderr 含最接近的命令：status', async () => {
    const r = await runCli(['staus'], cwd)
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('最接近的命令：status')
  })
```

（既有 `--version` / `--help` / 无参数用例即 exitOverride 的回归钉：它们断言 exit 0 + 内容，若 exitOverride 处理不当会红。）

- [ ] **Step 6: 全量验证 + 收尾**

Run: `npx vitest run tests/e2e/cli.e2e.test.ts` → 全绿（40+ 例）
Run: `git status --porcelain -uall` → 记录未提交面到 `.superpowers/sdd/2026-09-29-s12-guiding-polish.md/progress.md`（改动文件：cli.ts、fuzzy-suggest.test.ts、cli.e2e.test.ts）

---

### Task 2: forget `--dry-run` + F1/F2 错误模板（forget.ts + cli.ts + forget-command.test.ts）

**Files:**
- Modify: `src/commands/forget.ts`（签名扩第三参；forgetDirect dry-run 分支；交互遇 dry-run 拒绝；F1/F2 文案模板）
- Modify: `src/cli.ts`（forget 块加 `--dry-run` option + 透传）
- Modify: `tests/unit/forget-command.test.ts`（dry-run 3 例 + F 断言同步）

**Interfaces:**
- Produces: `runForget(targets: readonly string[], cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`

- [ ] **Step 1: 写失败测试**（`tests/unit/forget-command.test.ts` 追加 describe）

```ts
describe('lpm forget --dry-run（S12 spec §4.4/§4.5）', () => {
  it('S12-FG-DR1：直通 --dry-run → 计划文本 + config byte 级零写盘 + exit 0', async () => {
    const ws = makeWs()
    registerLib(ws, '@t/a', 'libs/a')
    registerLib(ws, '@t/b', 'libs/b')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a', '@t/b'], ws, { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.out.join('')).toContain('将移除注册：@t/a、@t/b')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-FG-DR2：--dry-run + 已链接 → 照样拦截 + 零写盘 + exit 1', async () => {
    const ws = makeWs({ '.lpm/state.json': JSON.stringify({ version: 1, links: { '@t/a': { original: {}, linkedAt: 'x' } } }) })
    registerLib(ws, '@t/a', 'libs/a')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runForget(['@t/a'], ws, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('先 lpm unlink @t/a')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-FG-DR3：无参数 + --dry-run → 拒绝 + exit 1 + 零 clack 调用', async () => {
    const ws = makeWs()
    const cap = captureOut()
    const code = await runForget([], ws, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('--dry-run 仅直通模式适用')
    expect(multiselect).not.toHaveBeenCalled()
  })
})
```

（注：`captureOut` 返回 `{out, err}` 数组；`multiselect` 已在文件顶部 mock。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: 3 个新例 FAIL（`runForget` 第三参不存在 / dry-run 未实现）

- [ ] **Step 3: 实现**（`src/commands/forget.ts`）

- import 加：`import { renderPlan, type PlanView } from './plan-view.js'`
- `runForget` 签名改：`export async function runForget(targets: readonly string[], cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number>`
- `forgetDirect` 签名改：`async function forgetDirect(targets: readonly string[], rootDir: string, cwd: string, opts: { dryRun?: boolean }): Promise<number>`
- `forgetDirect` 内「2. 已链接拦截」之后、「3. 写盘」之前插入 dry-run 分支（原 3/4 顺延）：

```ts
  // 3. dry-run（S12 §4.4）：校验全跑后打印计划零写盘；预设提示是删除后的通知，dry-run 不适用（§8 自决 5）
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将移除注册：${keys.join('、')}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
```

- `runForget` 无参数分支顶部（`if (targets.length === 0) {` 之后第一行）插入：

```ts
      if (opts.dryRun === true) {
        process.stderr.write(`--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：${FORGET_USAGE} --dry-run\n`)
        return 1
      }
```

- `runForget` 直通分支改：`return await forgetDirect(targets, rootDir, cwd, opts)`
- **F1/F2 文案模板**（spec §5.2）：
  - `notFound`（forget.ts:67-71）：`'当前没有任何已注册的 lib。用 lpm link <路径> 注册'` → `'当前没有任何已注册的 lib。\n下一步：用 lpm link <路径> 注册'`；`\`注册不存在：${raw}。已注册：${registeredList(cfg)}\`` → `\`注册不存在：${raw}。\n下一步：检查拼写后重试；已注册：${registeredList(cfg)}\``
  - F2（forget.ts:121）：`\`${key} 当前已链接。先 lpm unlink ${key} 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档\`` → `\`${key} 当前已链接。\n下一步：先 lpm unlink ${key} 取消链接，或改用 lpm unlink——lpm 不会同时拆线与删档\``

- [ ] **Step 4: 跑测试验证通过 + 断言同步**

Run: `npx vitest run tests/unit/forget-command.test.ts`
Expected: 全部通过（新 3 例 + 既有 FG 例；FG-6/FG-7 等用 `toContain('先 lpm unlink @t/a')` 的断言子串在「下一步」行仍命中，零改动；若有整条 `toBe` 断言失败，按两行模板同步）
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands/forget\|src/cli"`
Expected: 零输出

- [ ] **Step 5: cli 接线**（`src/cli.ts` forget 块整体替换为）

```ts
    if (meta.name === 'forget') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runForget(targets, undefined, { dryRun: options.dryRun })
        })
      continue
    }
```

- [ ] **Step 6: 全量验证 + 收尾**

Run: `npx vitest run tests/unit/forget-command.test.ts tests/e2e/cli.e2e.test.ts` → 全绿
Run: `git status --porcelain -uall` → 记录到 progress.md（改动：forget.ts、cli.ts、forget-command.test.ts）

---

### Task 3: dir `--dry-run` + D1–D4 错误模板（dir.ts + cli.ts + dir-command.test.ts）

**Files:**
- Modify: `src/commands/dir.ts`（签名扩第三参；add/rm dry-run 分支；交互遇 dry-run 拒绝；D1–D4 文案模板）
- Modify: `src/cli.ts`（dir 块加 `--dry-run` + 透传）
- Modify: `tests/unit/dir-command.test.ts`（dry-run 4 例 + D 断言同步）

**Interfaces:**
- Produces: `runDir(args: readonly string[], _cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`

- [ ] **Step 1: 写失败测试**（`tests/unit/dir-command.test.ts` 追加 describe）

```ts
describe('lpm dir --dry-run（S12 spec §4.4/§4.5）', () => {
  it('S12-D-DR1：add --dry-run → 计划文本 + 用户配置零写盘 + exit 0', async () => {
    const home = makeHome()
    const scan = join(mkdtempSync(join(tmpdir(), 'lpm-scan-')), 'x')
    dirs.push(join(scan, '..'))
    mkdirSync(scan, { recursive: true })
    const cap = captureOut()
    const code = await runDir(['add', scan], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.out.join('')).toContain(`将加入扫描目录：${scan}`)
    expect(existsSync(join(home, '.lpm', 'config.json'))).toBe(false)
  })

  it('S12-D-DR2：rm --dry-run → 计划文本 + 零写盘 + exit 0', async () => {
    const home = makeHome()
    const scan = join(home, 'scan-dir')
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [scan] }), 'utf8')
    const before = readFileSync(join(home, '.lpm', 'config.json'), 'utf8')
    const cap = captureOut()
    const code = await runDir(['rm', scan], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain(`将移除扫描目录：${scan}`)
    expect(readFileSync(join(home, '.lpm', 'config.json'), 'utf8')).toBe(before)
  })

  it('S12-D-DR3：ls --dry-run → 照常列出（只读不受影响）', async () => {
    const home = makeHome()
    writeFileSync(join(home, '.lpm', 'config.json'), JSON.stringify({ version: 1, scanDirs: [join(home, 'a')] }), 'utf8')
    const cap = captureOut()
    const code = await runDir(['ls'], process.cwd(), { dryRun: true })
    expect(code).toBe(0)
    expect(cap.out.join('')).toContain(join(home, 'a'))
  })

  it('S12-D-DR4：无参数 + --dry-run → 拒绝 + exit 1 + 零 clack 调用', async () => {
    makeHome()
    const cap = captureOut()
    const code = await runDir([], process.cwd(), { dryRun: true })
    expect(code).toBe(1)
    expect(cap.err.join('')).toContain('--dry-run 仅直通模式适用')
    expect(multiselect).not.toHaveBeenCalled()
  })
})
```

（注：unit 直调 `runDir` 时 `--dry-run` 走第三参 opts，**不进 args**——cli 层才解析 flag。`makeHome`/`captureOut`/`multiselect` 均为文件既有 fixture。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/dir-command.test.ts`
Expected: 4 个新例 FAIL

- [ ] **Step 3: 实现**（`src/commands/dir.ts`）

- import 加：`import { renderPlan, type PlanView } from './plan-view.js'`
- `runDir` 签名改：`export async function runDir(args: readonly string[], _cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number>`
- `runDirAdd` 签名改：`async function runDirAdd(dir: string, opts: { dryRun?: boolean }): Promise<number>`；校验后、写盘前插入：

```ts
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将加入扫描目录：${trimmed}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
```

- `runDirRm` 签名改：`async function runDirRm(raw: string, opts: { dryRun?: boolean }): Promise<number>`；校验后、写盘前插入：

```ts
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将移除扫描目录：${dir}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
```

- `runDir` 分派改（整体替换函数体）：

```ts
  try {
    if (args.length === 0) {
      if (opts.dryRun === true) {
        process.stderr.write(`--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：${DIR_USAGE} --dry-run\n`)
        return 1
      }
      return await runDirInteractive()
    }
    if (args[0] === 'add' && args.length === 2) return await runDirAdd(args[1] as string, opts)
    if (args[0] === 'rm' && args.length === 2) return await runDirRm(args[1] as string, opts)
    if (args[0] === 'ls' && args.length === 1) return await runDirLs()
    throw new DirError(`用法：${DIR_USAGE}`)
  } catch (err) {
    return reportError(err)
  }
```

- **D1–D4 文案模板**（spec §5.3）：
  - D1（dir.ts:36）：`\`扫描目录必须是已存在的绝对路径：${trimmed}。示例：D:\\Seed\\libs\`` → `\`扫描目录必须是已存在的绝对路径：${trimmed}。\n下一步：示例：D:\\Seed\\libs\``
  - D2（dir.ts:51）：`'当前没有任何扫描目录。可用 lpm dir add <路径> 添加'` → `'当前没有任何扫描目录。\n下一步：用 lpm dir add <路径> 添加'`
  - D3（dir.ts:54）：`\`扫描目录不在列表中：${dir}。可用 lpm dir ls 查看\`` → `\`扫描目录不在列表中：${dir}。\n下一步：用 lpm dir ls 查看当前列表\``
  - D4（dir.ts:113）：`\`用法：${DIR_USAGE}\`` → `\`用法错误。\n下一步：${DIR_USAGE}\``

- [ ] **Step 4: 跑测试验证通过 + 断言同步**

Run: `npx vitest run tests/unit/dir-command.test.ts`
Expected: 全绿（新 4 例 + 既有 D 例；D-3/D-4 等 `toContain('扫描目录必须是已存在的绝对路径')` 子串在描述行仍命中，零改动）
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands/dir\|src/cli"`
Expected: 零输出

- [ ] **Step 5: cli 接线**（`src/cli.ts` dir 块整体替换为）

```ts
    if (meta.name === 'dir') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'add <路径> | rm <路径> | ls')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (args: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runDir(args, undefined, { dryRun: options.dryRun })
        })
      continue
    }
```

- [ ] **Step 6: 全量验证 + 收尾**

Run: `npx vitest run tests/unit/dir-command.test.ts tests/e2e/cli.e2e.test.ts` → 全绿
Run: `git status --porcelain -uall` → 记录到 progress.md（改动：dir.ts、cli.ts、dir-command.test.ts）

---

### Task 4: save/preset `--dry-run` + P1–P7 错误模板（preset.ts + cli.ts + preset-command.test.ts + cli.e2e 冒烟）

**Files:**
- Modify: `src/commands/preset.ts`（runSave/runPreset/runPresetRm 签名扩第三参；dry-run 分支；交互遇 dry-run 拒绝；P1–P7 文案模板）
- Modify: `src/cli.ts`（save/preset 块加 `--dry-run` + 透传）
- Modify: `tests/unit/preset-command.test.ts`（dry-run 4 例 + P 断言同步）
- Modify: `tests/e2e/cli.e2e.test.ts`（S10 save describe 内加 dry-run 冒烟）

**Interfaces:**
- Produces: `runSave(name: string, cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`；`runPreset(args: readonly string[], cwd?: string, opts?: { dryRun?: boolean }): Promise<number>`

- [ ] **Step 1: 写失败测试**（`tests/unit/preset-command.test.ts` 追加 describe）

```ts
describe('save / preset rm --dry-run（S12 spec §4.4/§4.5）', () => {
  it('S12-PR-DR1：save --dry-run → 计划文本 + config byte 级零写盘 + exit 0', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    writeStateFile(dir, ['@t/b', '@t/a'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runSave('前端', dir, { dryRun: true })
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(cap.stdout()).toContain('将保存预设：前端（2 项：@t/a、@t/b）')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR2：save --dry-run 撞名 → 照样报错 + 零写盘', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { 前端: ['@t/a'] } }) })
    writeStateFile(dir, ['@t/b'])
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runSave('前端', dir, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('预设名已存在')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR3：preset rm --dry-run → 计划文本 + 零写盘 + exit 0', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/lib'], b: ['@t/x'] } }) })
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const cap = captureOut()
    const code = await runPreset(['rm', 'a'], dir, { dryRun: true })
    expect(code).toBe(0)
    expect(cap.stdout()).toContain('将删除预设：a')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })

  it('S12-PR-DR4：preset 无参数 + --dry-run → 拒绝 + exit 1 + 零 clack 调用', async () => {
    const dir = makeProj({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {}, presets: { a: ['@t/lib'] } }) })
    const cap = captureOut()
    const code = await runPreset([], dir, { dryRun: true })
    expect(code).toBe(1)
    expect(cap.stderr()).toContain('--dry-run 仅直通模式适用')
    expect(multiselect).not.toHaveBeenCalled()
  })
})
```

（注：`captureOut` 返回 `{stdout, stderr}` 函数；`multiselect` 已 mock。）

- [ ] **Step 2: 跑测试验证失败**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: 4 个新例 FAIL

- [ ] **Step 3: 实现**（`src/commands/preset.ts`）

- import 加：`import { renderPlan, type PlanView } from './plan-view.js'`
- `runSave` 签名改：`export async function runSave(name: string, cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number>`；`await writeProjectConfig(...)` 之前插入：

```ts
    if (opts.dryRun === true) {
      const view: PlanView = { entries: [{ kind: 'line', text: `将保存预设：${name}（${sorted.length} 项：${sorted.join('、')}）` }], install: null, watch: [] }
      process.stdout.write(renderPlan(view, 'dry-run'))
      return 0
    }
```

- `runPresetRm` 签名改：`async function runPresetRm(name: string, cwd: string, opts: { dryRun?: boolean }): Promise<number>`；`await persistPresets(...)` 之前插入：

```ts
  if (opts.dryRun === true) {
    const view: PlanView = { entries: [{ kind: 'line', text: `将删除预设：${name}` }], install: null, watch: [] }
    process.stdout.write(renderPlan(view, 'dry-run'))
    return 0
  }
```

- `runPreset` 签名改：`export async function runPreset(args: readonly string[], cwd: string = process.cwd(), opts: { dryRun?: boolean } = {}): Promise<number>`；分派改：

```ts
    if (args.length === 0) {
      if (opts.dryRun === true) {
        process.stderr.write('--dry-run 仅直通模式适用（交互模式自带确认与预览）；直通用法：lpm preset rm <名> --dry-run\n')
        return 1
      }
      return await runPresetInteractive(cwd)
    }
    if (args[0] === 'rm' && args.length === 2) return await runPresetRm(args[1] as string, cwd, opts)
    throw new PresetError('用法：lpm preset（列表管理）/ lpm preset rm <名>')
```

- **P1–P7 文案模板**（spec §5.1）：
  - P1（preset.ts:38）：`'lpm.config.json 的 presets 应为对象。可手工修正或删除该字段——lpm 状态可抛弃重建'` → `'lpm.config.json 的 presets 应为对象。\n下一步：手工修正该字段，或删除 presets 后重新 lpm save——lpm 状态可抛弃重建'`
  - P2（preset.ts:54）：`'预设名不能为空，且不能包含空白字符（示例：my-preset）'` → `'预设名不能为空，且不能包含空白字符。\n下一步：改用不含空白的名字，如 my-preset'`
  - P3（preset.ts:78）：`'当前没有任何已链接的库，无法存为预设。先 lpm link <名字|路径>'` → `'当前没有任何已链接的库，无法存为预设。\n下一步：先 lpm link <名字|路径> 建立链接'`
  - P4（preset.ts:81）：`\`预设名已存在：${name}。先 lpm preset rm ${name} 删除，或换一个名字\`` → `\`预设名已存在：${name}。\n下一步：先 lpm preset rm ${name} 删除，或换一个名字\``
  - P5（preset.ts:107）：`'没有 lpm.config.json，没有任何预设（该文件进 git，可由版本库恢复）'` → `'没有 lpm.config.json，没有任何预设。\n下一步：该文件进 git，可由版本库恢复'`
  - P6（preset.ts:112-116）：`\`预设不存在：${name}。可用预设：${avail.join('、')}\`` → `\`预设不存在：${name}。\n下一步：可用预设：${avail.join('、')}\``；空分支 `\`预设不存在：${name}。当前没有任何预设\`` → `\`预设不存在：${name}。\n下一步：当前没有任何预设。先 lpm save <名字> 建立\``
  - P7（preset.ts:165）：`'用法：lpm preset（列表管理）/ lpm preset rm <名>'` → `'用法错误。\n下一步：lpm preset（列表管理）/ lpm preset rm <名>'`

- [ ] **Step 4: 跑测试验证通过 + 断言同步**

Run: `npx vitest run tests/unit/preset-command.test.ts`
Expected: 全绿（新 4 例 + 既有例；SV 系列 `toContain('当前没有任何已链接的库')` 等子串在描述行命中，零改动）
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands/preset\|src/cli"`
Expected: 零输出

- [ ] **Step 5: cli 接线 + e2e 冒烟**

`src/cli.ts` save 块整体替换为：

```ts
    if (meta.name === 'save') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('<预设名>', '预设名')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .allowExcessArguments(false)
        .action(async (name: string, options: { dryRun?: boolean }) => {
          process.exitCode = await runSave(name, undefined, { dryRun: options.dryRun })
        })
      continue
    }
```

preset 块整体替换为：

```ts
    if (meta.name === 'preset') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[args...]', 'rm <名>')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (args: string[], options: { dryRun?: boolean }) => {
          process.exitCode = await runPreset(args, undefined, { dryRun: options.dryRun })
        })
      continue
    }
```

`tests/e2e/cli.e2e.test.ts` 的 `lpm save e2e（S10）` describe 内追加：

```ts
  it('E2E-S12-1：save --dry-run → exit 0 + 计划文本 + config 零写盘（冒烟）', async () => {
    const dir = makeProject({
      'lpm.config.json': JSON.stringify({ version: 1, libs: {} }),
    })
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(
      join(dir, '.lpm', 'state.json'),
      JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }),
      'utf8',
    )
    const before = readFileSync(join(dir, 'lpm.config.json'), 'utf8')
    const r = await runCli(['save', 'x', '--dry-run'], dir)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('dry-run 执行计划（不落任何盘、不执行任何子进程）：')
    expect(readFileSync(join(dir, 'lpm.config.json'), 'utf8')).toBe(before)
  })
```

（e2e 文件已 import `mkdirSync`/`writeFileSync`/`readFileSync`/`join`，无新增 import。）

- [ ] **Step 6: 全量验证 + 收尾**

Run: `npx vitest run tests/unit/preset-command.test.ts tests/e2e/cli.e2e.test.ts` → 全绿
Run: `git status --porcelain -uall` → 记录到 progress.md（改动：preset.ts、cli.ts、preset-command.test.ts、cli.e2e.test.ts）

---

### Task 5: link/unlink/repair/use 错误文案统一模板（13 条 + 断言同步）

**Files:**
- Modify: `src/commands/link.ts`（A1–A12、I1–I2 共 14 条）
- Modify: `src/commands/unlink.ts`（U1 1 条）
- Modify: `src/commands/repair.ts`（U2 1 条）
- Modify: `tests/unit/*` 中对该等文案的整条断言（若有）——子串断言零改动
- 不改：`use.ts` 无自有文案（其错误全来自 core 层，归 T6）

**Interfaces:**
- Consumes: spec §5.9 / §5.10 表（唯一改写依据）

- [ ] **Step 1: 按 spec §5.9/§5.10 逐条改写 message**

改写模式：**描述部分逐字保留现状第一句；动作拆到「\n下一步：」行**。以 link.ts 的三处为样板（其余按 spec 表机械套用）：

- A1（link.ts:1022）：`'--last / --all / --preset 三者互斥，请只用一个。用法：lpm link --last | --all | --preset <名>'` → `'--last / --all / --preset 三者互斥。\n下一步：请只用一个。用法：lpm link --last | --all | --preset <名>'`
- A10（link.ts:128）：`\`未知注册名/路径不存在：${raw}。已注册：${registeredList(cfg)}；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册。\`` → `\`未知注册名/路径不存在：${raw}。\n下一步：已注册：${registeredList(cfg)}；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册。\``
- A12（link.ts:559）：`\`${check.name} 不在任何成员依赖中。先在引用方执行 pnpm add ${check.name} 再 link\`` → `\`${check.name} 不在任何成员依赖中。\n下一步：先在引用方执行 pnpm add ${check.name} 再 link\``

完整清单：A1–A12、I1–I2（link.ts）、U1（unlink.ts，`LinkStateCorruptError` 的 message 参数）、U2（repair.ts:520）。逐条对照 spec §5.9/§5.10，**未列条目零改动**。

- [ ] **Step 2: 跑相关测试，同步整条断言**

Run: `npx vitest run tests/unit/link-command.test.ts tests/unit/link-interactive.test.ts tests/unit/unlink-command.test.ts tests/unit/unlink-interactive.test.ts tests/unit/repair-command.test.ts tests/unit/link-collection.test.ts tests/unit/link-picker.test.ts tests/e2e/cli.e2e.test.ts`
Expected: 既有 `toContain` 子串断言全部存活（描述行保留）；若有 `toBe`/`toEqual` 整条断言失败，按两行模板同步该断言。
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands/link\|src/commands/unlink\|src/commands/repair"`
Expected: 零输出

- [ ] **Step 3: 收尾**

Run: `git status --porcelain -uall` → 记录到 progress.md（改动：link.ts、unlink.ts、repair.ts + 断言同步的文件）

---

### Task 6: core 层错误文案统一模板（26 条 + R1 补下一步 + 断言同步）

**Files:**
- Modify: `src/core/workspace.ts`（W1–W7）
- Modify: `src/core/pm.ts`（M1–M2）
- Modify: `src/state/index.ts`（S1–S4）
- Modify: `src/core/linkcheck.ts`（L1–L9）
- Modify: `src/core/rewriter.ts`（R1，**补缺失的下一步**）
- Modify: `src/core/install.ts`（R2）
- Modify: `tests/unit/*` 中对该等文案的整条断言（若有）——子串断言零改动

**Interfaces:**
- Consumes: spec §5.4–§5.8 表（唯一改写依据）

- [ ] **Step 1: 按 spec §5.4–§5.8 逐条改写 message**

改写模式同 T5（描述逐字保留 + `\n下一步：` 行）。样板（workspace.ts W2 / pm.ts M1 / rewriter.ts R1）：

- W2（workspace.ts:75）：`\`清单解析失败：${manifestPath}（${(e as Error).message}）。请修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状。\`` → `\`清单解析失败：${manifestPath}（${(e as Error).message}）。\n下一步：修正 JSON 语法后重试；若该文件由其他工具生成，请先恢复原状\``
- M1（pm.ts:98）：`\`检测到多个 lockfile（${found.join(', ')}），包管理器判定歧义。请手动指定：lpm use <pnpm|npm|yarn>\`` → `\`检测到多个 lockfile（${found.join(', ')}），包管理器判定歧义。\n下一步：手动指定：lpm use <pnpm|npm|yarn>\``
- **R1（rewriter.ts:40，补下一步）**：`\`无法生成相对路径（跨盘符？）：libDir=${libDirAbs} manifestDir=${manifestDirAbs}\`` → `\`无法生成相对路径（跨盘符？）：libDir=${libDirAbs} manifestDir=${manifestDirAbs}\n下一步：Windows 无法跨盘符写相对路径——将 lib 与项目放到同一盘符后重试\``

完整清单：W1–W7、M1–M2、S1–S4、L1–L9、R1、R2，逐条对照 spec §5.4–§5.8。

- [ ] **Step 2: 跑相关测试，同步整条断言**

Run: `npx vitest run tests/unit`（全量 unit；重点 workspace/pm/state/rewriter/status/repair 相关）
Expected: 既有 `toContain` 子串断言存活；整条断言按两行模板同步。
Run: `npx tsc --noEmit --pretty 2>&1`
Expected: 仅既有已知错误清单内的错误（见全局规则），零新增

- [ ] **Step 3: 收尾**

Run: `git status --porcelain -uall` → 记录到 progress.md（改动：workspace.ts、pm.ts、state/index.ts、linkcheck.ts、rewriter.ts、install.ts + 断言同步）

---

### Task 7: S9 spec 措辞回写 + 终态验证 + 文档收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-s9-interactive-design.md`（§4.4 行 217 措辞按命令分别描述）
- Modify: `docs/superpowers/specs/2026-09-29-s12-guiding-polish-design.md`（§10 追加终态实测计数）
- 只读核对：`.superpowers/sdd/2026-09-29-s12-guiding-polish.md/progress.md` 全任务记录齐

- [ ] **Step 1: S9 spec §4.4 行 217 措辞回写**

现状（行 217）把「dry-run 沿用 S6 的单行、**无缩进**文案 `无待执行变更`」当通用规则，实际只描述 link。改为按命令分别描述（替换该行）：

> **「两模式只差首行」只对非空计划成立（实现期裁定 4）**：**非空计划**下交互预览与 dry-run 只差首行；**空计划**分支两模式各自保持既有形态——link 直通 dry-run 沿用 S6 的单行、**无缩进**文案 `无待执行变更`（且只打这一行、不列跳过明细）；unlink 的 dry-run 空分支走 `renderPlan(view, 'dry-run')`（**首行 `dry-run 执行计划（不落任何盘、不执行任何子进程）：` + 两空格缩进明细**，视图非空但计划空时补一行两空格缩进的 `  无待执行变更`，见 `unlink.ts` `unlinkPlanIsEmpty` 窄谓词）。预览打印明细 + **两空格缩进**版 `  无待执行变更`。原因是「dry-run 逐字兼容」是硬约束（既有测试断言这些字符串），而预览需要让人看懂「为什么没事可做」

- [ ] **Step 2: 终态验证**

Run: `pnpm verify`
Expected: exit 0 = typecheck 0 + build 成功 + unit **≥28 文件 / ≥499 例**（新增 fuzzy-suggest 1 文件 ≥7 例 + dry-run 各命令用例）+ e2e **≥1 文件 / ≥38 例**（新增 lnik 建议断言 + staus + save dry-run 冒烟）；把**实测终态计数**与 `git status --porcelain -uall` 未提交面写入 spec §10 与 progress.md

- [ ] **Step 3: 文档收口（落地后回头扫声明它的地方——用户规则）**

用关键词扫描一遍是否有过时字样：`Get-ChildItem docs,src,tests -Recurse -File -Include *.md,*.ts | Select-String -Pattern '未做|未验证|待建|缺|待定'`——重点核对：
- S9/S10/S11 spec 中若写了「S12 将补 --dry-run」之类待办 → 改「已落地（S12）」或标注日期
- 本 spec §9/§10 计数与终态一致
- 交接词相关段落如提到 S12 状态 → 不主动改（S13 交接在阶段二收口时统一处理）

- [ ] **Step 4: 收尾**

Run: `git status --porcelain -uall` → 完整未提交面清单记入 progress.md 与 spec §10
（S12 全部完成。按交接词 §S13 节直接进入 S13 阶段，无需新交接词。）
