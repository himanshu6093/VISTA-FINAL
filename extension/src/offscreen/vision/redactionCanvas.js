import { REGEX_RULES, UI_STOPWORDS, COMPANY_INDICATORS, hasIndianPINAddressContext } from './piiDetector.js';

// Common English words that must NEVER be treated as individual person names
const COMMON_DICTIONARY_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'all', 'any', 'not', 'are', 'were',
  'was', 'have', 'has', 'had', 'been', 'will', 'shall', 'would', 'could', 'should', 'can',
  'into', 'onto', 'upon', 'about', 'above', 'below', 'between', 'under', 'over', 'after',
  'before', 'first', 'second', 'third', 'basis', 'seats', 'course', 'courses', 'institution',
  'colleges', 'college', 'school', 'university', 'board', 'year', 'date', 'time', 'same',
  'dcece', 'bcece', 'allotted', 'category', 'merit', 'rank', 'serial', 'online', 'form',
  'application', 'hereby', 'declare', 'declaration', 'chosen', 'diploma', 'engineering',
  'mechanical', 'electrical', 'civil', 'computer', 'science', 'technology', 'free', 'will',
  'choice', 'liking', 'consideration', 'furnished', 'submitted', 'documents', 'correct',
  'authentic', 'found', 'false', 'forged', 'proved', 'adopted', 'unfair', 'means', 'stage',
  'publication', 'results', 'admission', 'liable', 'cancellation', 'expulsion', 'legal',
  'action', 'event', 'admitted', 'abide', 'rules', 'concerned', 'vacating', 'left', 'thumb',
  'impression', 'signature', 'candidate', 'english', 'hindi', 'recommended', 'allotment',
  'seat', 'verified', 'verifies', 'fulfills', 'eligibility', 'criteria', 'fixed', 'respective',
  'competent', 'apex', 'body', 'authority',
  // Months and Days of Week (Never person names)
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
  'mon', 'monday', 'tue', 'tuesday', 'wed', 'wednesday', 'thu', 'thursday',
  'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
  // School & Mark Sheet Terms (Never person names)
  'code', 'roll', 'subject', 'marks', 'obtained', 'first', 'div', 'division',
  'sil', 'mil', 'sanskrit', 'hindi', 'mathematics', 'maths', 'science', 'social',
  'english', 'aggregate', 'result', 'pass', 'controller', 'examination',
  'bseb', 'cbse', 'unique', 'centre', 'center'
]);

