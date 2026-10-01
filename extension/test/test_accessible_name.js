/**
 * V.I.S.T.A. — Semantic DOM Formatter
 * Test Suite: Accessible Name Extraction (getAccessibleName)
 * 
 * Verifies the 8-level priority order:
 * 1. aria-label
 * 2. aria-labelledby
 * 3. associated label element
 * 4. accessible name (native control specific name / value)
 * 5. meaningful visible text
 * 6. placeholder
 * 7. alt text
 * 8. title
 * 
 * Tests required:
 * 1. button with visible text
 * 2. button with aria-label
 * 3. input with label
 * 4. input with placeholder
 * 5. image with alt
 * 6. aria-labelledby
 * 7. element with no useful name
 */

const assert = require("assert");

// Minimal DOM Mocking for testing in Node.js
class MockNode {
  constructor(tagName = "div", attrs = {}, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.textContent = textContent;
    this.id = attrs.id || "";
    this.type = attrs.type || "";
    this.value = attrs.value || "";
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
  }

  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return this.attrs[name] !== undefined;
  }

  setAttribute(name, val) {
    this.attrs[name] = val;
  }

  appendChild(child) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }

  closest(selector) {
    let curr = this.parentNode;
    const targetTag = selector.toUpperCase();
    while (curr) {
      if (curr.tagName === targetTag) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  contains(node) {
    if (!node) return false;
    let curr = node;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentNode;
    }
    return false;
  }

  cloneNode(deep) {
    const clone = new MockNode(this.tagName, this.attrs, this.textContent);
    clone.ownerDocument = this.ownerDocument;
    if (deep) {
      clone.children = this.children.map((c) => {
        const childClone = c.cloneNode(true);
        childClone.parentNode = clone;
        return childClone;
      });
    }
    return clone;
  }

  querySelectorAll(selector) {
    const results = [];
    const targetTags = selector.split(",").map((s) => s.trim().toUpperCase());
    function traverse(node) {
      for (const child of node.children) {
        if (targetTags.includes(child.tagName)) {
          results.push(child);
        }
        traverse(child);
      }
    }
    traverse(this);
    return results;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }
}

class MockDocument {
  constructor() {
    this.elementsById = new Map();
    this.labelsByFor = new Map();
  }

