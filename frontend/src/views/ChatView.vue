<script setup lang="ts">
defineOptions({ name: 'ChatView' })
// 对话页编排壳（#316 候选 B / #340：#316 拆分定案——8 组件边界，本文件只做编排）。
// 连接生命周期 × runId 路由 × 消息投影的非响应式簇全在 useChatConnection（composable 闭包）；
// 响应式投影（messages/approvals/sessions/commands/输入）在 chatStore（纯 mutation）；
// 8 个展示组件全 props-in/emits-out 哑组件（ChatSidebar/ChatHeader/ChatStream/ChatComposer +
// ChatMessageItem/ThinkingCard/ToolLine/ApprovalCard），6 slot 全开（msg-item/thinking/tool-line/
// empty/slash-menu/banner——#399 起审批卡并入 ChatStream 合并时间线渲染，approvals slot 删除），
// 表现父注入、逻辑留宿主。
// 行为与拆分前一致：同 wire（隧道 + 官方协议机）、同 reconnect（4401 刷新重建/退避重连）、同 ping/pong。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listInstances } from '@/api/containers'
import { ApiError } from '@/api/client'
import { useChatStore, type Msg } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { useAuthStore, tokenOwner } from '@/stores/auth'
import { safeLocalStorage } from '@/storage'
import { useChatConnection } from '@/chat/useChatConnection'
import {
  buildAttachments,
  compressImageFile,
  fileToRawAttachment,
  isAllowedAttachmentType,
  toPreviewDataUrl,
  type PendingAttachment,
  type RawAttachment,
} from '@/chat/attachments'
import ChatSidebar from '@/components/chat/ChatSidebar.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import ChatStream from '@/components/chat/ChatStream.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import ApprovalDock from '@/components/chat/ApprovalDock.vue'
import FileTabsPanel from '@/components/chat/FileTabsPanel.vue'

const chat = useChatStore()
const auth = useAuthStore()
// 视图专属态（connecting/errorMsg 上抛至此，disconnected 在 composable 内）
const connecting = ref(false)
const errorMsg = ref('')

// #626 T1：左栏「会话｜文件」分段态（视图专属，默认「会话」）+ workspace 文件 tab store（决议 A：与 chatStore 同级）
const sidebarTab = ref<'sessions' | 'files'>('sessions')
const fileTabs = useFileTabsStore()
// 切到「文件」分段：树未加载则拉一次（同容器切回不重拉）；切容器：reset 已清树，在 files 分段时重拉
watch(sidebarTab, (tab) => {
  if (tab === 'files' && chat.selectedContainer && !fileTabs.tree && !fileTabs.treeLoading) {
    void fileTabs.loadTree()
  }
})
watch(() => chat.selectedContainer, (name) => {
  if (sidebarTab.value === 'files' && name) void fileTabs.loadTree()
})
function switchSidebarTab(tab: 'sessions' | 'files'): void {
  sidebarTab.value = tab
}
function activateTab(path: string): void {
  fileTabs.activePath = path
}

const conn = useChatConnection({
  onConnecting(v: boolean) {
    connecting.value = v
  },
  onError(message: string) {
    errorMsg.value = message
  },
  onClearError() {
    errorMsg.value = ''
  },
  // #694（Spec 轴 review）：动作类失败（用户主动发起的回退）走瞬时 toast，不进顶部连接横幅——
  // 横幅 label 恒「加载失败」，把「回退失败：…」套在其下语义相左；贴 #461 删除会话失败 toast 先例。
  onActionError(message: string) {
    ElMessage.error(message)
  },
  // #459-T2 #463 #1：Enter/斜杠发送统一走 sendMessage（含附件校验/清空预览条），与发送按钮同路径。
  // 箭头闭包延迟求值——sendMessage 为 function 声明提升，Enter 触发时 conn 已就绪。
  onSend() {
    void sendMessage()
  },
  // #694 回退编排的 composer 协同（#693 spec §1.4）：草稿（文本 + 附件）归本壳，composable 经这两个
  // 回调抓指纹 / 回填——直接引用两个函数声明（提升，rewind 触发时 pendingAttachments 已就绪），
  // 不再经一层转手。
  onRewindDraftFingerprint: draftFingerprint,
  onEntryBackfill: applyEntryBackfill,
})

