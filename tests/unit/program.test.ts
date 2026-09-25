import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli.js'
import { COMMANDS } from '../../src/commands/registry.js'

describe('program 组装', () => {
  it('注册命令名单与 COMMANDS 一致', () => {
    const program = buildProgram()
    expect(program.commands.map((c) => c.name())).toEqual(COMMANDS.map((c) => c.name))
  })

  it('含 --version 选项', () => {
    const longs = buildProgram().options.map((o) => o.long)
    expect(longs).toContain('--version')
  })
})
