# 官方 control-ui workspace 文件面板调研(#617 / 子 ticket of #616)

> **研究问题**：官方 control-ui(`github.com/openclaw/openclaw` 的 `ui/`,Lit + Vite）在「workspace 文件树 / 文件预览 / canvas 面板 / session-diff 面板」上的实现细节是什么？哪些可抄、哪些必须自建？
>
> **背景**:#616 规划 chat/ 页「左栏 workspace 文件树 + 右侧只读文件 tabs(agent 调用修改文件类工具时自动弹出、修改处行级高亮）」。`558-official-ui-study.md:107` 曾把 session-diff 面板与 canvas 预览判「不做」（理由：面板单 agent/精简场景用不上）。需求已出现，重看可参考性。
>
> **一手来源**：本调研经 `gh api repos/openclaw/openclaw/contents` + raw 抓取官方**当前 main** 源码（HEAD `686294f9f8b2600c6b7a2d023bc9b79f514609bc`,2026-08-11),**非二手**。下列行号均为该版本行号。
>
> **版本断层（贯穿全文的头号事实）**：官方这套面板的数据通路全部建立在 `sessions.files.*` / `sessions.diff` / `artifacts.*` 这组**较新 gateway RPC** 上。我们钉死的 SDK `@openclaw/gateway-client@2026.7.2-beta.6` **完全没有**这些方法——`grep` 整个 `dist/`:`sessions.files.*` / `sessions.diff` / `artifacts.*` / `listFiles` / `getFile` / `setFile` 命中 0;`gateway-protocol/dist` 仅残留一个 `SessionsDiff` 类型，无 `SessionWorkspace*` 类型、无 client helper。官方 UI 自己也用 `isGatewayMethodAdvertised`(读 WS hello 的 `features.methods[]`,`ui/src/lib/gateway-methods.ts:6-19`）对这些方法逐个做能力门控——证明它们是**可选/新网关能力**，不是协议基石。

---

## 问 1：官方有没有文件树/文件列表面板？数据从哪来？

**有，但形态与 #616 想要的「recursive 嵌套树」不同。** 官方叫 **workspace files rail**(`chat-workspace-rail`),chat 页可 dock 到右侧或底部的栏，折叠态只剩 header(`⇧⌘B` 切换）。实现集中在 `ui/src/pages/chat/components/chat-session-workspace.ts`(~1395 行）+ `chat-pane-render.ts`（接线）。

**数据来自三个 gateway WebSocket RPC**(`client.request(...)`/`sessions` capability wrapper)——**不是 REST，也不是某种 fs 能力工具**:

| RPC | 返回 | 用途 |
|---|---|---|
| `sessions.files.list` | `SessionWorkspaceListResult` | 文件面板主数据（见下） |
| `artifacts.list` / `artifacts.download` | artifact 列表/字节 | 产物区 |
| `sessions.files.get` | `SessionWorkspaceGetResult.file` | 单文件全文（预览用） |

`sessions.files.list` 的返回(`ui/src/api/types.ts:369-376` + `324-355`）实为**三块拼起来的**:

1. **`files[]`：会话「触碰过」的文件清单**(`SessionWorkspaceFileEntry`,`kind: "modified" | "read"`)——rail 顶部分「changed / read」两节列这个。`modified` 计数还显示在折叠 toggle 的 badge 上。
2. **`browser`：单级目录浏览器**(`SessionWorkspaceBrowserResult`)——cwd 相对、一次只列一层；`entries[]`(`kind: "file" | "directory"`)、`parentPath` 供 `..` 上溯、点目录 `onBrowsePath` 下钻、搜索框 160ms 防抖 `onSearch` 全盘搜、`truncated` 截断提示。**这是「逐层浏览」模型，不是一次性 recursive 嵌套树**。
3. **`root` / `gitCheckout`**：工作区根路径 + 是否 git 检出（决定 session-diff 按钮可用性）。

**「触碰文件」的 modified/read 分类是网关服务端做的**(`src/gateway/server-methods/sessions-files.ts`):扫 session 消息里的 `toolcall`/`tooluse` 块，按工具名+args 归类——`read`→`read`、`write`/`edit`→`modified`、patch 工具（`addRawPatchFiles`/`addStructuredPatchFiles`)→`modified`(`sessions-files.ts:222-242`);per-session LRU cache(16)+ delta fold(≤1000 消息/1MB)。即 **agent 工具活动 → 网关记 touched files → 面板下次 list 时反映**，是纯被动反映，不推事件。

**对 #616 的直接含义**:
- 数据通路**不可复用**——`sessions.files.list/get` 不在我们 SDK（见文首版本断层）;#616 已定走控制面统一 files REST API(`GET .../files?root=workspace`,Docker getArchive 背书，与网关版本无关）。本调研证实这是**必然**而非可选。
- 形态差异：官方「触碰清单 + 单级浏览」≠ #616「recursive 全量嵌套树（对齐 files API `DirListing`)」。**recursive 树官方无对应物,WorkspaceTree 只能全新写**（基线 2/3 已钉）。
- 但「从工具调用 args 提取文件路径 + 分 read/modified 类」这一**思路**官方与我们 `tool-call-view.ts` 的 `resolveToolCallKind`/`resolveToolCallTargetPaths` 等价（我们只是做在 client 侧）——基线事件基础已覆盖。

## 问 2：官方 canvas / 文件预览的实现

**「文件预览」= chat 右侧 sidebar 的一块内容区，不是 tabs、不是 modal。** 入口 `openFile`(`chat-session-workspace.ts:453-598`):`sessions.files.get` 取全文 → 按 `file.previewKind`(`"text" | "image" | "unsupported"`,`api/types.ts:337`）分派成 `SidebarContent`(`kind: "image" | "markdown" | "file"`)→ `handleOpenSidebar(content)` 渲染。

- **组件结构 / 渲染**：文本文件产 `kind: "file"` 的 SidebarContent（带 `content`/`language`/`line`/`hash`/`root`)。**可编辑时**用 **CodeMirror 6** 渲染(`ui/src/pages/chat/components/file-editor-view.ts:1-13` 引 `@codemirror/*` + `@lezer/highlight`)：语法高亮（`LanguageDescription` 按需加载）、行号、history、CRLF 原样保留（`detectLineSeparator`)。**这是重依赖 + 语法高亮，与 #616「零新依赖、无语法高亮」基线(5）直接冲突。**
- **编辑（只读版用不上，备查）**：乐观并发 CAS——`file.hash`(sha256）作 `expectedHash` 调 `sessions.files.set`，冲突返 `session_file_conflict`（带 `currentHash`)→ `fetchLatest` 重载(`chat-session-workspace.ts:504-576`)；还要 `isGatewayMethodAdvertised("sessions.files.set")` + operator admin。编辑门 `canEdit` 含 `hasUniformLineEndings`。
- **触发方式**:**手动**。两类入口（`chat-pane-render.ts:483-484` 接线）：① 点 workspace rail 的文件行/眼睛图标；② 点 chat 消息里的文件链接（`onOpenWorkspaceFile` / `onRevealWorkspaceFile`，后者顺带把 browser 定位到该文件所在目录，`chat-session-workspace.ts:698-709`)。**官方没有「工具事件自动弹出文件」的联动**——这是与 #616 核心交互的本质差异（见问 4)。
- **另一套 preview**:`ui/src/components/file-preview-modal.ts` 是 **agents files 页**(`ui/src/pages/agents/files.ts`，走 `agents.files.get/set` RPC）用的**只读 modal**：吃一个 plain `files: {path,size,contents}[]` 数组，搜索 + 详情 + copy 按钮，**不用 CodeMirror**。与 chat workspace 是两套独立实现，且 `agents.files.*` 同样不在我们 SDK。
- **「canvas」在 openclaw 是另一个东西，与文件预览无关**:① A2UI 生成式 UI widget 面——`canvas-widget-frame-generation.ts`（连接代际计数，帧在连接边界重建）、`app/canvas-surface-lease.runtime.ts`(surface 租约）、`components/mascot-canvas.ts`;② history 里 `type:"canvas"` 的附件预览（`message-normalizer.ts:97-118,368,412`，依赖共享层 `../../../../src/chat/canvas-render.js`)。**两者都是「agent 生成画布」，不是「文件内容预览」，对 #616 无可抄性**——`558:107` 判 canvas「不做」在此依然成立。

## 问 3：官方 session-diff 面板：diff 数据来源与渲染

- **数据来源**:gateway `sessions.diff` RPC → `SessionsDiffResult`(`packages/gateway-protocol`，面板 import 于 `session-diff-panel.ts:6-9`):`{ baseRef, branch, root, additions, deletions, files: SessionDiffFile[], unavailableReason?, truncated? }`；每文件 `SessionDiffFile { path, oldPath?, status: added|deleted|renamed|modified, patch?, binary?, untracked?, additions, deletions }`。
- **本质 = git 工作树 diff，服务端跑 git CLI**(`src/sessions/session-diff.ts`):`runGit(cwd, [...])` 执行 `git diff --name-status/--numstat/--patch -z -M`，把多文件 `diff --git` 输出拆成 per-file chunk，处理 rename/binary(`Binary files ... differ`);并对 **session-start baseline** 过滤（`session-create-diff-baseline.ts`/`session-diff-baseline.ts` 配套）。前提：workspace 是 git 检出（否则 `unavailableReason: "not_git"`)+ 宿主有 git。面板注释自述:「renders the sessions.diff RPC result (branch + working-tree changes per file)」。
- **渲染**(`session-diff-panel.ts`,Lit):caller 供 `loader: () => Promise<SessionsDiffResult>`(`@lit/task` 驱动，refresh 重跑）→ 每文件 `parseSessionDiffPatch(file.patch, formatGap)` 把 unified patch 解析成 `DiffLine[]`,**hunk 间隙插「N unmodified lines」skip 行**(`session-diff.ts:22-74`)→ 共享叶子渲染器 `renderDiffBlock` + `renderDiffStatChips`(`chat-diff-render.ts:19-61`,add/del/ctx/skip + gutter 行号 + 行级底色）逐行渲染；per-file 可折叠 section,binary/tooLarge/truncated 各有占位文案。
- **触发**:rail header 的 diff toggle(fileDiff 图标），仅当 `isGatewayMethodAdvertised("sessions.diff")` 才挂 `onOpenDiff`(`chat-session-workspace.ts:819-822`)，点开 `kind: "session-diff"` 的 sidebar，其 `load` 每次重取 `sessions.diff`(`buildSessionDiffSidebarContent`)。
- **形态判断**：这是「**整个 session 的 git 总 diff 面板**」,**不是** #616 要的「逐工具调用、随事件流实时弹出的单文件 tab + 修改行高亮」。且它依赖 git 检出 + baseline + 新 RPC，三样我们都缺。**整体不抄**（见问 4)。

## 问 4：可抄写 vs 必须自建

### 可抄写（纯 TS、0/轻依赖，呼应 #555 最小抄写集模式）

| 项 | 文件 | 依据 | 移植方式 |
|---|---|---|---|
| unified patch → `DiffLine[]` 解析 | `ui/src/lib/chat/session-diff.ts`(`parseSessionDiffPatch`) | 0 import（仅 `import type { DiffLine } from "./tool-call-diff.ts"`);hunk 间隙插 skip、截断标记 | **可直接抄**,Vue 侧接渲染 |
| LCS 行 diff / diff 详情解析 / write 预览 | `ui/src/lib/chat/tool-call-diff.ts` | #555 已判真 0 依赖可抄（最小抄写集 4 文件之一） | #616 事件基础已计划用 |
| 「unified patch → 行级 DiffLine(add/del/ctx/skip + 行号 gutter + 行级底色)」渲染模型 | `chat-diff-render.ts` 的思路 | 渲染是 Lit,**模型可抄** | Vue 重实现渲染层（零依赖） |
| 「从工具 args 提取路径 + 分 read/modified」 | 网关 `sessions-files.ts` 的思路 | 与我们 `tool-call-view.ts` 的 kind/target-paths 等价 | 已有，无需抄 |

### 必须自建（官方没有 / 对我们不可用）

| 项 | 原因 |
|---|---|
| **数据通路** | 官方全靠 `sessions.files.*`/`sessions.diff`/`artifacts.*` 新 RPC，我们 SDK 没有、部署网关也未必 advertise。#616 走控制面统一 files REST API——本调研证实**必然** |
| **recursive 嵌套文件树** | 官方只有「触碰清单 + 单级目录浏览」，无 recursive 树。`WorkspaceTree` 全新写（基线 2/3) |
| **右侧只读 tabs + 工具事件自动弹出 + 修改行高亮** | 官方是「被动清单 + 点击 sidebar 预览」,**无 auto-pop-on-tool-call 联动**。此交互官方根本没有，必须自建（基线 4/6) |
| **轻量只读查看器** | 官方文本查看器是 CodeMirror 6（重依赖+语法高亮）,与「零新依赖无语法高亮」基线（5）冲突。自建轻量组件 |
| **session-diff 整形态** | git 基线 diff 依赖 git 检出 + baseline + 新 RPC，对面板单容器过重。不抄 |

