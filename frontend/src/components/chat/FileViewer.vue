<script setup lang="ts">
// FileViewer —— 只读全文查看器（#626 T1 / #618 规格 §5.3，变体 A）。
// 哑组件纯展示 FileTab：等宽 + 行号槽 + lineMarks 命中行 add 底色高亮；长行横向滚动；无语法高亮、
// 零新依赖、只读不回写。空态分发：error（含重试按钮，#628 T3）/ binary / oversized / loading（content null 但 loaded）。
import { computed } from 'vue'
import type { FileTab } from '@/stores/fileTabs'

const props = defineProps<{ tab: FileTab }>()
// #628 T3：error 态「重试」——哑组件仅 emit 本 tab 的 path，父链经 FileTabsPanel 透明上浮至 ChatView 调
// fileTabs.retry，据开路上下文（agent→复刻高亮 / tree→无高亮）复刻对应 fetch。
defineEmits<{ retry: [path: string] }>()

// 行按 \n 切分（保留尾空行）；行号 1-based。
const lines = computed(() => (props.tab.content ?? '').split('\n'))
const markSet = computed(() => new Set(props.tab.lineMarks))
function isMarked(n: number): boolean {
  return markSet.value.has(n)
}
</script>

<template>
  <div class="fv" data-test="file-viewer">
    <div v-if="tab.state === 'error'" class="state" data-test="viewer-error">
      <span class="ic">⚠️</span>
      <span>无法读取该文件：{{ tab.errorMessage ?? '未知错误' }}</span>
      <button type="button" class="retry" data-test="viewer-retry" @click="$emit('retry', tab.path)">重试</button>
    </div>
    <div v-else-if="tab.state === 'pending'" class="skel" data-test="viewer-pending">
      <div
        v-for="w in [ '55%', '82%', '68%', '44%' ]"
        :key="w"
        class="skel-line"
        :style="{ width: w }"
      />
      <span class="skel-hint">正在修改…</span>
    </div>
    <div v-else-if="tab.binary" class="state" data-test="viewer-binary">
      <span class="ic">📦</span>
      <span>二进制文件，不支持预览</span>
    </div>
    <div v-else-if="tab.oversized" class="state" data-test="viewer-oversized">
      <span class="ic">🐘</span>
      <span>文件过大，不支持预览</span>
    </div>
    <div v-else-if="tab.content === null" class="state" data-test="viewer-loading">
      <span class="ic">⋯</span>
      <span>正在读取文件…</span>
    </div>
    <div v-else class="viewer" data-test="viewer-content">
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="vl"
        :class="{ hl: isMarked(i + 1) }"
        :data-test="`line-${i + 1}`"
      ><span class="mk">{{ isMarked(i + 1) ? '+' : ' ' }}</span><span class="ln">{{ i + 1 }}</span><span class="lc">{{ line }}</span></div>
    </div>
  </div>
</template>

<style scoped>
.fv { height: 100%; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.viewer { height: 100%; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 1.55; padding: 8px 0; }
.vl { display: flex; white-space: pre; }
.vl.hl { background: rgba(103, 194, 58, 0.13); }
.mk { width: 14px; flex: none; text-align: center; color: var(--el-color-success); font-weight: 700; user-select: none; }
.ln { width: 34px; flex: none; text-align: right; padding-right: 10px; color: var(--el-text-color-secondary); user-select: none; }
.lc { flex: 1; padding-right: 14px; color: var(--el-text-color-primary); }
.state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 13px; text-align: center; padding: 24px 16px; }
.state .ic { font-size: 26px; }
.state .retry { margin-top: 4px; background: transparent; border: 1px solid var(--el-border-color); border-radius: 6px; padding: 4px 14px; cursor: pointer; color: var(--el-color-primary); font-size: 12.5px; }
.state .retry:hover { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary); }
/* pending 骨架屏（agent running；原型 619 .skel shimmer）——零依赖纯 CSS */
.skel { height: 100%; display: flex; flex-direction: column; gap: 9px; padding: 14px 16px; }
.skel-line { height: 14px; border-radius: 4px; background: linear-gradient(90deg, var(--el-fill-color) 25%, var(--el-fill-color-light) 37%, var(--el-fill-color) 63%); background-size: 400% 100%; animation: fv-skel 1.4s ease infinite; }
.skel-hint { font-size: 12.5px; color: var(--el-text-color-secondary); margin-top: 6px; }
@keyframes fv-skel { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
</style>
