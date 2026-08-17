#!/usr/bin/env bash
# run-ai-research-pipeline driver —— 启动/停止/健康检查 控制面 + 前端开发服务器
#
# 用法：
#   .claude/skills/run-ai-research-pipeline/driver.sh start    # 后台启动控制面+前端
#   .claude/skills/run-ai-research-pipeline/driver.sh stop     # 停止控制面+前端
#   .claude/skills/run-ai-research-pipeline/driver.sh status   # 健康检查
#   .claude/skills/run-ai-research-pipeline/driver.sh wait     # 阻塞等待两端就绪（超时 30s）
#
# PID 文件写入 /tmp/ai-research-pipeline-{server,frontend}.pid
# 日志写入 /tmp/ai-research-pipeline-{server,frontend}.log
# （#341 M9：Django backend 退役，控制面 = server/ TS/Express，端口 8001。）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 项目根目录（.claude/skills/run-ai-research-pipeline/ → 项目根）
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SERVER_DIR="$PROJECT_ROOT/server"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
SERVER_PID_FILE="/tmp/ai-research-pipeline-server.pid"
FRONTEND_PID_FILE="/tmp/ai-research-pipeline-frontend.pid"
SERVER_LOG="/tmp/ai-research-pipeline-server.log"
FRONTEND_LOG="/tmp/ai-research-pipeline-frontend.log"
SERVER_PORT=8001
FRONTEND_PORT=5173
WAIT_TIMEOUT=30

_ensure_node_modules() {
  # 不仅仅检查目录存在——检查 package.json 中的依赖是否已全部安装。
  # node_modules 目录可能因 npm 中途中断、手动删除子目录、或 worktree 软链而部分缺失。
  local dir="$1"
  if [ -d "$dir/node_modules" ]; then
    cd "$dir"
    if npm ls --depth=0 --silent 2>/dev/null; then
      return 0
    fi
    echo "[driver] $dir node_modules 不完整，重新安装 …"
  else
    echo "[driver] 安装 $dir 依赖 …"
  fi
  cd "$dir" && npm install
}

_ensure_db() {
  echo "[driver] 生成 Prisma client + 落表 …"
  cd "$SERVER_DIR"
  npm run prisma:generate >/dev/null 2>&1
  npm run db:apply 2>&1 | tail -2
}

_load_env() {
  # codex P2 :64：shell 环境变量优先于 deploy/.env——仅注入调用方当前未设置的变量，
  # 避免 `LLM_API_KEY=new driver.sh start` 被 .env 的空值/旧值覆盖（→ 503 / 错凭证）。
  # 对齐 python-dotenv load_dotenv() 默认「不覆盖既有 env」语义，落实文件注释承诺的
  # 「用户也可改用 shell 环境变量注入」。值按文档 KEY=VALUE 字面量取（首个 = 之后整段，
  # 不做 $ 展开/去引号——本仓库 .env.example 无此类值）。可选 $1 指定路径便于自测。
  local env_file="${1:-$PROJECT_ROOT/deploy/.env}"
  [ -f "$env_file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"        # 去行首空白
    [ -z "$line" ] && continue
    [ "${line:0:1}" = "#" ] && continue             # 跳过注释
    case "$line" in *=*) : ;; *) continue ;; esac   # 仅 KEY=VALUE 行
    key="${line%%=*}"                               # 首个 = 之前
    val="${line#*=}"                                # 首个 = 之后（含后续 =）
    [ "${key:0:7}" = "export " ] && key="${key#export }"   # 去可选 export 前缀
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    # 合法完整 shell 标识符（codex P2 :84）：case 的 glob `[A-Za-z_][A-Za-z0-9_]*` 里
    # `*` 是通配（匹配任意字符），GOOD.KEY/AB@CD 这类非法 identifier 会被首/次字符放行，
    # 随后间接展开 ${!key+x} 仍抛「无效的变量名」→ set -e 终止 driver.sh 启动（前后端不启）；
    # 且 glob 强制第 2 个字符，合法单字符键（X=x）被静默跳过不注入。改用锚定整个串的正则
    # `[[ =~ ^...$ ]]` 精确判定完整 identifier：`-`/`.`/`@` 等一律拒，单字符键放行。
    # 调用方未设置才注入（已设置的 shell 值胜出——含显式空值）。
    if [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      [ -n "${!key+x}" ] || export "$key=$val"
    fi
  done < "$env_file"
  echo "[driver] 已加载 deploy/.env（shell 环境变量优先，未被覆盖）"
}

