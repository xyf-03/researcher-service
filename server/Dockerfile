# server/Dockerfile —— TS/Express 控制面生产镜像（issue #341 M9，替代退役的 Django backend 镜像）
# 多阶段：build（npm ci 全量——编译需要 devDeps：typescript + prisma CLI）+ prebuild 钩子
# prisma generate → tsc 产出 dist/；runtime（npm ci --omit=dev，仅生产依赖，src 全部 import
# 已验证落在 dependencies）。容器启动经 entrypoint：先幂等落表（apply-schema.mjs + user_version
# 标记，对齐 Django 镜像「entrypoint = migrate + daphne」模式）再起 node dist/server.js。

# ---- build：编译 ----
FROM node:lts-slim AS build

WORKDIR /app
# better-sqlite3 原生模块（node-gyp）在 build 阶段 npm ci 的 postinstall 编译工具链。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

# 仅拷依赖清单以最大化层缓存；源码变化不触发重装。
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY prisma ./prisma
COPY scripts ./scripts
# prebuild 钩子 = prisma generate；build = tsc -p tsconfig.build.json + cp src/generated dist/generated。
RUN npm run build

# ---- runtime：精简运行镜像 ----
FROM node:lts-slim

# better-sqlite3 原生模块（node-gyp）在 runtime 的 postinstall 编译工具链；
# 仅构建期用，体积小。必须 slim（Debian/glibc）——alpine/musl 需额外编译参数。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# 生产依赖独立安装（--omit=dev），避免 COPY build 的 node_modules 带入 devDeps 测试栈。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 编译产物 + prisma generate 生成物（tsc 已编译进 dist/generated，显式双拷贝保证完整；
# client 纯 JS，体积可忽略）。schema/scripts 供 entrypoint 幂等落表。
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts

# ADR 0013（issue #593）：home 模板与 openclaw.json 构建期入镜像——生产不再挂载任何宿主数据
# 路径（唯一豁免 docker.sock）。两处 COPY 的源是 buildx 多 context（CD 经 build-contexts 注入：
# template=<researcher 克隆>、deploy=<本仓库 deploy/>）；本地构建须自备同名 context
# （docker buildx build --build-context template=<dir> --build-context deploy=<dir>）。
# template：provision 的 cp -a 预填充源（容器化后落在容器私有 fleet 根，compose 里
# OPENCLAW_TEMPLATE_DIR 指向此路径）；openclaw.json：配置单一来源（compose OPENCLAW_TEMPLATE_JSON）。
COPY --from=template / /app/templates/researcher
# 防 .git 经 provision cp -a 进容器 home（对齐 #593 CD 的 rm -rf .git 意图）：本地 dev build 的
# template context 带 .git（用户自行 clone，issue #594 dev 容器化路径，无 cd.yml 预处理步骤）；
# prod 经 cd.yml clone 后已 rm（此 rm 幂等无害）。统一在 COPY 后清理，保证 dev/prod 镜像同形态。
RUN rm -rf /app/templates/researcher/.git
COPY --from=deploy /openclaw.json /app/deploy/openclaw.json

COPY docker-entrypoint.sh /usr/local/bin/panel-entrypoint
RUN chmod +x /usr/local/bin/panel-entrypoint

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["panel-entrypoint"]
