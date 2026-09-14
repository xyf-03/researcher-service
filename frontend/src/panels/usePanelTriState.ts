// usePanelTriState —— 面板三态包装 composable（issue #668 / spec #667）。
// 宿主侧胶水：持有三态 refs，把哑组件冒泡的事件经纯函数（triState 状态机/钳制、
// panelWidth 持久化）落成状态更新；storage / viewport / token 由 options 注入
// （jsdom 无布局——DOM 度量一律注入）。四个面板复用同一套，本票只接通 wiki 文件树。
// 持久化只记 inline 宽度（拖拽结束落盘）；collapsed/popped 态不持久化，每次进页恒 inline。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Ref } from 'vue'
import {
  clampPoppedVw,
  clampRange,
  pxToVw,
  POPPED_DEFAULT_VW,
  transitionPanelState,
  triStateEnabled,
} from '@/panels/triState'
import type { PanelSide, PanelState, WidthRange } from '@/panels/triState'
import { loadPanelWidth, panelWidthKey, savePanelWidth } from '@/panels/panelWidth'
import { tokenOwner } from '@/stores/auth'
import { safeLocalStorage } from '@/storage'

export interface PanelTriStateOptions {
  /** 持久化 key 的页面段（如 'wiki' / 'chat'） */
  view: string
  /** 持久化 key 的面板段（如 'file-tree' / 'graph'） */
  panel: string
  /** 面板贴边侧，默认 left */
  side?: PanelSide
  /** inline 宽度硬边界（spec #667 两档：160–560 / 240–720，见 triState 常量） */
  inlineRange: WidthRange
  /** storage 无值时的默认宽度（该面板现状固定宽） */
  defaultInlineWidth: number
  /** access token 供给者（解析出按用户隔离的 key owner，chat 草稿先例） */
  token: () => string
  /** Storage 供给者，默认 safeLocalStorage()（隐私模式兜底） */
  storage?: () => Storage | null
  /** 视口宽供给者，默认 window.innerWidth（窄屏判定 + popped px↔vw 换算） */
  getViewportWidth?: () => number
}

export function usePanelTriState(options: PanelTriStateOptions) {
  const storage = options.storage ?? safeLocalStorage
  const getViewportWidth = options.getViewportWidth ?? (() => window.innerWidth)
  const side: PanelSide = options.side ?? 'left'
  const { min, max } = options.inlineRange

  // key 在挂载时按当前身份算一次（refresh 换 token 不改 sub，owner 稳定）。
  const key = panelWidthKey(tokenOwner(options.token()), options.view, options.panel)

  const state = ref<PanelState>('inline') // collapsed/popped 不持久化：每次进页恒 inline
  const inlineWidth = ref(loadPanelWidth(storage(), key, options.inlineRange) ?? options.defaultInlineWidth)
  const poppedVw = ref(POPPED_DEFAULT_VW)

  const viewportWidth = ref(getViewportWidth())
  const disabled = computed(() => !triStateEnabled(viewportWidth.value))

  function syncViewport(): void {
    viewportWidth.value = getViewportWidth()
  }
  onMounted(() => window.addEventListener('resize', syncViewport))
  onUnmounted(() => window.removeEventListener('resize', syncViewport))

  function onCollapse(): void {
    state.value = transitionPanelState(state.value, 'collapse')
  }
  function onPop(): void {
    state.value = transitionPanelState(state.value, 'pop')
  }
  function onExpand(): void {
    state.value = transitionPanelState(state.value, 'expand')
  }
  function onRestore(): void {
    state.value = transitionPanelState(state.value, 'restore')
  }

  function onResizeInline(widthPx: number): void {
    inlineWidth.value = clampRange(widthPx, min, max)
  }
  function onResizePopped(widthPx: number): void {
    poppedVw.value = clampPoppedVw(pxToVw(widthPx, viewportWidth.value))
  }
  function onDragEnd(): void {
    // 仅 inline 宽度持久化；popped 拖宽不落盘（spec：弹出/折叠态与弹出宽度均不记）。
    if (state.value === 'inline') savePanelWidth(storage(), key, inlineWidth.value)
  }

  return {
    state: state as Ref<PanelState>,
    inlineWidth,
    poppedVw,
    disabled,
    viewportWidth,
    side,
    onCollapse,
    onPop,
    onExpand,
    onRestore,
    onResizeInline,
    onResizePopped,
    onDragEnd,
  }
}
