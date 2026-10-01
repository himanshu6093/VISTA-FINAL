"""VISTA planner eval — replays D1/D2/D3-style payloads against /plan and scores
contract validity, grounding correctness, leak-freedom, and latency.
Baseline: heuristic (zero weights). Re-run with --base-url against a
VLM_ENABLED=1 server for the SIH latency/accuracy table.

Usage (repo root):
  python server/eval_planner.py [--base-url http://127.0.0.1:8000] [--out demo/eval-report.json]
Self-boot default: starts `uvicorn app:app --port 18010` in server/ and kills it.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BASE = 'http://127.0.0.1:18010'
TINY_PNG = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
            'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')


def dom():
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


CASES = [
    {'name': 'D1-payment', 'goal': 'Click Continue under Payment Information',
     'mode': 'dom', 'expect': {'action': 'click', 'targetId': 'e1'}},
    {'name': 'D1-footer', 'goal': 'Click Continue in the Footer section',
     'mode': 'dom', 'expect': {'action': 'click', 'targetId': 'e2'}},
    {'name': 'D3-leak-goal', 'goal': 'type s3cret-demo-only into the password field',
     'mode': 'dom', 'expect': {}, 'leakProbe': 's3cret-demo-only'},
    {'name': 'D1-no-grounding', 'goal': 'summarize the quarterly chart trends',
     'mode': 'dom', 'dom': [], 'expect': {'need_vision': True}},
    {'name': 'D2-vision-shape', 'goal': 'Click Submit next to the redacted address',
     'mode': 'vision', 'image': True,
     'manifest': [{'token': '<ADDRESS_HIDDEN>',
                   'bbox': {'x': 10, 'y': 10, 'width': 100, 'height': 20},
                   'source': 'ocr+pii'}],
     'expect': {}},
    {'name': 'A1-amazon-searchbox',
     'goal': 'search black trimmer under 500 on amazon website',
     'mode': 'dom',
     'dom': [
         {'id': 'e9', 'tag': 'input', 'role': 'searchbox',
          'name': 'Search Amazon.in', 'text': '', 'context': {},
          'interactive': True, 'bbox': {'x': 200, 'y': 20, 'width': 400, 'height': 40}},
         {'id': 'e10', 'tag': 'button', 'role': 'button',
          'name': 'Cart', 'text': 'Cart', 'context': {},
          'interactive': True, 'bbox': {'x': 900, 'y': 20, 'width': 60, 'height': 40}},
     ],
     'expect': {'action': 'type', 'targetId': 'e9',
                'value': 'black trimmer under 500'}},
]


def post(url, payload):
    data = json.dumps(payload).encode()
    t0 = time.perf_counter()
    req = urllib.request.Request(url + '/plan', data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=180) as r:
        body = json.load(r)
    return body, (time.perf_counter() - t0) * 1000


def get(url, path):
    with urllib.request.urlopen(url + path, timeout=30) as r:
        return json.load(r)


def main():
    args = sys.argv[1:]
    out = 'demo/eval-report.json'
    if '--out' in args:
        out = args[args.index('--out') + 1]
    base = BASE
    owned = True
    if '--base-url' in args:
        base = args[args.index('--base-url') + 1].rstrip('/')
        owned = False

    proc = None
    if owned:
        here = os.path.dirname(os.path.abspath(__file__))
        proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app',
                                 '--port', '18010'],
                                cwd=here, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                health = get(base, '/health')
                break
            except Exception:
                time.sleep(1)
        else:
            proc.kill()
            sys.exit('server failed to boot')
    try:
        health = get(base, '/health')
        planner = 'vlm' if health.get('vlm', {}).get('enabled') else 'heuristic'
        results = []
        for c in CASES:
            payload = {'goal': c['goal'], 'url_host': 'eval.local', 'mode': c['mode'],
                       'semantic_dom': c.get('dom', dom()),
                       'screenshot_redacted_b64': TINY_PNG if c.get('image') else None,
                       'redaction_manifest': c.get('manifest', [])}
            body, ms = post(base, payload)
            ok, notes = True, []
            for k, v in c['expect'].items():
                if body.get(k) != v:
                    ok, notes = False, notes + [f'{k}: want {v}, got {body.get(k)}']
            if body.get('action') not in ('click', 'type', 'select', 'scroll', 'press', 'done'):
                ok, notes = False, notes + ['action outside contract enum']
            if c.get('leakProbe'):
                # Hard invariant: user/goal text must never persist in /audit.
                # (A goal-derived echo inside the plan itself is the user's own
                # words coming back as instructions — page values, by contrast,
                # never reach the server at all: see DOM unit tests.)
                audit = get(base, '/audit')
                if c['leakProbe'] in json.dumps(audit):
                    ok, notes = False, notes + ['LEAK: probe found in /audit']
            results.append({'name': c['name'], 'ok': ok, 'ms': round(ms, 1),
                            'action': body.get('action'), 'target': body.get('targetId'),
                            'planner': body.get('planner'), 'notes': notes})
        report = {'planner': planner, 'model': health.get('vlm', {}).get('model'),
                  'cases': results,
                  'passed': sum(1 for r in results if r['ok']),
                  'total': len(results)}
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)
        print(f"planner={planner} passed={report['passed']}/{report['total']} -> {out}")
        print('name | ok | ms | action | target | notes')
        for r in results:
            print(f"{r['name']} | {r['ok']} | {r['ms']} | {r['action']} | "
                  f"{r['target']} | {'; '.join(r['notes'])}")
        return 0 if report['passed'] == report['total'] else 1
    finally:
        if proc:
            proc.kill()


if __name__ == '__main__':
    sys.exit(main())
