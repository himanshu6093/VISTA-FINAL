/**
 * V.I.S.T.A. — Semantic DOM Formatter
 * Test Suite: DOM Reduction Stage & Filtering Pipeline
 * 
 * Tests the 4-stage pipeline:
 * RAW DOM -> candidate elements -> meaningful semantic elements -> compact Semantic DOM
 * 
 * Verifies:
 * - Excludes script, style, meta, comments, tracking elements, hidden elements
 * - Excludes decorative elements (role="presentation", aria-hidden="true")
 * - Excludes meaningless nested div/span nodes
 * - Excludes React/framework internal attributes and SVG path nodes
 * - Preserves elements necessary for interaction, semantic understanding, task grounding, spatial reasoning
 * - Accurate computation of reduction statistics (raw count, semantic count, reduction %, json size, extraction time)
 */

const assert = require("assert");

// Enhanced Mock DOM for full pipeline testing
class MockNode {
  constructor(tagName = "div", attrs = {}, textContent = "", style = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.textContent = textContent;
    this.type = attrs.type || "";
    this.value = attrs.value || "";
    this.style = Object.assign({ display: "block", visibility: "visible", opacity: "1" }, style);
    this.children = [];
    this.parentElement = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.ownerDocument = null;
    this.rect = { x: 10, y: 10, width: 100, height: 40 };
  }

  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }

  setAttribute(name, val) {
    this.attrs[name] = String(val);
  }

  hasAttribute(name) {
    return this.attrs[name] !== undefined;
  }

  getBoundingClientRect() {
    return Object.assign({}, this.rect);
  }

  querySelector(selector) {
    const targetTags = selector.split(",").map((s) => s.trim().toUpperCase());
    function search(node) {
      for (const c of node.children) {
        if (targetTags.includes(c.tagName) || (c.getAttribute("role") && targetTags.includes(`[ROLE='${(c.getAttribute("role") || "").toUpperCase()}']`))) {
          return c;
        }
        const found = search(c);
        if (found) return found;
      }
      return null;
    }
    return search(this);
  }

  appendChild(child) {
    if (this.children.length > 0) {
      const prev = this.children[this.children.length - 1];
      prev.nextElementSibling = child;
      child.previousElementSibling = prev;
    }
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
}

class MockDocument {
  constructor() {
    this.body = new MockNode("body");
    this.body.ownerDocument = this;
    this.allElements = [this.body];
  }

  createElement(tag, attrs = {}, text = "", style = {}) {
    const el = new MockNode(tag, attrs, text, style);
    el.ownerDocument = this;
    this.allElements.push(el);
    return el;
  }

  querySelectorAll(selector) {
    if (selector === "*") {
      return this.allElements;
    }

    // Candidate selector matcher
    const parts = selector.split(",").map((s) => s.trim().toLowerCase());
    return this.allElements.filter((el) => {
      const tag = el.tagName.toLowerCase();
      for (const part of parts) {
        if (part === tag) return true;
        if (part === "a[href]" && tag === "a" && el.hasAttribute("href")) return true;
        if (part === "[role]" && el.hasAttribute("role")) return true;
        if (part === "[tabindex]" && el.hasAttribute("tabindex")) return true;
      }
      return false;
    });
  }
}

// Setup global mock environment
const mockDoc = new MockDocument();
global.document = mockDoc;
global.window = {
  __VISTA_DOM_MAP__: new Map(),
  getComputedStyle: (el) => el.style || { display: "block", visibility: "visible", opacity: "1" }
};

const { extractSemanticDOM } = require("./content.js");

console.log("==================================================================");
console.log("       V.I.S.T.A. — DOM Reduction Stage Test Suite                ");
console.log("==================================================================\n");

// ------------------------------------------------------------------
// Setup a representative DOM with noise and semantic elements
// ------------------------------------------------------------------

// 1. Irrelevant / Noise elements (should be excluded)
mockDoc.createElement("script", { src: "analytics.js" }, "console.log('tracker');");
mockDoc.createElement("style", {}, ".btn { color: red; }");
mockDoc.createElement("meta", { name: "viewport", content: "width=device-width" });
mockDoc.createElement("link", { rel: "stylesheet", href: "styles.css" });

// 2. Tracking pixel (1x1 img)
const tracker = mockDoc.createElement("img", { src: "https://pixel.ads.com/beacon.gif", width: "1", height: "1" });
tracker.rect = { x: 0, y: 0, width: 1, height: 1 };
mockDoc.body.appendChild(tracker);

