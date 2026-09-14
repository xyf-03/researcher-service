// seam: chat/attachments —— 附件采集/校验/组装纯函数模块（#459-T1 #462）。
// 契约：采集层（#463 composer 三通道）产生的原始附件 → 类型过滤（白名单 image/audio/video）→
// 体积校验（按字节估算 base64 膨胀，非图片 ≤700KB，图片压缩后同限）→ 组装官方 chat.send 的
// attachments[] 形状。超限附件拒发（返回 rejected 供 UI 提示「文件过大」）；非法输入返回空数组。

import { describe, expect, it, vi } from 'vitest'
import {
  buildAttachments,
  compressImageFile,
  fileToRawAttachment,
  fitWithin,
  attachmentTypeOf,
  editorAttachmentToRaw,
  isAllowedAttachmentType,
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_EDGE,
  MAX_TOTAL_BYTES,
  type CompressEngine,
  type RawAttachment,
} from './attachments'

// 造字节数可控的 content（base64 体积 = ceil(n/3)*4 决定帧上限，与文件字节数区分）。
// content 用重复字符便于估算 base64 长度（不影响校验逻辑——校验只看字节数）。
function raw(overrides: Partial<RawAttachment> = {}): RawAttachment {
  return {
    mimeType: 'image/png',
    fileName: 'shot.png',
    content: 'a'.repeat(100),
    ...overrides,
  }
}

describe('isAllowedAttachmentType（白名单 image/audio/video + 文档 mime）', () => {
  it('放行 image/audio/video 前缀', () => {
    expect(isAllowedAttachmentType('image/png')).toBe(true)
    expect(isAllowedAttachmentType('image/jpeg')).toBe(true)
    expect(isAllowedAttachmentType('image/webp')).toBe(true)
    expect(isAllowedAttachmentType('audio/mpeg')).toBe(true)
    expect(isAllowedAttachmentType('video/mp4')).toBe(true)
  })

  it('放行文档 mime（与 ChatMessageItem SAFE_DOCUMENT_MIMES 对齐 + text/markdown）', () => {
    expect(isAllowedAttachmentType('application/pdf')).toBe(true)
    expect(isAllowedAttachmentType('text/plain')).toBe(true)
    expect(isAllowedAttachmentType('text/markdown')).toBe(true)
    expect(isAllowedAttachmentType('text/csv')).toBe(true)
    expect(isAllowedAttachmentType('application/json')).toBe(true)
    expect(isAllowedAttachmentType('application/zip')).toBe(true)
    expect(isAllowedAttachmentType('application/gzip')).toBe(true)
    expect(isAllowedAttachmentType('application/x-tar')).toBe(true)
  })

  it('拦截白名单外类型（octet-stream 等未知二进制、office 渲染卡不认的 mime）', () => {
    expect(isAllowedAttachmentType('application/octet-stream')).toBe(false)
    expect(isAllowedAttachmentType('application/msword')).toBe(false)
    expect(isAllowedAttachmentType('image/svg+xml')).toBe(true) // image 前缀放行（发送侧不设防 mime，渲染侧 SAFE 排除 svg）
    expect(isAllowedAttachmentType('')).toBe(false)
    expect(isAllowedAttachmentType(undefined)).toBe(false)
  })
})

describe('attachmentTypeOf（mime → 官方附件块类型）', () => {
  it('image/audio/video 主段直映射', () => {
    expect(attachmentTypeOf('image/png')).toBe('image')
    expect(attachmentTypeOf('audio/mpeg')).toBe('audio')
    expect(attachmentTypeOf('video/mp4')).toBe('video')
  })

  it('文档 mime → document（官方第 4 块类型，渲染下载卡）', () => {
    expect(attachmentTypeOf('application/pdf')).toBe('document')
    expect(attachmentTypeOf('text/plain')).toBe('document')
    expect(attachmentTypeOf('text/markdown')).toBe('document')
    expect(attachmentTypeOf('application/zip')).toBe('document')
  })

  it('白名单外 → null', () => {
    expect(attachmentTypeOf('application/octet-stream')).toBeNull()
    expect(attachmentTypeOf('')).toBeNull()
    expect(attachmentTypeOf(undefined)).toBeNull()
  })
})

