# S6 link 直通版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `lpm link <名字|路径>... [--watch] [--dry-run]` 直通链路——前置检查、注册 upsert、批量改写（同文件链式）、单次 install、--watch 子进程、O4 完成提示、last 写入、dry-run 执行计划。

**Architecture:** 命令编排层 `commands/link.ts`（S3 use.ts 先例：runLink 返回退出码、cwd 参数化）调用 core 纯函数/子进程模块（linkcheck / install）与 state 层（config/state/atomic），S5 改写引擎 7 导出冻结面零改动。崩溃安全顺序「先 state → 再 package.json → 单次 install」（PRD §9 行 306）。

**Tech Stack:** TypeScript ESM + Node ≥22.12 + commander + @clack/prompts + execa + tsup + vitest（运行时依赖零新增；git 为 system 命令调用非依赖）。

**Spec:** `docs/superpowers/specs/2026-09-26-s6-link-direct-design.md`（4 轮 multi-lens 收敛，§4.4 行为契约为权威；本 plan 与 spec 配套阅读，冲突以 spec §4.4 为准——计划期修订 3/4 的 spec 同步见 Task 5）。

## Global Constraints（每个任务隐含遵守）

- **禁止一切 Git 写操作**（用户全局规则）：本 plan 所有任务**无 commit 步骤**，改动由用户自行 commit；任务收尾用 `git status --porcelain -uall` 核对改动面形态
- 终端为 Windows PowerShell：验证命令全部 `pnpm` / `npx vitest` 直跑，禁 bash 脚本
- 相对导入一律带 `.js`；node 内置模块具名导入（`import { join } from 'node:path'`）
- 冻结面零改动：S1 §4.3/§4.4 公共 API、S5 rewriter 恰 7 导出封闭面、S2 workspace / S3 pm / S4 state 既有导出逐字不动；本 plan 新增导出仅 §4.3 所列 + 计划期修订 3/4 所列
- 运行时依赖零新增（package.json 不动；execa/commander/@clack/prompts 既有）
- 原子写 = 临时文件 + rename；宿主项目文件（package.json/.gitignore）不依赖 rename 之外的写坏恢复
- spec §4.4 行为契约逐条 + §9 自决细节 1–8 为行为权威；错误文案以 §6 表为逐字基线
- 测试期子代理运行后必须核对 git status（双 BOM 教训）；测试不落盘任何 fixture 进 src/**
- 单文件编辑后立即 `npx tsc --noEmit --pretty 2>&1 | grep "<该文件目录>"` 检查（P0 规则）；全部任务后全量 tsc

## 计划期修订（评审确认项；含 spec 同步义务）

1. **collectMembers 单一真相抽取**：S2 loadWorkspace 内联的成员展开段（正模式并集 + 负模式剔除 + manifest 严格读取）抽为私有函数 `collectMembers(rootDir, patterns)`，loadWorkspace 与新导出 `listWorkspaceMembers` 共用——spec §4.3「复用 parsePackagesYaml 与 walk 逻辑」的具体化；公共 API 零变化，load-workspace 既有 19 条回归守护
2. **runInstall stdio 细化**：`['inherit', 'inherit', 'pipe']`——stdout/stdin 透传（禁死屏），stderr 管道捕获供 `InstallError.stderrTail`（spec §4.3「stdio 继承」的落地形态）
3. **WatchProcess 增加 `failure` 字段**：`{ pid, exited, kill, failure: Promise<unknown | null> }`——H7「spawn 失败警告」的数据源（正常退出 → null）；spec §4.3 同步 hunk 随 Task 5 执行
4. **新增 `LinkTargetError`** 承载 O5 零命中（spec §6 表漏 O5 行的疏漏补齐）；spec §4.3/§6 表同步 hunk 随 Task 5 执行
5. **计数链定版**：unit **218** = 158 基线 + T1 7 + T2 16 + T3 7 + T4 30；e2e **16** = 11 + 5（spec §7.4 #1 预估 211/16 的定版；T3 评审 I-1 修订 +1）
6. **S1 spec 回写 3 hunk 定位**：行 351（「S1 全为 stub」）、行 352（「S2–S6 逐段填充」）、行 406（分层表 commands/* 行）——精确新旧文本见 Task 5
7. **Task 4 落盘顺序断言收窄**：断言「install（execa mock）被调用时 state.json 与被改写 package.json 均已包含新值」（E6 a/b 先于 c 的关键不变量）；writeState↔writeTextFileAtomic 内部顺序由 spec E6 契约 + 代码走查保证（避免文件级 vi.mock 与其余用例的真实 state 行为冲突）
8. **B4 形态 A 新 fixture**：`tests/fixtures/workspace/lib-root-no-manifest/`（无根 package.json + pnpm-workspace.yaml + 两个成员，3 文件）
9. **e2e 复用** `tests/e2e/helpers.js` 的 `runCli`（spawn 构建 dist）；Task 5 步骤含 `pnpm build` 前置
10. **link-command.test.ts 的 execa mock 双用途分流**：mock 实现按 `cmd === 'git'` 分流（git show / rev-parse 走测试内闭包行为，install 走默认成功）
11. **OCR 修复轮（2026-09-26，open-code-review）**：S6 交付（unit 218 + e2e 16 全绿）后 OCR 评审 15 条意见——严重度分布 **1 critical（O1 PM_BINARY，install.ts yarn 可执行名）+ 4 medium + 10 low**（以 `ocr-out.txt` 原文分级为准；O11 合并 link.ts 两处）→ **12 修复 + 2 关闭**（O12 install.ts package-lock 显式分支保留·自文档化优先；O13 atomic.ts 两函数核心重复不重构·归 S12）。修复项：O1 PM_BINARY 映射、O2 head 选项不可用时不出现、O3 LinkTargetError 字段改 `pkgName`、O4 dry-run flags 复用 `buildInstallCommand`、O5 workspace `validatePatterns` 单源、O6 `Object.hasOwn`、O7 按 manifestPath 分组聚合、O8 严格相等、O9 `collectEntryCandidates` 重写（exports 顶层条件简写）、O10 防御拷贝、O11 删死导入/死字段、O14 嵌套三元展开。计数链 **218 → 222**（T2 +1 = T2-17 / T3 +1 = T3-8 / T4 +2 = T4-31、T4-32；e2e 16 不变）→ 残余修复轮 **222 → 223**（残余① T4-33 dry-run 计划展示可执行名；T3 8→8 / T4 32→33）。**Task 3 / Task 4 代码块为执行前历史文本**，实现以 spec §4.3/§4.4 与账本 OCR 轮记录为准（不逐字重写代码块）；逐条处置见 `.superpowers/sdd/2026-09-26-s6-link-direct.md/ocr-fix-report.md`。

---

### Task 1: 原子文本写 + 成员展开导出（基础设施）

**Files:**
- Modify: `src/state/atomic.ts`（文件末尾追加 writeTextFileAtomic）
- Modify: `src/core/workspace.ts`（私有 collectMembers 抽取 + 文件末尾追加 listWorkspaceMembers）
- Test: `tests/unit/state-files.test.ts`（追加 3 用例 + import 区追加）
- Test: `tests/unit/load-workspace.test.ts`（追加 4 用例 + import 区追加）
- Create: `tests/fixtures/workspace/lib-root-no-manifest/pnpm-workspace.yaml`
- Create: `tests/fixtures/workspace/lib-root-no-manifest/packages/one/package.json`
- Create: `tests/fixtures/workspace/lib-root-no-manifest/packages/two/package.json`

**Interfaces:**
- Consumes: atomic.ts 既有 `writeJsonFileAtomic` 同款 tmp 命名模式（pid + randomUUID + rename）；workspace.ts 既有 `parsePackagesYaml` / `matchWorkspacePattern` / `readManifest` / `WorkspaceNotFoundError` / `WorkspacePatternError`（均私有或既有导出，零改动）
- Produces: `writeTextFileAtomic(filePath: string, content: string): void`；`listWorkspaceMembers(rootDir: string): Promise<PackageJsonInfo[]>`（Task 4 消费；签名 = spec §4.3 逐字）

- [ ] **Step 1: 写失败测试（state-files.test.ts 追加）**

在文件 import 区追加（并入现有 node:fs 具名导入，保持字母序；`writeTextFileAtomic` 来自 `../../src/state/atomic.js`——若该文件尚未 import atomic 模块则新增 import 行）：

```ts
import { writeTextFileAtomic } from '../../src/state/atomic.js'
```

文件末尾追加：

```ts
describe('writeTextFileAtomic（S6 spec §4.3）', () => {
  it('用例 T1-1：逐字节写回（BOM/CRLF/中文 byte 级保真）且无 tmp 残留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const p = join(dir, 'package.json')
      const content = '\uFEFF{\r\n  "name": "包",\r\n  "dependencies": {\r\n    "x": "link:../lib"\r\n  }\r\n}\r\n'
      writeTextFileAtomic(p, content)
      expect(readFileSync(p, 'utf8')).toBe(content)
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用例 T1-2：目标为已存在目录 → rename 失败 → 原错误重抛且 tmp 清理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const target = join(dir, 'occupied')
      mkdirSync(target)
      expect(() => writeTextFileAtomic(target, 'x')).toThrow()
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('用例 T1-3：父目录缺失 → write 失败重抛且目标不存在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-tfa-'))
    try {
      const p = join(dir, 'no-such', 'package.json')
      expect(() => writeTextFileAtomic(p, 'x')).toThrow()
      expect(existsSync(p)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: 跑 RED**

Run: `npx vitest run tests/unit/state-files.test.ts`
Expected: FAIL——import ERROR（`writeTextFileAtomic` 导出不存在）

- [ ] **Step 3: 实现 writeTextFileAtomic（atomic.ts 末尾追加）**

```ts
/** 文本级原子写（S6 spec §4.3）：writeJsonFileAtomic 同款 tmp 命名（pid + uuid）+ rename；
 *  content 逐字节 utf8 落盘——无 BOM/换行/转义转换（package.json 格式保真由 S5 引擎产出保证）。
 *  失败语义：写入/rename 失败 → 清理孤儿 tmp 后原错误重抛。 */
export function writeTextFileAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath) // Node 在 Windows 对已存在目标可覆盖（REPLACE_EXISTING 语义）；目标为目录时抛错
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
```

imports 零新增（randomUUID/renameSync/rmSync/writeFileSync 均已在位）。

- [ ] **Step 4: 跑 GREEN**

Run: `npx vitest run tests/unit/state-files.test.ts`
Expected: PASS（既有 25 + 新 3 = 28）

- [ ] **Step 5: 写失败测试（load-workspace.test.ts 追加）**

import 区并入：`import { listWorkspaceMembers } from '../../src/core/workspace.js'`（加进现有 workspace.js 导入块）。文件末尾追加：

```ts
describe('listWorkspaceMembers（S6 spec §4.3 B4 形态 A / 计划期修订 1）', () => {
  const relsOf = (members: PackageJsonInfo[], rootDir: string) =>
    members.map((m) => path.relative(rootDir, m.dir).replaceAll('\\', '/')).sort()

  it('用例 T1-4：正常展开 + 负模式剔除（复用 monorepo-pnpm fixture，isRoot 全 false）', async () => {
    const rootDir = FIX('monorepo-pnpm')
    const members = await listWorkspaceMembers(rootDir)
    expect(relsOf(members, rootDir)).toEqual(['apps/web', 'docs', 'packages/server'])
    expect(members.every((m) => !m.isRoot)).toBe(true)
    expect(members.some((m) => m.dir.includes('legacy'))).toBe(false)
  })

  it('用例 T1-5：无 pnpm-workspace.yaml → invalid-root（single-package fixture）', async () => {
    await expect(listWorkspaceMembers(FIX('single-package'))).rejects.toThrowError(WorkspaceNotFoundError)
  })

  it('用例 T1-6：空 patterns → 空数组（monorepo-empty-patterns fixture）', async () => {
    expect(await listWorkspaceMembers(FIX('monorepo-empty-patterns'))).toEqual([])
  })

  it('用例 T1-7：形态 A——根无 package.json 仍可展开（lib-root-no-manifest fixture）', async () => {
    const rootDir = FIX('lib-root-no-manifest')
    const members = await listWorkspaceMembers(rootDir)
    expect(relsOf(members, rootDir)).toEqual(['packages/one', 'packages/two'])
    expect(members.map((m) => m.name).sort()).toEqual(['lib-one', 'lib-two'])
  })
})
```

import 区还需并入 `type PackageJsonInfo`（加进现有 workspace.js 导入块）。

- [ ] **Step 6: 创建形态 A fixture（3 文件）**

`tests/fixtures/workspace/lib-root-no-manifest/pnpm-workspace.yaml`：

```yaml
packages:
  - 'packages/*'
