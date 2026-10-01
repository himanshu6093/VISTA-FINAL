# VISTA_FINAL — Phase 8 done (fully working loop, VLM-verified)

Cross-browser vision: `pipeline-host.js` shared by Chromium offscreen doc and
Firefox hidden-tab host (`src/vision-page/`, same importmap targets, verified
resolving). Orchestrator `ensureVisionHost()` picks per browser; per-step
audit carries `visionHost: offscreen|tab`. Manifest gains gecko settings
(id + min 121.0). Firefox manual pass still required (no headless FF here).

## Eval baseline (live Gemini `gemini-flash-lite-latest`, `python server/eval_planner.py`)
| case | result | ms | action |
|---|---|---|---|
| D1-payment | pass | ~1600 | click e1 |
| D1-footer | pass | ~1250 | click e2 |
| D3-leak-goal | pass, probe absent from /audit | ~1850 | type e3 (user's own goal words) |
| D1-no-grounding | pass | ~8000 | scroll + need_vision |
| D2-vision-shape | pass (contract) | ~2000 | scroll |
| A1-amazon-searchbox | pass | ~1450 | type e9 + `black trimmer under 500` |
Full report: `demo/eval-report.json`. Heuristic fallback alone: ~15ms/step
(previous baseline). Re-run vs any server:
`python server/eval_planner.py --base-url http://127.0.0.1:8000`.

## Submission packaging
`powershell -ExecutionPolicy Bypass -File tools/package-store.ps1`
validates all 15 offline files (runtimes + weights), stages a clean tree
(no tests), and writes `dist/vista-extension-<ver>.zip` (0.3.0: 24.5MB).
VLM setup (reviewer machine): `server/setup-vlm.ps1` installs Ollama, pulls
`qwen2.5vl:3b`, and prints the eval command.

Privacy-preserving browser agent: local semantic-DOM + redacted-vision client, redaction-aware server.

## What landed in Phase 1
- `extension/src/content/semanticDom.js` — byte-copy of Semantic_DOM_Formatter
  `content.js` (SHA256-verified). 32/32 DOM unit tests pass (`extension/test/`).
- `extension/src/offscreen/vision/` — 6 VISTA modules integrated; only import
  headers adapted to lazy importmap loading (regex/PII logic bit-identical).
  PII smoke: 14/14 (`node extension/test/test_pii_regex.mjs`, 54 rules).
- `extension/src/offscreen/offscreen.js` — full pipeline (capture -> face -> OCR
  -> PII -> QR -> redaction -> JPEG + manifest), every stage degrades to DOM-only.
- `extension/manifest.json` — no remote code: importmap resolves to local
  `vendor/` (75 files/~15MB, import-scanned, all 7 specifiers resolve).
  CSP keeps `wasm-unsafe-eval` + HF/raw-github fallback hosts only.
- `vision/models/` — SHA256-verified weights local: YuNet 232KB, Paddle Tiny
  ~6.3MB, MiniLM-L6 ~22.6MB. `wasmPaths` pinned to `vendor/ort/` at boot
  (overrides paddle's CDN default). Total offline payload ~44MB, gitignored,
  reproducible via `vendor/README.md`.

Privacy-preserving browser agent: local semantic-DOM + redacted-vision client, redaction-aware server.

## Layout (current)
- `extension/` MV3 (Chrome 116+, Firefox-compat note below): background orchestrator + ContextEvaluator, content `semanticDom` stub + `actuator`, offscreen redaction stub + `vision/README` port checklist, popup goal runner.
- `server/` FastAPI stub (`/health`, `/plan` keyword-grounder, no weights) + `prompts/redactionAware.system.txt`.
- `shared/` action + redaction-manifest JSON schemas + semantic-dom example.
- `demo/tasks.md` 3 judging tasks.

## Run (Phase 2)
1. Server (heuristic default, zero weights):
   `cd server; pip install -r requirements.txt; uvicorn app:app --port 8000`
   Tests: `python server/test_planner.py` (heuristic + validator + mocked-VLM + live endpoint).
2. Server with open-weights VLM: install Ollama, `ollama pull qwen2.5vl:3b`, then
   `VLM_ENABLED=1 VLM_MODEL=qwen2.5vl:3b uvicorn app:app --port 8000`.
   Unvalidated/garbage output auto-falls-back to heuristic (`fallback_reason` set).
2b. Server with cloud VLM (smooth multi-step, ~2-4s/step): copy
   `server/.env.example` to `server/.env`, paste key, same uvicorn command.
   Providers: `VLM_PROVIDER=gemini` (default model gemini-2.0-flash) or
   `VLM_PROVIDER=openai` (+ `OPENAI_BASE_URL` for gateways). `.env` is gitignored.
3. Extension: `chrome://extensions` -> Developer mode -> Load unpacked -> `extension/`.
   Open a normal page, set goal, Run 1 step or Run loop. Reload the extension
   after pulling (service worker + offscreen changed in Phase 3).
4. Fixture: `cd demo && python -m http.server 8090` -> `fixture-two-continues.html` (D1/D3).

## Phase 3 additions
- Popup: Run loop (max steps) + Stop, before/after redaction preview (original
  labeled device-only, never uploaded), token counts, run trail, per-step audit.
- Model card: status pill, Preload (~30MB first run), Clear space.
- Offscreen relays model status/preload/clear; returns `original_b64` for local
  preview only (never in the server POST body).
- Server `/audit`: sizes-only log (nodes, image bytes, planner, action) — no
  goal text, DOM text, or pixels. D3 screenshot proof.

## Next (remaining)
- Live on-page E2E pass: D1/D2/D3 with 30s captures per demo/tasks.md
  (results in demo/E2E-LOG.md, incl. Firefox rows).
- VLM vision-mode grounding eval (redacted-image + manifest → click accuracy).
- Firefox manual pass: `about:debugging` → Load Temporary Add-on → fixture D1
  (DOM mode), then vision-only (hidden-tab fallback host, `visionHost: tab`).

## Privacy invariants (enforced in code)
- content.js never emits input `value` (only `type` + `value_present`).
- Server receives only sanitized DOM + redacted PNG + manifest. Raw pixels/values never POSTed.
- Popup audit panel shows exactly what left the browser per step.
