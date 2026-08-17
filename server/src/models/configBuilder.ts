// ProviderConfigBuilder —— openclaw.json models.providers 合并纯逻辑（平移 backend/models/config_builder.py，#336）。
//
// 纯领域逻辑（无 IO / 无 Prisma）：消费 ProviderSpec 列表，把 DB model provider 合并进
// base openclaw.json cfg，供 ModelConfigWriter 经 FileArchive.putArchive 写容器内
//（#591 静态 config：写盘后重启容器生效，OpenClaw 加载时校验形状）。
//
// 规则（r28）：
// - 空 providers → base 透传（P0 兼容：无托管 provider 时沿用模板默认 minimax）。
// - 非空 → DB provider **全量替换** models.providers（DB 单一来源）；agents.defaults.model
//   按入参序重算 primary/fallbacks 与 agents.defaults.models 别名 —— 删除任一 provider
//   后天然无悬空引用（级联清理）。
// - apiKey 永远写 SecretRef {source:env, provider:default, id:<env_id>}，**不落明文**（r28 §2）。
// - api 取值（openai-completions / anthropic-messages）由 serializer 校验后经 ProviderSpec.api 原样写入。

import type { ProviderApiWire } from './values'
import { assertPlainObject } from '../containers/configRenderer'
import { ConfigurationError } from '../containers/errors'

// SecretRef.provider 固定引用 deploy/openclaw.json 既有的 secrets.providers.default（r28 §2.1）
export const DEFAULT_SECRET_PROVIDER = 'default'

// ProviderConfigBuilder 的输入契约（与 Prisma ModelProvider 行解耦，便于纯单测）。
// models 为已校验的模型条目列表，每项形如
// {id, name, reasoning, input[], cost{input,output,cacheRead,cacheWrite}, contextWindow, maxTokens}
// （r28 §1.2，落盘时按 provider 形态原样输出）；id 必填非空（API 层已校验）。
export interface ProviderSpec {
  providerId: string
  api: ProviderApiWire
  baseUrl: string
  apiKeyEnvId: string
  authHeader: boolean
  models: Array<Record<string, unknown>>
}

// 把 base openclaw.json cfg 与 DB providers 合并为可写盘的 cfg dict（纯函数，不 mutate 入参）。
export class ProviderConfigBuilder {
  build(baseCfg: Record<string, unknown>, providers: readonly ProviderSpec[]): Record<string, unknown> {
    // 深拷贝：返回新对象，绝不 mutate 调用方 base（对齐 Python copy.deepcopy）
    const cfg = structuredClone(baseCfg)
    if (providers.length === 0) return cfg

    // #366 codex P2：非空 providers 必写 apiKey SecretRef(provider:default)（下方 renderProvider），
    // 先确认模板 secrets.providers.default 存在——否则写出的配置引用不存在的 secret provider，
    // openclaw 解析凭证失败、热加载被拒，但 DB 已提交报成功 = 不可用配置。缺失 → 90003
    // （复用 ConfigurationError，与意见 4 的模板错误转译同一条配置失败信封）。
    // #366 codex 三轮 P2：改用 assertPlainObject（显式排数组）——`typeof [] === 'object'` 逃过
    // 旧检查，default 上挂 SecretRef 属性被 JSON.stringify 丢弃 → 引用不存在的 secret provider。
    const secrets = cfg.secrets as { providers?: Record<string, unknown> } | undefined
    const defaultSecretProvider = secrets?.providers?.default
    assertPlainObject(defaultSecretProvider, 'OPENCLAW_TEMPLATE_JSON (secrets.providers.default)')
    // #366 codex 五轮 P2：仅断言 default 是对象不够——renderProvider 恒发 apiKey SecretRef
    // {source:'env', provider:'default'}，default.source 须为 env。模板把 default 配成 file/exec
    // （或缺 source）时，写出的 SecretRef 与引用的 secret provider 声明冲突 → OpenClaw 凭证解析
    // 失败、热加载被拒，DB 却已提交报成功 = 不可用配置。与「default 缺失」同根，缺省即拒。
    if ((defaultSecretProvider as Record<string, unknown>).source !== 'env') {
      throw new ConfigurationError('OPENCLAW_TEMPLATE_JSON (secrets.providers.default.source)')
    }

    const providersMap: Record<string, Record<string, unknown>> = {}
    const refs: string[] = [] // "<pid>/<mid>" 按序
    const aliases: Record<string, Record<string, string>> = {}
    for (const spec of providers) {
      providersMap[spec.providerId] = this.renderProvider(spec)
      for (const model of spec.models) {
        const ref = `${spec.providerId}/${String(model.id)}`
        refs.push(ref)
        aliases[ref] = { alias: (model.name as string | undefined) || String(model.id) }
      }
    }
    // #366 codex 三轮 P2：合并前断言 models/agents/agents.defaults 为普通对象——模板若给 JSON 合法但
    // 形状错误的值（如 "models": []），`cfg.models ??= {}` 拿到数组后挂 named property，JSON.stringify
    // 只序列化 index 属性 → provider 与 default-model 引用静默丢失、DB 却报成功。渲染器只校验了
    // gateway 链，这里是合并写入点的形状闸。
    if (cfg.models !== undefined) assertPlainObject(cfg.models, 'OPENCLAW_TEMPLATE_JSON (models)')
    const models = (cfg.models ??= {}) as Record<string, unknown>
    models.providers = providersMap
    if (cfg.agents !== undefined) assertPlainObject(cfg.agents, 'OPENCLAW_TEMPLATE_JSON (agents)')
    const agents = (cfg.agents ??= {}) as Record<string, unknown>
    if (agents.defaults !== undefined) assertPlainObject(agents.defaults, 'OPENCLAW_TEMPLATE_JSON (agents.defaults)')
    const defaults = (agents.defaults ??= {}) as Record<string, unknown>
    defaults.model = { primary: refs[0], fallbacks: refs.slice(1) }
    defaults.models = aliases
    return cfg
  }

  // #366 codex 四轮 P1（已知风险，接受 + 文档化，非本 PR 编码缺陷）：apiKey 一律引用共享
  // LLM_API_KEY（值仅管理员部署级配置，见 ALLOWED_API_KEY_ENV_IDS）；而 base_url 完全用户可控。
  // 多租户不可信场景下，恶意 user 可把自家容器的 base_url 指向自己端点，诱使容器把共享 key
  // 作为凭证发往该处 → key 外泄。这是 spec §5.2「全面板共享一个 LLM_API_KEY + 用户配置自己容器
  // LLM 后端」的组合（Django 前身同设计，AGENTS.md「本地/可信部署可接受」姿态）；根治需 per-user
  // 凭证或 admin 白名单 base_url，均超出 #336 范围 → 接受并文档化（见 server/README.md）。
  renderProvider(spec: ProviderSpec): Record<string, unknown> {
    return {
      baseUrl: spec.baseUrl,
      apiKey: {
        source: 'env',
        provider: DEFAULT_SECRET_PROVIDER,
        id: spec.apiKeyEnvId,
      },
      api: spec.api,
      authHeader: spec.authHeader,
      models: spec.models.map((m) => structuredClone(m)),
    }
  }
}
