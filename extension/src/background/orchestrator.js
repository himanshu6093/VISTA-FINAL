/**
 * VISTA Phase 3 — Background orchestrator (service worker, ES module).
 * Owns: goal state, ContextEvaluator routing, server comms, step + loop runs,
 * model-relay to offscreen, per-step audit trail.
 * Heavy vision (ORT/WASM/canvas) lives in offscreen document, NOT here.
 */

import { planAction } from './serverClient.js';
import { evaluateContext } from './contextEvaluator.js';
import { hasOffscreenAPI, browserName } from '../lib/browser-poly.js';

const STATE = {
  goal: '',
  visionMode: 'auto', // 'auto' | 'dom-only' | 'vision-only'
  serverUrl: 'http://127.0.0.1:8000',
  running: false,
  clipboard: '', // local-only copy/paste buffer; never sent to the server
};

/**
 * Heavy pages exceed the planner's node cap; never truncate away the controls.
 * Text-rich nodes (paragraphs) are interleaved, not appended, so copy targets
 * survive the server's head-slice even on link-heavy article pages.
 */
function prioritizeElements(elements, cap) {
  if (elements.length <= cap) return elements;
  const isTextRich = (e) => !e?.interactive && ((e?.text ?? '').length >= 60);
  const interactive = elements.filter((e) => e?.interactive);
  const textRich = elements.filter(isTextRich);
  const rest = elements.filter((e) => !e?.interactive && !isTextRich(e));
  const out = [];
  let i = 0, t = 0, r = 0;
  while (out.length < cap && (i < interactive.length || t < textRich.length || r < rest.length)) {
    for (let k = 0; k < 3 && i < interactive.length && out.length < cap; k++) out.push(interactive[i++]);
    if (t < textRich.length && out.length < cap) out.push(textRich[t++]);
    if (i >= interactive.length && t >= textRich.length && r < rest.length && out.length < cap) out.push(rest[r++]);
  }
  return out;
}

let visionTabId = null; // Firefox fallback host tab (reused while open)

/**
 * Popup UI mirror in session storage. The popup is destroyed on every tab
 * switch, so the trail/preview/status live here instead of popup memory and
 * survive both popup closes and service-worker restarts.
 */
const UI_EMPTY = { trail: [], preview: null, status: '', running: false };
async function getUI() {
  try {
    const s = await chrome.storage.session.get('vistaUI');
    return s?.vistaUI ?? { ...UI_EMPTY };
  } catch {
    return { ...UI_EMPTY };
  }
}
async function setUI(patch) {
  try {
    const cur = await getUI();
    await chrome.storage.session.set({ vistaUI: { ...cur, ...patch } });
  } catch { /* storage unavailable: UI stays ephemeral */ }
}
getUI().then((ui) => {
  // A fresh service worker means no loop can still be running.
  if (ui.running) setUI({ running: false, status: 'loop interrupted (service worker restarted)' });
});

/**
 * Ensure a vision host exists and report which one.
 * Chromium: offscreen document. Firefox (no chrome.offscreen): hidden
 * extension tab running the same pipeline-host.js. Vision messages stay
 * broadcast runtime.sendMessage — exactly one host exists per browser,
 * so no routing changes are needed downstream.
 */
async function ensureVisionHost() {
  if (hasOffscreenAPI()) {
    const exists = await chrome.offscreen.hasDocument?.().catch(() => false);
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['BLOBS', 'LOCAL_STORAGE'],
        justification: 'VISTA screenshot capture + on-device redaction (face/OCR/PII) before any network call.',
      });
    }
    return { kind: 'offscreen' };
  }
  try {
    if (visionTabId == null) throw new Error('no fallback tab yet');
    await chrome.tabs.get(visionTabId); // throws if user closed it
  } catch {
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL('src/vision-page/vision-page.html'),
      active: false,
    });
    visionTabId = tab.id;
    await new Promise((r) => setTimeout(r, 800)); // importmap + modules boot
  }
  return { kind: 'tab', tabId: visionTabId };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] ?? null;
}

/** Resolves once the tab's document finished loading (bounded wait). */
async function waitForTabComplete(tabId, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete' || Date.now() - t0 > timeoutMs) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function extractSemanticDom(tabId) {
  // content.js from Semantic_DOM_Formatter answers {action:'extract_dom'}.
  // Phase 1 will copy full content.js into src/content/semanticDom.js.
  const res = await chrome.tabs.sendMessage(tabId, { action: 'extract_dom' }).catch(async () => {
    // Auto-inject if content script not yet running (mirrors DOM repo popup.js logic).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/semanticDom.js', 'src/content/actuator.js'],
    });
    await new Promise((r) => setTimeout(r, 150));
    return chrome.tabs.sendMessage(tabId, { action: 'extract_dom' });
  });
  if (!res?.success) throw new Error(res?.error || 'semantic DOM extraction failed');
  return res.data; // { elements, stats, pageTitle, ... }
}

