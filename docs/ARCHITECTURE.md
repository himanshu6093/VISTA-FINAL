# VISTA — Architecture & Coverage Map (SIH submission reference)

## End-to-end dataflow (matches the architecture diagram)

```
User Goal (popup)
  |
  v
Semantic DOM Formatter (content/semanticDom.js — 8k nodes -> ~150, value_present only)
  |
  v
Context Evaluator (background/contextEvaluator.js) — Sufficient? --No--> Viewport Frame Grabber (offscreen captureVisibleTab)
  |                                                                              |
  Yes                                                                            v
  |                                                                     Face (YuNet) + OCR (PP-OCRv6 Tiny) + QR
  v                                                                              |
Multimodal Reasoning Engine (server: vlm.py VLM or heuristic) <-- Privacy Filter -- PII (54 regexes + opt. MiniLM) -> Canvas Redaction & Compositing (guided <TAG_HIDDEN> + manifest)
  |                                                                              (original pixels NEVER leave the browser)
  v Action JSON (shared/action-schema.json)
CDP Action Dispatcher equivalent: content/actuator.js via agentId map (no debugger prompt)
  |
  v Vision Mode ON loops back to Frame Grabber until done / max steps
```

## Diagram box -> code

| Diagram | File | Test |
|---|---|---|
| Semantic DOM Formatter | `extension/src/content/semanticDom.js` | 32 tests in `extension/test/` |
| Context Evaluator | `extension/src/background/contextEvaluator.js` | heuristic rules (keywords, node counts) |
| Viewport Frame Grabber | `extension/src/offscreen/pipeline-host.js` (`captureVisibleTab`) | live E2E |
| Face / OCR / PII models | `vision/{faceDetector,ocrService,piiDetector,qrDetector}.js` | `test_pii_regex.mjs` 14/14 |
| Canvas Redaction & Compositing | `vision/redactionCanvas.js` + `offscreen` fallback renderer | preview card |
| Multimodal Reasoning Engine (VLM) | `server/vlm.py` + `prompts/redactionAware.system.txt` | `server/test_planner.py` (mocked) |
| Action (JSON) | `shared/action-schema.json` + `server/schemas.py` | contract tests |
| CDP Action Dispatcher | `extension/src/content/actuator.js` (e-id map; CDP optional perm) | D1 E2E |
| Firefox host | `extension/src/vision-page/` (same pipeline-host) | FF rows in E2E-LOG |

## Expected Solution coverage

- Local Vision Processing (browser, WebGPU-capable ORT bundle, WASM EP default): YES — offscreen sandbox, ~30MB local weights.
- Privacy Preserving Filter (faces, passwords, PII; server redaction-aware): YES — blur + `<*_HIDDEN>` tokens + manifest + `value_present`-only DOM.
- Server integration (sanitized in, UI action out, open-weights): YES — FastAPI + Ollama `qwen2.5vl:3b` path, heuristic fallback, `/audit` sizes-only log.
- Latency/accuracy tradeoff: DOM path ~15ms vs vision ~800-1200ms budget; eval harness `server/eval_planner.py` produces the comparison table (`demo/eval-report.json`).

## Privacy invariants (enforced, tested)

1. `content.js` never emits input `value` (D3 test asserts absence).
2. Server POST = sanitized DOM + redacted JPEG + manifest (popup audit + `/audit` prove sizes only).
3. Original screenshot displayed locally only, labeled device-only.
4. VLM output validated/clamped (unknown action/id rejected → heuristic).
5. Cloud mode sends the user's goal text to the provider (it is the
   instruction); page values, DOM text, and raw pixels stay sanitized.
   Fully-offline mode (heuristic or Ollama) sends nothing anywhere.
