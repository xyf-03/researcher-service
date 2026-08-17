// seam: chat/toolRender/tool-call-view —— #555 官方抄写(view-model 分类/路径/命令剥壳/diff 组装)
// 纯函数单测。行为依据 docs/research/555-official-tool-call-files.md §A/B/C/E。

import { describe, expect, it } from 'vitest'
import {
  resolveToolCallKind,
  resolveToolCallTargetPaths,
  resolveToolCallView,
  unwrapShellWrapperCommand,
} from './tool-call-view'

describe('resolveToolCallKind', () => {
  it('classifies the standard tool name tables (case/whitespace insensitive)', () => {
    expect(resolveToolCallKind('Bash')).toBe('command')
    expect(resolveToolCallKind('read_file')).toBe('read')
    expect(resolveToolCallKind('edit_file')).toBe('edit')
    expect(resolveToolCallKind('write_file')).toBe('write')
    expect(resolveToolCallKind('grep')).toBe('search')
    expect(resolveToolCallKind('web_fetch')).toBe('fetch')
  })

  it('sub-classifies text-editor tools by args.command', () => {
    expect(resolveToolCallKind('str_replace_editor', { command: 'view' })).toBe('read')
    expect(resolveToolCallKind('str_replace_editor', { command: 'str_replace' })).toBe('edit')
    expect(resolveToolCallKind('str_replace_editor', { command: 'insert' })).toBe('edit')
    expect(resolveToolCallKind('str_replace_editor', { command: 'undo_edit' })).toBe('edit')
    expect(resolveToolCallKind('str_replace_editor', { command: 'create' })).toBe('write')
    expect(resolveToolCallKind('str_replace_editor', { command: 'unknown' })).toBe('generic')
    expect(resolveToolCallKind('str_replace_editor')).toBe('generic')
  })

  it('treats patch tools as edit', () => {
    expect(resolveToolCallKind('apply_patch')).toBe('edit')
    expect(resolveToolCallKind('applypatch')).toBe('edit')
    expect(resolveToolCallKind('patch')).toBe('edit')
  })

  it('falls back to a command by arg shape (string command field, ≤3 keys)', () => {
    expect(resolveToolCallKind('my_tool', { command: 'do stuff', cwd: '/tmp' })).toBe('command')
    expect(resolveToolCallKind('my_tool', { command: 'x', a: 1, b: 2, c: 3 })).toBe('generic')
    expect(resolveToolCallKind('my_tool', { command: 42 })).toBe('generic')
  })

  it('defaults unknown tools to generic', () => {
    expect(resolveToolCallKind('some_unknown_tool')).toBe('generic')
  })
})

