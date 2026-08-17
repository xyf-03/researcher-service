// AutoFigure 域 API client（T09，docs/autofigure/tickets/T09-vue-figure-journey.md）。
// researcher-service figures 公共 REST 的窄前端投影（T01–T06 已冻结契约）：
//   POST /api/v1/figures（Idempotency-Key 幂等创建）· GET /（列表）· GET /:id（详情）· GET /:id/png（PNG 字节）。
// 边界纪律：
//   - 无 delete：V1 无删除，本模块不导出任何删除函数。
//   - 凭证边界：创建只发 {prompt} 体 + Idempotency-Key 头；userId / provider 凭证不进请求。
//   - PNG 走 apiFetch（原始字节，成功路径豁免 #312 信封 → 原生 image/png 字节）；错误面仍走信封
//     （70040/70042/70043，HTTP 200 + JSON），按 Content-Type 判别。apiJson 是信封解析器，读 PNG
//     字节会失败，故不可用。
import { ApiError, apiFetch, apiJson, parseEnvelopeBody } from '@/api/client'
import { parseEnvelope } from '@/api/errors'

export type FigureAppStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface CreateFigureResult {
  readonly figureId: string
  readonly jobId: string
  readonly status: FigureAppStatus
}

export interface FigureSummaryDTO {
  readonly figureId: string
  readonly jobId: string
  readonly prompt: string
  readonly status: FigureAppStatus
  readonly createdAt: string
}

export interface FigureDetailDTO extends FigureSummaryDTO {
  readonly errorMessage: string | null
  readonly updatedAt: string
}

// 创建/重放：key 由调用方按「提交快照」生命周期管理（T09 约束 3）——同 key+同 prompt 后端回放
// 当前状态，同 key+不同 prompt → 70041。创建成功返回 {figureId, jobId, status}（status 可能已是
// 终态——回放历史 Job）。
export function createFigure(prompt: string, idempotencyKey: string): Promise<CreateFigureResult> {
  return apiJson<CreateFigureResult>('/api/v1/figures', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ prompt }),
  })
}

// 后端排序已冻结（T05）：createdAt DESC, id DESC。客户端不重排、不分页、不搜索。
export function listFigures(): Promise<FigureSummaryDTO[]> {
  return apiJson<FigureSummaryDTO[]>('/api/v1/figures')
}

export function getFigureDetail(id: string): Promise<FigureDetailDTO> {
  return apiJson<FigureDetailDTO>(`/api/v1/figures/${encodeURIComponent(id)}`)
}

// PNG 原始字节（T06 下载契约）：成功路径原生 image/png（不包信封、不 base64-in-JSON），错误面走
// 信封（70040/70042/70043）。apiFetch 复用既有 JWT + 401 刷新链，不建第二 fetch 栈。
export async function getFigurePngBlob(id: string): Promise<Blob> {
  const resp = await apiFetch(`/api/v1/figures/${encodeURIComponent(id)}/png`)
  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.includes('image/png')) {
    return resp.blob()
  }
  // 错误面（JSON 信封）：提取 code → ApiError，调用方据此做应用级区分
  // （70042 未就绪 / 70043 不可用 / 70040 不存在）。parseEnvelopeBody 复用 apiFetch 为 10001/10004
  // 检测可能已读并缓存的同一 body（__envBody）——body 流只可读一次，二次 resp.json() 会 reject 丢码。
  const env = parseEnvelope(await parseEnvelopeBody(resp))
  if (env) throw new ApiError(resp.status, env.message || `请求失败（${resp.status}）`, env.code)
  // 非信封 / 非 JSON body：按 HTTP status 兜底
  throw new ApiError(resp.status, `请求失败（${resp.status}）`)
}
