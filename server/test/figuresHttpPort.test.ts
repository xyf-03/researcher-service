// T07 AutoFigure 生产 HTTP adapter 测试（docs/autofigure/tickets/T07-autofigure-http-adapter.md）。
//
// 覆盖私有 sidecar wire 契约的边界纪律：
//   - `png_base64` 只存在于私有 wire：success 响应用 png_base64（Python 侧命名），adapter 在边界
//     立即 base64 decode 为字节，返回的 AutoFigureGenerationResult 用 `png`（`png_base64` 字段名
//     绝不泄漏到应用层/调用方）。
//   - 凭证只在私有 header（X-Autofigure-Api-Key），绝不在 body；诊断日志不插值凭证/header/body。
//   - 所有 sidecar/网络/provider 失败归一为 GENERATION_EXECUTION_ERROR（T05 白名单单源）。
//   - 无 adapter-local 超时、无自动重试：一次生成恰好一次传输，失败不重试。
// 传输替身注入 fetchImpl seam（对齐 makeHttpHealthProbe 可注入先例），不依赖真 sidecar 可达。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HttpAutoFigureGenerationPort,
  SIDECAR_CREDENTIAL_HEADER,
  SIDECAR_GENERATE_PATH,
  type FetchImpl,
} from '../src/figures/httpPort'
import { GENERATION_EXECUTION_ERROR } from '../src/figures/runner'
import type { AutoFigureGenerationCredential, AutoFigureGenerationInput } from '../src/figures/port'

const CREDENTIAL: AutoFigureGenerationCredential = { apiKey: 'sk-test-secret-value' }
const INPUT: AutoFigureGenerationInput = { prompt: '  user  prompt  ' }

// 确定性 PNG 字节（带真实 magic 前缀，供精确字节回读断言）。
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64')

const SIDECAR_URL = 'http://autofigure:8796'
const EXPECTED_ENDPOINT = `${SIDECAR_URL}${SIDECAR_GENERATE_PATH}`

// 捕获每次传输的 (url, init)，返回结构化调用记录；handler 决定 fake 响应/抛错。
function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<unknown>,
): { fetchImpl: FetchImpl; calls: () => Array<{ url: string; init: RequestInit | undefined }> } {
  const recorded: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const u = url as string
    const i = init as RequestInit | undefined
    recorded.push({ url: u, init: i })
    return handler(u, i)
  }) as unknown as FetchImpl
  return { fetchImpl, calls: () => recorded }
}

// fake Response 最小形状：adapter 只消费 ok / status / json()。
function fakeResponse(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  }
}

function successBody(): unknown {
  return { ok: true, xml: '<mxfile><diagram/></mxfile>', png_base64: PNG_B64, evaluation: '{"ok":true}' }
}

function makePort(fetchImpl: FetchImpl): HttpAutoFigureGenerationPort {
  return new HttpAutoFigureGenerationPort({ baseUrl: SIDECAR_URL, fetchImpl })
}

