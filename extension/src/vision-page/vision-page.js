/**
 * VISTA Firefox vision host — hidden extension tab entry.
 * Reuses pipeline-host.js (same code as the Chromium offscreen document).
 * The background orchestrator opens this page (active:false) when
 * chrome.offscreen is unavailable and keeps reusing the tab.
 */
import { handleVisionMessage, handlesVisionMessage } from '../offscreen/pipeline-host.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!handlesVisionMessage(msg)) return undefined;
  handleVisionMessage(msg).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String(e?.message ?? e).slice(0, 300) }));
  return true;
});
