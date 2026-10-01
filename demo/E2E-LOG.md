# E2E validation log — paste results back for fixes

Env: Chrome version ____ | server: heuristic / VLM(qwen2.5vl:3b) | commit ____

## S0 — Load
- [ ] `chrome://extensions` → reload VISTA → version shows 0.3.0, no Errors button
- [ ] `cd server && uvicorn app:app --port 8000` → `/health` ok, phase=2
- [ ] `cd demo && python -m http.server 8090` → fixture opens
- [ ] Popup → **Diagnose** → all 5 rows PASS (paste any FAIL row back as-is)

## D1 — Disambiguated click (fixture, dom-only, 1 step)
Goal: `Click Continue under Payment Information`
- [ ] Status line shows: `dom → click e__ [heuristic]`
- [ ] Payment Continue was clicked (form state/page changed), Footer untouched
- [ ] Audit panel: `nodesSent` > 0, `imageBytes` = 0
- Paste here on failure: status text + last lines of
  `chrome://extensions` → VISTA → Inspect views: service worker → Console

## D3 — Password never leaks (fixture)
- [ ] `GET /audit` (open `http://127.0.0.1:8000/audit`) contains sizes only
- [ ] Page Ctrl+F `s3cret` in audit response: no match
- [ ] Fixture password field still masked in extracted JSON (no `"value":`)

## P1 — Model preload (once)
- [ ] Popup model pill → Preload → status becomes `~29.x MB` (takes ~30-60s, WASM init)
- [ ] Reload extension → pill still shows cached size (CacheStorage persisted)

## D2 — Vision redaction (fixture in vision-only, or any photo page)
Goal: `Click Continue under Payment Information`
- [ ] Preview card appears: BEFORE (original) vs AFTER (blurred + `<TAG>` badges)
- [ ] Manifest line: N redactions + token counts, e.g. `{"<ID_HIDDEN>":1}`
- [ ] Timings present: `face_ms / ocr_ms / pii_ms / total_ms`
- [ ] Server `/audit` entry for this step: `image_bytes` > 0 AND no PII text in log
- Paste here on failure: `timings` object + `mode`/`error` fields from popup JSON

## Perf snapshot (for SIH latency/accuracy table)
- D1 dom step: ____ ms | D2 vision total: ____ ms (face __ / ocr __ / pii __)
- D1 success? Y/N | D2 action correct? Y/N

## A1 — Full task: "search black trimmer under 500 on amazon website"
Needs: cloud key in `server/.env` (`VLM_PROVIDER=gemini`), server restarted.
1. Any tab open (e.g. blank). Goal = the sentence above. Mode auto. **Run loop** (max 8).
2. Expected trail: `navigate amazon.in` → `type <query> into search box` →
   `press Enter` → `done` (results visible). ~2-4s per step, no long pauses.
3. If a step stalls (same action 3x) the loop stops with `stalled:true` — paste trail.
- [ ] Results page for "black trimmer" shows | steps used: __ | total time: __

## FF — Firefox temporary add-on (`about:debugging`)
- [ ] Loads without manifest errors (unknown `offscreen` permission warns only)
- [ ] Fixture D1 dom-only passes; trail shows `visionHost: none`
- [ ] Vision-only: hidden tab opens once, reused; trail shows `visionHost: tab`
- [ ] Preload/Clear model buttons work (same CacheStorage code path)
