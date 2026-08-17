# deploy/openclaw-image/Dockerfile —— 自建派生 OpenClaw 镜像（issue #588，ADR 0011/0013）
#
# 谱系：FROM 官方 browser 基线（保 browser 能力，ADR 0003），不新开谱系（CONTEXT「镜像谱系」）。
# 叠加（ADR 0013）：
#   ① pdftotext（poppler-utils，agent 经 tools.exec 提取 PDF 文本）
#   ② wiki/workspace 骨架 COPY 进 /home/node/.openclaw（named volume 首挂自动初始化，ADR 0011）
# 经 OPENCLAW_IMAGE 注入（server config.ts 默认值指向本镜像 ghcr.io/acautomata/researcher-service/openclaw）。
# 构建期断言：pdftotext 可用 + 骨架齐全，任一缺失即构建失败（不带病出镜像）。
#
# 构建：docker build -t ghcr.io/acautomata/researcher-service/openclaw:latest deploy/openclaw-image

FROM ghcr.io/openclaw/openclaw:2026.7.1-browser

USER root

# ① pdftotext（poppler-utils）；bookworm 源经 apt-get 直装。构建期断言 command -v pdftotext
#    + 运行探针（-v 返回码，不接管道——sh/dash 无 pipefail，接 head 会掩蔽探针失败）。
#    装失败/包名漂移/二进制损坏均构建失败。
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && command -v pdftotext \
    && pdftotext -v >/dev/null 2>&1

# ② wiki/workspace 骨架（root 写入后还原 node 属主——官方镜像默认 user node(1000)）。
#    构建期断言：12 个骨架文件逐一声明（与 server/test/openclawImage.test.ts SKELETON_FILES
#    清单对齐），任一缺失即构建失败（不带病出镜像）。
COPY skeleton/.openclaw/ /home/node/.openclaw/
RUN chown -R node:node /home/node/.openclaw \
    && test -f /home/node/.openclaw/wiki/main/WIKI.md \
    && test -f /home/node/.openclaw/wiki/main/index.md \
    && test -f /home/node/.openclaw/wiki/main/inbox.md \
    && test -f /home/node/.openclaw/wiki/main/AGENTS.md \
    && test -f /home/node/.openclaw/wiki/main/concepts/index.md \
    && test -f /home/node/.openclaw/wiki/main/entities/index.md \
    && test -f /home/node/.openclaw/wiki/main/sources/index.md \
    && test -f /home/node/.openclaw/wiki/main/syntheses/index.md \
    && test -f /home/node/.openclaw/wiki/main/reports/index.md \
    && test -f /home/node/.openclaw/wiki/main/_attachments/.gitkeep \
    && test -f /home/node/.openclaw/wiki/main/_views/.gitkeep \
    && test -f /home/node/.openclaw/workspace/README.md

USER node
