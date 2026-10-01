# extension/test/

- `test_accessible_name.js`, `test_dom_reduction.js`, `test_interaction_state.js`,
  `test_semantic_context.js` — verbatim copies from Semantic_DOM_Formatter (32 tests).
- `content.js` — BYTE-COPY fixture of `../src/content/semanticDom.js` (tests
  `require('./content.js')`). Re-copy after any change to semanticDom.js:
  `Copy-Item extension/src/content/semanticDom.js extension/test/content.js -Force`
- `test_pii_regex.mjs` — VISTA_FINAL smoke test for the ported PII engine
  (10 PII detections + 4 false-positive shields). Run:
  `node extension/test/test_pii_regex.mjs`