// Printed form field labels that must NEVER be masked by an entity self-match
const FORM_LABEL_WORDS = new Set([
  'name', 'roll', 'code', 'mother', 'mothers', "mother's", 'father', 'fathers', "father's",
  'school', 'subject', 'marks', 'controller', 'examination', 'date', 'year', 'state', 'pin',
  'village', 'post', 'district', 'police', 'station', 'account', 'ifsc', 'aadhar', 'aadhaar', 'mobile'
]);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Characters that join tokens into a larger identifier (email local-part, dotted handle,
// hyphenated slug, snake_case). A name token or single-word name entity adjacent to one of
// these belongs to that larger identifier — e.g. "sarah" inside "sarah.j.techie99 @gmail.com"
// or "jenkins" inside "s.jenkins@" — and must never be redacted as a standalone person name.
const IDENTIFIER_JOIN_CHARS = /[.@_\-]/;

// Address field-label phrases for the 2D multi-line address grounding (section 4c). Longest
// phrases first so multi-word variants win the alternation; mirrors the address-label variants
// used by the text-level PII detector.
const ADDRESS_LABEL_PHRASES = [
  'Current Residential Address', 'Primary Residential Address', 'Permanent Residential Address',
  'Prior Residential Address', 'Residential Address', 'Billing Address', 'Shipping Address',
  'Mailing Address', 'Delivery Address', 'Correspondence Address', 'Permanent Address',
  'Home Address', 'Local Address', 'Registered Address', 'Office Address', 'Address'
];

/**
 * Computes a surgical sub-bounding box for an in-line substring within an OCR text line box.
 * Allows pinpoint in-line redaction (e.g. redacting just "Rajesh Kumar" in a full sentence).
 */
function getCharWeight(ch) {
  if ('il1!|:;\',. -`'.includes(ch)) return 0.52;
  if ('frtI()[]{}'.includes(ch)) return 0.68;
  if ('mwWM@%#&'.includes(ch)) return 1.40;
  if (ch >= 'A' && ch <= 'Z') return 1.18;
  if (ch >= '0' && ch <= '9') return 1.12;
  return 0.95;
}

function snapToWordBoundaries(str, startIdx, endIdx) {
  let s = Math.max(0, startIdx);
  let e = Math.min(str.length, endIdx);
  // Snap s left if mid-word
  while (s > 0 && /\w/.test(str[s]) && /\w/.test(str[s - 1])) {
    s--;
  }
  // Snap e right if mid-word
  while (e < str.length && /\w/.test(str[e - 1]) && /\w/.test(str[e])) {
    e++;
  }
  return { s, e };
}

function computeSubBox(box, fullText, startIdx, endIdx) {
  const b = box || { x: 0, y: 0, width: 100, height: 20 };
  const str = fullText || '';
  
  // Snap to full word boundaries to prevent slicing words in half (e.g. "Start" -> "art")
  const { s: cleanStart, e: cleanEnd } = snapToWordBoundaries(str, startIdx, endIdx);

  let totalW = 0;
  const prefixWeights = [0];
  for (let i = 0; i < str.length; i++) {
    totalW += getCharWeight(str[i]);
    prefixWeights.push(totalW);
  }
  totalW = Math.max(0.1, totalW);

  const startRatio = prefixWeights[Math.min(cleanStart, str.length)] / totalW;
  const endRatio = prefixWeights[Math.min(cleanEnd, str.length)] / totalW;

  const boxW = b.width || 100;
  const rawX = (b.x || 0) + boxW * startRatio;
  const rawEnd = (b.x || 0) + boxW * endRatio;

  // Modest pixel padding (6px) so characters are never clipped
  const padPx = 6;
  const subX = Math.max(b.x || 0, Math.round(rawX - (cleanStart > 0 ? padPx : 0)));
  const subEnd = Math.min((b.x || 0) + boxW, Math.round(rawEnd + (cleanEnd < str.length ? padPx : 0)));
  const subW = Math.max(16, subEnd - subX);

  return {
    x: subX,
    y: b.y ?? 0,
    width: subW,
    height: b.height ?? 20
  };
}

/**
 * Matches detected OCR visual bounding boxes against extracted PII entities.
 * Eliminates false positives on icons, UI buttons, breadcrumbs, and random text fragments.
 * Computes surgical in-line sub-boxes so only the sensitive words are masked, not the whole line.
 *
 * @param {Array} ocrBoxes - Detected OCR boxes with { text, box, confidence }
 * @param {Array} redactedEntities - Extracted PII entities with { originalValue, tag }
 * @param {Array} qrBoxes - Detected QR code bounding boxes
 * @returns {Array} List of boxes to redact with assigned tags
 */
export function findBoxesToRedact(ocrBoxes, redactedEntities, qrBoxes = []) {
  const boxesToRedact = [];

  for (const item of ocrBoxes) {
    const itemText = (item.text || '').trim();
    if (!itemText) continue;

    const cleanLower = itemText.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, '');

    // High-precision check: Does this line contain direct PII (Email @, phone, card, account, aadhaar)?
    const containsEmail = /@/.test(itemText);
    const hasDirectPII = containsEmail || REGEX_RULES.some(rule => {
      if (rule.tag === 'ADDRESS') return false;
      const pat = new RegExp(rule.pattern.source, rule.pattern.flags);
      return pat.test(itemText);
    });

    if (!hasDirectPII) {
      if (cleanLower.length <= 2 && !/^\d{2}$/.test(cleanLower)) {
        continue; // Skip single letters, punctuation, icon noise like "v", "[PI", "o"
      }

      if (UI_STOPWORDS.has(cleanLower) || UI_STOPWORDS.has(itemText.toLowerCase())) {
        continue; // Skip generic buttons/navigation: "Home", "Download Invoice", "Cart", etc.
      }

      // Skip company, corporate, or organization names (e.g. Seller: CultX, Flipkart, Inc, Ltd, etc.)
      if (COMPANY_INDICATORS.test(itemText) || COMPANY_INDICATORS.test(cleanLower)) {
        continue;
      }
    }

    // Reject standalone code identifiers, repo slugs, file paths, or URLs (e.g. "helo-ayush/VISTA_PII")
    // Do NOT reject lines containing dates (12/30), parentage (S/o), or bank account labels (A/c)
    if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(itemText) && !/\d{1,2}\/\d{1,2}/.test(itemText)) {
      continue;
    }
    if (/^(?:https?:\/\/|www\.)\S+$/i.test(itemText)) {
      continue;
    }
    if (/^[a-zA-Z0-9]+_[a-zA-Z0-9_]+$/.test(cleanLower)) {
      continue;
    }

    const itemLower = itemText.toLowerCase();

    // Skip UI category lists or multi-word navigation where >= 50% of words are UI stopwords
    // UNLESS the line contains a high-precision sensitive PII match (e.g. ORDER_ID, PHONE, CARD, EMAIL, etc.)
    const words = cleanLower.split(/[\s,&/+-]+/).filter(w => w.length >= 2);
    if (words.length > 0 && !hasDirectPII) {
      const stopwordCount = words.filter(w => UI_STOPWORDS.has(w) || COMPANY_INDICATORS.test(w)).length;
      if (stopwordCount / words.length >= 0.50) {
        continue;
      }
    }

    const matchedSubSpans = [];

    // 1. Match against extracted PII entities
    for (const ent of redactedEntities) {
      const val = (ent.originalValue || '').trim();
      if (!val || val.length < 3) continue;

      const valLower = val.toLowerCase();
      const cleanVal = val.replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
      const cleanItem = itemText.replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();

      // Form label words can never be redacted by entity matches
      if (FORM_LABEL_WORDS.has(valLower) || FORM_LABEL_WORDS.has(cleanVal)) {
        continue;
      }
      if (FORM_LABEL_WORDS.has(cleanItem)) {
        continue;
      }

      // Case A: The OCR line contains the sensitive PII (either full entity or substring)
      let searchStart = 0;
      while (searchStart < itemLower.length) {
        const idx = itemLower.indexOf(valLower, searchStart);
        if (idx === -1) break;

        // A single-word name entity must not match inside a larger identifier/email
        // (e.g. NAME "Sarah" inside "sarah.j.techie99 @gmail.com"). Multi-word full-name
        // matches ("Sarah Jenkins", "Iyer-Subramanian") keep their existing behavior.
        if (ent.tag === 'NAME' && !/\s/.test(val)) {
          const prevChar = idx > 0 ? itemLower[idx - 1] : '';
          const nextChar = idx + val.length < itemLower.length ? itemLower[idx + val.length] : '';
          const isWordStart = idx === 0 || (!/\w/.test(prevChar) && !IDENTIFIER_JOIN_CHARS.test(prevChar));
          const isWordEnd = idx + val.length >= itemLower.length || (!/\w/.test(nextChar) && !IDENTIFIER_JOIN_CHARS.test(nextChar));
          if (!isWordStart || !isWordEnd) {
            searchStart = idx + val.length;
            continue;
          }
        }

        matchedSubSpans.push({
          start: idx,
          end: idx + val.length,
          tag: ent.tag,
          value: val
        });
        searchStart = idx + val.length;
      }

      // Multi-line ADDRESS entities (e.g. "742 Evergreen Terrace, Springfield, OR\n97477")
      // can never match a single OCR line verbatim. Match each newline-separated segment so
      // real addresses still get a surgical per-line redaction; tiny fragments such as a bare
      // PIN ("97477") are skipped so unrelated number-only lines are never dragged in.
      if (ent.tag === 'ADDRESS' && valLower.includes('\n')) {
        for (const seg of valLower.split(/\s*\n\s*/)) {
          if (seg.length < 8) continue;
          let sStart = 0;
          while (sStart < itemLower.length) {
            const sIdx = itemLower.indexOf(seg, sStart);
            if (sIdx === -1) break;
            matchedSubSpans.push({ start: sIdx, end: sIdx + seg.length, tag: ent.tag, value: seg });
            sStart = sIdx + seg.length;
          }
        }
      }

      // Case B: For person names, match individual name tokens (length >= 3, never common dictionary words)
      if (ent.tag === 'NAME' && val.split(/\s+/).length > 1) {
        const nameParts = val.split(/\s+/).filter(p => 
          p.length >= 3 && 
          !UI_STOPWORDS.has(p.toLowerCase()) && 
          !COMPANY_INDICATORS.test(p) &&
          !COMMON_DICTIONARY_WORDS.has(p.toLowerCase()) &&
          !FORM_LABEL_WORDS.has(p.toLowerCase())
        );
        for (const part of nameParts) {
          const partLower = part.toLowerCase();
          let pStart = 0;
          while (pStart < itemLower.length) {
            const pIdx = itemLower.indexOf(partLower, pStart);
            if (pIdx === -1) break;
            // Same IDENTIFIER_JOIN_CHARS guard as Case A - reject tokens inside emails/handles
            const isWordStart = pIdx === 0 || (!/\w/.test(itemLower[pIdx - 1]) && !IDENTIFIER_JOIN_CHARS.test(itemLower[pIdx - 1]));
            const isWordEnd = (pIdx + part.length >= itemLower.length) || (!/\w/.test(itemLower[pIdx + part.length]) && !IDENTIFIER_JOIN_CHARS.test(itemLower[pIdx + part.length]));
            if (isWordStart && isWordEnd) {
              matchedSubSpans.push({
                start: pIdx,
                end: pIdx + part.length,
                tag: 'NAME',
                value: part
              });
            }
            pStart = pIdx + part.length;
          }
        }
      }

      // Case C: The PII entity contains this OCR box (requires >= 70% match or address segment)
      if (cleanItem.length >= 4 && !UI_STOPWORDS.has(cleanLower) && !FORM_LABEL_WORDS.has(cleanItem)) {
        if (cleanVal.includes(cleanItem) && (cleanItem.length / cleanVal.length >= 0.70 || ent.tag === 'ADDRESS')) {
          matchedSubSpans.push({
            start: 0,
            end: itemText.length,
            tag: ent.tag,
            value: itemText
          });
        }
      }

      // Case D: Handles & Usernames (@username)
      if (ent.tag === 'HANDLE') {
        const cleanHandle = valLower.replace(/^[@#\s]+/, '');
        if (cleanHandle.length >= 3) {
          let hStart = 0;
          while (hStart < itemLower.length) {
            const hIdx = itemLower.indexOf(cleanHandle, hStart);
            if (hIdx === -1) break;
            const actualStart = (hIdx > 0 && (itemLower[hIdx - 1] === '@' || itemLower[hIdx - 1] === '#')) ? hIdx - 1 : hIdx;
            matchedSubSpans.push({
              start: actualStart,
              end: hIdx + cleanHandle.length,
              tag: 'HANDLE',
              value: cleanHandle
            });
            hStart = hIdx + cleanHandle.length;
          }
        }
      }
    }

    // 2. High-precision direct regex rules on this line (PHONE, CARD, AADHAAR, PAN, EMAIL, UPI, ACCOUNT_NUMBER, CVV, etc.)
    for (const rule of REGEX_RULES) {
      if (rule.tag === 'ADDRESS') continue;
      const pat = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m;
      while ((m = pat.exec(itemText)) !== null) {
        if (m[1]) {
          const valStart = m.index + m[0].lastIndexOf(m[1]);
          matchedSubSpans.push({
            start: valStart,
            end: valStart + m[1].length,
            tag: rule.tag,
            value: m[1]
          });
        } else {
          matchedSubSpans.push({
            start: m.index,
            end: m.index + m[0].length,
            tag: rule.tag,
            value: m[0]
          });
        }
      }
    }

    // 3. Direct handle detection: any OCR box starting with @ or containing @username
    const handleRegex = /(?<=\s|^|[([:;,])@\s*[a-zA-Z0-9_.-]{2,32}\b/gi;
    let hm;
    while ((hm = handleRegex.exec(itemText)) !== null) {
      matchedSubSpans.push({
        start: hm.index,
        end: hm.index + hm[0].length,
        tag: 'HANDLE',
        value: hm[0]
      });
    }

    if (matchedSubSpans.length > 0) {
      // Sort and merge overlapping sub-spans within this line
      matchedSubSpans.sort((a, b) => a.start - b.start);
      const mergedLineSpans = [];
      for (const span of matchedSubSpans) {
        if (mergedLineSpans.length === 0) {
          mergedLineSpans.push({ ...span });
        } else {
          const last = mergedLineSpans[mergedLineSpans.length - 1];
          if (span.start <= last.end) {
            last.end = Math.max(last.end, span.end);
            if (span.tag === 'NAME' || last.tag === 'NAME') last.tag = 'NAME';
          } else {
            mergedLineSpans.push({ ...span });
          }
        }
      }

      // Generate surgical boxes for each matched entity
      for (const span of mergedLineSpans) {
        const itemBox = item.box || { x: item.x || 0, y: item.y || 0, width: item.width || 100, height: item.height || 20 };
        const spanRatio = (span.end - span.start) / itemText.length;
        if (spanRatio >= 0.85) {
          // Entity occupies the whole line -> redact full box
          boxesToRedact.push({
            ...itemBox,
            text: itemText,
            tag: span.tag,
            confidence: item.confidence
          });
        } else {
          // Entity is an in-line substring -> compute pinpoint sub-box!
          const sub = computeSubBox(itemBox, itemText, span.start, span.end);
          boxesToRedact.push({
            ...sub,
            text: itemText.substring(span.start, span.end),
            tag: span.tag,
            confidence: item.confidence
          });
        }
      }
    }
  }

  // --- 4. 2D Spatial Key-Value Grounding for ID & Form Labels ---
  const KEY_VALUE_LABELS = [
    { pattern: /\bRoll\s*(?:No\.?|Number)/i, tag: 'ID' },
    { pattern: /\bEnrollment\s*(?:No\.?|Number)/i, tag: 'ID' },
    { pattern: /\bRegistration\s*(?:No\.?|Number)/i, tag: 'ID' },
    { pattern: /\bStudent\s*(?:ID|No\.?)/i, tag: 'ID' },
    { pattern: /\bCandidate\s*(?:ID|Code|No\.?)/i, tag: 'ID' }
  ];

  for (const item of ocrBoxes) {
    const itemText = (item.text || '').trim();
    for (const rule of KEY_VALUE_LABELS) {
      if (rule.pattern.test(itemText)) {
        // Look for an adjacent OCR box to the right within 240px and same vertical band.
        // The adjacent box must actually look like an ID value (letters + digits mix),
        // never a generic UI label or company name.
        const itemBox = item.box || item;
        const adjacent = ocrBoxes.find(b => {
          if (b === item) return false;
          const bBox = b.box || b;
          const bText = (b.text || '').trim();
          const isRight = bBox.x > itemBox.x && bBox.x < itemBox.x + itemBox.width + 240;
          const isSameBand = Math.abs(bBox.y - itemBox.y) < Math.max(itemBox.height, 25);
          const looksLikeID = /^(?=[A-Za-z0-9/-]*\d)[A-Za-z0-9/-]{4,}$/.test(bText) &&
            !UI_STOPWORDS.has(bText.toLowerCase()) &&
            !COMPANY_INDICATORS.test(bText);
          return isRight && isSameBand && looksLikeID;
        });

        if (adjacent) {
          const adjBox = adjacent.box || adjacent;
          const alreadyRedacted = boxesToRedact.some(b => 
            Math.abs(b.x - adjBox.x) < 10 && Math.abs(b.y - adjBox.y) < 10
          );
          if (!alreadyRedacted) {
            boxesToRedact.push({
              ...adjBox,
              text: adjacent.text,
              tag: rule.tag,
              confidence: adjacent.confidence
            });
          }
        }
      }
    }
  }

  // --- 4a. 2D Spatial Form-Field Grounding for Hand-Filled Passbooks & Forms ---
  const PASSBOOK_FIELDS = [
    { pattern: /\b(?:Name\s+Of\s+Account\s+Holder|Account\s+Holder(?:\s*Name)?|Customer\s+Name)\s*[:#-]?/i, tag: 'NAME', defaultW: 240, isValid: (t) => /^[A-Za-z][A-Za-z.'’\- ]{2,}$/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) },
    { pattern: /\b(?:Father'?s?\/Husband'?s?\s+Name|Father'?s?\s+Name|Husband'?s?\s+Name)\s*[:#-]?/i, tag: 'NAME', defaultW: 240, isValid: (t) => /^[A-Za-z][A-Za-z.'’\- ]{2,}$/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) },
    { pattern: /\bVillage\s*[:#-]?/i, tag: 'ADDRESS', defaultW: 180, isValid: (t) => /[A-Za-z]{3,}/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) && !COMPANY_INDICATORS.test(t) },
    { pattern: /\bPost\s*[:#-]?/i, tag: 'ADDRESS', defaultW: 180, isValid: (t) => /[A-Za-z]{3,}/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) && !COMPANY_INDICATORS.test(t) },
    { pattern: /\bPolice\s*Station\s*[:#-]?/i, tag: 'ADDRESS', defaultW: 180, isValid: (t) => /[A-Za-z]{3,}/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) && !COMPANY_INDICATORS.test(t) },
    { pattern: /\bDistrict\s*[:#-]?/i, tag: 'ADDRESS', defaultW: 180, isValid: (t) => /[A-Za-z]{3,}/.test(t) && !UI_STOPWORDS.has(t.toLowerCase()) && !COMPANY_INDICATORS.test(t) },
    { pattern: /\b(?:Account\s*No|A\/c\s*No)\s*[:#-]?/i, tag: 'ACCOUNT_NUMBER', defaultW: 260, isValid: (t) => /\d{4,}/.test(t) },
    { pattern: /\b(?:Aadhar|Aadhaar)\s*No\s*[:#-]?/i, tag: 'AADHAAR', defaultW: 240, isValid: (t) => /\d{4,}/.test(t) }
  ];

  for (const item of ocrBoxes) {
    const itemText = (item.text || '').trim();
    for (const field of PASSBOOK_FIELDS) {
      if (field.pattern.test(itemText)) {
        const itemBox = item.box || item;
        // Check if there is an OCR box directly to the right in the same horizontal band.
        // The adjacent box must plausibly contain the field's value for that tag (letters-only
        // for names, digits for account/aadhaar numbers, never UI stopwords or company names).
        const adjacent = ocrBoxes.find(b => {
          if (b === item) return false;
          const bBox = b.box || b;
          const bText = (b.text || '').trim();
          const isRight = bBox.x > itemBox.x && bBox.x < itemBox.x + itemBox.width + 240;
          const isSameBand = Math.abs(bBox.y - itemBox.y) < Math.max(itemBox.height, 25);
          return isRight && isSameBand && field.isValid(bText);
        });

        if (adjacent) {
          const adjBox = adjacent.box || adjacent;
          const already = boxesToRedact.some(b => Math.abs(b.x - adjBox.x) < 10 && Math.abs(b.y - adjBox.y) < 10);
          if (!already) {
            boxesToRedact.push({ ...adjBox, text: adjacent.text, tag: field.tag });
          }
        } else {
          // No OCR box detected because handwritten Hindi/Devanagari was unread by Latin OCR.
          // Ground the fill-in zone directly to the right!
          const fillX = Math.round(itemBox.x + itemBox.width + 6);
          const fillY = Math.max(0, Math.round(itemBox.y - 2));
          const fillW = field.defaultW;
          const fillH = Math.round(itemBox.height * 1.35);

          const already = boxesToRedact.some(b => 
            Math.abs(b.x - fillX) < 30 && Math.abs(b.y - fillY) < 15
          );
          if (!already) {
            boxesToRedact.push({
              x: fillX,
              y: fillY,
              width: fillW,
              height: fillH,
              tag: field.tag,
              text: `<${field.tag}_FIELD>`
            });
          }
        }
      }
    }
  }
  for (const item of ocrBoxes) {
    const t = (item.text || '').trim();
    if (
      /\b[A-Z]{2}[- ]?\d{1,3}[- ]?(?:19|20)\d{2}[- ]?\d{7}\b/i.test(t) ||
      /\bDL[- ]?\d{1,3}[- ]?\d{7,11}\b/i.test(t) ||
      /\b(?:DL|DL1|DL01)\s+\d{10,12}\b/i.test(t)
    ) {
      const bBox = item.box || item;
      const already = boxesToRedact.some(r => Math.abs(r.x - bBox.x) < 10 && Math.abs(r.y - bBox.y) < 10);
      if (!already) {
        boxesToRedact.push({ ...bBox, text: t, tag: 'DRIVING_LICENSE' });
      }
    }
  }

  // --- 4c. Multi-Line Address Grounding (e.g. "Address: 23B-CB," and lines directly below) ---
  // Build anchored label regexes from ADDRESS_LABEL_PHRASES.
  // LABEL_WITH_SEP: label at line start followed by : # - (value on same line)
  // LABEL_ONLY:     standalone short label with nothing else (value on next lines)
  const _labelAlt = ADDRESS_LABEL_PHRASES.map(p => esc(p)).join("|");
  const ADDRESS_LABEL_WITH_SEP_RE = new RegExp("^\\s*(?:" + _labelAlt + ")\\s*[:#-]\\s*(.*)$", "i");
  const ADDRESS_LABEL_ONLY_RE = new RegExp("^\\s*(?:" + _labelAlt + ")\\s*$", "i");
  const addrLabels = ocrBoxes.filter(b => {
    const t = (b.text || "").trim();
    return ADDRESS_LABEL_WITH_SEP_RE.test(t) || (ADDRESS_LABEL_ONLY_RE.test(t) && t.length <= 36);
  });
  for (const labelItem of addrLabels) {
    const lBox = labelItem.box || labelItem;
    const lText = (labelItem.text || '').trim();

    // 1. Redact address content on the label line itself
    // Use anchored regex to capture same-line value after the label separator.
    // For standalone labels (no separator), no same-line value - handled by step 2.
    const match = ADDRESS_LABEL_WITH_SEP_RE.exec(lText);
    if (match && match[1] && match[1].trim().length > 0) {
      const sub = computeSubBox(lBox, lText, lText.indexOf(match[1]), lText.length);
      boxesToRedact.push({ ...sub, text: match[1], tag: 'ADDRESS' });
    }

    // 2. Find subsequent lines located vertically below this address label (downwards within 160px).
    // Narrow horizontal window (~40px left / ~60px right of the label's left edge) so unrelated
    // right-side content is never dragged in; stop at lines that look like other labels/UI.
    const addressLines = ocrBoxes.filter(b => {
      if (b === labelItem) return false;
      const bBox = b.box || b;
      const bText = (b.text || '').trim();
      const isBelow = bBox.y > lBox.y && bBox.y < lBox.y + 160;
      const isAligned = bBox.x >= lBox.x - 40 && bBox.x <= lBox.x + 60;
      const isNotAnotherLabel = !/\b(?:Date\s*of\s*Birth|Blood\s*Group|Organ\s*Donor|Validity|Son[\s/]*|Signature|Issue\s*Date|Holder|Mobile\s*(?:No\.?|Number)?|Phone(?:\s*No\.?)?|Email|PIN(?:\s*Code)?|Pincode|District|Village|State|Country|Name|Father'?s?\s*Name|Mother'?s?\s*Name|Husband'?s?\s*Name|Wife'?s?\s*Name|Account\s*(?:No\.?|Number)|IFSC|Aadhaar|PAN|DOB)\b/i.test(bText);
      const isNotUI = !UI_STOPWORDS.has(bText.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ''));
      return isBelow && isAligned && isNotAnotherLabel && isNotUI;
    });

    for (const line of addressLines) {
      const bBox = line.box || line;
      const already = boxesToRedact.some(r => Math.abs(r.x - bBox.x) < 10 && Math.abs(r.y - bBox.y) < 10);
      if (!already) {
        boxesToRedact.push({ ...bBox, text: line.text, tag: 'ADDRESS' });
      }
    }
  }

  // Catch address lines with Indian PIN codes or Cantonment (e.g. "...,DELHI,110028" or "DELHI CANTONMENT").
  // Gated on real address context (known city / PIN label / street-keyword multi-part address) so
  // HSN codes, quantities, prices and other bare 6-digit numbers never trigger a whole-line blur.
  for (const item of ocrBoxes) {
    const itemText = (item.text || '').trim();
    if (/\b(?:CANTONMENT|CANTT)\b/i.test(itemText) || hasIndianPINAddressContext(itemText)) {
      if (!/\b(?:Issued\s*by|Transport\s*Department|Government\s*of)\b/i.test(itemText)) {
        const bBox = item.box || item;
        const already = boxesToRedact.some(r => Math.abs(r.x - bBox.x) < 10 && Math.abs(r.y - bBox.y) < 10);
        if (!already) {
          boxesToRedact.push({ ...bBox, text: itemText, tag: 'ADDRESS' });
        }
      }
    }
  }

  // --- 4d. Relation / Relative Name Grounding (Son/Daughter/Wife of) ---
  const relationLabels = ocrBoxes.filter(b => /\b(?:Son[\s/]*Daughter[\s/]*Wife\s*of|S\/o|D\/o|W\/o|C\/o)\s*[:#-]?/i.test(b.text || ''));
  for (const relItem of relationLabels) {
    const rBox = relItem.box || relItem;
    const rText = (relItem.text || '').trim();
    const rMatch = rText.match(/\b(?:Son[\s/]*Daughter[\s/]*Wife\s*of|S\/o|D\/o|W\/o|C\/o)\s*[:#-]?\s*(.*)/i);
    if (rMatch && rMatch[1] && rMatch[1].trim().length > 1) {
      const sub = computeSubBox(rBox, rText, rText.indexOf(rMatch[1]), rText.length);
      boxesToRedact.push({ ...sub, text: rMatch[1], tag: 'NAME' });
    } else {
      const adjacent = ocrBoxes.find(b => {
        if (b === relItem) return false;
        const bBox = b.box || b;
        const isRight = bBox.x > rBox.x && bBox.x < rBox.x + rBox.width + 300;
        const isSameBand = Math.abs(bBox.y - rBox.y) < Math.max(rBox.height, 25);
        return isRight && isSameBand && /[A-Za-z]{2,}/.test(b.text || '');
      });
      if (adjacent) {
        const adjBox = adjacent.box || adjacent;
        boxesToRedact.push({ ...adjBox, text: adjacent.text, tag: 'NAME' });
      }
    }
  }

  // --- 4e. Date of Birth Grounding ---
  const dobLabels = ocrBoxes.filter(b => /\b(?:Date\s*of\s*Birth|DOB)\s*[:#-]?/i.test(b.text || ''));
  for (const dobItem of dobLabels) {
    const dBox = dobItem.box || dobItem;
    const dText = (dobItem.text || '').trim();
    const dobMatch = dText.match(/\b(?:Date\s*of\s*Birth|DOB)\s*[:#-]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i);
    if (dobMatch && dobMatch[1]) {
      const sub = computeSubBox(dBox, dText, dText.indexOf(dobMatch[1]), dText.indexOf(dobMatch[1]) + dobMatch[1].length);
      boxesToRedact.push({ ...sub, text: dobMatch[1], tag: 'DOB' });
    }
  }

  // --- 4f. Bilingual Regional / Hindi Name Detection on Indian IDs (Aadhaar, Voter ID, PAN) ---
  const isAadhaarOrID = ocrBoxes.some(b => 
    /\b(?:Government\s+of\s+India|UIDAI|Unique\s+Identification|Aadhaar|Income\s*Tax\s*Department|Election\s*Commission)\b/i.test(b.text || '')
  ) || boxesToRedact.some(b => b.tag === 'AADHAAR' || b.tag === 'PAN' || b.tag === 'VOTER_ID');

  if (isAadhaarOrID) {
    const nameBoxes = boxesToRedact.filter(b => b.tag === 'NAME');
    for (const nb of nameBoxes) {
      // Check if there is space directly above the English name for the Hindi/Regional name
      const hindiY = Math.max(0, Math.round(nb.y - nb.height * 1.15 - 4));
      const hindiH = Math.round(nb.height * 1.05);
      const alreadyMasked = boxesToRedact.some(b => Math.abs(b.x - nb.x) < 20 && Math.abs(b.y - hindiY) < 12);
      if (!alreadyMasked && hindiY > 15) {
        boxesToRedact.push({
          x: nb.x,
          y: hindiY,
          width: nb.width,
          height: hindiH,
          tag: 'NAME',
          text: '<Hindi/Regional Name>'
        });
      }
    }
  }

  // --- 5. 2D Spatial Signature Detection (Candidate & Holder Signature) ---
  const sigLabel = ocrBoxes.find(b => /\b(?:Signature\s+of\s+(?:the\s+)?Candidate|Holder'?s\s+Signature|Candidate'?s\s+Signature|Sign\s+of\s+Holder)\b/i.test(b.text));
  if (sigLabel) {
    const sigBox = sigLabel.box || sigLabel;

    // Guard: Do not redact if there is printed body paragraph text directly above (e.g. declaration paragraph)
    const textAbove = ocrBoxes.find(b => {
      if (b === sigLabel) return false;
      const bBox = b.box || b;
      const isDirectlyAbove = bBox.y < sigBox.y && bBox.y > sigBox.y - 70;
      const isHorizontallyOverlapping = Math.max(bBox.x, sigBox.x) < Math.min(bBox.x + bBox.width, sigBox.x + sigBox.width);
      return isDirectlyAbove && isHorizontallyOverlapping && (b.text || '').length > 20;
    });

    // Guard: Do not redact if this is a blank form with dotted lines (e.g. "(i) In English .....")
    const hasDottedLines = ocrBoxes.some(b => 
      /\b(?:In\s*English|In\s*Hindi)\b/i.test(b.text || '') && /\.{3,}/.test(b.text || '')
    );

    if (!textAbove && !hasDottedLines) {
      const sigH = Math.max(55, Math.round(sigBox.height * 2.2));
      const sigW = Math.max(140, Math.round(sigBox.width * 1.1));
      boxesToRedact.push({
        x: Math.max(0, sigBox.x - 10),
        y: Math.max(0, sigBox.y - sigH - 4),
        width: sigW,
        height: sigH,
        tag: 'SIGNATURE',
        text: '<Holder/Candidate Signature>'
      });
    }
  }

  // --- 6. 2D Spatial Official Signatures (Dean / Principal / Controller of Examination) ---
  const officialSigLabels = ocrBoxes.filter(b => /\b(?:Dean|Principal|Director|Controller\s+of\s+Examination)\b/i.test(b.text));
  for (const off of officialSigLabels) {
    const offBox = off.box || off;
    const sigH = Math.max(50, Math.round(offBox.height * 2.2));
    const sigW = Math.max(130, Math.round(offBox.width * 0.95));
    boxesToRedact.push({
      x: Math.max(0, offBox.x),
      y: Math.max(0, offBox.y - sigH - 5),
      width: sigW,
      height: sigH,
      tag: 'SIGNATURE',
      text: '<Official Signature>'
    });
  }

  // --- 7. QR Codes & 2D Matrix Barcodes ---
  for (const qr of qrBoxes) {
    boxesToRedact.push({
      x: qr.x,
      y: qr.y,
      width: qr.width,
      height: qr.height,
      tag: 'QR',
      text: '<QR Code>'
    });
  }

  return boxesToRedact;
}

/**
 * Applies mathematical pixelation blur to an arbitrary bounding box on the canvas.
 */
function applyPixelatedBlur(ctx, x, y, width, height, pixelSize = 12) {
  if (![x, y, width, height, pixelSize].every(Number.isFinite) || width < 1 || height < 1 || pixelSize < 1) return;

  // Clip the source rect to the canvas: drawImage throws on out-of-bounds/negative sizes.
  const sx = Math.min(Math.max(0, Math.round(x)), ctx.canvas.width - 1);
  const sy = Math.min(Math.max(0, Math.round(y)), ctx.canvas.height - 1);
  const sw = Math.max(1, Math.min(Math.round(width), ctx.canvas.width - sx));
  const sh = Math.max(1, Math.min(Math.round(height), ctx.canvas.height - sy));

  const scaledW = Math.max(1, Math.floor(sw / pixelSize));
  const scaledH = Math.max(1, Math.floor(sh / pixelSize));

  const offscreen = document.createElement('canvas');
  offscreen.width = scaledW;
  offscreen.height = scaledH;

  const offCtx = offscreen.getContext('2d');
  offCtx.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, scaledW, scaledH);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, 0, 0, scaledW, scaledH, sx, sy, sw, sh);
  ctx.restore();
}

/**
 * Draws rounded rectangle helper.
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Main visual rendering engine on HTML5 Canvas.
 * Renders document image, blurred faces with <FACE_HIDDEN>, and blurred/guided PII text boxes (<NAME_HIDDEN>, etc.).
 *
 * @param {HTMLCanvasElement} canvas - Target display canvas
 * @param {HTMLImageElement} img - Source image
 * @param {Array} boxesToRedact - Bounding boxes of detected PII text
 * @param {Array} allOcrBoxes - All detected OCR boxes (for inspection mode)
 * @param {Array} faces - Detected faces from YuNet
 * @param {string} viewMode - 'guided' | 'blackout' | 'boxes' | 'original'
 * @returns {number} Time taken to render in milliseconds
 */
export function renderCanvasOverlay(canvas, img, boxesToRedact = [], allOcrBoxes = [], faces = [], viewMode = 'guided') {
  if (!canvas || !img) return 0;
  const startTime = performance.now();
  const ctx = canvas.getContext('2d');

  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  // 1. Draw pristine original image
  ctx.drawImage(img, 0, 0);

  if (viewMode === 'original') {
    return Math.round(performance.now() - startTime);
  }

  // --- MODE: FACE BOXES ---
  if (viewMode === 'faces') {
    faces.forEach((face, idx) => {
      ctx.lineWidth = Math.max(3, Math.round(canvas.width / 400));
      ctx.strokeStyle = '#a855f7'; // Purple-500
      ctx.strokeRect(face.x, face.y, face.width, face.height);

      // Subtle fill
      ctx.fillStyle = 'rgba(168, 85, 247, 0.15)';
      ctx.fillRect(face.x, face.y, face.width, face.height);

      const fontSize = Math.max(12, Math.round(canvas.width / 70));
      ctx.font = `bold ${fontSize}px monospace`;
      const faceLabel = `Face #${idx + 1} (${Math.round(face.score * 100)}%)`;
      const metrics = ctx.measureText(faceLabel);

      ctx.fillStyle = 'rgba(147, 51, 234, 0.95)';
      ctx.fillRect(face.x, Math.max(0, face.y - fontSize - 6), metrics.width + 10, fontSize + 6);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(faceLabel, face.x + 5, Math.max(fontSize, face.y - 4));

      // Facial landmarks
      if (face.landmarks && Array.isArray(face.landmarks)) {
        ctx.fillStyle = '#fbbf24';
        for (const pt of face.landmarks) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, Math.max(3, Math.round(canvas.width / 350)), 0, 2 * Math.PI);
          ctx.fill();
        }
      }
    });
    return Math.round(performance.now() - startTime);
  }

  // --- MODE: OCR BOXES ---
  if (viewMode === 'ocr') {
    for (const item of allOcrBoxes) {
      const isRedacted = boxesToRedact.some(b => b.x === item.box.x && b.y === item.box.y);
      ctx.lineWidth = Math.max(1.5, Math.round(canvas.width / 600));
      ctx.strokeStyle = isRedacted ? '#ef4444' : '#10b981';
      ctx.strokeRect(item.box.x, item.box.y, item.box.width, item.box.height);

      ctx.fillStyle = isRedacted ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.08)';
      ctx.fillRect(item.box.x, item.box.y, item.box.width, item.box.height);

      const fontSize = Math.max(10, Math.round(canvas.width / 90));
      ctx.font = `bold ${fontSize}px monospace`;
      // Display the full scanned text without artificial 15-character truncation
      const label = isRedacted ? `[${item.tag || 'PII'}]` : (item.text || `${Math.round(item.confidence * 100)}%`);
      const textMetrics = ctx.measureText(label);

      ctx.fillStyle = isRedacted ? 'rgba(239, 68, 68, 0.9)' : 'rgba(16, 185, 129, 0.85)';
      ctx.fillRect(item.box.x, Math.max(0, item.box.y - fontSize - 4), textMetrics.width + 6, fontSize + 4);

      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, item.box.x + 3, Math.max(fontSize, item.box.y - 3));
    }
    return Math.round(performance.now() - startTime);
  }

  // --- MODE 1: GUIDED SEMANTIC PRIVACY MASKING (DEFAULT & RECOMMENDED) ---
  // A. Blur & Mask Faces with <FACE_HIDDEN> (with 25-35% head margin expansion)
  for (const face of faces) {
    const padW = Math.round(face.width * 0.25);
    const padH = Math.round(face.height * 0.35);
    const fx = Math.max(0, Math.round(face.x - padW / 2));
    const fy = Math.max(0, Math.round(face.y - padH * 0.65)); // extra expansion upward for hair/forehead
    const fw = Math.min(canvas.width - fx, Math.round(face.width + padW));
    const fh = Math.min(canvas.height - fy, Math.round(face.height + padH));

    // Apply privacy pixelation blur
    const pixelSize = Math.max(8, Math.round(fw / 12));
    applyPixelatedBlur(ctx, fx, fy, fw, fh, pixelSize);

    // Frosted dark privacy veil over face
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.fillRect(fx, fy, fw, fh);

    // Face border outline
    ctx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
    ctx.lineWidth = Math.max(2, Math.round(canvas.width / 500));
    ctx.strokeRect(fx, fy, fw, fh);

    // Centered Guided Label Badge: <FACE_HIDDEN>
    const badgeText = '<FACE_HIDDEN>';
    const fontSize = Math.max(12, Math.min(22, Math.round(fw / 6)));
    ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    const metrics = ctx.measureText(badgeText);
    const badgeW = metrics.width + 16;
    const badgeH = fontSize + 10;
    const badgeX = fx + (fw - badgeW) / 2;
    const badgeY = fy + (fh - badgeH) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    drawRoundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fill();
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, badgeX + 8, badgeY + badgeH / 2);
    ctx.restore();
  }

  // B. Blur & Fill Sensitive PII Text with Guided Semantic Badges (<NAME_HIDDEN>, etc.)
  for (const box of boxesToRedact) {
    const padX = Math.max(3, Math.round(box.width * 0.02));
    const padY = Math.max(3, Math.round(box.height * 0.08));
    const rx = Math.max(0, box.x - padX);
    const ry = Math.max(0, box.y - padY);
    const rw = Math.min(canvas.width - rx, box.width + padX * 2);
    const rh = Math.min(canvas.height - ry, box.height + padY * 2);

    // Apply privacy pixelation blur over the underlying text
    applyPixelatedBlur(ctx, rx, ry, rw, rh, Math.max(4, Math.round(rh / 3)));

    // Deep semantic background fill
    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    drawRoundedRect(ctx, rx, ry, rw, rh, 4);
    ctx.fill();

    // Guided semantic token: <TAG_HIDDEN> or compact [TAG] if box is narrow
    const rawTag = (box.tag || 'PII').toUpperCase();
    const tag = rawTag === 'DRIVING_LICENSE' ? 'DL' : rawTag;
    const token = rw >= 85 ? `<${tag}_HIDDEN>` : (rw >= 40 ? `[${tag}]` : `*`);

    const maxFontSize = Math.max(10, Math.min(18, Math.round(rh * 0.65)));
    ctx.font = `bold ${maxFontSize}px ui-monospace, SFMono-Regular, monospace`;
    let metrics = ctx.measureText(token);

    // Auto-fit font size if badge is wider than the box
    let fittedFontSize = maxFontSize;
    if (metrics.width > rw - 6 && rw > 25) {
      fittedFontSize = Math.max(8, Math.floor(maxFontSize * (rw - 6) / metrics.width));
      ctx.font = `bold ${fittedFontSize}px ui-monospace, SFMono-Regular, monospace`;
      metrics = ctx.measureText(token);
    }

    ctx.save();
    ctx.fillStyle = '#38bdf8'; // Sky-400 for high-contrast machine-readable AI recognition
    ctx.textBaseline = 'middle';
    const textX = rx + Math.max(3, (rw - metrics.width) / 2);
    const textY = ry + rh / 2;
    ctx.fillText(token, textX, textY);
    ctx.restore();
  }

  return Math.round(performance.now() - startTime);
}
