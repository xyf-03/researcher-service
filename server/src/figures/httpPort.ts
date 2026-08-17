// AutoFigure 生产 HTTP adapter（T07，docs/autofigure/tickets/T07-autofigure-http-adapter.md）。
//
// 这是 AutoFigureGenerationPort 的生产实现：把 normalized 生成输入 → 私有 sidecar HTTP 请求 →
// 解析响应 → normalized result。私有 wire 契约见 docs/autofigure/sidecar-contract.md（本文件是其
// 代码侧单一来源：请求/成功/失败 zod schema 在此声明，markdown 是人工文档镜像）。
//
// 边界纪律：
//   - 只实现计算能力：不拥有生命周期/状态机/领取/超时/reconcile/幂等/归属/信封（T03 Port 不变量）。
//   - 凭证走私有 header `X-Autofigure-Api-Key`（T07 属主决策）：header 而非 body 字段——凭证是
//     服务端执行上下文，不是域生成输入（T03 input/credential 分离）；不转发 JWT、不转发 userId。
//   - `png_base64` 只存在于本私有 wire 边界：adapter 立即 base64 decode 为 Prisma Bytes 等价
//     （Uint8Array<ArrayBuffer>），归一化后**不向应用层/公开层传播 `png_base64` 字段名**。
//   - 所有 sidecar/网络/provider 失败归一为稳定非敏感原因 GENERATION_EXECUTION_ERROR（T05
//     白名单单源见 runner.ts）；不落 raw 响应体/stack/provider 文本/Python traceback。
//   - 无 adapter-local 超时：T04 AUTOFIGURE_JOB_TIMEOUT_MS 是 V1 唯一 application execution
//     timeout（应用 runner 是生命周期事实源）；HTTP 迟到 settle 由 T04 终态围栏丢弃。无自动重试。
//   - 凭证绝不打日志：本文件任何日志只含固定类别 + HTTP 状态码，不插值 header/body/凭证。

import { z } from 'zod'
import type {
  AutoFigureGenerationCredential,
  AutoFigureGenerationInput,
  AutoFigureGenerationOptions,
  AutoFigureGenerationPort,
  AutoFigureGenerationResult,
  FigurePngBytes,
} from './port'
import { GENERATION_EXECUTION_ERROR } from './runner'

// ---------------------------------------------------------------------------
// 私有 wire 契约（代码侧单一来源）
// ---------------------------------------------------------------------------

// 请求 body：只含 V1 域输入 prompt（normalized）。凭证在 header，绝不在 body。
export const sidecarGenerateRequestSchema = z.object({
  prompt: z.string().min(1).max(4000),
})

// 成功响应：`png_base64` 是 base64 编码的 PNG 字节（对齐 upstream AutoFigure / Python 命名），
// 仅存在于本私有 wire 边界。evaluation 为 sidecar 已归一化的非敏感 JSON 字符串。
export const sidecarSuccessSchema = z.object({
  ok: z.literal(true),
  xml: z.string(),
  png_base64: z.string(),
  evaluation: z.string(),
})

// 失败响应：sidecar 生成失败（2xx 内）。`error` 为短不透明代码，仅供服务端诊断，绝不外泄。
export const sidecarFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string().optional(),
})

// 凭证 header 名（私有 sidecar 传输；值 = config.autofigure.llmKey）
export const SIDECAR_CREDENTIAL_HEADER = 'X-Autofigure-Api-Key'

// sidecar 生成端点路径（相对 sidecar 根；baseUrl 来自 config.autofigure.sidecarUrl）
export const SIDECAR_GENERATE_PATH = '/v1/generate'

// ---------------------------------------------------------------------------
// 传输 seam（可注入；默认全局 fetch，对齐 makeHttpHealthProbe 先例）
// ---------------------------------------------------------------------------

export type FetchImpl = typeof fetch

export interface HttpAutoFigureGenerationPortOptions {
  baseUrl: string
  fetchImpl?: FetchImpl
}

export class HttpAutoFigureGenerationPort implements AutoFigureGenerationPort {
  private readonly endpoint: string
  private readonly fetchImpl: FetchImpl

