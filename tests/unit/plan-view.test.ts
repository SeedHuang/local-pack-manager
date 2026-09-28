import { describe, expect, it } from 'vitest'
import { renderPlan, type PlanView } from '../../src/commands/plan-view.js'

const DRY_HEAD = 'dry-run 执行计划（不落任何盘、不执行任何子进程）：'
const PREVIEW_HEAD = '执行计划预览：'

/** 一个含 CJK 与中英混排的代表性计划（link 形态） */
function view(): PlanView {
  return {
    entries: [
      { kind: 'line', text: '注册 upsert：@t/lib → ../../lpm-lib（新增/更新）' },
      { kind: 'group', heading: '改写 apps/web/package.json:', lines: ['dependencies.@t/lib：^1.0.0 → link:../../lpm-lib'] },
      { kind: 'line', text: '已链接跳过：@t/two' },
      { kind: 'line', text: 'peer 警告：apps/web/package.json（@t/lib）' },
    ],
    install: { command: 'pnpm install --no-frozen-lockfile', verify: null },
    watch: ['拉起 ../../lpm-lib 的 build:watch（pnpm run build:watch）'],
  }
}

describe('renderPlan', () => {
  it('PV-1：dry-run 首行是既有 K 文案', () => {
    expect(renderPlan(view(), 'dry-run').split('\n')[0]).toBe(DRY_HEAD)
  })
  it('PV-2：preview 首行是「执行计划预览：」', () => {
    expect(renderPlan(view(), 'preview').split('\n')[0]).toBe(PREVIEW_HEAD)
  })
  it('PV-3：两模式除首行外逐字相同（§13.9 一致性的结构保证）', () => {
    const d = renderPlan(view(), 'dry-run').split('\n').slice(1).join('\n')
    const p = renderPlan(view(), 'preview').split('\n').slice(1).join('\n')
    expect(p).toBe(d)
  })
  it('PV-4：group 条目 = 2 空格 heading + 4 空格明细行', () => {
    const lines = renderPlan(view(), 'preview').split('\n')
    expect(lines).toContain('  改写 apps/web/package.json:')
    expect(lines).toContain('    dependencies.@t/lib：^1.0.0 → link:../../lpm-lib')
  })
  it('PV-5：line 条目 2 空格缩进', () => {
    const lines = renderPlan(view(), 'preview').split('\n')
    expect(lines).toContain('  已链接跳过：@t/two')
    expect(lines).toContain('  peer 警告：apps/web/package.json（@t/lib）')
  })
  it('PV-6：verify === null 时不出现「复验」行', () => {
    expect(renderPlan(view(), 'preview')).not.toContain('复验：')
  })
  it('PV-7：verify 非 null 时出现在 install 之后', () => {
    const v = view()
    v.install = { command: 'pnpm install --no-frozen-lockfile', verify: 'node_modules 实际指向（残留/缺失将 pnpm install --force 重建）' }
    const lines = renderPlan(v, 'preview').split('\n')
    const i = lines.findIndex((l) => l.startsWith('  install：'))
    expect(lines[i + 1]).toBe('  复验：node_modules 实际指向（残留/缺失将 pnpm install --force 重建）')
  })
  it('PV-8：watch 为空数组时不出现 watch 行', () => {
    const v = view()
    v.watch = []
    expect(renderPlan(v, 'preview')).not.toContain('  watch：')
  })
  it('PV-9：install 为 null 时不出现 install 行', () => {
    const v = view()
    v.install = null
    expect(renderPlan(v, 'preview')).not.toContain('  install：')
  })
  it('PV-10：已安装段落在 entries 之后（行序 = entries 顺序 + install + watch）', () => {
    const lines = renderPlan(view(), 'preview').split('\n').filter((l) => l !== '')
    expect(lines[lines.length - 1]).toBe('  watch：拉起 ../../lpm-lib 的 build:watch（pnpm run build:watch）')
  })
  it('PV-11：返回值以单个换行结尾（与既有 stdout.write 调用形态一致）', () => {
    const out = renderPlan(view(), 'preview')
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})
