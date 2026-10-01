# VISTA offscreen/vision — Phase 1 port status: DONE (lazy-load adapters)

Originals byte-copied from helo-ayush/VISTA `src/modules/`; only import headers
were adapted (see PORT notes in each file). Verify hashes vs source if needed.

- [x] `faceDetector.js` — YuNet, header PORTed to lazy `onnxruntime-web` via importmap.
- [x] `ocrService.js` — PaddleOCR, header PORTed to lazy `ppu-paddle-ocr/web` via importmap.
- [x] `piiDetector.js` — header PORTed to lazy transformers; Phase 4 NER guarded
      (regex-only fallback, 54 rules, 14/14 smoke test). All regex/shield logic identical.
- [x] `redactionCanvas.js` — UNCHANGED (relative import only).
- [x] `qrDetector.js` — header PORTed to lazy `jsqr`; `detectQRCodesRGBA` now async.
- [x] `modelManager.js` — UNCHANGED (relative imports only; calls lazy loaders).
- [x] `assetHelper.js` — REWRITTEN for `chrome.runtime.getURL` (was Vite `import.meta.env`).

Remaining for Phase 2:
- [ ] On-page E2E: load unpacked extension, run D1/D2/D3 in demo/tasks.md.
- [ ] Server VLM: swap `heuristic_plan()` for Qwen2-VL/Ollama (redaction-aware prompt ready).

Vanilla ES modules only (no React/Tailwind/npm here). Reference specs preserved
from the originals:

- YuNet `face_detection_yunet_2023mar.onnx` (~232KB): 640x640 BGR planar, score 0.35,
  NMS IoU 0.3 -> `[{x,y,width,height,score,landmarks[5]}]`.
- PaddleOCR `PP-OCRv6_tiny_det.ort` (1.88MB) + `_rec.ort` (4.53MB) + dict:
  `maxSideLength:960, recBatchSize:8, strategy:'per-box'` + `repairEmailArtifacts()`.
- PII: 54-rule regex suite (Indian Aadhaar/PAN/Voter/DL, cards, IFSC, UPI, phones,
  emails + UI_STOPWORDS + COMPANY_INDICATORS). BERT-NER lazy via CacheStorage
  `vista-models-cache`, never bundled (103MB).
- Redaction: pixelation blur + frosted fill + `<*_HIDDEN>` badges;
  manifest `[{token, bbox, source}]`.
- `modelManager`: `preloadAllModels(onProgress)` + `clearAllModelStorage()`.

Model hosting (do NOT commit .onnx to git):
- Dev: `extension/src/offscreen/vision/models/` (gitignored) loaded via `chrome.runtime.getURL`.
- Prod: lazy fetch from your CDN/release asset on first run, persist in CacheStorage. Show `Downloading Models: 45% (x MB)` pill (reuse `ModelStoragePill.jsx` logic as vanilla).

Perf budget to preserve: face 60-95ms, OCR det 69ms + rec ~350-550ms, PII regex <2ms / BERT 70-110ms, canvas 1-2ms. Total ~800-1200ms.
