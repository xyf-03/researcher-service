// useChatConnection —— 对话连接 composable（#316 候选 B / #340 首个 composable 先例）。
// 关键约束：连接生命周期 × runId 路由 × 消息投影共享的**非响应式簇**必须同宿主——本 composable
// 闭包持有 gateway/定时器/runId 集/请求代（containerGen/historyGen），ws 帧经 handle* 直译成
// chatStore 纯 mutation；响应式投影（messages/approvals/sessions/…）归 chatStore。
// 视图专属态（connecting/disconnected/errorMsg）经 onStatus 回调上抛，本 composable 不持有。
import { computed, ref } from 'vue'
import { getBootstrapToken } from '@/api/chat'
import { useAuthStore, isTokenExpired } from '@/stores/auth'
import { useChatStore, newMsg, type Msg, type ApprovalItem, type ToolRow } from '@/stores/chat'
import { useFileTabsStore } from '@/stores/fileTabs'
import { ApiError, apiFetch } from '@/api/client'
import {
  createGatewayChat,
  createRequestId,
  type GatewayChat,
  type SessionDTO,
  type HistoryMessageDTO,
  type ChatFrame,
} from '@/chat/gatewayChat'
import { splitThinking } from '@/chat/thinking'
import { extractMessageAttachments, extractMessageText, extractThinking, attachmentToMediaBlock, type MediaBlock } from '@/chat/eventTranslate'
import type { Attachment } from '@/chat/attachments'
import { createOutboxStore } from '@/chat/outboxStore'
import { WS_AUTH_FAIL, WS_MUST_CHANGE_PASSWORD, WS_CONTAINER_ACCESS_DENIED, WS_GATEWAY_UNAVAILABLE } from '@/chat/closeCodes'

// T07 斜杠命令选项（ChatComposer 菜单渲染 props；单一来源计算在 useChatConnection）
export interface SlashOption {
  alias: string // 展示/填入的精确斜杠别名（含前导 /）
  description: string
}

// 视图专属态（ChatView 注入）：connecting/errorMsg 本属页面展示，非消息投影；disconnected 属
// 连接生命周期（composable 内部 ref，模板经返回的 disconnected 读取）。
export interface ChatStatus {
  onConnecting(v: boolean): void
  onError(message: string): void
  onClearError(): void
  // #459-T2 #463 #1：宿主接管的统一发送入口（含附件校验/清空预览条）。提供后 Enter/斜杠发送改走
  // 它（与发送按钮同路径），缺省回退 composable 内 send（纯文本）——Enter 与按钮行为不再分叉。
  onSend?(): void
}

// B4/B5 定时器阈值（同原 ChatView 常量）
const PENDING_RUN_GRACE_MS = 8000
const RESUME_WAIT_MS = 30_000
const CONNECT_TIMEOUT_MS = 15_000
const INITIAL_HISTORY_LIMIT = 50

// Phase 2 图片显示修复：agent mediaUrls 的容器内 workspace 绝对路径前缀。与 server files/routes.ts
// FILE_ROOTS.workspace = ${HOME_BIND}/workspace = /home/node/.openclaw/workspace 严格对齐——以此前缀
// 开头的 MediaBlock.src 是「待 resolve 的容器媒体」（经受保护 files/raw 端点取字节→blob URL）；
// 其余（http/https/data:/blob:/base64 历史附件）原样透传。前缀由 server resolveWorkspaceAbsPath
// 二次复检（越界/穿越 → 90002），前端识别失败最坏为静默丢弃，不会误读任意容器文件。
const WORKSPACE_ABS_PREFIX = '/home/node/.openclaw/workspace/'

