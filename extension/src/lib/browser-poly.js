/**
 * VISTA capability + namespace helpers (background ES modules).
 * Firefox MV3 lacks chrome.offscreen — vision runs in a hidden extension
 * page instead (src/vision-page/). Everything else (tabs, scripting,
 * runtime messaging, captureVisibleTab) exists in both browsers.
 */
export function hasOffscreenAPI() {
  try {
    return typeof chrome !== 'undefined' && 'offscreen' in chrome;
  } catch {
    return false;
  }
}

export function browserName() {
  try {
    const ua = (globalThis.navigator?.userAgent ?? '').toLowerCase();
    if (ua.includes('firefox')) return 'firefox';
  } catch { /* ignore */ }
  return 'chromium';
}
