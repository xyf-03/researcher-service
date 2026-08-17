// #555 数据适配：渲染层 ToolRow(input/result) → 官方 view-model 三元组。
// args←ToolRow.input（调用参数）、details←ToolRow.result（结果侧细节，edit/write 的权威
// diff 优先读 details.diff，缺则 view 内部本地 computeLineDiff 双源兜底）。
// 纯函数、无 I/O，便于按翻译层接缝风格直测（喂 ToolRow → 断言 ToolCallView）。
import type { ToolRow } from '@/stores/chat'
import { resolveToolCallView, type ToolCallView } from './tool-call-view'
import type { ToolGroupSummaryInput } from './tool-call-grouping'

export function toolRowToView(tool: ToolRow): ToolCallView {
  return resolveToolCallView({ name: tool.name, args: tool.input, details: tool.result })
}

export function toolRowToGroupInput(tool: ToolRow): ToolGroupSummaryInput {
  return { name: tool.name, args: tool.input, isError: tool.state === 'error' }
}
