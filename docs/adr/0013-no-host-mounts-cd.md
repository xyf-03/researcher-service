# 禁止挂 host：模板/配置入镜像，CD 与 dev 全容器化

**Status**: accepted

生产部署除 `/var/run/docker.sock` 外**零 host 挂载**；模板与 `openclaw.json` 单一来源构建期 COPY 进镜像；`openclaw.json` 写读经 Docker 原语；dev 控制面也容器化。配套引入**自建派生镜像**承载 OpenClaw 内容与 PDF 工具。

## 决策

**唯一豁免的 host 挂载：`/var/run/docker.sock`**。它是控制面增删查 OpenClaw 容器的唯一通道，无 named-volume 替代（spec §5.4 已接受「等价 root」风险，本地/可信部署可接受）。

其余全部去除 host 挂载：

| 原 host 挂载 | 改为 |
|---|---|
| `/fleet:/fleet`（server 操作宿主 instances 树） | **删除**——home bind 随 named volume 化（0011）消失，server 不再需要操作宿主 instances 树 |
| `/srv/openclaw/template:ro`（researcher 模板） | **COPY 进 server 镜像**；同时 wiki/workspace 骨架烤进 OpenClaw 派生镜像（named volume 自动初始化用） |
| `./openclaw.json:ro`（配置模板） | **COPY 进 server 镜像**，CD 不再 scp/挂载模板 |
| `instances/<id>/config:ro`（openclaw.json 唯一来源） | **写用 `putArchive` 打进容器、读用 `getArchive` 拉出**，零数据 bind |

**自建派生镜像**：`FROM ghcr.io/openclaw/openclaw:2026.9.4-browser`（保 browser 能力，ADR 0003 基线；基线版本 issue #695 起前进，单源 = `deploy/openclaw-image/Dockerfile` 的 `FROM` 行），叠加：①`pdftotext`（poppler，PDF 文本提取 CLI，供 agent `tools.exec` 调用）；②wiki/workspace 骨架 COPY 进 `~/.openclaw`（named volume 首挂自动初始化）。经 `OPENCLAW_IMAGE` 注入。派生镜像不新开谱系，只继承官方谱系已校准性质（CONTEXT.md「镜像谱系」）。

**dev 控制面容器化**：dev 与 prod 同形态（compose 起 server+redis，挂 docker.sock），消除「dev 直跑摸不到 named volume」的分叉。

## 为什么

- **整洁**：数据不落宿主、模板不散在宿主文件系统；server 镜像自包含配置单一来源，CD 部署面最小化。
- **解死结**：home bind 一旦去除，「server 与宿主 daemon 解析同一宿主路径」的 `/fleet` 死结（2026-08-01 生产实测）随之消失（见 [0011](./0011-named-volume-topology.md)）。

## 后果（已接受）

- **静态 config（#366 的明确回退）**：`openclaw.json` 现靠「宿主 rename 换 inode + 目录 ro bind」实现 gateway watch 热加载（#366 刻意设计）。改经 `putArchive` 写后**该热加载机制放弃**——配置改静态，改配置须**重启容器**生效。这是本 ADR 对 #366「目录 ro bind + OPENCLAW_CONFIG_PATH」的刻意回退，动机是零 host 数据挂载。
- **模板版本随镜像**：模板/骨架在构建期锁进镜像，更新模板须重建镜像（换来部署面无模板挂载）。
- **dev 工作流变化**：dev 不再 `npm run dev` 直跑，改容器化（与 prod 一致）。

## 考虑过但否决的方案

- **保留 `instances/<id>/config` ro bind**：最省事，但留下一个 host 数据路径，「零 host 数据挂载」不彻底。
- **config 走 named volume + server 挂卷写**：server 是长驻容器，不能每建一个 OpenClaw 容器就改自己的挂载；故 config 改经 `putArchive`/`getArchive`（复用 0012 的 Docker 原语通道），而非控制面挂 config 卷。
- **`docker.sock` 也去除**：无替代——控制面编排 OpenClaw 必须经 daemon；改 TCP 远程 daemon 反而扩大暴露面。

## 关联

- 依赖 [0011-named-volume-topology](./0011-named-volume-topology.md)（home bind 消失才有 `/fleet` 删除）、[0012-file-query-via-docker-archive](./0012-file-query-via-docker-archive.md)（config/文件写读共用 getArchive/putArchive 通道）。
- 回退 #366（`instances/<id>/config` ro bind + 热加载）——见「后果」。
- 镜像基线沿用 [0003-migrate-to-openclaw-official-browser-image](./0003-migrate-to-openclaw-official-browser-image.md)。
