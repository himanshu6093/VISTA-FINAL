/** VISTA Phase 3 popup controller: steps, loops, model mgmt, redaction preview. */
const $ = (id) => document.getElementById(id);

// The popup is destroyed on every tab switch; the background mirrors live UI
// state into chrome.storage.session and we rehydrate/poll it from here.
let acting = false;          // popup is awaiting its own request
let firstHydrate = true;
let lastMirrorStatus = null;

async function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function setBusy(busy) {
  for (const id of ['run', 'loop', 'preload', 'clearModels', 'diagnose']) $(id).disabled = busy;
}

function tokenCounts(manifest) {
  const counts = {};
  for (const m of manifest ?? []) counts[m.token] = (counts[m.token] ?? 0) + 1;
  return counts;
}

function renderPreview(preview) {
  const card = $('preview-card');
  if (!preview?.redacted_b64) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  if (preview.original_b64) $('shot-before').src = preview.original_b64;
  $('shot-after').src = preview.redacted_b64;
  const counts = tokenCounts(preview.manifest);
  $('manifest').textContent =
    `${(preview.manifest ?? []).length} redactions ` + JSON.stringify(counts) +
    (preview.timings ? ` | ${preview.timings.total_ms ?? '?'}ms ${preview.timings.render ?? ''}` : '');
}

function renderTrail(trail) {
  const card = $('trail-card');
  const ol = $('trail');
  ol.innerHTML = '';
  if (!trail?.length) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  for (const s of trail) {
    const li = document.createElement('li');
    li.textContent = `#${s.step} ${s.route} (${s.visionHost ?? 'none'}) → ${s.action ?? '?'} ${s.targetId ?? ''} ` +
      `[${s.planner ?? 'heuristic'}] nodes=${s.nodesSent} img=${s.imageBytes}B redacted=${s.redactionCount} ` +
      `acted=${s.acted ?? '-'} ${s.ms ?? '?'}ms` +
      (s.acted === false && s.actError ? ` actErr(${s.actError})` : '') +
      (s.visionError ? ` VISION_ERR(${s.visionError})` : '') +
      (s.error ? ' ERROR(' + s.error + ')' : '');
    ol.appendChild(li);
  }
}

function renderAudit(audit) {
  if (!audit) return;
  $('audit').textContent = JSON.stringify({
    note: 'sizes only — no values, text, or pixels leave the browser unredacted',
    route: audit.route, nodesSent: audit.nodesSent, imageBytes: audit.imageBytes,
    redactionCount: audit.redactionCount, planner: audit.planner,
    action: audit.action, targetId: audit.targetId,
  }, null, 2);
}

async function refreshModelStatus() {
  try {
    const st = await send('VISTA_MODEL_STATUS');
    $('model-status').textContent = st?.formatted ?? (st?.isCached ? 'cached' : 'not downloaded');
  } catch {
    $('model-status').textContent = 'offscreen offline';
  }
}

$('health')?.addEventListener('click', async () => {
  try {
    const url = $('serverUrl').value.replace(/\/$/, '');
    const r = await fetch(`${url}/health`).then((x) => x.json());
    $('status').textContent = `server ok: phase=${r.phase} vlm=${r.vlm?.enabled ? r.vlm.model : 'off'}`;
  } catch (e) {
    $('status').textContent = `server unreachable: ${e.message} (start: uvicorn app:app --port 8000)`;
  }
});

async function applyGoal() {
  await send('VISTA_SET_GOAL', {
    goal: $('goal').value,
    visionMode: $('visionMode').value,
    serverUrl: $('serverUrl').value,
  });
}

$('run')?.addEventListener('click', async () => {
  acting = true;
  setBusy(true);
  $('status').textContent = 'running 1 step…';
  try {
    await applyGoal();
    const out = await send('VISTA_RUN_STEP');
    $('out').textContent = JSON.stringify(out, null, 2);
    if (!out.ok) {
      $('status').textContent = `error: ${out.error}`;
    } else {
      $('status').textContent = `${out.decision?.route} → ${out.plan?.action ?? '?'} ${out.plan?.targetId ?? ''} [${out.plan?.planner ?? 'heuristic'}]`;
      renderAudit(out.audit);
      renderPreview(out.preview);
    }
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
  } finally {
    acting = false;
    setBusy(false);
  }
});

