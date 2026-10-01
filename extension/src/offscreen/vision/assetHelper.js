/**
 * VISTA extension asset resolver (offscreen scope).
 * Replaces Vite `import.meta.env.BASE_URL` helper from the web demo.
 * - Models: `src/offscreen/vision/models/...` (vendored locally, gitignored).
 * - Runtimes: `src/offscreen/vendor/...` via getVendorUrl (importmap target).
 */
function resolveBase() {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
      return chrome.runtime.getURL('src/offscreen/');
    }
  } catch {
    /* fall through to relative */
  }
  return null;
}

export function getAssetUrl(relPath) {
  // Called from vision/*.js (one level below offscreen/), so the relative
  // fallback stays `./models/...`. Under chrome it is absolute anyway.
  const cleanRel = String(relPath).replace(/^\/+/, '');
  const base = resolveBase();
  if (base) return `${base}vision/${cleanRel}`;
  return `./${cleanRel}`;
}

export function getVendorUrl(relPath) {
  const cleanRel = String(relPath).replace(/^\/+/, '');
  const base = resolveBase();
  if (base) return `${base}vendor/${cleanRel}`;
  return `./vendor/${cleanRel}`;
}
