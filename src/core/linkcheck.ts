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

/** exports '.' 主入口字符串候选（§4.4 C5：直接字符串 / import·require·node·default 子键字符串值；
 *  OCR O9：兼容 Node 顶层条件简写 `{"import": ...}`（无 '.' 键）） */
function collectEntryCandidates(value: unknown): string[] {
  const out: string[] = []
  const pushConditionStrings = (obj: Record<string, unknown>): void => {
    for (const key of ['default', 'import', 'node', 'require']) {
      const v = obj[key]
      if (typeof v === 'string') out.push(v)
    }
  }
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  const obj = value as Record<string, unknown>
  const dot = obj['.']
  if (typeof dot === 'string') out.push(dot)
  else if (dot !== null && typeof dot === 'object' && !Array.isArray(dot)) {
    pushConditionStrings(dot as Record<string, unknown>)
  } else if (dot === undefined) {
    pushConditionStrings(obj) // 顶层条件简写
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
  if (typeof opts.expectedName === 'string' && opts.expectedName !== '' && name !== '' && name !== opts.expectedName) {
    throw new LibCheckError('name-mismatch', libDirAbs, `lib 实际 name（${name}）≠ 通讯录 key（${opts.expectedName}）。请更新 lpm.config.json 中 libs 键为 ${name} 后重试。`)
  }
  const entryCandidates = resolveEntryCandidates(libDirAbs, manifest)
  // 必须是常规文件：无扩展名候选（如 "main": "./dist"）会同时产出目录与 index.js 两个路径，
  // 目录存在但构建产物缺失时不得放行（B5 误放行修复）
  if (entryCandidates !== null && !entryCandidates.some((p) => existsSync(p) && statSync(p).isFile())) {
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
