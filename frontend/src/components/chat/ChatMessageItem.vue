<script setup lang="ts">
// 单条聊天消息（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// thinking/tool-line slot 注入点：默认渲染 ThinkingCard/ToolLine；父可经 slot 覆盖表现。
// #401 / ticket #402：assistant 正文走 MarkdownRenderer（v-html + DOMPurify 消毒），
// user 保持纯文本（用户输入的 * # _ 不当语法）；流式光标由 MarkdownRenderer streaming 控制。
// #459-T3 #464：附件媒体块（msg.media）渲染——image→img / audio→audio controls / video→video
// controls；src 为纯 base64，此处重建完整 dataURL（data:<mime>;base64,<src>）。user 与 assistant
// 均渲染（user 发送的附件 echo / AI 工具产出的多媒体如 browser 截图）。
import type { Msg } from '@/stores/chat'
import { hasTrace } from '@/stores/chat'
import type { MediaBlock } from '@/chat/eventTranslate'
// #555:工具聚合摘要——summarizeToolGroup 纯函数 + ToolRow→{name,args,isError} 三元组适配
import { summarizeToolGroup } from '@/chat/toolRender/tool-call-grouping'
import { toolRowToGroupInput } from '@/chat/toolRender/adapt'
import { computed, ref } from 'vue'
import ThinkingCard from '@/components/chat/ThinkingCard.vue'
import ToolLine from '@/components/chat/ToolLine.vue'
import TraceFold from '@/components/chat/TraceFold.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'
import RewindConfirmPopover from '@/components/chat/RewindConfirmPopover.vue'
import { rememberSkipRewindConfirm, shouldSkipRewindConfirm } from '@/chat/rewindPreference'

const props = withDefaults(
  defineProps<{
    msg: Msg
    regenerateText?: string
    // #694：回退入口是否可用（由 ChatView 计算：网关支持会话控制 且 agent 未在工作、连接未断）。
    // false 时入口整体**不渲染**（官方同构：busy 时 hover 按钮不渲染，而非禁用态）。缺省 false =
    // fail-closed：能力门未被宿主打开就不渲染，不出现点了必然报错的按钮（与 regenerateText 缺省
    // 隐藏同款「缺省即不给动作」语义）。
    rewindAvailable?: boolean
    // #697：fork 入口是否可用（宿主单独开门——与回退共享能力/身份门，但 busy 互斥独立计算）。
    // 同款 fail-closed。
    forkAvailable?: boolean
  }>(),
  { rewindAvailable: false, forkAvailable: false },
)

// T1 轮次折叠（#664）：开合 emit 回父层（ChatStream→ChatView）落 store mutation。
// #694：rewind 无参（父层按消息取 entryId），确认 popover 的「不再询问」由本组件落盘。
// #697：fork 无参同上；免确认（源会话完整保留，非破坏性），点击直接 emit。
const emit = defineEmits<{ regenerate: [text: string]; toggleTraceFold: []; rewind: []; fork: [] }>()

// T1 轮次折叠（#664）：完成（非流式）且有轨迹的 assistant 消息渲染折叠条——轨迹判定
// hasTrace（思考非空或工具行非空），正文与附件不算轨迹；流式进行中渲染现状完全不动；
// 无轨迹不渲染折叠条。
const traceFoldable = computed(
  () => props.msg.role === 'assistant' && !props.msg.streaming && hasTrace(props.msg),
)

// ---- #694 对话回退入口 ----
// 渲染条件（三者同时成立才渲染，缺一即整体隐藏）：user 消息 + 有网关条目 id（已持久化；本地乐观
// echo 与异常形状消息无 id，回退必然被网关拒）+ rewindAvailable（agent 工作中/连接异常/网关不支持
// 会话控制）。见模板 hover 操作条。
const rewindVisible = computed(
  () => props.msg.role === 'user' && Boolean(props.msg.entryId) && props.rewindAvailable,
)
// #697 fork 入口：身份门与回退一致（已持久化 user 消息），能力门独立（宿主分别开门——
// rewind/fork 在途互斥时只隐藏其中一侧）。
const forkVisible = computed(
  () => props.msg.role === 'user' && Boolean(props.msg.entryId) && props.forkAvailable,
)
// 确认 popover 显隐（本地瞬态；关闭路径见 RewindConfirmPopover）+ 触发按钮 ref（传给 popover 作
// anchor：落在触发按钮上的按下不算外部点击，保住「再点入口收起」的 toggle 语义）。
const confirmOpen = ref(false)
const rewindBtn = ref<HTMLButtonElement | null>(null)

