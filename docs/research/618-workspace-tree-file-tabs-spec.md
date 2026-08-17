# chat/ 页 workspace 文件树 + 文件 tabs 实现规格（#618 / 收口 ticket of [#616](https://github.com/ACautomata/researcher-service/issues/616)）

> **本文件是什么**：[#616](https://github.com/ACautomata/researcher-service/issues/616) 图的 Destination 交付物——可交接实现规格（同 `555-official-tool-call-files.md` 形态：源码行号可核、逐项钉死、零歧义）。图内只规划不写码；本文件汇编已钉死的 6 条设计基线 + [#617](https://github.com/ACautomata/researcher-service/issues/617) 调研可抄写项 + [#619](https://github.com/ACautomata/researcher-service/issues/619) 原型观感，并钉死剩余细节。
>
> **三项本票新决议**（grilling 钉死，实现不得偏离）：
> - **A. tab 状态归属**：新建 `useFileTabsStore`（与 `useChatStore` 同级），不扩进 `chatStore`。
> - **B. 历史回放**：回放历史会话**不开任何 tab**（仅实时工具事件 + 树点击开 tab）。
> - **C. 自动弹 tab 触发集**：仅修改类工具 `edit`/`write`/`patch` 自动弹 tab（对齐 Destination「修改文件类工具」原话）；`read`/`search`/`command`/`fetch` 不自动弹。
>
> **行号基准**：本仓 `master` @ `eedc52b`（2026-08-11），前端在 `frontend/src/`、控制面在 `server/src/`。

---

## 0. 设计基线速览（[#616](https://github.com/ACautomata/researcher-service/issues/616) 已钉死，不在本票重述细节）

1. **布局**：左栏「容器+会话 ｜ 文件树」tab 切换，宽度不变；右侧 tabs 面板**仅在有 tab 时占位**。
2. **树组件**：新写 `WorkspaceTree`（数据对齐 files API `DirListing`/`FileEntry` 嵌套目录树）；wiki 的 `FileTree` 一行不动。
3. **树数据**：`recursive=true` 一次拉全量（10k 上限，`truncated` 时树底提示）；切容器重拉。
4. **tabs 触发**：工具 start 即弹 pending tab；result 后经 files API 拉全文 + 事件流 diff 做行级高亮；同文件后续 result 重拉刷新；error result（含审批拒绝）不开/收起 tab；binary/oversized 显示空态文案。
5. **tabs 内容**：只读全文 + 修改处高亮，**不回写**；查看器为新写轻量组件（等宽 + 行号 + diff 行级底色），**零新依赖、无语法高亮**。
6. **联动**：点树中文件也开 tab（无高亮），与 agent 触发同面板同机制；同路径复用单 tab；tab 可单个关闭 + 一键全关；切会话清空。

> [#617](https://github.com/ACautomata/researcher-service/issues/617) 已证实：官方 `sessions.files.*`/`sessions.diff`/`artifacts.*` 对我们钉死的 SDK `2026.7.2-beta.6` 完全不可用 → **数据路必须走控制面 files REST**（基线 4 被佐证为必然，非可选）；官方无 auto-pop-on-tool-call 联动，tabs 交互全新建。可抄仅两块纯 TS（`session-diff.ts` patch 解析、`tool-call-diff.ts` LCS），后者已在 `frontend/src/chat/toolRender/` 移植落地。
>
> [#619](https://github.com/ACautomata/researcher-service/issues/619) 已定胜出**变体 A**：左栏顶部胶囊分段「会话｜文件」+ 右面板 **360px 固定** + 横排 tab 条 + 骨架屏 pending + 行底色高亮。

---

## 1. 数据契约（files REST + 前端镜像类型）

控制面 files REST 已就绪（[#586](https://github.com/ACautomata/researcher-service/issues/586)/[#589](https://github.com/ACautomata/researcher-service/issues/589)，`server/src/files/routes.ts:54`）：

```
GET /api/v1/containers/:name/files?root=workspace&path=<relPath>&recursive=true|false
```

- `path` 指目录（或空=根）→ `DirListing`；`path` 指文件 → `FileReading`（`server/src/files/fsPort.ts:22-40`）。
- `recursive=true` 递归 walk 全量相对路径（`server/src/files/dockerArchive.ts:169`），超 `WALK_LIMIT` 截断 `truncated:true`。
- binary（NUL 嗅探）与 oversized（`> MAX_FILE_READ_BYTES`）返回 `content:null + binary/oversized:true`（`fsPort.ts:32-40`）——接口不被大二进制拖垮，前端据此出空态。
- 错误信封：不存在 `60040`、已存在 `60041`、非法 `90002`、越权 `20040`（`server/src/files/routes.ts:6`、CLAUDE.md 码段）。读侧容器存在即可读（stopped 亦可）。

**前端镜像类型**（`frontend/src/api/files.ts` 本地定义——前端不 import server 类型，对齐 `api/containers.ts:4-20`/`api/wiki.ts` 本地 DTO 惯例）：

```ts
// 与 server/src/files/fsPort.ts:13-40 逐字段对齐（前端镜像，非 import）
export interface FileEntry { path: string; type: 'file' | 'directory'; size: number; modified: string }
export interface DirListing { kind: 'dir'; path: string; files: FileEntry[]; truncated: boolean }
export interface FileReading {
  kind: 'file'; path: string; content: string | null
  size: number; modified: string; binary: boolean; oversized: boolean
}
```

**client 函数**（两个，都走 `apiJson`——自动信封解包 + 401 刷新链，`frontend/src/api/client.ts:112`）：

```ts
import { apiJson } from '@/api/client'
// 树：一次拉全量 workspace 嵌套（基线 3）
export function listWorkspaceTree(name: string): Promise<DirListing> {
  return apiJson<DirListing>(
    `/api/v1/containers/${encodeURIComponent(name)}/files?root=workspace&recursive=true`,
  )
}
// 单文件全文（基线 4：result 后拉该文件全文）
export function readWorkspaceFile(name: string, relPath: string): Promise<FileReading> {
  return apiJson<FileReading>(
    `/api/v1/containers/${encodeURIComponent(name)}/files?root=workspace&path=${encodeURIComponent(relPath)}`,
  )
}
```

> v1 只读：tabs 不回写（基线 5），故 `api/files.ts` **不实现 PUT/POST/DELETE**（files REST 已有，但本图 Out of scope；后续「tabs 可编辑」票再开）。

---

## 2. 组件划分与文件落位

| 文件（新建） | 职责 | 形态 |
|---|---|---|
| `frontend/src/api/files.ts` | files REST client + 镜像类型（§1） | 纯函数，`apiJson` 封装 |
| `frontend/src/stores/fileTabs.ts` | tab 状态机 + workspace 树数据 + 全部 actions（§3） | Pinia store |
| `frontend/src/components/chat/WorkspaceTree.vue` | 嵌套目录树渲染（对齐 `DirListing`） + truncated 提示 + 点击 emit | 哑组件 props-in/emits-out（对齐 `ChatSidebar` 等 8 组件惯例，`ChatView.vue:6-8`） |
| `frontend/src/components/chat/FileTabsPanel.vue` | 右侧面板壳：横排 tab 条 + 骨架屏 pending + 关闭/全关 + active 切换 + 空态分发 | 哑组件 |
| `frontend/src/components/chat/FileViewer.vue` | 只读查看器：等宽 + 行号 + diff 行级底色高亮 + 各空态（binary/oversized/error/空） | 哑组件（纯展示 `FileTab`） |

**落位约束**：
- 三组件入 `components/chat/`（与 `ChatSidebar`/`ChatStream`/`ToolLine` 同目录，`ChatView.vue:26-29` 已 import 同目录组件）。
- `FileTabsPanel` 是 `ChatView.vue` 模板里 `<main class="main">` 的**右同胞**（`ChatView.vue:246`），`v-if="fileTabs.tabs.length"` 条件占位（基线 1：无 tab 不占位）。360px 固定宽度（变体 A）。
- 「会话｜文件」胶囊分段入 `ChatSidebar.vue` 顶部（变体 A），控制左栏内容切换（会话列表 ↔ WorkspaceTree），**侧栏宽度不变**（基线 1）。
- `useChatConnection.ts` 新增一处调用点（§4），不新增组件。

**复用边界**（不新建）：
- 工具分类/取路径/算 diff：复用已移植的 `frontend/src/chat/toolRender/`（`adapt.ts:9` `toolRowToView`、`tool-call-view.ts` 的 `resolveToolCallKind`/`resolveToolCallTargetPaths`、`tool-call-diff.ts` 的 `computeLineDiff`/`buildWriteDiffLines`）。**零重复实现**。
- wiki `FileTree.vue` / `MdEditor.vue` / `stores/wiki.ts` / `WikiView.vue`：一行不动（[#616](https://github.com/ACautomata/researcher-service/issues/616) Out of scope）。
- server 端：零改动（files API 能力已齐）。

---

## 3. `useFileTabsStore` —— 状态机与 actions（决议 A）

### 3.1 state 形状

```ts
import { defineStore } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { listWorkspaceTree, readWorkspaceFile, type DirListing, type FileEntry } from '@/api/files'
import { resolveToolCallKind, resolveToolCallTargetPaths } from '@/chat/toolRender/tool-call-view'
import { buildWriteDiffLines, computeLineDiff, type DiffLine } from '@/chat/toolRender/tool-call-diff'

export interface FileTab {
  path: string               // workspace 相对路径；唯一 key（基线 6：同路径复用单 tab）
  state: 'pending' | 'loaded' | 'error'
  content: string | null     // 全文（loaded）；pending/error 为 null
  lineMarks: number[]        // 高亮行号（1-based）；空=无高亮（树点击 / 未映射 / write 全行除外）
  binary: boolean            // loaded 时由 FileReading.binary 落
  oversized: boolean         // loaded 时由 FileReading.oversized 落
  errorMessage?: string      // error 态文案（fetch 失败 / 文件不存在）
}

export const useFileTabsStore = defineStore('fileTabs', {
  state: () => ({
    tree: null as DirListing | null,        // workspace 递归树（基线 3）
    treeLoading: false as boolean,
    treeTruncated: false as boolean,
    tabs: [] as FileTab[],
    activePath: null as string | null,
  }),
  // ... actions 见 §3.2
})
```

> 树数据（`tree`）与 tab 数据同住 `fileTabs` store：二者同属「文件面板」关注点、同 per-container 生命周期（切容器树重拉 + tab 清空），合住避免再开一 store。容器名经 `useChatStore().selectedContainer` 取（Pinia 允许跨 store 引用），单一来源。

### 3.2 状态机（pending → loaded / error）

```
                       tool start(edit/write/patch) for P, 无 tab P
          ┌──────────────────────────────────────────────────────────┐
          ▼                                                            │
   ┌──────────┐  tool done → fetch 文件成功   ┌──────────┐            │
   │ pending  │ ────────────────────────────▶│  loaded  │            │
   │ (骨架屏) │                                │ (全文+高亮)│            │
   └──────────┘                                └──────────┘            │
        │  tool error result                       ▲   ▲               │
        │  (含审批拒绝)                             │   │               │
        └──────────► 关闭 tab(remove)              │   │ tree 点击 → fetch 成功
                                                   │   │ tool done → fetch 成功(刷新)
                                                   │   │
                                                ┌──────────┐           │
                                                │  error   │◀──────────┘
                                                │(fetch 失败)│  fetch 失败(60040 等)
                                                └──────────┘
```

**转移规则（逐条钉死）**：

| 触发 | 当前态 | 目标态 | 说明 |
|---|---|---|---|
| `onToolEvent`：kind∈{edit,write}、有 paths、state=`running` | 无 tab P | 新建 tab `{path:P, state:'pending', content:null, lineMarks:[], binary:false, oversized:false}` + `activePath=P` | 基线 4「start 即弹 pending」 |
| 同上 | 已有 tab P（loaded） | **保持 loaded**（不降级 pending 骨架，避免内容闪烁） | 细化：可加 `updating?:boolean` 轻量指示（非必须） |
| `onToolEvent`：state=`done`、kind∈{edit,write}、有 paths | tab P（任意态） | fetch `readWorkspaceFile`：成功→`loaded`+content+lineMarks(§5)+binary/oversized；失败(60040 等)→`error`+errorMessage | 基线 4「result 后拉全文 + 高亮 / 同文件后续 result 重拉刷新」 |
| `onToolEvent`：state=`error` | tab P 仍 `pending`（本 run 所开、未 loaded） | **remove tab P**（若 P 是 active 则 active 切相邻或 null） | 基线 4「error result 收起」 |
| 同上 | tab P 已 `loaded`（先前成功内容） | **保持 loaded，不刷新**（失败编辑未改文件） | 避免误清已展示内容 |
| 同上 | 无 tab P | 不开 tab（什么都不做） | 基线 4「error result 不开」 |
| `openFromTree(P)` | 无 tab P | fetch：成功→`loaded`+content+lineMarks:`[]`(无高亮)；失败→`error`。`activePath=P` | 基线 6「树点击开 tab 无高亮」 |
| 同上 | 已有 tab P | 仅 `activePath=P`（不重拉，除非用户主动刷新——v1 无此按钮） | 基线 6「同路径复用」 |
| fetch 返回 `binary:true` 或 `oversized:true` | — | `loaded`：`content:null` + 对应标志 true → 查看器出空态文案（不崩溃） | §6 空态 |

**关闭与清空**（基线 6）：
- `closeTab(path)`：`tabs = tabs.filter(t => t.path !== path)`；若删的是 active → active 切到剩余末位或 null。
- `closeAll()`：`tabs = []`、`activePath = null`。
- `reset()`：`tabs = []`、`activePath = null`、`tree = null`、`treeTruncated = false`。**切会话 + 切容器均调**（§4 接线点）。

**`onToolEvent` 入口签名**（供 `handleTool` 单点调用）：

```ts
// 唯一 live 入口；handleTool 传整帧，内部自筛 kind/path（决议 C）
onToolEvent(tool: { name: string; state: 'running' | 'done' | 'error'; input: unknown; result: unknown }): void {
  const kind = resolveToolCallKind(tool.name, tool.input)   // tool-call-view.ts
  if (kind !== 'edit' && kind !== 'write') return            // 决议 C：仅修改类
  const paths = resolveToolCallTargetPaths(tool.name, tool.input).filter(p => p && !p.startsWith('/'))
  if (paths.length === 0) return
  for (const p of dedupe(paths)) {
    if (tool.state === 'running') this.openPending(p)
    else if (tool.state === 'done') void this.loadAndHighlight(p, tool)   // §5
    else /* error */ this.closeIfPending(p)
  }
}
```

> **多文件 patch**：`resolveToolCallTargetPaths` 对 patch 工具可返回多路径（`tool-call-patch.ts` 的 `parsePatchView`）。每个路径各开/各刷一个 tab；diff 拆分见 §5。`dedupe` 保同路径只处理一次。

---

## 4. 事件接线（live + tree-click）

### 4.1 live：`handleTool` 单点挂钩

**落点**：`frontend/src/chat/useChatConnection.ts:391` `handleTool`。这是工具帧 `running`/`done`/`error` 三态转换的**唯一**入口（`onFrame` 分派 → `handleTool(frame)`，`useChatConnection.ts:631`），天然拿到 `name/state/input/result` 全量。**不在 `toolRender/adapt.ts` 挂**——那是渲染层纯函数（`adapt.ts:9` 无副作用），只作 §3.2 `onToolEvent` 内部的判定助手被复用。

**改法**（surgical，~2 行）：在 `handleTool` 函数体末尾（现有 `last.tools` push/match 逻辑之后，`return` 之前）调一次：

```ts
// useChatConnection.ts:391 handleTool 末尾
function handleTool(tool: { ... }) {
  if (!claimRun(tool.runId)) return
  // ... 现有 last.tools push/match 逻辑不变 ...
  fileTabs.onToolEvent(tool)   // 新增：drive 文件 tab（决议 A；内部自筛修改类 + 路径）
}
```

> `useChatConnection` 已 import 并直接调用 `chat`（chatStore）多个 action（如 `handleApproval`→`chat.addApproval`），同宿主再 import `useFileTabsStore` 并调其 action 是同一接缝惯例（`useChatConnection.ts:9`）。**不**用深 watch `chat.messages[].tools`——检测 `running→done` 转换需 diff 工具数组，易漏判且重；显式挂 `handleTool` 最直接可靠。

### 4.2 tree-click：`WorkspaceTree` → `openFromTree`

`WorkspaceTree.vue` 点击文件节点 `emit('open', path)` → 父组件（`ChatSidebar` 或 `ChatView`）调 `fileTabs.openFromTree(path)`。与 live 同面板同机制（基线 6），复用 `loadAndHighlight` 的 fetch 路径，仅 `lineMarks=[]`（无高亮）。

### 4.3 切会话/切容器：清空

`useChatConnection` 现有 `resetForSession`/`resetForContainer` 调用点（chatStore 的同名 action，`stores/chat.ts:225-243`）旁，并列加 `fileTabs.reset()`：

- **切会话**（`resetForSession`，`chat.ts:238`）：`fileTabs.reset()`——清空全部 tab + activePath（基线 6「切会话清空」）。树是否保留：树是 per-container 而非 per-session，**切会话保留树**（不重拉），仅清 tab。
- **切容器**（`resetForContainer`，`chat.ts:225`）：`fileTabs.reset()` + 下次进入「文件」分段时重拉树（基线 3「切容器重拉」）。`loadTree` 由分段切到「文件」或容器变更触发，不阻塞 chat 连接。

> `loadTree` 失败（容器 stopped 亦可读；真正失败=容器不存在/越权 20040）→ `tree=null` + 树区出错误空态（§6），不抛错条污染 chat。

---

## 5. diff 行级高亮机制（基线 4「事件流 diff 做行级高亮」+ §0 基线 5 零依赖）

### 5.1 数据来源

`onToolEvent` 在 `done` 态对每个 path 调 `loadAndHighlight(path, tool)`：

1. `readWorkspaceFile(container, path)` 拉文件全文（**编辑后**状态）→ `content`。
2. 据工具类型算 `lineMarks`（高亮行号集合，1-based）：

| 工具子类 | lineMarks 算法 | 精度 |
|---|---|---|
| **write / create**（新文件） | `buildWriteDiffLines(content)` 全 add，`lineNo` 1..N → 全行高亮 | **精确**（整文件即新增，行号与 fetched 完全对齐） |
| **edit**（str_replace/insert/单/多 edit） | 取 edit 的 new 文本（`tool-call-view.ts` 的 `readEditPairs`：`newText`/`new_string`/…）；在 fetched `content` 中**首次出现**定位起始行 → 高亮 new 文本所占行 | **best-effort**（见 §5.2） |
| **patch**（apply_patch/unified）多文件 | 每文件 tab 取该文件片段的 new 行（`parsePatchView` 的 per-file add 行）；在 fetched 中定位 | best-effort |

3. `binary`/`oversized`（`FileReading` 标志）→ `content:null`、`lineMarks:[]`、查看器出空态（§6）。

### 5.2 精度边界（edit 类的已知限制 + 优雅降级）

edit 的 new 文本是片段，无绝对行号；用「在 fetched 全文中首次出现」定位是**best-effort**：
- new 文本在文件中唯一 → 精确高亮。
- new 文本重复出现（如空行、常见代码块）→ 高亮**首次**出现处（可能非真实编辑处）。
- new 文本在 fetched 中找不到（文件被后续工具再改、或 new 文本是 patch 的部分行）→ `lineMarks:[]`（**无高亮，全文照常展示**，不报错）。

> **决议**：v1 接受 best-effort（对齐基线 5「轻量、零依赖」）。绝对行号精确高亮需 server 侧 git baseline diff（类官方 `sessions.diff`，[#617](https://github.com/ACautomata/researcher-service/issues/617) 问 3），属 [#616](https://github.com/ACautomata/researcher-service/issues/616) Not yet specified「全会话 session-diff 面板」邻接域，destination 完成后另票评估。本图不引入。

### 5.3 查看器渲染（`FileViewer.vue`）

- 等宽字体 + 行号槽（变体 A：`.vl .ln` 行号、`.vl .lc` 内容，`docs/prototypes/619-chat-file-tabs.html:89-95`）。
- `lineMarks` 命中行 → 行底色（add 行 `--ok-bg`；`docs/prototypes/619-chat-file-tabs.html:94` `.hl-rowbg`）。
- 行号 = fetched 文件实际行号（1-based，非 diff 行号）。
- 无语法高亮（基线 5）；长行横向滚动（`overflow-x:auto` 内联在查看器容器，非 body）。
- pending 态 → 骨架屏（`.skel`，原型 `:116-118`）。

---

## 6. 各空态形态与文案（基线 4 + §0）

| 空态 | 触发 | 形态 | 文案（建议，最终可微调） |
|---|---|---|---|
| **pending**（骨架屏） | tool `running` 已开 tab、未 done | 3–5 行 shimmer 骨架（原型 `:116-118`） | 无文字（或顶栏小字「正在修改…」） |
| **truncated 树** | `listWorkspaceTree` 返回 `truncated:true` | 树底固定提示条 | 「条目过多，仅显示前 10000 项；未列出的文件仍可被 agent 修改并在此弹出」 |
| **空 workspace** | `tree.files.length === 0` 且非 truncated | 树区居中空态 | 「workspace 为空——agent 创建的文件会出现在这里」 |
| **binary 文件** | `FileReading.binary === true` | 查看器居中空态（不展示内容） | 「二进制文件，不支持预览」 |
| **oversized 文件** | `FileReading.oversized === true` | 同上 | 「文件过大，不支持预览」 |
| **fetch error**（文件不存在 60040 等） | `readWorkspaceFile` 抛 `ApiError` | 查看器 error 态 + 重试按钮 | 「无法读取该文件：{message}」（重试调 `loadAndHighlight`） |
| **error tool result**（含审批拒绝） | `onToolEvent` state=`error` + tab 仍 pending | **不开/收起 tab**（§3.2 转移表） | 无独立空态（tab 直接消失） |
| **无 tab** | `tabs.length === 0` | 右面板**不占位**（`v-if`，基线 1） | — |

---

## 7. 历史路径关系（决议 B 落地）

**事实链**（本仓源码）：
- 历史会话经 `loadHistory` → assistant 消息 `extractToolRows` 重建工具行（`useChatConnection.ts:1030`）。
- `extractToolRows` 产出的 `ToolRow` 恒为 `{state:'done', result:null, input: arguments}`（`useChatConnection.ts:1038-1045`）——**无 diff、无 result**。
- 历史路径**不经过 `handleTool`**（`handleTool` 只由 live `onFrame` `type:'tool'` 触发，`useChatConnection.ts:631`）。

**决议 B 落地**：因 §4.1 把 tab 入站唯一挂在 `handleTool`，历史路径天然不开任何 tab——**无需额外代码**区分 live/history。回放历史会话时：
- 聊天流照常展示工具行（既有 #555 渲染，`ToolLine.vue`），用户能看到 agent 改了哪些文件。
- 右侧 tab 面板保持空（无 tab → 不占位）；用户想看某文件可点聊天流里的工具行（v1：工具行点击是否开 tab 属可选增强，见 §9 未决）或切到「文件」分段点树。
- 切回实时会话/继续对话 → live 工具事件恢复自动弹 tab。

> **不采**「历史也自动开 tab」：history 工具行无 result（不能算 diff 高亮），自动开 = 每次切会话对 N 个文件发 files 请求、却只显示无高亮全文——成本高、价值低，且与「tab 是实时活动面」语义冲突。

---

## 8. 验收标准（实现完成后逐条核）

- **AC1**（live 弹 tab + 高亮）：agent 调 `edit`/`write`/`patch`（live）→ 右侧自动弹 pending 骨架 tab → `done` 后拉全文 + 修改处行底色高亮；同路径复用单 tab，后续 `done` 重拉刷新。
- **AC2**（error result 不开/收起）：工具 `error` result（含 exec 审批拒绝）→ 不开新 tab；若该路径仅有 pending tab 则关闭，已 loaded 的 tab 保持。
- **AC3**（树点击联动）：点 workspace 树文件 → 同面板开 tab（只读全文、无高亮），与 agent 触发同路径复用、同机制。
- **AC4**（关闭/清空）：tab 可单个 × 关闭 + 一键全关；切会话清空全部 tab + activePath（树保留）；切容器清 tab + 树重拉。
- **AC5**（树与空态）：`recursive` 一次拉全量；`truncated` → 树底提示；空 workspace → 空态文案；binary/oversized 文件 → 空态文案（不崩溃、不展示内容）。
- **AC6**（历史不开 tab）：回放历史会话不开任何 tab；切回实时恢复弹出（决议 B）。
- **AC7**（只读 + 零依赖）：查看器只读不回写；零新依赖（无 CodeMirror/highlight.js/shiki）；等宽 + 行号 + diff 行级底色，无语法高亮。
- **AC8**（布局变体 A）：左栏「会话｜文件」胶囊分段，侧栏宽度不变；右面板 360px 固定、仅在有 tab 时占位。
- **AC9**（边界零改动）：server 端零改动；wiki `FileTree`/`stores/wiki.ts`/`WikiView` 零改动；`MdEditor` 零改动。
- **AC10**（测试）：`frontend` vitest 全绿 + `vue-tsc` 类型检查通过；接缝测试覆盖——`api/files.ts`（mock fetch 信封）、`stores/fileTabs.ts` 状态机（纯 mutation 直测：pending/loaded/error 转移、error 收起、同路径复用、reset）、三组件（假数据 props 断言渲染与 emit）。

> **冒烟限制**：本机无网关运行时（memory `local-env-no-gateway-runtime`）→ live 工具事件端到端冒烟不可行；AC1/AC2/AC6 的 live 路径以 vitest（mock `handleTool` 调 `onToolEvent`）+ 类型检查担保，真环境核留部署后人工。

---

## 9. 实现切分（波次/票粒度建议）

每波一票，顺序依赖；每波自带 vitest + 类型，可独立合并。

| 波次 | 票主题 | 范围 | 验收（波内） |
|---|---|---|---|
| **W1** | `api/files.ts` + `fileTabs` store 状态机 | §1 client + 镜像类型；§3 store 全量 actions（`loadTree`/`onToolEvent`/`openFromTree`/`closeTab`/`closeAll`/`reset`/`loadAndHighlight`）纯逻辑 + files 拉取。**不接 UI** | store 直测：状态机转移表全覆盖、error 收起、同路径复用、多文件 patch dedupe、reset；api client mock 信封（60040/20040/binary/oversized） |
| **W2** | `FileViewer` + `FileTabsPanel` | §5.3 查看器（等宽+行号+行底色+骨架屏）；面板壳（横排 tab 条 + 关闭/全关 + active 切换 + §6 空态分发）。假 `FileTab[]` 驱动 | 组件 props 断言：各空态文案、高亮行渲染、关闭/全关 emit、active 切换 |
| **W3** | `WorkspaceTree` + 左栏分段 | 嵌套树渲染（对齐 `DirListing`）+ truncated/空 workspace 提示 + 点击 emit；`ChatSidebar` 加「会话｜文件」胶囊分段（变体 A） | 树渲染嵌套 + truncated 提示 + 点击 emit open；分段切换侧栏宽度不变 |
| **W4** | 事件接线 + 联动 | §4.1 `handleTool`→`onToolEvent`；§4.3 切会话/容器 `reset`；§5 diff 高亮定位；`ChatView` 右面板条件占位；树点击→`openFromTree` | 集成：mock live tool 帧序列 → tab 弹出/高亮/收起/清空全链路；决议 B 历史不开 tab 断言 |
| **W5** | 集成冒烟 + 收尾 | AC1–AC10 全量核；冒烟脚本/手工清单；本机无网关降级说明 | AC 逐条勾核；vitest + vue-tsc 全绿 |

> W1 是关键路径（store 状态机是全图心脏），先合；W2/W3 可并行（互不依赖）；W4 依赖 W1–W3；W5 收口。

---

## 10. 附录

### 10.1 未决 / 已显式推迟（继承 [#616](https://github.com/ACautomata/researcher-service/issues/616) Not yet specified，本票不解决）

- tabs 可编辑/回写（v1 只读；待只读版落地后另票评估并发回写冲突）。
- 查看器语法高亮（基线 5 钉死不做；未来引入 highlight.js/shiki 需评估依赖与包体积）。
- workspace 树 CRUD（新建/删除/上传/重命名）与搜索/过滤。
- tab 历史版本 / 同文件多次修改的 diff 回放。
- 超 10k 条目巨型 workspace 的完整体验（懒加载等）。
- 全会话 session-diff 面板（含 edit 行级绝对高亮的 server 侧精确解，§5.2）。
- 聊天流工具行（`ToolLine.vue`）点击是否开 tab（v1 不做；树点击已覆盖手动开 tab）。

### 10.2 风险

- **edit 行级高亮 best-effort**（§5.2）：可接受；用户感知=「偶尔高亮首处或无高亮」，全文仍可读。真环境核后若反馈差，优先排 §10.1 session-diff 票。
- **本机无网关运行时**：live 端到端冒烟不可行（memory `local-env-no-gateway-runtime`）；W4/W5 以 mock + 类型担保。
- **多文件 patch 的 diff 拆分**：`parsePatchView` 已按文件分段（`tool-call-patch.ts`），但 per-file new 行在 fetched 中定位仍 best-effort；W1 单测须覆盖多文件 patch 的 tab 多开 + 各自高亮降级。

### 10.3 关键源码索引（本仓 master @ `eedc52b`）

- 工具事件入口：`frontend/src/chat/useChatConnection.ts:391`（`handleTool`）、`:631`（`onFrame` 分派）、`:1030`（`extractToolRows` 历史路径）。
- chatStore：`frontend/src/stores/chat.ts:11`（`ToolRow` 形状）、`:225`/`:238`（`resetForContainer`/`resetForSession`）。
- toolRender 抄写集（已移植，复用）：`frontend/src/chat/toolRender/tool-call-view.ts`（`resolveToolCallKind`/`resolveToolCallTargetPaths`）、`tool-call-diff.ts`（`computeLineDiff`/`buildWriteDiffLines`）、`tool-call-patch.ts`（`parsePatchView`）、`adapt.ts:9`（`toolRowToView`）。
- files REST：`server/src/files/routes.ts:54`（GET）、`server/src/files/fsPort.ts:13-40`（`FileEntry`/`DirListing`/`FileReading`）、`server/src/files/dockerArchive.ts:169`（recursive walk + truncated）。
- API client 约定：`frontend/src/api/client.ts:112`（`apiJson` 信封解包 + 401 刷新）、`frontend/src/api/containers.ts:22`（同形态 client 函数范例）。
- ChatView 布局：`frontend/src/views/ChatView.vue:234-246`（`<ChatSidebar>` + `<main class="main">` 右同胞位点）、`:26-29`（同目录组件 import 惯例）。
- 原型（变体 A 全集）：`docs/prototypes/619-chat-file-tabs.html`（`?variant=A`，`:102-118` 段胶囊/360px/横排 tab/骨架屏/行底色）。