### 只能抄思路（Lit/共享层耦合，渲染层须 Vue 重写）

`session-diff-panel.ts` / `chat-diff-render.ts` / `file-editor-view.ts` / 整个 workspace rail(`chat-session-workspace.ts`）全是 Lit `html` 模板，且后者依赖 settings/i18n/operator-access/`sessions` 能力 wrapper。**解析与 diff 逻辑（纯 TS）可平移，渲染层全部 Vue 重写**——与 #558 维度 4「官方核心逻辑几乎不碰 Lit，摩擦只在接组件渲染一层」结论一致。

---

## 结论（一句话）

官方**有**这套面板，但其数据通路（`sessions.files.*`/`sessions.diff`/`artifacts.*` 新 gateway RPC）**对我们钉死的 SDK `2026.7.2-beta.6` 完全不可用**，其交互（被动清单 + 点击预览 + 整 session git diff)**也没有 #616 要的「recursive 树 + 工具事件自动弹只读 tab + 行级高亮」**。因此 #616 的「数据走 files REST API、WorkspaceTree/查看器/tabs 全新写」基线全部成立且被本调研佐证为必然；**真正可从官方抄的只有两块纯 TS**:`session-diff.ts` 的 unified-patch→DiffLine 解析，与 `tool-call-diff.ts` 的 LCS 行 diff(#555 已纳入最小抄写集）——外加「行级 DiffLine 渲染模型」的思路。canvas(A2UI 生成画布）与文件预览无关，`558:107` 的「不做」判断维持。