async function captureRedactedScreenshot(tab, semanticDom) {
  const host = await ensureVisionHost();
  // Offscreen documents only expose chrome.runtime, so the capture MUST happen
  // here in the service worker; the host only runs the redaction pipeline.
  let dataUrl = null;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return {
      redacted_b64: null, original_b64: null, manifest: [], mode: 'capture-failed', timings: {},
      visionHost: host.kind,
      error: `captureVisibleTab: ${String(e?.message ?? e).slice(0, 200)}`,
    };
  }
  const visionMsg = {
    type: 'VISTA_REDACT_SCREENSHOT',
    windowId: tab.windowId,
    url: tab.url,
    dataUrl,
  };
  let res = await chrome.runtime.sendMessage(visionMsg).catch(() => null);
  if (!res) {
    // The offscreen document was just created and its module may still be
    // booting; give the listener a moment and retry once.
    await new Promise((r) => setTimeout(r, 500));
    res = await chrome.runtime.sendMessage(visionMsg).catch(() => null);
  }
  const out = res ?? {
    redacted_b64: null, original_b64: null, manifest: [], mode: 'vision-host-missing', timings: {},
    error: 'vision host did not respond (reload extension)',
  };
  out.visionHost = host.kind; // local-only; never included in the server POST
  return out;
}

async function dispatchAction(tabId, actionMsg) {
  // v1: content-script actuator (no scary chrome.debugger prompt).
  // CDP via chrome.debugger is optional_permissions, Phase 3+.
  return chrome.tabs.sendMessage(tabId, { action: 'vista_act', payload: actionMsg });
}

export async function runOneStep(prevOut) {
  let tab = await getActiveTab();
  if (!tab?.id) throw new Error('No active tab. Open a normal webpage (not chrome://).');
  if (/^(chrome|edge|about|view-source|chrome-extension):/.test(tab.url || '')) {
    throw new Error('Browser blocks extensions on internal pages. Open a normal webpage.');
  }
  // A previous click may have activated a tab that is still loading; extracting
  // a half-parsed document yields a garbage DOM and derails the planner.
  tab = (await waitForTabComplete(tab.id, 6000)) ?? tab;

  const dom = await extractSemanticDom(tab.id);
  // Cheap local page fingerprint (url + node count + title) used to tell the
  // planner whether its previous action visibly changed anything.
  const pageSig = `${tab.url}|${(dom.elements ?? []).length}|${dom.pageTitle ?? ''}`;
  const decision = evaluateContext({
    goal: STATE.goal,
    elements: dom.elements ?? [],
    visionMode: STATE.visionMode,
  });

  let redacted = { redacted_b64: null, manifest: [], timings: {} };
  if (decision.route === 'vision') {
    redacted = await captureRedactedScreenshot(tab, dom);
  }

  // PRIVACY INVARIANT: server receives semantic_dom (values already stripped by
  // content.js -> value_present only) + redacted image + manifest. Never raw pixels/values.
  const body = {
    goal: STATE.goal,
    url_host: new URL(tab.url).host,
    semantic_dom: prioritizeElements(dom.elements ?? [], 300),
    screenshot_redacted_b64: redacted.redacted_b64,
    redaction_manifest: redacted.manifest ?? [],
    mode: decision.route === 'vision' ? 'vision' : 'dom',
    // Flag only — the copied text never leaves the browser. Tells the planner
    // it already has the paragraph so it pastes instead of re-copying/going back.
    clipboard_filled: !!STATE.clipboard,
  };
  // Feed the previous step's outcome back so the planner can break no-op loops
  // (e.g. pressing Enter that never changed the page). Local-only summary —
  // action/target/flags, never page content or input values.
  if (prevOut?.plan) {
    body.last_step = {
      action: prevOut.plan.action ?? null,
      targetId: prevOut.plan.targetId ?? null,
      key: prevOut.plan.key ?? null,
      acted: prevOut.audit?.acted ?? null,
      actError: prevOut.audit?.actError ?? null,
      page_changed: prevOut.pageSig ? pageSig !== prevOut.pageSig : true,
    };
  }
  const t0 = Date.now();
  const plan = await planAction({ serverUrl: STATE.serverUrl, body });
  const ms = Date.now() - t0;

  let actResult = null;
  // navigate and paste carry no targetId by design (canvas apps have no textbox
  // node to ground paste to) but MUST still be dispatched.
  const NO_TARGET_DISPATCH = new Set(['navigate', 'paste']);
  if (plan?.action && plan.action !== 'done' && (plan?.targetId || NO_TARGET_DISPATCH.has(plan.action))) {
    const payload = plan.action === 'paste' && !plan.value ? { ...plan, value: STATE.clipboard } : plan;
    actResult = await dispatchAction(tab.id, payload).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (plan.action === 'copy' && actResult?.ok) STATE.clipboard = String(actResult.text ?? '');
  }
  // Per-step audit: sizes only (mirrors server /audit; safe to display/log).
  const audit = {
    route: decision.route,
    visionHost: redacted.visionHost ?? 'none',
    reason: decision.reason,
    nodesSent: body.semantic_dom.length,
    imageBytes: (redacted.redacted_b64 ?? '').length,
    redactionCount: (redacted.manifest ?? []).length,
    planner: plan?.planner ?? 'heuristic',
    action: plan?.action,
    targetId: plan?.targetId ?? null,
    acted: actResult?.ok ?? null,
    actError: actResult?.error ?? null,
    visionError: redacted.error ?? null,
    ms,
  };
  // Preview frames are LOCAL-ONLY (popup display). Original pixels never POSTed.
  const preview = decision.route === 'vision' ? {
    original_b64: redacted.original_b64 ?? null,
    redacted_b64: redacted.redacted_b64 ?? null,
    manifest: redacted.manifest ?? [],
    timings: redacted.timings ?? {},
  } : null;
  return { decision, stats: dom.stats, plan, redactionCount: audit.redactionCount, audit, preview, tabId: tab.id, pageSig };
}

