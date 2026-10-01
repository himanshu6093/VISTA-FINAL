/**
 * VISTA Phase 1 — offscreen vision pipeline (has DOM/canvas/Cache APIs).
 * Flow mirrors the VISTA web demo (App.jsx):
 *   capture -> faces (YuNet) -> OCR (PP-OCRv6 Tiny) -> PII (regex + opt. BERT)
 *         -> QR -> findBoxesToRedact -> renderCanvasOverlay -> redacted JPEG + manifest
 *
 * Every stage degrades gracefully: a failed stage logs a warning and yields [],
 * so the agent falls back to DOM-only instead of crashing the step.
 * Phase 1b: 100% offline — runtimes via local importmap, .wasm + models from
 * extension package. The only network use is the sanitized POST to the VISTA
 * server by the background orchestrator (never raw pixels/values).
 */
import { detectFaces } from './vision/faceDetector.js';
import { runDocumentOCR } from './vision/ocrService.js';
import { redactTextContent } from './vision/piiDetector.js';
import { findBoxesToRedact, renderCanvasOverlay } from './vision/redactionCanvas.js';
import { detectQRCodes } from './vision/qrDetector.js';
import { getVendorUrl } from './vision/assetHelper.js';

/**
 * Point ORT at the vendored .wasm BEFORE any session is created.
 * (ppu-paddle-ocr would otherwise default wasmPaths to the jsdelivr CDN.)
 * Same module instance as faceDetector/ocrService lazy imports (single
 * importmap resolution), so this covers the whole pipeline.
 */
let ortReady = null;
export function ensureLocalOrt() {
  if (!ortReady) {
    ortReady = import('onnxruntime-web').then((ort) => {
      try {
        // vendor/ort/ as directory URL (chrome) or relative (fallback).
        const dir = getVendorUrl('ort/');
        ort.env.wasm.wasmPaths = dir.endsWith('/') ? dir : `${dir}/`;
      } catch (e) {
        console.warn('[VISTA] could not set local wasmPaths:', e?.message ?? e);
      }
      return ort;
    }).catch((e) => {
      console.warn('[VISTA] onnxruntime-web unavailable:', e?.message ?? e);
      return null;
    });
  }
  return ortReady;
}
ensureLocalOrt();

/** Map detector tags -> guided semantic tokens (server is trained on these). */
export function tagToToken(tag) {
  const t = String(tag || '').toUpperCase();
  if (t === 'FACE') return '<FACE_HIDDEN>';
  switch (t) {
    case 'NAME':
    case 'SIGNATURE':
      return '<NAME_HIDDEN>';
    case 'HANDLE':
      return '<HANDLE_HIDDEN>';
    case 'ADDRESS':
    case 'LOCATION':
      return '<ADDRESS_HIDDEN>';
    case 'PHONE':
      return '<PHONE_HIDDEN>';
    case 'EMAIL':
      return '<EMAIL_HIDDEN>';
    default:
      return '<ID_HIDDEN>'; // cards, Aadhaar/PAN/IDs, order/tracking nos, QR, URLs, DOB, hashes…
  }
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode screenshot'));
    img.src = dataUrl;
  });
}