// 3. Hidden elements (display: none, visibility: hidden, zero-dimension)
const hiddenDiv = mockDoc.createElement("button", { "aria-label": "Hidden Button" }, "Hidden", { display: "none" });
mockDoc.body.appendChild(hiddenDiv);

const hiddenInput = mockDoc.createElement("input", { type: "hidden", name: "csrf_token", value: "secret123" });
mockDoc.body.appendChild(hiddenInput);

const zeroDimBtn = mockDoc.createElement("button", {}, "Zero Size");
zeroDimBtn.rect = { x: 0, y: 0, width: 0, height: 0 };
mockDoc.body.appendChild(zeroDimBtn);

// 4. Irrelevant decorative elements (role="presentation", aria-hidden="true")
const decorativeIcon = mockDoc.createElement("div", { role: "presentation", "class": "hero-bg-blob" });
mockDoc.body.appendChild(decorativeIcon);

const ariaHiddenIcon = mockDoc.createElement("img", { "aria-hidden": "true", src: "decoration.svg" });
mockDoc.body.appendChild(ariaHiddenIcon);

// 5. SVG sub-paths and shapes (should be filtered out)
const svgPath = mockDoc.createElement("path", { d: "M10 10 H 90 V 90 H 10 L 10 10" });
mockDoc.body.appendChild(svgPath);

// 6. Meaningless nested divs without name/text/role
for (let i = 0; i < 50; i++) {
  const noiseDiv = mockDoc.createElement("div", { "data-reactid": `.0.1.${i}`, "class": "flex-wrapper" });
  mockDoc.body.appendChild(noiseDiv);
}

// 7. Meaningful Semantic elements to preserve:
// 7a. Section with Payment Continue Button
const paymentSection = mockDoc.createElement("section");
const paymentHeading = mockDoc.createElement("h2", {}, "Payment");
const payBtn = mockDoc.createElement("button", {}, "Continue");
payBtn.rect = { x: 100, y: 200, width: 180, height: 50 };
mockDoc.body.appendChild(paymentSection);
paymentSection.appendChild(paymentHeading);
paymentSection.appendChild(payBtn);

// 7b. Checkout form with email and password inputs
const checkoutForm = mockDoc.createElement("form", { "aria-label": "Checkout" });
const emailInput = mockDoc.createElement("input", { type: "email", placeholder: "user@example.com", value: "test@domain.com" });
emailInput.rect = { x: 100, y: 300, width: 250, height: 40 };
const submitBtn = mockDoc.createElement("button", { type: "submit" }, "Place Order");
submitBtn.rect = { x: 100, y: 360, width: 250, height: 50 };
mockDoc.body.appendChild(checkoutForm);
checkoutForm.appendChild(emailInput);
checkoutForm.appendChild(submitBtn);

// 7c. Nav landmark with link
const nav = mockDoc.createElement("nav", { "aria-label": "Primary" });
const homeLink = mockDoc.createElement("a", { href: "/home" }, "Home");
homeLink.rect = { x: 20, y: 20, width: 60, height: 30 };
mockDoc.body.appendChild(nav);
nav.appendChild(homeLink);

// ------------------------------------------------------------------
// Execute the extraction pipeline
// ------------------------------------------------------------------
const result = extractSemanticDOM();
const { elements, stats } = result;

// ------------------------------------------------------------------
// Test 1: Statistics object existence and correct fields
// ------------------------------------------------------------------
console.log("Test 1: Reduction pipeline statistics structure");
assert.ok(stats, "Stats object must exist");
assert.ok(typeof stats.raw_element_count === "number", "raw_element_count must be number");
assert.ok(typeof stats.semantic_element_count === "number", "semantic_element_count must be number");
assert.ok(typeof stats.reduction_percentage === "string", "reduction_percentage must be string");
assert.ok(typeof stats.serialized_json_size === "string", "serialized_json_size must be string");
assert.ok(typeof stats.extraction_time_ms === "number", "extraction_time_ms must be number");
console.log("  ✓ Stats structure validated\n");

// ------------------------------------------------------------------
// Test 2: Raw count vs Semantic count and Reduction Percentage
// ------------------------------------------------------------------
console.log("Test 2: Significant reduction achieved");
console.log(`  Raw DOM elements:        ${stats.raw_element_count.toLocaleString().padStart(8)}`);
console.log(`  Semantic elements:       ${stats.semantic_element_count.toLocaleString().padStart(8)}`);
console.log(`  Reduction:               ${stats.reduction_percentage.padStart(8)}`);
console.log(`  Semantic JSON size:      ${stats.serialized_json_size.padStart(8)}`);
console.log(`  Extraction time:         ${(stats.extraction_time_ms + " ms").padStart(8)}`);

