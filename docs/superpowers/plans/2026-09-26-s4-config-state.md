# S4 配置与状态文件层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 S1 §4.4 冻结的 8 个 state stub 函数（state/last/user 读写 + deleteState + ensureGitignoreEntry），闭环 S3 遗留"深层 schema 校验归 S4"，并按 T1① 定版强化 atomic tmp 并发防护。

**Architecture:** 无新增源码模块——`src/state/index.ts` 8 stub → 实现 + `LpmStateParseError`（与 `LpmConfigParseError` 同文件分域），`src/state/atomic.ts` tmp 名加 uuid 段；读路径共通规约（BOM 剥除 → JSON.parse → 非对象判定 → 顶层字段校验 → version 校验）抽内部 helper `readLpmJson`；写路径全部复用 `writeJsonFileAtomic`；`writeState` 内建 gitignore 防护。

**Tech Stack:** TypeScript ESM（NodeNext）+ Node ≥22.12 + vitest 5；仅用内置模块 node:fs / node:path / node:os / node:crypto。

**Spec:** docs/superpowers/specs/2026-09-26-s4-config-state-design.md（含 §10 评审 Backlog；plan 与 spec 同读）

## Global Constraints（每个任务隐含包含）

- **禁止一切 Git 写操作**（commit/restore/checkout 等）——用户全局规则，改动由用户自行 commit；本 plan 无任何 commit 步骤
- **终端为 Windows PowerShell**：命令一律 PowerShell 兼容写法；skill bash 脚本不可用
- **相对导入一律带 `.js` 扩展名**（NodeNext）；目录模块写 `<dir>/index.js`
- **运行时依赖零新增**（PRD §14 行 391）：本 plan 仅用 node:fs/node:path/node:os/node:crypto 内置模块
- **冻结签名零改动**：S1 §4.4 八函数签名逐字保持；`writeJsonFileAtomic(filePath, value)` 签名不变（仅 tmp 名强化）；`readProjectConfig` 签名不变（仅行为增强）
- **原子写 = 临时文件 + rename**；fs 失败保持 crash 语义、不入错误契约（S3 账本行 37 Ruling）
- **错误文案契约**（spec §6，逐字含「可修复或直接删除该文件——lpm 状态可抛弃重建」尾巴）
- **测试期子代理运行后必须核对 git status**（2026-09-26 双 BOM 教训）；BOM 敏感文件写入遵循 S2 账本行 26 Ruling（本 plan 无 BOM 敏感 fixture 写入）
- **测试代码为权威**：plan 内计数若与实测不符，以实测为准并在账本记录（S3 P0 先例）
- **每任务结束全量绿**：任务收尾时既有用例不得红（state-stub.test.ts 随 readState 实现即时退役，见计划期修订②）

## 计划期修订（writing-plans 自审发现，随 plan 评审一并确认——S3 先例）

1. **T1① 技术事实澄清**：`writeJsonFileAtomic` 为同步函数，单线程事件循环下同进程两次调用不可能交错——"同进程并发互撞"仅在 worker_threads（共享 `process.pid`）场景真实成立。uuid 强化按用户定版（spec §2 决策 4）保留：防御纵深、覆盖 worker_threads、成本一次性。测试对策：用例 14 为并发语义守护（同步实现下恒绿，防未来改异步回归），用例 14-2 经 fs 失败注入判别 tmp 名含 uuid 段（唯一强判别点）。
2. **state-stub.test.ts 退役前移至 Task 2**：readState 实现后该文件唯一用例（readState rejects not-implemented）必失效，删除动作与实现同任务，保证 Task 2 收尾全量绿（spec §4.1/§7.4 #6 语义不变）。
3. **S3 spec §6.5 文案统一（新增回写义务 2c）**：`readLpmJson` 统一 helper 使 config 非对象文案由「不是合法的 lpm 配置（应为 JSON 对象）」变为「不是合法的 lpm 状态/配置文件（应为 JSON 对象）」——config-io 14d 断言（contains「应为 JSON 对象」/「可抛弃重建」）不受影响，S3 spec §6.5 #5 第二句随 Task 4 回写。
4. **unit 预期计数**（Task 3 执行期勘误，S3 P0 计数修正先例）：91 − 1（state-stub 退役）+ Task 1 增 2（14、14-2）+ Task 2 增 17（state-files 读 13 + 14b 4）+ Task 3 增 12（state-files 写与矩阵：3+1+2+1+13-1/13-4/13-5 各 1 + 13-2/13-3 it 内 for 循环 2——**非 it.each 参数化**）+ pm 增 1 = **122 unit + e2e 11 不变**。实测 122 定版（2026-09-26 Task 3 实证）。

---

### Task 1: atomic tmp 并发强化（T1①）

**Files:**
- Modify: `src/state/atomic.ts`（tmp 行 + 头注释）
- Test: `tests/unit/config-io.test.ts`（顶部 vi import + fs mock；底部新增 describe）

**Interfaces:**
- Consumes: 既有 `writeJsonFileAtomic(filePath: string, value: unknown): void`（S3 冻结签名，不改）
- Produces: `writeJsonFileAtomic` 行为强化——tmp 名为 `` `${filePath}.${process.pid}.${randomUUID()}.tmp` ``（node:crypto randomUUID）；其余语义（undefined TypeError / 失败清理 tmp 重抛 / rename 覆盖 / 2 空格 + 尾随 \n + LF + 无 BOM）不变。Task 3 的三个写函数消费它。

- [ ] **Step 1: 写失败测试**

