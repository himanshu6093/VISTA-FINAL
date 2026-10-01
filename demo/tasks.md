# VISTA demo tasks (SIH judging — each proves privacy + E2E action)

## D1 — DOM-only: disambiguated click (no screenshot leaves browser)
1. Serve the fixture: `cd demo && python -m http.server 8090`, open `http://127.0.0.1:8090/fixture-two-continues.html`
   (or open the file directly with extension file-URL access enabled).
2. Goal: "Click Continue under Payment Information".
3. Expect: ContextEvaluator route=dom, server returns targetId of the Payment
   Continue (heuristic: keyword overlap; VLM: `planner` field shows `vlm:...`),
   actuator clicks the Payment one — Footer one untouched.
4. Privacy proof: popup audit shows `screenshot_redacted_b64: null`, inputs only `value_present`.

## D2 — Vision: redacted screenshot grounding
1. Page with profile photo + address text.
2. Mode: vision-only. Expect offscreen: faces -> <FACE_HIDDEN>, address OCR -> <ADDRESS_HIDDEN>.
3. Goal: "Click Submit next to the redacted address".
4. Expect: server grounds via manifest bbox + semantic_dom, returns click.
5. Privacy proof: popup "Vision redaction preview" shows BEFORE (labeled device
   only, never uploaded) vs AFTER (what the server received) + token counts;
   server /audit log contains sizes only, zero text/pixels.

## D3 — Password never leaks
1. Same fixture (password `s3cret-demo-only` pre-filled, email pre-filled).
2. Extract DOM -> assert JSON contains `"type":"password","value_present":true` and NO `"value":"..."`.
3. Run any goal -> assert POST /plan body has no `s3cret` string (check server log / popup audit).
4. Headless check (no browser): `python server/test_planner.py` asserts the
   planner input carries `value_present` only.

Record each as 30s screen capture for submission.
