import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isFloatingImageRef } from '../src/containers/imageRef'

// issue #588 派生 OpenClaw 镜像静态断言（issue #586 测试接缝 5 的先例：config.test.ts）。
// 断言对象是 deploy/openclaw-image/ 的声明式产物（Dockerfile + 骨架），不触真 docker：
// 构建期断言（pdftotext 可用、骨架齐全）由 Dockerfile RUN 在构建时执行，此处兜底防回归。
// 路径解析沿 chatSubprotocol.test.ts 模式：vitest 自 server/ 目录运行，cwd 上溯取仓库根。
const ROOT = resolve(process.cwd(), '..')
const IMAGE_DIR = join(ROOT, 'deploy/openclaw-image')
const SKELETON_ROOT = join(IMAGE_DIR, 'skeleton/.openclaw')
// 钉定的目标版本 tag（issue #695）：版本 tag 一经发布不可移动——bump = 改 Dockerfile FROM 基线
// （版本前进）+ 本常量 + config.ts 默认目标镜像 + 模板栈 compose 默认值 + dev driver 预拉默认值
// （四处运行期明文同锁，见下方 describe），路径见 deploy/README.md「派生镜像版本 tag 约定」。
const PINNED_TAG = '2026.9.4-browser'
// 官方 browser 基线（ADR 0003 保 browser 能力；派生镜像不新开谱系，ADR 0013）
const OFFICIAL_BASE = `ghcr.io/openclaw/openclaw:${PINNED_TAG}`
// 本仓库 GHCR 派生镜像（与 CD 推送 tag 同源；ghcr.io 要求 repository 全小写）
const DERIVED_DEFAULT = `ghcr.io/acautomata/researcher-service/openclaw:${PINNED_TAG}`
const QUOTE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readDockerfile(): string {
  return readRepoFile('deploy/openclaw-image/Dockerfile')
}

// 骨架文件清单：wiki vault 顶层 + memory-wiki 五核心目录（r7-wiki-read-mechanism 实测结构，
// 与 deploy/openclaw.json 的 memory-wiki vaultMode=isolated 配置匹配）+ workspace。
// Dockerfile 构建期断言逐一声明同一清单（两端锚定，防漏防错挂载点）。
const SKELETON_FILES = [
  'wiki/main/WIKI.md',
  'wiki/main/index.md',
  'wiki/main/inbox.md',
  'wiki/main/AGENTS.md',
  'wiki/main/concepts/index.md',
  'wiki/main/entities/index.md',
  'wiki/main/sources/index.md',
  'wiki/main/syntheses/index.md',
  'wiki/main/reports/index.md',
  'wiki/main/_attachments/.gitkeep',
  'wiki/main/_views/.gitkeep',
  'workspace/README.md',
]

// 手写递归 walk（不用 readdirSync recursive：Node ≥20.1 才支持，仓库无 engines 门禁）
function walkFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