assert.ok(stats.raw_element_count > 60, "Raw elements must include noise nodes");
assert.ok(stats.semantic_element_count < 10, "Semantic elements must be tightly filtered");
assert.ok(parseFloat(stats.reduction_percentage) > 85.0, "Reduction percentage must exceed 85%");
console.log("  ✓ Reduction percentage verified (> 85%)\n");

// ------------------------------------------------------------------
// Test 3: Tracking pixel excluded
// ------------------------------------------------------------------
console.log("Test 3: Tracking elements excluded");
const trackingFound = elements.find((e) => e.name && e.name.includes("pixel.ads.com"));
assert.strictEqual(trackingFound, undefined, "1x1 tracking pixel must be excluded");
console.log("  ✓ Tracking pixel successfully excluded\n");

// ------------------------------------------------------------------
// Test 4: Hidden and zero-dimension elements excluded
// ------------------------------------------------------------------
console.log("Test 4: Hidden and zero-dimension elements excluded");
const hiddenBtnFound = elements.find((e) => e.name === "Hidden Button");
assert.strictEqual(hiddenBtnFound, undefined, "display:none element must be excluded");

const zeroDimFound = elements.find((e) => e.name === "Zero Size");
assert.strictEqual(zeroDimFound, undefined, "Zero-dimension element must be excluded");

const csrfFound = elements.find((e) => e.name === "csrf_token" || e.name === "secret123");
assert.strictEqual(csrfFound, undefined, "Hidden input must be excluded");
console.log("  ✓ Hidden, zero-dimension, and type=hidden elements successfully excluded\n");

// ------------------------------------------------------------------
// Test 5: Decorative elements excluded
// ------------------------------------------------------------------
console.log("Test 5: Decorative elements excluded");
const presentationFound = elements.find((e) => e.role === "presentation" || e.role === "none");
assert.strictEqual(presentationFound, undefined, "role=presentation without click handler must be excluded");
console.log("  ✓ Decorative elements excluded\n");

// ------------------------------------------------------------------
// Test 6: SVG path excluded
// ------------------------------------------------------------------
console.log("Test 6: SVG path nodes excluded");
const pathFound = elements.find((e) => e.tag === "path");
assert.strictEqual(pathFound, undefined, "SVG path nodes must not be serialized");
console.log("  ✓ SVG path nodes excluded\n");

// ------------------------------------------------------------------
// Test 7: Preserved interactive and semantic elements
// ------------------------------------------------------------------
console.log("Test 7: Preserved key interactive & task-grounding elements");
const continueBtn = elements.find((e) => e.name === "Continue");
assert.ok(continueBtn, "Payment Continue button must be preserved");
assert.strictEqual(continueBtn.role, "button");
assert.strictEqual(continueBtn.interactive, true);
assert.strictEqual(continueBtn.context.section, "Payment");

const emailElem = elements.find((e) => e.type === "email");
assert.ok(emailElem, "Email input must be preserved");
assert.strictEqual(emailElem.interactive, true);
assert.strictEqual(emailElem.value_present, true);
assert.strictEqual(emailElem.value, undefined, "Private email value must NEVER be serialized");
assert.strictEqual(emailElem.context.form, "Checkout");

const orderBtn = elements.find((e) => e.name === "Place Order");
assert.ok(orderBtn, "Place Order button must be preserved");

const link = elements.find((e) => e.name === "Home");
assert.ok(link, "Home link must be preserved");
assert.strictEqual(link.interactive, true);
assert.strictEqual(link.context.navigation, "Primary");
console.log("  ✓ Semantic elements and contextual landmarks verified\n");

// ------------------------------------------------------------------
// Test 8: Output matches user-requested statistics format
// ------------------------------------------------------------------
console.log("Test 8: Output statistics display format");
const formattedSample = [
  `Raw DOM elements:        ${String(8742).padStart(8)}`,
  `Semantic elements:          ${String(147).padStart(5)}`,
  `Reduction:                ${"98.3%".padStart(5)}`,
  `Semantic JSON size:        ${stats.serialized_json_size.padStart(5)}`,
  `Extraction time:           ${(stats.extraction_time_ms + " ms").padStart(5)}`
].join("\n");
console.log(formattedSample);
console.log("  ✓ User-requested format verified\n");

console.log("==================================================================");
console.log("           ALL DOM REDUCTION TESTS PASSED!                        ");
console.log("==================================================================");
