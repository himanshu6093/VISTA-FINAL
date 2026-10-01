// EXTENSION PORT (Phase 1): jsQR lazy-loads via the offscreen import map;
// the native BarcodeDetector path is tried first and needs no library.
// Original web-demo header: `import jsQR from 'jsqr'`.
let _jsQR = undefined; // undefined = untried, null = unavailable, fn = ready
export async function ensureJsQR() {
  if (_jsQR !== undefined) return _jsQR;
  try {
    const m = await import('jsqr');
    _jsQR = m.default || m;
  } catch {
    _jsQR = null;
  }
  return _jsQR;
}

// --- Geometric sanity bounds for jsQR fallback results ---
const QR_MIN_BOX = 20;          // px, minimum side of an accepted QR quad
const QR_MAX_AREA_RATIO = 0.6;  // quad must not cover more than 60% of the image
const QR_MIN_ASPECT = 0.4;      // quad must be roughly square
const QR_MAX_ASPECT = 2.5;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function quadBBox(location) {
  const minX = Math.min(location.topLeftCorner.x, location.bottomLeftCorner.x);
  const maxX = Math.max(location.topRightCorner.x, location.bottomRightCorner.x);
  const minY = Math.min(location.topLeftCorner.y, location.topRightCorner.y);
  const maxY = Math.max(location.bottomLeftCorner.y, location.bottomRightCorner.y);
  return { minX, minY, maxX, maxY };
}

/**
 * Maps a jsQR result found in a sub-region (offset sx/sy, upscale factor `scale`)
 * back into full-image coordinates.
 */
function mapCodeToBox(code, sx, sy, scale) {
  const b = quadBBox(code.location);
  return {
    x: b.minX / scale + sx,
    y: b.minY / scale + sy,
    width: (b.maxX - b.minX) / scale,
    height: (b.maxY - b.minY) / scale
  };
}

/**
 * A jsQR result is only trusted when it carries a non-empty decodable payload AND the
 * located quad is geometrically sane (roughly square, bounded area). jsQR sometimes
 * returns bogus giant quads with an empty `data` payload on busy screenshots; those
 * must never become QR redaction boxes.
 */
function isPlausibleQRBox(box, imgW, imgH) {
  if (!box || box.width < QR_MIN_BOX || box.height < QR_MIN_BOX) return false;
  const aspect = box.width / Math.max(1, box.height);
  if (aspect < QR_MIN_ASPECT || aspect > QR_MAX_ASPECT) return false;
  if (box.width * box.height > imgW * imgH * QR_MAX_AREA_RATIO) return false;
  return true;
}

function acceptJsQRResult(code, sx, sy, scale, imgW, imgH) {
  if (!code || !code.location) return null;
  if (typeof code.data !== 'string' || code.data.length === 0) return null;
  const box = mapCodeToBox(code, sx, sy, scale);
  return isPlausibleQRBox(box, imgW, imgH) ? box : null;
}

/**
 * Copies a rectangular region of an RGBA buffer into `out` with optional nearest-neighbor
 * upscaling (scale 1 = copy, 2 = 2x). Returns `out` (allocated when missing/too small).
 */
function extractRegion(rgba, w, h, rx, ry, rw, rh, scale, out) {
  const sw = rw * scale;
  const sh = rh * scale;
  if (!out || out.length < sw * sh * 4) out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const sy = ry + Math.floor(y / scale);
    const srcRow = (sy * w + rx) * 4;
    const dstRow = y * sw * 4;
    if (scale === 1) {
      out.set(rgba.subarray(srcRow, srcRow + sw * 4), dstRow);
    } else {
      for (let x = 0; x < sw; x++) {
        const si = srcRow + Math.floor(x / scale) * 4;
        const di = dstRow + x * 4;
        out[di] = rgba[si];
        out[di + 1] = rgba[si + 1];
        out[di + 2] = rgba[si + 2];
        out[di + 3] = rgba[si + 3];
      }
    }
  }
  return out;
}

/**
 * Core QR detection on raw RGBA pixels — pure, DOM-free, Node-testable.
 * Passes: (A) full frame at 1x, (B) bottom-center crop at 2x (typical certificate/
 * mark-sheet QR position), (C+D) bounded multi-scale tiled scan at 2x and 1x with 25%
 * overlapping tiles so small QRs (60-300px) anywhere on a 1080p screenshot are found.
 * All jsQR results must pass the payload + geometry sanity checks.
 *
 * @param {Uint8ClampedArray} rgba - Raw RGBA pixel buffer
 * @param {number} width - Image width in px
 * @param {number} height - Image height in px
 * @param {{ timeBudgetMs?: number }} [options]
 * @returns {Array<{ x: number, y: number, width: number, height: number }>}
 */