// #694：回退 / 分叉响应 `editorAttachments` 元素（wire `{mimeType, data}`）→ RawAttachment。
describe('editorAttachmentToRaw（网关修改类 RPC 的编辑器附件 → RawAttachment）', () => {
  it('图片：type 派生 + content 原样纯 base64 + sizeBytes 按解码字节数反推（非 base64 长度）', () => {
    expect(editorAttachmentToRaw({ mimeType: 'image/png', data: 'AAAA' })).toEqual({
      type: 'image',
      mimeType: 'image/png',
      content: 'AAAA',
      sizeBytes: 3, // 4 个字符 → 3 字节（padding 计）
    })
  })

  it('白名单外 mime → null（调用方丢弃，不把渲染不出的块塞进预览条）', () => {
    expect(editorAttachmentToRaw({ mimeType: 'application/octet-stream', data: 'AAAA' })).toBeNull()
    expect(editorAttachmentToRaw({ mimeType: '', data: 'AAAA' })).toBeNull()
  })

  it('文档 mime → document（回填后仍能经发送校验，不被当未知类型拒发）', () => {
    const att = editorAttachmentToRaw({ mimeType: 'application/pdf', data: 'AAAA' })
    expect(att?.type).toBe('document')
    expect(buildAttachments([att!]).rejected).toHaveLength(0)
  })

  it('空 data → sizeBytes 0（不臆造体积；下游按 0 字节放行）', () => {
    expect(editorAttachmentToRaw({ mimeType: 'image/png', data: '' })).toMatchObject({ sizeBytes: 0 })
  })
})

describe('MAX_ATTACHMENT_BYTES（体积上限，base64 膨胀核算）', () => {
  it('非图片 ≤700KB：ceil(716800/3)*4 ≈ 955KB < 1MiB 隧道帧上限，留余量', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(700 * 1024)
    // base64 膨胀 4/3：ceil(716800/3)*4 = 955,734B ≈ 0.91MiB < 1MiB（TUNNEL_MAX_PAYLOAD）
    expect(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4).toBeLessThan(1024 * 1024)
  })

  it('MAX_TOTAL_BYTES（合计预算）：与单附件同值——chat.send 一条 WS 帧，1MiB 上限内', () => {
    expect(MAX_TOTAL_BYTES).toBe(MAX_ATTACHMENT_BYTES)
  })
})

