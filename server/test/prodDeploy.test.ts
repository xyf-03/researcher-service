import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// issue #593 prod compose/CD 去 host 挂载静态断言（issue #586 测试接缝 5；先例：config.test.ts /
// openclawImage.test.ts 文本断言模式，不触真 docker）。断言对象是声明式产物——prod compose、
// server 镜像 Dockerfile、CD workflow——防「模板/配置回退到宿主挂载」回归。
// 路径解析沿 openclawImage.test.ts 模式：vitest 自 server/ 目录运行，cwd 上溯取仓库根。
const ROOT = resolve(process.cwd(), '..')

function readRepoFile(rel: string): string {
  const file = join(ROOT, rel)
  expect(existsSync(file), `缺文件: ${file}`).toBe(true)
  return readFileSync(file, 'utf8')
}

// server 服务的 volumes 段（compose 中唯一带 volumes 的服务）：从 `volumes:` 行到下一
// `    networks:` 行之间，取所有挂载条目（`- <src>:<dst>` 形态）。文本定位不经 YAML 解析，
// 断言只对挂载条目行生效（注释提及 /fleet 等历史语境词汇不误伤）。
function serverMountLines(compose: string): string[] {
  const afterVolumes = compose.split('volumes:')[1]
  expect(afterVolumes, 'compose 缺 server volumes 段').toBeDefined()
  const section = afterVolumes.split('\n    networks:')[0]
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
}

describe('prod compose 去 host 挂载（issue #593，ADR 0013）', () => {
  const compose = readRepoFile('deploy/docker-compose.deploy.yml')

  it('server 仅挂载 docker.sock（唯一豁免）+ SQLite named volume，无任何宿主数据路径', () => {
    const mounts = serverMountLines(compose)
    expect(mounts).toEqual([
      '- /var/run/docker.sock:/var/run/docker.sock',
      '- panel-db:/app/db',
    ])
  })

  it('挂载条目无残留 host 数据挂载形态（/fleet、/srv/openclaw、./openclaw.json、:ro）', () => {
    const mounts = serverMountLines(compose)
    for (const m of mounts) {
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\/fleet:/)
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\/srv\/openclaw/)
      expect(m, `残留 host 挂载: ${m}`).not.toMatch(/\.\/openclaw\.json/)
      expect(m, `残留 :ro 挂载: ${m}`).not.toContain(':ro')
    }
  })

  it('模板与 openclaw.json 的 env 指向镜像内路径（构建期 COPY 产物）', () => {
    expect(compose).toMatch(/OPENCLAW_TEMPLATE_DIR: \/app\/templates\/researcher/)
    expect(compose).toMatch(/OPENCLAW_TEMPLATE_JSON: \/app\/deploy\/openclaw\.json/)
  })

  it('fleet 根为容器内工作目录、无宿主 bind（/fleet 绑定已移除；与 devDeploy.test.ts 同形断言）', () => {
    // issue #595 收口锚定：#593 删 /fleet:/fleet bind 后 OPENCLAW_FLEET_ROOT 仍是容器内路径——
    // named volume 拓扑（ADR 0011）下 OpenClaw 容器不 bind 宿主树，createComplete 的 instanceDir/
    // provision 落容器私有 /fleet（容器重建即空、create 幂等重建；卷内容由 #588 派生镜像骨架播种）。
    expect(compose).toMatch(/OPENCLAW_FLEET_ROOT: \/fleet/)
  })
})