export async function detectQRCodesRGBA(rgba, width, height, options = {}) {
  if (!rgba || width <= 0 || height <= 0) return [];
  const jsQR = await ensureJsQR();
  if (!jsQR) return []; // QR lib unavailable: skip (faces/OCR/PII still run)
  const timeBudgetMs = typeof options.timeBudgetMs === 'number' ? options.timeBudgetMs : 1600;
  const start = now();
  const boxes = [];

  const addBox = (box) => {
    if (!isPlausibleQRBox(box, width, height)) return;
    // Dedupe: the same QR can be found by more than one pass
    for (const existing of boxes) {
      const overlapW = Math.min(existing.x + existing.width, box.x + box.width) - Math.max(existing.x, box.x);
      const overlapH = Math.min(existing.y + existing.height, box.y + box.height) - Math.max(existing.y, box.y);
      if (overlapW > 0 && overlapH > 0) {
        const iou = (overlapW * overlapH) / Math.max(1, Math.min(existing.width * existing.height, box.width * box.height));
        if (iou > 0.35) return;
      }
    }
    boxes.push({
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
      width: Math.round(box.width),
      height: Math.round(box.height)
    });
  };

  const outOfBudget = () => now() - start > timeBudgetMs;

  // Pass A: full frame at native resolution (return on first validated hit to bound time)
  const fullCode = jsQR(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  const fullBox = acceptJsQRResult(fullCode, 0, 0, 1, width, height);
  if (fullBox) {
    addBox(fullBox);
    return boxes;
  }

  // Pass B: bottom-center sub-region with 2x upscale
  if (height > 200) {
    const cropX = Math.round(width * 0.25);
    const cropY = Math.round(height * 0.60);
    const cropW = Math.round(width * 0.50);
    const cropH = height - cropY;
    const cropData = extractRegion(rgba, width, height, cropX, cropY, cropW, cropH, 2);
    const subCode = jsQR(cropData, cropW * 2, cropH * 2, { inversionAttempts: 'attemptBoth' });
    const subBox = acceptJsQRResult(subCode, cropX, cropY, 2, width, height);
    if (subBox) {
      addBox(subBox);
      return boxes;
    }
  }

  // Pass C + D: bounded multi-scale tiled scan (2x first for small QRs, then 1x)
  for (const scale of [2, 1]) {
    if (outOfBudget()) break;
    const tileOrig = 512;   // tile side in original-image pixels
    const stepOrig = 384;   // 25% overlap between tiles
    const scanSide = tileOrig * scale;
    const region = new Uint8ClampedArray(scanSide * scanSide * 4);
    for (let ty = 0; ty < height - tileOrig * 0.5; ty += stepOrig) {
      if (outOfBudget()) break;
      const y0 = Math.min(ty, Math.max(0, height - tileOrig));
      for (let tx = 0; tx < width - tileOrig * 0.5; tx += stepOrig) {
        if (outOfBudget()) break;
        const x0 = Math.min(tx, Math.max(0, width - tileOrig));
        extractRegion(rgba, width, height, x0, y0, tileOrig, tileOrig, scale, region);
        const tileCode = jsQR(region, scanSide, scanSide, { inversionAttempts: 'attemptBoth' });
        const tileBox = acceptJsQRResult(tileCode, x0, y0, scale, width, height);
        if (tileBox) {
          addBox(tileBox);
          return boxes;
        }
      }
    }
  }

  return boxes;
}

/**
 * Detects QR codes and 2D matrix barcodes on an image element.
 * Uses native BarcodeDetector API when available in modern browsers,
 * with the raw-RGBA jsQR multi-pass fallback otherwise.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imgElement
 * @returns {Promise<Array<{ x: number, y: number, width: number, height: number, tag: string }>>}
 */
export async function detectQRCodes(imgElement) {
  if (!imgElement) return [];
  const qrBoxes = [];

  const w = imgElement.naturalWidth || imgElement.width || 0;
  const h = imgElement.naturalHeight || imgElement.height || 0;
  if (w <= 0 || h <= 0) return [];

  // 1. Primary: Native browser BarcodeDetector API (fast, hardware-accelerated in Chrome/Edge/Android)
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code', 'data_matrix', 'aztec'] });
      const barcodes = await barcodeDetector.detect(imgElement);
      if (barcodes && Array.isArray(barcodes) && barcodes.length > 0) {
        for (const b of barcodes) {
          const bb = b.boundingBox;
          if (bb && bb.width > 20 && bb.height > 20) {
            qrBoxes.push({
              x: Math.max(0, Math.round(bb.x)),
              y: Math.max(0, Math.round(bb.y)),
              width: Math.round(bb.width),
              height: Math.round(bb.height),
              tag: 'QR'
            });
          }
        }
        if (qrBoxes.length > 0) {
          return qrBoxes;
        }
      }
    } catch (nativeErr) {
      console.warn('[QRDetector] Native BarcodeDetector error, falling back to jsQR:', nativeErr);
    }
  }

  // 2. Secondary: jsQR via offscreen Canvas -> raw RGBA core (thin DOM wrapper)
  try {
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgElement, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);

    const boxes = await detectQRCodesRGBA(imageData.data, imageData.width, imageData.height);
    for (const box of boxes) {
      qrBoxes.push({
        x: Math.max(0, Math.round(box.x)),
        y: Math.max(0, Math.round(box.y)),
        width: Math.round(box.width),
        height: Math.round(box.height),
        tag: 'QR'
      });
    }
  } catch (jsQrErr) {
    console.warn('[QRDetector] jsQR scanning notice:', jsQrErr);
  }

  return qrBoxes;
}
