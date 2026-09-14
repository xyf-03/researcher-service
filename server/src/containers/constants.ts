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
// #699 升级备份卷名前缀：openclaw-home-backup-<instanceId>——独立于代系三卷命名（runtime.backupVolumeFor），
// 不在 namedVolumesFor / 删除连删范围：删容器后备份仍在，供故障手工救回（spec §2.4）。
export const VOLUME_HOME_BACKUP_PREFIX = 'openclaw-home-backup-'
// 备份卷在一次性临时容器内的挂载点 + 备份 tar 文件名（#699 备份 runOnce 单一来源；手工救回按
// `tar tzf /b/home.tar.gz` 读出——冒烟清单同形状）。
export const ONESHOT_BACKUP_TARGET = '/backup'
export const BACKUP_TAR_NAME = 'home.tar.gz'
// #699 升级连续失败进入终态（upgrade_failed）的阈值（spec §2.2：可重试失败 +1、成功清零、≥3 终态）。
export const UPGRADE_MAX_ATTEMPTS = 3
// 按 label 过滤管理容器生命周期
export const LABEL_APP_KEY = 'app'
export const LABEL_APP_VALUE = 'openclaw-fleet'
export const LABEL_INSTANCE_KEY = 'openclaw.instance'
export const LABEL_PORT_KEY = 'openclaw.port'
// #696 一次性临时容器标记（runOnce）：与 fleet 三标签互斥——临时容器不写 app/instance/port 标签、
// 不发布宿主端口，故 listFleet（按 app 过滤）与端口对账均不可见；本标签仅用于「认出临时容器」
//（daemon 侧泄漏排查 / 冒烟断言）。
export const LABEL_ONESHOT_KEY = 'openclaw.oneshot'
export const LABEL_ONESHOT_VALUE = 'true'
// 容器内 home 路径（openclaw.json 落其内默认路径 ~/.openclaw/openclaw.json——静态 config，无独立
// config bind）。#591 时指「home 目录 rw host bind」（承载 workspace/wiki/state/logs）；#590/ADR 0011
// 起默认走 named volume 拓扑（三卷，见 MOUNT_*），host bind 仅遗留路径/调试用。
export const HOME_BIND = '/home/node/.openclaw'
// 三卷在容器内的挂载点（#590 拓扑）：挂载布局是共享内核纯知识——真容器 buildRunOptions 与
// files 域树根（FILE_ROOTS）都从这里取，防路径字面量多处手写漂移；home 卷直接挂 HOME_BIND。
export const MOUNT_WIKI = `${HOME_BIND}/wiki/main`
export const MOUNT_WORKSPACE = `${HOME_BIND}/workspace`
// gateway 网络绑定模式（容器内 gateway 绑 lan，宿主侧靠 Docker 端口映射隔离）
export const GATEWAY_BIND = 'lan'
// env 占位：真 token 绝不落盘 JSON，保留 ${GATEWAY_TOKEN} 由 gateway 进程运行时插值
export const GATEWAY_TOKEN_PLACEHOLDER = '${GATEWAY_TOKEN}'

// --- 编排状态机协议常量 ---
// gateway_token 熵（GATEWAY_TOKEN）：32 字节 = 256 bit
export const TOKEN_URLSAFE_BYTES = 32