describe('resolveToolCallTargetPaths', () => {
  it('reads the first non-empty path variant across harness spellings', () => {
    expect(resolveToolCallTargetPaths('read', { path: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(resolveToolCallTargetPaths('read', { file_path: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(resolveToolCallTargetPaths('read', { filePath: '/a/b.ts' })).toEqual(['/a/b.ts'])
    expect(resolveToolCallTargetPaths('read', { filename: '/a/b.ts' })).toEqual(['/a/b.ts'])
    // path 优先于后置变体
    expect(resolveToolCallTargetPaths('read', { path: '/a.ts', file_path: '/b.ts' })).toEqual(['/a.ts'])
  })

  it('returns patch paths for patch tools', () => {
    const paths = resolveToolCallTargetPaths('apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@\n-old\n+new\n*** End Patch',
    })
    expect(paths).toEqual(['src/a.ts'])
  })

  it('returns [] when no path is present', () => {
    expect(resolveToolCallTargetPaths('read', {})).toEqual([])
  })
})

describe('resolveToolCallView', () => {
  it('command: unwraps the shell wrapper and shows the full command', () => {
    const view = resolveToolCallView({ name: 'bash', args: { command: 'sh -lc "echo hi"' } })
    expect(view.kind).toBe('command')
    expect(view.command).toBe('echo hi')
  })

  it('command: keeps the command as-is when no wrapper matches', () => {
    const view = resolveToolCallView({ name: 'exec', args: { command: 'ls -la\npwd' } })
    expect(view).toEqual({ kind: 'command', command: 'ls -la\npwd' })
  })

  it('read: target is the basename (bold), targetDetail the directory (dimmed)', () => {
    const view = resolveToolCallView({ name: 'read', args: { file_path: '/repo/src/util.ts' } })
    expect(view).toEqual({ kind: 'read', target: 'util.ts', targetDetail: '/repo/src' })
  })

  it('read: root-level file keeps the full path as target (slash at index 0)', () => {
    expect(resolveToolCallView({ name: 'read', args: { path: '/notes.md' } })).toEqual({
      kind: 'read',
      target: '/notes.md',
    })
  })

  it('read: missing path degrades to generic', () => {
    expect(resolveToolCallView({ name: 'read', args: {} }).kind).toBe('generic')
  })

  it('edit: prefers details.diff (precomputed generateDiffString) over local diff', () => {
    const view = resolveToolCallView({
      name: 'edit',
      args: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' },
      details: { diff: '+457 foo\n-455 bar\n' },
    })
    expect(view.kind).toBe('edit')
    expect(view.target).toBe('a.ts')
    expect(view.targetDetail).toBe('/repo')
    expect(view.diff).toEqual([
      { kind: 'add', lineNo: 457, text: 'foo' },
      { kind: 'del', lineNo: 455, text: 'bar' },
    ])
    expect(view.stat).toEqual({ added: 1, removed: 1 })
  })

  it('edit: falls back to a local computeLineDiff when details.diff is absent', () => {
    const view = resolveToolCallView({
      name: 'edit',
      args: { file_path: '/repo/a.ts', old_string: 'one', new_string: 'two' },
    })
    expect(view).toEqual({
      kind: 'edit',
      target: 'a.ts',
      targetDetail: '/repo',
      diff: [
        { kind: 'del', text: 'one' },
        { kind: 'add', text: 'two' },
      ],
      stat: { added: 1, removed: 1 },
    })
  })

  it('edit: multi-edit pairs each get their own local diff joined with skip rows', () => {
    const view = resolveToolCallView({
      name: 'edit',
      args: {
        file_path: '/repo/a.ts',
        edits: [
          { old_string: 'a1', new_string: 'b1' },
          { old_string: 'a2', new_string: 'b2' },
        ],
      },
    })
    expect(view.diff).toEqual([
      { kind: 'del', text: 'a1' },
      { kind: 'add', text: 'b1' },
      { kind: 'skip', text: '' },
      { kind: 'del', text: 'a2' },
      { kind: 'add', text: 'b2' },
    ])
  })

  it('text-editor insert: local diff from empty against insert_text, no stat (unknown context)', () => {
    const view = resolveToolCallView({
      name: 'str_replace_editor',
      args: { command: 'insert', insert_text: 'new line', path: '/a.ts' },
    })
    expect(view.diff).toEqual([{ kind: 'add', text: 'new line' }])
    expect(view.stat).toBeUndefined()
  })

  it('write: details.diff is authoritative when present', () => {
    const view = resolveToolCallView({
      name: 'write',
      args: { file_path: '/repo/a.ts', content: 'ignored' },
      details: { diff: '+1 created\n' },
    })
    expect(view.diff).toEqual([{ kind: 'add', lineNo: 1, text: 'created' }])
  })

  it('write: changed===false yields no diff', () => {
    const view = resolveToolCallView({
      name: 'write',
      args: { file_path: '/repo/a.ts', content: 'x' },
      details: { changed: false },
    })
    expect(view).toEqual({ kind: 'write', target: 'a.ts', targetDetail: '/repo' })
  })

  it('write: new-file content renders as an all-add preview with stat', () => {
    const view = resolveToolCallView({ name: 'write', args: { path: '/repo/a.ts', content: 'x\ny' } })
    expect(view.diff).toEqual([
      { kind: 'add', lineNo: 1, text: 'x' },
      { kind: 'add', lineNo: 2, text: 'y' },
    ])
    expect(view.stat).toEqual({ added: 2, removed: 0 })
  })

  it('text-editor create: content comes from file_text', () => {
    const view = resolveToolCallView({
      name: 'str_replace_editor',
      args: { command: 'create', file_text: 'hello', path: '/a.ts' },
    })
    expect(view.kind).toBe('write')
    expect(view.diff).toEqual([{ kind: 'add', lineNo: 1, text: 'hello' }])
  })

  it('search: target is the pattern, targetDetail the search scope path', () => {
    const view = resolveToolCallView({ name: 'grep', args: { pattern: 'TODO', path: '/src' } })
    expect(view).toEqual({ kind: 'search', target: 'TODO', targetDetail: '/src' })
    expect(resolveToolCallView({ name: 'grep', args: { query: 'x' } }).target).toBe('x')
    expect(resolveToolCallView({ name: 'glob', args: { glob: '**/*.ts' } }).target).toBe('**/*.ts')
  })

  it('fetch: target is the url', () => {
    expect(resolveToolCallView({ name: 'web_fetch', args: { url: 'https://x.com' } })).toEqual({
      kind: 'fetch',
      target: 'https://x.com',
    })
  })

  it('generic: unknown tools degrade to a readable generic row', () => {
    expect(resolveToolCallView({ name: 'mystery_tool', args: { foo: 1 } })).toEqual({ kind: 'generic' })
  })

  it('details side is consulted through the result slot (args ← input, details ← result)', () => {
    const view = resolveToolCallView({
      name: 'edit',
      args: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
      details: { diff: '+9 fixed\n-8 broken\n' },
    })
    expect(view.diff).toEqual([
      { kind: 'add', lineNo: 9, text: 'fixed' },
      { kind: 'del', lineNo: 8, text: 'broken' },
    ])
  })
})

describe('unwrapShellWrapperCommand', () => {
  it('strips sh -lc / bash -c style wrappers (display-only)', () => {
    expect(unwrapShellWrapperCommand('sh -lc "echo hi"')).toBe('echo hi')
    expect(unwrapShellWrapperCommand("bash -c 'ls -la'")).toBe('ls -la')
    expect(unwrapShellWrapperCommand('/bin/bash -lc "pwd"')).toBe('pwd')
    expect(unwrapShellWrapperCommand('  zsh -c "date"  ')).toBe('date')
  })

  it('returns the command unchanged when no wrapper matches', () => {
    expect(unwrapShellWrapperCommand('git status')).toBe('git status')
    expect(unwrapShellWrapperCommand('echo sh -lc "not a wrapper"')).toBe('echo sh -lc "not a wrapper"')
  })
})
