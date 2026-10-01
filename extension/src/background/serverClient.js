/**
 * VISTA Phase 0 — thin server client. Sends ONLY sanitized payload.
 */

export async function planAction({ serverUrl, body }) {
  const url = `${String(serverUrl).replace(/\/$/, '')}/plan`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`server /plan ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json(); // { thought, action, targetId, value, done }
}

export async function checkHealth(serverUrl) {
  const res = await fetch(`${String(serverUrl).replace(/\/$/, '')}/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}
