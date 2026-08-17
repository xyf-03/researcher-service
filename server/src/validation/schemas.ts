import { z } from 'zod'
import {
  API_CHOICES,
  API_KEY_ENV_ID_REGEX,
  ALLOWED_API_KEY_ENV_IDS,
  MODEL_INPUT_MODALITIES,
  PROVIDER_ID_REGEX,
} from '../models/values'

// 请求体 schema（zod）。校验失败 → 90002 + flatten().fieldErrors（{field:[errors]}）。
// username 格式：字母/数字/下划线/连字符，3–30 字符（近似 Django UnicodeUsernameValidator，更严）。
export const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,30}$/

// bcryptjs 截断 >72 字节的输入（72 字节后丢弃）。若不对密码设 UTF-8 字节上限，首 72 字节
// 相同而后续不同的两个密码可互登（碰撞面）。共享此校验：login / 建号 / 改密一律拒绝 >72 字节。
// Codex #342 四轮 P2。
const BYTE72_MAX = 72
const BYTE72_ERR = `密码不能超过 ${BYTE72_MAX} 字节`

function max72Bytes(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') <= BYTE72_MAX
}

export const loginSchema = z.object({
  username: z.string().min(1, '不能为空'),
  password: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
})

export const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1, '不能为空').refine(max72Bytes, BYTE72_ERR),
  newPassword: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
})

// 建账号（admin register / users POST 共用）：用户名格式 + 密码≥8 + 可选 email + 可选配额。
export const userCreateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, '用户名仅允许字母、数字、下划线、连字符（3-30 位）'),
  password: z.string().min(8, '至少 8 个字符').refine(max72Bytes, BYTE72_ERR),
  email: z.string().email('email 格式非法').optional(),
  maxContainers: z.number().int().optional(),
})

// 改账号（users PATCH）：可改 active / 配额。
export const userPatchSchema = z.object({
  isActive: z.boolean().optional(),
  maxContainers: z.number().int().optional(),
})

// 容器名 DNS-label（#334 / 平移 NAME_VALIDATOR）：小写字母开头，3–30 位，仅 [a-z0-9-]。
// 防路径分隔符 / .. / 空格 / 大写（同时防 instances/<name>/ 目录穿越与 docker-name 注入）。
export const CONTAINER_NAME_REGEX = /^[a-z][a-z0-9-]{2,29}$/

// 建容器（containers POST）：仅需 name（端口/token/home 由编排器决定）。校验失败 → 90002 + data.name。
export const containerCreateSchema = z.object({
  name: z
    .string()
    .regex(CONTAINER_NAME_REGEX, 'name 须以小写字母开头，3–30 位，仅含小写字母、数字、连字符'),
})

// AutoFigure（T01，docs/autofigure/tickets/T01-authenticated-figure-creation.md）：
// Figure 创建请求体。仅 prompt 一项；ownerId 不接收——zod object 默认 strip 未知字段，客户端
// 随请求提交的 userId（若有）被丢弃，绝不作为归属来源（ownerId 只来自认证身份，见 figures/routes.ts）。
// trim 对齐 modelProviderWriteSchema.base_url 先例（纯空白语义为空 → 拒）；上限 4000 字符。
export const figureCreateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt 不能为空').max(4000, 'prompt 过长（≤4000 字符）'),
})

// 建/改 model provider（models POST/PUT，#336）：snake_case wire（平移 Django
// ModelProviderWriteSerializer）。provider_id / api_key_env_id 经格式 + 成员校验（r28 §1），
// api 限两值（r28 §1.3），models 至少一条且每条含非空 id（无 model 无法派生默认模型引用）。
// models 条目形状校验（#366 codex 三轮 P2）：已知字段类型严格校验（name/reasoning/input/cost/
// contextWindow/maxTokens，对齐前端 ModelEntryDTO），未知扩展字段 passthrough 透传（前端表单
// 收集的其余字段原样保留）。原来 `z.record(z.string(), z.unknown())` 让 {id:'m', name:{}} 这种
// 非法形状入库——ProviderConfigBuilder 把 name 对象原样落盘为 alias/model 名（应为 string）→
// 热加载拒绝、运行时落后 DB。入站校验拒绝，生成文件才可能符合 OpenClaw 形状。
// base_url trim 后校验（#366 codex P2）：zod min(1) 不 trim，纯空格 '   ' 语义为空仍通过——
// 对齐 Django CharField 默认 trim_whitespace，防「空 baseUrl 入库 + 写盘报成功热加载」。
// 校验失败 → 90002 + 各字段明细（api_key_env_id 非法格式/未注入 env 同入 data.api_key_env_id）。
export const modelProviderWriteSchema = z.object({
  provider_id: z
    .string()
    .regex(PROVIDER_ID_REGEX, 'provider_id 须以小写字母开头，1–64 位，仅含小写字母、数字、连字符'),
  api: z.enum(API_CHOICES),
  base_url: z.string().trim().min(1, 'base_url 不能为空').max(512, 'base_url 过长'),
  api_key_env_id: z
    .string()
    .regex(API_KEY_ENV_ID_REGEX, 'api_key_env_id 须大写字母开头，仅含大写字母、数字、下划线（1–128 位）')
    .refine(
      (v) => ALLOWED_API_KEY_ENV_IDS.has(v),
      'api_key_env_id 须为容器已注入的 env（当前仅：LLM_API_KEY）',
    ),
  auth_header: z.boolean().default(true),
  models: z
    .array(
      z
        .object({
          id: z.string().min(1, '每条 model 须含非空 id'),
          name: z.string().optional(),
          reasoning: z.boolean().optional(),
          // #366 codex 四轮 P2：input 限 r28 §1.2 枚举（text/image/audio/video/pdf）——非法取值
          // （如 "bogus"）原样落盘会被 OpenClaw 热加载校验拒绝，DB 却已提交报成功。
          input: z.array(z.enum(MODEL_INPUT_MODALITIES)).optional(),
          cost: z
            .object({
              input: z.number(),
              output: z.number(),
              cacheRead: z.number(),
              cacheWrite: z.number(),
            })
            .optional(),
          contextWindow: z.number().optional(),
          maxTokens: z.number().optional(),
        })
        .passthrough(), // 未知扩展字段透传（前端表单收集的其余字段原样保留）
    )
    .min(1, '须至少一条 model（用于派生默认模型引用）')
    // #366 codex 五轮 P2：同 provider 内 model id 须唯一。重复 id 让 ProviderConfigBuilder 生成相同
    // <pid>/<mid> ref —— primary 自指进 fallbacks + aliases 键覆盖，盘上配置歧义、DB 却报成功
    // （与 input 枚举同根：入站拒，生成文件才可能符合 OpenClaw 形状）。path 落 models → 90002 明细。
    .refine(
      (models) => new Set(models.map((m) => String(m.id))).size === models.length,
      { message: '同 provider 内 model id 须唯一', path: ['models'] },
    ),
})
