/**
 * VISTA Phase 0 — content actuator (no CDP, no scary permission prompt).
 * Executes server actions via window.__VISTA_DOM_MAP__ (e-id -> element).
 * Actions: click | type | select | scroll | press (Enter/Escape/Tab).
 * Privacy: type NEVER logs the value; background never forwards raw values.
 */

if (typeof window !== 'undefined') {
  const getTarget = (targetId, fallbackXy) => {
    const map = window.__VISTA_DOM_MAP__;
    let el = targetId && map?.get ? map.get(targetId) : null;
    // React re-renders detach nodes; clicking a detached element is a silent no-op.
    if (el && !el.isConnected) el = null;
    if (!el && Array.isArray(fallbackXy)) {
      el = document.elementFromPoint(fallbackXy[0], fallbackXy[1]);
    }
    return el;
  };

  const fire = (el, type) => el?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));

  chrome?.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (msg?.action !== 'vista_act') return undefined;
    (async () => {
      let responded = false;
      try {
        const p = msg.payload ?? {};
        // navigate/scroll/done act on the window or page, not a specific node —
        // they carry no targetId, so don't require (or scroll to) an element.
        // paste MAY carry a targetId but canvas apps (Excalidraw) have none;
        // it falls back to the focused element / body below.
        const needsEl = !['navigate', 'scroll', 'done', 'paste'].includes(p.action);
        let el = null;
        if (needsEl) {
          el = getTarget(p.targetId, p.fallback_xy);
          if (!el) throw new Error(`target ${p.targetId} not found (map miss + no element at fallback_xy)`);
        } else if (p.action === 'paste' && p.targetId) {
          el = getTarget(p.targetId, p.fallback_xy); // optional; null is fine
        }
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          await new Promise((r) => setTimeout(r, 60));
        }

        switch (p.action) {
          case 'navigate': {
            let url = String(p.value ?? '').trim();
            // Planners often omit the scheme ("www.geeksforgeeks.org/...").
            if (!/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(url)) {
              url = `https://${url}`;
            }
            if (!/^https?:\/\//i.test(url)) throw new Error(`navigate blocked: not an http(s) URL (${url.slice(0, 60)})`);
            // Respond BEFORE unloading this document, or the message port dies
            // mid-flight and the orchestrator records a phantom action failure.
            responded = true;
            sendResponse({ ok: true });
            setTimeout(() => { window.location.href = url; }, 0);
            return;
          }
          case 'copy': {
            const text = (el.innerText ?? el.textContent ?? '').trim();
            if (!text) throw new Error('copy: target has no visible text');
            responded = true;
            sendResponse({ ok: true, text: text.slice(0, 5000) });
            return;
          }
          case 'paste': {
            const text = String(p.value ?? '');
            if (!text) throw new Error('paste: clipboard is empty (copy something first)');
            // Canvas apps (Excalidraw) have no textbox node; a paste event on the
            // focused element or body bubbles to their document-level listener.
            const target = el || document.activeElement || document.body;
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            // Apps read e.clipboardData on paste events; untrusted Ctrl+V would
            // never reach the browser's real paste path.
            target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            break;
          }
          case 'click':
            el.focus?.();
            el.click();
            break;
          case 'type': {
            el.focus?.();
            // Prefer native value setter so React/Vue listeners fire.
            const setter = Object.getOwnPropertyDescriptor(el.__proto__ || {}, 'value')?.set
              ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(el, String(p.value ?? ''));
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
          case 'select':
            el.focus?.();
            el.value = String(p.value ?? '');
            fire(el, 'input'); fire(el, 'change');
            break;
          case 'scroll':
            (p.direction === 'up' ? -1 : 1);
            window.scrollBy({ top: (p.direction === 'up' ? -1 : 1) * (Number(p.pixels) || 600), behavior: 'smooth' });
            break;
          case 'press': {
            const key = p.key || 'Enter';
            const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0;
            const make = (type) => {
              const ev = new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true });
              // KeyboardEventInit cannot set keyCode/which, but legacy handlers
              // (and React's synthetic events) still read them.
              Object.defineProperty(ev, 'keyCode', { value: keyCode });
              Object.defineProperty(ev, 'which', { value: keyCode });
              return ev;
            };
            const notPrevented = el.dispatchEvent(make('keydown'));
            // Real Enter fires keydown → keypress → keyup; some widgets only
            // listen to keypress.
            el.dispatchEvent(make('keypress'));
            el.dispatchEvent(make('keyup'));
            if (!notPrevented) break; // page handler consumed the key itself
            // Untrusted events run no browser default action, so reproduce the
            // ones a real keypress would trigger: implicit form submit, button
            // activation, link navigation.
            if (key === 'Enter') {
              if (el.tagName === 'INPUT' && typeof el.form?.requestSubmit === 'function') {
                el.form.requestSubmit();
              } else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute?.('role') === 'button') {
                el.click();
              }
            }
            break;
          }
          case 'done':
            break;
          default:
            throw new Error(`unknown action: ${p.action}`);
        }
        if (!responded) sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
      }
    })();
    return true;
  });
}