// 嵌套 ref 在模板中不解包（conn 是普通对象）——顶层解构后模板自动解包（slash 匹配单一来源在
// useChatConnection，此处只消费）
const slashOpen = conn.slashOpen
const slashMatches = conn.slashMatches

const currentSessionTitle = computed(() => {
  const s = chat.sessions.find((x) => x.session_key === chat.selectedSession)
  return s?.title || (s ? s.session_key.slice(0, 8) : '') || ''
})

// 是否有助手消息正在流式；并发 send 会让旧 streaming 消息永久卡住光标，故流式中禁发
const streaming = computed(() => chat.messages.some((m) => m.role === 'assistant' && m.streaming))

// #694 回退入口的渲染门（#693 spec §1.5 官方同构 + Codex #703 P1 修订）：网关支持会话控制
//（hello-ok features 快照）且不在忙碌态时才渲染。忙碌态 = 流式 / 连接中 / 已断线（复用三态）
// + 回退自身在途（rewindBusy：窗口内投影还是旧代，重入即被编排层吞掉）+ 投影未同步
//（transcriptSynced：重连后 syncSessions 落地前，可见的是断线前的陈旧条目——此刻回退可能剪除
// 用户未见的更新轮次；fail-closed，同步失败保持隐藏直至下次权威 loadHistory）。
const rewindAvailable = computed(
  () =>
    conn.sessionControlAvailable.value &&
    conn.transcriptSynced.value &&
    !conn.rewindBusy.value &&
    !conn.forkBusy.value &&
    !streaming.value &&
    !connecting.value &&
    !conn.disconnected.value,
)

// #697 fork 入口的渲染门：与回退共享能力门 / 投影权威门 / 忙碌三态，另与回退在途互斥
//（rewindBusy 与 forkBusy 双向——两者同动 transcript，同时进行 = 网关侧乐观并发冲突）。
const forkAvailable = computed(
  () =>
    conn.sessionControlAvailable.value &&
    conn.transcriptSynced.value &&
    !conn.rewindBusy.value &&
    !conn.forkBusy.value &&
    !streaming.value &&
    !connecting.value &&
    !conn.disconnected.value,
)

// #694 回退入口 emit（ChatStream→消息携带）：取网关条目 id 发起编排（无 id 时入口本就不渲染，防御性早退）。
function rewind(msg: Msg): void {
  if (!msg.entryId) return
  void conn.rewind(msg.entryId)
}

// #697 fork 入口 emit：同 rewind 取 entryId 发起编排。
function fork(msg: Msg): void {
  if (!msg.entryId) return
  void conn.fork(msg.entryId)
}
  
// #698 分支菜单 busy 门（#706 词汇「会话控制能力」四合一套件同族）：忙碌态禁用而非隐藏——顶栏
// 按钮闪现会推挤布局（与消息级入口的隐藏形态有意分歧）；transcriptSynced 关门（重连同步窗口内
// 分支列表可能陈旧，fail-closed）。渲染门（length > 1）在 ChatHeader 哑组件内单点判定。
const branchMenuBusy = computed(
  () =>
    conn.rewindBusy.value ||
    conn.forkBusy.value ||
    !conn.transcriptSynced.value ||
    streaming.value ||
    connecting.value ||
    conn.disconnected.value,
)

// #698 分支切换 emit：无确认直接切换（#693 spec §1.4）
function branchSwitch(leafEntryId: string): void {
  void conn.switchBranch(leafEntryId)
}

