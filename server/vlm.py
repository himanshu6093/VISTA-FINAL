"""VISTA Phase 2 — open-weights VLM planner (Ollama) with strict validation.

Design (SIH-safe):
- The VLM only ever sees SANITIZED input (semantic_dom with values stripped,
  redacted screenshot + <*_HIDDEN> manifest). Same contract as heuristic.
- The VLM is NEVER trusted blindly: every field is validated and clamped
  (action enum, targetId must exist in this step's semantic_dom, bbox-derived
  fallback_xy). Any failure -> return None -> caller falls back to heuristic.
- Default OFF (VLM_ENABLED=0). Enable with Ollama running:
      VLM_ENABLED=1 VLM_MODEL=qwen2.5vl:3b uvicorn app:app --port 8000
  Setup: install Ollama (Windows installer), `ollama pull qwen2.5vl:3b`
  (3B vision model, ~2GB, fits 16GB RAM alongside the browser).
"""
import json
import logging
import os

try:
    import requests
except ImportError:  # pragma: no cover - declared in requirements.txt
    requests = None

LOG = logging.getLogger('vista.vlm')

ACTIONS = {'click', 'type', 'select', 'scroll', 'press', 'done', 'navigate', 'copy', 'paste'}
# paste is deliberately absent: canvas apps (Excalidraw) expose no textbox node,
# so a target-less paste is valid — the client pastes onto the page itself.
NEED_TARGET = {'click', 'type', 'select', 'press', 'copy'}

# Hard input budget: DOM JSON dominates the context window.
MAX_NODES = 120


def vlm_config():
    return {
        'enabled': os.getenv('VLM_ENABLED', '0') == '1',
        'provider': os.getenv('VLM_PROVIDER', 'ollama').lower(),
        'host': os.getenv('OLLAMA_HOST', 'http://127.0.0.1:11434').rstrip('/'),
        'model': os.getenv('VLM_MODEL', 'qwen2.5vl:3b'),
        'timeout_s': int(os.getenv('VLM_TIMEOUT_S', '120')),
        'num_ctx': int(os.getenv('VLM_NUM_CTX', '8192')),
    }


def ollama_reachable(host, timeout_s=3):
    """Cheap probe for /health reporting. Never raises."""
    if requests is None:
        return False
    try:
        r = requests.get(f'{host}/api/tags', timeout=timeout_s)
        return r.ok
    except Exception:
        return False


def _slim_dom(semantic_dom):
    """Keep only planner-relevant keys so the prompt fits num_ctx."""
    slim = []
    for el in (semantic_dom or [])[:MAX_NODES]:
        if not isinstance(el, dict):
            continue
        ctx = el.get('context') or {}
        slim.append({
            'id': el.get('id'),
            'tag': el.get('tag'),
            'role': el.get('role'),
            'name': el.get('name'),
            'text': (el.get('text') or '')[:120],
            'context': {k: v for k, v in ctx.items() if v} or {},
            'interactive': bool(el.get('interactive')),
            'bbox': el.get('bbox'),
            # CRITICAL for multi-step flows: without this the planner cannot
            # tell a filled search box from an empty one and re-types forever.
            'value_present': bool(el.get('value_present', False)),
        })
        if el.get('type'):
            slim[-1]['type'] = el.get('type')
    return slim


def _strip_data_url(data_url):
    if not data_url:
        return None
    if ',' in data_url:
        return data_url.split(',', 1)[1]
    return data_url


def build_messages(req, system_prompt):
    """Serialize the SANITIZED request into Ollama chat messages."""
    user_payload = {
        'goal': req.goal,
        'mode': req.mode,
        'semantic_dom': _slim_dom(req.semantic_dom),
        'redaction_manifest': req.redaction_manifest or [],
    }
    # Feed the previous step's outcome back so the model can break no-op loops
    # (e.g. pressing Enter on an empty/unresponsive box repeatedly).
    last_step = getattr(req, 'last_step', None)
    if last_step:
        user_payload['last_step'] = last_step
    if getattr(req, 'clipboard_filled', False):
        user_payload['clipboard_filled'] = True
        user_payload['instruction'] = (
            'Clipboard already holds the copied text. On this page your job is to PASTE it: '
            'return {"action":"paste"} with no targetId on canvas/whiteboard apps, or with the '
            'textbox node id otherwise. Never copy again; never navigate back to the source page.')
    messages = [
        {'role': 'system', 'content': system_prompt},
        {'role': 'user', 'content': json.dumps(user_payload)},
    ]
    images = []
    if req.mode == 'vision' and req.screenshot_redacted_b64:
        b64 = _strip_data_url(req.screenshot_redacted_b64)
        if b64:
            images = [b64]
    return messages, images


