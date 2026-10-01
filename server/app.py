"""VISTA Phase 2 server — redaction-aware planner: VLM first, heuristic fallback.

- VLM (Ollama open-weights, default qwen2.5vl:3b) sees ONLY sanitized input and
  its output is validated/clamped (see vlm.py). Default OFF for fast demos.
- Heuristic keyword-grounder (Phase 0) remains the always-available fallback,
  so /plan works with zero model weights.
Keep request/response schemas stable — extension depends on them.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timezone
import os
import re
from pathlib import Path
try:
    from .schemas import PlanRequest, PlanResponse  # package run: uvicorn server.app:app
    from .vlm import vlm_config, ollama_reachable, plan_with_vlm
    from .cloud_vlm import cloud_config
except ImportError:
    from schemas import PlanRequest, PlanResponse  # flat run: cd server && uvicorn app:app
    from vlm import vlm_config, ollama_reachable, plan_with_vlm
    from cloud_vlm import cloud_config

app = FastAPI(title='VISTA server (phase2)')


def _load_dotenv():
    """Zero-dependency .env loader (server/.env, gitignored). Shell env wins."""
    try:
        p = Path(__file__).with_name('.env')
        if not p.exists():
            return
        for line in p.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and v and k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass


_load_dotenv()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

with open(Path(__file__).with_name('prompts') / 'redactionAware.system.txt', encoding='utf-8') as _f:
    SYSTEM_PROMPT = _f.read()


@app.get('/health')
def health():
    cfg = vlm_config()
    provider = cfg.get('provider', 'ollama')
    model = cfg['model'] if provider == 'ollama' else cloud_config()['model']
    reachable = (ollama_reachable(cfg['host']) if provider == 'ollama' else bool(model))
    return {
        'ok': True,
        'phase': 7,
        'system_prompt_chars': len(SYSTEM_PROMPT),
        'vlm': {
            'enabled': cfg['enabled'],
            'provider': provider,
            'model': model,
            'host': cfg['host'],
            'reachable': reachable if cfg['enabled'] else False,
        },
    }


@app.post('/plan', response_model=PlanResponse)
def plan(req: PlanRequest):
    cfg = vlm_config()
    if cfg['enabled']:
        kwargs, reason = plan_with_vlm(req, SYSTEM_PROMPT, cfg)
        if kwargs is not None:
            resp = _repair_clipboard_stall(req, PlanResponse(**kwargs))
            _audit(req, resp)
            return resp
        # VLM failed -> fall through to heuristic, recording why.
        resp = heuristic_plan(req)
        resp.planner = 'heuristic'
        resp.fallback_reason = reason
        _audit(req, resp)
        return resp
    resp = heuristic_plan(req)
    _audit(req, resp)
    return resp


def _repair_clipboard_stall(req: PlanRequest, resp: PlanResponse) -> PlanResponse:
    """Deterministic repair for flash-class models: while copied text is held,
    repeating a click that changed nothing means the model is stuck clicking
    toolbar/canvas nodes instead of pasting. Convert that step into a paste."""
    ls = req.last_step or {}
    if not req.clipboard_filled or resp.action != 'click':
        return resp
    if ls.get('action') != 'click' or ls.get('page_changed') is not False:
        return resp
    if ls.get('targetId') != resp.targetId:
        return resp
    resp.action = 'paste'
    resp.targetId = None
    resp.fallback_xy = None
    resp.value = None
    resp.fallback_reason = 'repair: repeated no-effect click with clipboard filled -> paste'
    return resp


# --- Phase 3: privacy audit log (D3 proof) ---
# Records SIZES and decisions only. Never goal text, DOM text, or image bytes,
# so the log itself is safe to screenshot for the SIH submission.
AUDIT_LOG: list = []


def _audit(req: PlanRequest, resp: PlanResponse):
    AUDIT_LOG.append({
        'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'url_host': req.url_host,
        'mode': req.mode,
        'nodes': len(req.semantic_dom or []),
        'image_bytes': len(req.screenshot_redacted_b64 or ''),
        'manifest': len(req.redaction_manifest or []),
        'planner': resp.planner,
        'action': resp.action,
        'target': resp.targetId,
        'fallback': resp.fallback_reason,
    })
    del AUDIT_LOG[:-50]


@app.get('/audit')
def audit():
    return {'entries': AUDIT_LOG}


def _search_query(goal):
    """Extract a search query from goals like 'search X on amazon website'.

    Returns '' when the goal is not a search task. Never returns passwords
    or site clauses — only the query portion, capped at 200 chars.
    """
    m = re.search(r'\bsearch\s+(.+)$', goal)
    if not m:
        return ''
    q = m.group(1)
    q = re.sub(r'\s+on\s+\S.*$', '', q)  # drop "on amazon website" site clause
    q = re.sub(r'\s+website\s*$', '', q)
    return q.strip()[:200]


SEARCH_INPUT_ROLES = {'searchbox', 'textbox', 'combobox'}


def heuristic_plan(req: PlanRequest) -> PlanResponse:
    """Keyword-grounder + offline search flow (type query, then Enter).

    Works with NO model weights, so tasks survive cloud outages.
    """
    goal = (req.goal or '').lower()
    words = [w for w in goal.replace("'", '').split() if len(w) > 3][:12]

    # --- Offline search flow: type into an empty search box, Enter when filled.
    query = _search_query(goal)
    if query:
        inputs = [e for e in req.semantic_dom
                  if (e.get('role') in SEARCH_INPUT_ROLES or e.get('tag') in ('input', 'textarea'))
                  and e.get('type') != 'password' and isinstance(e.get('id'), str)]
        prefer = lambda e: ('search' not in f"{e.get('name', '')} {e.get('role', '')}".lower(),
                            e.get('id'))
        empty = sorted([e for e in inputs if not e.get('value_present')], key=prefer)
        if empty:
            el = empty[0]
            return PlanResponse(
                thought=f'heuristic: type query into {el.get("id")} ({el.get("name")})',
                action='type', targetId=el.get('id'), value=query)
        filled = sorted([e for e in inputs if e.get('value_present')], key=prefer)
        if filled:
            el = filled[0]
            return PlanResponse(
                thought=f'heuristic: submit filled search {el.get("id")}',
                action='press', targetId=el.get('id'), key='Enter')

    best = None
    for el in req.semantic_dom:
        name = f"{el.get('name', '')} {el.get('text', '')} {el.get('context', {}).get('section', '')}".lower()
        score = sum(1 for w in words if w in name)
        if score > 0 and (best is None or score > best[0]):
            best = (score, el)
    if best:
        el = best[1]
        return PlanResponse(
            thought=f"heuristic: keyword overlap {best[0]} on {el.get('id')} ({el.get('name')})",
            action='click',
            targetId=el.get('id'),
        )
    # Nothing grounded -> ask client for vision (if dom mode) or scroll (if vision mode).
    if req.mode == 'dom' and not req.screenshot_redacted_b64:
        return PlanResponse(
            thought='heuristic: no DOM grounding; request vision pass',
            action='scroll',
            direction='down',
            pixels=600,
            need_vision=True,
        )
    interactives = [e for e in req.semantic_dom if e.get('interactive')]
    if interactives:
        return PlanResponse(
            thought='heuristic fallback: first interactive',
            action='click',
            targetId=interactives[0].get('id'),
        )
    return PlanResponse(thought='heuristic: nothing actionable', action='done', done=True)