async function dataUrlToArrayBuffer(dataUrl) {
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

/** Last-resort compositor if renderCanvasOverlay (ported) throws on a shape. */
function simpleRedact(canvas, img, boxes) {
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  for (const b of boxes) {
    const x = Math.max(0, Math.round(b.x || 0));
    const y = Math.max(0, Math.round(b.y || 0));
    const w = Math.max(8, Math.round(b.width || 0));
    const h = Math.max(8, Math.round(b.height || 0));
    // pixelate
    const px = Math.max(6, Math.round(Math.min(w, h) / 8));
    const tiny = document.createElement('canvas');
    tiny.width = Math.max(1, Math.floor(w / px));
    tiny.height = Math.max(1, Math.floor(h / px));
    tiny.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, tiny.width, tiny.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
    // frosted band + token
    ctx.fillStyle = 'rgba(10,12,18,0.72)';
    ctx.fillRect(x, y + h - 20, w, 20);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(tagToToken(b.tag), x + 4, y + h - 6);
  }
}

async function runPipeline(dataUrl) {
  const timings = {};
  const t0 = performance.now();
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;

  let faces = [];
  try {
    const t = performance.now();
    ({ faces } = await detectFaces(img));
    timings.face_ms = Math.round(performance.now() - t);
  } catch (e) {
    timings.face_ms = -1;
    timings.face_error = String(e?.message ?? e).slice(0, 200);
  }

  let ocrItems = [];
  let fullText = '';
  try {
    const t = performance.now();
    const ocr = await runDocumentOCR(await dataUrlToArrayBuffer(dataUrl));
    ocrItems = ocr.items ?? [];
    fullText = ocr.fullText ?? '';
    timings.ocr_ms = Math.round(performance.now() - t);
  } catch (e) {
    timings.ocr_ms = -1;
    timings.ocr_error = String(e?.message ?? e).slice(0, 200);
  }

  let redactedEntities = [];
  let piiEngine = 'skipped (no OCR text)';
  try {
    const t = performance.now();
    if (fullText.trim()) {
      const pii = await redactTextContent(fullText);
      redactedEntities = pii.redactedEntities ?? [];
      piiEngine = pii.engine ?? piiEngine;
    }
    timings.pii_ms = Math.round(performance.now() - t);
  } catch (e) {
    timings.pii_ms = -1;
    timings.pii_error = String(e?.message ?? e).slice(0, 200);
  }

  let qrBoxes = [];
  try {
    const t = performance.now();
    qrBoxes = (await detectQRCodes(img)).map((q) => ({ ...q }));
    timings.qr_ms = Math.round(performance.now() - t);
  } catch (e) {
    timings.qr_ms = -1;
  }

  let boxes = [];
  try {
    boxes = findBoxesToRedact(ocrItems, redactedEntities, qrBoxes) ?? [];
  } catch (e) {
    timings.match_error = String(e?.message ?? e).slice(0, 200);
  }

  const canvas = document.createElement('canvas');
  try {
    renderCanvasOverlay(canvas, img, boxes, ocrItems, faces, 'guided');
    timings.render = 'guided';
  } catch (e) {
    timings.render_error = String(e?.message ?? e).slice(0, 200);
    try {
      simpleRedact(canvas, img, boxes);
      timings.render = 'fallback';
    } catch (e2) {
      // Never lose the pixels: an unredacted copy still beats no image at all.
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d').drawImage(img, 0, 0);
      timings.render = 'plain';
      timings.render_error += ' | ' + String(e2?.message ?? e2).slice(0, 120);
    }
  }

  const manifest = [
    ...faces.map((f) => ({
      token: '<FACE_HIDDEN>',
      bbox: { x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.width), height: Math.round(f.height) },
      source: 'face',
      confidence: f.score ?? null,
    })),
    ...boxes.map((b) => ({
      token: tagToToken(b.tag),
      bbox: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      source: 'ocr+pii',
    })),
  ];

  const redacted_b64 = canvas.toDataURL('image/jpeg', 0.9);
  timings.total_ms = Math.round(performance.now() - t0);
  // original_b64 is LOCAL-ONLY (popup before/after preview). It is passed to
  // the background for display and NEVER included in the server POST body.
  return { redacted_b64, original_b64: dataUrl, manifest, mode: 'vision', timings, piiEngine, ocrBoxes: ocrItems.length, faces: faces.length };
}

/**
 * Shared vision host logic — imported by BOTH:
 *  - offscreen.js (Chromium offscreen document), and
 *  - ../vision-page/vision-page.js (Firefox fallback extension page).
 * Pure async request -> response; each host wires its own onMessage listener.
 * Asset/model URLs come from assetHelper (chrome.runtime.getURL, absolute),
 * so this module works from any extension page. Importing it also pins
 * ORT wasmPaths locally via ensureLocalOrt().
 */

const VISION_TYPES = new Set([
  'VISTA_REDACT_SCREENSHOT',
  'VISTA_MODEL_STATUS',
  'VISTA_PRELOAD_MODELS',
  'VISTA_CLEAR_MODELS',
]);

export function handlesVisionMessage(msg) {
  return !!msg && VISION_TYPES.has(msg.type);
}

export async function handleVisionMessage(msg) {
  if (msg?.type === 'VISTA_MODEL_STATUS') {
    const { checkStorageUsage } = await import('./vision/modelManager.js');
    return { ...(await checkStorageUsage()), via: 'cache-api' };
  }
  if (msg?.type === 'VISTA_PRELOAD_MODELS') {
    const { preloadAllModels, checkStorageUsage } = await import('./vision/modelManager.js');
    await preloadAllModels();
    return { ...(await checkStorageUsage()), preloaded: true };
  }
  if (msg?.type === 'VISTA_CLEAR_MODELS') {
    const { clearAllModelStorage } = await import('./vision/modelManager.js');
    return { ...(await clearAllModelStorage()), cleared: true };
  }
  try {
    // Offscreen documents only expose chrome.runtime (no chrome.tabs), so the
    // background service worker captures and passes dataUrl. Extension-page
    // hosts (Firefox fallback tab) still have chrome.tabs and capture themselves.
    let dataUrl = msg.dataUrl ?? null;
    if (!dataUrl && typeof chrome !== 'undefined' && typeof chrome.tabs?.captureVisibleTab === 'function') {
      dataUrl = await chrome.tabs.captureVisibleTab(msg.windowId, { format: 'png' });
    }
    if (!dataUrl) {
      throw new Error('no screenshot dataUrl in message and chrome.tabs unavailable in this host');
    }
    return await runPipeline(dataUrl);
  } catch (e) {
    return {
      redacted_b64: null,
      original_b64: null,
      manifest: [],
      mode: 'capture-failed',
      error: String(e?.message ?? e).slice(0, 300),
      note: 'Screenshot capture failed (restricted page or no models yet) — orchestrator falls back to DOM-only.',
    };
  }
}
