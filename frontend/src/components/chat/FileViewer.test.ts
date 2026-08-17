// seam: FileViewer 组件 —— 只读全文查看器（#626 T1 / #618 规格 §5.3、变体 A）。
// 哑组件纯展示 FileTab：等宽 + 行号 + lineMarks 命中行底色 + 各空态（binary/oversized/error/loading）。
// 只读不回写、无语法高亮、零新依赖。T1 树点击 lineMarks 恒 []（无高亮），后续 agent 票写入高亮行号。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FileViewer from '@/components/chat/FileViewer.vue'
import type { FileTab } from '@/stores/fileTabs'

function tab(over: Partial<FileTab> = {}): FileTab {
  return {
    path: 'notes/plan.md',
    state: 'loaded',
    content: '# plan\n第二行\n第三行\n',
    lineMarks: [],
    binary: false,
    oversized: false,
    ...over,
  }
}

describe('FileViewer', () => {
  it('renders line numbers + content (monospace) for loaded text', () => {
    const w = mount(FileViewer, { props: { tab: tab() } })
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(true)
    expect(w.find('[data-test="line-1"]').text()).toContain('# plan')
    expect(w.find('[data-test="line-3"]').text()).toContain('第三行')
    // 行号存在
    expect(w.find('[data-test="line-2"]').text()).toContain('2')
  })

  it('highlights lineMarks rows with add bg', () => {
    const w = mount(FileViewer, { props: { tab: tab({ lineMarks: [3] }) } })
    expect(w.find('[data-test="line-3"]').classes()).toContain('hl')
    expect(w.find('[data-test="line-1"]').classes()).not.toContain('hl')
  })

  it('shows binary empty-state (no content rendered)', () => {
    const w = mount(FileViewer, { props: { tab: tab({ binary: true, content: null }) } })
    expect(w.find('[data-test="viewer-binary"]').exists()).toBe(true)
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(false)
  })

  it('shows oversized empty-state (no content rendered)', () => {
    const w = mount(FileViewer, { props: { tab: tab({ oversized: true, content: null }) } })
    expect(w.find('[data-test="viewer-oversized"]').exists()).toBe(true)
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(false)
  })

  it('shows error empty-state with message', () => {
    const w = mount(FileViewer, { props: { tab: tab({ state: 'error', content: null, errorMessage: '文件不存在' }) } })
    expect(w.find('[data-test="viewer-error"]').exists()).toBe(true)
    expect(w.text()).toContain('文件不存在')
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(false)
  })

  it('error 态渲染「重试」按钮，点击 emit retry（#628 T3）', async () => {
    const w = mount(FileViewer, { props: { tab: tab({ state: 'error', content: null, errorMessage: '文件不存在' }) } })
    expect(w.find('[data-test="viewer-retry"]').exists()).toBe(true)
    expect(w.find('[data-test="viewer-retry"]').text()).toContain('重试')
    await w.find('[data-test="viewer-retry"]').trigger('click')
    expect(w.emitted('retry')).toEqual([['notes/plan.md']])
  })

  it('shows loading hint when loaded but content still null (fetch in flight)', () => {
    const w = mount(FileViewer, { props: { tab: tab({ content: null }) } })
    expect(w.find('[data-test="viewer-loading"]').exists()).toBe(true)
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(false)
  })

  it('shows pending skeleton when agent running (state=pending)', () => {
    const w = mount(FileViewer, { props: { tab: tab({ state: 'pending', content: null }) } })
    expect(w.find('[data-test="viewer-pending"]').exists()).toBe(true)
    expect(w.findAll('.skel-line').length).toBeGreaterThan(0)
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(false)
    expect(w.find('[data-test="viewer-loading"]').exists()).toBe(false) // 与 fetch-in-flight 区分
  })

  it('renders an empty file (content === "") without crashing', () => {
    const w = mount(FileViewer, { props: { tab: tab({ content: '' }) } })
    expect(w.find('[data-test="viewer-content"]').exists()).toBe(true)
  })
})
