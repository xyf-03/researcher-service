// seam: usePanelTriState —— 三态包装 composable（issue #668 / spec #667）。
// 好测试标准：只断言外部行为——状态/宽度 refs 的值、持久化副作用（jsdom localStorage
// 真身）、合成指针事件驱动真 PanelTriState 的全链路；不断言内部实现。
// 依赖注入（storage/viewport/token）由 options 传入，测试可控。
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PanelTriState from '@/components/PanelTriState.vue'
import { usePanelTriState } from '@/panels/usePanelTriState'
import { panelWidthKey } from '@/panels/panelWidth'
import { INLINE_RANGE_NARROW } from '@/panels/triState'

function mountHarness(options: Parameters<typeof usePanelTriState>[0]) {
  let api!: ReturnType<typeof usePanelTriState>
  mount(defineComponent({
    setup() {
      api = usePanelTriState(options)
      return () => h('div')
    },
  }))
  return api
}

function keyOf(owner: string): string {
  return panelWidthKey(owner, 'wiki', 'file-tree')
}

const BASE = {
  view: 'wiki',
  panel: 'file-tree',
  inlineRange: INLINE_RANGE_NARROW,
  defaultInlineWidth: 220,
  token: () => 'header.' + btoa(JSON.stringify({ sub: 'alice' })) + '.sig',
} as const

describe('usePanelTriState — 初始态', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('每次进页恒 inline（collapsed/popped 不持久化），宽度默认值，浮层默认 50vw', () => {
    const p = mountHarness(BASE)
    expect(p.state.value).toBe('inline')
    expect(p.inlineWidth.value).toBe(220)
    expect(p.poppedVw.value).toBe(50)
    expect(p.disabled.value).toBe(false)
  })

  it('storage 有值则恢复宽度', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '400')
    const p = mountHarness(BASE)
    expect(p.inlineWidth.value).toBe(400)
  })

  it('恢复值越界时钳制', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '9999')
    expect(mountHarness(BASE).inlineWidth.value).toBe(560)
  })

  it('按用户 token 隔离：alice 存的宽度 bob 读不到', () => {
    globalThis.localStorage.setItem(keyOf('alice'), '400')
    const bob = mountHarness({ ...BASE, token: () => 'header.' + btoa(JSON.stringify({ sub: 'bob' })) + '.sig' })
    expect(bob.inlineWidth.value).toBe(220)
  })
})

describe('usePanelTriState — 状态机驱动', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('折叠 → 弹出 → 收回 全链路', () => {
    const p = mountHarness(BASE)
    p.onCollapse()
    expect(p.state.value).toBe('collapsed')
    p.onPop()
    expect(p.state.value).toBe('popped')
    p.onRestore()
    expect(p.state.value).toBe('inline')
  })

  it('窄条展开小按钮不经弹出直接回 inline', () => {
    const p = mountHarness(BASE)
    p.onCollapse()
    p.onExpand()
    expect(p.state.value).toBe('inline')
    expect(p.poppedVw.value).toBe(50) // 未经过弹出
  })

  it('resize 钳制：inline 160–560、popped 50–90vw（viewport 注入）', () => {
    const p = mountHarness({ ...BASE, getViewportWidth: () => 1280 })
    p.onResizeInline(1000)
    expect(p.inlineWidth.value).toBe(560)
    p.onResizeInline(50)
    expect(p.inlineWidth.value).toBe(160)
    p.onResizePopped(960) // 1280×75%
    expect(p.poppedVw.value).toBe(75)
    p.onResizePopped(100)
    expect(p.poppedVw.value).toBe(50)
  })
})

describe('usePanelTriState — 持久化时机（仅 inline 宽度）', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('inline 拖拽结束写入 storage', () => {
    const p = mountHarness(BASE)
    p.onResizeInline(480)
    p.onDragEnd()
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBe('480')
  })

  it('popped 拖拽结束不写入（浮层宽度不持久化）', () => {
    const p = mountHarness(BASE)
    p.onCollapse()
    p.onPop()
    p.onResizePopped(900)
    p.onDragEnd()
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBeNull()
  })
})

describe('usePanelTriState — 窄屏禁用（viewport 注入 + resize 联动）', () => {
  beforeEach(() => globalThis.localStorage.clear())

  it('<720 禁用，≥720 启用', () => {
    const p = mountHarness({ ...BASE, getViewportWidth: () => 500 })
    expect(p.disabled.value).toBe(true)
    expect(p.viewportWidth.value).toBe(500)
  })

  it('窗口 resize 跨阈值时联动（用户拉伸窗口）', () => {
    const getViewportWidth = vi.fn(() => 1024)
    const p = mountHarness({ ...BASE, getViewportWidth })
    expect(p.disabled.value).toBe(false)
    getViewportWidth.mockReturnValue(600)
    window.dispatchEvent(new Event('resize'))
    expect(p.disabled.value).toBe(true)
    getViewportWidth.mockReturnValue(1024)
    window.dispatchEvent(new Event('resize'))
    expect(p.disabled.value).toBe(false)
  })
})

describe('usePanelTriState — 端到端：真 PanelTriState + 合成指针事件 + localStorage', () => {
  beforeEach(() => globalThis.localStorage.clear())

  function mountE2E() {
    let api!: ReturnType<typeof usePanelTriState>
    const harness = defineComponent({
      setup() {
        api = usePanelTriState(BASE)
        return () => h(PanelTriState, {
          state: api.state.value,
          inlineWidth: api.inlineWidth.value,
          defaultWidth: 220,
          poppedVw: api.poppedVw.value,
          viewportWidth: api.viewportWidth.value,
          label: '文件树',
          'onCollapse': api.onCollapse,
          'onPop': api.onPop,
          'onExpand': api.onExpand,
          'onRestore': api.onRestore,
          'onResizeInline': api.onResizeInline,
          'onResizePopped': api.onResizePopped,
          'onDragEnd': api.onDragEnd,
        }, { default: () => h('div', '内容') })
      },
    })
    return { wrapper: mount(harness), api }
  }

  it('拖拽 → 宽度钳制更新 → 松手落 storage → 重进恢复', async () => {
    const { wrapper, api } = mountE2E()
    const handle = wrapper.get('[data-test="drag-handle"]')
    handle.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 480 })) // 220+280=500，界内
    expect(api.inlineWidth.value).toBe(500)
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 800 })) // 220+600=820 → 钳 560
    expect(api.inlineWidth.value).toBe(560)
    window.dispatchEvent(new MouseEvent('pointerup', {}))
    expect(globalThis.localStorage.getItem(keyOf('alice'))).toBe('560')

    // 重进（重新挂载 harness）→ 宽度恢复，形态恒 inline
    const again = mountE2E()
    expect(again.api.state.value).toBe('inline')
    expect(again.api.inlineWidth.value).toBe(560)
  })

  it('折叠 → 点窄条弹出 → 收回，全链路事件驱动', async () => {
    const { wrapper, api } = mountE2E()
    await wrapper.get('[data-test="collapse-btn"]').trigger('click')
    expect(wrapper.find('[data-test="rail"]').exists()).toBe(true)
    await wrapper.get('[data-test="rail"]').trigger('click')
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('popped')
    await wrapper.get('[data-test="restore-btn"]').trigger('click')
    expect(wrapper.find('[data-test="panel"]').attributes('data-state')).toBe('inline')
    expect(api.state.value).toBe('inline')
  })
})
