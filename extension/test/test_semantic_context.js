/**
 * V.I.S.T.A. — Semantic DOM Formatter
 * Test Suite: Semantic Parent / Context Extraction
 * 
 * Verifies that meaningful elements capture compact semantic context from ancestors:
 * - section (e.g. <section><h2>Payment</h2><button>Continue</button></section> -> { section: "Payment" })
 * - footer (e.g. <footer><button>Continue</button></footer> -> { section: "Footer" })
 * - article
 * - form
 * - dialog
 * - navigation
 * - heading (nearest preceding heading)
 * - named container
 */

const assert = require("assert");

// Import extraction functions from content.js
const { computeSemanticContext } = require("./content.js");

// Minimal Mock DOM for context testing
class MockElement {
  constructor(tagName = "div", attrs = {}, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.textContent = textContent;
    this.id = attrs.id || "";
    this.name = attrs.name || "";
    this.children = [];
    this.parentElement = null;
    this.previousElementSibling = null;
    this.nextElementSibling = null;
    this.ownerDocument = null;
  }

  getAttribute(name) {
    return this.attrs[name] !== undefined ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return this.attrs[name] !== undefined;
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

  querySelector(selector) {
    const targetTags = selector.split(",").map((s) => s.trim().toUpperCase());
    function search(node) {
      for (const c of node.children) {
        if (targetTags.includes(c.tagName) || (c.getAttribute("role") && targetTags.includes(`[ROLE='${c.getAttribute("role").toUpperCase()}']`))) {
          return c;
        }
        const found = search(c);
        if (found) return found;
      }
      return null;
    }
    return search(this);
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement("body");
    this.body.ownerDocument = this;
  }
  createElement(tag, attrs = {}, text = "") {
    const el = new MockElement(tag, attrs, text);
    el.ownerDocument = this;
    return el;
  }
}

const doc = new MockDocument();

console.log("==================================================================");
console.log("     V.I.S.T.A. — Semantic Parent / Context Test Suite            ");
console.log("==================================================================\n");

// -------------------------------------------------------------
// Test 1: User Example - <section><h2>Payment</h2><button>Continue</button></section>
// -------------------------------------------------------------
{
  console.log("Test 1: Section with Heading (User Example)");
  const section = doc.createElement("section");
  const heading = doc.createElement("h2", {}, "Payment");
  const button = doc.createElement("button", {}, "Continue");

  doc.body.appendChild(section);
  section.appendChild(heading);
  section.appendChild(button);

  const context = computeSemanticContext(button);
  console.log("  Input:    <section><h2>Payment</h2><button>Continue</button></section>");
  console.log("  Context: ", JSON.stringify(context));

  assert.deepStrictEqual(context, { section: "Payment" }, "Test 1 failed");
  console.log("  Result:   ✅ PASS (Distinguishes 'Continue under Payment')\n");
}

// -------------------------------------------------------------
// Test 2: User Goal - Distinguish "Continue under Footer"
// -------------------------------------------------------------
{
  console.log("Test 2: Footer Landmark (User Goal)");
  const footer = doc.createElement("footer");
  const button = doc.createElement("button", {}, "Continue");

  doc.body.appendChild(footer);
  footer.appendChild(button);

  const context = computeSemanticContext(button);
  console.log("  Input:    <footer><button>Continue</button></footer>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.section, "Footer", "Test 2 failed");
  console.log("  Result:   ✅ PASS (Distinguishes 'Continue under Footer')\n");
}

// -------------------------------------------------------------
// Test 3: Form Container
// -------------------------------------------------------------
{
  console.log("Test 3: Form Container (e.g. checkout-form)");
  const form = doc.createElement("form", { id: "checkout-form" });
  const input = doc.createElement("input", { type: "text" });

  doc.body.appendChild(form);
  form.appendChild(input);

  const context = computeSemanticContext(input);
  console.log("  Input:    <form id=\"checkout-form\"><input></form>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.form, "checkout-form");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 4: Dialog Container
// -------------------------------------------------------------
{
  console.log("Test 4: Dialog Container");
  const dialog = doc.createElement("dialog", { "aria-label": "Delete Confirmation" });
  const btn = doc.createElement("button", {}, "Confirm");

  doc.body.appendChild(dialog);
  dialog.appendChild(btn);

  const context = computeSemanticContext(btn);
  console.log("  Input:    <dialog aria-label=\"Delete Confirmation\"><button>Confirm</button></dialog>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.dialog, "Delete Confirmation");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 5: Navigation Landmark
// -------------------------------------------------------------
{
  console.log("Test 5: Navigation Landmark");
  const nav = doc.createElement("nav", { "aria-label": "Main Menu" });
  const link = doc.createElement("a", { href: "/home" }, "Home");

  doc.body.appendChild(nav);
  nav.appendChild(link);

  const context = computeSemanticContext(link);
  console.log("  Input:    <nav aria-label=\"Main Menu\"><a href=\"/home\">Home</a></nav>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.navigation, "Main Menu");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 6: Fieldset with Legend
// -------------------------------------------------------------
{
  console.log("Test 6: Fieldset with Legend");
  const fieldset = doc.createElement("fieldset");
  const legend = doc.createElement("legend", {}, "Shipping Address");
  const input = doc.createElement("input", { type: "text" });

  doc.body.appendChild(fieldset);
  fieldset.appendChild(legend);
  fieldset.appendChild(input);

  const context = computeSemanticContext(input);
  console.log("  Input:    <fieldset><legend>Shipping Address</legend><input></fieldset>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.section, "Shipping Address");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 7: Preceding Heading in Flow (No Section Tag)
// -------------------------------------------------------------
{
  console.log("Test 7: Closest Preceding Heading in Flow");
  const container = doc.createElement("div");
  const heading = doc.createElement("h3", {}, "Order Summary");
  const btn = doc.createElement("button", {}, "View Items");

  doc.body.appendChild(container);
  container.appendChild(heading);
  container.appendChild(btn);

  const context = computeSemanticContext(btn);
  console.log("  Input:    <div><h3>Order Summary</h3><button>View Items</button></div>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.heading, "Order Summary");
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 8: Nested Context (Form inside Section)
// -------------------------------------------------------------
{
  console.log("Test 8: Nested Context (Form inside Section)");
  const section = doc.createElement("section");
  const heading = doc.createElement("h2", {}, "Account Setup");
  const form = doc.createElement("form", { id: "profile-form" });
  const btn = doc.createElement("button", {}, "Save");

  doc.body.appendChild(section);
  section.appendChild(heading);
  section.appendChild(form);
  form.appendChild(btn);

  const context = computeSemanticContext(btn);
  console.log("  Input:    <section><h2>Account Setup</h2><form id=\"profile-form\"><button>Save</button></form></section>");
  console.log("  Context: ", JSON.stringify(context));

  assert.strictEqual(context.section, "Account Setup");
  assert.strictEqual(context.form, "profile-form");
  console.log("  Result:   ✅ PASS (Nested landmarks both captured)\n");
}

// -------------------------------------------------------------
// Test 9: Standalone Top-Level Element (No Context)
// -------------------------------------------------------------
{
  console.log("Test 9: Standalone Element (Empty Context)");
  const freshDoc = new MockDocument();
  const btn = freshDoc.createElement("button", {}, "Standalone");
  freshDoc.body.appendChild(btn);

  const context = computeSemanticContext(btn);
  console.log("  Context: ", JSON.stringify(context));

  assert.deepStrictEqual(context, {});
  console.log("  Result:   ✅ PASS (Compact empty object)\n");
}

console.log("==================================================================");
console.log("  🎉 All Semantic Context extraction tests passed cleanly!        ");
console.log("==================================================================");
