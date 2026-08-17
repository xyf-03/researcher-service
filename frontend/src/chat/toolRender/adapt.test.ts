// seam: chat/toolRender/adapt —— #555 数据适配(渲染层 ToolRow → view-model 三元组)纯函数单测。
// 翻译层接缝风格:喂 ToolRow(翻译层产物)→ 断言适配产出的 ToolCallView / 聚合输入。
// args←ToolRow.input、details←ToolRow.result(#579 数据适配三元组)。

import { describe, expect, it } from 'vitest'
import { toolRowToGroupInput, toolRowToView } from './adapt'
import type { ToolRow } from '@/stores/chat'

function row(partial: Partial<ToolRow>): ToolRow {
  return { id: 't1', name: 'bash', state: 'done', title: null, input: null, result: null, ...partial }
}

describe('toolRowToView', () => {
  it('maps args←input (call arguments) for command tools', () => {
    const view = toolRowToView(row({ name: 'bash', input: { command: 'sh -lc "echo hi"' } }))
    expect(view).toEqual({ kind: 'command', command: 'echo hi' })
  })

  it('maps details←result (result-side details) for edit diff', () => {
    const view = toolRowToView(
      row({
        name: 'edit',
        input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
        result: { diff: '+457 foo\n-455 bar\n' },
      }),
    )
    expect(view.diff).toEqual([
      { kind: 'add', lineNo: 457, text: 'foo' },
      { kind: 'del', lineNo: 455, text: 'bar' },
    ])
    expect(view.stat).toEqual({ added: 1, removed: 1 })
  })

  it('falls back to a local diff when result carries no diff details', () => {
    const view = toolRowToView(
      row({ name: 'edit', input: { file_path: '/a.ts', old_string: 'one', new_string: 'two' }, result: {} }),
    )
    expect(view.diff).toEqual([
      { kind: 'del', text: 'one' },
      { kind: 'add', text: 'two' },
    ])
  })

  it('keeps ToolRow.input untouched (no mutation, no drop)', () => {
    const input = { command: 'ls -la' }
    const tool = row({ name: 'bash', input })
    toolRowToView(tool)
    expect(tool.input).toBe(input)
    expect(tool).toHaveProperty('input')
  })
})

describe('toolRowToGroupInput', () => {
  it('maps {name, args←input, isError←state==="error"}', () => {
    expect(toolRowToGroupInput(row({ name: 'bash', input: { command: 'x' }, state: 'running' }))).toEqual({
      name: 'bash',
      args: { command: 'x' },
      isError: false,
    })
    expect(toolRowToGroupInput(row({ name: 'read', input: { path: '/a.ts' }, state: 'error' }))).toEqual({
      name: 'read',
      args: { path: '/a.ts' },
      isError: true,
    })
  })
})
