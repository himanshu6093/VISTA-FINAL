import { getNERPipeline, resetNERPipeline } from './piiDetector.js';
import { loadFaceDetector, resetFaceDetector } from './faceDetector.js';
import { getPaddleOCR, resetPaddleOCR } from './ocrService.js';

// Total expected weights payload in MB across YuNet (~1.5MB), PaddleOCR (~4.5MB), and MiniLM-L6 (~23.4MB)
export const TOTAL_MODELS_SIZE_MB = 29.4;

/**
 * Checks client browser storage usage via Navigator Storage & Cache API.
 * @returns {Promise<{ bytes: number, mb: number, formatted: string, isCached: boolean }>}
 */
export async function checkStorageUsage() {
  if (typeof window === 'undefined') {
    return { bytes: 0, mb: 0, formatted: '0 MB', isCached: false };
  }

  let usageBytes = 0;

  // 1. Check navigator.storage.estimate()
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage || 0;
    } catch (e) {
      console.warn('Storage estimate warning:', e);
    }
  }

  // 2. Fallback or cross-check Cache API for transformers-cache
  let hasCacheEntries = false;
  if ('caches' in window) {
    try {
      const hasTransformersCache = await caches.has('transformers-cache');
      if (hasTransformersCache) {
        const cache = await caches.open('transformers-cache');
        const keys = await cache.keys();
        if (keys.length > 0) {
          hasCacheEntries = true;
        }
      }
    } catch (e) {
      console.warn('Cache check warning:', e);
    }
  }

  const usageMB = usageBytes > 0 ? (usageBytes / (1024 * 1024)).toFixed(1) : (hasCacheEntries ? TOTAL_MODELS_SIZE_MB.toFixed(1) : '0');
  const isCached = usageBytes > 10 * 1024 * 1024 || hasCacheEntries;

  return {
    bytes: usageBytes,
    mb: parseFloat(usageMB),
    formatted: `${usageMB} MB`,
    isCached
  };
}

/**
 * Purges all cached neural weights from Cache API, IndexedDB, and memory.
 * Frees disk space on the client browser.
 */
export async function clearAllModelStorage() {
  // 1. Release in-memory singleton sessions
  resetNERPipeline();
  resetFaceDetector();
  await resetPaddleOCR();

  // 2. Delete Cache API stores
  if (typeof window !== 'undefined' && 'caches' in window) {
    try {
      const keys = await caches.keys();
      for (const key of keys) {
        if (
          key.includes('transformer') ||
          key.includes('vista') ||
          key.includes('model') ||
          key.includes('onnx')
        ) {
          await caches.delete(key);
        }
      }
      await caches.delete('transformers-cache');
      await caches.delete('vista-models-cache');
    } catch (e) {
      console.warn('Error deleting caches:', e);
    }
  }

  // 3. Clear IndexedDB if used by transformers or ORT
  if (typeof window !== 'undefined' && 'indexedDB' in window && indexedDB.databases) {
    try {
      const dbs = await indexedDB.databases();
      for (const db of dbs) {
        if (
          db.name &&
          (db.name.includes('transformer') ||
            db.name.includes('onnx') ||
            db.name.includes('vista'))
        ) {
          indexedDB.deleteDatabase(db.name);
        }
      }
    } catch (e) {}
  }

  // 4. Return new storage measurement
  return await checkStorageUsage();
}

/**
 * Pre-downloads and warms up all 3 neural models with smooth progress reporting.
 * @param {(status: { progress: number, stage: string, loadedMB: number, totalMB: number }) => void} onProgress
 */
export async function preloadAllModels(onProgress) {
  const totalMB = TOTAL_MODELS_SIZE_MB;
  let currentLoadedMB = 0;

  const report = (stage, loadedDelta = 0, directPercent = null) => {
    currentLoadedMB = Math.min(currentLoadedMB + loadedDelta, totalMB);
    const progress = directPercent !== null ? directPercent : Math.round((currentLoadedMB / totalMB) * 100);
    if (onProgress) {
      onProgress({
        progress: Math.min(Math.max(progress, 0), 100),
        stage,
        loadedMB: parseFloat(currentLoadedMB.toFixed(1)),
        totalMB
      });
    }
  };

  try {
    // Stage 1: Face Detector (YuNet ~0.23 MB)
    report('Initializing Face Detector (YuNet ONNX)...', 0.2, 2);
    await loadFaceDetector();
    report('Face Detector loaded', 0.1, 5);

    // Stage 2: OCR Engine (PaddleOCR v6 ~6.5 MB)
    report('Loading High-Speed OCR Engine (PaddleOCR v6)...', 3.0, 8);
    await getPaddleOCR();
    report('OCR Engine ready', 3.4, 15);

    // Stage 3: Neural PII Model (MiniLM-L6 v2 ~22.8 MB)
    report('Loading Neural PII Model (MiniLM-L6 ~22.8 MB)...', 0, 22);
    await getNERPipeline((item) => {
      if (item && item.progress !== undefined) {
        const isTotal = item.status === 'progress_total';
        const isModel = item.file && item.file.includes('model');
        const filename = item.file ? item.file.replace(/^.*[\\\/]/, '') : '';

        // Check whether downloading local ~22.8MB model or 109MB fallback
        const isFallbackRemote = item.total && item.total > 50 * 1024 * 1024;
        const targetModelMB = isFallbackRemote ? 109.0 : 22.8;
        const currentTotalMB = isFallbackRemote ? 116.0 : TOTAL_MODELS_SIZE_MB;

        let bertProgress = 0;
        let bertLoadedMB = 0;

        if (isTotal) {
          bertProgress = item.progress;
          bertLoadedMB = (item.progress / 100) * targetModelMB;
        } else if (isModel) {
          bertProgress = item.progress;
          bertLoadedMB = item.loaded ? item.loaded / (1024 * 1024) : (item.progress / 100) * targetModelMB;
        } else {
          // Metadata or tokenizer files (config.json, tokenizer.json ~0.7MB total)
          bertProgress = Math.min(item.progress * 0.05, 5);
          bertLoadedMB = item.loaded ? item.loaded / (1024 * 1024) : 0.7;
        }

        const overallProgress = Math.round(22 + (bertProgress * 0.77));
        const totalNowMB = parseFloat((6.6 + bertLoadedMB).toFixed(1));

        if (onProgress) {
          onProgress({
            progress: Math.min(Math.max(overallProgress, 22), 99),
            stage: filename
              ? `Downloading ${filename} (${Math.round(item.progress)}%)...`
              : 'Downloading Neural PII weights...',
            loadedMB: Math.min(totalNowMB, currentTotalMB),
            totalMB: currentTotalMB
          });
        }
      }
    });

    report('All models cached & ready on device!', 0, 100);
    const finalStorage = await checkStorageUsage();
    return finalStorage;
  } catch (err) {
    console.error('Preload failed:', err);
    throw err;
  }
}
