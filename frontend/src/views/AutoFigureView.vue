<script setup lang="ts">
// AutoFigure 生成页（T09，docs/autofigure/tickets/T09-vue-figure-journey.md）。
// Vue-native 旅程：prompt 提交（Idempotency-Key 快照）→ queued/running 轮询 → succeeded PNG
// 预览/下载 | failed 稳定失败态；历史列表 → 详情重开；flag off → 「功能未启用」（非裸 404）。
//
// 全局不变量：无假百分比 / 无 SSE/WS / 无 provider 凭证 / 无删除 / 无浏览器→Python；只消费应用级
// 状态（envelope code/status/prompt）；错误走 ApiError 逐字或本地化兜底（网络瞬态不渲染为失败态）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ApiError } from '@/api/client'
import {
  createFigure,
  getFigureDetail,
  getFigurePngBlob,
  type FigureAppStatus,
  type FigureDetailDTO,
  type FigureSummaryDTO,
} from '@/api/figures'
import { useAutofigureStore } from '@/stores/autofigure'

const store = useAutofigureStore()

const POLL_INTERVAL_MS = 3000

// ---- 提交快照（T09 约束 3：可编辑 promptText / 已提交 prompt+key / 当前 Figure 状态三分离）----
// promptText 是编辑器可改文本；submission 是「已提交意图」快照 {prompt, key}——编辑 promptText 不触碰
// 它（正在运行的提交身份不被编辑动作改变）；只有新提交意图才替换 submission。
const promptText = ref('')
const submitting = ref(false)
const submission = ref<{ prompt: string; key: string } | null>(null)
const current = ref<FigureDetailDTO | null>(null)

// ---- 轮询（无重叠：refreshInFlight 守卫 + interval 单例；卸载/隐藏停，可见即恢复）----
let pollTimer: ReturnType<typeof setInterval> | null = null
let refreshInFlight = false

// ---- PNG 预览（T09 约束 4：stale 响应守卫 + Blob URL 回收）----
const previewUrl = ref<string | null>(null)
let pngFetchedFor: string | null = null
let figureGeneration = 0 // 每次切换当前 Figure 目标 +1；在飞 detail/PNG 响应据此丢弃 stale

const errorMsg = ref('')
const probeFailed = ref(false)

// 状态域以 FigureAppStatus 联合定型（api/figures.ts 单一来源），避免裸 string 三处并列分支。
const STATUS_LABEL: Record<FigureAppStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

const STATUS_TAG_TYPE: Record<FigureAppStatus, 'success' | 'warning' | 'info' | 'danger' | ''> = {
  succeeded: 'success',
  failed: 'danger',
  running: 'warning',
  queued: 'info',
}

const isNonTerminal = (s: FigureAppStatus | undefined): boolean => s === 'queued' || s === 'running'

function statusTagType(status: FigureAppStatus): 'success' | 'warning' | 'info' | 'danger' | '' {
  return STATUS_TAG_TYPE[status]
}

// capability 就绪后模板才渲染主内容（unknown → 轻量检测态，不闪 disabled 误判）。
const capabilityReady = computed(() => store.capability !== 'unknown')

function startPolling(): void {
  if (!isNonTerminal(current.value?.status)) return
  if (pollTimer !== null) return
  pollTimer = setInterval(() => {
    void refreshCurrent()
  }, POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function revokePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = null
  }
  pngFetchedFor = null
}

// 切换当前 Figure 目标：递增 generation（stale 守卫）→ 回收旧预览 → 停旧轮询。
function switchTo(figure: FigureDetailDTO | null): void {
  figureGeneration += 1
  revokePreview()
  stopPolling()
  current.value = figure
  if (!figure) submission.value = null
}

async function refreshCurrent(): Promise<void> {
  const id = current.value?.figureId
  if (!id || refreshInFlight) return
  refreshInFlight = true
  const gen = figureGeneration
  try {
    const detail = await getFigureDetail(id)
    if (gen !== figureGeneration || current.value?.figureId !== id) return // stale 丢弃
    current.value = detail
    const status = detail.status
    if (status === 'succeeded') {
      stopPolling()
      await loadPng(id)
    } else if (status === 'failed') {
      stopPolling()
    }
    // queued/running → 下一 tick 继续
  } catch (e) {
    if (gen !== figureGeneration) return
    if (e instanceof ApiError && e.code === 70040) {
      // 不存在/越权：停止轮询，应用级提示。
      stopPolling()
      errorMsg.value = e.message
    }
    // 其余瞬态（网络/5xx）：保持现有状态，下一 tick 重试
  } finally {
    refreshInFlight = false
  }
}

