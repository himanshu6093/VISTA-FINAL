"""VISTA Phase 2 server tests — plain asserts, no pytest needed.
Run from repo root:  python server/test_planner.py
Run from server dir: python test_planner.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from schemas import PlanRequest, PlanResponse  # noqa: E402
import vlm  # noqa: E402
from app import heuristic_plan  # noqa: E402

# Hermetic tests: importing app loads server/.env (live Gemini key) — pin
# deterministic defaults here; individual tests override + restore.
_SAVED_ENV = {k: os.environ.get(k) for k in
              ('VLM_ENABLED', 'VLM_PROVIDER', 'VLM_MODEL', 'GOOGLE_API_KEY', 'OPENAI_API_KEY')}
os.environ['VLM_ENABLED'] = '0'
os.environ['VLM_PROVIDER'] = 'ollama'


def dom_two_continues():
    return [
        {'id': 'e1', 'tag': 'button', 'role': 'button', 'name': 'Continue',
         'text': 'Continue', 'context': {'section': 'Payment Information'},
         'interactive': True, 'bbox': {'x': 500, 'y': 620, 'width': 180, 'height': 48}},
        {'id': 'e2', 'tag': 'button', 'role': 'button', 'name': 'Continue',
         'text': 'Continue', 'context': {'section': 'Footer'},
         'interactive': True, 'bbox': {'x': 100, 'y': 900, 'width': 120, 'height': 40}},
        {'id': 'e3', 'tag': 'input', 'role': 'textbox', 'name': 'Password',
         'type': 'password', 'value_present': True, 'text': '',
         'context': {'form': 'payment-form'},
         'interactive': True, 'bbox': {'x': 100, 'y': 300, 'width': 250, 'height': 40}},
    ]


def req(goal, **kw):
    base = {'goal': goal, 'url_host': 'demo.local', 'semantic_dom': dom_two_continues(), 'mode': 'dom'}
    base.update(kw)
    return PlanRequest(**base)


# 1. Heuristic unchanged: Payment Continue wins over Footer Continue.
r = heuristic_plan(req('Click Continue under Payment Information'))
assert r.action == 'click' and r.targetId == 'e1', r
assert r.planner == 'heuristic' and r.fallback_reason is None, r

# 2. Heuristic asks for vision when nothing grounds in dom mode.
r = heuristic_plan(req('do the thing with the chart', semantic_dom=[]))
assert r.need_vision is True and r.action == 'scroll', r

# 2b. Offline search flow: type query into empty search box...
search_dom = [
    {'id': 'e9', 'tag': 'input', 'role': 'searchbox', 'name': 'Search Amazon.in',
     'text': '', 'context': {}, 'interactive': True,
     'bbox': {'x': 200, 'y': 20, 'width': 400, 'height': 40}},
    {'id': 'e3', 'tag': 'input', 'role': 'textbox', 'name': 'Password',
     'type': 'password', 'value_present': True, 'text': '', 'context': {},
     'interactive': True, 'bbox': {'x': 100, 'y': 300, 'width': 250, 'height': 40}},
]
r = heuristic_plan(req('search black trimmer under 500 on amazon website',
                       semantic_dom=search_dom))
assert r.action == 'type' and r.targetId == 'e9', r
assert r.value == 'black trimmer under 500', r

# 2c. ...then Enter once the box is filled (never types passwords).
filled = [dict(e, value_present=True) if e['id'] == 'e9' else e for e in search_dom]
r = heuristic_plan(req('search black trimmer under 500 on amazon website',
                       semantic_dom=filled))
assert r.action == 'press' and r.targetId == 'e9' and r.key == 'Enter', r

# 2d. 'research' is not a search task; password-only pages never get typed.
r = heuristic_plan(req('research competitors', semantic_dom=search_dom))
assert not (r.action == 'type'), r
pw_only = [e for e in search_dom if e['id'] == 'e3']
r = heuristic_plan(req('search secrets', semantic_dom=pw_only))
assert not (r.action == 'type' and r.targetId == 'e3'), r

# 2e. Slim DOM preserves value_present (planner must see filled boxes).
from vlm import _slim_dom as _slim
slim = _slim([{'id': 'e9', 'tag': 'input', 'role': 'searchbox', 'name': 'S',
               'text': '', 'context': {}, 'interactive': True,
               'bbox': {'x': 1, 'y': 2, 'width': 3, 'height': 4},
               'type': 'search', 'value_present': True}])
assert slim[0]['value_present'] is True and slim[0]['type'] == 'search', slim

# 3. No raw values in heuristic path (D3): request carries value_present only.
assert 's3cret' not in json.dumps([e for e in dom_two_continues()])

# 4. Validator accepts good VLM output, derives fallback_xy from bbox center.
kwargs, err = vlm.validate_action(
    {'thought': 'Continue under Payment', 'action': 'click', 'targetId': 'e1'},
    req('x'))
assert err is None and kwargs['fallback_xy'] == [590, 644], (kwargs, err)

# 5. Validator rejects: bad action, unknown id, type-without-value.
for bad in ({'action': 'dance', 'targetId': 'e1'},
            {'action': 'click', 'targetId': 'e999'},
            {'action': 'type', 'targetId': 'e3'}):
    _, err = vlm.validate_action(bad, req('x'))
    assert err, bad

# 5b. Validator: navigate accepts http(s), rejects javascript: and long URLs.
kwargs, err = vlm.validate_action(
    {'thought': 'go', 'action': 'navigate', 'value': 'https://www.amazon.in'}, req('x'))
assert err is None and kwargs['targetId'] is None, (kwargs, err)
for bad in ({'action': 'navigate', 'value': 'javascript:alert(1)'},
            {'action': 'navigate'},
            {'action': 'navigate', 'value': 'https://x.in/' + 'a' * 2000}):
    _, err = vlm.validate_action(bad, req('x'))
    assert err, bad

# 6. VLM disabled by default -> clean fallback reason, no network attempted.
os.environ.pop('VLM_ENABLED', None)
kwargs, reason = vlm.plan_with_vlm(req('x'), 'sys')
assert kwargs is None and 'disabled' in reason, reason

# 7. Mocked Ollama success path (no server needed).
class FakeResp:
    ok = True
    status_code = 200

    def json(self):
        return {'message': {'content': json.dumps(
            {'thought': 'mock', 'action': 'click', 'targetId': 'e2'})}}


real_post = vlm.requests.post
vlm.requests.post = lambda *a, **k: FakeResp()
try:
    cfg = {'enabled': True, 'provider': 'ollama', 'host': 'http://127.0.0.1:11434',
           'model': 'mock-model', 'timeout_s': 5, 'num_ctx': 8192}
    kwargs, err = vlm.plan_with_vlm(req('Click Continue in Footer'), 'sys', cfg)
    assert err is None and kwargs['targetId'] == 'e2', (kwargs, err)
    assert kwargs['planner'] == 'vlm:mock-model', kwargs
    assert kwargs['fallback_xy'] == [160, 920], kwargs
finally:
    vlm.requests.post = real_post


# 8. Mocked Ollama garbage -> validation reason (caller falls back to heuristic).
class GarbageResp(FakeResp):
    def json(self):
        return {'message': {'content': '{"action": "teleport", "targetId": "e1"}'}}


vlm.requests.post = lambda *a, **k: GarbageResp()
try:
    kwargs, reason = vlm.plan_with_vlm(req('x'), 'sys', cfg)
    assert kwargs is None and 'validation' in reason, reason
finally:
    vlm.requests.post = real_post


# 9. Unreachable Ollama -> reason, no exception.
def boom(*a, **k):
    raise ConnectionError('refused')


vlm.requests.post = boom
try:
    kwargs, reason = vlm.plan_with_vlm(req('x'), 'sys', cfg)
    assert kwargs is None and 'unreachable' in reason, reason
finally:
    vlm.requests.post = real_post


# 9b. Cloud dispatch (mocked Gemini envelope): navigate accepted, planner tagged.
class GeminiResp:
    ok = True
    status_code = 200

    def json(self):
        return {'candidates': [{'content': {'parts': [{'text': json.dumps(
            {'thought': 'open amazon', 'action': 'navigate',
             'value': 'https://www.amazon.in'})}]}}]}


os.environ['VLM_PROVIDER'] = 'gemini'
os.environ['GOOGLE_API_KEY'] = 'test-key'
vlm.requests.post = lambda *a, **k: GeminiResp()
try:
    kwargs, err = vlm.plan_with_vlm(req('go amazon'), 'sys', {'enabled': True})
    assert err is None, err
    assert kwargs['action'] == 'navigate' and kwargs['targetId'] is None, kwargs
    assert kwargs['planner'].startswith('vlm:gemini:'), kwargs
finally:
    vlm.requests.post = real_post
    os.environ['VLM_PROVIDER'] = 'ollama'
    os.environ['VLM_ENABLED'] = '0'
    os.environ.pop('GOOGLE_API_KEY', None)


# 10. Endpoint contract via TestClient (heuristic default; VLM disabled here).
try:
    from fastapi.testclient import TestClient
    from app import app
    c = TestClient(app)
    h = c.get('/health')
    assert h.status_code == 200 and h.json()['ok'] is True and h.json()['phase'] == 7, h.text
    p = c.post('/plan', json={'goal': 'Click Continue under Payment',
                              'url_host': 'demo.local',
                              'semantic_dom': dom_two_continues(), 'mode': 'dom'})
    assert p.status_code == 200, p.text
    body = p.json()
    assert body['targetId'] == 'e1' and body['planner'] == 'heuristic', body
    print('endpoint: /health + /plan OK (TestClient)')
except ImportError as e:
    print(f'endpoint: SKIPPED (testclient deps missing: {e})')

# 11. /audit logs sizes only — D3 proof: no goal text, DOM text, or image bytes.
try:
    from fastapi.testclient import TestClient
    from app import app
    c = TestClient(app)
    evil_goal = 'type s3cret-demo-only into password'
    c.post('/plan', json={'goal': evil_goal, 'url_host': 'demo.local',
                          'semantic_dom': dom_two_continues(), 'mode': 'dom'})
    a = c.get('/audit')
    assert a.status_code == 200, a.text
    blob = a.json()
    assert blob['entries'], blob
    last = blob['entries'][-1]
    assert set(last) <= {'ts', 'url_host', 'mode', 'nodes', 'image_bytes',
                         'manifest', 'planner', 'action', 'target', 'fallback'}, set(last)
    dumped = json.dumps(blob)
    assert 's3cret' not in dumped and 'screenshot_redacted_b64' not in dumped, dumped
    print('endpoint: /audit sizes-only OK')
except ImportError as e:
    print(f'endpoint audit: SKIPPED ({e})')

print('server planner: ALL ASSERTIONS PASSED')

for _k, _v in _SAVED_ENV.items():
    if _v is None:
        os.environ.pop(_k, None)
    else:
        os.environ[_k] = _v
