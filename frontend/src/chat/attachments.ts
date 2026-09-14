// #459-T1 #462：附件采集/校验/组装纯函数模块。
// 采集层（#463 composer 三通道）产生的原始附件 → 类型过滤（白名单 image/audio/video）→
// 体积校验（按字节估算 base64 膨胀，非图片 ≤700KB，图片压缩后同限）→ 组装官方 chat.send
// 的 attachments[] 形状。超限/非法附件拒发（返回 rejected 供 UI 提示「文件过大/类型不支持」）。
//
// 体积上限核算（隧道边界，T1 acceptance）：
//   server TUNNEL_MAX_PAYLOAD = 1MiB（单帧 ws maxPayload，server/src/chat/values.ts）；base64 膨胀
//   系数 4/3。MAX_ATTACHMENT_BYTES = 700KB → base64 后 ceil(716800/3)*4 = 955,734B ≈ 0.91MiB < 1MiB，
//   留 ~97KB 余量容纳 JSON 帧头 + message + idempotencyKey 等元数据。
//   图片与非图片共用此限——图片压缩（最长边 1280 + JPEG/WebP，#463）完成后再入本模块校验，本模块
//   不做压缩（#462 仅协议能力，#463 采集/压缩）。TUNNEL_SEND_BUDGET（4MiB 连接级发送预算）不变。

// 官方 chat.send attachments[] 元素形状（@openclaw/gateway-protocol schema，0 信任 content 自由形状）。
export interface Attachment {
  type?: string
  mimeType?: string
  fileName?: string
  content?: unknown
  sizeBytes?: number
  durationMs?: number
  width?: number
  height?: number
}

// 采集层（#463）输入的原始附件——与官方形状同构，额外字段（如预览 objectURL）由采集层自行管理，
// 本模块只消费组装 attachments[] 所需的字段。
export type RawAttachment = Partial<Attachment>

export interface RejectedAttachment {
  fileName?: string
  reason: 'type' | 'size'
}

// 附件体积上限（字节数）：非图片 ≤700KB，base64 后 <1MiB 隧道帧上限留余量（见文件头核算）。
export const MAX_ATTACHMENT_BYTES = 700 * 1024

// 一次 chat.send 全部附件的合计体积预算（字节数）：与单附件同值。chat.send 帧在一条 WS 帧里，
// 合计才决定帧体积——单附件 ≤700KB 守住还不够，2×700KB 合计 1.4MB 会超 1MiB 帧上限。先发顺序
// 放行，累积超预算的后续附件拒发（采集层 #463 可据 rejected 提示「附件合计过大」）。
export const MAX_TOTAL_BYTES = MAX_ATTACHMENT_BYTES

// 类型白名单（放行 image/audio/video 前缀 + 文档 mime——文档走官方第 4 块类型 document，
// 渲染层下载卡呈现；与 ChatMessageItem SAFE_DOCUMENT_MIMES 对齐 + text/markdown，两处清单须
// 同步改。仍须挡攻击者塞大字节进 free-form content 爆破帧上限）。mimeType 缺失/空前缀不匹配一律拦截。
export function isAllowedAttachmentType(mimeType: string | undefined): boolean {
  return attachmentTypeOf(mimeType) !== null
}

// 文档 mime 清单（发送侧白名单 = 渲染侧 SAFE_DOCUMENT_MIMES ∪ text/markdown；同步改两处）。
// 未知二进制（octet-stream）与渲染卡不认的 office mime 不放行——发了渲染不出，徒增帧体积风险。
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/gzip',
  'application/x-tar',
])

// mime → 官方附件块类型（image/audio/video 主段直映射；文档 mime → document；白名单外 → null）。
// 派生结果即 chat.send attachments[].type 与 MediaBlock.type（渲染按此分派）。
export function attachmentTypeOf(mimeType: string | undefined): string | null {
  if (typeof mimeType !== 'string' || !mimeType) return null
  const main = mimeType.split('/')[0].toLowerCase()
  if (main === 'image' || main === 'audio' || main === 'video') return main
  return DOCUMENT_MIMES.has(mimeType.toLowerCase()) ? 'document' : null
}

// ---- #459-T2 #463：采集层（压缩 + 文件转换）----

// 图片压缩目标：最长边降采样到 1280（spec「最长边 1280」），小于等于不放大。
export const MAX_IMAGE_EDGE = 1280

// 压缩输出 mime：WebP（同尺寸比 JPEG 更小，且支持 alpha——PNG 透明截图/图标转 JPEG 会压黑底，
// spec 允许 JPEG/WebP 取 WebP 保真；engine.render 已参数化 mime，零额外成本）。
const COMPRESS_MIME = 'image/webp'
// 压缩质量（0–1）：默认画质与体积的常用平衡点。
const COMPRESS_QUALITY = 0.85

