// seam: PanelTriState 组件 —— 面板三态包装哑组件（issue #668 / spec #667）。
// 好测试标准：只断言外部行为——渲染结构（data-state / data-test 钩子 / slot）、emits、
// 合成指针事件后的几何 emit 值；不断言内部实现。状态与钳制在宿主（usePanelTriState），
// 本组件 props-in/emits-out：拖拽只 emit 原始几何值，钳制由宿主做。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PanelTriState from '@/components/PanelTriState.vue'

// jsdom 无 PointerEvent 构造器：MouseEvent 按 'pointerdown' 类型分发同样触发 Vue 监听。
function pointerDown(el: Element, clientX: number): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX }))
}
function pointerMove(clientX: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX }))
}
function pointerUp(): void {
  window.dispatchEvent(new MouseEvent('pointerup', {}))
}

const SLOT = '<div data-test="slot-content">面板内容</div>'

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(PanelTriState, {
    props: {
      state: 'inline',
      inlineWidth: 220,
      defaultWidth: 220,
      poppedVw: 50,
      viewportWidth: 1280,
      label: '文件树',
      ...props,
    },
    slots: { default: SLOT },
  })
}

describe('PanelTriState — inline（常驻可拖宽）', () => {
  it('渲染 slot 内容 + 拖拽手柄 + 折叠按钮，根标记 data-state=inline', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('inline')
    expect(wrapper.find('[data-test="panel-body"]').element.contains(wrapper.find('[data-test="slot-content"]').element)).toBe(true)
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="collapse-btn"]').exists()).toBe(true)
  })

  it('宽度经 inline-width 渲染为 px', () => {
    const wrapper = mountPanel({ inlineWidth: 400 })
    expect(wrapper.find('[data-test="panel"]').attributes('style')).toContain('width: 400px')
  })

  it('点折叠按钮 emit collapse', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="collapse-btn"]').trigger('click')
    expect(wrapper.emitted('collapse')).toHaveLength(1)
  })

  it('left 面板拖手柄：右拖 emit resize-inline（未钳制原值），松手 emit drag-end', () => {
    const wrapper = mountPanel({ inlineWidth: 220 })
    pointerDown(wrapper.get('[data-test="drag-handle"]').element, 200)
    pointerMove(320) // 右拖 120px → 220+120
    expect(wrapper.emitted('resize-inline')).toEqual([[340]])
    pointerMove(180) // 左拖回退 20px → 220-20
    expect(wrapper.emitted('resize-inline')?.at(-1)).toEqual([200])
    pointerUp()
    expect(wrapper.emitted('drag-end')).toHaveLength(1)
    pointerMove(400) // 松手后拖拽结束，不再 emit
    expect(wrapper.emitted('resize-inline')).toHaveLength(2)
  })

  it('right 面板拖手柄：左拖变宽（镜像几何）', () => {
    const wrapper = mountPanel({ side: 'right', inlineWidth: 300 })
    pointerDown(wrapper.get('[data-test="drag-handle"]').element, 400)
    pointerMove(300) // 左拖 100px → 300+100
    expect(wrapper.emitted('resize-inline')?.at(-1)).toEqual([400])
    pointerUp()
  })

  it('手柄可聚焦且带 aria（键盘用户基线）', () => {
    const wrapper = mountPanel()
    const handle = wrapper.get('[data-test="drag-handle"]')
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-label')).toContain('文件树')
  })
})

describe('PanelTriState — collapsed（边缘窄条）', () => {
  it('渲染窄条 + 展开小按钮，不渲染 slot 内容', () => {
    const wrapper = mountPanel({ state: 'collapsed' })
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('collapsed')
    expect(wrapper.find('[data-test="rail"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="expand-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="slot-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(false)
  })

  it('点窄条 emit pop（不经过弹出步骤的显式事件）', async () => {
    const wrapper = mountPanel({ state: 'collapsed' })
    await wrapper.find('[data-test="rail"]').trigger('click')
    expect(wrapper.emitted('pop')).toHaveLength(1)
  })

  it('点展开小按钮 emit expand（不经弹出直接回 inline）', async () => {
    const wrapper = mountPanel({ state: 'collapsed' })
    await wrapper.find('[data-test="expand-btn"]').trigger('click')
    expect(wrapper.emitted('expand')).toHaveLength(1)
    expect(wrapper.emitted('pop')).toBeUndefined()
  })
})

describe('PanelTriState — popped（贴边全高非模态浮层）', () => {
  it('渲染 slot + 收回按钮 + 拖宽手柄，宽度为 vw，data-state=popped', () => {
    const wrapper = mountPanel({ state: 'popped', poppedVw: 60 })
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('popped')
    expect(wrapper.find('[data-test="slot-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="restore-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="pop-handle"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="panel"]').attributes('style')).toContain('width: 60vw')
  })

  it('点收回按钮 emit restore（唯一关闭途径）', async () => {
    const wrapper = mountPanel({ state: 'popped' })
    await wrapper.find('[data-test="restore-btn"]').trigger('click')
    expect(wrapper.emitted('restore')).toHaveLength(1)
  })

  it('拖 pop-handle：起始 px 由 poppedVw×viewport 换算，emit resize-popped 原始 px', () => {
    const wrapper = mountPanel({ state: 'popped', poppedVw: 50, viewportWidth: 1280 }) // 起始 640px
    pointerDown(wrapper.get('[data-test="pop-handle"]').element, 600)
    pointerMove(760) // 右拖 120px → 640+120=800
    expect(wrapper.emitted('resize-popped')?.at(-1)).toEqual([800])
    pointerUp()
    expect(wrapper.emitted('drag-end')).toHaveLength(1)
  })
})

describe('PanelTriState — disabled（窄屏 <720px 整体禁用）', () => {
  it('无手柄、无按钮、无窄条/浮层，slot 照常渲染，宽度用 defaultWidth', () => {
    const wrapper = mountPanel({ disabled: true, inlineWidth: 400, defaultWidth: 220 })
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('disabled')
    expect(wrapper.find('[data-test="slot-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="drag-handle"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="collapse-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="rail"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="panel"]').attributes('style')).toContain('width: 220px')
  })

  it('disabled 下手柄 pointerdown 不启动拖拽', () => {
    const wrapper = mountPanel({ disabled: true })
    pointerDown(wrapper.get('[data-test="panel"]').element, 200)
    pointerMove(400)
    expect(wrapper.emitted('resize-inline')).toBeUndefined()
  })
})
