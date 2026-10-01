/**
 * VISTA Phase 0 — ContextEvaluator (heuristic, no ML).
 * Decides DOM-sufficient vs vision-needed. Mirrors architecture diagram.
 * Phase 2 can swap in a tiny local classifier; keep function signature stable.
 */

const VISION_KEYWORDS = [
  'image', 'photo', 'picture', 'video', 'map', 'chart', 'graph', 'captcha',
  'canvas', 'screenshot', 'poster', 'thumbnail', 'gallery', 'qr',
];

export function evaluateContext({ goal = '', elements = [], visionMode = 'auto' }) {
  if (visionMode === 'dom-only') return { route: 'dom', reason: 'user forced dom-only' };
  if (visionMode === 'vision-only') return { route: 'vision', reason: 'user forced vision-only' };

  const g = goal.toLowerCase();
  if (VISION_KEYWORDS.some((k) => g.includes(k))) {
    return { route: 'vision', reason: `goal mentions visual keyword` };
  }
  // Too few actionable nodes -> DOM likely insufficient (canvas/image-heavy page).
  const interactive = elements.filter((e) => e?.interactive || e?.role === 'button' || e?.tag === 'a');
  if (elements.length < 10 || interactive.length === 0) {
    return { route: 'vision', reason: `only ${elements.length} nodes / ${interactive.length} interactive` };
  }
  // Large canvas/img with no accessible name -> vision needed.
  const unnamedMedia = elements.filter(
    (e) => (e.tag === 'canvas' || e.tag === 'img') && !(e.name || '').trim()
  );
  if (unnamedMedia.length >= 2) {
    return { route: 'vision', reason: `${unnamedMedia.length} unnamed media elements` };
  }
  return { route: 'dom', reason: `${interactive.length} interactive nodes, no visual keywords` };
}