describe('HttpAutoFigureGenerationPort（T07 私有 sidecar wire 契约）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('构造：endpoint = baseUrl + /v1/generate（尾部斜杠容忍，URL 规范化）', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(successBody()))
    const port = new HttpAutoFigureGenerationPort({ baseUrl: `${SIDECAR_URL}/`, fetchImpl })
    await port.generate(INPUT, CREDENTIAL)
    expect(calls()[0].url).toBe(EXPECTED_ENDPOINT)
  })

  it('构造：空/空白 baseUrl → 装配期 fail-fast（enabled 未配 sidecar 立即暴露）', () => {
    expect(() => new HttpAutoFigureGenerationPort({ baseUrl: '' })).toThrow(/AUTOFIGURE_SIDECAR_URL/)
    expect(() => new HttpAutoFigureGenerationPort({ baseUrl: '   ' })).toThrow(/AUTOFIGURE_SIDECAR_URL/)
  })

  it('POST 形状：method POST + 端点 /v1/generate + Content-Type json + redirect 拒绝', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(successBody()))
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res.ok).toBe(true)
    expect(calls()).toHaveLength(1)
    const call = calls()[0]
    expect(call.url).toBe(EXPECTED_ENDPOINT)
    expect(call.init?.method).toBe('POST')
    expect(call.init?.headers).toMatchObject({ 'Content-Type': 'application/json' })
    // 凭证不出本机：fetch 拒绝跟随重定向（3xx → 抛错 → 稳定失败，header 绝不到重定向目标）。
    expect(call.init?.redirect).toBe('error')
  })

  it('凭证不跟随重定向：3xx 响应 → fetch 抛错 → ok:false 稳定失败，无重定向请求发出', async () => {
    // redirect:'error' 下 Node fetch 遇 3xx 直接抛 TypeError（不会向 Location 发出第二个请求）——
    // 由传输替身模拟该行为：返回 302 即抛错，断言一次性失败。
    const { fetchImpl, calls } = makeFetch(async () => {
      throw new TypeError('redirect: error')
    })
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
    expect(calls()).toHaveLength(1)
    // 即使传输层未按约定抛错而是返回 302（宽松替身），adapter 仍归一非 2xx → 稳定失败。
    const { fetchImpl: lenient } = makeFetch(async () =>
      fakeResponse({}, { ok: false, status: 302 }),
    )
    const port2 = makePort(lenient)
    expect(await port2.generate(INPUT, CREDENTIAL)).toEqual({
      ok: false,
      errorMessage: GENERATION_EXECUTION_ERROR,
    })
  })

  it('凭证只走 header：X-Autofigure-Api-Key = credential.apiKey，body 绝不含凭证', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(successBody()))
    const port = makePort(fetchImpl)
    await port.generate(INPUT, CREDENTIAL)
    const { init } = calls()[0]
    const headers = init?.headers as Record<string, string>
    expect(headers[SIDECAR_CREDENTIAL_HEADER]).toBe(CREDENTIAL.apiKey)
    // body 是域输入 prompt（normalized JSON），凭证/额外字段绝不混入。
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: INPUT.prompt })
    expect(String(init?.body)).not.toContain(CREDENTIAL.apiKey)
  })

  it('signal 透传：options.signal 原样进 fetch init（T04 应用超时取消在飞执行的接线点）', async () => {
    const { fetchImpl, calls } = makeFetch(async () => fakeResponse(successBody()))
    const port = makePort(fetchImpl)
    const controller = new AbortController()
    const res = await port.generate(INPUT, CREDENTIAL, { signal: controller.signal })
    expect(res.ok).toBe(true)
    expect(calls()[0].init?.signal).toBe(controller.signal)
  })

  it('signal 中止 → 传输抛 AbortError → ok:false 稳定失败（adapter 不新增超时错误态/不重试）', async () => {
    // T07 已批准扩 Scope：signal 只透传（runner T04 超时触发 abort）。abort 后 fetch 抛 AbortError
    // → 统一归一 GENERATION_EXECUTION_ERROR。adapter 层无「超时」错误态——超时原因归一
    // （JOB_TIMEOUT_REASON）由 runner 依据 signal.aborted 决定，此契约在 adapter 不可见。
    const controller = new AbortController()
    const { fetchImpl, calls } = makeFetch(async (_url, init) => {
      if (init?.signal?.aborted) {
        throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
      }
      return fakeResponse(successBody())
    })
    const port = makePort(fetchImpl)
    controller.abort()
    const res = await port.generate(INPUT, CREDENTIAL, { signal: controller.signal })
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
    expect(calls()).toHaveLength(1) // 一次生成恰好一次传输，无重试
    // abort 记独立 `aborted` 诊断类别——运营不把超时误读为不可达（终态原因仍由 runner 归一）。
    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls.at(-1)?.[0])).toContain('aborted')
  })

  it('成功：2xx {ok:true, xml, png_base64, evaluation} → {ok:true, xml, png 字节, evaluation}', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse(successBody()))
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.xml).toBe('<mxfile><diagram/></mxfile>')
    expect(res.evaluation).toBe('{"ok":true}')
    // png_base64 在边界 decode 为字节：精确回读原始字节（含 PNG magic）。
    expect(Array.from(res.png)).toEqual(Array.from(PNG_BYTES))
    // `png_base64` 字段名绝不泄漏到归一化结果：成功 shape 用 `png`。
    expect('png_base64' in res).toBe(false)
    expect(res.png).toBeInstanceOf(Uint8Array)
  })

  it('成功：png_base64 字节精确性（任意字节经 base64 往返无损）', async () => {
    // T07 已批准风险 B：decodePng 校验 PNG 8 字节签名——测试载荷必须以真实 magic 开头。
    // 前缀 + 64 字节确定性差异载荷 → 字节级往返无损断言。
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...Array.from({ length: 64 }, (_, i) => (i * 7) % 256),
    ])
    // 覆盖式响应：自定义 png_base64
    const { fetchImpl, calls } = makeFetch(async () =>
      fakeResponse({
        ok: true,
        xml: 'x',
        png_base64: Buffer.from(bytes).toString('base64'),
        evaluation: 'e',
      }),
    )
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res.ok).toBe(true)
    if (res.ok) expect(Array.from(res.png)).toEqual(Array.from(bytes))
    expect(calls()).toHaveLength(1)
  })

  it('成功 shape 但 png_base64 解码为非 PNG 字节（magic 不匹配）→ invalid_png_base64 → ok:false 稳定失败', async () => {
    // T07 已批准风险 B：decodePng 校验 PNG 8 字节签名（89 50 4E 47 0D 0A 1A 0A）。可解码为
    // 非空字节但签名不匹配（非 PNG 产物/截断）同样拒绝——防错误 sidecar 产物以 succeeded 落库。
    const notPng = Buffer.from([0x01, 0x02, 0x03]).toString('base64')
    const { fetchImpl } = makeFetch(async () =>
      fakeResponse({ ok: true, xml: 'x', png_base64: notPng, evaluation: 'e' }),
    )
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('sidecar 不可达（fetch 抛错）→ ok:false GENERATION_EXECUTION_ERROR，无重试', async () => {
    const { fetchImpl, calls } = makeFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
    expect(calls()).toHaveLength(1) // 一次生成恰好一次传输，不自动重试
  })

  it('非 2xx → ok:false GENERATION_EXECUTION_ERROR', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse({ ok: false, error: 'boom' }, { ok: false, status: 500 }))
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('畸形 JSON（res.json 失败）→ ok:false GENERATION_EXECUTION_ERROR', async () => {
    const { fetchImpl } = makeFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }))
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('成功 shape 但 png_base64 空 → invalid_png_base64 → ok:false 稳定失败', async () => {
    const { fetchImpl } = makeFetch(async () =>
      fakeResponse({ ok: true, xml: 'x', png_base64: '', evaluation: 'e' }),
    )
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('成功 shape 但 png_base64 解码为空（非 base64 字母表字符）→ ok:false 稳定失败', async () => {
    // Node base64 解码宽松（丢弃非字母表字符）：纯无效字符串 `%%%###` 无任何 base64 字符 →
    // 解码为空 buffer → invalid_png_base64。绝不放行空产物字节。
    const { fetchImpl } = makeFetch(async () =>
      fakeResponse({ ok: true, xml: 'x', png_base64: '%%%###', evaluation: 'e' }),
    )
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('sidecar 结构化失败 {ok:false, error} → ok:false 稳定失败', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse({ ok: false, error: 'generation_failed' }))
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('畸形 shape（2xx 但既非成功也非失败）→ ok:false 稳定失败', async () => {
    const { fetchImpl } = makeFetch(async () => fakeResponse({ ok: true, xml: 'x' })) // 缺 png_base64/evaluation
    const port = makePort(fetchImpl)
    const res = await port.generate(INPUT, CREDENTIAL)
    expect(res).toEqual({ ok: false, errorMessage: GENERATION_EXECUTION_ERROR })
  })

  it('日志卫生：诊断日志只含固定类别，绝不插值凭证/header/body/raw 响应', async () => {
    const { fetchImpl } = makeFetch(async () => {
      throw new Error('network down')
    })
    const port = makePort(fetchImpl)
    await port.generate(INPUT, CREDENTIAL)
    expect(warnSpy).toHaveBeenCalled()
    for (const args of warnSpy.mock.calls) {
      const line = String(args[0])
      expect(line).toContain('sidecar generation failed')
      expect(line).not.toContain(CREDENTIAL.apiKey)
      expect(line).not.toContain(SIDECAR_CREDENTIAL_HEADER)
      expect(line).not.toContain(INPUT.prompt)
    }
  })
})
