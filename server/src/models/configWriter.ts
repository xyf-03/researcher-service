// ModelConfigWriter —— provider CRUD 后重渲染 openclaw.json 的写侧 Port（#336）。
//
// 平移 backend/containers/fleet/command.py#rewrite_config 语义：DB（ModelProvider）为单一来源，
// 读该容器全部 provider → ProviderConfigBuilder 合并进模板 base（ConfigRenderer 强制 gateway
// 安全不变量）→ 经 FileArchive.writeConfig（#591，putArchive）覆盖写容器内
// ~/.openclaw/openclaw.json（home 卷 / bind home 内）。
// **静态 config**：对 #366「宿主 rename + ro bind 热加载」的明确回退——写盘后须重启容器生效，
// 不再依赖 gateway watch 热加载。写盘失败抛 ConfigWriteError → DB 事务据此回滚（view/service 层）。
//
// 路由层注入此 Port（AppDeps.models.configWriter）：测试可注入假 writer 测回滚，生产装
// TemplateModelConfigWriter（真模板 + FileArchive）。

import { readFile } from 'node:fs/promises'
import { CODE } from '../codes'
import { ConfigRenderer } from '../containers/configRenderer'
import { ConfigWriteError, ConfigurationError, ContainerDomainError } from '../containers/errors'
import { FileNotFound } from '../files/errors'
import type { FileArchive } from '../files/fsPort'
import { ProviderConfigBuilder, type ProviderSpec } from './configBuilder'

export interface ModelConfigWriter {
  // 把 providers 合并进模板 base 后写容器内 openclaw.json（name 定容器、id 仅诊断，代系绑定 #360）。
  rewrite(opts: { name: string; id: string; providers: readonly ProviderSpec[] }): Promise<void>
}

// 模板写盘依赖面（收窄到所需字段，便于 server.ts 直接传 config.fleet；archive 供
// FileArchive.writeConfig 落容器内 config——静态 config，见 fsPort.ts #591 说明）
export interface ModelConfigWriterDeps {
  readonly archive: FileArchive
  readonly templateJson: string
  readonly llmApiKey: string
  readonly panelOrigin: string
}

export class TemplateModelConfigWriter implements ModelConfigWriter {
  private renderer: ConfigRenderer | null = null

  constructor(private readonly cfg: ModelConfigWriterDeps) {}

  async rewrite({ name, id, providers }: { name: string; id: string; providers: readonly ProviderSpec[] }): Promise<void> {
    // LLM key 未配置 → 90003（ConfigurationError 携带码）。生产 create 已前置 fail-fast
    // （command.ts 同款），此处兜底防「key 被清空后仍写盘成功、provider 不可用」。
    if (!this.cfg.llmApiKey) throw new ConfigurationError('LLM_API_KEY')
    // #366 P1 升级路径（#591 以容器内探测复刻）：旧代容器（#366 前的创建，gateway 经
    // OPENCLAW_CONFIG_PATH 读 ro bind 目录、env 固化）容器内默认路径 ~/.openclaw/openclaw.json
    // 无文件——putArchive 写入后 gateway 永不读取、API 却报成功（#366 P1「热加载断链」重演）。
    // 容器内探测：readConfig FileNotFound = 旧代/未初始化 → fail-fast 90003 提示重建；非
    // FileNotFound（daemon 故障）→ 归写盘失败域（后续 writeConfig 同面暴露）。
    try {
      await this.cfg.archive.readConfig(name)
    } catch (e) {
      if (e instanceof FileNotFound) {
        throw new ContainerDomainError(
          CODE.LLM_NOT_CONFIGURED,
          `容器为旧版本（容器内无 ~/.openclaw/openclaw.json），模型配置无法写入生效路径——请重建该容器后再配置`,
        )
      }
      throw new ConfigWriteError(name, `${id} ~/.openclaw/openclaw.json read-probe (${(e as Error).message})`)
    }
    const renderer = await this.ensureRenderer()
    // #385：allowedOrigins 强制含面板 origin（渲染产物与 create 路径同源强制点）
    const merged = new ProviderConfigBuilder().build(renderer.renderDict(this.cfg.panelOrigin), providers)
    try {
      // #591：config 落容器内 ~/.openclaw/openclaw.json（putArchive），零宿主数据路径。
      // 静态 config：写盘后须重启容器生效（对 #366 热加载的明确回退）。
      await this.cfg.archive.writeConfig(name, JSON.stringify(merged, null, 2))
    } catch (e) {
      // 写盘失败（容器缺失/daemon 故障/IO）→ ConfigWriteError：service 据它判定「盘未变」→
      // 事务回滚 DB 行（90003）、不触发 reconcile（#366 codex 四轮 P2：多余写盘 = stale-write 竞态面）。
      throw new ConfigWriteError(name, `${id} ~/.openclaw/openclaw.json (${(e as Error).message})`)
    }
  }

  // 惰性读模板 + 缓存（对齐 command.ts ensureRenderer）：ConfigRenderer 构造期解析损坏模板 fail-fast。
  // #366 修复（codex P2「模板加载错误转译」）：readFile 失败（缺失/EACCES）与 JSON.parse 抛的
  // 裸 SyntaxError 都包成 ConfigurationError（90003）——否则全局错误面把每个 SyntaxError 当
  // body 解析失败误译 90002、文件缺失落 90000，客户端收到错误分类的配置失败信封。
  private async ensureRenderer(): Promise<ConfigRenderer> {
    if (!this.renderer) {
      let templateText: string
      try {
        templateText = await readFile(this.cfg.templateJson, 'utf8')
      } catch (e) {
        throw new ConfigurationError(
          `模板文件读取失败 ${this.cfg.templateJson}: ${(e as Error).message}`,
        )
      }
      try {
        this.renderer = new ConfigRenderer(templateText)
      } catch (e) {
        // ConfigRenderer 构造已把损坏模板转 ConfigurationError（形状断言 C9）→ 原样上抛；
        // JSON.parse 抛的裸 SyntaxError → 包成 ConfigurationError。
        if (e instanceof ConfigurationError) throw e
        throw new ConfigurationError(
          `模板 JSON 解析失败 ${this.cfg.templateJson}: ${(e as Error).message}`,
        )
      }
    }
    return this.renderer
  }
}
