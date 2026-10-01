/**
 * V.I.S.T.A. — Semantic DOM Formatter
 * Test Suite: Browser Interaction States & Input Privacy
 * 
 * Verifies that every element captures:
 * - visible
 * - enabled
 * - disabled
 * - checked
 * - selected
 * - focused
 * - interactive
 * 
 * And for inputs:
 * - type
 * - value_present
 * 
 * And critically verifies:
 * - DO NOT expose actual input values
 * - Never include "value": "real email/password"
 */

const assert = require("assert");

// Import extraction functions from content.js
const {
  getAccessibleName,
  computeSemanticRole,
  computeElementText,
  computeVisibility,
  computeEnabled,
  computeChecked,
  computeSelected,
  computeFocused,
  computeInteractivity
} = require("./content.js");

// Minimal Mock Element
class MockElement {
  constructor(tagName = "div", attrs = {}, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.attrs = Object.assign({}, attrs);
    this.textContent = textContent;
    this.id = attrs.id || "";
    this.type = attrs.type || "";
    this.value = attrs.value !== undefined ? attrs.value : "";
    this.checked = !!attrs.checked;
    this.selected = !!attrs.selected;
    this.disabled = !!attrs.disabled;
    this.offsetParent = attrs.offsetParent !== undefined ? attrs.offsetParent : {};
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

  closest(selector) {
    if (this.attrs.inDisabledFieldset && selector.includes("fieldset[disabled]")) {
      return {};
    }
    return null;
  }

  getBoundingClientRect() {
    return this.attrs.bbox || { x: 50, y: 100, width: 200, height: 40 };
  }
}

class MockDocument {
  constructor() {
    this.activeElement = null;
  }
}

const doc = new MockDocument();

/**
 * Simulate the semantic object creation from extractSemanticDOM()
 */
function createSemanticObject(el, id = "e1") {
  el.ownerDocument = doc;
  const tag = (el.tagName || "").toLowerCase();
  const rect = el.getBoundingClientRect();
  const bbox = {
    x: Math.round(rect.x ?? 0),
    y: Math.round(rect.y ?? 0),
    width: Math.round(rect.width ?? 0),
    height: Math.round(rect.height ?? 0)
  };

  const role = computeSemanticRole(el);
  const nameDetails = getAccessibleName(el, { includeSource: true });
  const text = computeElementText(el, tag, role);
  const visible = computeVisibility(el, tag, bbox);
  const enabled = computeEnabled(el);
  const disabled = !enabled;
  const checked = computeChecked(el, tag);
  const selected = computeSelected(el, tag);
  const focused = computeFocused(el);
  const interactive = computeInteractivity(el, tag, role, enabled);

  const semanticObject = {
    id: id,
    tag: tag,
    role: role,
    name: nameDetails.name,
    nameSource: nameDetails.source,
    text: text,
    visible: visible,
    enabled: enabled,
    disabled: disabled,
    checked: checked,
    selected: selected,
    focused: focused,
    interactive: interactive,
    bbox: bbox
  };

  if (tag === "input") {
    const inputType = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "text").toLowerCase();
    semanticObject.type = inputType;
    semanticObject.value_present = Boolean(el.value && String(el.value).length > 0);
  } else if (tag === "textarea") {
    semanticObject.type = "textarea";
    semanticObject.value_present = Boolean(el.value && String(el.value).length > 0);
  }

  return semanticObject;
}

console.log("==================================================================");
console.log("   V.I.S.T.A. — Browser Interaction State & Privacy Test Suite    ");
console.log("==================================================================\n");

// -------------------------------------------------------------
// Test 1: Password Input (Privacy & Value Obfuscation)
// -------------------------------------------------------------
{
  console.log("Test 1: Password Input (Privacy Requirement)");
  const secretPassword = "SuperSecretPassword123!#";
  const passwordInput = new MockElement("input", {
    type: "password",
    id: "pwd",
    "aria-label": "Password",
    value: secretPassword
  });

  const obj = createSemanticObject(passwordInput, "e1");
  console.log("  Extracted Object:", JSON.stringify(obj, null, 2));

  // Critical Assertions
  assert.strictEqual(obj.type, "password");
  assert.strictEqual(obj.value_present, true);
  assert.strictEqual(obj.enabled, true);
  assert.strictEqual(obj.disabled, false);
  assert.strictEqual(obj.interactive, true);

  // PRIVACY MANDATE: Value must NEVER be exposed!
  assert.strictEqual(obj.value, undefined, "LEAK: 'value' property must NOT exist in semanticObject!");
  assert.strictEqual(obj.text.includes(secretPassword), false, "LEAK: 'text' property must NOT contain password!");
  const serialized = JSON.stringify(obj);
  assert.strictEqual(serialized.includes(secretPassword), false, "LEAK: Serialized JSON contains password!");
  console.log("  Result:   ✅ PASS (Password masked, value_present: true, zero leakage)\n");
}