async function loadPng(id: string): Promise<void> {
  if (pngFetchedFor === id && previewUrl.value) return // 已取过且存活
  const gen = figureGeneration
  try {
    const blob = await getFigurePngBlob(id)
    if (gen !== figureGeneration || current.value?.figureId !== id) return // stale：未建 URL 无泄漏
    const url = URL.createObjectURL(blob)
    if (gen !== figureGeneration || current.value?.figureId !== id) {
      URL.revokeObjectURL(url) // 在飞期间目标切换：立即回收刚建的 URL
      return
    }
    revokePreview()
    previewUrl.value = url
    pngFetchedFor = id
  } catch (e) {
    if (gen !== figureGeneration) return // stale 错误丢弃
    if (e instanceof ApiError && (e.code === 70043 || e.code === 70040)) {
      errorMsg.value = e.message // PNG 不可用 / 不存在
    } else {
      errorMsg.value = 'PNG 加载失败，请稍后重试'
    }
  }
}

// 幂等键生命周期（约束 3）：
//   - 快照与输入同 prompt 且其提交未达终态（Job queued/running，或 create 尚未成功 current===null）
//     → 复用同 key（瞬态重试同一次提交 / 防重复提交去重）。
//   - 否则（终态后再次生成 / 不同 prompt / 首次提交）→ 新 key。key 仅内存，不持久化。
function beginSubmission(prompt: string): string {
  const s = submission.value
  if (s && s.prompt === prompt) {
    const active = current.value
    const stillActive = active !== null && isNonTerminal(active.status)
    const createNotSettled = active === null // create 失败/未成功 → 重试同 key
    if (stillActive || createNotSettled) return s.key
  }
  submission.value = { prompt, key: crypto.randomUUID() }
  return submission.value.key
}

async function submit(): Promise<void> {
  const prompt = promptText.value.trim()
  if (!prompt) {
    ElMessage.warning('请输入生成提示词')
    return
  }
  if (submitting.value) return
  submitting.value = true
  errorMsg.value = ''
  try {
    const key = beginSubmission(prompt)
    const result = await createFigure(prompt, key)
    switchTo({
      figureId: result.figureId,
      jobId: result.jobId,
      prompt,
      status: result.status,
      errorMessage: null,
      createdAt: '',
      updatedAt: '',
    })
    if (isNonTerminal(result.status)) {
      void refreshCurrent() // 立即拉一次详情（create 可能已 running）
      startPolling()
    } else if (result.status === 'succeeded') {
      void loadPng(result.figureId)
    }
    void store.refreshHistory()
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.code === 70041) {
        // Spec-3：服务端已确认该 key 绑定不同输入，作废本提交快照——继续复用只会永久 70041。
        // 仅清 submission（下一提交生成新 key），不清 current（若有已完成 Figure 不受影响）。
        submission.value = null
        errorMsg.value = '检测到幂等键冲突，请重试'
      } else {
        errorMsg.value = e.message // 90002 校验 / 70040 等：信封 message 即应用级文案
      }
    } else {
      errorMsg.value = '提交失败，请稍后重试' // 网络瞬态：重试沿用同 key（beginSubmission）
    }
  } finally {
    submitting.value = false
  }
}

async function reopen(figure: FigureSummaryDTO): Promise<void> {
  errorMsg.value = ''
  try {
    const detail = await getFigureDetail(figure.figureId)
    switchTo(detail) // 递增 generation + 停旧轮询 + 回收旧预览
    submission.value = null // 重开不是提交；重开后的新提交是新生成（新 key）
    if (detail.status === 'succeeded') {
      await loadPng(detail.figureId)
    } else if (isNonTerminal(detail.status)) {
      startPolling()
    }
    // failed → current 已含 errorMessage，渲染稳定失败态
  } catch (e) {
    errorMsg.value = e instanceof ApiError ? e.message : '加载失败，请稍后重试'
  }
}

async function retryProbe(): Promise<void> {
  probeFailed.value = false
  await store.probe(true)
  probeFailed.value = store.capability === 'unknown'
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    if (isNonTerminal(current.value?.status)) void refreshCurrent()
    startPolling()
  } else {
    stopPolling()
  }
}

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  await store.probe()
  probeFailed.value = store.capability === 'unknown'
})

onBeforeUnmount(() => {
  // T09 Spec-2：先递增 generation 失效在飞 detail/PNG 响应——unmount 时在飞 loadPng 的 gen 检查
  // 随即失败，不得再 createObjectURL（否则 URL 无人 revoke → Blob 泄漏）；已建的 URL 由 revokePreview 回收。
  figureGeneration += 1
  stopPolling()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  revokePreview()
})
</script>

