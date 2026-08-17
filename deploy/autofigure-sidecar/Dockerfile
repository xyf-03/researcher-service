# AutoFigure sidecar 镜像（T08，docs/autofigure/tickets/T08-python-sidecar.md）。
#
# 零 host mount（ADR 0013）：所有内容构建期入镜像；凭证运行时经私有 header / env 注入，镜像内无密钥。
# 构建上下文 = 本目录（自包含：vendored 上游包 + 薄桥 + 署名文件），对齐 deploy/openclaw-image 先例。
# T10 组装 panel-net 时引用本镜像；本票只保证镜像就绪（构建期断言验证）。
FROM python:3.12-slim

# libcairo2：`import cairosvg` 运行必需（上游 generator 模块级导入）。chromium 系统依赖由
# playwright install --with-deps 一并安装。passwd：提供 useradd/groupadd（降权 USER 用）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends libcairo2 passwd \
    && rm -rf /var/lib/apt/lists/*

# PLAYWRIGHT_BROWSERS_PATH 前置：chromium 缓存落到 /ms-playwright（构建期 root 写，运行期归
# 非 root 用户读——见下方 USER 降权）。
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# 依赖先装（层缓存）：上游管线全量依赖 + 薄桥服务依赖。
COPY requirements-upstream.txt service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements-upstream.txt \
    && pip install --no-cache-dir -r requirements.txt

# chromium + 系统依赖（mxGraph→PNG 导出必需，headless 无沙箱）。
RUN python -m playwright install --with-deps chromium

# vendored 上游包 + 薄桥服务 + 署名文件。
COPY autofigure/ ./autofigure/
COPY service/ ./service/
COPY LICENSE CITATION.cff CITATION_AND_ATTRIBUTION.md TRADEMARK.md ./

# 构建期断言（deploy/openclaw-image/Dockerfile 先例）：上游包可导入、playwright 可用、署名文件就位。
RUN python -c "import autofigure; from autofigure.generator import generate_initial_code, code_to_png, evaluate_code; print('autofigure import ok')" \
    && python -c "from playwright.sync_api import sync_playwright; print('playwright ok')" \
    && test -f /app/LICENSE && test -f /app/CITATION.cff \
    && test -f /app/CITATION_AND_ATTRIBUTION.md && test -f /app/TRADEMARK.md \
    && echo 'licensing files present'

# 降权运行（对齐 deploy/openclaw-image `USER node` 先例；sidecar 无需 root——无 host mount、
# 无 docker.sock，凭证经 header 注入）。chromium 浏览器缓存与 /app 归非 root 用户所有。
RUN useradd --create-home --uid 10001 autofigure \
    && chown -R autofigure:autofigure /app /ms-playwright
USER autofigure

WORKDIR /app/service
EXPOSE 8080

# 1 worker + 少量线程：生成被 bridge 锁串行化（concurrency=1），多余线程仅服务 /health。
# --timeout 0：生成可达数分钟，禁用 gunicorn worker 超时（V1 唯一 execution timeout 在 researcher
# 侧 T04 AUTOFIGURE_JOB_TIMEOUT_MS；sidecar 无自有超时契约——T08 不新增 timeout policy）。
CMD ["gunicorn", "-w", "1", "--threads", "4", "--timeout", "0", "--bind", "0.0.0.0:8080", "app:app"]
