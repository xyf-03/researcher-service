// 容器/编排域纯常量单一来源（平移 backend/containers/constants.py，#334）。
// 真常量（协议/架构级不变量，跨部署不漂移）进此模块；部署配置（端口池区间/宿主 bind/token）留 config.ts。

// 容器内 gateway 固定端口（Docker 网络命名空间隔离，仅宿主侧分配映射端口）
export const GATEWAY_INTERNAL_PORT = 18789

// 容器名前缀：与原 compose 栈 openclaw-gateway 隔离
export const CONTAINER_PREFIX = 'openclaw-gw-'
// #590 named volume 名前缀（ADR 0011）：openclaw-<kind>-<id>，按代系 id（#360）派生
// （runtime.namedVolumesFor）。容器删除时连带 docker volume rm 清理。
export const VOLUME_WIKI_PREFIX = 'openclaw-wiki-'
export const VOLUME_WORKSPACE_PREFIX = 'openclaw-workspace-'
export const VOLUME_HOME_PREFIX = 'openclaw-home-'
// 按 label 过滤管理容器生命周期
export const LABEL_APP_KEY = 'app'
export const LABEL_APP_VALUE = 'openclaw-fleet'
export const LABEL_INSTANCE_KEY = 'openclaw.instance'
export const LABEL_PORT_KEY = 'openclaw.port'
// 容器内固定 bind-mount 路径（#591：仅 home 目录 rw bind 承载 workspace/wiki/state/logs；
// openclaw.json 落 home 内默认路径 ~/.openclaw/openclaw.json——静态 config，无独立 config bind）
export const HOME_BIND = '/home/node/.openclaw'
// gateway 网络绑定模式（容器内 gateway 绑 lan，宿主侧靠 Docker 端口映射隔离）
export const GATEWAY_BIND = 'lan'
// env 占位：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} 由 gateway 进程运行时插值
export const GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'

// --- 编排状态机协议常量 ---
// gateway_token 熵（GATEWAY_TOKEN）：32 字节 = 256 bit
export const TOKEN_URLSAFE_BYTES = 32
