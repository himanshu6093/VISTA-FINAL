"""VISTA Phase 7 — cloud VLM providers (Gemini + OpenAI-compatible).

Why cloud: local 3B VLM on CPU = 30-90s per step (visible pauses). Cloud
flash-class models = ~2-4s per step, which is what makes multi-step tasks
("search black trimmer under 500 on amazon") feel smooth.

Privacy posture is UNCHANGED: providers receive only the sanitized payload
(semantic_dom with values stripped, redacted screenshot + <*_HIDDEN>
manifest). Raw pixels/values never leave the browser. Keys live in env
(.env file, never committed, never logged, never in /audit).

Returns (raw_dict, None) on transport success, (None, reason) on any failure.
Callers validate via vlm.validate_action() and fall back to heuristic.
"""
import json
import logging
import os

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

LOG = logging.getLogger('vista.cloud')

try:
    from vlm import _slim_dom  # flat run: cd server && uvicorn app:app
except ImportError:
    from server.vlm import _slim_dom  # package run: uvicorn server.app:app

DEFAULTS = {
    'gemini': 'gemini-flash-lite-latest',  # verified live 2026-09-30; 2.0/2.5 retired for new keys
    'openai': 'gpt-4o-mini',
}


def cloud_config():
    provider = os.getenv('VLM_PROVIDER', 'heuristic').lower()
    model = os.getenv('VLM_MODEL') or DEFAULTS.get(provider, '')
    return {
        'provider': provider,
        'model': model,
        'timeout_s': int(os.getenv('VLM_TIMEOUT_S', '60')),
        'num_ctx': int(os.getenv('VLM_NUM_CTX', '8192')),
        'google_key': os.getenv('GOOGLE_API_KEY', '') or os.getenv('GEMINI_API_KEY', ''),
        'openai_key': os.getenv('OPENAI_API_KEY', ''),
        'openai_base': os.getenv('OPENAI_BASE_URL', 'https://api.openai.com').rstrip('/'),
    }


def _slim_payload(req):
    payload = {
        'goal': req.goal,
        'mode': req.mode,
        'semantic_dom': _slim_dom(req.semantic_dom),
        'redaction_manifest': req.redaction_manifest or [],
    }
    last_step = getattr(req, 'last_step', None)
    if last_step:
        payload['last_step'] = last_step
    if getattr(req, 'clipboard_filled', False):
        payload['clipboard_filled'] = True
        payload['instruction'] = (
            'Clipboard already holds the copied text. On this page your job is to PASTE it: '
            'return {"action":"paste"} with no targetId on canvas/whiteboard apps, or with the '
            'textbox node id otherwise. Never copy again; never navigate back to the source page.')
    return payload


def _image_b64(req):
    data_url = req.screenshot_redacted_b64 or ''
    if req.mode == 'vision' and data_url and ',' in data_url:
        return data_url.split(',', 1)[1]
    return None


def plan_with_gemini(req, system_prompt, cfg):
    """Google AI Studio generateContent. Returns (raw, None)/(None, reason)."""
    if requests is None:
        return None, 'requests library missing'
    if not cfg['google_key']:
        return None, 'GOOGLE_API_KEY not set'
    if not cfg['model']:
        return None, 'VLM_MODEL not set'
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{cfg['model']}:generateContent?key={cfg['google_key']}")
    parts = [{'text': json.dumps(_slim_payload(req))}]
    img = _image_b64(req)
    if img:
        parts.append({'inline_data': {'mime_type': 'image/jpeg', 'data': img}})
    body = {
        'system_instruction': {'parts': [{'text': system_prompt}]},
        'contents': [{'role': 'user', 'parts': parts}],
        'generationConfig': {'temperature': 0, 'responseMimeType': 'application/json',
                             'maxOutputTokens': 1024},
    }
    try:
        r = requests.post(url, json=body, timeout=cfg['timeout_s'])
    except Exception as e:
        return None, f'gemini unreachable: {str(e)[:150]}'
    if not r.ok:
        return None, f'gemini HTTP {r.status_code}: {r.text[:200]}'
    try:
        data = r.json()
        text = ''.join(p.get('text', '') for p in
                       data['candidates'][0]['content']['parts'])
        return json.loads(text), None
    except Exception as e:
        return None, f'gemini unparseable output: {str(e)[:150]}'


def plan_with_openai(req, system_prompt, cfg):
    """OpenAI-compatible chat completions (OpenAI, Azure, Groq, OpenRouter...).

    Point OPENAI_BASE_URL at any compatible gateway; key via OPENAI_API_KEY.
    """
    if requests is None:
        return None, 'requests library missing'
    if not cfg['openai_key']:
        return None, 'OPENAI_API_KEY not set'
    if not cfg['model']:
        return None, 'VLM_MODEL not set'
    content = [{'type': 'text', 'text': json.dumps(_slim_payload(req))}]
    if req.mode == 'vision' and req.screenshot_redacted_b64:
        content.append({'type': 'image_url',
                        'image_url': {'url': req.screenshot_redacted_b64}})
    body = {
        'model': cfg['model'],
        'temperature': 0,
        'response_format': {'type': 'json_object'},
        'max_tokens': 1024,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': content},
        ],
    }
    try:
        r = requests.post(f"{cfg['openai_base']}/v1/chat/completions", json=body,
                          headers={'Authorization': f"Bearer {cfg['openai_key']}"},
                          timeout=cfg['timeout_s'])
    except Exception as e:
        return None, f'openai-gateway unreachable: {str(e)[:150]}'
    if not r.ok:
        return None, f'openai-gateway HTTP {r.status_code}: {r.text[:200]}'
    try:
        return json.loads(r.json()['choices'][0]['message']['content']), None
    except Exception as e:
        return None, f'openai-gateway unparseable output: {str(e)[:150]}'


def plan_with_cloud(req, system_prompt, cfg=None):
    """Dispatch by VLM_PROVIDER. Returns (raw, None)/(None, reason)."""
    cfg = cfg or cloud_config()
    if cfg['provider'] == 'gemini':
        return plan_with_gemini(req, system_prompt, cfg)
    if cfg['provider'] == 'openai':
        return plan_with_openai(req, system_prompt, cfg)
    return None, f"unknown cloud provider: {cfg['provider']!r} (want gemini|openai)"