`tests/unit/config-io.test.ts` 顶部 import 区改为（新增 `vi`）：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
```

紧随 import 区之后（`const dirs` 之前）插入 fs mock（透传真实现，仅开关开时注入写失败——不影响本文件其他用例）：

```ts
// T1①（S4 spec §4.5）：writeFileSync 默认透传真实现；failWrite 开关注入失败以观察 tmp 名；
// calls 记录 writeFileSync 首参（tmp 路径）供 14-2 断言 uuid 段
const fsMock = vi.hoisted(() => ({ failWrite: false, calls: [] as unknown[][] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      fsMock.calls.push(args)
      if (fsMock.failWrite) throw new Error('injected write failure')
      return actual.writeFileSync(...args)
    }) as typeof actual.writeFileSync,
  }
})
```

文件末尾追加 describe：

```ts
describe('writeJsonFileAtomic 并发与 tmp 契约（T1①，S4 spec §4.5）', () => {
  it('用例 14：同进程并发写同目标——双成功、无 tmp 残留、终值为两次之一的完整内容', async () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    await Promise.all([
      Promise.resolve().then(() => writeJsonFileAtomic(p, { a: 1 })),
      Promise.resolve().then(() => writeJsonFileAtomic(p, { b: 2 })),
    ])
    const raw = readFileSync(p, 'utf8')
    // 同步函数体在事件循环下串行执行——终值确定为后写者；此处按并发契约「二选一」断言（计划期修订 1）
    expect(raw === '{\n  "a": 1\n}\n' || raw === '{\n  "b": 2\n}\n').toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 14-2：tmp 名含 pid 与 uuid 段（失败注入观察，§4.5 格式契约）', () => {
    const dir = makeProject()
    const p = join(dir, 'a.json')
    fsMock.calls.length = 0
    fsMock.failWrite = true
    try {
      expect(() => writeJsonFileAtomic(p, { a: 1 })).toThrow('injected write failure')
    } finally {
      fsMock.failWrite = false
    }
    const tmpArg = fsMock.calls[0]?.[0]
    expect(typeof tmpArg).toBe('string')
    const base = (tmpArg as string).split(/[\\/]/).pop() as string
    expect(base).toMatch(/^a\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/)
    // 失败路径清理后无孤儿 tmp（S3 L1 语义回归守护）
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/config-io.test.ts`
Expected: **用例 14-2 FAIL**（现行 tmp 为 `a.json.<pid>.tmp`，不匹配 uuid 正则）；**用例 14 PASS**（同步实现下并发语义本就满足，属回归守护——计划期修订 1）；既有 8 用例 PASS（mock 透传不影响）。

- [ ] **Step 3: 实现**

`src/state/atomic.ts` 全文替换为：

```ts
import { randomUUID } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'

/** 原子写 JSON（PRD §9 崩溃安全：临时文件 + rename 覆盖；S3 spec §4.6 契约 + S4 spec §4.5 tmp 强化）。
 *  序列化契约：JSON.stringify(value, null, 2) + 尾随换行；LF；无 BOM。
 *  tmp 名含 pid + uuid 后缀——pid 防双终端并发互踩，uuid 防同进程并发互撞（T1① 定版；同步函数体在
 *  单线程事件循环下不可交错，uuid 实际覆盖 worker_threads 共享 pid 场景，作防御纵深）。
 *  失败语义：value 不可序列化（undefined）→ TypeError，不落盘；
 *  写入/rename 失败（Windows 目标被占用、磁盘满等）→ 清理孤儿 tmp 后原错误重抛。 */
export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    // JSON.stringify(undefined) 运行时返回 undefined（lib 签名误标 string），直接拼接会把字符串 "undefined" 落盘
    throw new TypeError(`writeJsonFileAtomic: value 不可序列化为 JSON：${filePath}`)
  }
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, json + '\n', 'utf8')
    renameSync(tmp, filePath) // Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING 语义）
  } catch (err) {
    rmSync(tmp, { force: true }) // 清理孤儿 tmp，不掩盖原错误
    throw err
  }
}
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm vitest run tests/unit/config-io.test.ts`
Expected: 10/10 PASS（既有 8 + 新增 2）。

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/state"`
Expected: 零输出（无该目录类型错误）。

- [ ] **Step 5: 写任务报告**

写入 `.superpowers/sdd/2026-09-26-s4-config-state.md/task-1-report.md`：改动文件清单、红灯/绿灯证据（原样粘贴关键输出）、与任务书代码块的偏差（如有）、git status 核对结果（应仅 spec/plan/handoffs 等已知未跟踪项，无 fixture 污染）。

---

### Task 2: 读路径——LpmStateParseError + 三读函数 + config 深层校验（F1/F2 闭环）

**Files:**
- Modify: `src/state/index.ts`（新增 LpmStateParseError + 内部 helper readLpmJson + 三个读函数实现 + readProjectConfig 重构增强）
- Modify: `tests/unit/config-io.test.ts`（新增 14b describe，4 it）
- Create: `tests/unit/state-files.test.ts`（读用例）
- Delete: `tests/unit/state-stub.test.ts`（计划期修订 2：readState 实现即失效）

**Interfaces:**
- Consumes: 既有 `LpmConfigParseError`（S3 冻结，config 域）；`writeJsonFileAtomic`（Task 1，本任务不消费但同文件共存）；类型 `LinkState`/`LastSet`/`UserLpmConfig`（`src/state/types.js`，S1 冻结）
- Produces:
  - `export class LpmStateParseError extends Error { constructor(public filePath: string, message: string) }`（name = 'LpmStateParseError'）
  - `readState(rootDir: string): Promise<LinkState | null>`（真实实现）
  - `readLast(rootDir: string): Promise<LastSet | null>`（真实实现）
  - `readUserConfig(): Promise<UserLpmConfig>`（真实实现；缺失 → `{ version: 1, scanDirs: [] }`）
  - `readProjectConfig` 行为增强：libs 顶层校验 + version 校验（错误类仍 `LpmConfigParseError`，签名不变）
  - Task 3 消费本任务的 `statePathOf` 同款路径约定：state = `<rootDir>/.lpm/state.json`、last = `<rootDir>/.lpm/last.json`、user = `join(homedir(), '.lpm', 'config.json')`