```

`tests/fixtures/workspace/lib-root-no-manifest/packages/one/package.json`：

```json
{ "name": "lib-one" }
```

`tests/fixtures/workspace/lib-root-no-manifest/packages/two/package.json`：

```json
{ "name": "lib-two" }
```

- [ ] **Step 7: 跑 RED**

Run: `npx vitest run tests/unit/load-workspace.test.ts`
Expected: FAIL——import ERROR（`listWorkspaceMembers` 不存在）

- [ ] **Step 8: 重构 workspace.ts——抽 collectMembers（行为零变化）**

将 loadWorkspace 内 `if (patterns.length > 0) { ... }` 成员展开段（正模式/负模式/collected/walk/hit Set/成员 push 全部）抽为私有函数，loadWorkspace 改为调用：

```ts
/** loadWorkspace 与 listWorkspaceMembers 共用的成员展开（计划期修订 1：单一真相抽取）。
 *  patterns 为空 → 空数组；正模式并集（Set 保持首次命中序 = DFS 字典序）→ 依序负模式剔除；
 *  命中目录无 package.json → 非成员（后代已在 collected 中）；manifest 严格读取（§4.2 读取规约）。 */
function collectMembers(rootDir: string, patterns: string[]): PackageJsonInfo[] {
  if (patterns.length === 0) return []
  const positives = patterns.filter((p) => !p.startsWith('!'))
  const negatives = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  const collected: string[] = []
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      collected.push(childRel)
      walk(path.join(dir, entry.name), childRel)
    }
  }
  walk(rootDir, '')
  const hit = new Set<string>()
  for (const rel of collected) {
    if (positives.some((p) => matchWorkspacePattern(p, rel))) hit.add(rel)
  }
  const out: PackageJsonInfo[] = []
  for (const rel of hit) {
    if (negatives.some((p) => matchWorkspacePattern(p, rel))) continue
    const manifestPath = path.join(rootDir, rel, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readManifest(manifestPath)
    out.push({
      dir: path.join(rootDir, rel),
      manifestPath,
      name: typeof manifest['name'] === 'string' ? manifest['name'] : '',
      isRoot: false,
    })
  }
  return out
}
```

loadWorkspace 尾部改为：

```ts
  const members: PackageJsonInfo[] = [
    {
      dir: rootDir,
      manifestPath: rootManifestPath,
      name: typeof rootManifest['name'] === 'string' ? rootManifest['name'] : '',
      isRoot: true,
    },
  ]
  members.push(...collectMembers(rootDir, patterns))
  return { rootDir, manifestFormat, members }
```

- [ ] **Step 9: 实现 listWorkspaceMembers（workspace.ts 末尾追加）**

```ts
/** B4 形态 A（S6 spec §4.3/§4.4 B1）：lib 路径是无 package.json 的 pnpm monorepo 根
 *  （本地有 pnpm-workspace.yaml）→ 解析 packages patterns 展开成员（不含根——根无 manifest）。
 *  无 pnpm-workspace.yaml → WorkspaceNotFoundError('invalid-root')；成员展开与 loadWorkspace
 *  共用 collectMembers（单一真相）；pattern 语义错误前置校验（同 loadWorkspace 重抛机制）。 */
export async function listWorkspaceMembers(rootDir: string): Promise<PackageJsonInfo[]> {
  const yamlPath = path.join(rootDir, 'pnpm-workspace.yaml')
  if (!existsSync(yamlPath)) {
    throw new WorkspaceNotFoundError(
      'invalid-root',
      `${rootDir} 不是 npm 包（缺 package.json）且缺 pnpm-workspace.yaml，无法作为 lib 链接。请确认路径指向包目录或 pnpm monorepo 根。`,
    )
  }
  const patterns = parsePackagesYaml(readFileSync(yamlPath, 'utf8'), yamlPath)
  for (const p of patterns) {
    try {
      matchWorkspacePattern(p, '')
    } catch (e) {
      if (e instanceof WorkspacePatternError) {
        throw new WorkspacePatternError(
          e.pattern,
          yamlPath,
          e.message.replace('）。支持：', `）。清单：${yamlPath}。支持：`),
        )
      }
      throw e
    }
  }
  return collectMembers(rootDir, patterns)
}
```

- [ ] **Step 10: 跑 GREEN + 回归 + typecheck**

Run: `npx vitest run tests/unit/load-workspace.test.ts` → PASS（19 + 4 = 23）
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/"` → 零错误（grep 空）
Run: `npx vitest run tests/unit` → 165 passed（158 + 7）

- [ ] **Step 11: git status 核对**

Run: `git status --porcelain -uall`
Expected: `M src/state/atomic.ts`、`M src/core/workspace.ts`、`M tests/unit/state-files.test.ts`、`M tests/unit/load-workspace.test.ts`、`?? tests/fixtures/workspace/lib-root-no-manifest/`（4 M + 1 新目录）——**无 BOM 异常形态**（fixture yaml/json 均新建纯 ASCII）

---

### Task 2: 前置检查 core/linkcheck.ts

**Files:**
- Create: `src/core/linkcheck.ts`
- Test: `tests/unit/linkcheck.test.ts`（新建，16 用例）

**Interfaces:**
- Consumes: node:fs / node:path 内置；无跨模块依赖（core 内独立，分层规则）
- Produces: `checkLib(libDirAbs, opts): LibCheckOk`、`LibCheckError(kind, libDirAbs, message)`、`LibCheckKind`、`LibCheckOk`、`LibCheckOptions`（spec §4.3 逐字；Task 4 消费）

- [ ] **Step 1: 写失败测试（新建 tests/unit/linkcheck.test.ts）**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibCheckError, checkLib } from '../../src/core/linkcheck.js'

const dirs: string[] = []
function makeLib(files: Record<string, string> = {}, extra: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-check-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  extra(dir)
  return dir
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const OK_MANIFEST = JSON.stringify({ name: '@t/lib', main: './index.js', scripts: { 'build:watch': 'echo' } })

describe('checkLib（S6 spec §4.4 C 七 kind 正反）', () => {
  it('T2-1 dir-missing：目录不存在', () => {
    expect(() => checkLib(join('Z:', 'no-such-dir-xyz'))).toThrowError(LibCheckError)
    try {
      checkLib(join('Z:', 'no-such-dir-xyz'))
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('dir-missing')
      expect((e as Error).message).toContain('路径不存在')
    }
  })

  it('T2-2 dir-missing：路径是文件非目录', () => {
    const dir = makeLib({ 'file.txt': 'x' })
    expect(() => checkLib(join(dir, 'file.txt'))).toThrowError(LibCheckError)
  })

  it('T2-3 manifest-missing：目录无 package.json', () => {
    const dir = makeLib()
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('manifest-missing')
      expect((e as Error).message).toContain('不是 npm 包')
    }
  })

  it('T2-4 manifest-invalid：坏 JSON', () => {
    const dir = makeLib({ 'package.json': '{oops' })
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('manifest-invalid')
    }
  })

  it('T2-5 manifest-invalid：BOM + 坏 JSON（剥 BOM 后仍坏）', () => {
    const dir = makeLib({ 'package.json': '\uFEFF{oops' })
    expect(() => checkLib(dir)).toThrowError(LibCheckError)
  })

  it('T2-6 name-mismatch：expectedName 传入且 lib name 不等（B7）', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    try {
      checkLib(dir, { expectedName: '@t/old-name' })
      expect.unreachable()
    } catch (e) {
      const err = e as LibCheckError
      expect(err.kind).toBe('name-mismatch')
      expect(err.message).toContain('请更新 lpm.config.json')
    }
  })

  it('T2-7 name 一致通过', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir, { expectedName: '@t/lib' }).name).toBe('@t/lib')
  })

  it('T2-8 name 空串跳过一致性', () => {
    const dir2 = makeLib({ 'package.json': JSON.stringify({ main: './index.js' }), 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir2, { expectedName: 'whatever' }).name).toBe('')
  })

  it('T2-9 entry-missing：main 指向缺失文件', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'node_modules/.keep': '' })
    try {
      checkLib(dir)
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('entry-missing')
      expect((e as Error).message).toContain('先 build')
    }
  })

  it('T2-10 entry-missing：exports.default 指向缺失文件', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { default: './dist/x.js' } } }),
      'node_modules/.keep': '',
    })
    expect(() => checkLib(dir)).toThrowError(LibCheckError)
  })

  it('T2-11 通过：main 存在', () => {
    const dir = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(checkLib(dir).manifestPath).toBe(join(dir, 'package.json'))
  })

  it('T2-12 通过：exports.import 存在', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { import: './esm/x.js' } } }),
      'esm/x.js': '',
      'node_modules/.keep': '',
    })
    expect(checkLib(dir).name).toBe('@t/lib')
  })

  it('T2-13 豁免：无 exports 无 main', () => {
    const dir = makeLib({ 'package.json': JSON.stringify({ name: '@t/lib' }), 'node_modules/.keep': '' })
    expect(checkLib(dir).name).toBe('@t/lib')
  })

  it('T2-14 豁免：exports 仅 types', () => {
    const dir = makeLib({
      'package.json': JSON.stringify({ name: '@t/lib', exports: { '.': { types: './x.d.ts' } } }),
      'node_modules/.keep': '',
    })
    expect(() => checkLib(dir)).not.toThrowError()
  })

  it('T2-15 node-modules-empty：目录不存在 / readdir 空；非空通过', () => {
    const a = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '' })
    expect(() => checkLib(a)).toThrowError(/node_modules 为空/)
    const b = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(() => checkLib(b)).not.toThrowError()
  })

  it('T2-16 watch-script-missing：缺 script / 非串；有则通过', () => {
    const a = makeLib({ 'package.json': JSON.stringify({ name: '@t/lib', main: './index.js' }), 'index.js': '', 'node_modules/.keep': '' })
    try {
      checkLib(a, { expectWatchScript: true })
      expect.unreachable()
    } catch (e) {
      expect((e as LibCheckError).kind).toBe('watch-script-missing')
    }
    const b = makeLib({ 'package.json': OK_MANIFEST, 'index.js': '', 'node_modules/.keep': '' })
    expect(() => checkLib(b, { expectWatchScript: true })).not.toThrowError()
  })
})
```

- [ ] **Step 2: 跑 RED**

Run: `npx vitest run tests/unit/linkcheck.test.ts`
Expected: FAIL——resolve ERROR（`src/core/linkcheck.js` 不存在）

- [ ] **Step 3: 实现 src/core/linkcheck.ts**

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 前置检查（S6 spec §4.4 C；PRD §6.1 行 97 + §11 错误表；B5/B7 修复落点）。
// 纯函数：无子进程、无状态层依赖；错误 message 首行即用户文案（S2 错误类惯例）。

export type LibCheckKind =
  | 'dir-missing' | 'manifest-missing' | 'manifest-invalid'
  | 'entry-missing' | 'name-mismatch' | 'node-modules-empty' | 'watch-script-missing'

export class LibCheckError extends Error {
  constructor(
    public kind: LibCheckKind,
    public libDirAbs: string,
    message: string,
  ) {
    super(message)
    this.name = 'LibCheckError'
  }
}

export interface LibCheckOk {
  name: string          // lib package.json name（缺失为空串）
  manifestPath: string  // lib package.json 绝对路径
}

export interface LibCheckOptions {
  expectedName?: string | null   // 通讯录 key（B7 判定）；null/缺省跳过
  expectWatchScript?: boolean    // --watch 时为 true
}

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}

/** 剥 BOM 解析 lib package.json（§4.4 C3）；坏 JSON/根值非对象 → manifest-invalid */
function readLibManifest(manifestPath: string, libDirAbs: string): Record<string, unknown> {
  let source: string
  try {
    source = readFileSync(manifestPath, 'utf8')
  } catch {
    throw new LibCheckError('manifest-invalid', libDirAbs, `${manifestPath} 无法读取。请确认文件可读。`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source)
  } catch (e) {
    throw new LibCheckError('manifest-invalid', libDirAbs, `${manifestPath} 不是合法 JSON（${(e as Error).message}）。请修正后重试。`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LibCheckError('manifest-invalid', libDirAbs, `${manifestPath} 不是合法的 package.json（根值不是 JSON 对象）。请修正后重试。`)
  }
  return parsed as Record<string, unknown>
}

/** exports '.' 主入口字符串候选（§4.4 C5：直接字符串，或 import/require/node/default 子键中的字符串值） */
function collectEntryCandidates(value: unknown): string[] {
  const out: string[] = []
  const fromCondition = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v)
      return
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      for (const key of ['default', 'import', 'node', 'require']) {
        if (typeof obj[key] === 'string') out.push(obj[key] as string)
      }
    }
  }
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    const dot = obj['.']
    if (typeof dot === 'string') out.push(dot)
    else if (dot !== null && typeof dot === 'object' && !Array.isArray(dot)) fromCondition(dot)
  }
  return out
}

/** 解析入口候选绝对路径（exports → main；无扩展名候选视为目录语义补 index.js）；
 *  无可取得候选（无 exports 无 main，或仅 types）→ null（B5 豁免面） */
function resolveEntryCandidates(libDirAbs: string, manifest: Record<string, unknown>): string[] | null {
  let candidates = collectEntryCandidates(manifest['exports'])
  if (candidates.length === 0 && typeof manifest['main'] === 'string') {
    candidates = [manifest['main'] as string]
  }
  if (candidates.length === 0) return null
  const out: string[] = []
  for (const c of candidates) {
    const abs = resolve(libDirAbs, c)
    out.push(abs)
    if (!/\.[^./\\]+$/.test(c)) out.push(join(abs, 'index.js'))
  }
  return out
}

/** 前置检查纯函数（B5 修复落点）。步骤序与错误 kind 见 spec §4.4 C；任一失败抛 LibCheckError。 */
export function checkLib(libDirAbs: string, opts: LibCheckOptions = {}): LibCheckOk {
  if (!isDirectory(libDirAbs)) {
    throw new LibCheckError('dir-missing', libDirAbs, `路径不存在或不是目录：${libDirAbs}。支持绝对路径、相对路径（相对当前目录）；含空格请加引号。`)
  }
  const manifestPath = join(libDirAbs, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new LibCheckError('manifest-missing', libDirAbs, `${libDirAbs} 不是 npm 包（缺 package.json）。请确认路径指向包目录。`)
  }
  const manifest = readLibManifest(manifestPath, libDirAbs)
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : ''
  if (opts.expectedName != null && opts.expectedName !== '' && name !== '' && name !== opts.expectedName) {
    throw new LibCheckError('name-mismatch', libDirAbs, `lib 实际 name（${name}）≠ 通讯录 key（${opts.expectedName}）。请更新 lpm.config.json 中 libs 键为 ${name} 后重试。`)
  }
  const entryCandidates = resolveEntryCandidates(libDirAbs, manifest)
  if (entryCandidates !== null && !entryCandidates.some((p) => existsSync(p))) {
    throw new LibCheckError('entry-missing', libDirAbs, `入口产物缺失：${entryCandidates[0]}。先 build 或起 build:watch 后重试。`)
  }
  const nmDir = join(libDirAbs, 'node_modules')
  let nmEmpty = true
  if (existsSync(nmDir) && statSync(nmDir).isDirectory()) nmEmpty = readdirSync(nmDir).length === 0
  if (nmEmpty) {
    throw new LibCheckError('node-modules-empty', libDirAbs, `${libDirAbs} 的 node_modules 为空。先在 ${libDirAbs} 执行包管理器 install。`)
  }
  if (opts.expectWatchScript === true) {
    const scripts = manifest['scripts']
    const has = scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)
      && typeof (scripts as Record<string, unknown>)['build:watch'] === 'string'
    if (!has) {
      throw new LibCheckError('watch-script-missing', libDirAbs, `${libDirAbs} 缺 build:watch script。请在 lib package.json 的 scripts 补充后重试，或去掉 --watch。`)
    }
  }
  return { name, manifestPath }
}
```