<template>
  <div class="autofigure-view" data-test="autofigure-view">
    <!-- flag off：明确「功能未启用」，非裸 404（T09 AC） -->
    <div v-if="store.capability === 'disabled'" class="autofigure-disabled" data-test="autofigure-disabled">
      AutoFigure 功能未启用
    </div>

    <!-- unknown：轻量检测态；probe 失败（瞬态）给重试入口 -->
    <div v-else-if="!capabilityReady" class="autofigure-probing" data-test="autofigure-probing">
      <template v-if="probeFailed">
        <span>AutoFigure 功能状态检测失败</span>
        <el-button link data-test="retry-probe" @click="retryProbe">重试</el-button>
      </template>
      <span v-else>正在检测 AutoFigure 功能状态…</span>
    </div>

    <template v-else>
      <!-- composer -->
      <div class="autofigure-composer">
        <el-input
          v-model="promptText"
          type="textarea"
          :rows="3"
          placeholder="描述你想生成的 figure…"
          data-test="prompt-input"
        />
        <div class="autofigure-actions">
          <el-button type="primary" :loading="submitting" data-test="submit-button" @click="submit">
            生成
          </el-button>
        </div>
        <p v-if="errorMsg" class="autofigure-error" data-test="autofigure-error">{{ errorMsg }}</p>
      </div>

      <!-- current submission -->
      <div v-if="current" class="autofigure-current" data-test="current-figure">
        <h3>当前生成</h3>
        <p class="autofigure-prompt">{{ current.prompt }}</p>
        <div class="autofigure-meta">
          <span class="autofigure-id">figure {{ current.figureId }} · job {{ current.jobId }}</span>
          <el-tag :type="statusTagType(current.status)" data-test="status-tag">
            {{ STATUS_LABEL[current.status] ?? current.status }}
          </el-tag>
        </div>
        <!-- failed：稳定失败态（errorMessage 服务端已白名单，非敏感） -->
        <p
          v-if="current.status === 'failed' && current.errorMessage"
          class="autofigure-failed"
          data-test="failed-message"
        >
          {{ current.errorMessage }}
        </p>
        <!-- succeeded：PNG 预览 + 下载 -->
        <template v-if="current.status === 'succeeded'">
          <div class="autofigure-preview" data-test="png-preview">
            <img v-if="previewUrl" :src="previewUrl" :alt="current.prompt" data-test="png-img" />
            <span v-else class="autofigure-preview-loading">正在加载图片…</span>
          </div>
          <a
            v-if="previewUrl"
            class="autofigure-download"
            :href="previewUrl"
            :download="`autofigure-${current.figureId}.png`"
            data-test="png-download"
          >
            下载 PNG
          </a>
        </template>
      </div>

      <!-- history -->
      <div class="autofigure-history">
        <h3>生成历史</h3>
        <ul v-if="store.history.length" class="autofigure-history-list" data-test="history-list">
          <li
            v-for="item in store.history"
            :key="item.figureId"
            class="autofigure-history-item"
            data-test="history-item"
          >
            <div class="autofigure-history-main">
              <span class="autofigure-history-prompt">{{ item.prompt }}</span>
              <span class="autofigure-history-meta">
                {{ item.createdAt }} · {{ STATUS_LABEL[item.status] ?? item.status }}
              </span>
            </div>
            <el-button link type="primary" data-test="reopen-button" @click="reopen(item)">
              查看
            </el-button>
          </li>
        </ul>
        <p v-else class="autofigure-empty" data-test="history-empty">暂无生成历史</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.autofigure-view {
  padding: 20px;
  max-width: 760px;
}
.autofigure-disabled,
.autofigure-probing {
  padding: 24px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
.autofigure-composer {
  margin-bottom: 24px;
}
.autofigure-actions {
  margin-top: 10px;
}
.autofigure-error,
.autofigure-failed {
  color: var(--el-color-danger);
  margin-top: 8px;
  font-size: 13px;
}
.autofigure-current,
.autofigure-history {
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 20px;
}
.autofigure-current h3,
.autofigure-history h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.autofigure-prompt {
  margin: 0 0 8px;
  font-size: 14px;
}
.autofigure-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.autofigure-preview {
  margin-top: 12px;
}
.autofigure-preview img {
  max-width: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}
.autofigure-download {
  display: inline-block;
  margin-top: 10px;
  color: var(--el-color-primary);
}
.autofigure-history-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.autofigure-history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.autofigure-history-item:last-child {
  border-bottom: 0;
}
.autofigure-history-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.autofigure-history-prompt {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.autofigure-history-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.autofigure-empty {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 0;
}
</style>