  constructor(options: HttpAutoFigureGenerationPortOptions) {
    // 装配期 fail-fast：enabled + 非法/空 baseUrl 立即暴露（new URL 抛错），不拖到首个请求。
    if (!options.baseUrl.trim()) {
      throw new Error(
        'AUTOFIGURE_SIDECAR_URL 未配置：AUTOFIGURE_ENABLED=true 时生产 adapter 需要 sidecar 地址',
      )
    }
    this.endpoint = new URL(SIDECAR_GENERATE_PATH, options.baseUrl.trim()).toString()
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  async generate(
    input: AutoFigureGenerationInput,
    credential: AutoFigureGenerationCredential,
    options?: AutoFigureGenerationOptions,
  ): Promise<AutoFigureGenerationResult> {
    // 请求体 = 契约 schema 校验后的域输入（normalized prompt）；凭证只进 header，绝不进 body。
    const body = JSON.stringify(sidecarGenerateRequestSchema.parse(input))
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [SIDECAR_CREDENTIAL_HEADER]: credential.apiKey,
    }

    let res: Response
    try {
      // redirect: 'error' —— 凭证绝不出本机：Node fetch 默认跟随 3xx，跨源重定向时 undici 只剥离
      // host/authorization/cookie/proxy-authorization，自定义 header（含 X-Autofigure-Api-Key）会
      // 原样重发到重定向目标（凭证外泄路径）。契约未定义重定向语义（单一 POST /v1/generate），
      // 任何 3xx → fetch 抛错 → 走 sidecar_unavailable → 稳定失败，凭证不跟随。
      // signal（T07 扩 Scope）：透传 runner 的 T04 超时 abort 信号——被中止 → fetch 抛
      // AbortError → 走下方 catch → 稳定失败；原因归一（JOB_TIMEOUT_REASON）由 runner 依据
      // signal.aborted 决定，adapter 不新增超时契约。
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: options?.signal,
      })
    } catch (err) {
      // sidecar 不可达 / 网络 / 传输失败：归一稳定失败。诊断日志只记固定类别，不插值 header/body。
      // T07 扩 Scope：T04 超时 abort 触发的 AbortError 记独立 `aborted` 类别——运营排障不把超时
      // 误读为不可达（终态原因仍由 runner 依 signal.aborted 归一 JOB_TIMEOUT_REASON，此处纯诊断
      // 分类，非新增错误态/超时契约）。
      this.warn(err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'sidecar_unavailable')
      return { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
    }

    if (!res.ok) {
      // 非 2xx（sidecar 错误面）：归一稳定失败。状态码进日志（可观测），响应体绝不落日志/errorMessage。
      this.warn(`non_2xx_status:${res.status}`)
      return { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (err) {
      // abort 若在 json() 读取中途触发（同 AbortError），同样归 `aborted` 诊断类别。
      this.warn(err instanceof Error && err.name === 'AbortError' ? 'aborted' : 'malformed_json')
      return { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
    }

    const success = sidecarSuccessSchema.safeParse(payload)
    if (success.success) {
      // png_base64 在本边界立即归一化为字节：base64 解码 → Prisma Bytes 等价。解码失败/空 →
      // 畸形失败（不把 sidecar 任意文本落 errorMessage）。
      const png = decodePng(success.data.png_base64)
      if (!png) {
        this.warn('invalid_png_base64')
        return { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
      }
      return { ok: true, xml: success.data.xml, png, evaluation: success.data.evaluation }
    }

    // 2xx 但非成功 shape：sidecar 结构化失败（ok:false）或畸形——统一归一稳定失败。
    if (sidecarFailureSchema.safeParse(payload).success) {
      this.warn('generation_failed')
    } else {
      this.warn('malformed_shape')
    }
    return { ok: false, errorMessage: GENERATION_EXECUTION_ERROR }
  }

  // 诊断日志：只含固定类别/状态码，绝不包含凭证、header、body、raw 响应文本（凭证卫生）。
  private warn(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(`[figures] sidecar generation failed: ${message}`)
  }
}

// base64 PNG → Prisma Bytes 等价（Uint8Array<ArrayBuffer>，精确对齐 FigurePngBytes）。
// new Uint8Array(typedArray) 复制到新 ArrayBuffer（类型即 Uint8Array<ArrayBuffer>）；Buffer 本体
// 是 Uint8Array<ArrayBufferLike>，直接透传会与 Prisma Bytes 严格类型不兼容。
// 校验（T07 已批准风险 B）：解码非空 + 以 PNG 8 字节签名（89 50 4E 47 0D 0A 1A 0A）开头——防截断/
// 错误 sidecar 产物以 succeeded 落库（否则只能新建 Figure 重生成）。解码空 / 非 PNG → null。
// 契约见 docs/autofigure/sidecar-contract.md §5。
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function decodePng(pngBase64: string): FigurePngBytes | null {
  if (!pngBase64) return null
  const decoded = Buffer.from(pngBase64, 'base64')
  if (decoded.length === 0) return null
  if (!PNG_SIGNATURE.every((b, i) => decoded[i] === b)) return null
  return new Uint8Array(decoded)
}
