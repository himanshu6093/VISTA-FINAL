import { getAssetUrl } from './assetHelper.js';

// EXTENSION PORT (Phase 1): onnxruntime-web lazy-loads via the offscreen import
// map (offscreen.html). Original web-demo header:
// `import * as ort from 'onnxruntime-web'`.
let _ort = null;
async function getOrt() {
  if (!_ort) _ort = await import('onnxruntime-web');
  return _ort;
}

const MODEL_REL_PATH = 'models/face/face_detection_yunet_2023mar.onnx';
const FALLBACK_YUNET_URL = 'https://raw.githubusercontent.com/opencv/opencv_zoo/master/models/face_detection_yunet/face_detection_yunet_2023mar.onnx';
const INPUT_SIZE = 640;           // YuNet standard input resolution (640x640)
const SCORE_THRESHOLD = 0.35;     // Threshold to catch all face candidates on documents/cards
const NMS_THRESHOLD = 0.3;        // IoU threshold to eliminate overlapping duplicates

let cachedSession = null;

let activeFaceProvider = 'WASM';

/**
 * Loads and caches the YuNet Face Detector ONNX session with robust buffer validation
 * and CDN fallback to ensure protobuf parsing never fails on corrupted/LFS pointer files.
 */
export async function loadFaceDetector() {
  if (!cachedSession) {
    const primaryUrl = getAssetUrl(MODEL_REL_PATH);
    let buffer = null;

    try {
      const res = await fetch(primaryUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      const rawBuf = await res.arrayBuffer();

      // Verify that this is real ONNX binary protobuf and not an un-downloaded 130-byte Git LFS pointer or HTML error
      if (rawBuf.byteLength < 5000) {
        const text = new TextDecoder().decode(rawBuf);
        if (text.startsWith('version https://git-lfs') || text.includes('<!DOCTYPE') || text.includes('<html')) {
          console.warn('[FaceDetector] Local YuNet file is an LFS pointer or HTML error. Falling back to OpenCV Zoo CDN...');
          throw new Error('Local file is LFS pointer or HTML error page');
        }
      }
      buffer = rawBuf;
    } catch (primaryErr) {
      console.warn(`[FaceDetector] Primary fetch from ${primaryUrl} failed (${primaryErr.message}). Attempting fallback to official OpenCV Zoo...`);
      try {
        const fallbackRes = await fetch(FALLBACK_YUNET_URL);
        if (!fallbackRes.ok) throw new Error(`Fallback HTTP ${fallbackRes.status}`);
        buffer = await fallbackRes.arrayBuffer();
      } catch (fallbackErr) {
        throw new Error(`Failed to load YuNet face model: ${primaryErr.message}. Fallback also failed: ${fallbackErr.message}`);
      }
    }

    cachedSession = await (await getOrt()).InferenceSession.create(new Uint8Array(buffer), {
      executionProviders: ['wasm'],
    });
  }
  return cachedSession;
}

export function resetFaceDetector() {
  if (cachedSession) {
    try { cachedSession.release(); } catch (e) {}
    cachedSession = null;
  }
}

/**
 * Decodes the 12 raw tensor outputs from YuNet (strides 8, 16, 32)
 * into pixel coordinates scaled back to original image dimensions.
 */
function decodeYuNetOutput(response, origW, origH) {
  const strides = [8, 16, 32];
  const candidates = [];

  for (const stride of strides) {
    const cols = Math.floor(INPUT_SIZE / stride);
    const rows = Math.floor(INPUT_SIZE / stride);

    const cls = response[`cls_${stride}`]?.data;
    const obj = response[`obj_${stride}`]?.data;
    const bbox = response[`bbox_${stride}`]?.data;
    const kps = response[`kps_${stride}`]?.data;

    if (!cls || !obj || !bbox) continue;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;

        // Combined face confidence = sqrt(classification * objectness)
        const clsScore = Math.min(Math.max(cls[idx], 0), 1);
        const objScore = Math.min(Math.max(obj[idx], 0), 1);
        const score = Math.sqrt(clsScore * objScore);

        if (score < SCORE_THRESHOLD) continue;

        // Decode bounding box offsets on 640x640 space
        const cx = (c + bbox[idx * 4 + 0]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;

        const x1 = cx - w / 2;
        const y1 = cy - h / 2;

        // Scale factors to map 640x640 coordinates back to original image dimensions
        const scaleX = origW / INPUT_SIZE;
        const scaleY = origH / INPUT_SIZE;

        // Clamp to image bounds: edge faces otherwise produce boxes that extend
        // past the canvas, making the redaction blur compute negative sizes.
        const clampX = Math.max(0, Math.min(origW - 1, x1 * scaleX));
        const clampY = Math.max(0, Math.min(origH - 1, y1 * scaleY));

        // 5 facial landmarks (right eye, left eye, nose, right mouth, left mouth)
        const landmarks = [];
        if (kps) {
          for (let n = 0; n < 5; n++) {
            landmarks.push({
              x: (c + kps[idx * 10 + 2 * n]) * stride * scaleX,
              y: (r + kps[idx * 10 + 2 * n + 1]) * stride * scaleY,
            });
          }
        }

        candidates.push({
          x: clampX,
          y: clampY,
          width: Math.max(1, Math.min(origW - clampX, w * scaleX)),
          height: Math.max(1, Math.min(origH - clampY, h * scaleY)),
          score: Math.round(score * 100) / 100,
          landmarks,
        });
      }
    }
  }

  // Non-Maximum Suppression (NMS)
  candidates.sort((a, b) => b.score - a.score);
  const finalFaces = [];

  for (const box of candidates) {
    let keep = true;
    for (const chosen of finalFaces) {
      const x1 = Math.max(box.x, chosen.x);
      const y1 = Math.max(box.y, chosen.y);
      const x2 = Math.min(box.x + box.width, chosen.x + chosen.width);
      const y2 = Math.min(box.y + box.height, chosen.y + chosen.height);

      const interW = Math.max(0, x2 - x1);
      const interH = Math.max(0, y2 - y1);
      const interArea = interW * interH;
      const unionArea = box.width * box.height + chosen.width * chosen.height - interArea;
      const iou = unionArea > 0 ? interArea / unionArea : 0;

      if (iou > NMS_THRESHOLD) {
        keep = false;
        break;
      }
    }
    if (keep) finalFaces.push(box);
  }

  return finalFaces;
}

