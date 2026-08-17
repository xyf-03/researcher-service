<script setup lang="ts">
// #555 工具渲染体系(官方对齐,抄写 toolRender/ 4 文件):summary 行 = 图标 + 主文本
// (command 命令首行折叠 / read·edit·write·search·fetch 的 target basename,加粗) + 副文本
// (targetDetail 目录淡显,ellipsis) + 状态;展开区 = edit/write 内联 diff + stat + 输入/输出详情。
// props-in/emits-out 哑组件(#316:#340 拆分边界)。
import { computed } from 'vue'
import type { ToolRow } from '@/stores/chat'
import { toolRowToView } from '@/chat/toolRender/adapt'
import type { DiffLineKind } from '@/chat/toolRender/tool-call-diff'

const props = defineProps<{
  tool: ToolRow
}>()

const view = computed(() => toolRowToView(props.tool))

// summary 显示模型(合并主/副/提示文本,判别只写一次):command=剥壳命令首行(折叠);
// 其余=target(basename/pattern/url)+targetDetail(目录/范围淡显);generic=title/name。
// hint 提示全文:command=完整命令;其余=完整路径。
const display = computed(() => {
  const v = view.value
  if (v.kind === 'command') {
    return { main: firstLine(v.command) || props.tool.name, secondary: '', hint: v.command ?? '' }
  }
  const title = typeof props.tool.title === 'string' ? props.tool.title : props.tool.name
  return {
    main: v.target ?? title,
    secondary: v.targetDetail ?? '',
    hint: v.targetDetail ? `${v.targetDetail}/${v.target ?? ''}` : (v.target ?? ''),
  }
})

function firstLine(text: string | undefined): string {
  if (!text) return ''
  const idx = text.indexOf('\n')
  return idx < 0 ? text : text.slice(0, idx)
}

function formatDetail(value: unknown): string {
  if (value == null || value === '') return '无'
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

// command 展开区显示剥壳完整命令(用户故事:看到命令本身);其余保持原始 input 详情
function inputDetail(): string {
  if (view.value.kind === 'command') return view.value.command ?? formatDetail(props.tool.input)
  return formatDetail(props.tool.input)
}

function diffSig(kind: DiffLineKind): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '-'
  if (kind === 'skip') return '…'
  return ' '
}
</script>

<template>
  <details class="tool" :class="tool.state" data-test="tool-line">
    <summary>
      <span class="t-icon">🔧</span>
      <span class="t-name" :title="display.hint">{{ display.main }}</span>
      <span v-if="display.secondary" class="t-args" :title="display.hint">{{ display.secondary }}</span>
      <span class="t-state">{{ tool.state === 'running' ? '⟳ 运行中' : tool.state === 'error' ? '✗ 失败' : '✓ 完成' }}</span>
    </summary>
    <div class="t-detail" data-test="tool-detail">
      <!-- #555 edit/write 内联 diff(行级对照 + added/removed stat) -->
      <div v-if="view.diff" class="t-diff" data-test="tool-diff">
        <div v-if="view.stat" class="t-stat" data-test="tool-stat">
          <span class="stat-add">+{{ view.stat.added }}</span>
          <span class="stat-del">−{{ view.stat.removed }}</span>
        </div>
        <div v-for="(line, i) in view.diff" :key="i" class="dl" :class="line.kind">
          <span class="dl-no">{{ line.lineNo ?? '' }}</span>
          <span class="dl-sig">{{ diffSig(line.kind) }}</span>
          <span class="dl-text">{{ line.text }}</span>
        </div>
      </div>
      <strong>输入</strong><pre>{{ inputDetail() }}</pre>
      <strong>输出</strong><pre>{{ formatDetail(tool.result) }}</pre>
    </div>
  </details>
</template>

<style scoped>
.tool { min-width: 0; background: var(--el-fill-color); border: 1px solid var(--el-border-color); border-radius: 9px; padding: 6px 12px; margin: 4px 0; font-size: 12.5px; }
.tool summary { display: flex; align-items: center; min-width: 0; gap: 9px; cursor: pointer; }
.tool .t-icon { color: var(--el-color-primary); }
.tool .t-name { font-family: ui-monospace, monospace; font-weight: 600; min-width: 0; }
.tool .t-args { min-width: 0; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
.tool .t-state { flex: none; margin-left: auto; display: flex; align-items: center; gap: 5px; }
.tool.running .t-state { color: var(--el-color-warning); }
.tool.error .t-state { color: var(--el-color-danger); }
.tool.done .t-state { color: var(--el-color-success); }
.t-detail { margin-top: 8px; border-top: 1px solid var(--el-border-color); padding-top: 8px; }
.t-detail pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--el-fill-color-darker); padding: 8px; border-radius: 6px; }
/* #555 内联 diff:add 绿 / del 红 / ctx 灰 / file 标题行 / skip 省略 */
.t-diff { max-height: 300px; overflow: auto; background: var(--el-fill-color-darker); border-radius: 6px; padding: 6px 0; margin-bottom: 8px; font-family: ui-monospace, monospace; }
.t-stat { padding: 2px 10px 4px; font-weight: 600; }
.t-stat .stat-add { color: var(--el-color-success); }
.t-stat .stat-del { color: var(--el-color-danger); }
.dl { display: flex; gap: 8px; padding: 0 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dl .dl-no { flex: none; min-width: 2.5em; text-align: right; color: var(--el-text-color-placeholder); user-select: none; }
.dl .dl-sig { flex: none; width: 1em; user-select: none; }
.dl.add { background: color-mix(in srgb, var(--el-color-success) 12%, transparent); }
.dl.add .dl-sig { color: var(--el-color-success); }
.dl.del { background: color-mix(in srgb, var(--el-color-danger) 12%, transparent); }
.dl.del .dl-sig { color: var(--el-color-danger); }
.dl.file { font-weight: 600; color: var(--el-text-color-secondary); padding-top: 4px; }
.dl.skip { justify-content: center; color: var(--el-text-color-placeholder); padding: 2px 0; }
</style>