$('loop')?.addEventListener('click', async () => {
  acting = true;
  setBusy(true);
  $('stop').disabled = false;
  $('status').textContent = 'running loop… (Stop to interrupt)';
  try {
    await applyGoal();
    const out = await send('VISTA_RUN_LOOP', { maxSteps: Number($('maxSteps').value) || 5 });
    $('out').textContent = JSON.stringify(out, null, 2);
    if (!out.ok) {
      $('status').textContent = `error: ${out.error}`;
    } else {
      const last = out.trail?.[out.trail.length - 1];
      const flag = out.stalled ? ' STALLED(no progress)' : out.loopError ? ` ERROR(${out.loopError})` : '';
      $('status').textContent = `loop done: ${out.trail?.length ?? 0} steps, last=${last?.action ?? '?'} ${last?.targetId ?? ''}${flag}`;
      renderTrail(out.trail);
      renderPreview(out.preview);
      if (last) renderAudit(last);
    }
  } catch (e) {
    $('status').textContent = `error: ${e.message}`;
  } finally {
    acting = false;
    setBusy(false);
  }
});

$('stop')?.addEventListener('click', async () => {
  await send('VISTA_STOP');
  $('status').textContent = 'stop requested';
});

$('diagnose')?.addEventListener('click', async () => {
  $('status').textContent = 'diagnosing…';
  try {
    const out = await send('VISTA_DIAGNOSE', { serverUrl: $('serverUrl').value });
    const ul = $('diag');
    ul.innerHTML = '';
    $('diag-card').classList.remove('hidden');
    for (const c of out.checks ?? []) {
      const li = document.createElement('li');
      li.className = c.ok ? 'pass' : 'fail';
      li.textContent = `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail || ''}${c.hint ? ` — ${c.hint}` : ''}`;
      ul.appendChild(li);
    }
    const allOk = (out.checks ?? []).every((c) => c.ok);
    $('status').textContent = allOk ? 'diagnostics: all green, ready for E2E' : 'diagnostics: fix FAIL rows above, then re-run';
  } catch (e) {
    $('status').textContent = `diagnose error: ${e.message}`;
  }
});

$('preload')?.addEventListener('click', async () => {
  $('model-status').textContent = 'downloading… (first run only)';
  try {
    const st = await send('VISTA_PRELOAD_MODELS');
    $('model-status').textContent = st?.formatted ?? 'ready';
  } catch (e) {
    $('model-status').textContent = `preload failed: ${e.message}`;
  }
});

$('clearModels')?.addEventListener('click', async () => {
  try {
    const st = await send('VISTA_CLEAR_MODELS');
    $('model-status').textContent = st?.formatted ?? 'cleared';
  } catch (e) {
    $('model-status').textContent = `clear failed: ${e.message}`;
  }
});

refreshModelStatus();

/**
 * Rehydrate live UI from the background mirror. Runs on open and once a second
 * so a popup reopened after a tab switch shows the still-running (or finished)
 * loop's trail/preview/status instead of a blank slate.
 */
async function hydrateUI() {
  let st;
  try {
    st = await send('VISTA_GET_STATE');
  } catch {
    return; // background asleep/unavailable; retry on next tick
  }
  if (!st?.ok) return;

  if (firstHydrate) {
    firstHydrate = false;
    if (st.goal && !$('goal').value) $('goal').value = st.goal;
    if (st.visionMode && $('visionMode')) $('visionMode').value = st.visionMode;
    if (st.serverUrl && $('serverUrl')) $('serverUrl').value = st.serverUrl;
  }

  // Trail/preview render even mid-action so a popup-open loop shows live progress.
  if (st.trail?.length) renderTrail(st.trail);
  if (st.preview) renderPreview(st.preview);

  // Don't clobber a just-composed local status while this popup is mid-action.
  if (!acting) {
    if (st.status && st.status !== lastMirrorStatus) {
      lastMirrorStatus = st.status;
      $('status').textContent = st.status;
    }
    setBusy(!!st.running);
    if ($('stop')) $('stop').disabled = !st.running;
  }
}
hydrateUI();
setInterval(hydrateUI, 1000);
