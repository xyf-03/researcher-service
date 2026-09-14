<script setup lang="ts">
// #694 回退确认 popover（#693 spec §1.5 / #685 官方 chat-confirm-popover 同构的哑组件）。
// 职责收窄为「问一次」：危险色确认 + 取消 + 「不再询问」勾选，勾选状态只在本组件生命周期内；
// 是否记住偏好的落盘、是否跳过询问，全在调用方（ChatMessageItem 经 chat/rewindPreference 纯模块）。
//
// 关闭路径（官方三条同构）：取消按钮、点击外部、Escape——都只 emit cancel（调用方负责收起；
// 组件不自持显隐态，父层 v-if 控制，卸载即摘掉文档监听）。
//
// 放置（官方 data-placement=above|below 同款）：默认锚在触发按钮上方；上方空间不够（消息贴近滚动
// 容器顶缘——popover 随内容滚动，超出 scrollport 的部分会被 overflow 裁掉，确认按钮就点不到了）则
// 翻到下方。水平同理（Codex #703 P2）：窄屏下 user 气泡占满内容列 → 操作条贴滚动容器左缘，232px
// 卡片左伸同样被裁 → 左伸不够时整体右移夹取。两个方向都只挂载时量一次：popover 与锚点同属一个
// 滚动内容，滚动时相对关系不变。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

// anchor = 触发按钮元素（调用方传入）：落在 anchor 上的按下不算「外部点击」——否则先 cancel 再由
// 触发按钮的 click 重新打开，会让「再点入口收起」的 toggle 永远失效（官方 toggle 语义）。
const props = defineProps<{ anchor?: HTMLElement | null }>()

const emit = defineEmits<{ confirm: [remember: boolean]; cancel: [] }>()

const remember = ref(false)
const root = ref<HTMLElement | null>(null)
// 触发按钮上方是否放得下（false → 翻转到下方）。缺省 true（未量出滚动宿主时维持默认放置）。
const placedBelow = ref(false)
// 横向位移（px，>0 = 卡片整体右移）：默认贴触发按钮右缘（right:0，向左展开）；左伸越界时右移夹取。
const shiftPx = ref(0)
const confirmBtn = ref<HTMLButtonElement | null>(null)
// 与锚点之间的呼吸间隙：单一来源 = 本常量（既驱动 JS 测量、又经 CSS 变量驱动 calc 偏移，防两处漂移）。
const GAP_PX = 6
// 横向夹取的安全边距（不让卡片贴住滚动容器边缘）。
const EDGE_PX = 8
const gapStyle = { '--rewind-gap': `${GAP_PX}px` }
// 卡片样式：间隙走 CSS 变量（与 CSS 的 calc 偏移共享同一常量）；横向位移纯由 JS 测量得来、CSS 无
// 对应项，故直接写内联 right（未位移时不写，用 CSS 的 right: 0 默认值）。
const rootStyle = computed(() => (shiftPx.value ? { ...gapStyle, right: `-${shiftPx.value}px` } : gapStyle))

// 点击外部关闭：只认「落在本 popover 与触发按钮之外」的按下——确认/取消按钮在 root 内，不会自我取消。
function onDocMouseDown(e: MouseEvent): void {
  const target = e.target as Node
  if (props.anchor?.contains(target)) return
  if (root.value && !root.value.contains(target)) emit('cancel')
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('cancel')
}

