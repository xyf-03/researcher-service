# Upstream AutoFigure vendoring

本 sidecar 镜像自包含上游 AutoFigure 生成管线（构建上下文 = 本目录，零 host mount，
ADR 0013）。上游代码与署名文件以**逐字拷贝**形式 vendor 于此，与研究员服务仓库解耦。

## Pinned upstream

- **仓库**：`../AutoFigure`（relative to this workspace root）
- **commit**：`454ee868b9e253d2dbf990b42c4e964b93e498fd`
- **vendored 范围**（与 `autofigure/` 包导入链一致）：
  - `autofigure/` — 完整 Python 包（含 `references/paper/*.png` 5 张 bundled reference figures）
  - `LICENSE`（MIT）· `CITATION.cff` · `CITATION_AND_ATTRIBUTION.md` · `TRADEMARK.md`
  - `requirements-upstream.txt` — 上游 root `requirements.txt` 逐字拷贝

## Re-vendor 指引

```bash
# 在 workspace 根，researcher-service 与 AutoFigure 平级
UP=AutoFigure
DS=researcher-service/deploy/autofigure-sidecar
# 1. 记录新 pin
git -C "$UP" rev-parse HEAD
# 2. 覆盖拷贝（排除 __pycache__）
rsync -a --exclude '__pycache__' "$UP/autofigure/" "$DS/autofigure/"
cp "$UP/LICENSE" "$DS/LICENSE"
cp "$UP/CITATION.cff" "$DS/CITATION.cff"
cp "$UP/CITATION_AND_ATTRIBUTION.md" "$DS/CITATION_AND_ATTRIBUTION.md"
cp "$UP/TRADEMARK.md" "$DS/TRADEMARK.md"
cp "$UP/requirements.txt" "$DS/requirements-upstream.txt"
# 3. 更新本文件 pinned commit；跑 service/tests 契约接缝回归
```

## 为什么 vendor 而非 sibling build context

- `deploy/openclaw-image/Dockerfile` 先例：镜像构建上下文自包含（base 镜像 + 内部 skeleton），
  `docker build deploy/autofigure-sidecar` 无需外部仓库在场。
- 零 host mount（ADR 0013）要求运行时镜像内自足。
- 风险 = vendor 快照与上游漂移；缓解 = 本文件 pin commit + re-vendor 指引 + 契约接缝测试。

## 上游包导入链（本地契约测试只需以下子集）

`import autofigure`（经 `__init__.py`）→ agent/extractor/enhancer/generator。模块级依赖：
`openai` · `Pillow` · `cairosvg`（需 libcairo2）· `requests`。`extractor` 对 pdfplumber/PyMuPDF
懒导入；`judge.py`（matplotlib/google-genai）不被任何 import 链引用——不参与导入。
完整运行面（LLM 调用 + Playwright 导出）需要 `requirements-upstream.txt` 全量 + chromium，
见 `Dockerfile`。