describe('派生 OpenClaw 镜像（issue #588）', () => {
  it(`Dockerfile 基于官方 ${PINNED_TAG} 基线（不新开谱系，ADR 0003/0013）`, () => {
    expect(dockerfileFromRef()).toBe(OFFICIAL_BASE)
  })

  it('Dockerfile 安装 poppler-utils 且 pdftotext 探针直接以返回码断言（不经管道）', () => {
    const df = readDockerfile()
    expect(df).toMatch(/poppler-utils/)
    // 探针须直接以返回码断言：`pdftotext -v` 后重定向即可（dash 无 pipefail，接 head 会恒返 0 假绿）
    expect(df).toMatch(/pdftotext -v\s*>\s*\/dev\/null\s*2>&1/)
  })

  it('Dockerfile 将骨架 COPY 进 /home/node/.openclaw（named volume 首挂自动初始化，ADR 0011）', () => {
    const df = readDockerfile()
    // 两端锚定：源 token 指向骨架、目标恰为 /home/node/.openclaw/（防落错挂载点假绿）
    expect(df).toMatch(/COPY\s+skeleton\/\.openclaw\/\s+\/home\/node\/\.openclaw\//)
    // 属主还原 node（官方镜像默认 user node(1000)，root COPY 产物须 chown）
    expect(df).toMatch(/chown\s+-R\s+node:node\s+\/home\/node\/\.openclaw/)
  })

  it('Dockerfile 构建期断言逐一声明全部骨架文件（与 SKELETON_FILES 清单一致，任一缺失即构建失败）', () => {
    const df = readDockerfile()
    for (const rel of SKELETON_FILES) {
      expect(
        df,
        `Dockerfile 缺骨架断言: ${rel}`,
      ).toMatch(new RegExp(`test -f /home/node/\\.openclaw/${QUOTE(rel)}`))
    }
  })

  it('骨架文件齐全（wiki vault + workspace；.gitkeep 占位仅要求存在）', () => {
    for (const rel of SKELETON_FILES) {
      const file = join(SKELETON_ROOT, rel)
      expect(existsSync(file), `缺骨架文件: ${rel}`).toBe(true)
      if (!rel.endsWith('.gitkeep')) {
        expect(statSync(file).size, `${rel} 为空`).toBeGreaterThan(0)
      }
    }
  })

  it('骨架不含插件内部状态 .openclaw-wiki（插件运行时自建，预置即陈旧）', () => {
    expect(existsSync(join(SKELETON_ROOT, 'wiki/main/.openclaw-wiki'))).toBe(false)
  })

  it('骨架不含面板源码残留（仅 wiki/workspace 两棵子树）', () => {
    const entries = walkFiles(SKELETON_ROOT)
    const tops = new Set(entries.map((e) => e.split('/')[0]))
    expect([...tops].sort()).toEqual(['wiki', 'workspace'])
  })

  it('vault 路径契约交叉校验：openclaw.json memory-wiki vault.path 指向骨架 wiki/main（ADR 0011 挂载点）', () => {
    const cfg = JSON.parse(readRepoFile('deploy/openclaw.json'))
    const vaultPath = cfg.plugins?.entries?.['memory-wiki']?.config?.vault?.path
    expect(vaultPath).toBe('~/.openclaw/wiki/main')
    expect(existsSync(join(SKELETON_ROOT, 'wiki/main'))).toBe(true)
  })
})

describe('OPENCLAW_IMAGE 默认值（issue #588 AC3）', () => {
  it('server 配置默认值指向本仓库派生镜像', () => {
    // #588 的归属断言：默认值指向本仓库派生镜像（而非官方基线）。读源码明文、与运行时 env
    // 注入解耦；与版本 tag 的完整交叉断言见下方「目标镜像钉版（issue #695）」——两处共用同一
    // 提取实现 configDefaultImage（不重复解析正则）
    expect(configDefaultImage()).toMatch(/^ghcr\.io\/acautomata\/researcher-service\/openclaw:/)
  })
})

// ---- 目标镜像钉版（issue #695，spec §2.1 升级编排的版本前提）----
// 版本单源 = Dockerfile FROM 基线行。四处**运行期**明文与之同版本并由本文件交叉断言锁死（防双源
// 漂移）：控制面默认目标镜像（config.ts OPENCLAW_IMAGE 默认值）、模板栈 compose 默认值、dev 管线
// driver 预拉默认值、测试内的版本常量；浮动判定统一走 src/containers/imageRef.ts 的
// isFloatingImageRef
// （纯知识单一实现，CONTEXT「共享内核」）。文档与 .env.example 里的版本是示意值（不在锁内，
// 换版时随 deploy/README.md 更新）。
// 沿本文件既有模式：读声明式产物文本，不触真 docker（构建期断言由 Dockerfile RUN 在构建时执行）。
const STANDALONE_COMPOSE = 'deploy/docker-compose.yml'
// dev 管线 driver 脚本（run-ai-research-pipeline）预拉 fleet 镜像的默认值：第四处运行期明文
const FLEET_DRIVER = '.claude/skills/run-ai-research-pipeline/driver.sh'

// 仓库根读文件：与 prodDeploy.test.ts / devDeploy.test.ts 的同名 helper 保持逐字一致（本目录的
// 静态断言测试各文件自包含、零业务依赖——不共用 helpers.ts：那份是 DB/auth 种子工具，引进来会
// 把 bcrypt/prisma 拖进纯文本断言；三份再现即考虑提取，届时以本注释为准）。
function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

function dockerfileFromRef(): string {
  const line = readDockerfile()
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('FROM '))
  expect(line, 'Dockerfile 缺 FROM 行').toBeDefined()
  return (line as string).slice('FROM '.length).split(/\s+/)[0]
}

// config.ts 里 OPENCLAW_IMAGE 默认值明文（与运行时 env 注入解耦，静态防漂移）
function configDefaultImage(): string {
  const m = readRepoFile('server/src/config.ts').match(/OPENCLAW_IMAGE\s*\?\?\s*'([^']+)'/)
  expect(m, 'config.ts 缺 OPENCLAW_IMAGE 默认值明文').not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

// `${OPENCLAW_IMAGE:-<默认>}` 形态的运行期默认镜像明文：模板栈 compose 与 dev driver 脚本同款
// 环境变量回退。单一提取实现、两处调用（与 imageTag 同理：纯知识不写第二份，防漂移）
function envDefaultImage(rel: string): string {
  const m = readRepoFile(rel).match(/\$\{OPENCLAW_IMAGE:-([^}]+)\}/)
  expect(m, `${rel} 缺 OPENCLAW_IMAGE 默认值`).not.toBeNull()
  return (m as RegExpMatchArray)[1]
}

