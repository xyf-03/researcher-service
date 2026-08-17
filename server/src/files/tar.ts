// 极简 tar（ustar + GNU longname + PAX）解析/打包（#589 · ADR 0012 底层经 Docker getArchive/
// putArchive，控制面新增 tar 流解析）。无第三方依赖，只覆盖 Docker 侧实际产出的形态：
//   - 读：Docker 用 Go archive/tar 写，长路径/非 ASCII 名 → PAX 'x'（path=）或 GNU 'L'；
//     大文件 size/mtime 可能 base-256 编码（GNU）。类型 '0'/'\0' 文件、'5' 目录、'2' 符号链接。
//   - 写：putArchive 只放一个文件条目；名超 100 字节或含非 ASCII → 补 PAX 'x' 头。
//
// 解析宽容策略：只按结构取 name/type/size/mtime/data，不校验 chksum（信任 Docker 产物）。

export interface TarEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mtime: number // unix 秒
  data: Buffer | null // 仅 collectData 且未超 maxDataBytes 时收集
}

const BLOCK = 512
// [start, end) 字节区间（subarray 直用）
const HEADER_FIELD = {
  name: [0, 100] as const,
  size: [124, 136] as const,
  mtime: [136, 148] as const,
  typeflag: [156, 157] as const,
  magic: [257, 263] as const,
  prefix: [345, 500] as const,
} as const

// 读八进制或 base-256（GNU）：首字节高位 0x80/0xFF → base-256 大端有符号；否则去空白八进制。
// 导出供 dockerArchive 流式 probe 读单头字段（超大文件判型不必全量收集）。
export function parseNumeric(raw: Buffer): number {
  if (raw.length === 0) return 0
  const first = raw[0]
  if (first === 0x80 || first === 0xff) {
    // base-256：首字节 0x80 = 正数（值在高 7 位），0xFF = 负数
    let value = first & 0x7f
    for (let i = 1; i < raw.length; i++) value = value * 256 + raw[i]
    return first === 0xff ? -value : value
  }
  const text = raw.toString('latin1').replace(/\0/g, '').trim()
  if (text === '') return 0
  const n = Number.parseInt(text, 8)
  return Number.isNaN(n) ? 0 : n
}

// PAX 记录：`<len> <key>=<value>\n`（len 为整条记录字节数）
function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let off = 0
  while (off < data.length) {
    const sp = data.indexOf(0x20, off) // 空格分隔 len 与 key=value
    if (sp < 0) break
    const len = Number.parseInt(data.subarray(off, sp).toString('latin1'), 10)
    if (!Number.isFinite(len) || len <= 0 || off + len > data.length) break
    const record = data.subarray(sp + 1, off + len).toString('utf8')
    const eq = record.indexOf('=')
    if (eq > 0) records.set(record.slice(0, eq), record.slice(eq + 1).replace(/\n$/, ''))
    off += len
  }
  return records
}

export interface ParseTarOptions {
  // 文件条目是否收集 data（列目录用 false 只读头部，大文件不拉内容进内存）
  collectData?: boolean
  // collectData 时的单文件字节上限：超限不收集（data=null），调用方据此标 oversized
  maxDataBytes?: number
}