// #405-T1：审批卡可见性过滤归 chatStore getter（#395 钉死 + #394 实测——当前会话是 subagent
// 会话时审批区恒空；非 subagent 会话显示归属卡 + 无 sessionKey 连接级卡 + subagent 卡；
// 被过滤卡留存列表仅渲染层隐藏）
const visibleApprovals = computed(() => chat.visibleApprovals)
// #405-T2：是否有待展示审批卡——驱动 ChatStream 在 main 会话无 assistant 消息时合成
// SyntheticAnchor 虚拟气泡承载审批卡（锚定三分支之外的稳定落点；卡全 resolved 后仍留存）
const connectionState = computed(() => {
  if (connecting.value) return { tone: 'info', label: '正在连接…', detail: '' }
  if (conn.disconnected.value) return { tone: 'danger', label: '连接已断开', detail: errorMsg.value }
  if (errorMsg.value) return { tone: 'danger', label: '加载失败', detail: errorMsg.value }
  return null
})

// #542：执行状态指示——与上方连接横幅互补，横幅只报连接态（正在连接/断开/加载失败），
// 此行只反映「正在干活」的瞬时态；横幅可见时返回空串整行隐藏，不重复横幅文案。
const executionStatus = computed(() => {
  if (connectionState.value) return ''
  if (visibleApprovals.value.some((a) => a.status === 'pending')) return '等待批准'
  if (chat.messages.some((m) => m.tools.some((t) => t.state === 'running'))) return '正在执行工具…'
  if (streaming.value) return '模型正在回答…'
  return '已连接'
})

// #668：JWT 身份解析与 localStorage 安全访问收敛到共享实现（stores/auth.tokenOwner /
// storage.safeLocalStorage），面板三态宽度持久化共用同一套隔离语义。
function draftKey(session = chat.selectedSession): string {
  return `researcher:draft:${tokenOwner(auth.token)}:${chat.selectedContainer}:${session}`
}
watch(() => [chat.selectedContainer, chat.selectedSession] as const, () => {
  if (chat.selectedContainer && chat.selectedSession) chat.setInput(safeLocalStorage()?.getItem(draftKey()) ?? '')
})
watch(() => chat.input, (value) => {
  if (!chat.selectedContainer || !chat.selectedSession) return
  const storage = safeLocalStorage(); if (!storage) return
  if (value) storage.setItem(draftKey(), value); else storage.removeItem(draftKey())
})
// #547 / ADR 0014：pending/resolving 请求固定在 composer 上方 ApprovalDock，避免被长回答顶出可视区域。
// resolved/expired 卡不留痕（ADR 0014 supersede #547 的留痕意图）——落定即从界面消失，不回时间线。
const activeApprovals = computed(() =>
  visibleApprovals.value.filter((a) => a.status === 'pending' || a.status === 'resolving'),
)

// 删除会话：确认（ElMessageBox）由本壳注入（composable 内不持有 UI）。
// #461：文案明示硬删除不可恢复（删除即硬删，无「归档/可恢复」中间态，与真实网关语义一致）。
async function confirmRemoveSession(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '确认删除该会话？删除后不可恢复。',
      '删除会话',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false // 用户取消
  }
}

async function removeSession(key: string): Promise<void> {
  const res = await conn.removeSession(key, confirmRemoveSession)
  if (res === true) {
    safeLocalStorage()?.removeItem(draftKey(key))
    ElMessage.success('会话已删除')
  }
  else if (typeof res === 'string') ElMessage.error(res) // #461：失败 → 醒目错误 toast（替换顶部小字 bar）
  // null = 用户取消 / 断线：无反馈
}

function toggleApprovalDetail(a: { id: string }): void {
  chat.toggleApprovalDetail(a.id)
}

// ---- #459-T2 #463：附件采集（预览条状态归宿主，贴 connecting/errorMsg 先例——本地瞬态 UI 态）----
// 预览项 PendingAttachment（结构上提 attachments.ts 单一来源）= 采集到的 RawAttachment（content 纯
// base64）+ 本地缩略 previewUrl（图片经 toPreviewDataUrl 重建 dataURL，免 objectURL 管理）；发送前经
// buildAttachments 统一校验（类型/体积），拒发项提示、放行项发送。
const pendingAttachments = ref<PendingAttachment[]>([])
let attachKey = 0

