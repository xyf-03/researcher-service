# T08 HTTP 契约测试（T07 sidecar-contract.md）：/health 可用性 + /v1/generate 请求/成功/失败形状。
# 使用 conftest._pipeline_stub 共享桩，经 app → bridge 全链路（无真 LLM/网络/浏览器）。
import base64
import json

import pytest

from app import app
from bridge import PNG_SIGNATURE
from conftest import KNOWN_PNG

CLIENT = app.test_client()


def _generate(prompt='draw a pipeline', api_key='sk-test-1234'):
    return CLIENT.post(
        '/v1/generate',
        json={'prompt': prompt},
        headers={'X-Autofigure-Api-Key': api_key},
    )


def test_health_returns_available():
    res = CLIENT.get('/health')
    assert res.status_code == 200
    assert res.get_json() == {'status': 'ok'}


def test_generate_success_contract_shape():
    res = _generate()
    assert res.status_code == 200
    body = res.get_json()
    assert body['ok'] is True
    assert isinstance(body['xml'], str)
    png = base64.b64decode(body['png_base64'])
    assert png.startswith(PNG_SIGNATURE)  # T07 契约 §5 PNG 8 字节签名
    assert json.loads(body['evaluation'])['overall_quality'] == 9.0


def test_generate_missing_credential_header_is_400():
    res = CLIENT.post('/v1/generate', json={'prompt': 'draw a pipeline'})
    assert res.status_code == 400
    body = res.get_json()
    assert body['ok'] is False
    assert body['error'] == 'missing_credential'


def test_generate_invalid_prompt_is_400():
    # 契约校验边界与 T07 `prompt: z.string().min(1).max(4000)` 精确一致：空串/超长/非字符串拒绝；
    # 纯空白字符串（'   '）是契约合法输入（无 .trim()），不放非法集。
    for bad in ('', 'x' * 4001, 42, None):
        res = CLIENT.post('/v1/generate', json={'prompt': bad}, headers={'X-Autofigure-Api-Key': 'k'})
        assert res.status_code == 400, bad
        body = res.get_json()
        assert body['ok'] is False
        assert body['error'] == 'invalid_prompt'


def test_whitespace_only_prompt_is_contract_valid():
    # 纯空白字符串命中契约 min(1)（zod 无 trim），应进入生成而非 400（契约忠实，不加严校验）。
    res = _generate(prompt='   ')
    assert res.status_code == 200
    assert res.get_json()['ok'] is True


def test_generate_malformed_json_is_400():
    res = CLIENT.post(
        '/v1/generate',
        data='{not json',
        content_type='application/json',
        headers={'X-Autofigure-Api-Key': 'k'},
    )
    assert res.status_code == 400
    assert res.get_json()['error'] == 'invalid_json'


def test_generate_pipeline_failure_is_2xx_ok_false(monkeypatch):
    import autofigure.generator as gen

    def broken_png(code, output_path, attempt_repair=False, output_format=None):
        return False, 'internal cairo explode'

    monkeypatch.setattr(gen, 'code_to_png', broken_png)
    res = _generate()
    assert res.status_code == 200
    body = res.get_json()
    assert body['ok'] is False
    assert body['error'] == 'png_export_failed'
    assert 'cairo' not in json.dumps(body)


def test_credential_never_in_response():
    secret = 'sk-very-secret-9999'
    res = _generate(api_key=secret)
    assert res.status_code == 200
    assert secret not in res.get_data(as_text=True)
