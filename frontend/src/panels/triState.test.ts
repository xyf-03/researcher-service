// seam: triState —— 面板三态纯逻辑（issue #668 / spec #667 决策层）。
// 状态机转移表（inline → collapsed → popped → inline；collapsed 可直接展开回 inline）、
// 宽度钳制、vw↔px 换算、拖拽几何、窄屏判定——全部纯函数，DOM 度量由宿主注入
// （贴滚动判定 shouldFollowBottom 先例：几何进参数，不摸 window/document）。
import { describe, expect, it } from 'vitest'
import {
  INLINE_RANGE_NARROW,
  INLINE_RANGE_WIDE,
  POPPED_DEFAULT_VW,
  POPPED_MAX_VW,
  POPPED_MIN_VW,
  TRI_STATE_MIN_VIEWPORT,
  clampPoppedVw,
  clampRange,
  draggedWidth,
  pxToVw,
  transitionPanelState,
  triStateEnabled,
  vwToPx,
} from '@/panels/triState'

describe('transitionPanelState（三态状态机）', () => {
  it('inline --collapse--> collapsed', () => {
    expect(transitionPanelState('inline', 'collapse')).toBe('collapsed')
  })

  it('collapsed --pop--> popped（点击窄条弹出）', () => {
    expect(transitionPanelState('collapsed', 'pop')).toBe('popped')
  })

  it('collapsed --expand--> inline（窄条展开小按钮，不经弹出）', () => {
    expect(transitionPanelState('collapsed', 'expand')).toBe('inline')
  })

  it('popped --restore--> inline（浮层显式收回）', () => {
    expect(transitionPanelState('popped', 'restore')).toBe('inline')
  })

  it('非法转移幂等返回原状态（如 inline 上误触 pop/expand）', () => {
    expect(transitionPanelState('inline', 'pop')).toBe('inline')
    expect(transitionPanelState('inline', 'expand')).toBe('inline')
    expect(transitionPanelState('inline', 'restore')).toBe('inline')
    expect(transitionPanelState('collapsed', 'collapse')).toBe('collapsed')
    expect(transitionPanelState('collapsed', 'restore')).toBe('collapsed')
    // popped 只能显式收回——不因 collapse 误触离开
    expect(transitionPanelState('popped', 'collapse')).toBe('popped')
    expect(transitionPanelState('popped', 'pop')).toBe('popped')
    expect(transitionPanelState('popped', 'expand')).toBe('popped')
  })
})

describe('clampRange（inline 拖宽硬边界）', () => {
  it('界内原样返回', () => {
    expect(clampRange(220, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(220)
    expect(clampRange(160, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(160)
    expect(clampRange(560, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(560)
  })

  it('越界钳制到 min/max（中间编辑区不被挤没）', () => {
    expect(clampRange(100, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(160)
    expect(clampRange(9999, INLINE_RANGE_NARROW.min, INLINE_RANGE_NARROW.max)).toBe(560)
  })

  it('wide 档（图谱/文件预览 240–720）同样生效', () => {
    expect(clampRange(100, INLINE_RANGE_WIDE.min, INLINE_RANGE_WIDE.max)).toBe(240)
    expect(clampRange(800, INLINE_RANGE_WIDE.min, INLINE_RANGE_WIDE.max)).toBe(720)
  })
})

describe('clampPoppedVw（浮层 50–90vw）', () => {
  it('默认 50vw、界内原样', () => {
    expect(POPPED_DEFAULT_VW).toBe(50)
    expect(clampPoppedVw(50)).toBe(50)
    expect(clampPoppedVw(75)).toBe(75)
    expect(clampPoppedVw(90)).toBe(90)
  })

  it('越界钳制', () => {
    expect(clampPoppedVw(10)).toBe(POPPED_MIN_VW)
    expect(clampPoppedVw(120)).toBe(POPPED_MAX_VW)
  })
})

describe('vw↔px 换算（viewport 由宿主注入）', () => {
  it('vwToPx / pxToVw 互逆', () => {
    expect(vwToPx(50, 1280)).toBe(640)
    expect(vwToPx(90, 1000)).toBe(900)
    expect(pxToVw(640, 1280)).toBe(50)
    expect(pxToVw(900, 1000)).toBe(90)
  })

  it('非整数 px 保留浮点 vw（拖拽连续调整，不取整步进）', () => {
    expect(pxToVw(645, 1280)).toBeCloseTo(50.390625)
    expect(vwToPx(pxToVw(645, 1280), 1280)).toBeCloseTo(645)
  })
})

describe('draggedWidth（拖拽几何：side 决定拖向）', () => {
  it('left 面板（手柄在右缘）：右拖变宽、左拖变窄', () => {
    expect(draggedWidth(220, 200, 320, 'left')).toBe(340)
    expect(draggedWidth(220, 200, 150, 'left')).toBe(170)
  })

  it('right 面板（手柄在左缘）：左拖变宽、右拖变窄', () => {
    expect(draggedWidth(300, 400, 300, 'right')).toBe(400)
    expect(draggedWidth(300, 400, 450, 'right')).toBe(250)
  })
})

describe('triStateEnabled（窄屏 <720px 整体禁用）', () => {
  it('≥720 启用，<720 禁用', () => {
    expect(TRI_STATE_MIN_VIEWPORT).toBe(720)
    expect(triStateEnabled(720)).toBe(true)
    expect(triStateEnabled(1024)).toBe(true)
    expect(triStateEnabled(719)).toBe(false)
    expect(triStateEnabled(375)).toBe(false)
  })
})