describe('buildAttachments（组装 chat.send attachments[]）', () => {
  it('空输入 → 空数组（不带附件输入时）', () => {
    expect(buildAttachments([])).toEqual({ attachments: [], rejected: [] })
    expect(buildAttachments(undefined)).toEqual({ attachments: [], rejected: [] })
    expect(buildAttachments(null)).toEqual({ attachments: [], rejected: [] })
  })

  it('单个合法附件 → 透传官方字段形状（type/mimeType/fileName/content/sizeBytes/width/height）', () => {
    const out = buildAttachments([
      raw({ type: 'image', sizeBytes: 1234, width: 800, height: 600 }),
    ])
    expect(out.rejected).toEqual([])
    expect(out.attachments).toEqual([
      {
        type: 'image',
        mimeType: 'image/png',
        fileName: 'shot.png',
        content: 'a'.repeat(100),
        sizeBytes: 1234,
        width: 800,
        height: 600,
      },
    ])
  })

  it('多个附件全合法 → 全放行', () => {
    const out = buildAttachments([
      raw({ fileName: 'a.png' }),
      raw({ mimeType: 'audio/mpeg', fileName: 'b.mp3' }),
      raw({ mimeType: 'video/mp4', fileName: 'c.mp4' }),
    ])
    expect(out.attachments).toHaveLength(3)
    expect(out.rejected).toEqual([])
  })

  it('白名单外类型 → 拒发（不进 attachments，进 rejected）；文档 mime 放行为 document', () => {
    const out = buildAttachments([
      raw({ fileName: 'ok.png' }),
      raw({ mimeType: 'application/pdf', fileName: 'doc.pdf', type: 'document' }),
      raw({ mimeType: 'application/octet-stream', fileName: 'bin.dat' }),
    ])
    expect(out.attachments).toHaveLength(2)
    expect(out.attachments.map((a) => a.fileName)).toEqual(['ok.png', 'doc.pdf'])
    expect(out.attachments[1].type).toBe('document')
    expect(out.rejected).toEqual([
      expect.objectContaining({ fileName: 'bin.dat', reason: 'type' }),
    ])
  })

  it('超限（>700KB）→ 拒发并标记 size', () => {
    const over = raw({ fileName: 'big.mp4', mimeType: 'video/mp4', content: 'x'.repeat(MAX_ATTACHMENT_BYTES + 1) })
    const out = buildAttachments([over])
    expect(out.attachments).toEqual([])
    expect(out.rejected).toEqual([
      expect.objectContaining({ fileName: 'big.mp4', reason: 'size' }),
    ])
  })

  it('恰在边界（==700KB）→ 放行（base64 后仍 <1MiB）', () => {
    const at = raw({ content: 'x'.repeat(MAX_ATTACHMENT_BYTES) })
    const out = buildAttachments([at])
    expect(out.attachments).toHaveLength(1)
    expect(out.rejected).toEqual([])
  })

  it('混合：合法 + 超类型 + 超体积 → 各归各位', () => {
    const out = buildAttachments([
      raw({ fileName: 'ok.png' }),
      raw({ mimeType: 'application/octet-stream', fileName: 'bin.dat' }),
      raw({ fileName: 'big.mp4', mimeType: 'video/mp4', content: 'x'.repeat(MAX_ATTACHMENT_BYTES + 1) }),
    ])
    expect(out.attachments.map((a) => a.fileName)).toEqual(['ok.png'])
    expect(out.rejected.map((r) => ({ name: r.fileName, reason: r.reason }))).toEqual([
      { name: 'bin.dat', reason: 'type' },
      { name: 'big.mp4', reason: 'size' },
    ])
  })

  it('合计体积超帧预算 → 超出部分拒发（chat.send 帧在一条 WS 帧，合计才决定帧体积）', () => {
    // 每个单附件 ≤700KB 合法，但两个 600KB 合计 1.2MB 超 MAX_TOTAL_BYTES（帧 1MiB 上限留余量）
    const out = buildAttachments([
      raw({ fileName: 'a.png', content: 'x'.repeat(600 * 1024) }),
      raw({ fileName: 'b.png', content: 'y'.repeat(600 * 1024) }),
    ])
    // 先到的放行，后续超合计预算的拒发
    expect(out.attachments.map((a) => a.fileName)).toEqual(['a.png'])
    expect(out.rejected).toEqual([expect.objectContaining({ fileName: 'b.png', reason: 'size' })])
  })

  it('合计恰在预算内 → 全放行', () => {
    const out = buildAttachments([
      raw({ fileName: 'a.png', content: 'x'.repeat(300 * 1024) }),
      raw({ fileName: 'b.png', content: 'y'.repeat(300 * 1024) }),
    ])
    expect(out.attachments).toHaveLength(2)
    expect(out.rejected).toEqual([])
  })

  it('content 为自由形状（0 信任）：字符串/base64 之外的形状不被体积校验误判', () => {
    // content 非 string 时不按 string 长度算，按 sizeBytes（若提供）兜底；均无则视为 0 放行
    const out = buildAttachments([
      raw({ content: { someBlob: true } as unknown as string, sizeBytes: 10 }),
    ])
    expect(out.attachments).toHaveLength(1)
    expect(out.rejected).toEqual([])
  })

  it('缺省可选字段（type/sizeBytes/width/height）→ 透传 undefined（官方 schema 全可选）', () => {
    const out = buildAttachments([raw({ fileName: 'minimal.png' })])
    expect(out.attachments[0]).toEqual({
      type: undefined,
      mimeType: 'image/png',
      fileName: 'minimal.png',
      content: 'a'.repeat(100),
      sizeBytes: undefined,
      width: undefined,
      height: undefined,
    })
  })
})