// 最近的纵向滚动祖先（overflow-y auto/scroll）——即 transcript 的滚动容器；量不到（离屏挂载/无
// 滚动祖先）就维持默认放置，不做猜测。
function nearestScrollParent(el: HTMLElement): HTMLElement | null {
  let cur = el.parentElement
  while (cur) {
    const overflowY = globalThis.getComputedStyle?.(cur)?.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return cur
    cur = cur.parentElement
  }
  return null
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onDocKeydown)
  // 焦点：确认按钮接管（键盘用户直接 Tab/Enter 可达；Escape 关闭路径同样可用）；关闭时归还给触发按钮。
  confirmBtn.value?.focus()
  const el = root.value
  const anchorEl = props.anchor
  const host = anchorEl ? nearestScrollParent(anchorEl) : null
  if (el && anchorEl && host) {
    const anchorRect = anchorEl.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    placedBelow.value = anchorRect.top - hostRect.top < el.offsetHeight + GAP_PX
    // 横向夹取（Codex #703 P2）：默认卡片右缘对齐触发按钮（right:0）向左展开；左缘越出滚动容器即
    // 整体右移。可覆盖气泡——弹层带阴影与 z-index，盖住气泡可接受；越界被裁（确认按钮点不到）不可接受。
    // 量不到有效宽度（离屏/异常环境）→ 维持默认放置，不做猜测（同 nearestScrollParent 语义）。
    if (Number.isFinite(hostRect.left) && Number.isFinite(hostRect.right)) {
      const wantedLeft = anchorRect.right - el.offsetWidth
      // 左缘允许的位置：容器左内边距，但不越过「容器右内边距 - 卡片宽」。容器比卡片还窄时后者更靠左
      // → 取后者：优先保右缘（确认按钮在卡片右下角，宁可裁左侧文案也不能让按钮被裁）。
      const leftLimit = Math.min(hostRect.left + EDGE_PX, hostRect.right - EDGE_PX - el.offsetWidth)
      shiftPx.value = Math.max(0, Math.round(leftLimit - wantedLeft))
    }
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onDocKeydown)
  // 焦点归还由调用方做（它拥有触发按钮与关闭动作）——见 ChatMessageItem.closeConfirm
})
</script>

<template>
  <div
    ref="root"
    class="rewind-confirm"
    :class="placedBelow ? 'below' : 'above'"
    :style="rootStyle"
    role="dialog"
    aria-label="Rewind"
    data-test="rewind-confirm"
  >
    <p class="rewind-confirm-text">回退到这条消息之前？</p>
    <p class="rewind-confirm-hint">其后的对话将从当前会话剪除。</p>
    <label class="rewind-confirm-remember">
      <input v-model="remember" type="checkbox" data-test="rewind-remember" />
      <span>不再询问</span>
    </label>
    <div class="rewind-confirm-actions">
      <button type="button" class="cancel" data-test="rewind-cancel" @click="emit('cancel')">取消</button>
      <button ref="confirmBtn" type="button" class="danger" data-test="rewind-confirm-yes" @click="emit('confirm', remember)">回退</button>
    </div>
  </div>
</template>

<style scoped>
/* 定位（放置策略见 script 头注释）：定位上下文由调用方提供（消息操作条 .msg-actions 是
   position:relative，本组件贴其右缘展开）；默认锚在触发按钮上方，上方放不下时翻到下方。 */
.rewind-confirm { position: absolute; right: 0; z-index: 20; }
.rewind-confirm.above { bottom: calc(100% + var(--rewind-gap)); }
.rewind-confirm.below { top: calc(100% + var(--rewind-gap)); }
/* 卡片定位与观感对齐官方：气泡底、1px 边框、radius 8px、投影。宽度定 232px，极窄视口下让位给
   （视口 - 24px）——横向夹取读的是实测 offsetWidth，故变窄也能整体落在滚动容器内（#703 P2）。 */
.rewind-confirm { width: min(232px, calc(100vw - 24px)); padding: 12px; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 8px; box-shadow: 0 8px 24px rgba(0, 0, 0, .35); text-align: left; }
.rewind-confirm-text { margin: 0; font-size: 13px; color: var(--el-text-color-primary); }
/* 后果说明：回退会剪掉后半段对话（CONTEXT.md「会话删除」确立的破坏性确认原则——确认文案必须让用户
   看清将要发生什么） */
.rewind-confirm-hint { margin: 4px 0 8px; font-size: 12px; color: var(--el-text-color-secondary); }
.rewind-confirm-remember { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--el-text-color-secondary); cursor: pointer; }
.rewind-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.rewind-confirm-actions button { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; background: transparent; }
.rewind-confirm-actions .cancel { color: var(--el-text-color-regular); }
/* 危险色确认（官方 yes 按钮 danger 红）：回退会剪掉后半段对话，属破坏性动作 */
.rewind-confirm-actions .danger { border-color: var(--el-color-danger); background: var(--el-color-danger); color: #fff; }
</style>