export async function runLoop(maxSteps = 5) {
  STATE.running = true;
  const trail = [];
  let preview = null;
  setUI({ trail: [], preview: null, running: true, status: 'running loop… (Stop to interrupt)' });
  let lastSig = '';
  let repeats = 0;
  let stalled = false;
  let loopError = null;
  let actFails = 0;
  let stoppedByUser = false;
  let prevOut = null;
  try {
    for (let i = 0; i < Math.max(1, Math.min(10, maxSteps)); i++) {
      if (!STATE.running) { stoppedByUser = true; break; }
      let out;
      try {
        out = await runOneStep(prevOut);
      } catch (e) {
        // Mid-navigation races (content script gone) land here: record and stop cleanly.
        loopError = String(e?.message ?? e).slice(0, 200);
        trail.push({ step: i + 1, error: loopError });
        setUI({ trail, preview });
        break;
      }
      trail.push({ step: i + 1, ...out.audit });
      if (out.preview) preview = out.preview;
      setUI({ trail, preview, status: `step ${i + 1}: ${out.plan?.action ?? '?'} ${out.plan?.targetId ?? ''}`.trim() });
      if (out.plan?.done || out.plan?.action === 'done') break;
      // Explicit action failures (e.g. target vanished) stop the loop loudly
      // instead of looking like planner stalls.
      if (out.audit?.acted === false) {
        actFails += 1;
        if (actFails >= 2) {
          loopError = `action failed twice (${out.plan?.action} ${out.plan?.targetId ?? ''}) — ${out.audit?.actError ?? 'target may have vanished'}`;
          break;
        }
      } else {
        actFails = 0;
      }
      // navigate/paste carry no targetId by design — allow the loop to continue.
      if (!out.plan?.targetId && !out.plan?.need_vision && out.plan?.action !== 'navigate' && out.plan?.action !== 'paste') break;
      // A click on a target=_blank card activates a new tab; wait briefly for
      // the switch so the next step doesn't plan against the stale page.
      if (out.plan?.action === 'click' && out.tabId) {
        const from = out.tabId;
        const t0 = Date.now();
        let active = await getActiveTab();
        while (active?.id === from && Date.now() - t0 < 1000) {
          await new Promise((r) => setTimeout(r, 200));
          active = await getActiveTab();
        }
      }
      // Anti-stall: same action+target 3x in a row means no progress.
      const sig = `${out.plan?.action}|${out.plan?.targetId ?? ''}`;
      repeats = sig === lastSig ? repeats + 1 : 0;
      lastSig = sig;
      if (repeats >= 2) { stalled = true; break; }
      // Let the page settle (longer after navigation loads a new document).
      await new Promise((r) => setTimeout(r, out.plan?.action === 'navigate' ? 2500 : 400));
      prevOut = out;
    }
  } finally {
    STATE.running = false;
  }
  const last = trail[trail.length - 1];
  const status = loopError
    ? `ERROR(${loopError})`
    : stalled
      ? `STALLED after ${trail.length} steps (no progress)`
      : stoppedByUser
        ? `stopped by user after ${trail.length} steps`
        : `loop done: ${trail.length} steps, last=${last?.action ?? last?.error ?? '?'}`;
  setUI({ running: false, status, trail, preview });
  return { trail, preview, stalled, loopError, stopped: stoppedByUser };
}