// 点击入口：已记住「不再询问」→ 直接回退；popover 已开 → 收起（toggle）；否则先问一次
// （破坏性动作的误触防线）。
function onRewindClick(): void {
  if (confirmOpen.value) {
    closeConfirm()
    return
  }
  if (shouldSkipRewindConfirm()) emit('rewind')
  else confirmOpen.value = true
}

// 收起确认 popover + 焦点归还触发按钮（焦点由本组件负责：触发按钮与关闭动作都归本组件；popover 只管
// 「问一次」，卸载时只摘自己的文档监听）。
function closeConfirm(): void {
  confirmOpen.value = false
  rewindBtn.value?.focus()
}

// 确认：勾了「不再询问」则落盘偏好（存储不可用时静默降级，本次回退照常执行）。
function onRewindConfirm(remember: boolean): void {
  if (remember) rememberSkipRewindConfirm()
  closeConfirm()
  emit('rewind')
}

defineSlots<{
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
}>()

// 媒体块 src（纯 base64 或完整 url）→ 渲染可用 src。
// 0 信任（security review：#568 url 形态防御纵深——翻译层已只放行 http(s) url 与纯 base64，本函数
// 兜底不信任外来 scheme）：http(s) 经 URL 解析校验后原样返回；data: 前缀原样返回；其余一律按纯
// base64 重建 dataURL——非 http(s) 非 data: 的字符串绝不作为可执行 href 原样透出（被拼进 base64
// 段，解码失败即不渲染）。
// Phase 2 图片显示修复：blob: 前缀原样返回——此类 src 恒为 useChatConnection 经受保护 files/raw
// 端点取字节后本页 URL.createObjectURL 自建（指向内存 blob，无外部注入面，非可执行 href），浏览器
// 按 blob 自带的 image/* mime 渲染；若不识别而拼 base64，blob: 段解码失败即不渲染（图片丢失）。
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
function mediaSrc(m: MediaBlock): string {
  if (isHttpUrl(m.src)) return m.src
  if (m.src.startsWith('data:')) return m.src
  if (m.src.startsWith('blob:')) return m.src
  return `data:${m.mimeType};base64,${m.src}`
}
// #568 安全修复（security review）：document 下载卡 mime 白名单——base64 形态的 dataURL href 只对
// 白名单 mime 放行（防下载到 text/html / image/svg+xml 等可执行/脚本类文件被用户打开执行）。url
// 形态为显式点击链接（download 属性），不受限。非白名单 base64 document 回退旧行为（静默不渲染）。
// 发送侧白名单（chat/attachments.ts DOCUMENT_MIMES）与本清单同步改：两侧一致文档附件才
// 「发得出 + 渲染得出下载卡」（text/markdown 为浏览器无注册 mime 的典型，发送侧按扩展名派生）。
const SAFE_DOCUMENT_MIMES = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/zip', 'application/gzip', 'application/x-tar']
function isSafeDocumentMime(mimeType: string): boolean {
  if (mimeType === 'image/svg+xml') return false // 可嵌脚本，排除
  if (mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return true
  return SAFE_DOCUMENT_MIMES.includes(mimeType)
}
// #568: 附件体积人类可读（字节 → B/KB/MB）；durationMs → mm:ss（播放器惯用格式）。
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}
async function copyMessage(): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
    await navigator.clipboard.writeText(props.msg.text)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
  }
}
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
</script>

