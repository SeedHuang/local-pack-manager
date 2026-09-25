import { describe, expect, it } from 'vitest'
import { readState } from '../../src/state/index.js'

describe('state stub', () => {
  it('readState reject 且符合 not-implemented 约定（readProjectConfig/writeProjectConfig 已由 S3 提前实现）', async () => {
    await expect(readState('C:/nowhere')).rejects.toThrow(/^not implemented: readState（计划 S4）$/)
  })
})
