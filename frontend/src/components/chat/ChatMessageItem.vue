<script setup lang="ts">
// 单条聊天消息（#316：#340 拆分边界，props-in/emits-out 哑组件）。
// thinking/tool-line slot 注入点：默认渲染 ThinkingCard/ToolLine；父可经 slot 覆盖表现。
// #401 / ticket #402：assistant 正文走 MarkdownRenderer（v-html + DOMPurify 消毒），
// user 保持纯文本（用户输入的 * # _ 不当语法）；流式光标由 MarkdownRenderer streaming 控制。
// #459-T3 #464：附件媒体块（msg.media）渲染——image→img / audio→audio controls / video→video
// controls；src 为纯 base64，此处重建完整 dataURL（data:<mime>;base64,<src>）。user 与 assistant
// 均渲染（user 发送的附件 echo / AI 工具产出的多媒体如 browser 截图）。
import type { Msg } from '@/stores/chat'
import type { MediaBlock } from '@/chat/eventTranslate'
// #555:工具聚合摘要——summarizeToolGroup 纯函数 + ToolRow→{name,args,isError} 三元组适配
import { summarizeToolGroup } from '@/chat/toolRender/tool-call-grouping'
import { toolRowToGroupInput } from '@/chat/toolRender/adapt'
import { ref } from 'vue'
import ThinkingCard from '@/components/chat/ThinkingCard.vue'
import ToolLine from '@/components/chat/ToolLine.vue'
import MarkdownRenderer from '@/components/chat/MarkdownRenderer.vue'

const props = defineProps<{
  msg: Msg
  regenerateText?: string
}>()

const emit = defineEmits<{ regenerate: [text: string] }>()

defineSlots<{
  thinking?: (props: { thinking: string; thinkingOpen: boolean }) => unknown
  'tool-line'?: (props: { tool: Msg['tools'][number] }) => unknown
}>()

// 媒体块 src（纯 base64 或完整 url）→ 渲染可用 src。
// 0 信任（security review：#568 url 形态防御纵深——翻译层已只放行 http(s) url 与纯 base64，本函数
// 兜底不信任外来 scheme）：http(s) 经 URL 解析校验后原样返回；data: 前缀原样返回；其余一律按纯
// base64 重建 dataURL——非 http(s) 非 data: 的字符串绝不作为可执行 href 原样透出（被拼进 base64
// 段，解码失败即不渲染）。
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
  return `data:${m.mimeType};base64,${m.src}`
}
// #568 安全修复（security review）：document 下载卡 mime 白名单——base64 形态的 dataURL href 只对
// 白名单 mime 放行（防下载到 text/html / image/svg+xml 等可执行/脚本类文件被用户打开执行）。url
// 形态为显式点击链接（download 属性），不受限。非白名单 base64 document 回退旧行为（静默不渲染）。
const SAFE_DOCUMENT_MIMES = ['application/pdf', 'text/plain', 'text/csv', 'application/json', 'application/zip', 'application/gzip', 'application/x-tar']
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
    <div class="bubble">
      <!-- T08 思考链折叠卡（spec §8.3 (a) / r26 §4） -->
      <slot name="thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen">
        <ThinkingCard v-if="msg.role === 'assistant' && msg.thinking" :thinking="msg.thinking" :thinking-open="msg.thinkingOpen" />
      </slot>
      <!-- T08 工具执行（spec §9.4 / 原型 oc-chat-page） -->
      <!-- #555：>=2 个工具调用聚合折叠为一条摘要（连续同类合并计数、失败追加 · N failed，
           用户故事 6），展开后逐行 ToolLine；单工具调用保持直接渲染。聚合只在渲染层
           落位（msg.tools 循环层），不碰 timeline.ts。 -->
      <template v-if="msg.tools.length >= 2">
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
.msg.user { justify-content: flex-end; }
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