def validate_action(raw, req):
    """Clamp raw model output to the contract. Returns (PlanResponse-kwargs, error)."""
    if not isinstance(raw, dict):
        return None, 'top-level JSON is not an object'
    action = raw.get('action')
    if action not in ACTIONS:
        return None, f'unknown action: {action!r}'

    by_id = {e.get('id'): e for e in (req.semantic_dom or []) if isinstance(e, dict)}
    target_id = raw.get('targetId')
    if action in NEED_TARGET:
        if not target_id or target_id not in by_id:
            return None, f'targetId {target_id!r} not in this step\'s semantic_dom'
    elif target_id and target_id not in by_id:
        target_id = None  # ignore stray ids on target-less actions

    value = raw.get('value')
    if action == 'type' and not value:
        return None, 'type action without value'
    if action == 'navigate':
        if not value or not str(value).startswith(('http://', 'https://')):
            return None, 'navigate without http(s) URL value'
        if len(str(value)) > 2000:
            return None, 'navigate URL too long'

    # Derive fallback_xy from the grounded node's bbox center when absent/invalid.
    fallback_xy = raw.get('fallback_xy')
    node = by_id.get(target_id) if target_id else None
    bbox = (node or {}).get('bbox') or {}
    if (not isinstance(fallback_xy, list) or len(fallback_xy) != 2) and bbox:
        try:
            fallback_xy = [int(bbox['x'] + bbox['width'] / 2), int(bbox['y'] + bbox['height'] / 2)]
        except (KeyError, TypeError):
            fallback_xy = None

    direction = raw.get('direction') if raw.get('direction') in ('up', 'down') else None
    if action == 'scroll' and direction is None:
        direction = 'down'

    return {
        'thought': str(raw.get('thought', ''))[:1000],
        'action': action,
        'targetId': target_id,
        'fallback_xy': fallback_xy,
        'value': str(value)[:2000] if value is not None else None,
        'direction': direction,
        'pixels': raw.get('pixels') if isinstance(raw.get('pixels'), int) else None,
        'key': raw.get('key') if raw.get('key') in ('Enter', 'Escape', 'Tab') else None,
        'done': bool(raw.get('done', action == 'done')),
        'need_vision': bool(raw.get('need_vision', False)),
    }, None


def plan_with_vlm(req, system_prompt, cfg=None):
    """Try the VLM. Returns (kwargs, None) on success, (None, reason) on failure.

    Callers MUST fall back to heuristic_plan() when kwargs is None.
    """
    cfg = cfg or vlm_config()
    if not cfg['enabled']:
        return None, 'VLM disabled (VLM_ENABLED!=1)'
    if requests is None:
        return None, 'requests library missing'
    if not req.goal:
        return None, 'empty goal'

    provider = str(cfg.get('provider') or os.getenv('VLM_PROVIDER', 'ollama')).lower()
    if provider in ('gemini', 'openai'):
        from cloud_vlm import plan_with_cloud, cloud_config
        ccfg = cloud_config()
        ccfg['provider'] = provider
        if cfg.get('model') and not os.getenv('VLM_MODEL'):
            ccfg['model'] = cfg['model']
        raw, err = plan_with_cloud(req, system_prompt, ccfg)
        if err:
            return None, err
        kwargs, verr = validate_action(raw, req)
        if verr:
            LOG.warning('VLM output rejected (%s); falling back to heuristic', verr)
            return None, f'validation: {verr}'
        kwargs['planner'] = f"vlm:{provider}:{ccfg['model']}"
        return kwargs, None

    messages, images = build_messages(req, system_prompt)
    body = {
        'model': cfg['model'],
        'messages': messages,
        'stream': False,
        'format': 'json',
        'options': {'temperature': 0, 'num_ctx': cfg['num_ctx']},
    }
    if images:
        body['images'] = images

    try:
        r = requests.post(f"{cfg['host']}/api/chat", json=body, timeout=cfg['timeout_s'])
    except Exception as e:
        return None, f'ollama unreachable: {str(e)[:150]}'
    if not r.ok:
        return None, f'ollama HTTP {r.status_code}: {r.text[:150]}'
    try:
        content = r.json()['message']['content']
        raw = json.loads(content)
    except Exception as e:
        return None, f'unparseable model output: {str(e)[:150]}'

    kwargs, err = validate_action(raw, req)
    if err:
        LOG.warning('VLM output rejected (%s); falling back to heuristic', err)
        return None, f'validation: {err}'
    kwargs['planner'] = f"vlm:{cfg['model']}"
    return kwargs, None