// 预览条追加（单一入口）：采集三通道（粘贴/拖拽/选择）与 #694 回退回填共用同一落点——key 单调递增
// （移除按钮按 key 定位）、图片经 toPreviewDataUrl 重建 dataURL 缩略。
function pushAttachment(att: RawAttachment): void {
  pendingAttachments.value.push({ key: ++attachKey, att, previewUrl: toPreviewDataUrl(att) })
}

// 三通道共用入口：粘贴/拖拽/文件选择的 File 列表 → 压缩（图片）/转换（非图片）→ 入预览条。
// 不支持的类型（非 image/audio/video）即时提示，不入预览条（体积校验留发送前 buildAttachments 兜底）。
async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
    if (!isAllowedAttachmentType(file.type)) {
      ElMessage.error(`不支持的附件类型：${file.name}`)
      continue
    }
    try {
      const att = file.type.startsWith('image/')
        ? await compressImageFile(file)
        : await fileToRawAttachment(file)
      pushAttachment(att)
    } catch {
      ElMessage.error(`附件读取失败：${file.name}`)
    }
  }
}

function removeAttachment(key: number): void {
  pendingAttachments.value = pendingAttachments.value.filter((p) => p.key !== key)
}

// 发送（Enter/按钮/斜杠统一入口，#1）：buildAttachments 校验预览条 → 有拒发则提示「文件过大/类型不
// 支持」不发；全放行（或无附件走纯文本）则 conn.send 透传。仅真发出才清空预览条（#2：conn.send 守卫
// 早退——无会话/断线/流式——返回 false，附件不丢）。
async function sendMessage(): Promise<void> {
  const { attachments, rejected } = buildAttachments(pendingAttachments.value.map((p) => p.att))
  if (rejected.length > 0) {
    const oversize = rejected.some((r) => r.reason === 'size')
    ElMessage.error(oversize ? '文件过大，无法发送' : '存在不支持的附件类型')
    return
  }
  const sent = conn.send(streaming.value, attachments)
  if (sent) pendingAttachments.value = [] // 真发出 → 预览条清空；早退保留
}

async function regenerate(text: string): Promise<void> {
  if (!text || streaming.value || conn.disconnected.value) return
  chat.setInput(text)
  await nextTick()
  await sendMessage()
}

// #694 回退的草稿指纹（#693 spec §1.4）：文本 + 附件内容的水位线快照——composable 在 rewind RPC
// 前后各取一次、比对是否变化（变化即跳过回填，保留用户新草稿）。附件是宿主局部态（不在 store），
// 故指纹只能算在宿主侧；内容整体入指纹（不做长度摘要），保证「同长不同内容」也判为改动。
function draftFingerprint(): string {
  return JSON.stringify([
    chat.input,
    pendingAttachments.value.map((p) => [p.att.mimeType ?? '', p.att.fileName ?? '', p.att.content ?? '']),
  ])
}

// #694 回退回填（指纹未变时才被 composable 调用；#697 fork 播种共用，改名 applyEntryBackfill——
// 两路回填语义同构，不维护两份近似实现）：被剪/被点首条用户消息文本覆盖式写入草稿 + 网关返回的
// 图片附件并入预览条（按内容去重——本地预览条已有同图时不重复插入，官方 merge 同款意图）。
function applyEntryBackfill(text: string, attachments: RawAttachment[]): void {
  chat.setInput(text)
  for (const att of attachments) {
    if (pendingAttachments.value.some((p) => p.att.mimeType === att.mimeType && p.att.content === att.content)) continue
    pushAttachment(att)
  }
}

