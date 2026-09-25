import { describe, expect, it } from 'vitest'
import { readProjectConfig, readState } from '../../src/state/index.js'

describe('state stub', () => {
  it('readState / readProjectConfig reject 且符合 not-implemented 约定', async () => {
    await expect(readState('C:/nowhere')).rejects.toThrow(
      /^not implemented: readState（计划 S4）$/,
    )
    await expect(readProjectConfig('C:/nowhere')).rejects.toThrow(
      /^not implemented: readProjectConfig（计划 S4）$/,
    )
  })
})