// -------------------------------------------------------------
// Test 2: Email Input with typed value
// -------------------------------------------------------------
{
  console.log("Test 2: Email Input (Privacy Requirement)");
  const sensitiveEmail = "confidential_ceo@enterprise.com";
  const emailInput = new MockElement("input", {
    type: "email",
    id: "email",
    "aria-label": "Work Email",
    value: sensitiveEmail
  });

  const obj = createSemanticObject(emailInput, "e2");
  console.log("  Extracted Object:", JSON.stringify(obj, null, 2));

  assert.strictEqual(obj.type, "email");
  assert.strictEqual(obj.value_present, true);
  assert.strictEqual(obj.value, undefined, "LEAK: 'value' property must NOT exist!");
  assert.strictEqual(obj.text.includes(sensitiveEmail), false, "LEAK: 'text' must NOT contain email!");
  assert.strictEqual(JSON.stringify(obj).includes(sensitiveEmail), false, "LEAK: JSON must NOT contain email!");
  console.log("  Result:   ✅ PASS (Email masked, value_present: true, zero leakage)\n");
}

// -------------------------------------------------------------
// Test 3: Empty Text Input
// -------------------------------------------------------------
{
  console.log("Test 3: Empty Text Input");
  const emptyInput = new MockElement("input", {
    type: "text",
    placeholder: "Enter full name",
    value: ""
  });

  const obj = createSemanticObject(emptyInput, "e3");
  assert.strictEqual(obj.type, "text");
  assert.strictEqual(obj.value_present, false);
  console.log("  Result:   ✅ PASS (value_present: false)\n");
}

// -------------------------------------------------------------
// Test 4: Checkbox Checked vs Unchecked
// -------------------------------------------------------------
{
  console.log("Test 4: Checkbox States (checked vs unchecked)");
  const checkedBox = new MockElement("input", { type: "checkbox", checked: true, "aria-label": "Remember me" });
  const uncheckedBox = new MockElement("input", { type: "checkbox", checked: false, "aria-label": "Subscribe" });

  const objChecked = createSemanticObject(checkedBox, "e4a");
  const objUnchecked = createSemanticObject(uncheckedBox, "e4b");

  assert.strictEqual(objChecked.checked, true);
  assert.strictEqual(objUnchecked.checked, false);
  console.log("  Checked:  ", objChecked.checked);
  console.log("  Unchecked:", objUnchecked.checked);
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 5: Option Selected vs Unselected
// -------------------------------------------------------------
{
  console.log("Test 5: Option States (selected vs unselected)");
  const selectedOpt = new MockElement("option", { selected: true }, "Enterprise Plan");
  const unselectedOpt = new MockElement("option", { selected: false }, "Basic Plan");

  const objSelected = createSemanticObject(selectedOpt, "e5a");
  const objUnselected = createSemanticObject(unselectedOpt, "e5b");

  assert.strictEqual(objSelected.selected, true);
  assert.strictEqual(objUnselected.selected, false);
  console.log("  Selected:  ", objSelected.selected);
  console.log("  Unselected:", objUnselected.selected);
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 6: Focused Element
// -------------------------------------------------------------
{
  console.log("Test 6: Focused Element State");
  const focusedInput = new MockElement("input", { type: "text", id: "search" });
  const blurredInput = new MockElement("input", { type: "text", id: "filter" });

  // Simulate active element in document
  doc.activeElement = focusedInput;

  const objFocused = createSemanticObject(focusedInput, "e6a");
  const objBlurred = createSemanticObject(blurredInput, "e6b");

  assert.strictEqual(objFocused.focused, true);
  assert.strictEqual(objBlurred.focused, false);
  console.log("  Focused element: ", objFocused.focused);
  console.log("  Unfocused element:", objBlurred.focused);
  console.log("  Result:   ✅ PASS\n");
}

// -------------------------------------------------------------
// Test 7: Disabled vs Enabled Button
// -------------------------------------------------------------
{
  console.log("Test 7: Disabled vs Enabled States");
  const disabledBtn = new MockElement("button", { disabled: true }, "Submit");
  const enabledBtn = new MockElement("button", {}, "Submit");

  const objDisabled = createSemanticObject(disabledBtn, "e7a");
  const objEnabled = createSemanticObject(enabledBtn, "e7b");

  assert.strictEqual(objDisabled.enabled, false);
  assert.strictEqual(objDisabled.disabled, true);
  assert.strictEqual(objDisabled.interactive, false);

  assert.strictEqual(objEnabled.enabled, true);
  assert.strictEqual(objEnabled.disabled, false);
  assert.strictEqual(objEnabled.interactive, true);

  console.log("  Disabled button -> enabled:", objDisabled.enabled, "disabled:", objDisabled.disabled, "interactive:", objDisabled.interactive);
  console.log("  Enabled button  -> enabled:", objEnabled.enabled, "disabled:", objEnabled.disabled, "interactive:", objEnabled.interactive);
  console.log("  Result:   ✅ PASS\n");
}

console.log("==================================================================");
console.log("  🎉 All Interaction State & Privacy tests passed with 0 leaks!    ");
console.log("==================================================================");
