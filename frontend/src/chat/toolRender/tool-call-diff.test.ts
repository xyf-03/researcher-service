// seam: chat/toolRender/tool-call-diff —— #555 官方抄写(diff 叶子,0 依赖)纯函数单测。
// 行为依据 docs/research/555-official-tool-call-files.md §D(行号/截断/skip 语义)。

import { describe, expect, it } from 'vitest'
import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  diffStat,
  joinDiffSections,
  MAX_DIFF_RENDER_LINES,
  parseDiffDetailsString,
  type DiffLine,
} from './tool-call-diff'

describe('diffStat', () => {
  it('counts add/del lines only', () => {
    const lines: DiffLine[] = [
      { kind: 'add', lineNo: 1, text: 'a' },
      { kind: 'del', lineNo: 1, text: 'b' },
      { kind: 'ctx', lineNo: 2, text: 'c' },
      { kind: 'skip', text: '' },
    ]
    expect(diffStat(lines)).toEqual({ added: 1, removed: 1 })
  })
})

describe('parseDiffDetailsString', () => {
  it('parses the edit tool generateDiffString format (+/-/ctx numbered lines)', () => {
    const lines = parseDiffDetailsString('+457 foo\n-455 bar\n 456 baz\n     ...\n')
    expect(lines).toEqual([
      { kind: 'add', lineNo: 457, text: 'foo' },
      { kind: 'del', lineNo: 455, text: 'bar' },
      { kind: 'ctx', lineNo: 456, text: 'baz' },
      { kind: 'skip', text: '' },
    ])
  })

  it('returns null when any non-empty line breaks the format (caller falls back to local diff)', () => {
    expect(parseDiffDetailsString('+457 foo\nnot a diff line\n')).toBeNull()
  })

  it('returns null when only context lines are present (no real change)', () => {
    expect(parseDiffDetailsString(' 456 baz\n 457 qux\n')).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(parseDiffDetailsString('  \n')).toBeNull()
  })

  it('appends a skip marker past MAX_DIFF_RENDER_LINES rows', () => {
    const rows = Array.from({ length: MAX_DIFF_RENDER_LINES + 5 }, (_, i) => `+${i} x`)
    const lines = parseDiffDetailsString(rows.join('\n'))
    expect(lines).not.toBeNull()
    expect(lines!.filter((l) => l.kind === 'skip').length).toBe(1)
  })
})

describe('computeLineDiff', () => {
  it('marks unchanged lines as ctx and changed lines as del/add', () => {
    const lines = computeLineDiff('a\nb\nc\n', 'a\nb\nx\nc\n')
    expect(lines).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('treats an empty old side as a pure insertion and vice versa', () => {
    expect(computeLineDiff('', 'x\ny')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
    ])
    expect(computeLineDiff('x\ny', '')).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'del', text: 'y' },
    ])
  })

  it('normalizes CRLF and drops the trailing-newline phantom row', () => {
    expect(computeLineDiff('a\r\nb', 'a\nb')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
    ])
  })

  it('bails to a skip marker when inputs exceed MAX_DIFF_INPUT_LINES (600)', () => {
    const big = Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n')
    const lines = computeLineDiff(big, big)
    expect(lines.at(-1)?.kind).toBe('skip')
  })

  it('compacts long diffs to changed lines ±3 context rows with skip separators', () => {
    const oldText = Array.from({ length: 500 }, (_, i) => `keep ${i}`).join('\n')
    const newText = Array.from({ length: 500 }, (_, i) =>
      i === 250 ? 'CHANGED' : `keep ${i}`,
    ).join('\n')
    const lines = computeLineDiff(oldText, newText)
    expect(lines.some((l) => l.kind === 'del' && l.text === 'keep 250')).toBe(true)
    expect(lines.some((l) => l.kind === 'add' && l.text === 'CHANGED')).toBe(true)
    expect(lines.some((l) => l.kind === 'skip')).toBe(true)
    expect(lines.length).toBeLessThan(100)
  })
})

describe('buildWriteDiffLines', () => {
  it('produces an all-added preview numbered from line 1', () => {
    const lines = buildWriteDiffLines('a\nb\n')
    expect(lines).toEqual([
      { kind: 'add', lineNo: 1, text: 'a' },
      { kind: 'add', lineNo: 2, text: 'b' },
    ])
  })

  it('caps at maxLines (default 80) with a skip marker', () => {
    const lines = buildWriteDiffLines(Array.from({ length: 90 }, (_, i) => `l${i}`).join('\n'))
    expect(lines.length).toBe(81)
    expect(lines.at(-1)).toEqual({ kind: 'skip', text: '' })
  })
})

describe('countTextLines', () => {
  it('counts lines with trailing-newline semantics (empty → 0)', () => {
    expect(countTextLines('')).toBe(0)
    expect(countTextLines('a')).toBe(1)
    expect(countTextLines('a\nb\n')).toBe(2)
  })
})

describe('joinDiffSections', () => {
  it('joins sections separated by skip rows', () => {
    const joined = joinDiffSections([
      [{ kind: 'add', text: 'a' }],
      [{ kind: 'del', text: 'b' }],
    ])
    expect(joined).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'skip', text: '' },
      { kind: 'del', text: 'b' },
    ])
  })

  it('truncates past maxLines with a trailing skip marker', () => {
    const joined = joinDiffSections([Array.from({ length: 10 }, (): DiffLine => ({ kind: 'add', text: 'x' }))], {
      maxLines: 3,
    })
    expect(joined.length).toBe(4)
    expect(joined.at(-1)).toEqual({ kind: 'skip', text: '' })
  })
})
