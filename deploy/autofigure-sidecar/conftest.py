# pytest 路径引导 + 契约接缝共享桩（T08 Testing seams，预商定接缝）。
#
# ROOT           -> `import autofigure`（vendored 上游包）
# ROOT/service   -> `import bridge` / `import app`
import base64
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent
for _p in (str(ROOT), str(ROOT / 'service')):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# 独立已知真值源：1x1 透明 PNG（标准已知字节，非从被测代码推导；T07 契约 §5 PNG 签名校验用）。
KNOWN_PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
)

# 契约接缝假体的已知产物（假体返回这些字面量，断言与其精确相等——独立来源，非重算）。
CANNED_XML = '<mxfile><diagram>canned diagram</diagram></mxfile>'
CANNED_EVAL = {
    'overall_quality': 9.0,
    'scores': {'aesthetic_design': 9.0, 'content_fidelity': 9.0, 'placeholder_usage': 9.0},
    'critique_summary': 'canned critique',
}


@pytest.fixture(autouse=True)
def _pipeline_stub(monkeypatch):
    """契约接缝默认桩：generate_initial_code / code_to_png / evaluate_code 替换为纯逻辑假体
    （无真 LLM/网络/浏览器）。测试可在其基础上再 monkeypatch 覆盖（后注册覆盖先注册）。"""
    import autofigure.generator as gen

    baseline = dict(gen.CONFIG)

    def fake_initial(paper_content, reference_figures, topic='paper', output_format=None):
        return CANNED_XML

    def fake_code_to_png(code, output_path, attempt_repair=False, output_format=None):
        with open(output_path, 'wb') as f:
            f.write(KNOWN_PNG)
        return True, code

    def fake_evaluate(code, code_image, paper_content, reference_figures, iteration,
                      topic='paper', output_format=None):
        return 9.0, dict(CANNED_EVAL)

    monkeypatch.setattr(gen, 'generate_initial_code', fake_initial)
    monkeypatch.setattr(gen, 'code_to_png', fake_code_to_png)
    monkeypatch.setattr(gen, 'evaluate_code', fake_evaluate)
    yield baseline
    # 兜底：即使被测代码异常退出也恢复 CONFIG 基线，保证跨用例隔离。
    gen.CONFIG.clear()
    gen.CONFIG.update(baseline)