## 附：证据索引

**官方（openclaw/openclaw @ main `686294f9`)**
- 文件面板：`ui/src/pages/chat/components/chat-session-workspace.ts`(`:453-598` openFile/预览、`:504-576` CAS 编辑、`:698-709` reveal、`:819-840` diff loader、`:941-1393` rail 渲染）、`ui/src/pages/chat/chat-pane-render.ts:483-484`（手动触发接线）
- 数据类型：`ui/src/api/types.ts:324-396`(`SessionWorkspaceFileEntry`/`Browser`/`List`/`Get`/`Set`)、RPC 名 `src/gateway/methods/core-descriptors.ts:180-187,398`(`sessions.files.list/get/set/reveal`、`artifacts.*`、`sessions.diff`)
- touched-files 分类（服务端）:`src/gateway/server-methods/sessions-files.ts:222-242`
- 文件查看器：`ui/src/pages/chat/components/file-editor-view.ts:1-13`(CodeMirror 6);只读 modal `ui/src/components/file-preview-modal.ts` + agents 页 `ui/src/pages/agents/files.ts`(`agents.files.get/set`)
- session-diff:`ui/src/lib/chat/session-diff.ts:22-74`(patch 解析）、`ui/src/pages/chat/components/session-diff-panel.ts`(panel)、`ui/src/pages/chat/components/chat-diff-render.ts:19-61`（行渲染）、服务端 git `src/sessions/session-diff.ts:32-181`
- 能力门控：`ui/src/lib/gateway-methods.ts:6-19`(hello `features.methods[]`)
- canvas(A2UI，非文件预览）:`ui/src/lib/chat/canvas-widget-frame-generation.ts`、`ui/src/app/canvas-surface-lease.runtime.ts`、`ui/src/lib/chat/message-normalizer.ts:97-118`

**我们（本仓）**
- SDK 版本断层：`frontend/node_modules/@openclaw/gateway-client@2026.7.2-beta.6/dist/*` grep `sessions.files/diff`/`artifacts`/`listFiles` 命中 0;`gateway-protocol/dist` 仅 `SessionsDiff` 类型残留
- 既有结论：`docs/research/558-official-ui-study.md:107`(session-diff/canvas「不做」)、`555-official-tool-call-files.md`(tool-call-diff 可抄）
- #616 数据/事件基础：统一 files API `GET /api/v1/containers/<name>/files?root=workspace`、`frontend/src/chat/toolRender/tool-call-view.ts`

> **置信度**：高。全部结论基于官方当前 main 一手源码（2026-08-11 抓取）。唯一未验证项：我们**部署的** OpenClaw 容器网关是否在 hello 里 advertise `sessions.files.*`/`sessions.diff`——本机无网关运行时（见 memory `local-env-no-gateway-runtime`)，需真环境核；但即便 advertise,SDK 无 helper，也得走裸 `client.request`，且交互形态差异（问 4）不受影响。
</content>
