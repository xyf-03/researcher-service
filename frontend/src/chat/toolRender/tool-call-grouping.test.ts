// seam: chat/toolRender/tool-call-grouping —— #555 官方抄写(连续同类工具调用聚合摘要)纯函数单测。
// 行为依据 docs/research/555-official-tool-call-files.md §G(顺序固定/路径去重/others 规则/failed 追加)。

import { describe, expect, it } from 'vitest'
import { summarizeToolGroup } from './tool-call-grouping'

describe('summarizeToolGroup', () => {
  it('aggregates commands with count', () => {
    const cards = Array.from({ length: 13 }, () => ({ name: 'bash', args: { command: 'x' } }))
    expect(summarizeToolGroup(cards)).toBe('Ran 13 commands')
  })

  it('joins segments in fixed order commands → reads → edits → writes → searches → fetches → others', () => {
    const label = summarizeToolGroup([
      { name: 'read', args: { file_path: '/a.ts' } },
      { name: 'bash', args: { command: 'ls' } },
      { name: 'grep', args: { pattern: 'TODO' } },
      { name: 'write', args: { path: '/b.md' } },
    ])
    expect(label).toBe('Ran a command, read a file, created a file, ran a search')
  })

  it('deduplicates repeated reads of the same file into one file count', () => {
    const label = summarizeToolGroup([
      { name: 'read', args: { path: '/a.ts' } },
      { name: 'read', args: { path: '/a.ts' } },
    ])
    expect(label).toBe('Read a file')
  })

  it('counts distinct files across paths (read 2 files)', () => {
    const label = summarizeToolGroup([
      { name: 'read', args: { path: '/a.ts' } },
      { name: 'read', args: { path: '/b.ts' } },
    ])
    expect(label).toBe('Read 2 files')
  })

  it('appends · N failed when any call failed', () => {
    const label = summarizeToolGroup([
      { name: 'bash', args: { command: 'ok' } },
      { name: 'bash', args: { command: 'bad' }, isError: true },
      { name: 'read', args: { path: '/a.ts' }, isError: true },
    ])
    expect(label).toBe('Ran 2 commands, read a file · 2 failed')
  })

  it('uses named-tool labels for ≤2 distinct unknown tools', () => {
    expect(summarizeToolGroup([{ name: 'foo' }])).toBe('Used foo')
    expect(
      summarizeToolGroup([
        { name: 'foo' },
        { name: 'foo' },
        { name: 'bar' },
      ]),
    ).toBe('Used foo, bar ×3')
  })

  it('falls back to "used N tools" for 3+ distinct unknown tools', () => {
    expect(
      summarizeToolGroup([{ name: 'foo' }, { name: 'bar' }, { name: 'baz' }]),
    ).toBe('Used 3 tools')
  })

  it('falls back to the empty label when the batch is empty', () => {
    expect(summarizeToolGroup([])).toBe('Ran 0 tool calls')
  })

  it('singular counts read naturally (commandsOne/readsOne…)', () => {
    expect(summarizeToolGroup([{ name: 'bash', args: { command: 'x' } }])).toBe('Ran a command')
    expect(summarizeToolGroup([{ name: 'edit', args: { file_path: '/a.ts' } }])).toBe('Edited a file')
    expect(summarizeToolGroup([{ name: 'web_fetch', args: { url: 'https://x' } }])).toBe('Fetched a page')
  })
})