_ensure_fleet_image() {
  # 容器编排（POST /containers）依赖镜像已 pull：本机默认派生镜像（issue #588，ADR 0013：
  # pdftotext + wiki/workspace 骨架，基官方 browser 变体）未 pull 时 docker run 会触发 pull 阻塞/失败，
  # 前端表现为「容器一直 creating」。docker daemon 不可达时跳过（driver 仍起前后端，仅容器创建不可用）。
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || { echo "[driver] 警告: docker daemon 不可达，容器创建将不可用"; return 0; }
  local image="${OPENCLAW_IMAGE:-ghcr.io/acautomata/researcher-service/openclaw:latest}"   # 派生镜像（issue #588）；可覆盖回官方基线
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "[driver] 预拉 fleet 镜像 $image …"
    if docker pull "$image"; then
      echo "[driver] ✓ 镜像就绪"
    else
      echo "[driver] 警告: 拉取 $image 失败，容器创建将不可用（检查镜像名/登录/网络）"
    fi
  fi
}

_warn_llm_key() {
  # LLM_API_KEY 缺失 → create 容器前置校验返 90003（信封码，HTTP 200），前端显示业务错误。
  # 提前显式警告。
  if [ -z "${LLM_API_KEY:-}" ]; then
    echo "[driver] 警告: LLM_API_KEY 未设置 —— 创建容器将返 90003（'LLM_API_KEY is required but not configured'）"
    echo "          请在 deploy/.env 或环境变量中设置 LLM_API_KEY 后重启 driver"
  fi
}

_is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

_health_server() {
  curl -sf -o /dev/null "http://localhost:$SERVER_PORT/api/health" 2>/dev/null
}

_health_frontend() {
  curl -sf -o /dev/null "http://localhost:$FRONTEND_PORT" 2>/dev/null
}

cmd_start() {
  _load_env
  _ensure_node_modules "$SERVER_DIR"
  _ensure_node_modules "$FRONTEND_DIR"
  _ensure_db
  _ensure_fleet_image
  _warn_llm_key

  # ---- server（TS/Express 控制面）----
  if [ -f "$SERVER_PID_FILE" ] && _is_pid_alive "$(cat "$SERVER_PID_FILE")"; then
    echo "[driver] server 已在运行 (pid $(cat "$SERVER_PID_FILE"))"
  else
    echo "[driver] 启动 Express 控制面 (port $SERVER_PORT) …"
    cd "$SERVER_DIR"
    nohup npm run dev \
      > "$SERVER_LOG" 2>&1 &
    echo $! > "$SERVER_PID_FILE"
    echo "[driver] server pid=$(cat "$SERVER_PID_FILE")"
  fi

  # ---- frontend ----
  if [ -f "$FRONTEND_PID_FILE" ] && _is_pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
    echo "[driver] frontend 已在运行 (pid $(cat "$FRONTEND_PID_FILE"))"
  else
    echo "[driver] 启动 Vite (port $FRONTEND_PORT) …"
    cd "$FRONTEND_DIR"
    nohup npx vite --port "$FRONTEND_PORT" --strictPort \
      > "$FRONTEND_LOG" 2>&1 &
    echo $! > "$FRONTEND_PID_FILE"
    echo "[driver] frontend pid=$(cat "$FRONTEND_PID_FILE")"
  fi
}