async function relayToOffscreen(type) {
  await ensureVisionHost();
  const res = await chrome.runtime.sendMessage({ type }).catch(() => null);
  return res ?? { ok: false, error: 'vision host unreachable (reload extension)' };
}

/**
 * Phase 6 — one-click pre-flight. Each check returns
 * { name, ok, detail, hint }. Never throws; never sends page content anywhere
 * (only a /health GET and local pings).
 */
export async function diagnose() {
  const checks = [];
  const push = (name, ok, detail = '', hint = '') => checks.push({ name, ok, detail, hint });

  push('extension', true,
    `${chrome.runtime.getManifest().version} on ${browserName()}, offscreen=${hasOffscreenAPI()}`);

  try {
    const r = await fetch(`${STATE.serverUrl.replace(/\/$/, '')}/health`).then((x) => x.json());
    push('server', !!r?.ok, `phase=${r.phase} planner=${r.vlm?.enabled ? r.vlm.model : 'heuristic'}`,
      r?.ok ? '' : 'start: cd server; uvicorn app:app --port 8000');
  } catch (e) {
    push('server', false, String(e?.message ?? e).slice(0, 120),
      'start: cd server; pip install -r requirements.txt; uvicorn app:app --port 8000');
  }

  try {
    const host = await ensureVisionHost();
    push('vision-host', true, `kind=${host.kind}`,
      host.kind === 'tab' ? 'Firefox fallback tab opened (hidden)' : '');
  } catch (e) {
    push('vision-host', false, String(e?.message ?? e).slice(0, 120), 'reload the extension');
  }

  try {
    const st = await relayToOffscreen('VISTA_MODEL_STATUS');
    push('models', !!st?.isCached, st?.formatted ?? JSON.stringify(st).slice(0, 120),
      st?.isCached ? '' : 'popup → Preload (~30MB, first run only)');
  } catch (e) {
    push('models', false, String(e?.message ?? e).slice(0, 120), 'see vision-host check');
  }

  try {
    const tab = await getActiveTab();
    if (!tab?.id || /^(chrome|edge|about|view-source|chrome-extension):/.test(tab.url || '')) {
      push('page', false, 'no normal webpage active', 'open an http(s) page, not chrome://');
    } else {
      const pong = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }).catch(() => null);
      push('page', !!pong?.status, pong ? `content-script v${pong.version}` : 'content script not injected yet',
        pong ? '' : 'auto-injects on first run; or reload the page');
    }
  } catch (e) {
    push('page', false, String(e?.message ?? e).slice(0, 120), 'reload the page');
  }

  return { ok: checks.every((c) => c.ok), checks };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'VISTA_SET_GOAL') {
      STATE.goal = String(msg.goal ?? '').slice(0, 2000);
      STATE.visionMode = msg.visionMode ?? STATE.visionMode;
      STATE.serverUrl = msg.serverUrl ?? STATE.serverUrl;
      setUI({ goal: STATE.goal, visionMode: STATE.visionMode, serverUrl: STATE.serverUrl });
      sendResponse({ ok: true });
    } else if (msg?.type === 'VISTA_RUN_STEP') {
      try {
        setUI({ status: 'running single step…' });
        const out = await runOneStep();
        const ui = await getUI();
        const trail = [...ui.trail, { step: ui.trail.length + 1, ...out.audit }];
        setUI({ trail, preview: out.preview ?? ui.preview, status: `step: ${out.plan?.action ?? '?'} ${out.plan?.targetId ?? ''}`.trim() });
        sendResponse({ ok: true, ...out });
      } catch (e) {
        setUI({ status: `ERROR(${String(e?.message ?? e).slice(0, 200)})` });
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    } else if (msg?.type === 'VISTA_RUN_LOOP') {
      try {
        const out = await runLoop(Number(msg.maxSteps) || 5);
        sendResponse({ ok: true, ...out });
      } catch (e) {
        STATE.running = false;
        setUI({ running: false, status: `ERROR(${String(e?.message ?? e).slice(0, 200)})` });
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    } else if (msg?.type === 'VISTA_STOP') {
      STATE.running = false;
      setUI({ running: false, status: 'stop requested' });
      sendResponse({ ok: true });
    } else if (msg?.type === 'VISTA_GET_STATE') {
      sendResponse({ ok: true, ...(await getUI()) });
    } else if (msg?.type === 'VISTA_DIAGNOSE') {
      try {
        if (msg.serverUrl) STATE.serverUrl = msg.serverUrl;
        sendResponse({ ok: true, ...(await diagnose()) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    } else if (msg?.type === 'VISTA_MODEL_STATUS' || msg?.type === 'VISTA_PRELOAD_MODELS' || msg?.type === 'VISTA_CLEAR_MODELS') {
      try {
        sendResponse({ ok: true, ...(await relayToOffscreen(msg.type)) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    }
  })();
  return true; // async response
});
