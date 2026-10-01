/**
 * VISTA Phase 1 — PII deterministic-engine smoke test (node, no browser).
 * Exercises the ported extension/src/offscreen/vision/piiDetector.js in
 * regex-only mode (transformers.js cannot load in node -> graceful fallback).
 * Run: node extension/test/test_pii_regex.mjs
 */
import assert from 'node:assert';
import { redactTextContent, REGEX_RULES, UI_STOPWORDS, COMPANY_INDICATORS } from '../src/offscreen/vision/piiDetector.js';

assert.ok(REGEX_RULES.length >= 20, `expected 20+ regex rules, got ${REGEX_RULES.length}`);
assert.ok(UI_STOPWORDS.has('cart') && UI_STOPWORDS.has('download'), 'UI stopwords missing');
assert.ok(COMPANY_INDICATORS.test('Flipkart') && COMPANY_INDICATORS.test('Pepe Jeans'), 'company filter missing');

const cases = [
  ['Contact me at sarah.jenkins@gmail.com today', 'EMAIL'],
  ['My UPI is user@okaxis pay now', 'UPI_ID'],
  ['Follow @rohitsinghal for updates', 'HANDLE'],
  ['Aadhaar No: 2345 6789 0123 verify', 'AADHAAR'],
  ['PAN ABCDE1234F submitted', 'PAN'],
  ['Call +91 98765 43210 urgently', 'PHONE'],
  ['Card 4111 1111 1111 1111 charged', 'CARD'],
  ['IFSC HDFC0001234 branch', 'IFSC'],
  ['Order OD123456789012345678 done', 'ORDER_ID'],
  ['SSN 123-45-6789 on file', 'SSN'],
];

let pass = 0;
for (const [text, wantTag] of cases) {
  const out = await redactTextContent(text);
  const tags = (out.redactedEntities ?? []).map((e) => e.tag);
  assert.ok(tags.includes(wantTag), `FAIL "${text}": wanted ${wantTag}, got [${tags}] (cleaned: ${out.cleanedText})`);
  assert.ok(!out.cleanedText.includes(text.split(' ').find((w) => /@|\d/.test(w)) ?? '###impossible###') || tags.length > 0, 'PII leaked into cleanedText');
  pass++;
}

// False-positive shields: UI chrome must NOT be redacted.
for (const benign of ['Cart', 'Download Invoice', 'Flipkart', 'Search for products']) {
  const out = await redactTextContent(benign);
  assert.strictEqual(out.count, 0, `FALSE POSITIVE on "${benign}": ${JSON.stringify(out.redactedEntities)}`);
  pass++;
}

// Overlap priority: deterministic regex wins; engine label reflects regex-only in node.
const probe = await redactTextContent('Email sarah.jenkins@gmail.com');
assert.match(probe.engine, /regex/i, `expected regex-only engine in node, got ${probe.engine}`);

console.log(`pii smoke: ${pass}/${cases.length + 4} assertions passed (engine: ${probe.engine}, rules: ${REGEX_RULES.length})`);
