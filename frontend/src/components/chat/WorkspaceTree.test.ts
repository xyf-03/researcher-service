// seam: WorkspaceTree 组件 —— chat/ 页 workspace 递归文件树（#626 T1 / #618 规格 §2、变体 A）。
// 哑组件 props-in/emits-out（对齐 FileTree.vue 接缝）。DirListing.files 是扁平相对路径数组（recursive
// walk 全量），组件内部构造嵌套 → 按折叠态拍平渲染。覆盖：嵌套渲染、点文件 emit open、目录折叠/展开、
// truncated 树底提示、空 workspace 空态、treeError 错误空态、active 文件高亮。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import WorkspaceTree from '@/components/chat/WorkspaceTree.vue'
import type { DirListing, FileEntry } from '@/api/files'

function fe(path: string, type: 'file' | 'directory' = 'file'): FileEntry {
  return { path, type, size: type === 'file' ? 10 : 0, modified: '2026-08-12T00:00:00Z' }
}

const TREE: DirListing = {
  kind: 'dir',
  path: '',
  files: [
    fe('README.md'),
    fe('notes/plan.md'),
    fe('notes/todo.md'),
    fe('src/index.ts'),
  ],
  truncated: false,
}

describe('WorkspaceTree', () => {
  it('renders nested files (flat paths → indented tree), dirs first then files', () => {
    const w = mount(WorkspaceTree, { props: { tree: TREE, activePath: '' } })
    // 目录优先（notes/src 在 README.md 前），各自字母序
    expect(w.find('[data-test="dir-notes"]').exists()).toBe(true)
    expect(w.find('[data-test="dir-src"]').exists()).toBe(true)
    expect(w.find('[data-test="node-README.md"]').exists()).toBe(true)
    // 展开后子文件可见
    expect(w.find('[data-test="node-notes/plan.md"]').exists()).toBe(true)
    expect(w.find('[data-test="node-notes/todo.md"]').exists()).toBe(true)
    expect(w.find('[data-test="node-src/index.ts"]').exists()).toBe(true)
    // DFS 渲染顺序：notes 目录在 README.md 之前（目录优先）
    const names = w.findAll('[data-test^="dir-"], [data-test^="node-"]').map((r) => r.attributes('data-test') ?? '')
    const notesIdx = names.indexOf('dir-notes')
    const readmeIdx = names.indexOf('node-README.md')
    expect(notesIdx).toBeGreaterThanOrEqual(0)
    expect(readmeIdx).toBeGreaterThan(notesIdx)
  })

  it('emits open with full path when a file node is clicked', async () => {
    const w = mount(WorkspaceTree, { props: { tree: TREE, activePath: '' } })
    await w.find('[data-test="node-notes/plan.md"]').trigger('click')
    expect(w.emitted('open')).toEqual([['notes/plan.md']])
  })

  it('collapses/expands a directory on click (kids hide then reappear)', async () => {
    const w = mount(WorkspaceTree, { props: { tree: TREE, activePath: '' } })
    expect(w.find('[data-test="node-notes/plan.md"]').exists()).toBe(true)
    await w.find('[data-test="dir-notes"]').trigger('click') // 折叠
    expect(w.find('[data-test="node-notes/plan.md"]').exists()).toBe(false)
    expect(w.find('[data-test="node-notes/todo.md"]').exists()).toBe(false)
    await w.find('[data-test="dir-notes"]').trigger('click') // 展开
    expect(w.find('[data-test="node-notes/plan.md"]').exists()).toBe(true)
  })

  it('marks the active file node', () => {
    const w = mount(WorkspaceTree, { props: { tree: TREE, activePath: 'src/index.ts' } })
    expect(w.find('[data-test="node-src/index.ts"]').classes()).toContain('active')
  })

  it('shows truncated notice when listing.truncated is true', () => {
    const w = mount(WorkspaceTree, {
      props: { tree: { ...TREE, truncated: true }, activePath: '' },
    })
    expect(w.find('[data-test="tree-truncated"]').exists()).toBe(true)
    expect(w.text()).toContain('10000')
  })

  it('shows empty-state text when workspace has no files (and not truncated)', () => {
    const w = mount(WorkspaceTree, {
      props: { tree: { kind: 'dir', path: '', files: [], truncated: false }, activePath: '' },
    })
    expect(w.find('[data-test="tree-empty"]').exists()).toBe(true)
  })

  it('shows error-state text when treeError is set (tree fetch failed)', () => {
    const w = mount(WorkspaceTree, {
      props: { tree: null, treeError: '读取失败', activePath: '' },
    })
    expect(w.find('[data-test="tree-error"]').exists()).toBe(true)
    expect(w.text()).toContain('读取失败')
  })
})
