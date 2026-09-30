import { describe, expect, it } from 'vitest'
import { injectAdaptation, removeFragment, findAllMarkers } from '../../src/core/utoopack.js'

describe('debug', () => {
  it('print', () => {
    const src = 'export default defineConfig({\n  utoopack: {}\n})\n'
    const out = injectAdaptation(src, '../..', {})
    console.log('INJECTED<<<')
    console.log(out)
    console.log('>>>INJECTED')
    console.log('MARKERS:', JSON.stringify(findAllMarkers(out)))
    const r = removeFragment(out)
    console.log('REMOVED<<<')
    console.log(JSON.stringify(r))
    console.log('>>>REMOVED')
    expect(true).toBe(true)
  })
})
