# AutoFigure 生成桥（T08，docs/autofigure/tickets/T08-python-sidecar.md）。
#
# 职责：把 T07 冻结私有契约的域输入（prompt）+ 服务端注入凭证 → 上游 AutoFigure 真实生成管线
# （vendored autofigure 包，见 UPSTREAM.md pin `454ee86`）→ 归一化 {xml, png_base64, evaluation}
# 或 {ok:false, error}。管线流程与上游 backend/autofigure_routes.py start_generation 逐点对应。
#
# 边界纪律：
#   - 无状态、无 JWT/userId：只收生成参数 + provider 凭证；topic 恒为 'paper'（V1 契约只传 prompt）。
#   - 凭证绝不落日志/响应/XML/evaluation：整个生成过程用 contextlib.redirect_stdout 抑制上游 stdout
#     （上游 call_unified_llm 把 api_key suffix 打到 stdout）。本模块日志只含固定类别 + 内部失败码，
#     绝不插值 header/凭证/pipeline 原始文本。
#   - 跨调用隔离：生成前 snapshot CONFIG、finally 恢复；threading.Lock 串行化「configure→生成→
#     restore」整段（CONFIG 是模块全局，必须原子；对齐 V1 concurrency=1）。
#   - 失败契约：所有内部/上游异常归一为短不透明代码（ok:false, error），绝不外泄 raw 文本。
import base64
import io
import json
import logging
import os
import tempfile
import threading
from contextlib import redirect_stdout
from pathlib import Path

from PIL import Image as _PILImage

from autofigure import generator as _generator  # vendored 上游包

logger = logging.getLogger('autofigure.bridge')

# PNG 8 字节签名（T07 契约 §5；与 researcher httpPort.decodePng 校验一致）。
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'

# CONFIG 是模块全局 → 生成串行化，保证 configure→生成→restore 原子；/health 由 gunicorn 线程服务。
_GENERATION_LOCK = threading.Lock()


