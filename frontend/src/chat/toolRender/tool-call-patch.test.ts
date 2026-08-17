// seam: chat/toolRender/tool-call-patch —— #555 官方抄写(patch 工具三路解析:结构化 / Codex / unified)
// 纯函数单测。行为依据 docs/research/555-official-tool-call-files.md §F。

import { describe, expect, it } from 'vitest'
import { parsePatchView } from './tool-call-patch'

describe('parsePatchView', () => {
  it('returns null for non-object input', () => {
    expect(parsePatchView(null)).toBeNull()
    expect(parsePatchView('text')).toBeNull()
    expect(parsePatchView({})).toBeNull()
  })

  describe('structured changes', () => {
    it('parses {path, kind, diff} entries with per-entry stats', () => {
      const data = parsePatchView({
        changes: [
          { path: 'src/a.ts', kind: 'update', diff: '@@ -1,2 +1,2 @@\n old\n+new\n-new2' },
          { path: 'src/b.ts', kind: 'add', diff: 'hello\nworld' },
        ],
      })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['src/a.ts', 'src/b.ts'])
      // 多文件 patch 插 file 标题行,中间以 skip 分隔
      expect(data!.lines.filter((l) => l.kind === 'file').map((l) => l.text)).toEqual([
        'Update src/a.ts',
        'Add src/b.ts',
      ])
      expect(data!.stat).toEqual({ added: 3, removed: 1 })
    })

    it('honors an exact stat field and move paths', () => {
      const data = parsePatchView({
        changes: [{ path: 'old.ts', kind: { type: 'update', move_path: 'new.ts' }, stat: { added: 5, removed: 0 } }],
      })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['new.ts'])
      expect(data!.move).toEqual({ from: 'old.ts', to: 'new.ts' })
      expect(data!.stat).toEqual({ added: 5, removed: 0 })
    })

    it('skips entries without a path', () => {
      expect(parsePatchView({ changes: [{ kind: 'add', diff: 'x' }] })).toBeNull()
    })
  })

  describe('Codex apply_patch text', () => {
    const codexPatch = `*** Begin Patch
*** Update File: src/a.ts
@@ -1,2 +1,2 @@
-old
+new
*** Add File: src/b.txt
+hello
*** End Patch`

    it('parses Begin/Update/Add File markers into sections', () => {
      const data = parsePatchView({ patch: codexPatch })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['src/a.ts', 'src/b.txt'])
      expect(data!.lines.filter((l) => l.kind === 'file').map((l) => l.text)).toEqual([
        'Update src/a.ts',
        'Add src/b.txt',
      ])
      expect(data!.stat).toEqual({ added: 2, removed: 1 })
    })

    it('supports Move to:', () => {
      const data = parsePatchView({
        patch: '*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch',
      })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['new.ts'])
      expect(data!.move).toEqual({ from: 'old.ts', to: 'new.ts' })
    })
  })

  describe('unified diff text', () => {
    const unified = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`

    it('parses diff --git headers and hunk lines', () => {
      const data = parsePatchView({ patch: unified })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['src/a.ts'])
      expect(data!.stat).toEqual({ added: 1, removed: 1 })
      expect(data!.lines).toContainEqual({ kind: 'del', lineNo: 2, text: 'old line' })
      expect(data!.lines).toContainEqual({ kind: 'add', lineNo: 2, text: 'new line' })
    })

    it('handles /dev/null as add (new file)', () => {
      const data = parsePatchView({
        patch: `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+content`,
      })
      expect(data).not.toBeNull()
      expect(data!.paths).toEqual(['src/new.ts'])
      expect(data!.stat).toEqual({ added: 1, removed: 0 })
      expect(data!.lines).toContainEqual({ kind: 'add', lineNo: 1, text: 'content' })
    })
  })
})
