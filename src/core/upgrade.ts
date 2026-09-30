import semver from 'semver'
import { LOCAL_PROTOCOL_RE } from './rewriter.js'

export type UpgradeDecision =
  | { kind: 'behind'; next: string }
  | { kind: 'current' }
  | { kind: 'skip'; reason: 'local-protocol' | 'workspace-protocol' | 'unparseable' | 'unsupported-shape' }

/** 单个命中点的升级决策（spec §4.2 判定顺序，逐条短路，不可改序） */
export function decideUpgrade(declared: string, latest: string): UpgradeDecision {
  if (LOCAL_PROTOCOL_RE.test(declared)) return { kind: 'skip', reason: 'local-protocol' }
  if (/^(workspace|npm):/.test(declared)) return { kind: 'skip', reason: 'workspace-protocol' }
  if (declared.trim() === '' || semver.validRange(declared) === null) return { kind: 'skip', reason: 'unparseable' }
  if (semver.satisfies(latest, declared)) return { kind: 'current' }
  // latest 不比声明的精确版本新 → current（防御：不降级）
  if (semver.valid(declared) !== null && semver.lte(latest, declared)) return { kind: 'current' }
  // 计算保留前缀的新值（spec 裁决 8）
  if (semver.valid(declared) !== null) return { kind: 'behind', next: latest }
  if (/^\^(\d+\.\d+\.\d+)$/.test(declared)) return { kind: 'behind', next: `^${latest}` }
  if (/^~(\d+\.\d+\.\d+)$/.test(declared)) return { kind: 'behind', next: `~${latest}` }
  return { kind: 'skip', reason: 'unsupported-shape' }
}
