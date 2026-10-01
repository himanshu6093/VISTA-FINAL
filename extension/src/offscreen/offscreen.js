/**
 * VISTA Chromium vision host — offscreen document entry.
 * All pipeline logic lives in pipeline-host.js (shared with the Firefox
 * fallback page). This file only wires the message listener.
 */
import { handleVisionMessage, handlesVisionMessage } from './pipeline-host.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!handlesVisionMessage(msg)) return undefined;
  handleVisionMessage(msg).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: String(e?.message ?? e).slice(0, 300) }));
  return true;
});