// ---- #459-T2 #463：采集层（压缩 + 文件转换）纯函数 ----

describe('fitWithin（最长边降采样几何，不放大）', () => {
  it('宽图超 1280 → 按比例缩到长边 1280', () => {
    expect(fitWithin(2560, 1280, MAX_IMAGE_EDGE)).toEqual({ width: 1280, height: 640 })
  })

  it('高图超 1280 → 按比例缩到长边 1280', () => {
    expect(fitWithin(720, 2560, MAX_IMAGE_EDGE)).toEqual({ width: 360, height: 1280 })
  })

  it('长边恰 1280 → 原样（不缩不放大）', () => {
    expect(fitWithin(1280, 800, MAX_IMAGE_EDGE)).toEqual({ width: 1280, height: 800 })
  })

  it('小于 1280 → 不放大，原样返回', () => {
    expect(fitWithin(800, 600, MAX_IMAGE_EDGE)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(100, 50, MAX_IMAGE_EDGE)).toEqual({ width: 100, height: 50 })
  })

  it('缩放结果取整（像素为整数）', () => {
    const out = fitWithin(2000, 1001, MAX_IMAGE_EDGE)
    expect(Number.isInteger(out.width)).toBe(true)
    expect(Number.isInteger(out.height)).toBe(true)
    expect(Math.max(out.width, out.height)).toBe(MAX_IMAGE_EDGE)
  })

  it('极端宽高比 → 短边下限 1px（不塌缩成 0 面积 canvas）', () => {
    // 1×10000 全页截图：scale=0.128，短边 round(0.128)=0 → 须钳到 ≥1
    const out = fitWithin(1, 10000, MAX_IMAGE_EDGE)
    expect(out.height).toBe(MAX_IMAGE_EDGE)
    expect(out.width).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(out.width)).toBe(true)
  })

  it('0 尺寸输入（无 intrinsic 尺寸的 SVG）→ 不产出 0 边', () => {
    const out = fitWithin(0, 0, MAX_IMAGE_EDGE)
    expect(out.width).toBeGreaterThanOrEqual(1)
    expect(out.height).toBeGreaterThanOrEqual(1)
  })
})

// 假压缩引擎：记录调用（缩放几何 + 输出 mime/quality），回固定 dataURL——断言纯逻辑编排，
// 不断言真实像素（canvas 在 jsdom 为 null，真实缩放由浏览器端引擎完成）。
function fakeEngine(overrides: Partial<CompressEngine> = {}): CompressEngine {
  return {
    loadSize: vi.fn(async () => ({ width: 2560, height: 1280 })),
    render: vi.fn(async (_file: File, w: number, h: number, mime: string) =>
      `data:${mime};base64,${'z'.repeat(w + h)}`),
    ...overrides,
  }
}

function imgFile(name = 'shot.png', type = 'image/png', bytes = 2048): File {
  return new File(['x'.repeat(bytes)], name, { type })
}