export function useChatConnection(status: ChatStatus) {
  const chat = useChatStore()
  const fileTabs = useFileTabsStore()
  const auth = useAuthStore()
  // #564: outbox 离线待发队列（sessionStorage 窄窗落盘）——「已点发送但网关还没回执」的消息
  // 刷新/重连后自动重发。工厂默认取全局 sessionStorage；scope = 容器+会话。
  const outbox = createOutboxStore()
  // Phase 2 图片显示修复：媒体 objectURL 生命周期管理。liveObjectUrls 追踪所有 fetchMediaObjectUrl
  // 创建的 objectURL（切会话/切容器/卸载时 revokeAllObjectUrls 统一释放，防泄漏——blob URL 在浏览器
  // 生命周期内不自动回收，不 revoke 每次会话图片都累积占用内存）。resolvedMediaPaths 按 runId 记录
  // 已挂载过的容器绝对路径（agent assistant 流可能多次携带相同 mediaUrls——每次文本增量重发→同图去重；
  // 记原始路径而非 blob URL，因每次 createObjectURL 生成的 URL 都不同、resolve 后无法比对去重）。
  // 生命周期与 liveObjectUrls 同界：revokeAllObjectUrls 一并清空（run 终态后可残留，reset 兜底有界）。
  const liveObjectUrls = new Set<string>()
  const resolvedMediaPaths = new Map<string, Set<string>>()

  // 连接生命周期态（本属连接簇）：意外断线禁用发送、提示重连（codex P2 #4）；onReady/onClose 维护
  const disconnected = ref(false)

  // ---- 非响应式连接簇（同宿主：本 composable 闭包）----
  let gateway: GatewayChat | null = null
  let disposed = false
  // runId 路由：仅当前 run 的增量写入回复；切会话/容器时把旧 run 标记 abandoned，丢弃其迟到帧（codex P2）
  let activeRunId = '' // 已收到首帧的当前 run
  const abandonedRunIds = new Set<string>() // 切换前遗留的 runId：迟到帧丢弃（codex P2 #3）
  // F7: 空闲期（无在途用户 send）观察到的外来自主 run 的 runId——其后（用户 send 后）的续帧/终态
  // 按 runId 丢弃，防止外来 run 在用户 send 后劫持 activeRunId、污染用户气泡/吞用户回复。终态清理。
  const foreignRunIds = new Set<string>()
  let pendingSend = false // 已 send 但首帧未到（runId 未知）
  // #53: 本 send 的 RPC ack 返回的 runId（官方 chat.send ackPayload={runId,status:"started"}）——
  // pendingSend 期间首帧归属判别信号：首帧 runId ≠ 本 run 时判定为外来/旧 run（切容器后旧连接在途
  // run 首帧经新连接到达的唯一判别方式；ack 未回/无 runId 时为空串，沿用旧行为）。
  let myRunId = '' // 本 send 的网关 runId（ack 返回）；'' = 未知/无 ack
  let pendingAbandonCount = 0 // 切会话时仍 pending 的 run 数；其迟到首帧按 FIFO 视为孤儿丢弃（codex P2 #3）
  // selectContainer 的请求代：丢弃切容器途中迟到的响应（codex P2）
  let containerGen = 0
  // codex #249 P2：loadHistory 的请求代。仅 containerGen+selectedSession 守卫拦不住「同一会话并发
  // 两次 loadHistory」（如断线重连 onReady 恢复时上一次历史请求仍在途）——两次守卫值相同、响应都被
  // 接受，后落地的快照 prepend 到先落地的已渲染历史上 → 转录重复/混杂。每次 loadHistory 自增并捕获
  // 请求代，只有最新一次才允许提交其快照，其余（被取代的在途请求）落地即丢弃。
  let historyGen = 0
  // #369：协议机内置重连（退避）；openGateway 用 everConnected 区分「首连等待就绪」（pendingConnect
  // resolve 供 selectContainer 续流程）与「重连成功恢复」（onReady 拉权威历史重建投影）。
  let everConnected = false
  let pendingConnect: ((ok: boolean) => void) | null = null
  // B3/B4: pendingSend 窗口收尾宽限——pendingSend && !activeRunId 期间收到无法匹配自己 run 的
  // error/done 时武装定时器：宽限内用户 run 首帧到达正常认领（复活占位），宽限过仍无首帧才落定占位
  // （防 B3 外来 done-first 终结用户空泡；防 B4 外来 error 清 flag 后用户 run 首帧被当 foreign）。
  // fire 时置 graceExpired（不保留 pendingSend）——慢 run 首帧 >宽限后仍走认领路径而非 foreign
  // （F8 定时器反噬修复），同时避免 fire 后残留 pendingSend 让切会话产生 phantom orphan 吞新 run。
  let pendingGraceTimer: ReturnType<typeof setTimeout> | null = null
  let graceExpired = false // B4: 宽限已 fire 仍无首帧——后续迟到的首帧仍认领（不 foreign）
  // B5: 意外断线时在途 run 的恢复信息——网关重连可能 resume 同一 run 补发续帧（session projection）。
  // onReady 消费：保留占位等待续帧（不 loadHistory 清空重建）；续帧到达 / 用户主动操作即取消。
  let resumeRun: { runId: string } | null = null
  let resumeTimer: ReturnType<typeof setTimeout> | null = null

  function armPendingGrace() {
    if (pendingGraceTimer !== null) return
    pendingGraceTimer = setTimeout(() => {
      pendingGraceTimer = null
      if (pendingSend && !activeRunId) {
        chat.finalizeLast() // 占位落定（防永久 streaming 锁死 composer）
        graceExpired = true // 迟到首帧仍可认领；pendingSend 清（切会话不产生 phantom orphan）
        pendingSend = false
        myRunId = '' // #53: 宽限 fire 放弃本 run 的 ack runId
      }
    }, PENDING_RUN_GRACE_MS)
  }
  function clearPendingGraceTimer() {
    if (pendingGraceTimer !== null) {
      clearTimeout(pendingGraceTimer)
      pendingGraceTimer = null
    }
  }
  function armResumeWait(run: { runId: string }) {
    if (resumeTimer !== null) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      // 窗口内无 resume 续帧（续帧到达会在 handleText/handleTool 取消本 timer）→ run 已死，
      // 恢复为历史重建（清占位与残留投影）。
      if (!disposed && activeRunId === run.runId && chat.selectedSession) {
        resumeRun = null
        // R4-6（第四轮）：清 activeRunId——否则残留死 runId 让 loadHistory 重建后，迟到的续帧命中
        // activeRunId===runId 通过 claimRun，append 进历史 assistant 消息（污染）；且后续自主 run 首帧
        // 命中 activeRunId 不同于自身 + claimedEmpty=false 被屏蔽。
        activeRunId = ''
        void loadHistory(chat.selectedSession)
      }
    }, RESUME_WAIT_MS)
  }
  function clearResumeWait() {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    resumeRun = null
  }

  // 收尾最后一条 streaming 助手消息（done/error/关闭时）
  function finalizeLast() {
    const last = chat.messages[chat.messages.length - 1]
    if (last && last.streaming) {
      last.streaming = false
      last.thinkingOpen = false // 断流时 <thinking> 未闭合也落定：text/thinking 已是剥离结果，思考保留在折叠卡
      // issue #238（评审 #198 Low 5.3）：终态对 raw 做一次最终 splitThinking 重解析——流式中
      // 被隐藏的半截 `<thi…` 残片按普通文本放回正文（终态无「下帧补齐」可言，残片不应被永久吞掉）；
      // 未闭合 <thinking> 内容仍留思考（标签不泄露正文）。
      const parts = splitThinking(last.raw, { terminal: true })
      last.text = parts.text
      // #565: terminal 重解析只作用于内联 <thinking> 标签路；结构化 thinking 块（content[] 提取，
      // handleText 以 ?? 覆盖写入）在 raw 无内联标签时被空内联结果冲掉（思考卡消失）——内联结果
      // 非空仍覆盖（混合场景同源，方向差异无碍），为空保留结构化产物。
      last.thinking = parts.thinking || last.thinking
    }
  }

  // ---- 渲染帧处理（runId 路由 / 消息投影 / 审批卡 / 工具行）----
  // P2-3（code review）：run-claim 单一助手——handleText/handleTool 共用（原两处 ~37 行逐行复制，
  // 漂移会静默吞用户回复；如 claimedEmpty 判定一处改动另一处不随）。
  // 返回 true = 本帧应继续渲染（已认领 activeRunId / 已是当前 run）；false = 本帧应丢弃
  // （abandoned/foreign/孤儿计数）。
  // P1-4（code review）+ R4-8（第四轮）：B2 claimedEmpty 用「渲染可见正文/思考」判定——半截
  // <thinking 残片（splitThinking 实测 {text:'',thinking:'',inThinking:false} 视觉空白但 raw!==''）
  // 不阻挡切换认领。**不要求 tools.length===0**：工具优先的外来 run 首帧（agent 先调工具再回复，
  // 常见）会在占位留 tool 行，若把 tool 行当内容占用，用户 run 首帧的切换认领被拒 → 回复被静默吞。
  // tool 行不是「回复正文」，不算占位已被占用。
  function claimRun(runId: string): boolean {
    if (abandonedRunIds.has(runId)) return false // 切换前遗留 run 的帧：丢弃
    if (foreignRunIds.has(runId)) return false // #53: 已判定外来/旧 run 的续帧：丢弃（含 B2 切换认领前）
    if (activeRunId && runId !== activeRunId) {
      // B2: 已认领 run 但占位仍无可见正文（先到者可能是同会话自主 run 的预热/status 首帧）→
      // 切换认领到后到 run（更像用户 send 触发的 run），防用户回复被静默丢弃（原代码直接 return）。
      const last = chat.messages[chat.messages.length - 1]
      const claimedEmpty = Boolean(
        last &&
          last.role === 'assistant' &&
          last.text === '' && // P1-4: 渲染可见正文（splitThinking 剥离后空）
          last.thinking === '',
      )
      if (claimedEmpty) {
        foreignRunIds.add(activeRunId) // 先到空 run 降级为外来
        activeRunId = runId
        clearPendingGraceTimer()
        clearResumeWait()
      } else {
        return false // 仅当前 run 的帧写入回复
      }
    }
    if (!activeRunId) {
      // 首帧到达：若属于切会话时仍 pending 的孤儿 run（FIFO 先到）→ 标记 abandoned 丢弃（codex P2 #3）
      if (pendingAbandonCount > 0) {
        pendingAbandonCount--
        abandonedRunIds.add(runId)
        return false
      }
      // #53: pendingSend 期间本 run ack 已知（myRunId）且首帧 runId 非本 run → 外来/旧 run 首帧
      //（切容器后旧连接在途 run 首帧经新连接到达，runId 不在 abandonedRunIds——切走时首帧未到）
      // 丢弃，不抢占 activeRunId（否则用户 run 首帧因 claimedEmpty=false 被静默丢弃）。
      if (pendingSend && myRunId && runId !== myRunId) {
        foreignRunIds.add(runId) // 记外来 run：其续帧/终态按 runId 过滤
        return false
      }
      // B4: 宽限已 fire（graceExpired）后迟到的用户 run 首帧——pendingSend 已清，但仍认领不 foreign
      const lateClaim = !pendingSend && graceExpired
      // F7: 空闲（无在途用户 send 且非迟到认领）时的首帧——外来自主 run 不认领：记录其 runId 供
      // 后续帧过滤（用户 send 后其续帧按 runId 丢弃，防劫持 activeRunId / 污染用户气泡 / 吞回复）。
      if (!pendingSend && !lateClaim) {
        foreignRunIds.add(runId)
        return false
      }
      // F7: 空闲期已观察到的外来 run 的续帧（用户 send 后到达）——丢弃，不抢占 activeRunId
      if (foreignRunIds.has(runId)) return false
      clearPendingGraceTimer() // B3/B4: 在途 error/done 的延迟收尾取消——首帧已到，本 run 正常
      clearResumeWait() // B5: resume 等待期间收到本 run 首帧 → 续帧已到，取消超时重建
      if (lateClaim) graceExpired = false
      activeRunId = runId
      pendingSend = false
      myRunId = '' // #53: 首帧已认领，归属判别信号不再需要
      // B4: 占位可能已被宽限 finalize（streaming=false）——认领后复活占位继续追加（慢 run 首帧
      // >宽限后仍正常渲染，而非被当作 foreign 丢弃）。
      const ph = chat.messages[chat.messages.length - 1]
      if (ph && ph.role === 'assistant' && !ph.streaming) ph.streaming = true
    }
    return true
  }

  // 增量文本：chat.delta 事件（deltaText 追加；replace 快照整段替换）。thinking 剥离纯函数无跨帧态。
  // #565: thinking?: string | null —— 结构化 thinking 块（replace 快照/final 的 content[]，翻译层
  // 提取随帧携带）。合并规则按帧类型分：
  //  - 带 thinking 字段的帧（replace 快照 / final tail-replace）：帧为权威——非 null 覆盖内联剥离
  //    结果（结构化块权威，防双路拼接翻倍）、null 走内联路（该权威快照无结构化块）；
  //  - delta 增量帧（thinking=undefined，增量是纯文本串无 content[]）：只更新内联路——内联结果
  //    非空覆盖（<thinking> 标签增量），为空保留上一帧值（结构化思考跨帧存活，对齐内联标签靠
  //    raw 累积跨帧存活的持久性——否则 replace 快照带的思考会被下一普通增量帧清空）。
  function handleText(runId: string, delta: string, replace?: boolean, thinking?: string | null) {
    if (!claimRun(runId)) return
    const last = chat.messages[chat.messages.length - 1]
    // B5: 追加条件放宽到 activeRunId===runId（本 run 帧）——断线 onClose 已 finalizeLast 落定占位
    //（streaming=false），resume 续帧到达时若只认 streaming 会丢帧；本 run 帧允许复活占位继续追加。
    if (last && last.role === 'assistant' && (last.streaming || activeRunId === runId)) {
      if (!last.streaming) last.streaming = true // 复活（B4 宽限 fire / B5 断线落定后）
      clearResumeWait() // B5: resume 续帧到达 → 取消超时重建（否则 30s 后误触发 loadHistory 打断）
      // T08 思考链剥离（spec §8.3 (a) / r26 §4）：思考以 <thinking> 标签内联在 text 增量里 →
      // 累积原始串 raw，再整体重解析拆出 thinking/text（replace 快照与 delta 追加统一走重解析）
      last.raw = replace ? delta : last.raw + delta
      const parts = splitThinking(last.raw)
      last.thinking =
        thinking !== undefined ? (thinking ?? parts.thinking) : (parts.thinking || last.thinking)
      last.thinkingOpen = parts.inThinking
      last.text = parts.text
    }
  }

  // #459-T3 #464：附件媒体帧——final/delta(replace) 消息 content 含 image/audio/video 块时
  // 写入当前 assistant 消息的 media（与 handleText 同款 runId 路由/锚定语义：claimRun 守卫
  // abandoned/foreign/孤儿；append 条件放宽到 activeRunId===runId 防断线 finalize 后 resume 丢帧）。
  // 纯媒体 run（无文本）的首帧即媒体 → 同样走 claimRun 认领占位，媒体 append 进占位气泡。
  function handleAttachment(runId: string, media: MediaBlock[]) {
    if (!claimRun(runId)) return
    const last = chat.messages[chat.messages.length - 1]
    if (last && last.role === 'assistant' && (last.streaming || activeRunId === runId)) {
      clearResumeWait() // B5: 本 run 媒体续帧到达 → 取消 resume 超时重建（同 handleText）
      last.media.push(...media)
    }
  }

  // Phase 2 图片显示修复：attachment 帧媒体源为容器内 workspace 绝对路径（agent assistant 流
  // mediaUrls，经 eventTranslate 转 MediaBlock，如 /home/node/.openclaw/workspace/test.png）→ 经受
  // 保护 files/raw 端点（apiFetch 带 JWT + 401 刷新链）取原始字节 → blob → objectURL 回填 src 后再
  // handleAttachment 挂 store。原因：<img> 直连容器路径带不了 Authorization header，且不能直接 <img
  // src="http://.../files/raw">（401 拒绝）；blob URL 是浏览器端标准消费形态。非容器路径
  // （http/https/data:/blob:/base64 历史附件）原样透传，不动既有图片/音频/视频/文档附件路径。
  // 失败/无权限/非白名单扩展名 → 静默丢弃该块（0 信任，不占位符、不报错打断会话）。
  // gen/session 守卫：await 期间切会话/容器则丢弃过期 resolve（对齐 loadHistory stale 守卫语义）。
  // 防重：同 run 已挂载过的容器路径（agent 增量重发 mediaUrls）跳过，避免同图重复渲染。
  async function resolveAttachment(runId: string, media: MediaBlock[]): Promise<void> {
    const gen = containerGen
    const sessionKey = chat.selectedSession
    const container = chat.selectedContainer
    if (!container || !sessionKey) return
    let seen = resolvedMediaPaths.get(runId)
    if (!seen) {
      seen = new Set()
      resolvedMediaPaths.set(runId, seen)
    }
    const resolved: MediaBlock[] = []
    for (const m of media) {
      if (!m.src.startsWith(WORKSPACE_ABS_PREFIX)) {
        resolved.push(m) // 非容器媒体：原样透传（base64/http/data:/blob: 历史附件、发送 echo）
        continue
      }
      if (seen.has(m.src)) continue // 已挂载过该路径：agent 重发去重
      const url = await fetchMediaObjectUrl(container, m.src)
      if (url) {
        seen.add(m.src)
        resolved.push({ ...m, src: url })
      }
    }
    if (gen !== containerGen || chat.selectedSession !== sessionKey) return // 切走了：丢弃过期 resolve
    if (resolved.length === 0) return
    handleAttachment(runId, resolved) // claimRun 守卫在内部二次确认（abandoned/foreign/孤儿）
  }

  // 经 files/raw 端点取容器内 workspace 图片字节 → blob → objectURL。任何失败（网络/校验 90002/
  // 越权 20040/不存在 60040/未知扩展名）→ null（消费端静默丢弃该媒体块）。objectURL 记入
  // liveObjectUrls，随 revokeAllObjectUrls（reset/dispose）统一释放。
  async function fetchMediaObjectUrl(container: string, absPath: string): Promise<string | null> {
    try {
      const resp = await apiFetch(`/api/v1/containers/${container}/files/raw?path=${encodeURIComponent(absPath)}`)
      if (!resp.ok) return null
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      liveObjectUrls.add(url)
      return url
    } catch {
      return null // 0 信任：任何异常静默丢弃（不打断会话、不占位符）
    }
  }

  // 释放全部已追踪 objectURL + 防重记录（切会话/切容器/卸载前调用——消息投影即将清空，objectURL
  // 无消费者，浏览器端可安全 revoke）。与 chatStore reset 调用点成对出现。
  function revokeAllObjectUrls(): void {
    for (const url of liveObjectUrls) URL.revokeObjectURL(url)
    liveObjectUrls.clear()
    resolvedMediaPaths.clear()
  }

  // #565: done 帧可携带 thinking——final 相等/thinking-only 场景（翻译层未产 text 帧）的结构化
  // 思考经独立通道到达。写入时机 = finalizeLast 之前（terminal 重解析为空时经 || 保留该值；
  // 非空时内联路终态结果优先，混合场景二者大概率同源，覆盖方向差异无视觉影响）。
  // #569: message?: unknown —— 外来 run 可见 final 的权威消息本体（done 帧扩展携带，来源 #560
  // currentRun.message）。仅 foreignRunIds 分支消费（局部插入）；本 run/abandoned/孤儿分支不读，
  // 沿用既有终态逻辑。
  function handleDone(runId: string, thinking?: string | null, message?: unknown) {
    if (abandonedRunIds.has(runId)) {
      abandonedRunIds.delete(runId)
      return
    }
    if (foreignRunIds.has(runId)) {
      foreignRunIds.delete(runId) // F7: 外来 run 终态：清理记录
      // #569: 外来可见 final 局部插入 history（对齐官方 #1909，非整段重拉）——可见 final 的权威
      // message 经 translateHistoryMessage 转 Msg 局部插入一条助手消息，不调 loadHistory（不打断
      // 在途占位/滚动位置/historyGen 竞争）。「可见」= 提取后有实质内容（text/media/tools 非空）；
      // 空 final（无内容）维持丢弃。去重 = 翻译层 #560 isReplayedFinal 重放网（同一外来 run 的
      // final 二次到达不产 done 帧）+ 本分支终态清理的天然一次性（同一 runId 不会二次进入）。
      // 不触碰 activeRunId/pendingSend/resumeRun——外来 final 与在途 turn 并存（纯追加一条）。
      // 在途（activeRunId 非空，占位在尾部）时插到占位之前：「尾部 = 在途气泡」是 handleText/
      // handleAttachment 续帧 append 的锚定不变量，外来消息尾部 push 会被后续续帧（activeRunId
      // ===runId 放行 streaming=false）污染（B5 断线落定占位同理）；空闲/终态走尾部 push。
      if (message) {
        const msg = translateHistoryMessage(message as HistoryMessageDTO) // 薄适配：与历史消息同构
        if (msg.text !== '' || msg.media.length > 0 || msg.tools.length > 0) {
          if (activeRunId) chat.insertBeforeLast(msg)
          else chat.pushMessage(msg)
        }
      }
      return
    }
    if (activeRunId && runId !== activeRunId) return
    if (activeRunId === runId) {
      if (thinking !== undefined && thinking !== null) {
        const last = chat.messages[chat.messages.length - 1]
        if (last && last.role === 'assistant') last.thinking = thinking
      }
      finalizeLast()
      activeRunId = ''
      clearResumeWait() // B5: run 正常终态，resume 无需继续
      return
    }
    // activeRunId 空：run 首帧即终态（无 delta）
    if (pendingAbandonCount > 0) {
      pendingAbandonCount--
      return // 孤儿 run 终态：计数丢弃
    }
    if (pendingSend) {
      // B3: 无 delta 外来 run 的 done-first 不立即终结用户空 placeholder/清 pendingSend（原代码
      // 直接 finalize——外来 run 首帧即终态会吞掉用户回复、placeholder 空终结）。武装宽限：
      // 宽限内用户 run 首帧到达正常认领，宽限过仍无动静才落定占位。
      armPendingGrace()
      return
    }
  }

  function handleError(message: string, runId?: string) {
    // codex R3 P2：通用连接错误 → 恢复所有 resolving 卡（协议 v4 chat.error 不带 approvalId；
    // 审批 resolve 失败经 RPC catch 按 id 复位，见 resolveApproval）
    chat.recoverPendingApprovals()
    // 消费者级错误（无 runId，如「会话不存在」）照常显示；run 级错误按 runId 过滤
    if (runId) {
      if (abandonedRunIds.has(runId)) {
        abandonedRunIds.delete(runId)
        return
      }
      if (foreignRunIds.has(runId)) {
        foreignRunIds.delete(runId) // F7: 外来 run error 终态：清理记录，不终结占位
        return
      }
      if (activeRunId && runId !== activeRunId) return
      if (!activeRunId) {
        // 切会话孤儿 run（首帧未到）的 error：计数丢弃（同 handleDone 的孤儿 done）
        if (pendingAbandonCount > 0) {
          pendingAbandonCount--
          return
        }
        // B3/B4: 无在途 activeRunId——不终结占位/清 flag：
        //  - 空闲（!pendingSend）：外来/自主 run 的 error，不动当前占位（防误伤）
        //  - 在途（pendingSend）：可能是本 run 失败也可能是外来 run；只显示错误，宽限内无首帧
        //    才落定占位（防外来 error 清 flag 后用户 run 首帧被静默丢弃）。fire 时保留 pendingSend，
        //    慢 run 首帧 >宽限后仍走认领路径而非 foreign（F8 定时器反噬修复）。
        if (!pendingSend) return
        status.onError(message)
        status.onConnecting(false)
        armPendingGrace()
        return
      }
      // activeRunId === runId：在途 run 失败 → 收尾占位 + 清 flag
      status.onError(message)
      status.onConnecting(false)
      finalizeLast()
      activeRunId = ''
      clearResumeWait() // B5: run 失败终态，resume 无需继续
      return
    }
    // 消费者级错误（无 runId，如「会话不存在」/连接级故障）：照常显示。
    // #14（第四轮）：终结在途占位 + 清 activeRunId/pendingSend 是**可辩护行为**——会话级错误意味着
    // 该会话/连接已坏，在途 run 不应再有续帧（网关不会在会话错误后继续推流）。即便随后有迟到帧，
    // 因 activeRunId 已清会被 claimRun 当 foreign 丢弃，是安全降级而非回复丢失。保留行为。
    status.onError(message)
    status.onConnecting(false)
    finalizeLast()
    activeRunId = ''
    pendingSend = false
    clearResumeWait() // B5: 消费者级错误（如会话不存在）→ 放弃 resume 等待
  }

  function handleApproval(card: {
    id: string
    kind: string
    command: string
    sessionKey: string | null
    agentId: string | null // #405-T1：发起方 agentId（frame 直通 addApproval）
  }) {
    chat.addApproval(card)
  }

  function handleApprovalResolved(id: string, decision: string) {
    chat.resolveApproval(id, decision)
  }

  // T08 工具执行（issue #44 / spec §9.4）：工具挂在所属 chat run 内，带 runId。首帧可能是工具
  // （agent 先调工具再回复）→ 与 handleText 同款锚定当前 run（共用 claimRun 助手，P2-3）；
  // 按 name 聚合 start→result 渲染一行标题+状态。
  function handleTool(tool: { runId: string; name: string; state: 'running' | 'done' | 'error'; id: string | null; title: unknown; input: unknown; result: unknown }) {
    if (!claimRun(tool.runId)) return
    const last = chat.messages[chat.messages.length - 1]
    if (!last || last.role !== 'assistant') return
    clearResumeWait() // B5: 本 run 工具续帧到达 → 取消 resume 超时重建
    fileTabs.onToolEvent(tool) // #627 T2：drive 文件 tab（决议 A；自筛修改类 edit/write/apply_patch + 路径；历史不经此，决议 B）
    if (tool.state === 'running') {
      last.tools.push({ id: tool.id, name: tool.name, state: 'running', title: tool.title,
                        input: tool.input, result: tool.result })
      return
    }
    // running/error/done：优先按工具调用 id 配对；无 id 退 name 匹配最后一个 running 行
    for (let i = last.tools.length - 1; i >= 0; i--) {
      const row = last.tools[i]
      const match = tool.id ? row.id === tool.id : row.name === tool.name && row.state === 'running'
      if (match && row.state === 'running') {
        row.state = tool.state
        row.result = tool.result
        return
      }
    }
    last.tools.push({ id: tool.id, name: tool.name, state: tool.state, title: tool.title,
                      input: tool.input, result: tool.result })
  }

  // issue #240：refresh 确认失效（refreshExhausted，cookie 4xx）——清会话跳登录，复用 api/client.ts 既有语义
  // （瞬态失败不走这里）。跳到登录页后路由守卫 hydrate 会再次确认，用户重新登录。
  function redirectLogin() {
    auth.clearSession()
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.assign('/login')
    }
  }

  // issue #240：4401（access token 过期）断线的刷新重连链路——区别于普通断线的退避重连。
  // forceRefresh 换到新 token 后立即重建 gateway（socket 本身健康，只是凭证过期，无需退避）；
  // refresh 确认失效（refreshExhausted）→ 清会话跳登录，不再重连；瞬态失败（token 仍空）→ 显示
  // 错误留手动重连入口（协议机对 4401 决策 retry:false，不自动重连防死循环）。
  async function recoverUnauthorized() {
    await auth.forceRefresh()
    if (disposed) return
    if (auth.refreshExhausted) {
      redirectLogin()
      return
    }
    if (auth.token) {
      void openGateway() // 新 token 已就绪：同步重建（无退避，socket 本身健康仅凭证过期）
    } else if (!disposed) {
      status.onError('登录状态刷新失败，请重试')
    }
  }

  // F5: 会话列表 + 当前会话历史加载（B-直连下会话 CRUD 全走协议机 RPC）。首连成功、自动重连成功、
  // 手动重连成功都在 onReady 触发（统一路径）；带 name+gen 守卫丢弃切容器途中迟到的响应。
  // C1: 保留原选中会话——4401 重建 / 手动重连不把用户踢回 session[0]（仅当原会话已删除才回退首个）。
  // C2: 无论首连还是重连都恢复当前会话历史（首连瞬败后跨自动重连也能补拉，防「看似已连接」空 chat）。
  async function syncSessions(name: string, gen: number) {
    if (gen !== containerGen || chat.selectedContainer !== name || !gateway) return
    try {
      const list = await gateway.listSessions()
      if (gen !== containerGen || chat.selectedContainer !== name) return // 切容器途中迟到：丢弃
      const prev = chat.selectedSession
      chat.setSessions(Array.isArray(list) ? list : []) // 对网关输入 0 信任：非数组回退空列表
      if (prev && chat.sessions.some((s) => s.session_key === prev)) {
        chat.setSelectedSession(prev) // C1: 原会话仍在列表中 → 保留选中
      } else {
        chat.setSelectedSession(chat.sessions[0]?.session_key ?? '')
      }
      if (!chat.selectedSession) await newSession()
      if (gen !== containerGen) return // newSession 期间又切容器：不连
      if (!chat.selectedSession) return // 会话创建失败（newSession 已显示错误）：不加载历史
      // #564: 先 loadHistory 再重发 outbox 残留——历史铺底后乐观 echo 才排到正确位置，且内容级
      // 去重（§三.3）可识别「网关已受理但 ack 丢」的历史消息（防 UI 双条）。await 保证 resendOutbox
      // 看到的是历史铺底后的 messages（fire-and-forget 会让去重对比空列表、重发排在较新回复之后）。
      // loadHistory 内部 try/catch 不会 reject（401/错误各自收尾），await 安全。
      await loadHistory(chat.selectedSession)
      // resendOutbox 前重查守卫：await 期间切容器/断线则跳过（不重发错容器；断线由下次重连触发）。
      if (gen === containerGen && chat.selectedContainer === name && gateway && !disconnected.value) {
        resendOutbox(name, chat.selectedSession)
      }
      // B0: 补拉待处理审批（切页/断线期间网关 push 的 exec.approval.requested 收不到）——
      // 不补拉则 agent 卡在 exec 审批时前端无卡可回，agent 卡死被网关 stuck-session recovery
      // abort（生产实测）。chat.addApproval 幂等（按 id 去重），与实时 push 不冲突。
      void restorePendingApprovals(gen)
    } catch (e) {
      if (gen !== containerGen) return
      status.onConnecting(false) // 出错解除 connecting（composer 解禁后用户可重试）
      if (e instanceof ApiError && e.status === 401) return
      status.onError((e as Error).message)
    }
  }

  // B0: 补拉待处理审批卡（切页/断线恢复路径，见 syncSessions 调用点注释）。gen 守卫同
  // syncSessions：切容器途中迟到的响应丢弃（卡片不污染新容器）。listPendingApprovals 内部已
  // catch（网关不支持/超时静默降级），此处不抛错误条。
  async function restorePendingApprovals(gen: number) {
    if (gen !== containerGen || !gateway) return
    try {
      const cards = await gateway.listPendingApprovals()
      if (gen !== containerGen || !gateway) return // 切容器途中迟到：丢弃
      for (const c of cards) chat.addApproval(c)
    } catch {
      // 静默：实时 push 仍工作，不因补拉失败打扰用户
    }
  }

  // T07 斜杠命令：拉取当前容器命令清单（协议机就绪后 onReady 首连触发）；失败静默降级为空清单。
  // F12: 绑定容器名+代际——旧 gateway stop() flush reject 会走 catch 置空 commands，若发生在
  //（另一容器的）新命令已填充后即误清空；快速切容器时旧 gateway 在途响应也会覆盖新命令。
  async function loadCommands() {
    const name = chat.selectedContainer
    const gen = containerGen
    if (!gateway) return
    try {
      const list = await gateway.listCommands()
      if (name === chat.selectedContainer && gen === containerGen) chat.setCommands(list)
    } catch {
      if (name === chat.selectedContainer && gen === containerGen) chat.setCommands([])
    }
  }

  // 建连主体（token 就绪后调用）：取 bootstrap token → 建 GatewayChat → 协议机握手。
  // 返回连接是否就绪（首连 onReady/onClose/onError 决议）；4401 刷新重建 / 手动重连复用。
  async function openGateway(): Promise<boolean> {
    const name = chat.selectedContainer
    const gen = containerGen
    if (!name) return false
    // 先把当前引用置空再停旧 gateway：旧 gateway 的 onClose 触发时 gateway!==myGw（stale guard
    // 判定为旧连接），不报误断线（与 selectContainer 同款「先置空再停」模式）
    const oldGw = gateway
    gateway = null
    // F6: 替换前决议旧等待方——旧 openGateway 的 pendingConnect（await ready 挂起者）立即 resolve：
    // 旧 gateway.stop() 不触发 onClose（协议机未配 notifyStoppedClose）+ ChatView stale guard 也拦截
    // 旧连接回调，无任何 resolve 路径；不在这里决议会让并发 openGateway 的早调用者 await ready 永挂
    // （泄漏 async frame + 切容器续体死锁）。
    if (pendingConnect) {
      pendingConnect(false)
      pendingConnect = null
    }
    oldGw?.stop()
    status.onConnecting(true)
    disconnected.value = false
    status.onClearError()
    everConnected = false
    pendingConnect = null
    clearPendingGraceTimer() // B4: 建连代际切换清除延迟收尾定时器（防跨代 fire）
    clearResumeWait() // B5: 新连接是新 run 语境，旧连接在途 run 的 resume 等待作废
    pendingAbandonCount = 0 // B1: 新连接孤儿计数清零（防吞新 run 首帧；切容器/4401重建/手动重连同路径）
    myRunId = '' // #53: 新连接生命周期边界，本 run 的 ack runId 作废
    graceExpired = false // #11（第四轮）：宽限过期标记是 run 语境，连接边界复位——防重连后首个自主 run 被 lateClaim 认领进旧占位
    // 协议机首连须 bootstrap auth（ADR 事实 2）；归属门/不存在 → 20040（前端显示容器不可访问）。
    // 信封错误（HTTP 200 + code）经 apiJson 抛 ApiError(code)——status 分支不再需要（P0 code review）。
    let bootstrapToken: string
    try {
      bootstrapToken = await getBootstrapToken(name)
    } catch (e) {
      if (gen !== containerGen || disposed) return false
      status.onConnecting(false)
      // #492：建连失败须恢复断开态——openGateway 开头无条件 disconnected=false（假定会连上），
      // 失败出口不复位会让 UI 假活（断线条消失、审批/发送按钮可点）但 gateway 为 null，
      // resolveApproval/send 静默 no-op → 「点击无响应」。onReady 成功路径会再置 false。
      disconnected.value = true
      if (e instanceof ApiError && (e.status === 401 || e.code === 10001)) return false
      if (e instanceof ApiError && e.code === 20040) {
        status.onError('容器不可访问，请切换容器')
        return false
      }
      // #13：容器非 running（creating/stopped/removing）——bootstrap-token 前置门，给清晰文案而非
      // 陷入隧道 4402 退避循环后显示通用「连接失败」。
      if (e instanceof ApiError && e.code === 20046) {
        status.onError('容器未运行，请启动后再对话')
        return false
      }
      status.onError((e as Error).message)
      return false
    }
    if (gen !== containerGen || disposed) return false
    const ready = new Promise<boolean>((resolve) => {
      pendingConnect = resolve
    })
    const myGw = createGatewayChat({
      container: name,
      jwt: auth.token!,
      bootstrapToken,
      handlers: {
        // 协议机完成 v4 握手（hello-ok）——首连与自动重连成功都会触发。首连：resolve 连接就绪 +
        // 拉命令清单；重连：以权威历史恢复投影（断线期间在途 run 已 abandoned 丢弃迟到帧）。
        onReady: () => {
          if (gateway !== myGw) return // stale guard：切容器后旧 gateway 回调不污染新会话
          status.onConnecting(false)
          disconnected.value = false
          status.onClearError()
          // #11（第四轮）：宽限过期标记是 run 语境，重连（新连接生命周期边界）复位——协议机自动重连
          // 走此路径（非 openGateway），不重置会让重连后首个自主 run 被 lateClaim（!pendingSend &&
          // graceExpired）认领进历史 assistant 占位。
          graceExpired = false
          if (everConnected) {
            // 自动重连成功：B5 若断线时在途 run 需 resume → 保留占位等续帧（不 loadHistory 清空
            // 重建，续帧继续渲染）；否则 syncSessions 恢复会话/历史（C2：重连补拉，首连瞬败后不再
            // 永久空列表、也不再只 loadHistory 空转）。
            if (resumeRun) {
              const r = resumeRun
              resumeRun = null
              armResumeWait(r)
            } else {
              void syncSessions(name, gen)
            }
            void loadCommands() // C2: 重连补拉命令清单（首连瞬败后斜杠菜单不再永久死）
          } else {
            everConnected = true
            pendingConnect?.(true)
            pendingConnect = null
            // F5: 会话列表/历史加载与首连解耦——首连成功与首连失败后的重连成功都在这里补拉会话，
            // 否则失败后 selectContainer 已 return、重连 onReady 也不 listSessions → 空 chat 假连接。
            void syncSessions(name, gen)
            void loadCommands()
          }
        },
        // 网关事件经 eventTranslate 翻译成渲染帧，按 type 分派到对应处理（runId 路由在 handle* 内）
        onFrame: (frame: ChatFrame) => {
          if (gateway !== myGw) return
          switch (frame.type) {
            case 'text':
              handleText(frame.runId, frame.delta, frame.replace, frame.thinking)
              break
            case 'attachment': // #459-T3 #464：附件媒体帧（image/audio/video 块）
              // Phase 2 图片显示修复：agent assistant 流 mediaUrls（容器绝对路径）先异步 resolve 成
              // blob URL 再挂 store（<img> 直连带不了 Authorization header）；既有 base64/http 媒体
              // 原样透传。resolve 为 fire-and-forget（不阻塞 ws 帧处理），失败静默丢弃。
              void resolveAttachment(frame.runId, frame.media)
              break
            case 'done':
              handleDone(frame.runId, frame.thinking, frame.message)
              break
            case 'error':
              handleError(frame.message, frame.runId)
              break
            case 'approval':
              handleApproval(frame)
              break
            case 'approvalResolved':
              handleApprovalResolved(frame.id, frame.decision)
              break
            case 'tool':
              handleTool(frame)
              break
          }
        },
        onClose: (code, _reason, retry, pairingRequired) => {
          if (gateway !== myGw) return // 旧 gateway 的关闭（切容器）不报断线
          status.onConnecting(false)
          disconnected.value = true // 意外断线：禁用发送（codex P2 #4）
          chat.recoverPendingApprovals() // 连接断开：恢复所有 resolving 卡片可重试
          const authGate =
            code === WS_AUTH_FAIL || code === WS_MUST_CHANGE_PASSWORD || code === WS_CONTAINER_ACCESS_DENIED
          // 占位落定（所有断开路径，光标不闪烁）：授权门拒绝（4401/4403/4404）也要落定——旧实现
          // 授权门分支不 finalizeLast，流式占位永久闪烁（composer 因 streaming 禁发）（P1-1）。
          if (activeRunId || pendingSend) finalizeLast()
          // R4-7（第四轮）：清 pendingSend——首帧未到的 send 在本连接已死，重连是新 run 语境（resumeRun
          // 仅在 activeRunId 非空时记，pendingSend 期间断线本就不期望 resume）。泄漏会让 4401 重建后
          // 切会话 abandonActiveRun 走 `else if (pendingSend)` → pendingAbandonCount++ → 下次 send 首帧
          // 被孤儿计数吞。
          pendingSend = false
          myRunId = '' // #53: 连接已死，本 run 的 ack runId 作废
          // B5: 意外断线不永久 abandon 在途 run——网关重连可能 resume 同一 run 补发续帧
          // （session projection）。记录 resumeRun 供 onReady 保留占位等待续帧（而非 loadHistory
          // 清空重建）；授权门拒绝（4401/4403/4404）不记录（连接未建立/不可恢复，无续帧可等）。
          if (authGate) {
            // P1-1: 授权门清残留 activeRunId——否则 loadHistory 清 messages 但不清 runId，跨重连
            // 存活的 runId 让自主 run 首帧被静默丢弃（claimedEmpty=false）。
            activeRunId = ''
          } else {
            // P1-3（code review）：仅 activeRunId 非空才记录 resumeRun——pendingSend=true 但首帧未到
            // （activeRunId===''）时断线，该 run 无法 resume（网关从未处理/无 runId 可投影），记录
            // {runId:''} 会让重连 30s 后 armResumeWait 以 '' 匹配 → loadHistory 清空用户刚发的消息。
            if (activeRunId) resumeRun = { runId: activeRunId }
            // 保留 activeRunId + 占位（不清空），等重连 onReady 消费 resumeRun（B5 续帧匹配）
          }
          pendingAbandonCount = 0 // 连接已死：孤儿计数是「同连接内迟到首帧」语义，清零防吞新 run
          if (!everConnected) {
            // 握手就绪前关闭（连接建立失败）→ 决议 openGateway 失败
            pendingConnect?.(false)
            pendingConnect = null
          }
          // issue #240：4401（access token 过期）走刷新重连链路（forceRefresh → 新 token 重建），
          // refresh 确认失效才跳登录——协议机对 4401 决策 retry:false，防拿过期 token 死循环。
          if (code === WS_AUTH_FAIL) {
            if (!disposed) void recoverUnauthorized()
            return
          }
          // D1: 4403 强制改密是账号级门（非容器归属）——切任何容器都 4403，误导「切换容器」让用户
          // 永远得不到「去改密码」指引，故独立文案。
          if (code === WS_MUST_CHANGE_PASSWORD) {
            if (!disposed) status.onError('账号需先修改密码后才能使用对话（请前往账号设置修改密码）')
            return
          }
          // 4404（容器归属门拒绝）：提示切换容器
          if (code === WS_CONTAINER_ACCESS_DENIED) {
            if (!disposed) status.onError('容器不可访问，请切换容器')
            return
          }
          // P1-7 + #377：PAIRING_REQUIRED 已由 gatewayChat 自动配对编排接管（approve → 重连）——
          // 此处 pairingRequired 仅在「自动配对失败」（approve HTTP 错误 / requestId 无效 / 预算用尽）
          // 时透传，如实提示重试而非让用户去容器详情页手动配对（详情页无 approve 入口，配对是自动的）。
          if (pairingRequired) {
            if (!disposed) status.onError('设备配对失败，请重试连接')
            return
          }
          // #376: 4402 网关不可达预算超限（retry:false = 连续 4402 达重试预算）→ 提示「容器网关不可用」
          // （容器 stopped/重启中/端口不通，容器恢复前重试无益；disconnected 条的「重新连接」= 手动重连
          // 入口，切容器/重连即新建 GatewayChat 重置预算）。预算内（retry:true）不在此分支，落下方
          // 「自动重连中…」。
          if (code === WS_GATEWAY_UNAVAILABLE && !retry) {
            if (!disposed) status.onError('容器网关不可用，请确认容器已启动后手动重连')
            return
          }
          // 其他断开：D2 按协议机 retry 决策如实提示——false = 已停止自动重连（非恢复错误 /
          // 连续失败 give-up / 未配对），true = 退避重连中。不再对已停重连谎报「自动重连中…」。
          if (!disposed) {
            status.onError(retry ? '连接已断开，自动重连中…' : '连接已断开，自动重连已停止，请手动重连')
          }
        },
        onError: (message) => {
          if (gateway !== myGw) return
          if (!everConnected) {
            status.onConnecting(false)
            pendingConnect?.(false)
            pendingConnect = null
          }
          if (!disposed) status.onError(message)
        },
      },
    })
    gateway = myGw
    myGw.start()
    // P0（code review）：连接期超时竞速——SYN 黑洞初始连接（socket 永不 open）下 onReady/onClose/
    // onError 都不触发，pendingConnect 永挂、connecting 永久 true。timer 收本调用局部作用域（闭包
    // 持有），并发 openGateway 不再互踩模块级单槽。超时：resolve(false) 解锁 UI + 主动关隧道触发
    // 协议机退避重连（P1：不关 socket 则 CONNECTING 下用户消息被 tunnelSocket.send 静默丢弃）。
    let resolveTimeout: (ok: boolean) => void
    const timeout = new Promise<boolean>((resolve) => {
      resolveTimeout = resolve
    })
    const connectTimeoutTimer = setTimeout(() => {
      if (gen === containerGen && !disposed) {
        status.onConnecting(false)
        // #492：连接超时同属建连失败出口——恢复断开态（UI 不假活；协议机退避重连成功后 onReady 再置 false）
        disconnected.value = true
        status.onError('连接建立超时，请检查容器状态后重试')
        myGw.closeSocket(1000, 'connect timeout') // P1-5: 触发协议机退避重连自愈
      }
      resolveTimeout(false)
    }, CONNECT_TIMEOUT_MS)
    const ok = await Promise.race([ready, timeout])
    clearTimeout(connectTimeoutTimer) // race 已 settle：清自己的 timer 防泄漏
    if (!ok && pendingConnect) pendingConnect = null // 超时分支：迟到的 onReady 不再影响本决议
    return ok && gateway === myGw
  }

  // 建连入口（token 就绪后调用；手动重连/刷新重建复用）：过期/缺失 token 先 forceRefresh 换新再建连。
  function connect() {
    if (!auth.token || isTokenExpired(auth.token)) {
      void (async () => {
        await auth.forceRefresh()
        if (disposed) return
        if (auth.refreshExhausted) {
          redirectLogin()
          return
        }
        void openGateway()
      })()
      return
    }
    void openGateway()
  }

  // 切会话/容器时调用：旧 run（已 claim 或仍 pending）标记 abandoned，其迟到帧按 runId 丢弃
  function abandonActiveRun() {
    if (activeRunId) abandonedRunIds.add(activeRunId)
    else if (pendingSend) pendingAbandonCount++ // 首帧未到、runId 未知：迟到首帧按 FIFO 计数丢弃
    graceExpired = false // 切会话/容器：宽限过期的「迟到认领」语义作废（新 run 语境）
    activeRunId = ''
    pendingSend = false
    myRunId = '' // #53: 切会话/容器放弃本 run 的 ack runId
  }

  async function selectContainer(name: string) {
    // B0: 同名 early-return 仅当连接还活着（gateway 非空）才跳过。生命周期对齐 KeepAlive（App.vue）：
    // 登录态下 ChatView 被缓存，切页走 activated/deactivated、连接保持，不 unmount；仅登出才 unmount
    // → dispose 断网关。故「store 残留 selectedContainer 而 gateway 已死」只在登出后再登录的 remount
    // 出现，此时必须重建连接，否则连接死而 UI 看似活着（send/resolveApproval 因 !gateway 静默 no-op，
    // 审批卡无人处理 → agent 卡死被网关 abort）。
    if (!name || (chat.selectedContainer === name && gateway)) return
    const gen = ++containerGen // 每次切换自增，await 后据此丢弃过期响应
    chat.setSelectedContainer(name)
    // 立即停用旧连接 + 清空状态：避免旧 gateway 迟到帧/迟到响应污染新容器（codex P2 #5 同款）
    const oldGw = gateway
    gateway = null
    oldGw?.stop()
    status.onConnecting(true)
    disconnected.value = false
    revokeAllObjectUrls() // Phase 2：切容器前释放旧容器媒体 objectURL（消息投影即将清空）
    chat.resetForContainer()
    fileTabs.reset() // #626 T1：切容器清文件 tab + workspace 树（下次进「文件」分段重拉）
    abandonActiveRun()
    clearPendingGraceTimer() // B4: 切容器清除旧容器武装的延迟收尾定时器（防跨容器 fire）
    clearResumeWait() // B5: 切容器放弃在途 run 的 resume 等待（新容器连接是新 run 语境）
    pendingAbandonCount = 0 // B1: 切容器后孤儿计数清零（旧连接的 run 永不再来帧，防吞新容器首帧）
    status.onClearError()
    try {
      // F5: 只等首连决议（openGateway 内部由 onReady/onClose/onError resolve）；会话列表/历史加载
      // 统一由 syncSessions 在 onReady 完成（首连成功与重连成功同路径）——首连失败后协议机自连/
      // 「重新连接」也都能补拉会话，否则「看似已连接」的空 chat 无会话、send 静默 no-op。
      const ok = await openGateway()
      if (gen !== containerGen) return
      if (!ok) return // openGateway 已显示错误（容器不可访问/连接失败）
    } catch (e) {
      if (gen !== containerGen) return
      status.onConnecting(false) // 出错解除 connecting（composer 解禁后用户可重试）
      // #492：selectContainer 建连失败也恢复断开态（同 openGateway 失败出口——防 UI 假活，
      // 断线条保持、审批/发送按钮禁用，用户可重试而非「可点但无响应」）
      if (!disposed) disconnected.value = true
      if (e instanceof ApiError && e.status === 401) return
      status.onError((e as Error).message)
    }
  }

  // #459-T2 #463：可选 attachments——宿主已采集/校验（buildAttachments 过滤+拒发提示），本层透传。
  // 纯图片消息（text 空但有附件）放行发送；文本与附件同帧携带（gateway.send 非空才含 attachments 键）。
  // 返回是否真发出（false=守卫早退未发，宿主据此决定是否清空预览条——#2：早退时附件不丢）。
  function send(streamingEnabled: boolean, attachments?: Attachment[]): boolean {
    const text = chat.input.trim()
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0
    // 既无文本也无附件 → 无内容可发（保持既有空文本禁发语义）；其余判定不变。
    if ((!text && !hasAttachments) || !gateway || !chat.selectedSession || disconnected.value || streamingEnabled) return false
    chat.setSlashDismissed(true) // 发送后关闭补全菜单（输入已被清空，下次输 / 时经 onComposerInput 复位）
    clearResumeWait() // B5: 用户发新消息 = 放弃旧 run 的 resume 等待（新 run 是新语境）
    const userMsg = newMsg('user', text)
    // #459-T3 #464：发送的附件（image/audio/video）塞进 user echo 消息 media——本地即时渲染
    // 自己发送的附件（验收 12）。投影走 attachmentToMediaBlock（与历史/流式 extract 共用同一
    // MediaBlock 投影，mimeType 主段派生 type / string content 门 / fileName 拷贝不重写）。
    if (hasAttachments) {
      for (const a of attachments!) {
        const block = attachmentToMediaBlock(a)
        if (block) userMsg.media.push(block)
      }
    }
    chat.pushMessage(userMsg)
    chat.pushMessage(newMsg('assistant'))
    activeRunId = '' // 等首帧 onText 锚定新 run
    graceExpired = false // B4: 新 run 语境，宽限过期标记作废
    pendingSend = true // 首帧未到前，切会话会按 pending 孤儿计数（codex P2 #3）
    myRunId = '' // #53: 新 send 语境，ack runId 未知
    const myGw = gateway
    const sessionKey = chat.selectedSession
    const container = chat.selectedContainer
    // #564: 幂等 key 在发送前生成并外注——ack 丢后的重发复用同一 id，经网关幂等去重防转录双跑。
    // 入队时机 = gateway.send 调用前（与 pendingSend=true 同步点）：「在线但 ack 未回」窄窗落盘，
    // ack 已回即删队（不打扰正常慢网关）。带附件消息不持久化（File/dataUrl 跨刷新失效，规格 §九）。
    const id = createRequestId().replace(/[^a-z0-9]/g, '')
    if (!hasAttachments) outbox.addPending(container, sessionKey, { id, text, createdAt: Date.now() })
    // chat.send RPC（幂等 key 外注 #564）；网关拒绝（未配对/scope 不足）→ catch 收尾提示
    void myGw
      .send(sessionKey, text, hasAttachments ? attachments : undefined, id)
      .then((runId) => {
        // ack = 网关已受理（status:"started"）→ 确认送达，删队（无条件：ack 是权威；切容器后旧
        // gateway 的 ack 也删旧容器队——消息已送达旧容器，留待无意义，且 scope 隔离互不影响）。
        outbox.removePending(container, sessionKey, id)
        // #53: ack 返回本 run 的网关 runId（官方 chat.send ackPayload）——供首帧归属判别。
        // stale-gateway 守卫同 catch：切容器后旧 gateway 的 ack 不污染新 run 语境。
        if (gateway !== myGw || !pendingSend) return
        myRunId = runId ?? ''
      })
      .catch((e) => {
        if (disposed) return
        // P1-2（code review）：stale-gateway 守卫——旧 gateway stop() flush-reject 在途 send 时，当前
        // 容器可能已切换（gateway !== myGw）；无守卫会对新容器 state 执行 finalizeLast + 写旧连接停止
        // 错误进新容器的 errorMsg（对齐 onFrame/onClose 的 stale guard）。
        if (gateway !== myGw) return
        status.onError((e as Error).message)
        // R4-5（第四轮）：run 已 claim 且仍在流（activeRunId 非空——首帧已到）时，RPC 超时但网关可能
        // 继续流式续帧。此时 finalize 占位会落定 streaming，续帧要么被当下次 send 的占位认领（跨 run
        // 文本污染 + 吞用户回复），要么占位永久卡。仅在「首帧未到即失败」（activeRunId 空，run 没起来）
        // 时 finalize + 清 pendingSend 放弃占位。
        // #564: catch 按 activeRunId 细分删队——非空（网关已受理在续流）→ 删队（ack 慢而已）；空
        //（run 未起来）→ 留队，下次重连/刷新经 resendOutbox 自动重发（规格 §三.2）。
        if (activeRunId) {
          outbox.removePending(container, sessionKey, id)
          return
        }
        // F3: RPC 失败复位 pendingSend——泄漏会让切会话变 phantom orphan（pendingAbandonCount++），
        // 下次发送首帧被当作孤儿丢弃、composer 永久锁死。
        pendingSend = false
        myRunId = '' // #53: RPC 失败，ack runId 无意义
        finalizeLast()
      })
    chat.setInput('')
    return true
  }

  // #564: 重发 outbox 残留待发（刷新/断线重连统一触发点 = syncSessions 选定会话 + loadHistory 之后；
  // 此时历史已铺底，乐观 echo 不会排到较新 assistant 回复之后）。逐条：
  //  - 文本已在历史（网关已受理、ack 丢而已）→ remove 不重发（内容级去重防 UI 双条，规格 §三.3）；
  //  - 否则按 send() 同款乐观 echo + gateway.send(sessionKey, text, undefined, item.id)——复用原
  //    幂等 key（网关幂等去重防转录双跑）；ack 后 remove，失败留队下次再试（取走不删，重发不经宿主，
  //    纯文本无附件，天然不碰附件预览条）。
  async function resendOutbox(container: string, sessionKey: string) {
    const items = outbox.takePending(container, sessionKey)
    if (!items.length || !gateway || disconnected.value) return
    const myGw = gateway
    // 内容级去重（规格 §三.3）：取历史中 user 消息文本全集。历史侧无 createdAt 可比（Msg 不产
    // 该字段），故只按 text 匹配——同文本歧义（两条同文本只受理一条/loadHistory 保留的本地在途
    // 消息同文本）为 content-level 最小版的固有取舍：误删不会让消息「从 UI 消失」（同文本在渲染
    // 中可见），误重发由网关幂等去重兜底，两端都可接受。
    const inHistory = new Set(chat.messages.filter((m) => m.role === 'user').map((m) => m.text))
    for (const item of items) {
      if (inHistory.has(item.text)) {
        outbox.removePending(container, sessionKey, item.id) // 已送达历史：确认点达成
        continue
      }
      if (gateway !== myGw || disconnected.value) return // 中途断开/切走：剩余留待下次
      chat.pushMessage(newMsg('user', item.text))
      chat.pushMessage(newMsg('assistant'))
      activeRunId = '' // 与 send() 同款：等首帧锚定新 run
      pendingSend = true
      myRunId = '' // #53: 重发是新 send 语境，ack runId 未知
      void myGw
        .send(sessionKey, item.text, undefined, item.id)
        .then(() => outbox.removePending(container, sessionKey, item.id))
        .catch(() => {
          if (gateway !== myGw) return // 切走：旧容器消息留待下次进容器重发
          // 与 send() 同款 catch 细分（规格 §三.2）：activeRunId 非空 = 重发已受理在续流 → 删队
          //（ack 慢而已）；空 = run 未起来 → 留队，下次重连再试（幂等 key + 内容去重兜底不双跑）。
          if (activeRunId) {
            outbox.removePending(container, sessionKey, item.id)
            return
          }
          pendingSend = false
          finalizeLast() // 未受理：落定占位（composer 解锁），留队下次重连再试
        })
    }
  }

  // 统一发送入口（#459-T2 #463 #1）：宿主提供 onSend（含附件校验/清空预览条）则走它（Enter/斜杠/
  // 按钮同路径），缺省回退 composable 内 send（纯文本）——各触发点行为不再分叉。
  function triggerSend(): void {
    if (status.onSend) status.onSend()
    else send(streaming.value)
  }

  // 新建会话（issue #81 / spec #76）：经协议机 sessions.create RPC；网关权威新建仅回 session_key。
  async function newSession() {
    if (!chat.selectedContainer || !gateway || disconnected.value) return // E2: 断线不操作（防裸错误）
    abandonActiveRun()
    clearResumeWait() // B5: 主动建会话 = 放弃 resume 等待
    chat.setMessages([])
    // codex R3 P1：不清空审批卡——新会话不换容器，切会话特意留存的同容器卡须保留（按 sessionKey 过滤渲染），
    // 否则卡住的 agent 对应那张卡会被这里误清、再也无法回覆
    try {
      const sessionKey = await gateway.createSession()
      const s: SessionDTO = { session_key: sessionKey, title: '', updated_at: '' }
      chat.prependSession(s)
      chat.setSelectedSession(s.session_key)
      status.onClearError()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      status.onError((e as Error).message)
    }
  }

  function pickSession(key: string) {
    if (!key || chat.selectedSession === key || !gateway || disconnected.value) return // E2: 断线不切换（防裸错误）
    abandonActiveRun()
    clearResumeWait() // B5: 主动切会话 = 放弃 resume 等待
    chat.setSelectedSession(key)
    // codex R2 P1：不清空审批卡——同容器其它会话的卡保留，渲染时按 selectedSession 过滤即可
    void loadHistory(key) // T3：切会话加载该会话历史（loadHistory 内部清空 messages + 维护分页态）
  }

  // T3 会话历史回看（issue #82 / spec #76）：经协议机 chat.history RPC 渲染历史消息 + 维护分页态。
  // stale 守卫：切会话/容器后迟到的 history 响应按 containerGen + selectedSession 双校验丢弃
  // （同 selectContainer 的 containerGen 套路）。401 由 client 处理；其它失败落 errorMsg。
  // codex #249 P2：另加 historyGen 请求代——同一会话并发两次 loadHistory（如重连恢复撞上在途请求）
  // 时只让最新一次提交快照，被取代的在途请求落地即丢弃，避免两份快照各自 prepend 造成转录重复。
  async function loadHistory(key: string) {
    const gen = containerGen
    const hgen = ++historyGen // codex #249 P2：本请求代；之后再有 loadHistory 即取代本请求
    if (!gateway) return // E2: 断线不重载（防先清空 transcript 再 RPC 失败留白）
    revokeAllObjectUrls() // Phase 2：重置消息投影前释放已追踪 objectURL（旧消息图片即将清空）
    chat.resetForSession()
    fileTabs.closeAll() // #626 T1：切会话清文件 tab（workspace 树是 per-container，保留）
    chat.setHistoryLoading(true)
    status.onClearError()
    try {
      const res = await gateway.getHistory(key, INITIAL_HISTORY_LIMIT)
      if (gen !== containerGen || chat.selectedSession !== key) return // 切走了：丢弃迟到响应
      if (hgen !== historyGen) return // codex #249 P2：已被更新的 loadHistory 取代：丢弃本在途响应
      // codex P2 #108：保留 await 期间 send() 追加的进行中 turn（user + 流式 assistant 占位）。
      // 直接整体替换会被历史快照覆盖 → delta 找不到 streaming 尾，整轮实时回复从 UI 消失。
      const inFlight = chat.messages
      // TODO(ii) 消息级 __openclaw.seq 排序：当前按到达序拼接（history + inFlight），不按 seq。
      // 暂缓——#560 §3 判不可行（历史/本地消息拿不到可靠 seq）+ 本地无网关无法实测；
      // 前置票：乐观消息接入 projection 元数据 + 真网关抓包确认流式 seq 下发。详见 memory
      // message-seq-ordering-deferred。
      chat.setMessages([...res.messages.map(translateHistoryMessage), ...inFlight])
      chat.setHistoryState(res.hasMore, res.nextOffset, false)
    } catch (e) {
      if (gen !== containerGen || chat.selectedSession !== key) return
      if (hgen !== historyGen) return // codex #249 P2：被取代的请求：不落错误、不干扰新请求
      if (e instanceof ApiError && e.status === 401) return // 401 由 client 处理会话
      status.onError((e as Error).message)
      chat.setHistoryLoading(false)
    }
  }

  // T3 历史消息翻译（防腐层，issue #82）：网关 display-normalized 消息字段名「待实测」（对齐后端
  // _parse_history 透传策略），前端单点容错——role 归一 operator/user/human→user、其余→assistant；
  // text 主取 text、回退 content/message。历史消息为终态：streaming=false；tools 无条件提取
  //（Q2-1(a)，与流式路一致——流式工具挂 msg.tools，历史也提取 toolCall 块进 tools）。
  // #565: 结构化 thinking 块（content[] 的 type==='thinking' 块）经 extractThinking 提取填
  // Msg.thinking（history 全量覆盖）；内联 <thinking> 标签剥离（splitThinking 的残片/未闭合
  // 语义）属流式路，历史为终态不剥离（既有现状：旧格式历史正文含字面标签，本规格不动）。
  // E1b: toolCall-only assistant 消息（生产实测：exec 审批无人处理 → 网关 stuck-session recovery
  // abort run → 最后一条 assistant content=[thinking,toolCall×N] 无 text 块）→ 提取 text 为空，
  // 若照原样渲染成空文本气泡（用户误以为回复丢失）。转译 toolCall 块为工具行（done 态）——
  // 语义正确展示 agent 实际调过什么工具，而非空白气泡。
  function translateHistoryMessage(m: HistoryMessageDTO): Msg {
    // E1: 网关 history 消息 content 多态（user=string / assistant=[{type:text},{type:thinking}]，
    // ADR 0003）——复用 eventTranslate.extractMessageText（已处理 string/数组 content 并跳过
    // thinking 块），不再只认 string 导致 assistant 历史渲染成空泡。text 字段回退保留（旧透传 shape）。
    const text = extractMessageText(m) || (typeof m.text === 'string' ? m.text : '')
    // Q2-1(a)：无条件提取 toolCall 块——与流式路一致（流式工具挂 msg.tools），消除「正文+工具」
    // 消息刷新后工具行凭空消失的布局分歧。原 text==='' 门（仅 toolCall-only 消息留工具）与流式
    // 不对称：有正文即丢全部工具，刷新后工具整段消失。
    const tools = extractToolRows(m)
    // #459-T3 #464：历史消息 image/audio/video 块 → media（与 text 独立通道，extractToolRows 同款
    // 防腐层位置）。此前非 text 块被渲染层丢弃；纯图片历史消息（text 空 + media 非空）照常渲染。
    const media = extractMessageAttachments(m)
    // #565: 结构化 thinking 块提取——与 text 独立通道（thinking 块不混入正文，正文块不混入思考）；
    // null（无结构化块）回退 ''（现状：无思考卡），非 null 填折叠卡渲染。
    const structThinking = extractThinking(m)
    return {
      role: historyRole(m.role),
      raw: text,
      text,
      thinking: structThinking ?? '',
      thinkingOpen: false,
      streaming: false,
      tools,
      media,
    }
  }

  // 从 assistant 消息 content 提取 toolCall 块 → 工具行（done 态）。Q2-1(a)：无条件调用（与流式
  // 路一致），有正文也提取——消除刷新后工具消失。toolCall 块字段：type/toolCallId/name/arguments（实测 jsonl）。
  function extractToolRows(m: HistoryMessageDTO): ToolRow[] {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) return []
    const rows: ToolRow[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'toolCall') continue
      rows.push({
        id: typeof b.toolCallId === 'string' ? b.toolCallId : typeof b.id === 'string' ? b.id : null,
        name: typeof b.name === 'string' ? b.name : '',
        state: 'done',
        title: null,
        input: b.arguments ?? null,
        result: null,
      })
    }
    return rows.filter((r) => r.name !== '') // 无名的 toolCall 块丢弃（0 信任）
  }

  function historyRole(role: unknown): 'user' | 'assistant' {
    const r = typeof role === 'string' ? role.toLowerCase() : ''
    return r === 'operator' || r === 'user' || r === 'human' ? 'user' : 'assistant'
  }

  // T3 历史分页（issue #82）：顶部「加载更多」向回翻更旧消息——用 historyAnchor(=nextOffset) 作
  // messageId 锚点请求更旧一页，prepend 到列表头部（消息流按时间旧→新，更旧的在上）。
  // stale 守卫同 loadHistory（containerGen + selectedSession 双校验）。
  // codex #249 R3 P2：与 loadHistory 共用 historyGen 请求代——完整 reload（如重连恢复）会 ++historyGen
  // 取代在途分页；若分页只校验不变的 container/session，其迟到响应会 prepend 旧页并覆盖 historyAnchor
  // 回第一页锚点，下次「加载更多」重复拉取/prepend 同一旧页（转录重复）。故分页也捕获并校验请求代。
  async function loadMoreHistory() {
    if (!chat.historyHasMore || chat.historyAnchor == null || chat.historyLoading || !gateway) return
    const key = chat.selectedSession
    const gen = containerGen
    const hgen = historyGen // codex #249 R3 P2：捕获当前代；不自增（分页不得取代进行中的完整 loadHistory）
    const anchor = String(chat.historyAnchor)
    chat.setHistoryLoading(true)
    try {
      const res = await gateway.getHistory(key, undefined, anchor)
      if (gen !== containerGen || chat.selectedSession !== key) return // 切走了：丢弃迟到响应
      if (hgen !== historyGen) return // codex #249 R3 P2：已被完整 loadHistory 取代：丢弃本在途分页
      chat.setMessages([...res.messages.map(translateHistoryMessage), ...chat.messages])
      chat.setHistoryState(res.hasMore, res.nextOffset, false)
    } catch (e) {
      if (gen !== containerGen || chat.selectedSession !== key) return
      if (hgen !== historyGen) return // codex #249 R3 P2：被取代的分页：不落错误、不干扰新请求
      if (e instanceof ApiError && e.status === 401) return
      status.onError((e as Error).message)
      chat.setHistoryLoading(false)
    }
  }

  // T06：批准/拒绝 → 回发 exec.approval.resolve RPC + 进 resolving 态（禁用按钮等回执，不乐观假成功，
  // codex P2）。成功由 handleApprovalResolved 落定；RPC 失败按错误分类（#492）：
  //  - 终态错误（审批过期/不存在/无权——网关协议 ErrorCodes.APPROVAL_NOT_FOUND / INVALID_REQUEST /
  //    FORBIDDEN）：卡已无可回覆，落定 expired（终态不可重试）+ 提示，不静默复位造成「反复点击无反馈」
  //  - 瞬态错误（网关不可用/网络/超时等其余码）：恢复 pending 让卡可重试（原行为）
  function resolveApproval(a: ApprovalItem, decision: 'allow-once' | 'deny') {
    // codex R3 P2：socket 已断则不可点——否则会进 resolving 后 request 抛错
    if (!gateway || a.status !== 'pending') return
    a.status = 'resolving'
    a.decision = decision
    void gateway.resolveApproval(a.id, a.kind ?? 'exec', decision).catch((e) => {
      const code = (e as { code?: unknown } | null)?.code ?? (e as { gatewayCode?: unknown } | null)?.gatewayCode
      if (
        code === 'APPROVAL_NOT_FOUND' ||
        code === 'INVALID_REQUEST' ||
        code === 'FORBIDDEN'
      ) {
        chat.expireApproval(a.id)
        status.onError('该审批已失效（过期或已被处理），无法再回覆')
      } else {
        chat.recoverPendingApprovals(a.id)
      }
    })
  }

  // T3 删除会话（issue #82 / spec #76，admin 级提升权限）：确认后调 sessions.delete（不带
  // archivedOnly——网关对未归档会话恒拒 INVALID_REQUEST，删除即硬删除、不可恢复，无「归档」中间态）。
  // 成功 → 从列表移除；删的是当前会话则停留空聊天区（空态视图 + 「新建会话」入口），不自动切/建。
  // 失败 → 返回错误信息（上层 toast 呈现；不落顶部小字 bar——删除失败须醒目可感知，spec #461）。
  // 返回：true=删除成功；string=删除失败（错误消息）；null=用户取消或断线（无反馈）。
  async function removeSession(key: string, confirm: () => Promise<boolean>): Promise<true | string | null> {
    if (!key || !gateway) return null // E2: 断线不操作（防裸错误）
    const ok = await confirm()
    if (!ok) return null // 用户取消
    try {
      await gateway.deleteSession(key)
    } catch (e) {
      return (e as Error).message || '删除失败'
    }
    chat.removeSession(key)
    if (chat.selectedSession === key) {
      chat.setSelectedSession('')
      revokeAllObjectUrls() // Phase 2：删除当前会话前释放其媒体 objectURL（消息投影即将清空）
      chat.resetForSession() // 清空消息投影 → 空聊天区（不再自动切到剩余首个或新建）
      fileTabs.closeAll() // #626 T1：删当前会话=离开会话，清文件 tab（workspace 树保留）
      status.onClearError() // 删除当前会话后清残留错误条（spec #461：错误呈现统一走 toast，不留双通道）
    }
    return true
  }

  // 切容器/断线/卸载清理
  function dispose() {
    disposed = true
    revokeAllObjectUrls() // Phase 2：卸载释放全部媒体 objectURL（组件销毁，blob URL 无消费者）
    clearPendingGraceTimer() // B4: 卸载清延迟收尾 timer，防组件销毁后触发
    clearResumeWait() // B5: 卸载清 resume 等待 timer
    // #14: 连接期超时 timer 已收 openGateway 局部作用域（P0：闭包内 clearTimeout，并发 openGateway
    // 不再互踩模块级单槽），组件卸载无需清理——gateway.stop() 停协议机即可。
    gateway?.stop()
    gateway = null
  }

  const streaming = computed(() => chat.messages.some((m) => m.role === 'assistant' && m.streaming))
  let promptHistoryIndex = -1
  let promptDraft = ''

  // ---- T07 斜杠命令匹配（单一来源，供 ChatView 键位处理 + ChatComposer 菜单渲染）----
  // 当前斜杠前缀：仅当输入形如 `/xxx`（无空格）时激活，返回去掉前导 / 的小写查询；否则 null
  const slashQuery = computed<string | null>(() => {
    const v = chat.input
    if (!v.startsWith('/') || v.includes(' ')) return null
    return v.slice(1).toLowerCase()
  })

  // 把命令清单拍平为「别名×描述」选项并按当前前缀过滤（/m 命中 /model 与 /m）
  const slashMatches = computed<SlashOption[]>(() => {
    const q = slashQuery.value
    if (q === null) return []
    const out: SlashOption[] = []
    for (const c of chat.commands) {
      for (const a of c.aliases) {
        if (a.slice(1).toLowerCase().startsWith(q)) out.push({ alias: a, description: c.description })
      }
    }
    return out
  })

  const slashOpen = computed(
    () => slashQuery.value !== null && !chat.slashDismissed && slashMatches.value.length > 0,
  )

  // 点选/选中：填入别名 + 尾随空格（便于续输参数），关闭菜单并聚焦；发送仍走普通 send()
  function pickSlash(alias: string) {
    chat.setInput(`${alias} `)
    chat.setSlashDismissed(true)
  }

  // 输入变化：若不再是斜杠前缀（删字符/加空格），复位 Esc 关闭态，下次输 / 可再弹
  function onComposerInput() {
    promptHistoryIndex = -1
    promptDraft = ''
    if (!slashQuery.value) chat.setSlashDismissed(false)
    chat.setSlashIndex(0)
  }

  // 键位处理：菜单开启时斜杠补全导航/选中/关闭优先于发送；关闭时 Enter（无修饰键）发送
  function onComposerKeydown(e: KeyboardEvent) {
    // 中文/日文等 IME 用 Enter 确认候选词时，不得把同一次 keydown 当成发送或命令选择。
    // isComposing 是标准信号；keyCode=229 兼容 Safari/部分输入法未正确暴露 composition 状态。
    if (e.isComposing || e.keyCode === 229) return

    if (slashOpen.value) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        chat.setSlashIndex((chat.slashIndex + 1) % slashMatches.value.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        chat.setSlashIndex((chat.slashIndex - 1 + slashMatches.value.length) % slashMatches.value.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        // Enter/Tab 选中高亮项填入（不发送）；发送由菜单关闭后的 Enter 触发
        e.preventDefault()
        const m = slashMatches.value[chat.slashIndex]
        if (m) pickSlash(m.alias)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        chat.setSlashDismissed(true)
      }
      return
    }
    // #524：空输入框按 ↑ 浏览当前会话的历史用户输入；↓ 返回较新的输入并最终恢复草稿。
    // 仅在空输入或已经进入浏览态时接管键位，避免破坏多行文本中的正常光标移动。
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const prompts = chat.messages.filter((m) => m.role === 'user').map((m) => m.text).filter(Boolean)
      if (prompts.length && (chat.input === '' || promptHistoryIndex >= 0)) {
        e.preventDefault()
        if (promptHistoryIndex < 0) promptDraft = chat.input
        promptHistoryIndex = e.key === 'ArrowUp'
          ? Math.min(promptHistoryIndex + 1, prompts.length - 1)
          : promptHistoryIndex - 1
        chat.setInput(promptHistoryIndex < 0 ? promptDraft : prompts[prompts.length - 1 - promptHistoryIndex])
        return
      }
    }
    // 菜单关闭：Enter（无修饰键）发送；Shift+Enter 换行（与原 @keydown.enter.exact 行为一致）
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      triggerSend()
    }
  }

  return {
    chat,
    disconnected,
    streaming,
    slashQuery,
    slashMatches,
    slashOpen,
    pickSlash,
    onComposerInput,
    onComposerKeydown,
    openGateway,
    connect,
    selectContainer,
    send,
    newSession,
    pickSession,
    removeSession,
    resolveApproval,
    loadMoreHistory,
    dispose,
    status,
  }
}
