# AutoFigure sidecar HTTP 表面（T08）。
#
# 私有 panel-net 契约（docs/autofigure/sidecar-contract.md）：
#   GET  /health         → {status: ok}（存活性探测，无域信息/凭证）
#   POST /v1/generate    → 请求 {prompt: 1-4000} + header X-Autofigure-Api-Key
#                          成功 {ok:true, xml, png_base64, evaluation}
#                          生成失败（2xx 内）{ok:false, error=<短不透明代码>}
#                          请求校验失败 → 400 {ok:false, error=<短不透明代码>}
#
# 无鉴权/CORS/JWT/userId（panel-net 私有）；凭证只经 header 进 bridge → CONFIG，绝不落日志/响应。
# provider/model/base_url 为 sidecar 级 env（AUTOFIGURE_PROVIDER/_MODEL/_BASE_URL）；API key 请求级注入。
import logging
import os

from flask import Flask, jsonify, request

from bridge import generate

logger = logging.getLogger('autofigure.app')

# 服务端配置（凭证除外——凭证经 header 请求级注入，绝不从 env 落盘到请求路径之外）。
_PROVIDER = os.environ.get('AUTOFIGURE_PROVIDER', 'openrouter')
_MODEL = os.environ.get('AUTOFIGURE_MODEL') or None
_BASE_URL = os.environ.get('AUTOFIGURE_BASE_URL') or None

_CREDENTIAL_HEADER = 'X-Autofigure-Api-Key'

app = Flask(__name__)


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


@app.route('/v1/generate', methods=['POST'])
def generate_route():
    api_key = request.headers.get(_CREDENTIAL_HEADER)
    if not api_key or not api_key.strip():
        return _reject('missing_credential')

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _reject('invalid_json')

    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not (1 <= len(prompt) <= 4000):
        return _reject('invalid_prompt')

    # 生成失败契约：2xx 内 {ok:false, error}（researcher adapter 的 res.ok 成立，解析失败 shape）。
    return jsonify(generate(
        prompt=prompt,
        provider=_PROVIDER,
        api_key=api_key.strip(),
        model=_MODEL,
        base_url=_BASE_URL,
    ))


def _reject(code):
    logger.warning('autofigure app: rejected request: %s', code)
    return jsonify({'ok': False, 'error': code}), 400