describe('目标镜像钉版（issue #695）', () => {
  it('Dockerfile FROM == config 默认目标镜像（两处明文交叉锁死，防双源漂移）', () => {
    // 锁死机制：两处明文须各自等于由 PINNED_TAG 拼出的期望值 ⇒ 任一处 tag 漂移即红。「非浮动」
    // 由下方独立断言兜底（isFloatingImageRef），故此处不再额外断言 tag 本身（那会恒真）
    expect(dockerfileFromRef()).toBe(OFFICIAL_BASE)
    expect(configDefaultImage()).toBe(DERIVED_DEFAULT)
  })

  it('模板栈 compose 与 dev driver 的默认镜像同版本（本地手动栈/dev 管线不落在别的版本上）', () => {
    expect(envDefaultImage(STANDALONE_COMPOSE)).toBe(DERIVED_DEFAULT)
    expect(envDefaultImage(FLEET_DRIVER)).toBe(DERIVED_DEFAULT)
  })

  // 「目标镜像」按 CONTEXT 词条专指 config.fleet.image；此处断言的四点是**镜像引用**（含版本单源
  // Dockerfile FROM，它本身不是「目标镜像」）——生产 fail-fast 的默认路径恒通过
  it('四处镜像引用均非浮动（Dockerfile FROM / config 默认 / 模板栈 compose / dev driver）', () => {
    expect(isFloatingImageRef(dockerfileFromRef())).toBe(false)
    expect(isFloatingImageRef(configDefaultImage())).toBe(false)
    expect(isFloatingImageRef(envDefaultImage(STANDALONE_COMPOSE))).toBe(false)
    expect(isFloatingImageRef(envDefaultImage(FLEET_DRIVER))).toBe(false)
  })
})

describe('CD 推送 openclaw 版本 tag（issue #695 AC4）', () => {
  const cd = readRepoFile('.github/workflows/cd.yml')
  // 收集期切出 openclaw 步骤块：先兜底（同本文件 tagsBlock / prodDeploy 的 serverMountLines 惯用法），
  // 步骤名一变即给可读断言失败，而非 `undefined.split(...)` 的 TypeError
  const openclawSection = cd.split('Build & push openclaw derived image')[1]
  expect(openclawSection, 'CD 缺 openclaw build & push 步骤').toBeDefined()
  const openclawStep = (openclawSection as string).split('Build & push autofigure')[0]

  // openclaw 步骤 tags 字面块（`tags: |` 起、至缩进 ≤ 该键的行止）：逐行即一个 tag，块内写注释
  // 会把 `# ...` 当 tag 文本传给 build-push-action（本断言即为防此回归）。
  function tagsBlock(step: string): string[] {
    const lines = step.split('\n')
    const start = lines.findIndex((l) => l.trim() === 'tags: |')
    expect(start, 'CD 缺 openclaw tags 字面块').toBeGreaterThanOrEqual(0)
    const indent = lines[start].search(/\S/)
    const out: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim() !== '' && lines[i].search(/\S/) <= indent) break
      out.push(lines[i].trim())
    }
    return out.filter((l) => l !== '')
  }

  it('版本 tag 从 Dockerfile FROM 基线行单源提取（不引入第二配置源）', () => {
    expect(cd).toMatch(/grep[^\n]*FROM[^\n]*deploy\/openclaw-image\/Dockerfile/)
    expect(cd).toMatch(/OPENCLAW_VERSION_TAG=\$\{VERSION_TAG\}/)
  })

  it('提取失败即 fail：缺 FROM 行 / 无 tag / digest FROM 行 / 端口形态 —— 不推垃圾 tag', () => {
    expect(cd).toMatch(/无法从 Dockerfile FROM 行提取版本 tag[\s\S]{0,200}?exit 1/)
    expect(cd).toMatch(/digest[\s\S]{0,200}?exit 1/)
    // 末段 `:` 是 registry 端口（`registry:5000/repo` 无 tag）：tag 不含 `/`，提取结果含 `/` 即拒
    expect(cd).toMatch(/\*\/\*\)[\s\S]{0,200}?exit 1/)
  })

  it('openclaw build & push 恰推三个 tag：:latest / :<sha> / 版本 tag（块内无注释行）', () => {
    expect(tagsBlock(openclawStep)).toEqual([
      '${{ env.OPENCLAW_IMAGE }}:latest',
      '${{ env.OPENCLAW_IMAGE }}:${{ env.IMAGE_TAG }}',
      '${{ env.OPENCLAW_IMAGE }}:${{ env.OPENCLAW_VERSION_TAG }}',
    ])
  })

  it('部署段显式重拉的运行时镜像 = 版本 tag（宿主缓存与 fleet 目标同源）', () => {
    expect(cd).toMatch(/docker pull "\$\{OPENCLAW_IMAGE\}:\$\{OPENCLAW_VERSION_TAG\}"/)
    // 变量须经 ssh-action 透传进远端脚本（env 声明 + envs 白名单）
    expect(cd).toMatch(/OPENCLAW_VERSION_TAG: \$\{\{ env\.OPENCLAW_VERSION_TAG \}\}/)
    expect(cd).toMatch(/envs: [^\n]*OPENCLAW_VERSION_TAG/)
  })
})
