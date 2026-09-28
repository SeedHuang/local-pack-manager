// 执行计划视图与渲染（S9 spec §4.4）。行为权威 = spec §4.4。
// 设计要点：link / unlink 共用一份渲染器——同一份 PlanView 在两种模式下只差首行，
// 这是「dry-run 输出与真实执行计划一致」（PRD §13 验收 9）的结构保证，不靠额外测试对齐。
// repair 不接本模块（S8 的 printPlan 已含三类信息且刚验收，spec §2 裁决 5）。

export type PlanEntry =
  | { kind: 'group'; heading: string; lines: string[] }
  | { kind: 'line'; text: string }

export interface PlanView {
  /** 明细条目：按各命令既有 dry-run 的行序填好文案（渲染器不重排、不改字） */
  entries: PlanEntry[]
  /** 尾部 install 段；verify 为 null 表示该命令不复验（link） */
  install: { command: string; verify: string | null } | null
  /** watch 行（已含「拉起 … 的 build:watch（… run build:watch）」正文） */
  watch: string[]
}

export type PlanMode = 'dry-run' | 'preview'

const TITLE: Record<PlanMode, string> = {
  'dry-run': 'dry-run 执行计划（不落任何盘、不执行任何子进程）：',
  preview: '执行计划预览：',
}

export function renderPlan(view: PlanView, mode: PlanMode): string {
  const out: string[] = [TITLE[mode]]
  for (const e of view.entries) {
    if (e.kind === 'group') {
      out.push(`  ${e.heading}`)
      for (const l of e.lines) out.push(`    ${l}`)
    } else {
      out.push(`  ${e.text}`)
    }
  }
  if (view.install !== null) {
    out.push(`  install：${view.install.command}（workspace 根）`)
    if (view.install.verify !== null) out.push(`  复验：${view.install.verify}`)
  }
  for (const w of view.watch) out.push(`  watch：${w}`)
  return `${out.join('\n')}\n`
}
