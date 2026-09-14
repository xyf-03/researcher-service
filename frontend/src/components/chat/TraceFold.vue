<script setup lang="ts">
// T1 轮次折叠条（#664 / CONTEXT.md「折叠条」）：轮次正常完成后轨迹（思考+工具）收进的单个折叠块
// 的条面。props-in/emits-out 哑组件（贴现有 chat 展示组件形态）：条面显示主文案 + 次要计数，点击
// emit('toggle') 回父层落 store；折叠态由 store 驱动（folded prop 只作条面箭头方向指示），轨迹
// 条目（思考卡/工具行）由父层在折叠条外按展开态渲染。
// T2 执行时长（#665）：有计时的条面主文案升级为「已执行 42s」（≥60s 中文分秒）+ 次要计数
// 「思考 · 5 次工具」；无时长数据（历史轮，durationMs 缺省）回退「执行过程 · …」计数文案。
// 格式化在本组件 computed 内完成（spec 决议：经条面文案断言，不新增纯函数测试接缝）。
import { computed } from 'vue'

const props = defineProps<{
  hasThinking: boolean // 本轮含思考
  toolCount: number // 本轮工具调用行数
  folded: boolean // 当前折叠态（条面在折叠/展开两态都渲染，箭头指示当前态）
  turnDurationMs?: number // 执行时长毫秒（#665；缺省 = 无时长数据 → 回退「执行过程」。与 Msg.turnDurationMs 同名——审查 S2：勿与媒体附件 durationMs（mm:ss 播放时长）同名混淆）
}>()

const emit = defineEmits<{ toggle: [] }>()

// 主文案：无时长数据回退「执行过程」；有时长「已执行 42s」——秒段 <60s 直接秒数，≥60s 中文分秒
//（整分钟省略秒段：「已执行 1 分」）。秒取整对齐 ChatMessageItem.formatDuration（Math.round）。
const durationLabel = computed(() => {
  if (props.turnDurationMs == null) return '执行过程'
  const totalSec = Math.max(0, Math.round(props.turnDurationMs / 1000))
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `已执行 ${totalSec}s`
  return sec > 0 ? `已执行 ${min} 分 ${sec} 秒` : `已执行 ${min} 分`
})

// 次要计数：思考段/工具段按实际内容有无拼接（纯思考/纯工具轮按实际内容计数）——
// 「思考 · 5 次工具」/「思考」/「3 次工具」/空（无轨迹不会渲染折叠条，防御性容空）。
const countLabel = computed(() => {
  const parts = []
  if (props.hasThinking) parts.push('思考')
  if (props.toolCount > 0) parts.push(`${props.toolCount} 次工具`)
  return parts.join(' · ')
})
</script>

<template>
  <button type="button" class="trace-fold" data-test="trace-fold" @click="emit('toggle')">
    <span class="caret" :class="{ open: !folded }">▶</span>
    <span class="label" data-test="trace-fold-label"
      >{{ durationLabel }}<template v-if="countLabel"> · <span class="counts">{{ countLabel }}</span></template></span
    >
  </button>
</template>

<style scoped>
.trace-fold {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 6px 12px;
  border: 1px dashed var(--el-border-color);
  border-radius: 10px;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
  text-align: left;
}
.trace-fold .caret { display: inline-block; font-size: 10px; transition: transform .18s; }
.trace-fold .caret.open { transform: rotate(90deg); }
.trace-fold .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trace-fold .counts { color: var(--el-text-color-secondary); } /* #665：次要计数弱化于时长主文案 */
</style>