/**
 * Executes full on-device Face Detection pipeline on an Image or Canvas element.
 * @param {HTMLImageElement|HTMLCanvasElement} img - Source image element
 * @returns {Promise<{ faces: Array, timeTaken: number }>}
 */
export async function detectFaces(img) {
  if (!img) return { faces: [], timeTaken: 0 };
  const startTime = performance.now();

  const session = await loadFaceDetector();

  // 1. Offscreen Canvas: Resize image to 640x640 expected by YuNet
  const offscreen = document.createElement('canvas');
  offscreen.width = INPUT_SIZE;
  offscreen.height = INPUT_SIZE;

  const ctx = offscreen.getContext('2d');
  ctx.drawImage(img, 0, 0, INPUT_SIZE, INPUT_SIZE);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE); // RGBA pixel array

  // 2. Preprocessing: Convert RGBA interleaved (0-255) to Planar BGR Float32
  // Shape required: [1, 3, 640, 640] (Blue, Green, Red channels)
  const totalPixels = INPUT_SIZE * INPUT_SIZE;
  const float32Data = new Float32Array(3 * totalPixels);
  const gOffset = totalPixels;
  const rOffset = 2 * totalPixels;

  for (let i = 0, j = 0; i < totalPixels; i++, j += 4) {
    float32Data[i] = data[j + 2];          // B (Blue)
    float32Data[gOffset + i] = data[j + 1]; // G (Green)
    float32Data[rOffset + i] = data[j];     // R (Red)
  }

  const inputTensor = new (await getOrt()).Tensor('float32', float32Data, [1, 3, INPUT_SIZE, INPUT_SIZE]);

  // 3. Inference
  const inputName = session.inputNames[0];
  const response = await session.run({ [inputName]: inputTensor });

  // 4. Decode
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;
  const faces = decodeYuNetOutput(response, origW, origH);
  const timeTaken = Math.round(performance.now() - startTime);

  return { faces, timeTaken, provider: activeFaceProvider };
}