// 最长边降采样几何：按比例把长边收到 max 内，短边随比例；长边 ≤ max 不放大、原样返回。像素取整。
// 短边钳 ≥1px——极端宽高比（如 1×10000 全页截图）round 会塌缩成 0、0 尺寸输入（无 intrinsic 尺寸的
// SVG）也得非 0 边，否则产出 0 面积 canvas（drawImage no-op、toDataURL 空 content）。
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const long = Math.max(w, h)
  if (long <= max) return { width: w, height: h }
  const scale = max / long
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

// 图像引擎接缝（DI，为可测性）：图片解码取原始尺寸 + canvas 缩放重编码为 dataURL。
// jsdom canvas.getContext 返回 null，真实像素操作只能在浏览器跑——逻辑（缩放几何/输出形状）经
// 注入假引擎单测覆盖，本接口默认实现走浏览器 canvas。
export interface CompressEngine {
  // 读出图片原始像素尺寸。
  loadSize(file: File): Promise<{ width: number; height: number }>
  // 把图片缩放到 w×h 并按 mime 重编码为 dataURL。
  render(file: File, width: number, height: number, mime: string): Promise<string>
}

// 预览条条目（#15 单一来源，ChatView/ChatComposer 共用——避免两处重复声明 drift）：采集到的
// RawAttachment（content 为纯 base64）+ 本地缩略 previewUrl（图片须宿主重建 dataURL 用于 <img>）+ key。
export interface PendingAttachment {
  key: number
  att: RawAttachment
  previewUrl: string // 图片=data:<mime>;base64,<content> 缩略；非图片=空（渲染文件名/类型）
}

// 重建预览用 dataURL（content 是纯 base64，<img src> 须完整 dataURL）：宿主/composer 渲染缩略用。
export function toPreviewDataUrl(att: RawAttachment): string {
  return att.type === 'image' && typeof att.content === 'string'
    ? `data:${att.mimeType};base64,${att.content}`
    : ''
}

// 图片文件 → 压缩后 RawAttachment：引擎解码+缩放一次完成 → fitWithin 目标尺寸 → 组 type:'image' +
// width/height（压缩后尺寸）+ content 纯 base64（#4 协议契约 r13 §2.4：剥 data:...;base64, 前缀）+
// sizeBytes 真实字节（#7：与文件路径 file.size 同单位，从 base64 长度反推，避免图片被多算 ~4/3）。
// 压缩后仍超 MAX_ATTACHMENT_BYTES 由下游 buildAttachments 拒发（采集层不重复判）。
export async function compressImageFile(
  file: File,
  engine: CompressEngine = canvasEngine,
): Promise<RawAttachment> {
  const { width, height } = await engine.loadSize(file)
  const target = fitWithin(width, height, MAX_IMAGE_EDGE)
  const dataUrl = await engine.render(file, target.width, target.height, COMPRESS_MIME)
  const content = stripDataUrlPrefix(dataUrl)
  return {
    type: 'image',
    mimeType: COMPRESS_MIME,
    fileName: file.name,
    content,
    sizeBytes: base64ByteCount(content),
    width: target.width,
    height: target.height,
  }
}

// 浏览器未注册 mime 的常见文档扩展名（File.type 为空串）→ 按扩展名派生（只覆盖文档白名单内
// 类型；.md 是典型——浏览器对 .md 不给 mime，不派生则一切 markdown 文件都被白名单拦）。
const EXT_MIME: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
}

// 非图片/通用文件 → RawAttachment：FileReader 读为 dataURL → content 剥前缀存纯 base64（#4）+
// fileName/mimeType/sizeBytes（真实字节 file.size，#7）+ type 经 attachmentTypeOf 派生（image/
// audio/video/document；无 mime 按扩展名补 mime 后再派生）。体积校验交下游 buildAttachments
// （>700KB 拒发），本函数不判。
export function fileToRawAttachment(file: File): Promise<RawAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
      const mimeType = file.type || EXT_MIME[ext] || ''
      resolve({
        type: attachmentTypeOf(mimeType) ?? '',
        mimeType,
        fileName: file.name,
        content: stripDataUrlPrefix(dataUrl),
        sizeBytes: file.size,
      })
    }
    reader.readAsDataURL(file)
  })
}

// 剥 dataURL 前缀（data:<mime>;base64,）只留纯 base64——#4 协议契约（r13 §2.4，源自上游 live 网关
// attachment-normalize.ts）：content 须为纯 base64，网关/Agent 严格 base64 解码 content，前缀会污染解码。
// 非 dataURL 字符串（已是纯 base64）原样返回。
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