- [ ] **Step 4: 跑 GREEN + typecheck**

Run: `npx vitest run tests/unit/linkcheck.test.ts` → 16 passed
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/core/linkcheck"` → 零输出

- [ ] **Step 5: git status 核对**

Run: `git status --porcelain -uall`
Expected: 新增 `?? src/core/linkcheck.ts`、`?? tests/unit/linkcheck.test.ts`（Task 1 的 M 形态保持）

---

### Task 3: install/watch 子进程构造 core/install.ts

**Files:**
- Create: `src/core/install.ts`
- Test: `tests/unit/install.test.ts`（新建，7 用例）

**Interfaces:**
- Consumes: `subdivideYarn(rootDir)` 与 `PackageManagerId`（core/pm.js 既有导出，零改动）；execa（既有依赖）
- Produces: `buildInstallCommand(pm): readonly string[]`、`InstallError(command, exitCode, stderrTail, message)`、`runInstall(rootDir, pm): Promise<void>`、`detectLibPM(libDirAbs): PackageManagerId`、`WatchProcess { pid; exited; kill; failure }`、`spawnBuildWatch(libDirAbs, pm): WatchProcess`（Task 4 消费；spec §4.3 + 计划期修订 3）

- [ ] **Step 1: 写失败测试（新建 tests/unit/install.test.ts）**

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { InstallError, buildInstallCommand, detectLibPM, runInstall, spawnBuildWatch } from '../../src/core/install.js'