describe('server 镜像构建期入模板（issue #593，ADR 0013）', () => {
  const df = readRepoFile('server/Dockerfile')

  it('COPY --from=template 整棵 researcher 克隆到 /app/templates/researcher（provision cp 源）', () => {
    expect(df).toMatch(/COPY --from=template \/ \/app\/templates\/researcher/)
  })

  it('COPY template 后清理 .git（issue #594：dev 本地 build 的 template context 带 .git 且无 cd.yml 预处理；防经 provision cp 进容器 home，对齐 CD 的 rm -rf .git 意图）', () => {
    expect(df).toMatch(/RUN rm -rf \/app\/templates\/researcher\/\.git/)
  })

  it('COPY --from=deploy 的 openclaw.json 到 /app/deploy/openclaw.json（配置单一来源入镜像）', () => {
    expect(df).toMatch(/COPY --from=deploy \/openclaw\.json \/app\/deploy\/openclaw\.json/)
  })

  it('模板 COPY 位于 runtime 阶段（ENTRYPOINT 之前、docker-entrypoint COPY 附近）', () => {
    // lastIndexOf：`FROM node:lts-slim AS build` 也含 `FROM node:lts-slim` 子串——
    // indexOf 会误配 build 阶段使断言恒真（spec 审查 #593 指出）；lastIndexOf 取
    // 文件最后出现的 runtime 阶段 `FROM node:lts-slim`（无 AS）。
    const runtimeStart = df.lastIndexOf('FROM node:lts-slim')
    const entrypointIdx = df.indexOf('COPY docker-entrypoint.sh')
    expect(runtimeStart).toBeGreaterThanOrEqual(0)
    expect(entrypointIdx).toBeGreaterThan(runtimeStart)
    const runtime = df.slice(runtimeStart, entrypointIdx)
    expect(runtime).toMatch(/COPY --from=template/)
    expect(runtime).toMatch(/COPY --from=deploy/)
  })
})

describe('CD 工作流（issue #593，ADR 0013）', () => {
  const cd = readRepoFile('.github/workflows/cd.yml')

  it('server 构建经 buildx 多 context 注入 template（researcher 克隆）与 deploy（openclaw.json）', () => {
    expect(cd).toMatch(/build-contexts:/)
    expect(cd).toMatch(/template=\$\{\{ github\.workspace \}\}\/_templates\/researcher/)
    expect(cd).toMatch(/deploy=\$\{\{ github\.workspace \}\}\/deploy/)
  })

  it('构建机构建期 clone researcher 模板（模板随镜像 :sha 版本化）', () => {
    // env 先归一默认仓库（secret 可覆盖），clone 只消费 $REPO 变量（防 secret 值注入命令）
    expect(cd).toMatch(/REPO="\$\{RESEARCHER_REPO:-https:\/\/github\.com\/ACautomata\/researcher\.git\}"/)
    expect(cd).toMatch(/git clone --depth 1 "\$REPO" "\$\{\{ github\.workspace \}\}\/_templates\/researcher"/)
  })

  it('不再 scp 分发 openclaw.json / 不再宿主 clone 模板', () => {
    expect(cd).not.toMatch(/cp deploy\/openclaw\.json/)
    expect(cd).not.toMatch(/TEMPLATE_DIR=\/srv\/openclaw\/template/)
  })

  it('clone 后清理 .git（模板上下文不进镜像/容器 home）', () => {
    // COPY --from=template 整棵浅克隆入镜像：.git 不删会永久携带 + provision cp -a 时
    // 一并拷进容器 ~/.openclaw/.git。clone 步骤内 rm -rf 兜底。
    expect(cd).toMatch(/rm -rf "\$\{\{ github\.workspace \}\}\/_templates\/researcher\/\.git"/)
  })
})

describe('prod flag 默认 named volume（issue #593 AC4，ADR 0011）', () => {
  it('config.ts readNamedVolumes 未设置时默认 true（compose 不覆盖即生产同效）', () => {
    // 对齐 openclawImage.test.ts「读 config.ts 源码锚定默认值」模式：compose 不设该变量，
    // 默认翻转即生产静默回退 bind 拓扑——静态锚定防漂移（防「compose 无显式设置」测试假绿）。
    const src = readRepoFile('server/src/config.ts')
    expect(src).toMatch(/if \(v === undefined\) return true/)
    expect(src).toMatch(/const v = process\.env\.OPENCLAW_NAMED_VOLUMES/)
  })

  it('compose 不显式覆盖 OPENCLAW_NAMED_VOLUMES（保持默认 true）', () => {
    const compose = readRepoFile('deploy/docker-compose.deploy.yml')
    expect(compose).not.toMatch(/OPENCLAW_NAMED_VOLUMES/)
  })
})
