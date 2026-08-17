import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// issue #588 派生 OpenClaw 镜像静态断言（issue #586 测试接缝 5 的先例：config.test.ts）。
// 断言对象是 deploy/openclaw-image/ 的声明式产物（Dockerfile + 骨架），不触真 docker：
// 构建期断言（pdftotext 可用、骨架齐全）由 Dockerfile RUN 在构建时执行，此处兜底防回归。
// 路径解析沿 chatSubprotocol.test.ts 模式：vitest 自 server/ 目录运行，cwd 上溯取仓库根。
const IMAGE_DIR = resolve(process.cwd(), '../deploy/openclaw-image')
const SKELETON_ROOT = join(IMAGE_DIR, 'skeleton/.openclaw')
// 官方 browser 基线（ADR 0003 保 browser 能力；派生镜像不新开谱系，ADR 0013）
const OFFICIAL_BASE = 'ghcr.io/openclaw/openclaw:2026.7.1-browser'
// 本仓库 GHCR 派生镜像（与 CD 推送 tag 同源；ghcr.io 要求 repository 全小写）
const DERIVED_DEFAULT = 'ghcr.io/acautomata/researcher-service/openclaw:latest'
const QUOTE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function readDockerfile(): string {
  const file = join(IMAGE_DIR, 'Dockerfile')
  expect(existsSync(file), `缺派生 Dockerfile: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
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
  it('Dockerfile 基于官方 2026.7.1-browser 基线（不新开谱系，ADR 0003/0013）', () => {
    const df = readDockerfile()
    const fromLine = df
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('FROM '))
    expect(fromLine).toBe(`FROM ${OFFICIAL_BASE}`)
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
    const cfg = JSON.parse(readFileSync(resolve(process.cwd(), '../deploy/openclaw.json'), 'utf8'))
    const vaultPath = cfg.plugins?.entries?.['memory-wiki']?.config?.vault?.path
    expect(vaultPath).toBe('~/.openclaw/wiki/main')
    expect(existsSync(join(SKELETON_ROOT, 'wiki/main'))).toBe(true)
  })
})

describe('OPENCLAW_IMAGE 默认值（issue #588 AC3）', () => {
  it('server 配置默认值指向派生镜像', () => {
    // 直接读 config.ts 源码断言默认值字符串：与运行时 env 注入解耦，静态防漂移
    const src = readFileSync(resolve(process.cwd(), 'src/config.ts'), 'utf8')
    expect(src).toMatch(
      new RegExp(`OPENCLAW_IMAGE\\s*\\?\\?\\s*'${QUOTE(DERIVED_DEFAULT)}'`),
    )
  })
})