const dirs: string[] = []
function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'lpm-inst-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  return dir
}
afterEach(() => {
  vi.mocked(execa).mockReset()
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('buildInstallCommand（spec §2 裁决 3 单源表）', () => {
  it('T3-1：四 PM 全表', () => {
    expect(buildInstallCommand('pnpm')).toEqual(['install', '--no-frozen-lockfile'])
    expect(buildInstallCommand('npm')).toEqual(['install'])
    expect(buildInstallCommand('yarn-classic')).toEqual(['install', '--no-frozen-lockfile'])
    expect(buildInstallCommand('yarn-berry')).toEqual(['install', '--no-immutable'])
  })
})

describe('detectLibPM（lib 目录 lockfile 探测）', () => {
  it('T3-2：pnpm-lock / package-lock / 无证据回退 npm', () => {
    expect(detectLibPM(makeDir({ 'pnpm-lock.yaml': '' }))).toBe('pnpm')
    expect(detectLibPM(makeDir({ 'package-lock.json': '' }))).toBe('npm')
    expect(detectLibPM(makeDir())).toBe('npm')
  })
  it('T3-3：yarn 细分——.yarnrc.yml → berry；裸 yarn.lock → classic', () => {
    expect(detectLibPM(makeDir({ 'yarn.lock': '', '.yarnrc.yml': '' }))).toBe('yarn-berry')
    expect(detectLibPM(makeDir({ 'yarn.lock': '# yarn lockfile v1\n' }))).toBe('yarn-classic')
  })
})

describe('runInstall', () => {
  it('T3-4：成功——execa 以根目录 + stdio 管道形态调用（计划期修订 2）', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({ exitCode: 0 } as never)
    await runInstall(dir, 'pnpm')
    expect(execa).toHaveBeenCalledWith('pnpm', ['install', '--no-frozen-lockfile'], { cwd: dir, stdio: ['inherit', 'inherit', 'pipe'] })
  })
  it('T3-5：失败 → InstallError（command/exitCode/stderrTail/文案含「state 已保留」）', async () => {
    vi.mocked(execa).mockRejectedValue({ exitCode: 1, stderr: 'boom line' })
    try {
      await runInstall(makeDir(), 'npm')
      expect.unreachable()
    } catch (e) {
      const err = e as InstallError
      expect(err).toBeInstanceOf(InstallError)
      expect(err.command).toBe('npm install')
      expect(err.exitCode).toBe(1)
      expect(err.stderrTail).toBe('boom line')
      expect(err.message).toContain('state 已保留')
      expect(err.message).toContain('可抛弃重建')
    }
  })
})

describe('spawnBuildWatch', () => {
  it('T3-6：spawn 参数 / pid 透传 / kill 转发 / failure 正常退出为 null', async () => {
    const dir = makeDir()
    const fakeChild = {
      pid: 4321,
      kill: vi.fn(),
      then: (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve({ exitCode: 0 }).then(onF, onR),
    }
    vi.mocked(execa).mockReturnValue(fakeChild as never)
    const w = spawnBuildWatch(dir, 'yarn-berry')
    expect(execa).toHaveBeenCalledWith('yarn-berry', ['run', 'build:watch'], { cwd: dir, stdio: 'inherit', reject: false })
    expect(w.pid).toBe(4321)
    w.kill()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    await expect(w.failure).resolves.toBeNull()
    await expect(w.exited).resolves.toBeUndefined()
  })

  it('T3-7：spawn 失败（reject:false 以 Error 实例 resolve，Task 3 评审 I-1）→ failure 携带 shortMessage', async () => {
    const dir = makeDir()
    vi.mocked(execa).mockResolvedValue({
      failed: true,
      exitCode: undefined,
      shortMessage: 'Command failed with ENOENT: pnpm run build:watch',
    } as never)
    const w = spawnBuildWatch(dir, 'pnpm')
    await expect(w.failure).resolves.toMatchObject({ message: 'Command failed with ENOENT: pnpm run build:watch' })
    await expect(w.exited).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑 RED**

Run: `npx vitest run tests/unit/install.test.ts`
Expected: FAIL——resolve ERROR（`src/core/install.js` 不存在）

- [ ] **Step 3: 实现 src/core/install.ts**

```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execa } from 'execa'
import { subdivideYarn, type PackageManagerId } from './pm.js'

// install/watch 子进程构造（S6 spec §4.3 + §2 裁决 2/3）。core 不依赖 state（S1 §3 分层）。

/** per-PM install 参数单源表（§2 裁决 3）：全部显式关闭冻结，本地/CI 行为一致 */
const INSTALL_ARGS_BY_PM: Record<PackageManagerId, readonly string[]> = {
  pnpm: ['install', '--no-frozen-lockfile'],
  npm: ['install'],
  'yarn-classic': ['install', '--no-frozen-lockfile'],
  'yarn-berry': ['install', '--no-immutable'],
}

export function buildInstallCommand(pm: PackageManagerId): readonly string[] {
  return INSTALL_ARGS_BY_PM[pm]
}

export class InstallError extends Error {
  constructor(
    public command: string,       // 展示用完整命令行
    public exitCode: number | null,
    public stderrTail: string,    // 子进程 stderr 末尾（≤2000 字符）
    message: string,
  ) {
    super(message)
    this.name = 'InstallError'
  }
}

/** 单次 install（workspace 根执行；stdout/stdin 继承透传——禁死屏；stderr 管道捕获供诊断——计划期修订 2） */
export async function runInstall(rootDir: string, pm: PackageManagerId): Promise<void> {
  const args = [...buildInstallCommand(pm)]
  const command = `${pm} ${args.join(' ')}`
  try {
    await execa(pm, args, { cwd: rootDir, stdio: ['inherit', 'inherit', 'pipe'] })
  } catch (err) {
    const e = err as { exitCode?: number | null; stderr?: string | undefined }
    const stderrTail = (e.stderr ?? '').slice(-2000)
    throw new InstallError(
      command,
      e.exitCode ?? null,
      stderrTail,
      `install 失败（exit ${e.exitCode ?? '未知'}）：${stderrTail !== '' ? stderrTail : command}\n`
        + 'state 已保留，可直接重跑 lpm link；若需彻底重来：① git checkout -- <受影响>/package.json ② 删除 .lpm/ ③ 在 workspace 根重跑一次 install——lpm 状态可抛弃重建',
    )
  }
}

/** lib 自身 PM 探测（§2 裁决 2）：lib 目录 lockfile——pnpm-lock→pnpm；yarn.lock→subdivideYarn；
 *  package-lock→npm；无证据 → 'npm'（回退）；多 lockfile 共存按 pnpm-lock > yarn.lock > package-lock
 *  首个命中（对齐 S3 LOCKFILE_ORDER 探测精神） */
export function detectLibPM(libDirAbs: string): PackageManagerId {
  if (existsSync(join(libDirAbs, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(libDirAbs, 'yarn.lock'))) return subdivideYarn(libDirAbs)
  if (existsSync(join(libDirAbs, 'package-lock.json'))) return 'npm'
  return 'npm'
}

export interface WatchProcess {
  pid: number
  exited: Promise<void>
  kill: () => void
  /** resolve 为子进程失败原因（spawn 失败/非零退出）；正常退出 → null——H7 警告数据源（计划期修订 3） */
  failure: Promise<unknown | null>
}

/** 拉起 lib 的 build:watch 子进程：<pm> run build:watch，cwd=libDir，stdio 继承，前台。
 *  前置检查已保证 script 存在；调用方经 exited 驻留、kill 终止、failure 出警告（§4.4 H） */
export function spawnBuildWatch(libDirAbs: string, pm: PackageManagerId): WatchProcess {
  const child = execa(pm, ['run', 'build:watch'], { cwd: libDirAbs, stdio: 'inherit', reject: false })
  const outcome = child.then(
    (r) => {
      if (r.exitCode === 0) return null
      // execa ^10 reject:false：spawn 失败（ENOENT 等）以 ExecaError 实例 resolve 而非 reject
      //（Task 3 评审 I-1）——优先取 shortMessage 携带原始 cause，防 H7 警告原因串降级为 'exit undefined'
      const e = r as { shortMessage?: string; message?: string }
      return new Error(e.shortMessage ?? e.message ?? `exit ${r.exitCode}`)
    },
    (err) => err,
  )
  const exited = outcome.then(
    () => undefined,
    () => undefined,
  )
  return {
    pid: child.pid ?? -1,
    exited,
    kill: () => {
      void child.kill('SIGTERM')
    },
    failure: outcome,
  }
}
```

- [ ] **Step 4: 跑 GREEN + typecheck**

Run: `npx vitest run tests/unit/install.test.ts` → 7 passed
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/core/install"` → 零输出
Run: `npx vitest run tests/unit` → **188 passed**（181 + 7）

- [ ] **Step 5: git status 核对**

Run: `git status --porcelain -uall`
Expected: 新增 `?? src/core/install.ts`、`?? tests/unit/install.test.ts`

---

### Task 4: 编排主流程 commands/link.ts

**Files:**
- Create: `src/commands/link.ts`
- Test: `tests/unit/link-command.test.ts`（新建，30 用例）

**Interfaces:**
- Consumes: Task 1 `writeTextFileAtomic` / `listWorkspaceMembers`；Task 2 `checkLib`/`LibCheckError`；Task 3 五件套；S5 `mapProtocol`/`rewriteDepValue`/`findDepEntries`/`ProtocolPathError`；S2 `findWorkspaceRoot`/`loadWorkspace`/`findDependents`/错误类；S3 `resolvePackageManager`/错误类；S4 `readProjectConfig`/`writeProjectConfig`/`readState`/`writeState`/`writeLast`/错误类 + `ProjectLpmConfig`/`LinkState` 类型
- Produces: `runLink(targets, opts, cwd?): Promise<number>`、`LinkOptions`、`LinkArgumentError`、`LinkInteractionError`、`LinkTargetError`（计划期修订 4）——Task 5 cli.ts 消费 `runLink` + `LinkOptions`

- [ ] **Step 1: 写失败测试（新建 tests/unit/link-command.test.ts）**

文件头（mock + 工厂 + 捕获，与 use-command.test.ts 同款模式 + execa mock 双用途分流）：

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}))
vi.mock('execa', () => ({ execa: vi.fn() }))

import { execa } from 'execa'
import { select, text, isCancel } from '@clack/prompts'
import { runLink } from '../../src/commands/link.js'

const dirs: string[] = []

/** workspace：pnpm-workspace（apps/web 依赖 @t/lib ^1.0.0）+ config（packageManager=pnpm）+ lockfile */
function makeWs(files: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'lpm-link-'))
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

/** lib：sibling 于 ws（同盘），name=@t/lib，main 可解析，node_modules 非空，build:watch 有 */
function makeLib(withWatch = true): string {
  const lib = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
  dirs.push(join(lib, '..'))
  const manifest: Record<string, unknown> = { name: '@t/lib', main: './index.js' }
  if (withWatch) (manifest as { scripts: object }).scripts = { 'build:watch': 'echo watch' }
  writeFileSync(join(lib, 'package.json'), JSON.stringify(manifest), 'utf8')
  mkdirSync(join(lib, 'node_modules'), { recursive: true })
  writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
  writeFileSync(join(lib, 'index.js'), 'export = 1;\n', 'utf8')
  return lib
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
function cfgOf(ws: string): { libs: Record<string, string> } {
  return JSON.parse(readFileSync(join(ws, 'lpm.config.json'), 'utf8'))
}
function stateOf(ws: string): { links: Record<string, { original: Record<string, string>; linkedAt: string }> } | null {
  const p = join(ws, '.lpm', 'state.json')
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null
}
const relPkg = (root: string, dir: string) => join(root, dir, 'package.json')

beforeEach(() => {
  vi.mocked(execa).mockImplementation(async (cmd: unknown, args: unknown[]) => {
    if (cmd === 'git') {
      const op = (args as string[])[0]
      if (op === 'rev-parse') return { stdout: dirs[0] ?? '' } as never // 仓库根 ≈ 第一临时目录（测试内仅验证调用形态）
      if (op === 'show') {
        // git show HEAD:<path> → 返回预置 HEAD 版 manifest 文本（依赖项为 registry range）
        return { stdout: JSON.stringify({ name: 'x', dependencies: { '@t/lib': '^0.9.0' } }) } as never
      }
      return { stdout: '' } as never
    }
    return { exitCode: 0 } as never // install 成功
  })
  vi.mocked(isCancel).mockReturnValue(false)
})
afterEach(() => {
  vi.restoreAllMocks()
  stubTty(undefined)
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})
```

用例（30 条，按 spec §7.2 清单编号；每条独立搭建 fixture；T4-23c/T4-28/T4-29 覆盖 spec §7.2 #18/#11/#19）：

```ts
describe('A. 参数与入口', () => {
  it('T4-1 无参数 → 用法提示 + exit 1', async () => {
    const cap = captureOut()
    expect(await runLink([], {})).toBe(1)
    expect(cap.stdout()).toContain('lpm link <名字|路径>')
  })
  it('T4-2 未注册名 → #12 文案 + exit 1', async () => {
    const ws = makeWs()
    const cap = captureOut()
    expect(await runLink(['nope'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('未知注册名/路径不存在')
    expect(cap.stderr()).toContain('已注册')
  })
  it('T4-3 注册名命中：全链成功（config 幂等不重写 mtime）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPathOf(ws, lib) } }))
    const before = statSync(join(ws, 'lpm.config.json')).mtimeMs
    const cap = captureOut()
    expect(await runLink(['@t/lib'], {}, ws)).toBe(0)
    expect(statSync(join(ws, 'lpm.config.json')).mtimeMs).toBe(before) // 同值 upsert 不写（D2）
    expect(cap.stdout()).toContain('链接完成')
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toContain('"link:')
    const st = stateOf(ws)
    expect(st?.links['@t/lib']?.original).toBeTruthy()
    expect(new Date(st?.links['@t/lib']?.linkedAt ?? '').toISOString()).toBe(st?.links['@t/lib']?.linkedAt) // ISO 8601
  })
  it('T4-4 libs 值非串 → #12', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { broken: 42 } }) })
    const cap = captureOut()
    expect(await runLink(['broken'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('注册值损坏')
  })
  it('T4-5 未注册 scoped 名 → #12 双提示（非 dir-missing 误导，A3）', async () => {
    const ws = makeWs()
    const cap = captureOut()
    expect(await runLink(['@other/pkg'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('已注册')
    expect(cap.stderr()).toContain('先注册')
  })
  it('T4-6 路径分支全链：config 写入 key=lib name + 正斜杠相对路径', async () => {
    const ws = makeWs()
    const lib = makeLib()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBe(relPathOf(ws, lib))
    const st = stateOf(ws)
    expect(Object.keys(st?.links['@t/lib']?.original ?? {})).toEqual([relPathOf(ws, 'apps/web') + '/package.json'])
  })
  it('T4-7 detected PM 提示行（config 无 packageManager）', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    const cap = captureOut()
    expect(await runLink([], {}, ws)).toBe(1) // 无 targets 提前退出，但 PM 提示在 A1 之后——改用带 targets
  })
})
```

——T4-7 需带 targets（A1 在 PM 解析前），修正为：

```ts
  it('T4-7 detected PM 提示行（config 无 packageManager → lockfile 推断 pnpm）', async () => {
    const ws = makeWs({ 'lpm.config.json': JSON.stringify({ version: 1, libs: {} }) })
    const lib = makeLib()
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('检测到包管理器：pnpm')
  })

describe('A4/B4 交互', () => {
  it('T4-8 PMAmbiguous 透传 exit 1', async () => {
    const ws = makeWs({
      'package-lock.json': '',
      'lpm.config.json': JSON.stringify({ version: 1, libs: {} }), // 去掉 packageManager → 推断 → 双 lockfile 歧义
    })
    const cap = captureOut()
    expect(await runLink(['@t/lib'], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('多个 lockfile')
  })
  it('T4-9 B4 形态 B：monorepo lib → select 选成员 → 链接成员', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-mono-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib', main: './index.js', scripts: {} }), 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/index.js'), '', 'utf8')
    mkdirSync(join(mono, 'pkgs/inner/node_modules'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/node_modules/.keep'), '', 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue(join(mono, 'pkgs/inner'))
    expect(await runLink([mono], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBe(relPathOf(ws, join(mono, 'pkgs/inner')))
  })
  it('T4-10 B4 非 TTY → #13', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-mono-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib' }), 'utf8')
    const cap = captureOut()
    expect(await runLink([mono], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('monorepo 根')
    expect(cap.stderr()).toContain('无法交互')
  })
  it('T4-11 B4 形态 A（根无 package.json + pnpm-workspace.yaml）→ listWorkspaceMembers 让选', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-monoa-'))
    dirs.push(mono)
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pnpm-workspace.yaml'), "packages:\n  - 'pkgs/*'\n", 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(mono, 'pkgs/inner/index.js'), '', 'utf8')
    mkdirSync(join(mono, 'pkgs/inner/node_modules'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/node_modules/.keep'), '', 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue(join(mono, 'pkgs/inner'))
    expect(await runLink([mono], {}, ws)).toBe(0)
    expect(cfgOf(ws).libs['@t/lib']).toBeTruthy()
  })
  it('T4-12 B4 select 取消 → exit 1「已取消」', async () => {
    const ws = makeWs()
    const mono = mkdtempSync(join(tmpdir(), 'lpm-monoc-'))
    dirs.push(mono)
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['pkgs/*'] }), 'utf8')
    mkdirSync(join(mono, 'pkgs/inner'), { recursive: true })
    writeFileSync(join(mono, 'pkgs/inner/package.json'), JSON.stringify({ name: '@t/lib' }), 'utf8')
    stubTty(true)
    vi.mocked(isCancel).mockReturnValue(true)
    const cap = captureOut()
    expect(await runLink([mono], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('已取消')
  })
})

describe('E. 幂等与非 lpm', () => {
  it('T4-13 幂等跳过：state 有条目 → 不 checkLib/install，state/pkg byte 原样', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const relPath = relPathOf(ws, lib)
    writeFileSync(join(ws, 'lpm.config.json'), JSON.stringify({ version: 1, packageManager: 'pnpm', libs: { '@t/lib': relPath } }))
    const pkgPath = relPkg(ws, 'apps/web')
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    const stateJson = JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: new Date(0).toISOString() } } })
    writeFileSync(join(stateDir, 'state.json'), stateJson, 'utf8')
    const pkgBefore = readFileSync(pkgPath, 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已链接')
    expect(execa).not.toHaveBeenCalled()                       // 零子进程（含 install）
    expect(readFileSync(pkgPath, 'utf8')).toBe(pkgBefore)      // pkg 零改写
    expect(readFileSync(join(stateDir, 'state.json'), 'utf8')).toBe(stateJson) // state byte 原样（C1）
  })
  it('T4-14 批量混入：[已链接 A, 新 B] → A 跳过 B 链接，install 恰一次', async () => {
    const ws = makeWs()
    const libA = makeLib()
    const relA = relPathOf(ws, libA)
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    // web 增加对 libB 的依赖
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: new Date(0).toISOString() } } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([libA, libBDir], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已链接：@t/lib')
    expect((stateOf(ws)?.links['@t/libb'] ?? null)).toBeTruthy()
    const installCalls = vi.mocked(execa).mock.calls.filter((c) => c[0] !== 'git')
    expect(installCalls).toHaveLength(1) // 单次 install（E6c）
    const finalPkg = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    expect(finalPkg).toContain('"link:')  // 两处改写共存（链式，E5）
    expect(finalPkg.match(/"link:/g)?.length).toBe(2)
  })
  it('T4-15 全部已链接 → 零 install 零写盘 exit 0', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const stateDir = join(ws, '.lpm')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, links: { '@t/lib': { original: {}, linkedAt: new Date(0).toISOString() } } }), 'utf8')
    vi.mocked(execa).mockClear()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(execa).not.toHaveBeenCalled()
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false) // I3 全跳过不写 last
  })
  it('T4-16 非 lpm TTY：git HEAD 通道 → original 记录 HEAD 值', async () => {
    const ws = makeWs()
    const lib = makeLib()
    // web 当前值手动改为本地协议（模拟用户手动 link）
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('head')
    expect(await runLink([lib], {}, ws)).toBe(0)
    const st = stateOf(ws)
    expect(Object.values(st?.links['@t/lib']?.original ?? {})).toContain('^0.9.0') // git show mock 的 HEAD 值
  })
  it('T4-17 非 lpm 手动输入本地协议 → 拒绝重提示，3 次后放弃（F12）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('manual')
    vi.mocked(text).mockResolvedValue('link:../oops')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0) // 3 次耗尽 → 放弃 → exit 0
    expect(cap.stderr()).toContain('不应为本地协议值')
    expect(stateOf(ws)).toBeNull() // 未落 state
  })
  it('T4-18 非 lpm 放弃 → config 注册保留 + state/pkg 零写 + exit 0（F11 语义）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(select).mockResolvedValue('abandon')
    const pkgBefore = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stdout()).toContain('已放弃')
    expect(cap.stdout()).toContain('注册已保留')
    expect(cfgOf(ws).libs['@t/lib']).toBeTruthy() // 注册保留（D5 在前）
    expect(stateOf(ws)).toBeNull()
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).toBe(pkgBefore)
  })
  it('T4-19 非 lpm 非 TTY → #14 exit 1', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('非 lpm 管理的本地链接')
  })
  it('T4-20 O5 零命中 → 「先 pnpm add」exit 1（LinkTargetError）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { other: '^1.0.0' } }), 'utf8')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('不在任何成员依赖中')
    expect(cap.stderr()).toContain('pnpm add')
  })
})

describe('E6/last/watch/dry-run/O4', () => {
  it('T4-21 同文件多 target 链式改写：两处 link: 共存无覆盖（F1）', async () => {
    const ws = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    expect(await runLink([libA, libBDir], {}, ws)).toBe(0)
    const pkg = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
    expect(pkg.match(/"link:/g)?.length).toBe(2)
    expect(pkg).toContain('@t/lib')
    expect(pkg).toContain('@t/libb')
  })
  it('T4-22 落盘顺序不变量：install 被调用时 state+pkg 均已写入（计划期修订 7）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    let stateAtInstall: string | null = null
    let pkgAtInstall: string | null = null
    vi.mocked(execa).mockImplementation(async (cmd: unknown) => {
      if (cmd !== 'git') {
        stateAtInstall = existsSync(join(ws, '.lpm', 'state.json')) ? readFileSync(join(ws, '.lpm', 'state.json'), 'utf8') : null
        pkgAtInstall = readFileSync(relPkg(ws, 'apps/web'), 'utf8')
      }
      return { exitCode: 0 } as never
    })
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(stateAtInstall).toContain('"@t/lib"')
    expect(pkgAtInstall).toContain('"link:')
  })
  it('T4-23a last：targets=2 → names=操作后全集；T4-23b targets=1 → 不写', async () => {
    const ws2 = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws2, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    expect(await runLink([libA, libBDir], {}, ws2)).toBe(0)
    const last = JSON.parse(readFileSync(join(ws2, '.lpm', 'last.json'), 'utf8'))
    expect(last.names.sort()).toEqual(['@t/lib', '@t/libb'])

    const ws1 = makeWs()
    const lib1 = makeLib()
    expect(await runLink([lib1], {}, ws1)).toBe(0)
    expect(existsSync(join(ws1, '.lpm', 'last.json'))).toBe(false)
  })
  it('T4-24 watch：spawn 参数正确 + dry-run 不拉起', async () => {
    const ws = makeWs()
    const lib = makeLib()
    vi.mocked(execa).mockClear()
    expect(await runLink([lib], { watch: true }, ws)).toBe(0)
    const watchCall = vi.mocked(execa).mock.calls.find((c) => (c[1] as string[])?.[0] === 'run')
    expect(watchCall?.[0]).toBe('npm') // lib 无 lockfile → 回退 npm（§2 裁决 2）
    expect(watchCall?.[1]).toEqual(['run', 'build:watch'])

    const wsD = makeWs()
    const libD = makeLib()
    vi.mocked(execa).mockClear()
    expect(await runLink([libD], { watch: true, dryRun: true }, wsD)).toBe(0)
    expect(vi.mocked(execa).mock.calls.filter((c) => c[0] !== 'git')).toHaveLength(0) // dry-run 零子进程
  })
  it('T4-25 dry-run 零写盘 + 计划内容（config/state/pkg/last/gitignore 全不变）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const snapshot = (): string => readdirSync(ws).sort().map((f) => `${f}:${existsSync(join(ws, f)) ? statSync(join(ws, f)).mtimeMs : ''}`).join('|')
    const before = snapshot()
    const cap = captureOut()
    expect(await runLink([lib], { dryRun: true }, ws)).toBe(0)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    expect(readFileSync(relPkg(ws, 'apps/web'), 'utf8')).not.toContain('link:')
    expect(cap.stdout()).toContain('dry-run 执行计划')
    expect(cap.stdout()).toContain('install --no-frozen-lockfile')
    expect(cap.stdout()).toContain('@t/lib')
  })
  it('T4-26 O4 输出形态（J1）：changedKeys 逐条 + 防误 commit 尾行 + dry-run 一致性（§7.4 #7）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    const out = cap.stdout()
    expect(out).toContain('dependencies.@t/lib：^1.0.0 → link:')
    expect(out).toContain('请勿提交')
    // dry-run 一致性：另一同构 ws 先 dry-run 后真实，改写明细一致
    const ws2 = makeWs()
    const lib2 = makeLib()
    const cap2 = captureOut()
    await runLink([lib2], { dryRun: true }, ws2)
    const planOut = cap2.stdout()
    expect(await runLink([lib2], {}, ws2)).toBe(0)
    const realPkg = readFileSync(relPkg(ws2, 'apps/web'), 'utf8')
    const m = planOut.match(/dependencies\.@t\/lib：(\S+) → (\S+)/)
    expect(m).not.toBeNull()
    expect(realPkg).toContain(`"${m?.[2]}"`)
  })
  it('T4-27 install 失败 → exit 1 + state 保留 + 逃生门文案（#16）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    vi.mocked(execa).mockImplementation(async (cmd: unknown) => {
      if (cmd !== 'git') throw { exitCode: 1, stderr: 'ERR_PNPM' }
      return { stdout: '' } as never
    })
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(1)
    expect(cap.stderr()).toContain('install 失败')
    expect(cap.stderr()).toContain('state 已保留')
    expect(stateOf(ws)?.links['@t/lib']).toBeTruthy() // state 未回滚（E6c 失败语义）
  })

  it('T4-28 git HEAD 通道不可用 → ①禁用并列原因（spec §7.2 #11）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(relPkg(ws, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': 'link:../../elsewhere' } }), 'utf8')
    stubTty(true)
    vi.mocked(execa).mockImplementation(async (cmd: unknown) => {
      if (cmd === 'git') throw new Error('git not found') // rev-parse 失败 → ①不可用
      return { exitCode: 0 } as never
    })
    vi.mocked(select).mockImplementation(async (o: { options: Array<{ value: string; label: string }> }) => {
      const head = o.options.find((x) => x.value === 'head')
      expect(head?.label).toContain('不可用') // ①标注不可用及原因
      return 'manual'
    })
    vi.mocked(text).mockResolvedValue('^0.9.0')
    const cap = captureOut()
    expect(await runLink([lib], {}, ws)).toBe(0)
    expect(cap.stderr()).toContain('git HEAD 通道不可用')
    expect(Object.values(stateOf(ws)?.links['@t/lib']?.original ?? {})).toContain('^0.9.0')
  })

  it('T4-29 watch spawn 失败 → 警告 + 退出码不变（H7 / spec §7.2 #19）', async () => {
    const ws = makeWs()
    const lib = makeLib()
    writeFileSync(join(lib, 'pnpm-lock.yaml'), '') // lib PM → pnpm
    vi.mocked(execa).mockImplementation(async (cmd: unknown, args: unknown[]) => {
      if ((args as string[])?.[0] === 'run') throw new Error('spawn ENOENT') // build:watch spawn 失败
      return { exitCode: 0 } as never
    })
    const cap = captureOut()
    expect(await runLink([lib], { watch: true }, ws)).toBe(0) // 退出码不变（链接已成功）
    expect(cap.stderr()).toContain('build:watch 异常退出')
  })

  it('T4-23c last 写失败 → 警告 + 退出码不变（spec §7.2 #18）', async () => {
    const ws2 = makeWs()
    const libA = makeLib()
    const libBDir = join(mkdtempSync(join(tmpdir(), 'lpm-lib-')), 'lib')
    dirs.push(join(libBDir, '..'))
    writeFileSync(join(libBDir, 'package.json'), JSON.stringify({ name: '@t/libb', main: './index.js' }), 'utf8')
    writeFileSync(join(libBDir, 'index.js'), '', 'utf8')
    mkdirSync(join(libBDir, 'node_modules'), { recursive: true })
    writeFileSync(join(libBDir, 'node_modules/.keep'), '', 'utf8')
    writeFileSync(relPkg(ws2, 'apps/web'), JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0', '@t/libb': '^2.0.0' } }), 'utf8')
    mkdirSync(join(ws2, '.lpm', 'last.json'), { recursive: true }) // last.json 为目录 → rename 失败
    const cap = captureOut()
    expect(await runLink([libA, libBDir], {}, ws2)).toBe(0)
    expect(cap.stderr()).toContain('last.json 写入失败')
  })
})
```

helper `relPathOf` 与 `pkgRel` 定义（工厂区追加）：

```ts
import { relative } from 'node:path'
const relPathOf = (root: string, abs: string): string => relative(root, abs).replaceAll('\\', '/')
```

注：T4-3 中 `relPathOf(ws, lib)` 即 config.libs 值（相对 ws 根、正斜杠）；T4-6 断言 original 键为 `'apps/web/package.json'`（相对根 + /package.json，G1）。

- [ ] **Step 2: 跑 RED**

Run: `npx vitest run tests/unit/link-command.test.ts`
Expected: FAIL——resolve ERROR（`src/commands/link.js` 不存在）

- [ ] **Step 3: 实现 src/commands/link.ts（五段完整参考实现）**

**段 1：imports + 类型 + 错误类**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import { execa } from 'execa'
import { LibCheckError, checkLib } from '../core/linkcheck.js'
import { InstallError, detectLibPM, runInstall, spawnBuildWatch, type WatchProcess } from '../core/install.js'
import { PMAmbiguousError, PMUnresolvedError, resolvePackageManager, type PackageManagerId } from '../core/pm.js'
import { ProtocolPathError, findDepEntries, mapProtocol, rewriteDepValue, type RewriteResult } from '../core/rewriter.js'
import {
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  findDependents,
  findWorkspaceRoot,
  listWorkspaceMembers,
  loadWorkspace,
  type DepHit,
  type PackageJsonInfo,
  type Workspace,
} from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  readProjectConfig,
  readState,
  writeLast,
  writeProjectConfig,
  writeState,
} from '../state/index.js'
import { writeTextFileAtomic } from '../state/atomic.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'

export interface LinkOptions { watch?: boolean; dryRun?: boolean }

export class LinkArgumentError extends Error {
  constructor(public target: string, message: string) {
    super(message)
    this.name = 'LinkArgumentError'
  }
}

export class LinkInteractionError extends Error {
  constructor(public kind: 'member-select' | 'non-lpm-ternary', message: string) {
    super(message)
    this.name = 'LinkInteractionError'
  }
}

/** O5 零命中（<name> 不在任何成员依赖中）——计划期修订 4 */
export class LinkTargetError extends Error {
  constructor(public name: string, message: string) {
    super(message)
    this.name = 'LinkTargetError'
  }
}

/** B4 让选取消——内部信号错误（B3：stderr「已取消」+ exit 1），不经 §6 错误表 */
class LinkCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'LinkCancelledError'
  }
}

const LOCAL_PROTOCOL_RE = /^(link|file|portal):/

interface ResolvedTarget { key: string; libDirAbs: string; source: 'name' | 'path' }
interface RewriteHit { manifestPath: string; pkgName: string; targetValue: string; fromValue: string; section: string }
interface FileAgg { content: string; hits: RewriteHit[]; changedCount: number }
interface LinkedTarget { key: string; libDirAbs: string; rel: string }
```

**段 2：工具函数**

```ts
function toRel(rootDir: string, abs: string): string {
  return relative(rootDir, abs).replaceAll('\\', '/')
}

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory()
}

/** JSON.parse 级提取（HEAD 文本/宽松场景）——original 值获取用（与 S5 文本级引擎解耦，恢复值语义等价） */
function extractValueFromManifestText(source: string, pkgName: string): string | null {
  try {
    const parsed = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as Record<string, unknown>
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = parsed[section]
      if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
        const v = (deps as Record<string, unknown>)[pkgName]
        if (typeof v === 'string') return v
      }
    }
  } catch {
    return null
  }
  return null
}

function registeredList(cfg: ProjectLpmConfig | null): string {
  const keys = Object.keys(cfg?.libs ?? {})
  return keys.length > 0 ? keys.join(', ') : '（无）'
}
```

**段 3：target 解析 + B4 分支**

```ts
async function resolveTarget(raw: string, cfg: ProjectLpmConfig | null, rootDir: string, cwd: string): Promise<ResolvedTarget> {
  const registered = cfg?.libs[raw]
  if (registered !== undefined) {
    if (typeof registered !== 'string') {
      throw new LinkArgumentError(raw, `注册值损坏：libs["${raw}"] 应为字符串相对路径。请修正 lpm.config.json。`)
    }
    return { key: raw, libDirAbs: join(rootDir, ...registered.split('/')), source: 'name' }
  }
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
  if (!looksLikePath) {
    throw new LinkArgumentError(raw, `未知注册名/路径不存在：${raw}。已注册：${registeredList(cfg)}；若为路径请使用路径写法（绝对/相对，含空格加引号）；若为注册名请检查拼写或先注册。`)
  }
  const abs = resolve(cwd, raw)
  if (!isDirectory(abs)) {
    throw new LinkArgumentError(raw, `未知注册名/路径不存在：${raw}。已注册：${registeredList(cfg)}；若为路径请确认目录存在；若为注册名请检查拼写或先注册。`)
  }
  return { key: '', libDirAbs: abs, source: 'path' }
}

/** B4 monorepo 根分支（spec §4.4 B）：返回确定成员后的 libDirAbs 与其 name */
async function resolveMonorepo(libDirAbs: string): Promise<{ libDirAbs: string; name: string }> {
  if (!existsSync(join(libDirAbs, 'package.json'))) {
    if (!existsSync(join(libDirAbs, 'pnpm-workspace.yaml'))) {
      throw new LibCheckError('manifest-missing', libDirAbs, `${libDirAbs} 不是 npm 包（缺 package.json）。请确认路径指向包目录。`)
    }
    const members = await listWorkspaceMembers(libDirAbs)
    return pickMember(libDirAbs, members)
  }
  const libWs = await loadWorkspace(libDirAbs)
  if (libWs.manifestFormat === 'single') {
    return { libDirAbs, name: libWs.members[0]?.name ?? '' }
  }
  return pickMember(libDirAbs, libWs.members)
}

async function pickMember(libDirAbs: string, members: PackageJsonInfo[]): Promise<{ libDirAbs: string; name: string }> {
  if (!process.stdin.isTTY) {
    const names = members.map((m) => (m.isRoot ? '（根）' : '') + (m.name !== '' ? m.name : toRel(libDirAbs, m.dir)))
    throw new LinkInteractionError('member-select', `${libDirAbs} 是 monorepo 根，需要选择成员包：可选成员 ${names.join(', ')}。当前环境无法交互——请直接使用成员路径，如 lpm link <成员路径>。`)
  }
  const selected = await clack.select({
    message: '该路径是 monorepo 根，请选择要链接的成员包',
    options: members.map((m) => ({
      value: m.dir,
      label: (m.isRoot ? '（根）' : '') + (m.name !== '' ? m.name : toRel(libDirAbs, m.dir)),
    })),
  })
  if (clack.isCancel(selected)) {
    throw new LinkCancelledError()
  }
  const dir = selected as string
  const member = members.find((m) => m.dir === dir)
  return { libDirAbs: dir, name: member?.name ?? '' }
}
```

**段 4：非 lpm 三选一**

```ts
const ABANDON = Symbol('abandon')

async function ternaryOriginal(
  rootDir: string,
  key: string,
  pkgName: string,
  hits: DepHit[],
): Promise<Map<string, string> | typeof ABANDON> {
  // 选项① git HEAD 预取（F1/F2：全部命中文件均取得非本地协议原值才可用）
  const headValues = new Map<string, string>()
  let headUsable = true
  let headReason = ''
  let repoRoot = ''
  try {
    const rr = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: rootDir })
    repoRoot = rr.stdout.trim()
  } catch {
    headUsable = false
    headReason = 'git 不可用或当前不在 git 仓库内'
  }
  if (headUsable) {
    for (const h of hits) {
      const relFromRepo = relative(repoRoot, h.manifestPath).replaceAll('\\', '/')
      try {
        const r = await execa('git', ['show', `HEAD:${relFromRepo}`], { cwd: repoRoot })
        const val = extractValueFromManifestText(r.stdout, pkgName)
        if (val === null || val === '' || LOCAL_PROTOCOL_RE.test(val)) {
          headUsable = false
          headReason = `HEAD 版 ${toRel(rootDir, h.manifestPath)} 的 ${pkgName} 值缺失或仍为本地协议`
          break
        }
        headValues.set(h.manifestPath, val)
      } catch {
        headUsable = false
        headReason = `HEAD 版 ${toRel(rootDir, h.manifestPath)} 读取失败（文件未入库？）`
        break
      }
    }
  }
  const options: Array<{ value: string; label: string }> = []
  options.push(headUsable
    ? { value: 'head', label: '从 git HEAD 读取原值' }
    : { value: 'head', label: `从 git HEAD 读取原值（不可用：${headReason}）` })
  options.push({ value: 'manual', label: '手动输入原 range' })
  options.push({ value: 'abandon', label: '放弃该 lib（不链接）' })
  if (!headUsable) {
    process.stderr.write(`提示：git HEAD 通道不可用——${headReason}。\n`)
  }
  const sel = await clack.select({
    message: `检测到非 lpm 管理的本地链接（${key}），选择原始 range 来源`,
    options,
  })
  if (clack.isCancel(sel)) return ABANDON
  if (sel === 'abandon') return ABANDON
  if (sel === 'head') return headValues
  // 手动输入（F3：空串重提示 / 本地协议拒绝重提示 / 3 次耗尽或取消 → 放弃）
  for (let i = 0; i < 3; i++) {
    const inp = await clack.text({ message: `输入 ${key} 的原始 range（如 ^1.2.3）` })
    if (clack.isCancel(inp)) return ABANDON
    const v = String(inp).trim()
    if (v === '') {
      process.stderr.write('输入为空，请重试。\n')
      continue
    }
    if (LOCAL_PROTOCOL_RE.test(v)) {
      process.stderr.write('原 range 不应为本地协议值（link:/file:/portal:）——否则 unlink 会「恢复」成 link 路径。请重试。\n')
      continue
    }
    return new Map(hits.map((h) => [h.manifestPath, v]))
  }
  return ABANDON
}
```

**段 5：runLink 主流程**

```ts
function failThrough(err: unknown): never {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkTargetError,
    ProtocolPathError, InstallError,
  ]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1) as never
  }
  throw err
}
```

——**exit 语义修正**：runLink 返回 number，不用 process.exit；failThrough 改为返回 number 的 `reportError`：

```ts
function reportError(err: unknown): number {
  const KNOWN = [
    WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError,
    PMAmbiguousError, PMUnresolvedError,
    LpmConfigParseError, LpmStateParseError,
    LibCheckError, LinkArgumentError, LinkInteractionError, LinkTargetError,
    ProtocolPathError, InstallError,
  ]
  if (KNOWN.some((k) => err instanceof k)) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }
  throw err
}

export async function runLink(targets: readonly string[], opts: LinkOptions, cwd: string = process.cwd()): Promise<number> {
  // A1 无参数
  if (targets.length === 0) {
    process.stdout.write('交互模式随 S9 上线；直通用法：lpm link <名字|路径>... [--watch] [--dry-run]\n')
    return 1
  }
  try {
    // A5 workspace
    const rootDir = await findWorkspaceRoot(cwd)
    const ws: Workspace = await loadWorkspace(rootDir)
    let cfg: ProjectLpmConfig | null = await readProjectConfig(rootDir)
    // A4 PM
    const pmResolution = await resolvePackageManager(rootDir, cfg?.packageManager)
    const pm = pmResolution.pm
    if (pmResolution.source === 'detected') {
      process.stdout.write(`检测到包管理器：${pm}（未 lpm use 固化）\n`)
    }
    // state 预读（幂等判定 + 合并写基线）
    let st: LinkState | null = await readState(rootDir)

    const seenRaw = new Set<string>()
    const seenKey = new Set<string>()
    const aggregated = new Map<string, FileAgg>()
    const peerWarn: Array<{ rel: string; pkg: string }> = []
    const planUpserts: Array<{ key: string; rel: string; isNew: boolean }> = []
    const planSkipped: string[] = []
    const planAbandoned: string[] = []
    const linkedTargets: LinkedTarget[] = []
    const pendingLinks: Array<{ key: string; original: Record<string, string> }> = []

    // ── 逐 target（遇错即停——聚合在内存，state/pkg 零写盘；config upsert 允许已发生）──
    for (const raw of targets) {
      if (seenRaw.has(raw)) continue
      seenRaw.add(raw)

      const rt = await resolveTarget(raw, cfg, rootDir, cwd)
      let libDirAbs = rt.libDirAbs
      let libName = ''
      if (rt.source === 'name') {
        libName = rt.key
      } else {
        const mr = await resolveMonorepo(libDirAbs)
        libDirAbs = mr.libDirAbs
        libName = mr.name
      }
      // key 确定（D1：名字分支 = target；路径分支 = name 预读，空名回退相对路径——§9 自决 7）
      const key = rt.source === 'name' ? rt.key : (libName !== '' ? libName : toRel(rootDir, libDirAbs))
      if (seenKey.has(key)) continue // E5 同 key 去重（不同写法指向同一 lib）
      seenKey.add(key)

      // E1 幂等判定（C1，尽早）
      if (st?.links[key] !== undefined) {
        process.stdout.write(`已链接：${key}，跳过（保留原 original 条目）\n`)
        planSkipped.push(key)
        continue
      }

      // C 前置检查（名字分支做 B7 一致性；dry-run 也跑——K3 参数有效性）
      const check = checkLib(libDirAbs, {
        expectedName: rt.source === 'name' ? rt.key : null,
        expectWatchScript: opts.watch === true,
      })

      // D upsert（静默；dry-run 只记录）
      const relPath = toRel(rootDir, libDirAbs)
      const isNew = cfg?.libs[key] !== relPath
      if (isNew && opts.dryRun !== true) {
        const next: ProjectLpmConfig = cfg ?? { version: 1, libs: {} }
        next.libs[key] = relPath
        await writeProjectConfig(rootDir, next)
        cfg = next
      }
      planUpserts.push({ key, relPath, isNew })

      // E2 命中
      const hits: DepHit[] = await findDependents(ws, check.name)
      // E3 O5 零命中
      if (hits.length === 0) {
        throw new LinkTargetError(check.name, `${check.name} 不在任何成员依赖中。先在引用方执行 pnpm add ${check.name} 再 link`)
      }

      // E4 非 lpm 检测
      const localHits = hits.filter((h) => LOCAL_PROTOCOL_RE.test(h.currentValue))
      let originals: Map<string, string>
      if (localHits.length > 0) {
        if (opts.dryRun === true) {
          process.stdout.write(`警告：检测到非 lpm 管理的本地链接（${toRel(rootDir, localHits[0].manifestPath)}）（dry-run 不记录 original）\n`)
          originals = new Map(hits.map((h) => [h.manifestPath, h.currentValue]))
        } else if (!process.stdin.isTTY) {
          throw new LinkInteractionError('non-lpm-ternary', `检测到非 lpm 管理的本地链接（${toRel(rootDir, localHits[0].manifestPath)}），需交互确认原始 range。请手动恢复该文件原值后重试，或先 lpm link --dry-run 查看。`)
        } else {
          const picked = await ternaryOriginal(rootDir, key, check.name, hits)
          if (picked === ABANDON) {
            process.stdout.write(`已放弃：${key}（注册已保留，本次未链接）\n`)
            planAbandoned.push(key)
            continue
          }
          originals = picked
        }
      } else {
        originals = new Map(hits.map((h) => [h.manifestPath, h.currentValue]))
      }

      // E5 改写聚合（按 manifestPath 分组链式应用；peer 数据源 = 应用时点 source）
      const originalMap: Record<string, string> = {}
      for (const h of hits) {
        const targetValue = mapProtocol(pm, libDirAbs, dirname(h.manifestPath))
        let entry = aggregated.get(h.manifestPath)
        if (entry === undefined) {
          entry = { content: readFileSync(h.manifestPath, 'utf8'), hits: [], changedCount: 0 }
          aggregated.set(h.manifestPath, entry)
        }
        const source = entry.content
        const result: RewriteResult = rewriteDepValue(source, check.name, targetValue)
        entry.content = result.content
        entry.changedCount += result.changedKeys.length
        entry.hits.push({ manifestPath: h.manifestPath, pkgName: check.name, targetValue, fromValue: h.currentValue, section: h.section })
        if (findDepEntries(source, check.name).includes('peerDependencies')) {
          peerWarn.push({ rel: toRel(rootDir, h.manifestPath), pkg: check.name })
        }
        // G1 original：键 = 相对根 + /package.json（根自身 → 'package.json'）
        const relDir = toRel(rootDir, dirname(h.manifestPath))
        const origKey = relDir === '' ? 'package.json' : `${relDir}/package.json`
        if (originalMap[origKey] === undefined) originalMap[origKey] = originals.get(h.manifestPath) ?? h.currentValue
      }
      pendingLinks.push({ key, original: originalMap })
      linkedTargets.push({ key, libDirAbs, rel: relPath })
    }

    // ── 汇总出口 ──
    const totalChanged = [...aggregated.values()].reduce((s, e) => s + e.changedCount, 0)
    const skippedTotal = planSkipped.length + planAbandoned.length
    if (aggregated.size === 0) {
      // 无改写：全已链接 / 全放弃
      return 0
    }

    // dry-run（K）：零写盘零子进程，打印执行计划
    if (opts.dryRun === true) {
      process.stdout.write('dry-run 执行计划（不落任何盘、不执行任何子进程）：\n')
      for (const u of planUpserts) {
        if (u.isNew || cfg?.libs[u.key] === undefined) process.stdout.write(`  注册 upsert：${u.key} → ${u.rel}（新增/更新）\n`)
      }
      for (const [mp, entry] of aggregated) {
        process.stdout.write(`  改写 ${toRel(rootDir, mp)}:\n`)
        for (const h of entry.hits) {
          process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}\n`)
        }
      }
      for (const k of planSkipped) process.stdout.write(`  已链接跳过：${k}\n`)
      for (const p of peerWarn) process.stdout.write(`  peer 警告：${p.rel}（${p.pkg}）\n`)
      const flags = pm === 'pnpm' ? 'install --no-frozen-lockfile' : pm === 'yarn-berry' ? 'install --no-immutable' : pm === 'yarn-classic' ? 'install --no-frozen-lockfile' : 'install'
      process.stdout.write(`  install：${pm} ${flags}（workspace 根）\n`)
      if (opts.watch === true) {
        for (const t of linkedTargets) process.stdout.write(`  watch：拉起 ${t.rel} 的 build:watch（${detectLibPM(t.libDirAbs)} run build:watch）\n`)
      }
      return 0
    }

    // E6a state（合并单次写；linkedAt = S6 生成 ISO 8601）
    const newLinks: LinkState['links'] = { ...(st?.links ?? {}) }
    for (const p of pendingLinks) {
      newLinks[p.key] = { original: p.original, linkedAt: new Date().toISOString() }
    }
    await writeState(rootDir, { version: 1, links: newLinks })

    // E6b package.json（文本级原子写）
    for (const [mp, entry] of aggregated) {
      writeTextFileAtomic(mp, entry.content)
    }

    // E6c 单次 install
    await runInstall(rootDir, pm)

    // I last（targets ≥ 2 且至少成功 1 个）
    if (targets.length >= 2 && linkedTargets.length >= 1) {
      try {
        const fresh = await readState(rootDir)
        await writeLast(rootDir, { version: 1, names: Object.keys(fresh?.links ?? {}) })
      } catch {
        process.stderr.write('警告：last.json 写入失败（不影响链接）\n')
      }
    }

    // H watch（Ruling 2：lib 自身 PM；前台驻留；Ctrl+C 兜底 kill；H7 spawn 失败警告）
    if (opts.watch === true && linkedTargets.length > 0) {
      const watches: WatchProcess[] = []
      for (const t of linkedTargets) {
        const libPm = detectLibPM(t.libDirAbs)
        try {
          const w = spawnBuildWatch(t.libDirAbs, libPm)
          watches.push(w)
          process.stdout.write(`watch：${t.rel}（${libPm} run build:watch，pid ${w.pid}）\n`)
          void w.failure.then((err) => {
            if (err !== null) process.stderr.write(`警告：build:watch 异常退出：${String(err)}（链接本身不受影响）\n`)
          })
        } catch (err) {
          process.stderr.write(`警告：build:watch 拉起失败：${(err as Error).message}（链接本身不受影响）\n`)
        }
      }
      if (watches.length > 0) {
        const onSigint = (): void => {
          for (const w of watches) w.kill()
        }
        process.on('SIGINT', onSigint)
        try {
          await Promise.all(watches.map((w) => w.exited))
        } finally {
          process.off('SIGINT', onSigint)
        }
      }
    }

    // J O4 完成提示（Ruling 6）
    process.stdout.write(`链接完成：${linkedTargets.length} 个 lib，${totalChanged} 处声明改写：\n`)
    for (const [mp, entry] of aggregated) {
      process.stdout.write(`  ${toRel(rootDir, mp)}:\n`)
      for (const h of entry.hits) {
        process.stdout.write(`    ${h.section}.${h.pkgName}：${h.fromValue} → ${h.targetValue}\n`)
      }
    }
    if (skippedTotal > 0) process.stdout.write(`  已链接跳过：${skippedTotal} 处\n`)
    for (const p of peerWarn) process.stdout.write(`  警告：peerDependencies 命中不改写：${p.rel}（${p.pkg}）\n`)
    process.stdout.write('以上 package.json 已修改，请勿提交；lpm unlink 可恢复原状。\n')
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

实现要点自查（implementer 逐条核对）：
- E8：upsert 逐 target 发生（写 config）；state/pkg 写在全部聚合后——遇错即停时 state/pkg 零写 ✓
- E5 去重：`seenRaw`（同串）+ `seenKey`（异写法同 lib）双层 ✓
- J2 计数：`linkedTargets.length`（去重后）、`totalChanged`（引擎 changedKeys 求和）、skipped = 跳过 + 放弃 ✓
- T4-25 断言 `existsSync('.lpm') === false`：dry-run 不触发 writeState → writeState 内建 ensureGitignoreEntry 也不跑 → 无 .gitignore ✓

- [ ] **Step 4: 跑 GREEN + typecheck**

Run: `npx vitest run tests/unit/link-command.test.ts` → 30 passed（如个别用例因 fixture 细节失败：只修测试 fixture 搭建，不改契约断言；契约冲突时报控制者裁定）
Run: `npx tsc --noEmit --pretty 2>&1 | grep "src/commands"` → 零输出
Run: `npx vitest run tests/unit` → **218 passed**（158 + 7 + 16 + 7 + 30）

- [ ] **Step 5: git status 核对**

Run: `git status --porcelain -uall`
Expected: 新增 `?? src/commands/link.ts`、`?? tests/unit/link-command.test.ts`；既有 M/?? 形态保持

---

### Task 5: cli 接线 + e2e + 文档回写收口

**Files:**
- Modify: `src/cli.ts`（link 特判接线，S3 use 先例）
- Test: `tests/e2e/cli.e2e.test.ts`（追加 5 用例）
- Modify: `docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md`（回写 3 hunk——§4.5 回写义务）
- Modify: `docs/superpowers/specs/2026-09-26-s6-link-direct-design.md`（计划期修订 3/4/5/7 的 spec 同步，5 hunk）

**Interfaces:**
- Consumes: Task 4 `runLink` / `LinkOptions`
- Produces: 可执行 `lpm link` 命令；e2e 计数 16；全部文档回写完成

- [ ] **Step 1: 写失败 e2e（cli.e2e.test.ts 追加）**

文件 import 区追加 `import { runLink } from '../../src/commands/link.js'` 无需——e2e 走 runCli。文件末尾追加（沿用该文件 `makeProject` 模式，若 S3 段的 makeProject 在 describe 内部则在本 describe 内重建同款）：

```ts
describe('lpm link e2e（S6 spec §7.3）', () => {
  const made: string[] = []
  function makeProject(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'lpm-link-e2e-'))
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
    'lpm.config.json': JSON.stringify({ version: 1, packageManager: 'pnpm', libs: {} }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { '@t/lib': '^1.0.0' } }),
  }

  it('E2E-1 dry-run：输出执行计划且项目 byte 级零变化（config/state/pkg/gitignore 均不产生）', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link', '--dry-run', join(ws, '..', 'no-such-lib')], ws)
    expect(r.exitCode).not.toBe(0) // lib 不存在 → 前置检查报错（dry-run 也要求参数有效，K3）
    // 正常 dry-run：临时 lib
    const lib = join(ws, '..', 'lpm-e2e-lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    writeFileSync(join(lib, 'index.js'), '', 'utf8')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    const before = readFileSync(join(ws, 'lpm.config.json'), 'utf8')
    const r2 = await runCli(['link', '--dry-run', lib], ws)
    expect(r2.exitCode).toBe(0)
    expect(r2.stdout).toContain('dry-run 执行计划')
    expect(readFileSync(join(ws, 'lpm.config.json'), 'utf8')).toBe(before)
    expect(existsSync(join(ws, '.lpm'))).toBe(false)
    expect(existsSync(join(ws, '.gitignore'))).toBe(false)
    expect(readFileSync(join(ws, 'apps/web/package.json'), 'utf8')).not.toContain('link:')
  })

  it('E2E-2 无参数：提示用法 + exit 1', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain('lpm link <名字|路径>')
  })

  it('E2E-3 未注册名：#12 文案 + exit 1', async () => {
    const ws = makeProject(WS_FILES)
    const r = await runCli(['link', 'ghost'], ws)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('未知注册名/路径不存在')
  })

  it('E2E-4 已链接路径（预置 state）：跳过 + 零变化 + exit 0', async () => {
    const ws = makeProject(WS_FILES)
    mkdirSync(join(ws, '.lpm'), { recursive: true })
    writeFileSync(
      join(ws, '.lpm', 'state.json'),
      JSON.stringify({ version: 1, links: { '@t/lib': { original: { 'apps/web/package.json': '^1.0.0' }, linkedAt: '2026-01-01T00:00:00.000Z' } } }),
      'utf8',
    )
    // 路径分支 key=name 预读需要 lib 存在
    const lib = join(ws, '..', 'lpm-e2e-lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'package.json'), JSON.stringify({ name: '@t/lib', main: './index.js' }), 'utf8')
    mkdirSync(join(lib, 'node_modules'), { recursive: true })
    writeFileSync(join(lib, 'node_modules', '.keep'), '', 'utf8')
    const r = await runCli(['link', lib], ws)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('已链接：@t/lib')
    expect(existsSync(join(ws, '.lpm', 'last.json'))).toBe(false)
  })

  it('E2E-5 --help link 行无「（计划 S6）」后缀；既有 11 例回归不变', async () => {
    const r = await runCli(['--help'], cwd)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('把依赖切到本地目录联调')
    expect(r.stdout).not.toContain('把依赖切到本地目录联调（计划 S6）')
  })
})
```

- [ ] **Step 2: 跑 e2e RED**

Run: `pnpm build && npx vitest run tests/e2e`
Expected: E2E-1~4 FAIL（link 仍为 stub：「尚未实现」）+ E2E-5 FAIL（带「（计划 S6）」后缀）；既有 11 例 PASS

- [ ] **Step 3: cli.ts link 接线**

`src/cli.ts`：import 区追加 `import { runLink } from './commands/link.js'`；`buildProgram` 内 use 特判块之后插入：

```ts
    // S6：link 直通版接线（同 use 特判；description 不带计划后缀）
    if (meta.name === 'link') {
      program
        .command(meta.name)
        .description(meta.summary)
        .argument('[targets...]', '注册名或路径')
        .option('--watch', '链接后拉起 lib 的 build:watch 子进程')
        .option('--dry-run', '仅打印执行计划，不落盘不执行')
        .action(async (targets: string[], options: { watch?: boolean; dryRun?: boolean }) => {
          process.exitCode = await runLink(targets, options)
        })
      continue
    }
```

- [ ] **Step 4: 跑 e2e GREEN + 全量 verify**

Run: `pnpm build && npx vitest run tests/e2e` → 16 passed（11 + 5）
Run: `pnpm verify` → 四段全绿：typecheck 0 + build + **unit 222/222（16 文件）** + **e2e 16/16**

- [ ] **Step 5: S1 spec 回写（3 hunk 逐字）**

hunk 1（行 351）——旧：

```
2. **命令调用流**：argv → `run()` → commander parse → registry 命中 → handler（S1 全为 stub：stderr 中文提示，退出码保持 0）；未命中 → commander 默认错误；`--version` / `--help` / 无参数 → help 输出
```

新：

```
2. **命令调用流**：argv → `run()` → commander parse → registry 命中 → handler（use / link 已实现——S3/S6 特判接线，真实退出码；其余 stub：stderr 中文提示，退出码保持 0）；未命中 → commander 默认错误；`--version` / `--help` / 无参数 → help 输出
```

hunk 2（行 352）——旧：

```
3. **业务管线（预告，仅接口）**：cwd → findWorkspaceRoot → loadWorkspace → findDependents → rewriter → state → PM install——每段独立文件、签名冻结（§4.3–4.4），S2–S6 逐段填充
```

新：

```
3. **业务管线（预告，仅接口）**：cwd → findWorkspaceRoot → loadWorkspace → findDependents → rewriter → state → PM install——每段独立文件、签名冻结（§4.3–4.4），S1–S6 已全部填充（S6 完成链路编排）
```

hunk 3（分层表行 406）——旧：

```
| commands/* | S6 起 stub → 实现；交互 S9；打磨 S12 |
```

新：

```
| commands/* | use（S3）/ link（S6）已实现；其余 stub 随 S7+ 逐期；交互 S9；打磨 S12 |
```

- [ ] **Step 6: S6 spec 同步（计划期修订 3/4/5/7 落盘，5 hunk 逐字）**

hunk 1（§4.3 install.ts 段 WatchProcess）——旧：

```
/** 拉起 lib 的 build:watch 子进程：<pm> run build:watch，cwd=libDir，stdio 继承，前台。
 *  前置检查已保证 script 存在；返回 child 供调用方驻留与终止（§4.4 H） */
export function spawnBuildWatch(libDirAbs: string, pm: PackageManagerId): { pid: number; exited: Promise<void>; kill: () => void }
```

新：

```
/** 拉起 lib 的 build:watch 子进程：<pm> run build:watch，cwd=libDir，stdio 继承，前台。
 *  前置检查已保证 script 存在；调用方经 exited 驻留、kill 终止、failure 出警告（§4.4 H）。
 *  failure：resolve 为子进程失败原因（spawn 失败/非零退出），正常退出 → null——H7 警告数据源（计划期修订 3） */
export interface WatchProcess {
  pid: number
  exited: Promise<void>
  kill: () => void
  failure: Promise<unknown | null>
}
export function spawnBuildWatch(libDirAbs: string, pm: PackageManagerId): WatchProcess
```

hunk 2（§4.3 link.ts 段，LinkInteractionError 块之后插入）：

```
/** O5 零命中（<name> 不在任何成员依赖中），message 首行即用户文案（§6 #17）——计划期修订 4 */
export class LinkTargetError extends Error {
  constructor(public pkgName: string, message: string) // name = 'LinkTargetError'
}
```

hunk 3（§6 错误表末行后追加 + §7.4 #3 计数）——表尾（#16 行后）追加：

```
| 17 | LinkTargetError | O5 零命中（findDependents 空） | 「<name> 不在任何成员依赖中。先在引用方执行 pnpm add <name> 再 link」 | 1 |
```

§7.4 #3「§6 错误表 16 条」→「§6 错误表 17 条」。

hunk 4（§7.4 #1 计数链定版）——旧：

```
1. `pnpm verify` 全绿（typecheck 0 + build + unit 含新增 + e2e 含新增），本机 Windows 通过；计数链预估 unit 158 + ~53 ≈ 211（linkcheck ~16 / install ~6 / link-command ~24 / state-files 追加 ~3 / load-workspace 追加 ~4）+ e2e 11 + 5 = 16——**plan 期定版**（S5 先例计划期修订）
```

新：

```
1. `pnpm verify` 全绿（typecheck 0 + build + unit 含新增 + e2e 含新增），本机 Windows 通过；计数链定版 unit **218**（158 基线 + T1 7 + T2 16 + T3 7 + T4 30）+ e2e **16**（11 + 5）——计划期修订 5（T3 评审 I-1 修订 +1）
```

hunk 5（§7.2 #15 落盘顺序断言收窄，计划期修订 7）——旧：

```
15. 落盘顺序：writeState 先于 writeTextFileAtomic（调用序断言）；install 恰一次（多 target 单次）；install 失败 → InstallError 文案含「state 已保留」且 state 内容未被回滚删除（E6/#16）
```

新：

```
15. 落盘顺序：install（execa mock）被调用时 state.json 与被改写 package.json 均已包含新值（E6 a/b 先于 c 的关键不变量；a↔b 内部顺序由 spec E6 契约与实现走查保证）；install 恰一次（多 target 单次）；install 失败 → InstallError 文案含「state 已保留」且 state 内容未被回滚删除（E6/#16）
```

- [ ] **Step 7: 最终核对**

Run: `pnpm verify` → 全绿（exit 0）
Run: `git status --porcelain -uall` → 改动面 = Task 1–4 产出 + `M src/cli.ts` + `M tests/e2e/cli.e2e.test.ts` + `M docs/superpowers/specs/2026-09-25-s1-cli-scaffold-design.md` + `M docs/superpowers/specs/2026-09-26-s6-link-direct-design.md`；**改动全部未提交，由用户自行 commit**

---

## 计数链与验收对照

| 段 | 基线 | 增量 | 累计 |
|---|---|---|---|
| 基线（2e46fa0） | unit 158 + e2e 11 | — | — |
| Task 1 | 158 | +7（state-files 3 + load-workspace 4） | 165 |
| Task 2 | 165 | +17（linkcheck，OCR O9 +1） | 182 |
| Task 3 | 182 | +8（install，I-1 修订 +1 / OCR O1 +1） | 190 |
| Task 4 | 190 | +33（link-command，OCR O6/O7 +2 / 残余① T4-33 +1） | **223** |
| Task 5 | e2e 11 | +5 | **16** |

spec §7.4 验收 ↔ 任务映射：#1 verify 全绿 + 计数链 → Task 5 Step 4/7；#2 契约↔用例双向 → T2/T3/T4 用例编号（spec §7.2 #1–22 ↔ T4-1~30 映射见各用例标题）；#3 错误表 17 条 → T2 七 kind + T4 各透传用例；#4 冻结面 → Task 5 spec 同步后人工核验（S5 引擎 7 导出 grep 复核）；#5 依赖白名单 → package.json 零改动（git diff 核验）；#6 S1 回写 → Task 5 Step 5；#7 dry-run 一致性 → T4-26。

## 收口说明

- 全部任务无 commit 步骤（用户全局 Git 规则）；SDD workspace 记录 + 最终全量 review + pnpm verify 由控制者按 S1–S5 流程执行
- Task 派发 brief 模式（S5 Ruling 承袭）：实现者定向读本 plan 对应 Task 节（Grep 定位 + Read 区间，禁止通读全文件）；每任务 reviewer 直读产出文件评审；每任务报告附 git status 核对结果
