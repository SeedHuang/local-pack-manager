import { isAbsolute, join, resolve } from 'node:path'
import * as clack from '@clack/prompts'
import {
  findWorkspaceRoot,
  loadWorkspace,
  ManifestParseError,
  WorkspaceNotFoundError,
  WorkspacePatternError,
  type Workspace,
} from '../core/workspace.js'
import {
  LpmConfigParseError,
  LpmStateParseError,
  readProjectConfig,
  readState,
  readUserConfig,
  writeProjectConfig,
} from '../state/index.js'
import type { LinkState, ProjectLpmConfig } from '../state/types.js'
import { PresetError, readPresets } from './preset.js'
import { collectLinkCandidates, parsePathInput, type LinkCandidate } from './link.js'

/** forget 相关错误（命令域；沿用「错误类归命令文件」先例） */
export class ForgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForgetError'
  }
}

/** 命令级错误上报（与 link/unlink/preset 同形）：KNOWN 直接打印 + return 1；其余 rethrow */
function reportError(err: unknown): number {
  const KNOWN = [ForgetError, WorkspaceNotFoundError, ManifestParseError, WorkspacePatternError, LpmConfigParseError, LpmStateParseError, PresetError]
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
  /** 未命中统一报错（名字分支与路径分支共用构造，行为逐字一致） */
  const notFound = (): never => {
    throw new ForgetError(
      Object.keys(cfg?.libs ?? {}).length === 0
        ? '当前没有任何已注册的 lib。用 lpm link <路径> 注册'
        : `注册不存在：${raw}。已注册：${registeredList(cfg)}`,
    )
  }
  if (cfg !== null && Object.hasOwn(cfg.libs, raw)) return [raw]
  const looksLikePath = raw.includes('/') || raw.includes('\\') || raw.startsWith('.') || isAbsolute(raw)
  if (!looksLikePath) {
    notFound()
  }
  const hits = resolveRegisteredNameByPath(raw, cfg, rootDir, cwd)
  if (hits.length === 0) {
    notFound()
  }
  return hits
}

/** 预设提示（spec §4.4 要点 4，按预设聚合、不洗）——直通与子界面共用。
 *  Ruling OCR-1：presets 内容损坏（顶层非对象）时 PresetError 已属 KNOWN——但删除在此**前**已落盘，
 *  让错误冒到 reportError 会「删除成功却 exit 1」误导用户；故此处容忍：警告一行并跳过提示（不 rethrow、不中断）。 */
function printPresetHints(cfg: ProjectLpmConfig | null, deleted: ReadonlySet<string>): void {
  let view
  try {
    view = readPresets(cfg)
  } catch {
    process.stdout.write('警告：lpm.config.json 的 presets 内容损坏，跳过预设提示（不影响本次删除）\n')
    return
  }
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

export interface ManageRegistryCtx {
  rootDir: string
  cwd: string
  ws: Workspace
  cfg: ProjectLpmConfig | null
  st: LinkState | null
}

/** 「按路径删除…」虚拟项哨兵（NUL 前缀，沿用 OTHER_OPTION / S10 哨兵惯例；包名不可能含 NUL） */
const FORGET_PATH_OPTION = '\u0000__forget_path__'

/** 子界面选项元数据（label/hint，行为与 spec §4.5 逐字一致；用 if/else 取代嵌套三元） */
function optionMeta(c: LinkCandidate): { label: string; hint: string } {
  if (c.linked) {
    return { label: `${c.key}  [已链接]`, hint: '先 lpm unlink，或改用 lpm unlink' }
  }
  if (!c.cfgIntact) {
    return { label: `${c.key}  [注册值损坏]`, hint: '修正 lpm.config.json 或删除（修脏路径）' }
  }
  return { label: c.key, hint: c.rel }
}

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
  const options = cand.registered.map((c) => ({ value: c.key, ...optionMeta(c) }))
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

/** `lpm forget` 入口：[] → 非 TTY 提示 / TTY 进子界面（T3 实现）；[targets...] → 直通 */
export async function runForget(targets: readonly string[], cwd: string = process.cwd()): Promise<number> {
  try {
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
    const rootDir = await findWorkspaceRoot(cwd)
    return await forgetDirect(targets, rootDir, cwd)
  } catch (err) {
    return reportError(err)
  }
}