export function parseTar(buffer: Buffer, opts: ParseTarOptions = {}): TarEntry[] {
  const { collectData = false, maxDataBytes = Infinity } = opts
  const entries: TarEntry[] = []
  let off = 0
  let pendingName: string | null = null // GNU 'L' longname 传给下一个头
  let pendingPax = new Map<string, string>() // 'x' PAX 覆盖下一个头的 name/size

  while (off + BLOCK <= buffer.length) {
    const header = buffer.subarray(off, off + BLOCK)
    if (header.every((b) => b === 0)) break // 全零块 → 结束
    const typeflag = String.fromCharCode(header[HEADER_FIELD.typeflag[0]])

    // 元头（GNU longname / PAX）：自身无业务语义，但 data 段要跳过
    if (typeflag === 'L' || typeflag === 'x' || typeflag === 'g' || typeflag === 'K') {
      const metaSize = parseNumeric(header.subarray(...HEADER_FIELD.size))
      const data = buffer.subarray(off + BLOCK, off + BLOCK + metaSize)
      if (typeflag === 'L') pendingName = data.toString('utf8').replace(/\0.*$/, '')
      if (typeflag === 'x') pendingPax = parsePaxRecords(data)
      off += BLOCK + alignTo(metaSize)
      continue
    }

    let name: string
    const paxName = pendingPax.get('path')
    if (paxName !== undefined) {
      name = paxName
    } else if (pendingName !== null) {
      name = pendingName
    } else {
      const rawName = header.subarray(...HEADER_FIELD.name).toString('utf8').replace(/\0.*$/, '')
      const prefix = header.subarray(...HEADER_FIELD.prefix).toString('utf8').replace(/\0.*$/, '')
      name = prefix !== '' ? `${prefix}/${rawName}` : rawName
    }
    pendingName = null
    pendingPax = new Map()

    const size = pendingPax.get('size') !== undefined ? Number(pendingPax.get('size')) : parseNumeric(header.subarray(...HEADER_FIELD.size))
    const mtime = parseNumeric(header.subarray(...HEADER_FIELD.mtime))

    let entryType: TarEntry['type']
    if (typeflag === '5') entryType = 'directory'
    else if (typeflag === '2') entryType = 'symlink'
    else if (typeflag === '0' || typeflag === '\0') entryType = 'file'
    else entryType = 'other'

    let data: Buffer | null = null
    if (collectData && entryType === 'file' && size <= maxDataBytes) {
      data = buffer.subarray(off + BLOCK, off + BLOCK + size)
    }
    entries.push({ name, type: entryType, size, mtime, data })
    off += BLOCK + alignTo(size)
  }
  return entries
}

// 数据段对齐（含 size 本身）；导出供 dockerArchive 流式跳过元头数据段
export function alignTo(size: number): number {
  return ((BLOCK - (size % BLOCK)) % BLOCK) + size
}

// ---- 写侧：单文件 tar（putArchive 用） ----

function encodeOctal(value: number): string {
  // 11 位八进制（GNU 宽字段）：不足前补空格；0 特判全零（tar 规范 size 0 时字段全零）
  if (value === 0) return '00000000000'
  return '0'.repeat(11 - value.toString(8).length) + value.toString(8)
}

// PAX 记录：`<len> <key>=<value>\n`，len = 整条记录字节数（含 len 数字、空格、body）。
// 数字与总长互相依赖（定点）：total = digits(total) + 1 + bodyLen。
function paxRecord(key: string, value: string): Buffer {
  const body = `${key}=${value}\n`
  const bodyLen = Buffer.byteLength(body)
  let total = bodyLen + 10 // 起步猜测（必然 ≥ 真值，向下收敛）
  for (;;) {
    const next = String(total).length + 1 + bodyLen
    if (next === total) break
    total = next
  }
  return Buffer.from(`${total} ${body}`, 'utf8')
}

// 造单个文件条目的 tar（putArchive 推进容器）。name 超 100 字节或含非 ASCII → 前置 PAX 'x' 头
// （对齐 Go archive/tar：USTAR 只收纯 ASCII ≤100 字节，否则自动降级 PAX）。
export function createTarFile(name: string, content: Buffer, mtimeSec = Math.floor(Date.now() / 1000)): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const needsPax = nameBytes.length > 100 || nameBytes.some((b) => b >= 0x80)
  const chunks: Buffer[] = []
  if (needsPax) {
    const pax = paxRecord('path', name)
    chunks.push(headerOf('', pax.length, 'x', mtimeSec))
    chunks.push(pax, Buffer.alloc(alignTo(pax.length) - pax.length))
  }
  chunks.push(headerOf(nameBytes.length <= 100 ? name : '', content.length, '0', mtimeSec))
  chunks.push(content)
  const pad = alignTo(content.length) - content.length
  if (pad > 0) chunks.push(Buffer.alloc(pad))
  chunks.push(Buffer.alloc(BLOCK * 2)) // 结束零块
  return Buffer.concat(chunks)
}

function headerOf(name: string, size: number, typeflag: string, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644', 100, 'utf8') // mode 0644
  h.write('0000000', 108, 'utf8') // uid 0
  h.write('0000000', 116, 'utf8') // gid 0
  h.write(encodeOctal(size), 124, 'utf8')
  h.write(encodeOctal(mtime), 136, 'utf8')
  h.write(typeflag, 156, 'utf8')
  h.write('ustar', 257, 'utf8')
  h.write('00', 263, 'utf8')
  h.write('root', 265, 'utf8')
  h.write('root', 297, 'utf8')
  // chksum（148-155）：字段先置空格（tar 规范），求全头字节和，写 6 位八进制 + NUL + 空格
  h.fill(0x20, 148, 156)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += h[i]
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8')
  return h
}