- [ ] **Step 1: 写失败测试**

新建 `tests/unit/state-files.test.ts` 全文：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LpmStateParseError, readLast, readState, readUserConfig } from '../../src/state/index.js'

// homedir 隔离（spec §7.1）：默认透传真实现，osMock.home 非空时替换（F10：plan 期红灯即验；失效则改 USERPROFILE 注入）
const osMock = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => (osMock.home !== '' ? osMock.home : actual.homedir()) }
})

const dirs: string[] = []
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-state-'))
  dirs.push(dir)
  return dir
}
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lpm-home-'))
  dirs.push(home)
  osMock.home = home
  return home
}
afterEach(() => {
  osMock.home = ''
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function writeStateFile(dir: string, content: string): void {
  mkdirSync(join(dir, '.lpm'), { recursive: true })
  writeFileSync(join(dir, '.lpm', 'state.json'), content, 'utf8')
}

describe('readState（S4 spec §4.4 读取共通规约）', () => {
  it('用例 1a：缺失 → null', async () => {
    expect(await readState(makeProject())).toBeNull()
  })

  it('用例 1b：手工落盘合法 state → 读出一致（roundtrip 前半，writeState 于 Task 3 补后半）', async () => {
    const dir = makeProject()
    const st = {
      version: 1 as const,
      links: { x: { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-09-26T00:00:00.000Z' } },
    }
    writeStateFile(dir, JSON.stringify(st, null, 2))
    expect(await readState(dir)).toEqual(st)
  })

  it('用例 2a：坏 JSON → LpmStateParseError（filePath + 可抛弃重建）', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{oops')
    const err = await readState(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as LpmStateParseError).filePath).toBe(join(dir, '.lpm', 'state.json'))
    expect((err as Error).message).toContain('不是合法 JSON')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 2b：非对象（数组/原始值）→ LpmStateParseError', async () => {
    const dir = makeProject()
    writeStateFile(dir, '[]')
    await expect(readState(dir)).rejects.toBeInstanceOf(LpmStateParseError)
    const dir2 = makeProject()
    writeStateFile(dir2, '"x"')
    await expect(readState(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 3：links 缺失 / links 非对象（数组）→ LpmStateParseError「links 应为对象」', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{"version":1}')
    const err = await readState(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('links 应为对象')
    const dir2 = makeProject()
    writeStateFile(dir2, '{"version":1,"links":[]}')
    await expect(readState(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 4：version 缺失宽容通过；version ≠ 1 → 「不支持的版本」', async () => {
    const dir = makeProject()
    writeStateFile(dir, '{"links":{}}')
    expect(await readState(dir)).toEqual({ links: {} })
    const dir2 = makeProject()
    writeStateFile(dir2, '{"version":2,"links":{}}')
    const err = await readState(dir2).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('不支持的版本')
  })

  it('用例 5：BOM 容忍（Buffer EF BB BF 前缀）', async () => {
    const dir = makeProject()
    writeStateFile(dir, '')
    const body = JSON.stringify({ version: 1, links: {} })
    writeFileSync(
      join(dir, '.lpm', 'state.json'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    )
    expect(await readState(dir)).toEqual({ version: 1, links: {} })
  })
})

describe('readLast（读路径部分；roundtrip 于 Task 3 用例 9c 补）', () => {
  it('用例 9a：缺失 → null', async () => {
    expect(await readLast(makeProject())).toBeNull()
  })

  it('用例 9b：names 缺失 / 非数组 → LpmStateParseError「names 应为数组」', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'last.json'), '{"version":1}', 'utf8')
    const err = await readLast(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('names 应为数组')
    const dir2 = makeProject()
    mkdirSync(join(dir2, '.lpm'), { recursive: true })
    writeFileSync(join(dir2, '.lpm', 'last.json'), '{"version":1,"names":"x"}', 'utf8')
    await expect(readLast(dir2)).rejects.toBeInstanceOf(LpmStateParseError)
  })
})

describe('readUserConfig（homedir 隔离）', () => {
  it('用例 11a：文件缺失 → { version: 1, scanDirs: [] }（S1 冻结注释定版）', async () => {
    makeHome()
    expect(await readUserConfig()).toEqual({ version: 1, scanDirs: [] })
  })

  it('用例 11b：scanDirs 缺失 / 非数组 → LpmStateParseError「scanDirs 应为数组」', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{"version":1}', 'utf8')
    const err = await readUserConfig().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('scanDirs 应为数组')
    const home2 = makeHome()
    mkdirSync(join(home2, '.lpm'), { recursive: true })
    writeFileSync(join(home2, '.lpm', 'config.json'), '{"version":1,"scanDirs":"x"}', 'utf8')
    await expect(readUserConfig()).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 11c：坏 JSON → LpmStateParseError', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{oops', 'utf8')
    await expect(readUserConfig()).rejects.toBeInstanceOf(LpmStateParseError)
  })

  it('用例 11d：version ≠ 1 → 「不支持的版本」', async () => {
    const home = makeHome()
    mkdirSync(join(home, '.lpm'), { recursive: true })
    writeFileSync(join(home, '.lpm', 'config.json'), '{"version":2,"scanDirs":[]}', 'utf8')
    const err = await readUserConfig().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmStateParseError)
    expect((err as Error).message).toContain('不支持的版本')
  })
})
```

`tests/unit/config-io.test.ts` 末尾追加 describe：

```ts
describe('readProjectConfig 深层校验（S4 spec §4.4 规约 5–7，F1/F2 闭环）', () => {
  it('用例 14b-1：libs 缺失 → LpmConfigParseError「libs 应为对象」', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":1}', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as Error).message).toContain('libs 应为对象')
    expect((err as Error).message).toContain('可抛弃重建')
  })

  it('用例 14b-2：libs 非对象（数组）→ LpmConfigParseError', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":1,"libs":[]}', 'utf8')
    await expect(readProjectConfig(dir)).rejects.toBeInstanceOf(LpmConfigParseError)
  })

  it('用例 14b-3：version ≠ 1（libs 合法）→ LpmConfigParseError「不支持的版本」', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"version":2,"libs":{}}', 'utf8')
    const err = await readProjectConfig(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LpmConfigParseError)
    expect((err as Error).message).toContain('不支持的版本')
  })

  it('用例 14b-4：libs 齐全 + version 缺失 → 宽容通过', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'lpm.config.json'), '{"libs":{}}', 'utf8')
    expect(await readProjectConfig(dir)).toEqual({ libs: {} })
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/state-files.test.ts tests/unit/config-io.test.ts`
Expected: state-files 全部 FAIL——红灯形态注记（S2 T1 先例）：`LpmStateParseError` 未导出 → import 为 undefined，`toBeInstanceOf(undefined)` 用例报 TypeError 形红；`readState/readLast/readUserConfig` 为 stub → rejects `not implemented: …（计划 S4）` 形红。config-io 14b 四例 FAIL（现行 readProjectConfig 无深层校验）。既有 config-io 10 例与全仓其余用例 PASS。

- [ ] **Step 3: 实现**

`src/state/index.ts` 全文替换为（8 stub 中三个读函数转实现；writeState/deleteState/writeLast/writeUserConfig/ensureGitignoreEntry 维持 stub 原文不动，Task 3 处理；`state-stub.test.ts` 本步删除）：

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { LastSet, LinkState, ProjectLpmConfig, UserLpmConfig } from './types.js'
import { writeJsonFileAtomic } from './atomic.js'

/** lpm.config.json 不是合法 JSON/结构无效（S3 引入；深层最小校验由 S4 补——S4 spec §4.4 规约 5–7） */
export class LpmConfigParseError extends Error {
  constructor(public configPath: string, message: string) {
    super(message)
    this.name = 'LpmConfigParseError'
  }
}

/** .lpm/state.json、.lpm/last.json、~/.lpm/config.json 不是合法 JSON/结构无效
 *  （S4 引入；与 LpmConfigParseError 分域——S4 spec §4.4 规约 7） */
export class LpmStateParseError extends Error {
  constructor(public filePath: string, message: string) {
    super(message)
    this.name = 'LpmStateParseError'
  }
}

function configPathOf(rootDir: string): string {
  return join(rootDir, 'lpm.config.json')
}

function statePathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'state.json')
}

function lastPathOf(rootDir: string): string {
  return join(rootDir, '.lpm', 'last.json')
}

function userConfigPath(): string {
  return join(homedir(), '.lpm', 'config.json')
}

/** 读 lpm JSON 文件共通规约（S4 spec §4.4 读取共通规约）：
 *  剥行首 UTF-8 BOM → JSON.parse → 非对象判定 → 顶层字段最小校验 → version 校验；
 *  错误类经 errOf 分域（config → LpmConfigParseError，state/last/user → LpmStateParseError）。
 *  S3 readProjectConfig 行为保持 + 增强：坏 JSON/非对象文案统一为「lpm 状态/配置文件」措辞
 *  （计划期修订 3，14d 断言不受影响；S3 spec §6.5 #5 随 Task 4 回写）。 */
function readLpmJson(
  filePath: string,
  raw: string,
  fieldChecks: Array<{ field: string; kind: 'object' | 'array' }>,
  errOf: (filePath: string, message: string) => Error,
): Record<string, unknown> {
  const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (err) {
    throw errOf(
      filePath,
      `${filePath} 不是合法 JSON（${(err as Error).message}）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw errOf(
      filePath,
      `${filePath} 不是合法的 lpm 状态/配置文件（应为 JSON 对象）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  const obj = parsed as Record<string, unknown>
  for (const { field, kind } of fieldChecks) {
    const v = obj[field]
    const ok =
      kind === 'object'
        ? typeof v === 'object' && v !== null && !Array.isArray(v)
        : Array.isArray(v)
    if (!ok) {
      throw errOf(
        filePath,
        `${filePath} 的 ${field} 应为${kind === 'object' ? '对象' : '数组'}。可修复或直接删除该文件——lpm 状态可抛弃重建`,
      )
    }
  }
  if (obj.version !== undefined && obj.version !== 1) {
    throw errOf(
      filePath,
      `${filePath} 版本 ${String(obj.version)} 不受支持（当前仅 version: 1）。可修复或直接删除该文件——lpm 状态可抛弃重建`,
    )
  }
  return obj
}

/** S3 提前实现（S3 spec §4.6）+ S4 深层校验增强（F1/F2 闭环）：缺失 → null；坏 JSON/非对象/字段校验失败 → LpmConfigParseError */
export async function readProjectConfig(rootDir: string): Promise<ProjectLpmConfig | null> {
  const p = configPathOf(rootDir)
  if (!existsSync(p)) return null
  const parsed = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'libs', kind: 'object' }],
    (fp, msg) => new LpmConfigParseError(fp, msg),
  )
  return parsed as ProjectLpmConfig
}

/** S3 提前实现（S3 spec §4.6）：原子写（PRD §9） */
export async function writeProjectConfig(rootDir: string, cfg: ProjectLpmConfig): Promise<void> {
  writeJsonFileAtomic(configPathOf(rootDir), cfg)
}

// 全部写入为原子写：临时文件 + rename（PRD §9 崩溃安全）——S4 实现（spec §4.4）

export async function readState(rootDir: string): Promise<LinkState | null> {
  const p = statePathOf(rootDir)
  if (!existsSync(p)) return null
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'links', kind: 'object' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as LinkState
}

export async function writeState(rootDir: string, st: LinkState): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）——实现于 Task 3
  throw new Error('not implemented: writeState（计划 S4）')
}

export async function deleteState(rootDir: string): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）
  throw new Error('not implemented: deleteState（计划 S4）')
}

export async function readLast(rootDir: string): Promise<LastSet | null> {
  const p = lastPathOf(rootDir)
  if (!existsSync(p)) return null
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'names', kind: 'array' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as LastSet
}

export async function writeLast(rootDir: string, last: LastSet): Promise<void> {
  throw new Error('not implemented: writeLast（计划 S4）')
}

export async function readUserConfig(): Promise<UserLpmConfig> {
  // 文件缺失 → { version: 1, scanDirs: [] }
  const p = userConfigPath()
  if (!existsSync(p)) return { version: 1, scanDirs: [] }
  const obj = readLpmJson(
    p,
    readFileSync(p, 'utf8'),
    [{ field: 'scanDirs', kind: 'array' }],
    (fp, msg) => new LpmStateParseError(fp, msg),
  )
  return obj as unknown as UserLpmConfig
}

export async function writeUserConfig(cfg: UserLpmConfig): Promise<void> {
  throw new Error('not implemented: writeUserConfig（计划 S4）')
}

export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'> {
  // 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/（PRD §9.5）——实现于 Task 3
  throw new Error('not implemented: ensureGitignoreEntry（计划 S4）')
}
```

删除 `tests/unit/state-stub.test.ts`（计划期修订 2：readState 已转真实现，not-implemented 断言失效；该文件仅此一用例）。

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm vitest run tests/unit`
Expected: 全绿，总数 **109/109**（91 基线 − 1 state-stub 退役 + 2 Task 1 + 13 state-files + 4 14b = 109；以实测为准，冲突时测试代码为权威并记账本）。state-stub.test.ts 已删除，不应再出现在文件列表。

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/state|tests/unit/state-files"`
Expected: 零输出。

- [ ] **Step 5: 全量回归核对（含 git status 检查——2026-09-26 教训）**

Run: `git status --porcelain -uall`
Expected: 仅已知未跟踪/已修改项（PRD 附录 A、handoffs、spec/plan、本次新改文件），**无 tests/fixtures/ 下任何条目**。

- [ ] **Step 6: 写任务报告**

写入 `.superpowers/sdd/2026-09-26-s4-config-state.md/task-2-report.md`（同 Task 1 Step 5 要素，附 state-stub 删除说明与实测计数）。

---

### Task 3: 写路径 + deleteState + ensureGitignoreEntry

**Files:**
- Modify: `src/state/index.ts`（writeState/writeLast/writeUserConfig/deleteState/ensureGitignoreEntry 五函数 stub → 实现）
- Test: `tests/unit/state-files.test.ts`（追加写路径与 gitignore 矩阵用例）

**Interfaces:**
- Consumes: `writeJsonFileAtomic`（Task 1 产出，tmp 含 uuid）；`LpmStateParseError` 与三个读函数（Task 2 产出）；类型 `LinkState`/`LastSet`/`UserLpmConfig`
- Produces:
  - `writeState(rootDir, st)`：mkdir `.lpm/` + **写入前自动 `ensureGitignoreEntry(rootDir)`**（返回值丢弃，spec §2 决策 5）+ 原子写
  - `deleteState(rootDir)`：`rmSync(statePath, { force: true })`——缺失幂等；只删 state.json，不动 last.json 与 `.lpm/` 目录
  - `writeLast(rootDir, last)`：mkdir + 原子写；**不调 ensureGitignoreEntry**（spec §4.4 差异点）
  - `writeUserConfig(cfg)`：mkdir `~/.lpm` + 原子写；无 gitignore 逻辑
  - `ensureGitignoreEntry(rootDir): Promise<'present' | 'added'>`：归一化匹配 + 直接写入（spec §4.4 步骤 1–3，含 BOM 剥除 F4）

- [ ] **Step 1: 写失败测试**

`tests/unit/state-files.test.ts` import 区改为（补 `readFileSync`、`readdirSync`、`ensureGitignoreEntry`、`writeState`、`writeLast`、`writeUserConfig`、`deleteState`）：

```ts
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
```

```ts
import {
  LpmStateParseError,
  deleteState,
  ensureGitignoreEntry,
  readLast,
  readState,
  readUserConfig,
  writeLast,
  writeState,
  writeUserConfig,
} from '../../src/state/index.js'
```

文件末尾追加：

```ts
describe('writeState（S4 spec §4.4：mkdir + gitignore 防护 + 原子写）', () => {
  it('用例 6：.lpm/ 不存在时自动 mkdir；原子写（无 tmp 残留）', async () => {
    const dir = makeProject()
    const st = { version: 1 as const, links: {} }
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.lpm', 'state.json'), 'utf8')).toContain('"version": 1')
    expect(readFileSync(join(dir, '.lpm', 'state.json'), 'utf8')).endsWith('\n')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('用例 7：首写触发 .gitignore 追加（新建含 .lpm/ 行）；次写幂等不重复', async () => {
    const dir = makeProject()
    const st = { version: 1 as const, links: {} }
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
    await writeState(dir, st)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
  })

  it('用例 7b：.gitignore 已存在且末尾无换行 → 先补换行再追加', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8')
    await writeState(dir, { version: 1 as const, links: {} })
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.lpm/\n')
  })
})

describe('deleteState（幂等；只删 state.json）', () => {
  it('用例 8：删除成功；文件缺失幂等；last.json 不受影响', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.lpm'), { recursive: true })
    writeFileSync(join(dir, '.lpm', 'state.json'), '{"version":1,"links":{}}', 'utf8')
    writeFileSync(join(dir, '.lpm', 'last.json'), '{"version":1,"names":[]}', 'utf8')
    await deleteState(dir)
    expect(() => readFileSync(join(dir, '.lpm', 'state.json'), 'utf8')).toThrow()
    expect(readFileSync(join(dir, '.lpm', 'last.json'), 'utf8')).toBe('{"version":1,"names":[]}')
    await deleteState(dir) // 幂等
    await deleteState(makeProject()) // 目录都不存在也幂等
  })
})

describe('writeLast / readLast roundtrip（S4 spec §4.4：mkdir + 原子写；不触 gitignore）', () => {
  it('用例 9c：writeLast 后 readLast 一致（roundtrip 后半）', async () => {
    const dir = makeProject()
    const last = { version: 1 as const, names: ['a', 'b'] }
    await writeLast(dir, last)
    expect(await readLast(dir)).toEqual(last)
  })

  it('用例 10：writeLast 不追加 .gitignore（不调 ensureGitignoreEntry，spec §4.4 差异点）', async () => {
    const dir = makeProject()
    await writeLast(dir, { version: 1 as const, names: [] })
    expect(() => readFileSync(join(dir, '.gitignore'), 'utf8')).toThrow()
  })
})

describe('writeUserConfig（homedir 隔离）', () => {
  it('用例 12：mkdir ~/.lpm + 原子写 + roundtrip', async () => {
    makeHome()
    const cfg = { version: 1 as const, scanDirs: ['D:/libs', 'D:/more'] }
    await writeUserConfig(cfg)
    expect(await readUserConfig()).toEqual(cfg)
    expect(readFileSync(join(osMock.home, '.lpm', 'config.json'), 'utf8')).toContain('D:/libs')
  })
})

describe('ensureGitignoreEntry（S4 spec §4.4 归一化口径，F4 含 BOM）', () => {
  it('用例 13-1：文件不存在 → 新建内容 .lpm/\\n → added', async () => {
    const dir = makeProject()
    expect(await ensureGitignoreEntry(dir)).toBe('added')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.lpm/\n')
  })

  it('用例 13-2：已覆盖 12 种常见写法 → present 且内容零改动', async () => {
    const entries = [
      '.lpm', '.lpm/', '/.lpm', '/.lpm/', '.lpm/*', '/.lpm/*',
      '.lpm/**', '/.lpm/**', '**/.lpm', '**/.lpm/', '**/.lpm/*', '**/.lpm/**',
    ]
    for (const entry of entries) {
      const dir = makeProject()
      writeFileSync(join(dir, '.gitignore'), `node_modules/\n${entry}\n`, 'utf8')
      expect(await ensureGitignoreEntry(dir), `写法 ${entry}`).toBe('present')
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `写法 ${entry}`).toBe(`node_modules/\n${entry}\n`)
    }
  })

  it('用例 13-3：反例 .lpmx / .foo/.lpm / !.lpm/ → 未覆盖，追加 .lpm/ 行', async () => {
    for (const entry of ['.lpmx', '.foo/.lpm', '!.lpm/']) {
      const dir = makeProject()
      writeFileSync(join(dir, '.gitignore'), `${entry}\n`, 'utf8')
      expect(await ensureGitignoreEntry(dir), `反例 ${entry}`).toBe('added')
      expect(readFileSync(join(dir, '.gitignore'), 'utf8'), `反例 ${entry}`).toBe(`${entry}\n.lpm/\n`)
    }
  })

  it('用例 13-4：末尾无换行 → 先补换行再追加', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, '.gitignore'), 'node_modules/', 'utf8')
    expect(await ensureGitignoreEntry(dir)).toBe('added')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('node_modules/\n.lpm/\n')
  })

  it('用例 13-5：带 BOM 的 .gitignore（首行 .lpm/）→ present 且零改动（F4）', async () => {
    const dir = makeProject()
    writeFileSync(
      join(dir, '.gitignore'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('.lpm/\nnode_modules/\n', 'utf8')]),
    )
    expect(await ensureGitignoreEntry(dir)).toBe('present')
    // present 零改动：BOM 与原内容原样保留
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').charCodeAt(0)).toBe(0xfeff)
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('\uFEFF.lpm/\nnode_modules/\n')
  })
})
```

- [ ] **Step 2: 跑红灯**

Run: `pnpm vitest run tests/unit/state-files.test.ts`
Expected: 新增 describe 全部 FAIL（writeState/deleteState/writeLast/writeUserConfig/ensureGitignoreEntry 仍 stub → `not implemented: …（计划 S4）`）；Task 2 既有 13 例 PASS。

- [ ] **Step 3: 实现**

`src/state/index.ts` 中五个 stub 函数替换为（import 区需含 `writeFileSync`——Task 2 版本已含；其余函数与文件其余部分零改动）：

```ts
function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

export async function writeState(rootDir: string, st: LinkState): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）；写入前内建 gitignore 防护（spec §2 决策 5，B6 不依赖 S6 记性）
  ensureGitignoreEntry(rootDir)
  const p = statePathOf(rootDir)
  ensureParentDir(p)
  writeJsonFileAtomic(p, st)
}

export async function deleteState(rootDir: string): Promise<void> {
  // links 清空即删文件（兼作 web 片段开关信号）；force 缺失幂等；只删 state.json，不动 last.json 与 .lpm/ 目录
  rmSync(statePathOf(rootDir), { force: true })
}

export async function writeLast(rootDir: string, last: LastSet): Promise<void> {
  // last.json 仅在 state 存续后才可能被写（.lpm/ 必已存在）——不调 ensureGitignoreEntry（spec §4.4 差异点）；mkdir 幂等仍做
  const p = lastPathOf(rootDir)
  ensureParentDir(p)
  writeJsonFileAtomic(p, last)
}

export async function writeUserConfig(cfg: UserLpmConfig): Promise<void> {
  // ~/.lpm 不在项目 git 仓库内——无 gitignore 逻辑（spec §4.4）
  const p = userConfigPath()
  ensureParentDir(p)
  writeJsonFileAtomic(p, cfg)
}

/** 归一化（S4 spec §4.4）：trim → 循环剥前导 '/' 或 '**/'、剥尾 '/**'、'/*'、'/' 至稳定 → 与 '.lpm' 全等 */
function normalizeGitignoreLine(line: string): string {
  let s = line.trim()
  let prev: string
  do {
    prev = s
    if (s.startsWith('/')) s = s.slice(1)
    if (s.startsWith('**/')) s = s.slice(3)
    if (s.endsWith('/**')) s = s.slice(0, -3)
    else if (s.endsWith('/*')) s = s.slice(0, -2)
    else if (s.endsWith('/') && s.length > 0) s = s.slice(0, -1)
  } while (s !== prev)
  return s
}

export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'> {
  // 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/（PRD §9.5）；.gitignore 为宿主项目文件，
  // 直接 writeFileSync 不入原子写承诺（spec §4.4；追加写坏可由 git 恢复）
  const p = join(rootDir, '.gitignore')
  if (existsSync(p)) {
    const raw = readFileSync(p, 'utf8')
    // 剥行首 UTF-8 BOM（记事本等工具常产生；lpm 家族读路径一致性——F4）
    const stripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const covered = stripped.split(/\r?\n/).some((line) => normalizeGitignoreLine(line) === '.lpm')
    if (covered) return 'present'
    const sep = raw.length === 0 || raw.endsWith('\n') ? '' : '\n'
    writeFileSync(p, raw + sep + '.lpm/\n', 'utf8')
    return 'added'
  }
  writeFileSync(p, '.lpm/\n', 'utf8')
  return 'added'
}
```

- [ ] **Step 4: 跑绿 + 类型检查**

Run: `pnpm vitest run tests/unit/state-files.test.ts`
Expected: 25/25 PASS（Task 2 既有 13 + 本任务 12）。

Run: `pnpm vitest run tests/unit`
Expected: 全绿，总数 **122/122**（Task 2 基线 109 + 12 state-files + 1 pm 补遗；2026-09-26 实测定版）。

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/state|tests/unit/state-files"`
Expected: 零输出。

- [ ] **Step 5: git status 核对**

Run: `git status --porcelain -uall`
Expected: 无 tests/fixtures/ 条目。

- [ ] **Step 6: 写任务报告**

写入 `.superpowers/sdd/2026-09-26-s4-config-state.md/task-3-report.md`（同前要素，附归一化 12 写法矩阵结果）。

---

### Task 4: S1/S3 spec 回写 + verify 四段收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（§4.4 标题与 ensureGitignoreEntry 行、§7 state-stub 表行）
- Modify: `docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md`（§4.6 tmp 契约行、readProjectConfig「S4 深化」注记、§6.5 #5 文案——义务 2a/2b/2c）

**Interfaces:**
- Consumes: Task 1–3 全部产出（回写文案与实际实现对账）
- Produces: 无代码；spec 文档与实现一致（后续 spec 引用的权威文本）

- [ ] **Step 1: S1 spec 回写（spec §4.6 义务 1）**

`docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md` 三处 old_str → new_str（逐字锚点，先 Read 目标区间核对再编辑）：

① §4.4 标题：

old:
```
### 4.4 state 读写 API（S4 填充；readProjectConfig/writeProjectConfig 已由 S3 提前实现，含原子写 helper src/state/atomic.ts 与 LpmConfigParseError）—— src/state/index.ts
```
new:
```
### 4.4 state 读写 API（已由 S4 全部实现；readProjectConfig/writeProjectConfig 由 S3 提前、S4 增强深层校验，含原子写 helper src/state/atomic.ts 与 LpmConfigParseError/LpmStateParseError）—— src/state/index.ts
```

② ensureGitignoreEntry 行（`// stub` 移除 + 实现注记）：

old:
```
/** 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/，未覆盖则追加并告知（PRD §9.5） */
export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'>   // stub
```
new:
```
/** 首次创建 .lpm/ 时检查 .gitignore 是否覆盖 .lpm/，未覆盖则追加并告知（PRD §9.5）——S4 实现（writeState 内建调用，归一化口径见 S4 spec §4.4） */
export async function ensureGitignoreEntry(rootDir: string): Promise<'present' | 'added'>
```

③ §7 行为表 state-stub 行（加退役注记）：

old:
```
| state-stub.test.ts | stub 可 rejected | 抽样 readState / readProjectConfig：reject 且 message 符合 not-implemented 约定 |
```
new:
```
| state-stub.test.ts | stub 可 rejected | 抽样 readState / readProjectConfig：reject 且 message 符合 not-implemented 约定（S4 退役：8 函数全部实现，文件已删除） |
```

- [ ] **Step 2: S3 spec 回写（spec §4.6 义务 2a/2b/2c）**

`docs/superpowers/specs/2026-09-25-s3-pm-detection-use-design.md` 三处（逐字锚点先核对）：

① §4.6 tmp 契约行（T1① 落痕）：

old:
```
1. tmp = <filePath>.<pid>.tmp（同目录保证 rename 同盘；pid 后缀防双终端并发互踩——PRD §9 动机）
```
new:
```
1. tmp = <filePath>.<pid>.<uuid>.tmp（同目录保证 rename 同盘；pid 防双终端并发互踩 + uuid 防同进程并发互撞
   ——PRD §9 动机 + S4 T1① 强化，uuid 实际覆盖 worker_threads 共享 pid 场景）
```

② readProjectConfig「S4 深化」注记（F1 闭环落痕）：

old:
```
    非对象（数组/原始值/null）→ LpmConfigParseError「应为 JSON 对象」（OCR 修复轮 2026-09-25 增补：
      非对象配置会让下游属性赋值/序列化静默失败；最小类型判定，非深层 schema 校验——S4 深化）
```
new:
```
    非对象（数组/原始值/null）→ LpmConfigParseError「应为 JSON 对象」（OCR 修复轮 2026-09-25 增补：
      非对象配置会让下游属性赋值/序列化静默失败；深层最小校验（libs 对象 / version）已由 S4 补——
      S4 spec §4.4 规约 5–7，非对象文案统一为「lpm 状态/配置文件」措辞）
```

③ §6.5 #5 第二句文案（计划期修订 3）：

old:
```
| 5 | config 坏 JSON / 非对象 | `LpmConfigParseError` → stderr，退出 1 | 「<路径> 不是合法 JSON（<原因>）」/「<路径> 不是合法的 lpm 配置（应为 JSON 对象）」，均含「可修复或直接删除该文件——lpm 状态可抛弃重建」 |
```
new:
```
| 5 | config 坏 JSON / 非对象 | `LpmConfigParseError` → stderr，退出 1 | 「<路径> 不是合法 JSON（<原因>）」/「<路径> 不是合法的 lpm 状态/配置文件（应为 JSON 对象）」（S4 统一措辞），均含「可修复或直接删除该文件——lpm 状态可抛弃重建」 |
```

- [ ] **Step 3: pnpm verify 四段全量复跑**

Run: `pnpm verify`
Expected: typecheck 0 错误 + build 成功 + unit **122/122**（12 文件：state-files 新增、state-stub 退役；2026-09-26 实测定版）+ e2e **11/11**。

- [ ] **Step 4: git status 终核**

Run: `git status --porcelain -uall`
Expected: 改动面 = src/state/{index,atomic}.ts + tests/unit/{config-io,pm,state-files}.* − state-stub + 两份 spec + 已知未跟踪 docs；**无 tests/fixtures/ 条目**。

- [ ] **Step 5: 写任务报告与账本收尾**

写入 `.superpowers/sdd/2026-09-26-s4-config-state.md/task-4-report.md`；progress.md 记账（四任务完成 + verify 四段结果 + 偏差裁决 + deferred minor + 「改动全部未提交，由用户自行 commit」）。

---

## Self-Review 记录（writing-plans 自审）

1. **Spec 覆盖**：§4.2 八函数（T2 读 3 + T3 写 4 + ensureGitignore T3）✓；§4.3 LpmStateParseError（T2）✓；§4.5 atomic（T1）✓；§4.4 读取共通规约（T2 readLpmJson）✓；深层校验 config 域（T2 14b + readProjectConfig 增强）✓；writeState 内建防护（T3 用例 7）✓；deleteState 幂等（T3 用例 8）✓；ensureGitignoreEntry 归一化/BOM/补换行（T3 13-1~13-5）✓；T2① pm 穿透（见下方补充——归 pm.test.ts，随 Task 3 派发一并执行，见下）✓；回写义务 1/2a/2b/2c（T4）✓；state-stub 退役（T2）✓；e2e 无新增 ✓。
2. **Placeholder 扫描**：无 TBD/TODO；所有代码块逐字给出；计数处显式标注「以实测为准」为既定纪律非占位。
3. **类型一致性**：`LpmStateParseError(filePath, message)` 与用例 `(err as LpmStateParseError).filePath` 一致；`normalizeGitignoreLine` 内部函数（不导出，不触公共 API 面）；`osMock.home` 在 state-files.test.ts 内自洽（Task 3 追加用例 12 复用 Task 2 的 makeHome/osMock——同文件追加，无跨文件引用）。

### 补遗：T2① pm 穿透用例（spec §7.2 #15，随 Task 3 派发一并执行——同为测试追加类小改）

**Files:** Modify: `tests/unit/pm.test.ts`（追加 1 it）

在 pm.test.ts 现有 describe 内追加（锚点：现有「pnpm-workspace.yaml 存在（无 lockfile）→ pnpm」用例之后；实现者先 Grep `workspace-manifest` 定位该 describe）：

```ts
it('级间穿透：packageManager 字段含未知 PM（bun@1）+ pnpm-workspace.yaml（无 lockfile）→ pnpm（T2①，evidence workspace-manifest）', async () => {
  const dir = makeTempProject()   // 用该文件既有临时目录 helper；若无则以现有用例同款方式自建
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', packageManager: 'bun@1.0.0' }), 'utf8')
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf8')
  const r = await detectPackageManagerDetailed(dir)
  expect(r.pm).toBe('pnpm')
  expect(r.evidence).toEqual({ kind: 'workspace-manifest', file: 'pnpm-workspace.yaml' })
})
```

注：helper 名以 pm.test.ts 现状为准（实现者先读该文件既有用例的临时目录构造方式，保持同款；断言面 = pm + evidence）。红灯不适用（实现已就绪，属覆盖补强）——直接跑绿。unit 总数相应 **+1 = 122**（2026-09-26 执行期勘误定版，见计划期修订④）。