async function loadInstances() {
  try {
    chat.setInstances(await listInstances())
    // B0: 总是走 selectContainer——同名且连接活着（gateway 非空）时其内部 early-return 跳过。
    // 生命周期对齐 KeepAlive（App.vue）：登录态下 ChatView 被缓存，切页走 activated/deactivated、
    // 连接保持，不 unmount；仅登出时才剔除缓存并 unmount → dispose 断网关。故「store 残留
    // selectedContainer 而 gateway 已死」只在登出后再登录的 remount 出现，此时必须重建连接，
    // 否则连接死而 UI 看似活着（send/resolveApproval 静默 no-op）。
    if (chat.instances.length) {
      await conn.selectContainer(chat.selectedContainer || chat.instances[0].name)
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return
    errorMsg.value = (e as Error).message
  }
}

onMounted(loadInstances)
onBeforeUnmount(() => {
  conn.dispose()
})

defineExpose({
  selectContainer: conn.selectContainer,
  // #9：暴露的发送统一走 sendMessage（含附件校验/清空预览条），与按钮/Enter 同路径，不分叉。
  send: () => sendMessage(),
  newSession: conn.newSession,
})
</script>

<template>
  <div class="chat">
    <ChatSidebar
      :instances="chat.instances"
      :sessions="chat.sessions"
      :selected-container="chat.selectedContainer"
      :selected-session="chat.selectedSession"
      :sidebar-tab="sidebarTab"
      :tree="fileTabs.tree"
      :tree-error="fileTabs.treeError"
      :active-file-path="fileTabs.activePath ?? ''"
      @select-container="conn.selectContainer"
      @select-session="conn.pickSession"
      @remove-session="removeSession"
      @new-session="conn.newSession"
      @switch-tab="switchSidebarTab"
      @open-file="(path: string) => void fileTabs.openFromTree(path)"
    />
    <main class="main">
      <ChatHeader
        :title="currentSessionTitle"
        :container="chat.selectedContainer"
        :connecting="connecting"
        :branches="chat.branches"
        :branch-busy="branchMenuBusy"
        @branch-switch="branchSwitch"
      />
      <div v-if="connectionState" class="connection-banner" :class="connectionState.tone" role="status" aria-live="polite" :data-test="conn.disconnected.value ? 'reconnect-bar' : 'connection-banner'">
        <span class="connection-label">{{ connectionState.label }}</span>
        <span v-if="connectionState.detail" class="connection-detail" data-test="error-bar">{{ connectionState.detail }}</span>
        <button v-if="conn.disconnected.value" class="reconnect" data-test="reconnect" @click="conn.connect()">重新连接</button>
      </div>
      <div v-if="executionStatus" class="execution-status" role="status" aria-live="polite" data-test="execution-status">{{ executionStatus }}</div>
      <ChatStream
        :messages="chat.messages"
        :history-has-more="chat.historyHasMore"
        :history-loading="chat.historyLoading"
        :rewind-available="rewindAvailable"
        :fork-available="forkAvailable"
        @load-more="conn.loadMoreHistory"
        @regenerate="regenerate"
        @toggle-trace-fold="chat.toggleTraceFold"
        @rewind="rewind"
        @fork="fork"
      >
        <!-- #461：无选中会话（含删除当前会话后）→ 空态视图 + 「新建会话」入口 -->
        <template #empty>
          <div v-if="!chat.selectedSession" class="empty-state" data-test="empty-state">
            <p class="empty-title">未选择会话</p>
            <p class="empty-hint">选择一个会话继续对话，或新建会话</p>
            <button
              type="button"
              class="empty-new"
              data-test="empty-new-session"
              :disabled="conn.disconnected.value"
              @click="conn.newSession"
            >＋ 新建会话</button>
          </div>
        </template>
      </ChatStream>
      <ApprovalDock
        :approvals="activeApprovals"
        :disconnected="conn.disconnected.value"
        @resolve="conn.resolveApproval"
        @toggle-detail="toggleApprovalDetail"
      />
      <ChatComposer
        v-model="chat.input"
        :matches="slashMatches"
        :slash-open="slashOpen"
        :slash-index="chat.slashIndex"
        :connecting="connecting"
        :streaming="streaming"
        :disconnected="conn.disconnected.value"
        :rewind-busy="conn.rewindBusy.value"
        :fork-busy="conn.forkBusy.value"
        :pending-attachments="pendingAttachments"
        @input="conn.onComposerInput"
        @keydown="conn.onComposerKeydown"
        @send="sendMessage"
        @pick-slash="conn.pickSlash"
        @add-files="addFiles"
        @remove-attachment="removeAttachment"
      >
        <!-- T07 斜杠补全菜单表现（父注入，逻辑留宿主 useChatConnection） -->
        <template #slash-menu="{ matches, slashIndex }">
          <div v-if="matches.length" class="slash-menu" data-test="slash-menu">
            <div
              v-for="(o, i) in matches"
              :key="o.alias"
              class="slash-item"
              :class="{ sel: i === slashIndex }"
              data-test="slash-item"
              @mousedown.prevent="conn.pickSlash(o.alias)"
            >
              <span class="cmd">{{ o.alias }}</span><span class="desc">{{ o.description }}</span>
            </div>
          </div>
        </template>
      </ChatComposer>
    </main>
    <FileTabsPanel
      v-if="fileTabs.tabs.length"
      class="file-panel"
      :tabs="fileTabs.tabs"
      :active-path="fileTabs.activePath"
      @activate="activateTab"
      @close="fileTabs.closeTab"
      @close-all="fileTabs.closeAll"
      @retry="fileTabs.retry"
    />
  </div>
</template>

<style scoped>
.chat { display: flex; height: 100%; min-height: 0; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.file-panel { width: 360px; flex: none; }
.connection-banner { display: flex; align-items: center; gap: 10px; padding: 8px 18px; font-size: 13px; }
.connection-banner.info { color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.connection-banner.danger { color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
.connection-label { font-weight: 600; }
.connection-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-banner .reconnect { margin-left: auto; background: transparent; border: 1px solid currentColor; border-radius: 6px; padding: 2px 10px; cursor: pointer; color: inherit; font-size: 12.5px; }
.execution-status { padding: 5px 18px; border-bottom: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }

/* T07 斜杠补全菜单（spec §9.4 / 原型 oc-chat-page.html）：弹在输入框上方，cmd mono + 描述 */
.slash-menu { position: absolute; bottom: calc(100% + 6px); left: 18px; right: 18px; max-height: 280px; overflow-y: auto; background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color); border-radius: 11px; box-shadow: 0 -8px 30px rgba(0, 0, 0, .18); z-index: 10; }
.slash-item { display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; }
.slash-item.sel, .slash-item:hover { background: var(--el-fill-color); }
.slash-item .cmd { font-family: ui-monospace, monospace; color: var(--el-color-primary); font-size: 13px; }
.slash-item .desc { margin-left: auto; color: var(--el-text-color-secondary); font-size: 12px; }
@media (max-width: 720px) {
  .chat { flex: 1; min-height: 0; flex-direction: column; }
  .chat :deep(.side) { width: auto; max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--el-border-color); }
  .chat :deep(.stream) { padding: 12px; }
  .chat :deep(.composer) { padding: 10px 12px; }
  .chat :deep(.msg), .chat :deep(.approval) { min-width: 0; max-width: 100%; box-sizing: border-box; }
}

/* #461：无选中会话空态视图（删除当前会话后停留空聊天区）——居中提示 + 新建会话入口 */
.empty-state { margin: auto; text-align: center; color: var(--el-text-color-secondary); }
.empty-title { margin: 0 0 6px; font-size: 14px; }
.empty-hint { margin: 0 0 12px; font-size: 12.5px; }
.empty-new { background: transparent; border: 1px dashed var(--el-border-color); border-radius: 7px; padding: 6px 16px; cursor: pointer; color: var(--el-text-color-secondary); font-size: 13px; }
.empty-new:disabled { cursor: default; opacity: .6; }
</style>
