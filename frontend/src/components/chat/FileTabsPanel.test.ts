// seam: FileTabsPanel 组件 —— 右面板壳（#626 T1 / #618 规格 §2，变体 A：360px 固定 + 横排 tab 条）。
// 哑组件：props 接 tabs + activePath，emits activate/close/closeAll。横排 tab 条（basename + ×）+
// 全关按钮 + 内嵌 FileViewer 渲染 active tab。无 tab 不占位由父 ChatView v-if 控制。T1 tab 仅 loaded/error。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileTabsPanel from '@/components/chat/FileTabsPanel.vue'
import type { FileTab } from '@/stores/fileTabs'

function tab(path: string, over: Partial<FileTab> = {}): FileTab {
  return { path, state: 'loaded', content: `c:${path}\n`, lineMarks: [], binary: false, oversized: false, ...over }
}

describe('FileTabsPanel', () => {
  it('renders a tab per file (basename label, full path title)', () => {
    const tabs = [tab('notes/plan.md'), tab('src/index.ts')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'notes/plan.md' } })
    expect(w.find('[data-test="tab-notes/plan.md"]').text()).toContain('plan.md')
    expect(w.find('[data-test="tab-src/index.ts"]').text()).toContain('index.ts')
    expect(w.find('[data-test="tab-notes/plan.md"]').attributes('title')).toBe('notes/plan.md')
  })

  it('marks the active tab', () => {
    const tabs = [tab('a.md'), tab('b.md')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'b.md' } })
    expect(w.find('[data-test="tab-b.md"]').classes()).toContain('active')
    expect(w.find('[data-test="tab-a.md"]').classes()).not.toContain('active')
  })

  it('emits activate with path when a tab is clicked', async () => {
    const tabs = [tab('a.md'), tab('b.md')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'a.md' } })
    await w.find('[data-test="tab-b.md"]').trigger('click')
    expect(w.emitted('activate')).toEqual([['b.md']])
  })

  it('emits close (not activate) when a tab × is clicked', async () => {
    const tabs = [tab('a.md'), tab('b.md')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'a.md' } })
    await w.find('[data-test="tab-close-a.md"]').trigger('click')
    expect(w.emitted('close')).toEqual([['a.md']])
    expect(w.emitted('activate')).toBeUndefined()
  })

  it('emits closeAll when the 全部关闭 button is clicked', async () => {
    const tabs = [tab('a.md')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'a.md' } })
    await w.find('[data-test="tabs-closeall"]').trigger('click')
    expect(w.emitted('closeAll')).toEqual([[]])
  })

  it('renders FileViewer for the active tab', () => {
    const tabs = [tab('a.md', { content: 'hello\n' })]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'a.md' } })
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(true)
    expect(w.find('[data-test="line-1"]').text()).toContain('hello')
  })

  it('renders empty body when activePath has no matching tab', () => {
    const tabs = [tab('a.md')]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: null } })
    expect(w.find('[data-test="file-viewer"]').exists()).toBe(false)
  })

  it('forwards retry from FileViewer with the active tab path（#628 T3）', async () => {
    const tabs = [tab('a.md', { state: 'error', content: null, errorMessage: '失败' })]
    const w = mount(FileTabsPanel, { props: { tabs, activePath: 'a.md' } })
    await w.find('[data-test="viewer-retry"]').trigger('click')
    expect(w.emitted('retry')).toEqual([['a.md']])
  })
})