  createElement(tagName, attrs = {}, textContent = "") {
    const el = new MockNode(tagName, attrs, textContent);
    el.ownerDocument = this;
    if (el.id) {
      this.elementsById.set(el.id, el);
    }
    if (tagName.toLowerCase() === "label" && attrs.for) {
      this.labelsByFor.set(attrs.for, el);
    }
    return el;
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelector(sel) {
    const forMatch = sel.match(/^label\[for="([^"]+)"\]$/);
    if (forMatch) {
      return this.labelsByFor.get(forMatch[1]) || null;
    }
    return null;
  }
}

// Global browser mocks
global.CSS = {
  escape: (str) => str.replace(/([^\w-])/g, "\\$1")
};
global.window = {};
global.document = new MockDocument();

// Import getAccessibleName from content.js
const { getAccessibleName } = require("./content.js");

console.log("==================================================");
console.log("   V.I.S.T.A. — Accessible Name Extraction Tests   ");
console.log("==================================================\n");

const doc = new MockDocument();
global.document = doc;

// -------------------------------------------------------------
// Test 1: Button with visible text
// -------------------------------------------------------------
{
  const btn = doc.createElement("button", {}, "Submit Application");
  const nameOnly = getAccessibleName(btn);
  const details = getAccessibleName(btn, { includeSource: true });

  console.log("Test 1: Button with visible text");
  console.log("  Input:    <button>Submit Application</button>");
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "Submit Application", "Test 1 name mismatch");
  assert.strictEqual(details.name, "Submit Application");
  assert.strictEqual(details.source, "visible-text");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 2: Button with aria-label (overriding visible text)
// -------------------------------------------------------------
{
  const btn = doc.createElement(
    "button",
    { "aria-label": "Close modal dialog" },
    "×"
  );
  const nameOnly = getAccessibleName(btn);
  const details = getAccessibleName(btn, { includeSource: true });

  console.log("Test 2: Button with aria-label");
  console.log('  Input:    <button aria-label="Close modal dialog">×</button>');
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "Close modal dialog", "Test 2 name mismatch");
  assert.strictEqual(details.name, "Close modal dialog");
  assert.strictEqual(details.source, "aria-label");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 3: Input with associated label (label[for])
// -------------------------------------------------------------
{
  const label = doc.createElement("label", { for: "user-email" }, "Email Address");
  const input = doc.createElement("input", {
    id: "user-email",
    type: "email",
    placeholder: "name@example.com"
  });

  const nameOnly = getAccessibleName(input);
  const details = getAccessibleName(input, { includeSource: true });

  console.log("Test 3: Input with label[for]");
  console.log('  Input:    <label for="user-email">Email Address</label><input id="user-email" placeholder="name@example.com">');
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  // Label takes precedence over placeholder according to priority order
  assert.strictEqual(nameOnly, "Email Address", "Test 3 name mismatch");
  assert.strictEqual(details.name, "Email Address");
  assert.strictEqual(details.source, "associated-label");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 4: Input with placeholder (no label or aria)
// -------------------------------------------------------------
{
  const input = doc.createElement("input", {
    type: "search",
    placeholder: "Search products, brands and more"
  });

  const nameOnly = getAccessibleName(input);
  const details = getAccessibleName(input, { includeSource: true });

  console.log("Test 4: Input with placeholder");
  console.log('  Input:    <input type="search" placeholder="Search products, brands and more">');
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "Search products, brands and more", "Test 4 name mismatch");
  assert.strictEqual(details.name, "Search products, brands and more");
  assert.strictEqual(details.source, "placeholder");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 5: Image with alt text
// -------------------------------------------------------------
{
  const img = doc.createElement("img", {
    src: "logo.png",
    alt: "VISTA Platform Logo"
  });

  const nameOnly = getAccessibleName(img);
  const details = getAccessibleName(img, { includeSource: true });

  console.log("Test 5: Image with alt text");
  console.log('  Input:    <img src="logo.png" alt="VISTA Platform Logo">');
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "VISTA Platform Logo", "Test 5 name mismatch");
  assert.strictEqual(details.name, "VISTA Platform Logo");
  assert.strictEqual(details.source, "alt");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 6: Element with aria-labelledby
// -------------------------------------------------------------
{
  const heading = doc.createElement("span", { id: "billing-header" }, "Billing Address");
  const section = doc.createElement("div", {
    role: "region",
    "aria-labelledby": "billing-header"
  });

  const nameOnly = getAccessibleName(section);
  const details = getAccessibleName(section, { includeSource: true });

  console.log("Test 6: Element with aria-labelledby");
  console.log('  Input:    <span id="billing-header">Billing Address</span><div role="region" aria-labelledby="billing-header">');
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "Billing Address", "Test 6 name mismatch");
  assert.strictEqual(details.name, "Billing Address");
  assert.strictEqual(details.source, "aria-labelledby");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 7: Element with no useful name
// -------------------------------------------------------------
{
  const emptyDiv = doc.createElement("div", {});
  const nameOnly = getAccessibleName(emptyDiv);
  const details = getAccessibleName(emptyDiv, { includeSource: true });

  console.log("Test 7: Element with no useful name");
  console.log("  Input:    <div></div>");
  console.log(`  Name:     "${details.name}"`);
  console.log(`  Source:   "${details.source}"`);

  assert.strictEqual(nameOnly, "", "Test 7 name mismatch");
  assert.strictEqual(details.name, "");
  assert.strictEqual(details.source, "none");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Bonus Test: Priority Order Verification (aria-label vs aria-labelledby vs title)
// -------------------------------------------------------------
{
  const complexEl = doc.createElement("button", {
    "aria-label": "Primary Aria Label",
    "aria-labelledby": "other-id",
    title: "Secondary Title"
  }, "Visible Text");

  const details = getAccessibleName(complexEl, { includeSource: true });

  console.log("Bonus Test: Priority Hierarchy (aria-label vs text vs title)");
  console.log(`  Winner:   "${details.name}" (source: ${details.source})`);

  assert.strictEqual(details.name, "Primary Aria Label");
  assert.strictEqual(details.source, "aria-label");
  console.log("  Result:   ✅ PASS\n");
}

console.log("==================================================");
console.log("  🎉 All 7 Accessible Name tests passed cleanly!   ");
console.log("==================================================");