describe('compressImageFile（图片压缩 → RawAttachment）', () => {
  it('大图 → 缩放至长边 1280，content 为纯 base64（剥 dataURL 前缀）+ 尺寸 + sizeBytes 真实字节', async () => {
    const engine = fakeEngine()
    const out = await compressImageFile(imgFile(), engine)
    expect(engine.render).toHaveBeenCalledWith(
      expect.any(File), MAX_IMAGE_EDGE, 640, expect.stringMatching(/^image\/(jpeg|webp)$/),
    )
    expect(out.type).toBe('image')
    expect(out.mimeType).toMatch(/^image\/(jpeg|webp)$/)
    expect(out.fileName).toBe('shot.png')
    expect(out.width).toBe(MAX_IMAGE_EDGE)
    expect(out.height).toBe(640)
    // #4 协议契约（r13 §2.4）：content 是纯 base64，不带 data:...;base64, 前缀
    expect(typeof out.content).toBe('string')
    expect(out.content).not.toContain('data:')
    expect(out.content).not.toContain('base64,')
    // #7 sizeBytes 单位统一：真实解码字节数（≈ base64 长度 ×3/4），非 base64 字符串长度
    // fakeEngine dataURL payload = 'z'.repeat(1280+640=1920) → 真实字节 ≈ 1920*3/4 = 1440
    expect(out.sizeBytes).toBe(1440)
  })

  it('小图（≤1280）→ 不放大：render 用原始尺寸', async () => {
    const engine = fakeEngine({ loadSize: vi.fn(async () => ({ width: 800, height: 600 })) })
    await compressImageFile(imgFile(), engine)
    expect(engine.render).toHaveBeenCalledWith(expect.any(File), 800, 600, expect.any(String))
  })

  it('默认引擎（不传 engine）走浏览器 canvas 实现——存在即可调用', () => {
    // jsdom 无 canvas，此用例仅钉死「engine 可选」签名（真实 canvas 路径在浏览器运行）。
    expect(typeof compressImageFile).toBe('function')
  })
})

describe('fileToRawAttachment（非图片/通用文件 → RawAttachment）', () => {
  it('content 为纯 base64（剥 dataURL 前缀），带 fileName/mimeType/sizeBytes 真实字节/type', async () => {
    const f = new File(['a'.repeat(100)], 'clip.mp4', { type: 'video/mp4' })
    const out = await fileToRawAttachment(f)
    expect(out.type).toBe('video')
    expect(out.mimeType).toBe('video/mp4')
    expect(out.fileName).toBe('clip.mp4')
    expect(out.sizeBytes).toBe(100) // 真实字节（file.size）
    expect(typeof out.content).toBe('string')
    // #4 协议契约：纯 base64，无 data: 前缀
    expect(out.content).not.toContain('data:')
    expect(out.content).not.toContain('base64,')
  })

  it('type 从 mimeType 主段派生（image/audio/video）', async () => {
    expect((await fileToRawAttachment(new File(['a'], 's.mp3', { type: 'audio/mpeg' }))).type).toBe('audio')
  })

  it('文档 mime → type=document（官方第 4 块类型）', async () => {
    const pdf = await fileToRawAttachment(new File(['a'], 'paper.pdf', { type: 'application/pdf' }))
    expect(pdf.type).toBe('document')
    expect(pdf.mimeType).toBe('application/pdf')
  })

  it('浏览器无注册 mime 的文件（如 .md，File.type 为空串）→ 按扩展名派生 mime', async () => {
    const md = await fileToRawAttachment(new File(['# 标题'], 'NOTES.md', { type: '' }))
    expect(md.mimeType).toBe('text/markdown')
    expect(md.type).toBe('document')
    const txt = await fileToRawAttachment(new File(['hi'], 'a.txt', { type: '' }))
    expect(txt.mimeType).toBe('text/plain')
    expect(txt.type).toBe('document')
  })

  it('无 mime 且扩展名不可识别 → mimeType 空 → 白名单拒（下游 buildAttachments 拦）', async () => {
    const bin = await fileToRawAttachment(new File([new Uint8Array([1])], 'x.weird', { type: '' }))
    expect(bin.mimeType).toBe('')
    expect(isAllowedAttachmentType(bin.mimeType)).toBe(false)
  })
})