class GenerationError(Exception):
    """归一化的生成失败（内部）：code 为短不透明失败码，可直接上 wire。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def generate(prompt, provider, api_key, model=None, base_url=None):
    """单次生成。成功 → {ok:True, xml, png_base64, evaluation}；失败 → {ok:False, error}。

    provider 由 sidecar env（AUTOFIGURE_PROVIDER）提供；api_key 来自 X-Autofigure-Api-Key header
    （请求级，绝不持久化）；model/base_url 可选（sidecar env，缺省走上游默认）。topic 恒为 'paper'
    （V1 契约只传 prompt；上游 start_generation 的默认 content type，无 topic 维度）。
    """
    if not isinstance(prompt, str) or not (1 <= _utf16_len(prompt) <= 4000):
        return _failure('invalid_prompt')
    if not api_key:
        return _failure('missing_credential')

    with _GENERATION_LOCK:
        snapshot = dict(_generator.CONFIG)
        try:
            # 抑制上游 stdout（整个生成过程）：call_unified_llm 打印 api_key suffix；
            # repair/validate 与 reference 加载打印内部细节/文件路径。生成由锁串行化，
            # redirect_stdout 只会罩住本请求的 pipeline 输出（gunicorn 日志走 stderr，不受影响）。
            with redirect_stdout(io.StringIO()):
                refs = _load_references()
                _configure_generator(provider, api_key, model, base_url)
                xml, png_bytes, evaluation = _run_pipeline(prompt, refs)
        except GenerationError as exc:
            logger.warning('autofigure bridge: generation failed: %s', exc.code)
            return _failure(exc.code)
        except Exception:  # 上游/playwright/网络任意异常 → 稳定不透明失败
            logger.warning('autofigure bridge: generation error')
            return _failure('generation_failed')
        finally:
            # 恢复 CONFIG 基线：凭证/OUTPUT_FORMAT 等调用级变更绝不在请求间残留。
            _generator.CONFIG.clear()
            _generator.CONFIG.update(snapshot)

    return {
        'ok': True,
        'xml': xml,
        'png_base64': base64.b64encode(png_bytes).decode('ascii'),
        'evaluation': json.dumps(evaluation),
    }


def _failure(code):
    return {'ok': False, 'error': code}


def _utf16_len(value):
    """UTF-16 code units 数——与 T07 冻结契约 zod `z.string().min(1).max(4000)` 的长度语义
    精确等价（Python len() 数码点，增补平面字符 1 码点 = 2 UTF-16 单元，会与契约边界偏离）。"""
    return len(value.encode('utf-16-le')) // 2


def _configure_generator(provider, api_key, model, base_url):
    """对齐上游 start_generation 的 CONFIG 注入：provider 专属 key/base_url/model + mxgraphxml。"""
    cfg = _generator.CONFIG
    cfg['LLM_PROVIDER'] = provider
    cfg['OUTPUT_FORMAT'] = 'mxgraphxml'
    if provider == 'openrouter':
        cfg['OPENROUTER_API_KEY'] = api_key
        cfg['OPENROUTER_MODEL'] = model or 'google/gemini-3.1-pro-preview'
        cfg['OPENROUTER_BASE_URL'] = base_url or 'https://openrouter.ai/api/v1'
    elif provider == 'bianxie':
        cfg['BIANXIE_API_KEY'] = api_key
        cfg['BIANXIE_CHAT_MODEL'] = model or 'gemini-3.1-pro-preview'
        cfg['BIANXIE_BASE_URL'] = base_url or 'https://api.bianxie.ai/v1'
    elif provider == 'gemini':
        cfg['GOOGLE_API_KEY'] = api_key
        cfg['GEMINI_MODEL'] = model or 'gemini-3.1-pro-preview'
        cfg['GEMINI_BASE_URL'] = base_url or 'https://generativelanguage.googleapis.com/v1beta/openai/'
    elif provider == 'kimi':
        # Formal Kimi Coding provider（T13，docs/autofigure/tickets/T13-kimi-coding-provider.md）。
        # 仍是 sidecar 级 transport 适配器：vendored generator.py 不识别 Kimi/KIMI_*（UPSTREAM pin
        # 454ee86），其 call_unified_llm 对未知 provider 落 else(bianxie) 分支（generator.py:137-143）
        # 读 BIANXIE_* 槽位，统一汇入 _call_openai_compatible（OpenAI 兼容 transport + image_url
        # 多模态）。故把 kimi 映射到既有 BIANXIE_* 槽位——**内部实现细节，不是用户可见的 provider**；
        # 不改 vendored CONFIG/代码、不新增 KIMI_* 槽位、不改变默认 provider（openrouter 仍是默认）。
        # base_url 缺省走唯一验证通过的官方端点 api.kimi.com/coding/v1（Moonshot 端点不隐含支持）。
        # model **必须显式提供**（AUTOFIGURE_MODEL）——视觉模型 ID 更新频繁，不作产品默认；
        # 缺 model 在 OpenAI 调用前本地 fail-fast（稳定短不透明配置错误，不泄漏内部细节/凭证）。
        if not model:
            raise GenerationError('missing_model')
        cfg['BIANXIE_API_KEY'] = api_key
        cfg['BIANXIE_BASE_URL'] = base_url or 'https://api.kimi.com/coding/v1'
        cfg['BIANXIE_CHAT_MODEL'] = model
    else:
        raise GenerationError('unsupported_provider')


def _run_pipeline(prompt, refs):
    """上游 V1 单次生成流程（start_generation 核心段，逐点对应）→ (xml, png_bytes, evaluation)。
    topic 恒为 'paper'（V1 契约只传 prompt；对齐上游 start_generation 的默认 content type）。"""
    xml = _generator.generate_initial_code(
        paper_content=prompt,
        reference_figures=refs,
        topic='paper',
        output_format='mxgraphxml',
    )
    if not xml:
        raise GenerationError('empty_xml')

    tmp_path = None
    code_image = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name

        success, _ = _generator.code_to_png(
            xml, tmp_path, attempt_repair=True, output_format='mxgraphxml')
        if not success or not os.path.exists(tmp_path):
            raise GenerationError('png_export_failed')
        with open(tmp_path, 'rb') as f:
            png_bytes = f.read()
        # PNG magic 前置校验：防截断/错误产物以 success 上 wire（researcher adapter 也会校验，双保险）。
        if not png_bytes.startswith(PNG_SIGNATURE):
            raise GenerationError('png_export_failed')
        code_image = _PILImage.open(tmp_path)

        score, evaluation = _generator.evaluate_code(
            code=xml,
            code_image=code_image,
            paper_content=prompt,
            reference_figures=refs,
            iteration=1,
            topic='paper',
            output_format='mxgraphxml',
        )
        if evaluation is None:
            evaluation = _generator.create_fallback_evaluation(5.0)
        return xml, png_bytes, evaluation
    finally:
        if code_image is not None:
            try:
                code_image.close()
            except Exception:
                pass
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _reference_dir():
    return Path(_generator.__file__).resolve().parent / 'references' / 'paper'


def _load_references():
    """加载 bundled paper reference figures（vendored 包内，5 张 PNG，对齐 get_reference_figures_for_topic）。
    失败归一为 GenerationError('reference_load_failed')（非敏感，可上 wire）。"""
    try:
        ref_dir = _reference_dir()
        paths = sorted(str(p) for p in ref_dir.glob('*.png'))
        if not paths:
            return []
        return _generator.load_reference_figures(paths)
    except Exception:
        raise GenerationError('reference_load_failed') from None