// base64 字符串对应的真实字节数（#7 体积校验单位统一）：≈ len ×3/4（剥 padding），与 file.size 同口径——
// 图片与文件按同一 MAX_ATTACHMENT_BYTES 预算计费，不再因 base64 膨胀（×4/3）让图片被多算 33%。
function base64ByteCount(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

// ---- #694 回退回填 ----

// 修改类会话控制 RPC（`sessions.rewind` / `sessions.fork`）响应里 `editorAttachments` 元素
// （官方 wire 形状 `{mimeType, data}`，data 为纯 base64）→ RawAttachment（与采集层同形状，预览条/
// 发送校验共用）。**必须补 sizeBytes**（Codex #703 P2）：缺它时下游 attachmentByteCount 退化为
// 「按 base64 字符数当字节数」（×4/3 高估），会让真实体积落在 (525KB, 700KB] 的图——本面板压缩后
// 正常发出过的图——在回退后重发被误判超限。折算与采集层 compressImageFile 同一口径
// （base64ByteCount）。白名单外的 mime（网关异常/新类型）→ null，调用方丢弃。
export function editorAttachmentToRaw(a: { mimeType: string; data: string }): RawAttachment | null {
  const type = attachmentTypeOf(a.mimeType)
  if (!type) return null
  return { type, mimeType: a.mimeType, content: a.data, sizeBytes: base64ByteCount(a.data) }
}

// 浏览器 canvas 默认引擎：单次解码（一个 objectURL + 一次 Image 加载）供 loadSize/render 共用——
// #10 避免两次解码（2× CPU + 峰值位图内存）。loadSize 缓存解码结果，render 复用；仅在浏览器可用
// （jsdom canvas 为 null）——采集层在浏览器运行，单测注入假引擎覆盖逻辑。
function decodeImage(file: File): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ img, revoke: () => URL.revokeObjectURL(url) })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

const canvasEngine: CompressEngine = {
  async loadSize(file: File): Promise<{ width: number; height: number }> {
    const { img, revoke } = await decodeImage(file)
    revoke()
    return { width: img.naturalWidth, height: img.naturalHeight }
  },
  async render(file: File, width: number, height: number, mime: string): Promise<string> {
    const { img, revoke } = await decodeImage(file)
    revoke()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d unavailable')
    ctx.drawImage(img, 0, 0, width, height)
    return canvas.toDataURL(mime, COMPRESS_QUALITY)
  },
}

// 附件字节数（体积校验依据）：优先显式 sizeBytes（采集层已知真实大小），回退 string content 长度
// （base64 字符串长度 ≈ 原始字节 4/3，保守用其长度本身当字节数——略高估 base64 前体积，安全方向）。
// content 自由形状（0 信任）：非 string 且无 sizeBytes → 视为 0（无法估量，交网关/隧道边界兜底）。
function attachmentByteCount(a: RawAttachment): number {
  if (typeof a.sizeBytes === 'number' && Number.isFinite(a.sizeBytes) && a.sizeBytes >= 0) return a.sizeBytes
  if (typeof a.content === 'string') return a.content.length
  return 0
}

// 采集 → 校验 → 组装：返回放行附件（官方形状）+ 拒发清单（reason 供 UI 区分「类型不支持/文件过大」）。
// 不接受附件输入（空数组/null/undefined）→ { attachments: [], rejected: [] }（不带附件输入返回空数组）。
export function buildAttachments(input: RawAttachment[] | null | undefined): {
  attachments: Attachment[]
  rejected: RejectedAttachment[]
} {
  const attachments: Attachment[] = []
  const rejected: RejectedAttachment[] = []
  if (!Array.isArray(input)) return { attachments, rejected }
  // 合计体积预算：chat.send 一条 WS 帧，累积已放行附件的字节数，超 MAX_TOTAL_BYTES 的后续附件拒发。
  let totalBytes = 0
  for (const a of input) {
    if (!a || typeof a !== 'object') continue
    if (!isAllowedAttachmentType(a.mimeType)) {
      rejected.push({ fileName: a.fileName, reason: 'type' })
      continue
    }
    const bytes = attachmentByteCount(a)
    if (bytes > MAX_ATTACHMENT_BYTES || totalBytes + bytes > MAX_TOTAL_BYTES) {
      rejected.push({ fileName: a.fileName, reason: 'size' })
      continue
    }
    totalBytes += bytes
    attachments.push({
      type: a.type,
      mimeType: a.mimeType,
      fileName: a.fileName,
      content: a.content,
      sizeBytes: a.sizeBytes,
      durationMs: a.durationMs,
      width: a.width,
      height: a.height,
    })
  }
  return { attachments, rejected }
}
