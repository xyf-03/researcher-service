// t() 本地 shim：替代官方 tool-call-grouping 依赖的 ui/src/i18n 状态式 I18nManager
//（带 localStorage/document 副作用 + 异步语言包，面板无此体系）。只含聚合摘要所需
// 英文文案表 + {count}/{names} 插值，key 沿用官方 `chat.toolCards.group.*`(#555 移植注意 3a)。
// 文案表来源：docs/research/555-official-tool-call-files.md §G（ui/src/i18n/locales/en.ts）。

const TOOL_GROUP_MESSAGES: Record<string, string> = {
  'chat.toolCards.group.commandsOne': 'ran a command',
  'chat.toolCards.group.commandsMany': 'ran {count} commands',
  'chat.toolCards.group.readsOne': 'read a file',
  'chat.toolCards.group.readsMany': 'read {count} files',
  'chat.toolCards.group.editsOne': 'edited a file',
  'chat.toolCards.group.editsMany': 'edited {count} files',
  'chat.toolCards.group.writesOne': 'created a file',
  'chat.toolCards.group.writesMany': 'created {count} files',
  'chat.toolCards.group.searchesOne': 'ran a search',
  'chat.toolCards.group.searchesMany': 'ran {count} searches',
  'chat.toolCards.group.fetchesOne': 'fetched a page',
  'chat.toolCards.group.fetchesMany': 'fetched {count} pages',
  'chat.toolCards.group.namedTool': 'used {names}',
  'chat.toolCards.group.namedToolRepeated': 'used {names} ×{count}',
  'chat.toolCards.group.otherOne': 'used a tool',
  'chat.toolCards.group.otherMany': 'used {count} tools',
  'chat.toolCards.group.emptyOne': 'Ran a tool call',
  'chat.toolCards.group.emptyMany': 'Ran {count} tool calls',
  'chat.toolCards.group.failedOne': '{count} failed',
  'chat.toolCards.group.failedMany': '{count} failed',
}

export function t(key: string, params?: Record<string, string>): string {
  let template = TOOL_GROUP_MESSAGES[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      template = template.replaceAll(`{${name}}`, value)
    }
  }
  return template
}
