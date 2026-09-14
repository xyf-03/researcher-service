// 面板三态（panel tri-state，CONTEXT.md 词汇）纯逻辑层——issue #668 / spec #667。
// 三种呈现态：inline（常驻可拖宽）/ collapsed（边缘窄条）/ popped（贴边全高非模态浮层）；
// 决策逻辑全部为纯函数，DOM 度量（指针坐标、视口宽）由宿主注入——贴滚动判定
// shouldFollowBottom 先例（几何进参数，不摸 window/document），可脱离 DOM 直测。

// 面板呈现态。窄屏 (<720px) 三态整体禁用（宿主经 triStateEnabled 判定后传 disabled）。
export type PanelState = 'inline' | 'collapsed' | 'popped'

// 驱动状态机的事件：折叠按钮 / 点击窄条 / 窄条展开小按钮 / 浮层收回按钮。
export type PanelEvent = 'collapse' | 'pop' | 'expand' | 'restore'

// 面板贴边侧：left = 面板在左（手柄在右缘，右拖变宽）；right 镜像。
export type PanelSide = 'left' | 'right'

// 转移表（grilling 设计会话定案，spec #667）：
//   inline --collapse--> collapsed --pop--> popped --restore--> inline
//                         └--expand--> inline
// 其余事件一律幂等停在原态（如 popped 不因 collapse 误触离开——浮层只经显式收回关闭）。
const TRANSITIONS: Record<PanelState, Partial<Record<PanelEvent, PanelState>>> = {
  inline: { collapse: 'collapsed' },
  collapsed: { pop: 'popped', expand: 'inline' },
  popped: { restore: 'inline' },
}

export function transitionPanelState(state: PanelState, event: PanelEvent): PanelState {
  return TRANSITIONS[state][event] ?? state
}

// inline 宽度档（spec #667）：chat 左栏与 wiki 文件树 160–560px；wiki 图谱与 chat 文件预览 240–720px。
// 后续面板票复用同档常量，不各写字面量。
export interface WidthRange {
  min: number
  max: number
}

export const INLINE_RANGE_NARROW: WidthRange = { min: 160, max: 560 }
export const INLINE_RANGE_WIDE: WidthRange = { min: 240, max: 720 }

export function clampRange(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, width))
}

// popped 浮层宽度：默认占屏一半，50–90vw 连续可调。
export const POPPED_MIN_VW = 50
export const POPPED_MAX_VW = 90
export const POPPED_DEFAULT_VW = 50

export function clampPoppedVw(vw: number): number {
  return clampRange(vw, POPPED_MIN_VW, POPPED_MAX_VW)
}

// vw 数值（50 = 50vw）↔ px；viewportWidth 由宿主注入（jsdom 无布局）。
// pxToVw 保留浮点不取整——拖拽「连续调整」（spec 验收），取整会在大屏产生 ~13px 步进。
export function vwToPx(vw: number, viewportWidth: number): number {
  return (vw / 100) * viewportWidth
}

export function pxToVw(px: number, viewportWidth: number): number {
  return (px / viewportWidth) * 100
}

// 拖拽几何：起始宽度 + 起始/当前指针 x → 拖后宽度。side=left 右拖为正（变宽），right 镜像。
export function draggedWidth(
  startWidth: number,
  startX: number,
  currentX: number,
  side: PanelSide,
): number {
  const delta = currentX - startX
  return side === 'left' ? startWidth + delta : startWidth - delta
}

// 窄屏阈值：viewport < 720px 三态整体禁用（无手柄、无窄条、无浮层，保持现有响应式布局）。
export const TRI_STATE_MIN_VIEWPORT = 720

export function triStateEnabled(viewportWidth: number): boolean {
  return viewportWidth >= TRI_STATE_MIN_VIEWPORT
}