cmd_wait() {
  local elapsed=0
  echo "[driver] 等待 server …"
  while ! _health_server; do
    sleep 1; elapsed=$((elapsed + 1))
    if [ $elapsed -ge $WAIT_TIMEOUT ]; then
      echo "[driver] ERROR: server 超时（${WAIT_TIMEOUT}s）"
      echo "--- server log tail ---"
      tail -20 "$SERVER_LOG" 2>/dev/null || true
      exit 1
    fi
  done
  echo "[driver] server 就绪 (${elapsed}s)"

  elapsed=0
  echo "[driver] 等待 frontend …"
  while ! _health_frontend; do
    sleep 1; elapsed=$((elapsed + 1))
    if [ $elapsed -ge $WAIT_TIMEOUT ]; then
      echo "[driver] ERROR: frontend 超时（${WAIT_TIMEOUT}s）"
      echo "--- frontend log tail ---"
      tail -20 "$FRONTEND_LOG" 2>/dev/null || true
      exit 1
    fi
  done
  echo "[driver] frontend 就绪 (${elapsed}s)"

  echo "[driver] ✓ 控制面与前端均已就绪"
  echo "  server:   http://localhost:$SERVER_PORT"
  echo "  frontend: http://localhost:$FRONTEND_PORT"
}

cmd_stop() {
  if [ -f "$SERVER_PID_FILE" ]; then
    local pid
    pid=$(cat "$SERVER_PID_FILE")
    if _is_pid_alive "$pid"; then
      echo "[driver] 停止 server (pid $pid) …"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        _is_pid_alive "$pid" || break
        sleep 0.1
      done
      _is_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$SERVER_PID_FILE"
    echo "[driver] server 已停止"
  else
    echo "[driver] server 未在运行（无 PID 文件）"
  fi

  if [ -f "$FRONTEND_PID_FILE" ]; then
    local pid
    pid=$(cat "$FRONTEND_PID_FILE")
    if _is_pid_alive "$pid"; then
      echo "[driver] 停止 frontend (pid $pid) …"
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do
        _is_pid_alive "$pid" || break
        sleep 0.1
      done
      _is_pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$FRONTEND_PID_FILE"
    echo "[driver] frontend 已停止"
  else
    echo "[driver] frontend 未在运行（无 PID 文件）"
  fi

  # 清理僵死子进程（tsx watch 会留子进程）
  pkill -f "tsx watch src/server.ts" 2>/dev/null || true
  pkill -f "vite.*--port $FRONTEND_PORT" 2>/dev/null || true
}

cmd_status() {
  echo "=== server ==="
  if [ -f "$SERVER_PID_FILE" ] && _is_pid_alive "$(cat "$SERVER_PID_FILE")"; then
    echo "  状态: 运行中 (pid $(cat "$SERVER_PID_FILE"))"
    _health_server && echo "  健康检查: ✓ /api/health 200" || echo "  健康检查: ✗ /api/health 不可达"
  else
    echo "  状态: 未运行"
  fi

  echo "=== frontend ==="
  if [ -f "$FRONTEND_PID_FILE" ] && _is_pid_alive "$(cat "$FRONTEND_PID_FILE")"; then
    echo "  状态: 运行中 (pid $(cat "$FRONTEND_PID_FILE"))"
    _health_frontend && echo "  健康检查: ✓ http://localhost:$FRONTEND_PORT 200" || echo "  健康检查: ✗ 不可达"
  else
    echo "  状态: 未运行"
  fi
}

case "${1:-help}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  wait)   cmd_wait ;;
  restart) cmd_stop; sleep 1; cmd_start; cmd_wait ;;
  help|--help|-h)
    echo "用法: driver.sh {start|stop|restart|status|wait}"
    ;;
  *)
    echo "未知命令: $1"; exit 1 ;;
esac
