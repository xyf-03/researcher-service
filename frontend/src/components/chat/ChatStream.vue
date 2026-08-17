<script setup lang="ts">
// 消息流（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// ADR 0014：审批卡不再进时间线（resolved/expired 不留痕；pending/resolving 在 composer 上方
// ApprovalDock）——本组件回归纯消息流渲染，不再合并 approvals、不再合成 SyntheticAnchor。
// ADR 0009 / #400：窗口自动向下滚动（范式 B 上滚让位 + rAF 节流）——宿主在本组件内部，
// 滚动容器即根元素 .stream；仅用户停留底部时跟随，上滚不抢滚动条，回到底部恢复；一帧内多次
// 流式 delta 合并滚一次（rAF 节流，平滑不抖动）。渲染 messages（ChatMessageItem 注入 msg-item/
// thinking/tool-line slot）+ 历史分页「加载更多」。thinking+回答保持同气泡、工具行挂 run（不扁平化）。
import { onBeforeUnmount, onUpdated, ref, watch } from 'vue'
import type { Msg } from '@/stores/chat'
import { shouldFollowBottom } from '@/chat/scroll'
import ChatMessageItem from '@/components/chat/ChatMessageItem.vue'

// props 供 script 侧 watch 追踪布局快照（模板按名访问，无需此绑定）
const props = defineProps<{
  messages: Msg[]
  historyHasMore: boolean
  historyLoading: boolean
}>()

const emit = defineEmits<{
  loadMore: []
  regenerate: [text: string]
}>()

function previousUserText(message: Msg): string {
  const index = props.messages.indexOf(message)
  for (let i = index - 1; i >= 0; i--) {
    const candidate = props.messages[i]
    if (candidate.role !== 'user') continue
    // 现有前端只能重发文本，无法从历史 Msg 安全重建原始附件；含附件时不显示入口，
    // 避免“重新生成”静默退化为只发送文字。
    return candidate.media.length === 0 ? candidate.text : ''
  }
  return ''
}

// ---- 自动滚动（ADR 0009 / #400，范式 B 上滚让位 + rAF 节流）----
// 滚动容器即根元素 .stream（overflow-y:auto）。stickyBottom 记录「用户是否停留在底部」：
// 由 scroll 事件实时判定；上滚离开底部 → false（新内容不抢滚动条），回到底部 → true（恢复跟随）。
const streamEl = ref<HTMLElement | null>(null)
const stickyBottom = ref(true)
const hasNewContent = ref(false)
let rafId = 0

// 滚动判定（范式 B）：距底 < 阈值视为停留底部。scroll 事件驱动——用户滚动操作与
// 程序性滚动（跟随触底）都经过这里；跟随触底时距底=0 保持 stickyBottom=true 不抖动。
function onScroll(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = shouldFollowBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
  if (stickyBottom.value) hasNewContent.value = false
}

// rAF 节流跟随：一帧内多次流式 delta 合并滚一次到底（平滑不抖动）。
// 仅 stickyBottom（用户停留底部）时滚；上滚回看历史时不抢滚动条。
function scrollToBottom(): void {
  if (!stickyBottom.value) return
  if (rafId) return // 本帧已调度
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const el = streamEl.value
    if (el && stickyBottom.value) el.scrollTop = el.scrollHeight
  })
}

function onTimelineContentChanged(): void {
  if (!stickyBottom.value) {
    hasNewContent.value = true
    return
  }
  scrollToBottom()
}

function jumpToBottom(): void {
  const el = streamEl.value
  if (!el) return
  stickyBottom.value = true
  hasNewContent.value = false
  el.scrollTop = el.scrollHeight
}

// DOM 更新后（新消息/历史加载更多 prepend）跟随。onUpdated 只对「本组件 render effect
// 失效」触发——流式 delta 是 useChatConnection 对消息对象**原地 mutation**（last.raw/text 就地改，
// 数组与对象身份不变），本组件渲染不读 text/thinking，render effect 不失效，onUpdated 不触发，
// 流式逐字追加会漏滚（#400 验收①第三场景，code-review 实证）。故补 layoutWatch：投影快照
// 只追踪「渲染布局相关字段」（role/streaming/raw 决定气泡高度），detailOpen/tools 等不属布局
// 变化、天然不进快照——不因 deep watch 被破坏。watch 回调统一走 scrollToBottom（rAF 节流）。
watch(
  () => props.messages.map((m) => `${m.role}|${m.streaming}|${m.raw.length}`).join('|'),
  onTimelineContentChanged,
)
// 非时间线更新（例如断线状态）不得制造“有新消息”；在底部时仍允许布局更新后校正滚底。
onUpdated(() => { if (stickyBottom.value) scrollToBottom() })
onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
})

defineSlots<{
  'msg-item'?: (props: { msg: Msg }) => unknown
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
  empty?: (props: {}) => unknown
}>()
</script>

<template>
  <!-- ADR 0009 / #400：.stream 即滚动容器（根元素，overflow-y:auto）——ref 供范式 B 跟随滚底，
       @scroll 实时判定 stickyBottom（用户停留底部则跟随、上滚则让位） -->
  <div class="stream" data-test="stream" ref="streamEl" role="log" aria-live="polite" aria-label="对话消息" @scroll="onScroll">
    <!-- T3 历史分页（issue #82）：hasMore 时顶部「加载更多」向回翻更旧消息，prepend 到头部。 -->
    <button
      v-if="historyHasMore"
      class="load-more"
      :disabled="historyLoading"
      data-test="load-more"
      @click="emit('loadMore')"
    >
      {{ historyLoading ? '加载中…' : '加载更多' }}
    </button>
    <!-- msg-item slot：父注入消息表现（默认 ChatMessageItem）；thinking/tool-line 透传给叶子 -->
    <template v-for="(m, i) in messages" :key="`m-${i}`">
      <slot name="msg-item" :msg="m">
        <ChatMessageItem :msg="m" :regenerate-text="m.role === 'assistant' ? previousUserText(m) : ''" @regenerate="emit('regenerate', $event)" />
      </slot>
    </template>
    <slot name="empty" />
    <button v-if="!stickyBottom" class="jump-bottom" data-test="jump-bottom" @click="jumpToBottom">
      {{ hasNewContent ? '有新消息 · 回到底部' : '回到底部' }}
    </button>
  </div>
</template>

<style scoped>
.stream { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.load-more { align-self: center; background: transparent; border: 1px dashed var(--el-border-color); border-radius: 8px; padding: 5px 18px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12.5px; }
.load-more:disabled { cursor: default; opacity: .6; }
.jump-bottom { position: sticky; bottom: 4px; align-self: center; border: 1px solid var(--el-border-color); border-radius: 18px; padding: 7px 14px; background: var(--el-bg-color-overlay); color: var(--el-color-primary); box-shadow: var(--el-box-shadow-light); cursor: pointer; z-index: 2; }
</style>