<template>
  <div class="msg" :class="msg.role">
    <!-- #694 消息级操作条（hover 显现，官方 chat-group-footer-actions 同构）：位于 user 气泡左侧的
         留白 gutter——不遮正文、不占额外纵向空间（显隐只改 opacity，无布局跳动）。仅已持久化的
         user 消息渲染（#694 回退 rewindVisible / #697 分叉 forkVisible，两门独立开门）。 -->
    <div
      v-if="rewindVisible || forkVisible"
      class="msg-actions"
      :class="{ open: confirmOpen }"
      data-test="msg-actions"
    >
      <!-- #697 fork：免确认（源会话完整保留，非破坏性）——点击直接 emit -->
      <button
        v-if="forkVisible"
        type="button"
        class="fork"
        aria-label="Fork"
        title="从这条消息之前分叉出新会话"
        data-test="fork"
        @click="emit('fork')"
      >从此分叉</button>
      <button
        v-if="rewindVisible"
        type="button"
        ref="rewindBtn"
        class="rewind"
        aria-label="Rewind"
        title="回退到这条消息之前"
        data-test="rewind"
        @click="onRewindClick"
      >回退</button>
      <RewindConfirmPopover
        v-if="confirmOpen"
        :anchor="rewindBtn"
        @confirm="onRewindConfirm"
        @cancel="closeConfirm"
      />
    </div>
    <div class="bubble">
      <!-- T1 轮次折叠（#664）：完成且有轨迹 → 折叠条（正文/附件/AI 提示条恒在折叠条外）。
           折叠态只渲染条面；展开态条面（可再收起）+ 平铺思考卡 + 逐行工具行（绕过工具分组
           聚合，仅一层）。traceFolded 三态统一「缺省即展开」（undefined/false 渲染轨迹、true
           只留条面）——T3（#666）起历史翻译的有轨迹 assistant 消息默认置 true（历史轮默认
           折叠）；异常收尾轮不置值（保持展开便于看原因）。 -->
      <template v-if="traceFoldable">
        <TraceFold
          :has-thinking="msg.thinking !== ''"
          :tool-count="msg.tools.length"
          :turn-duration-ms="msg.turnDurationMs"
          :folded="msg.traceFolded === true"
          @toggle="emit('toggleTraceFold')"
        />
      </template>
      <!-- 轨迹条目：流式/无轨迹完成轮恒渲染（现状）；折叠条展开态平铺渲染（无二级聚合） -->
      <template v-if="!traceFoldable || msg.traceFolded !== true">
        <!-- T08 思考链折叠卡（spec §8.3 (a) / r26 §4） -->
        <slot name="thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen">
          <ThinkingCard v-if="msg.role === 'assistant' && msg.thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen" />
        </slot>
        <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page） -->
        <!-- #555：>=2 个工具调用聚合折叠为一条摘要——**仅流式/无轨迹完成轮**（折叠条展开态
             平铺逐行 ToolLine，绕过分组聚合：#664 单层展开）。聚合只在渲染层落位，不碰 timeline.ts。 -->
        <template v-if="!traceFoldable && msg.tools.length >= 2">
          <details class="tool-group" data-test="tool-group">
            <summary data-test="tool-group-summary">
              {{ summarizeToolGroup(msg.tools.map(toolRowToGroupInput)) }}
            </summary>
            <div class="tool-group-list">
              <template v-for="(t, ti) in msg.tools" :key="`tool-${ti}`">
                <slot name="tool-line" :tool="t">
                  <ToolLine :tool="t" />
                </slot>
              </template>
            </div>
          </details>
        </template>
        <template v-else>
          <template v-for="(t, ti) in msg.tools" :key="`tool-${ti}`">
            <slot name="tool-line" :tool="t">
              <ToolLine :tool="t" />
            </slot>
          </template>
        </template>
      </template>
      <!-- #401：assistant 渲染 markdown（含流式光标），user 保持纯文本 + 光标 -->
      <MarkdownRenderer v-if="msg.role === 'assistant'" :text="msg.text" :streaming="msg.streaming" />
      <template v-else>{{ msg.text }}<span v-if="msg.streaming" class="cursor"></span></template>
      <!-- #459-T3 #464：附件媒体块（image/audio/video）——历史/流式/发送 echo 三源统一渲染。
           纯图片消息（text 空）也经此渲染出图片，不影响对话展示。
           #568: 附件元数据呈现——image 尺寸/体积、audio 时长/体积、video 尺寸/时长（有才显示，
           元数据缺省则与现状无差）；document 第 4 分支渲染成下载链接卡（label/fileName + sizeBytes）。 -->
      <div v-if="msg.media.length" class="media-list" data-test="media-list">
        <template v-for="(m, mi) in msg.media" :key="`media-${mi}`">
          <img
            v-if="m.type === 'image'"
            class="media-image"
            data-test="media-image"
            :src="mediaSrc(m)"
            :alt="m.fileName || '图片附件'"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div
            v-if="m.type === 'image' && ((m.width && m.height) || m.sizeBytes != null)"
            class="media-meta"
            data-test="media-meta"
          >
            <span v-if="m.width && m.height">{{ m.width }} × {{ m.height }}</span>
            <span v-if="m.sizeBytes != null">{{ formatBytes(m.sizeBytes) }}</span>
          </div>
          <audio
            v-if="m.type === 'audio'"
            class="media-audio"
            data-test="media-audio"
            :src="mediaSrc(m)"
            controls
            preload="metadata"
            referrerpolicy="no-referrer"
          ></audio>
          <div
            v-if="m.type === 'audio' && (m.durationMs != null || m.sizeBytes != null)"
            class="media-meta"
            data-test="media-meta"
          >
            <span v-if="m.durationMs != null">{{ formatDuration(m.durationMs) }}</span>
            <span v-if="m.sizeBytes != null">{{ formatBytes(m.sizeBytes) }}</span>
          </div>
          <video
            v-if="m.type === 'video'"
            class="media-video"
            data-test="media-video"
            :src="mediaSrc(m)"
            controls
            preload="metadata"
            referrerpolicy="no-referrer"
          ></video>
          <div
            v-if="m.type === 'video' && ((m.width && m.height) || m.durationMs != null)"
            class="media-meta"
            data-test="media-meta"
          >
            <span v-if="m.width && m.height">{{ m.width }} × {{ m.height }}</span>
            <span v-if="m.durationMs != null">{{ formatDuration(m.durationMs) }}</span>
          </div>
          <!-- #568: document 下载链接卡——base64 形态 href 为 dataURL（mime 白名单外不渲染）、url
               形态直用完整 url；download 属性触发下载；label 优先于 fileName 展示。外部 url 显式
               点击才请求，referrerpolicy/rel 防来源泄漏与 opener 劫持。 -->
          <a
            v-if="m.type === 'document' && (isHttpUrl(m.src) || isSafeDocumentMime(m.mimeType))"
            class="media-document"
            data-test="media-document"
            :href="mediaSrc(m)"
            :download="m.fileName"
            target="_blank"
            rel="noopener noreferrer"
            referrerpolicy="no-referrer"
          >
            <span class="media-document-name">{{ m.label || m.fileName || '附件' }}</span>
            <span v-if="m.sizeBytes != null" class="media-document-size">{{ formatBytes(m.sizeBytes) }}</span>
          </a>
        </template>
      </div>
      <div v-if="msg.role === 'assistant' && !msg.streaming" class="ai-notice" data-test="ai-notice">
        <span>内容由 AI 生成，仅供参考</span>
        <span class="ai-actions">
          <button v-if="regenerateText" type="button" class="regenerate" data-test="regenerate" @click="emit('regenerate', regenerateText)">重新生成</button>
          <button type="button" class="copy-message" data-test="copy-message" aria-live="polite" @click="copyMessage">
            {{ copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制' }}
          </button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* #545：消息与 composer 共用 840px 内容列。assistant 作为正文铺满内容列；user 在列内靠右，
   仅用户输入保留气泡，形成 ChatGPT 风格的紧凑对话层级。 */
.msg { display: flex; width: 100%; max-width: 840px; align-self: center; min-width: 0; }
.msg.user { justify-content: flex-end; align-items: center; }
/* #498：.bubble 是 .msg 的 flex item，须 min-width:0 才能收缩到内容 min-content 以下——
   否则 ToolLine 内连续无空格超长命令（min-content 可达上千 px）会把 .bubble 顶出 .msg 的
   840px 上限（item 默认 min-width:auto 溢出父界），且 .t-args 的 ellipsis 截断无从生效。 */
.bubble { word-break: break-word; min-width: 0; }
.msg.assistant .bubble { width: 100%; background: transparent; white-space: normal; }
.msg.user .bubble {
  max-width: min(75%, 640px);
  padding: 9px 13px;
  border-radius: 16px;
  background: var(--el-color-primary-light-8);
  white-space: pre-wrap;
}
/* #694 消息级操作条与确认 popover：操作条锚定在气泡左侧的留白 gutter（.msg.user 是 flex-end，
   操作条作为前一个 flex item 落在空处）——显隐只改 opacity/pointer-events，不引起布局跳动；
   hover / 键盘聚焦（focus-within）/ 确认 popover 打开（.open）三种态下可见。 */
.msg-actions { position: relative; display: flex; align-items: center; flex: 0 0 auto; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.msg.user:hover .msg-actions, .msg.user:focus-within .msg-actions, .msg-actions.open { opacity: 1; pointer-events: auto; }
.msg-actions .rewind { border: 0; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font-size: 12.5px; padding: 3px 8px; border-radius: 6px; }
.msg-actions .rewind:hover { background: var(--el-fill-color); color: var(--el-color-primary); }
/* #697 fork 入口：与回退同款交互形态 */
.msg-actions .fork { border: 0; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; font-size: 12.5px; padding: 3px 8px; border-radius: 6px; }
.msg-actions .fork:hover { background: var(--el-fill-color); color: var(--el-color-primary); }
/* 确认 popover 的定位在 RewindConfirmPopover 内（贴 .msg-actions 右缘，默认上翻、空间不足下翻） */
.ai-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid var(--el-border-color-lighter);
  color: var(--el-text-color-placeholder);
  font-size: 12px;
  line-height: 1.4;
}
.ai-actions { display: flex; align-items: center; gap: 10px; }
.copy-message { border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.regenerate { border: 0; background: transparent; color: var(--el-color-primary); cursor: pointer; }
.cursor { display: inline-block; width: 7px; height: 14px; background: var(--el-color-primary); vertical-align: -2px; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* #459-T3 #464：附件媒体块——约束在气泡宽度内，多附件纵向堆叠留白 */
.media-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.media-list:first-child { margin-top: 0; }
.media-image { max-width: 100%; max-height: 320px; border-radius: 8px; object-fit: contain; display: block; }
.media-audio { max-width: 100%; width: 320px; display: block; }
.media-video { max-width: 100%; max-height: 320px; border-radius: 8px; display: block; }

/* #568: 附件元数据行（尺寸/时长/体积）——小字次要色，位于媒体元素下方 */
.media-meta { display: flex; gap: 10px; margin-top: 4px; font-size: 12px; color: var(--el-text-color-secondary); }

/* #568: document 下载链接卡——文件名可截断、体积右对齐 */
.media-document { display: flex; align-items: center; justify-content: space-between; gap: 10px; max-width: 100%; min-width: 0; padding: 8px 12px; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color); color: var(--el-color-primary); text-decoration: none; font-size: 13px; }
.media-document-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.media-document-size { flex-shrink: 0; font-size: 12px; color: var(--el-text-color-secondary); }

/* #555：工具聚合摘要折叠卡（>=2 个工具调用时）——摘要行 + 展开逐行 ToolLine */
.tool-group { min-width: 0; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 9px; padding: 6px 12px; margin: 4px 0; font-size: 12.5px; }
.tool-group summary { display: flex; align-items: center; min-width: 0; gap: 9px; cursor: pointer; color: var(--el-text-color-secondary); }
.tool-group .tool-group-list { margin-top: 6px; border-top: 1px solid var(--el-border-color); padding-top: 4px; }

@media (max-width: 720px) {
  .msg.user .bubble { max-width: 88%; }
}

</style>
