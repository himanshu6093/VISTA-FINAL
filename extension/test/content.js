/**
 * V.I.S.T.A. — Visual Interface Sanitizer & Task Automator
 * Semantic DOM Formatter — Version 2.2
 * 
 * content.js
 * 
 * Injected into the active web page.
 * Extracts meaningful, agent-actionable elements from the DOM,
 * captures browser interaction states (visible, enabled, disabled, checked, selected, focused, interactive),
 * extracts privacy-preserving input states (type, value_present) without EVER exposing actual values,
 * maintains an internal ID -> DOM Element mapping on window.__VISTA_DOM_MAP__,
 * and outputs the Semantic DOM JSON to the console.
 */

// Global registry mapping Agent ID -> DOM Element for subsequent automation actions
if (typeof window !== "undefined") {
  window.__VISTA_DOM_MAP__ = window.__VISTA_DOM_MAP__ || new Map();
  window.__VISTA_VERSION__ = "2.2.0";
}

/**
 * Helper to extract clean text from a <label>, excluding nested input controls.
 */
function getCleanLabelText(labelEl, targetInput) {
  if (!labelEl) return "";
  try {
    if (targetInput && labelEl.contains && labelEl.contains(targetInput) && labelEl.cloneNode) {
      const clone = labelEl.cloneNode(true);
      const inputs = clone.querySelectorAll ? clone.querySelectorAll("input, textarea, select, button") : [];
      if (inputs && inputs.forEach) {
        inputs.forEach((inp) => {
          if (inp.remove) inp.remove();
        });
      }
      return (clone.textContent || "").trim().replace(/\s+/g, " ");
    }
    return (labelEl.textContent || "").trim().replace(/\s+/g, " ");
  } catch (e) {
    return (labelEl.textContent || "").trim().replace(/\s+/g, " ");
  }
}

/**
 * Determine the best semantic / accessible name for an element
 * using the designated priority order:
 * 
 * 1. aria-label
 * 2. aria-labelledby
 * 3. associated label element
 * 4. accessible name (native control specific name / value)
 * 5. meaningful visible text (buttons, links, headings, etc.)
 * 6. placeholder
 * 7. alt text
 * 8. title
 * 
 * @param {Element} el - DOM element to inspect
 * @param {Object} [options] - Options
 * @param {boolean} [options.includeSource=false] - Whether to return { name, source }
 * @returns {string | { name: string, source: string }}
 */
function getAccessibleName(el, options = {}) {
  const includeSource = !!options.includeSource;
  if (!el) {
    return includeSource ? { name: "", source: "none" } : "";
  }

  const tagName = (el.tagName || "").toLowerCase();

  // 1. Priority 1: aria-label
  try {
    const ariaLabel = el.getAttribute ? el.getAttribute("aria-label") : null;
    if (ariaLabel && typeof ariaLabel === "string") {
      const clean = ariaLabel.trim().replace(/\s+/g, " ");
      if (clean) {
        return includeSource ? { name: clean, source: "aria-label" } : clean;
      }
    }
  } catch (e) {}

  // 2. Priority 2: aria-labelledby
  try {
    const labelledBy = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
    if (labelledBy && typeof labelledBy === "string" && labelledBy.trim()) {
      const ids = labelledBy.trim().split(/\s+/);
      const parts = [];
      const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (doc) {
        for (const id of ids) {
          if (!id) continue;
          try {
            const target = doc.getElementById ? doc.getElementById(id) : null;
            if (target && target.textContent) {
              const t = target.textContent.trim().replace(/\s+/g, " ");
              if (t) parts.push(t);
            }
          } catch (err) {}
        }
      }
      if (parts.length > 0) {
        const clean = parts.join(" ");
        return includeSource ? { name: clean, source: "aria-labelledby" } : clean;
      }
    }
  } catch (e) {}

  // 3. Priority 3: associated label element
  if (["input", "textarea", "select", "button", "progress", "meter"].includes(tagName)) {
    try {
      const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);

      // 3a. Label via `for` attribute
      if (el.id && doc) {
        try {
          const label = doc.querySelector ? doc.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
          if (label) {
            const labelText = getCleanLabelText(label, el);
            if (labelText) {
              return includeSource ? { name: labelText, source: "associated-label" } : labelText;
            }
          }
        } catch (cssErr) {}
      }

      // 3b. Enclosing parent <label>
      const parentLabel = el.closest ? el.closest("label") : null;
      if (parentLabel) {
        const labelText = getCleanLabelText(parentLabel, el);
        if (labelText) {
          return includeSource ? { name: labelText, source: "associated-label" } : labelText;
        }
      }
    } catch (e) {}
  }

  // 4. Priority 4: accessible name / native control specific name
  try {
    if (tagName === "input" && ["button", "submit", "reset"].includes((el.type || "").toLowerCase())) {
      if (el.value && typeof el.value === "string" && el.value.trim()) {
        const clean = el.value.trim().replace(/\s+/g, " ");
        return includeSource ? { name: clean, source: "accessible-name" } : clean;
      }
    }
    if (tagName === "option") {
      const optLabel = el.getAttribute ? el.getAttribute("label") : null;
      if (optLabel && typeof optLabel === "string" && optLabel.trim()) {
        const clean = optLabel.trim().replace(/\s+/g, " ");
        return includeSource ? { name: clean, source: "accessible-name" } : clean;
      }
    }
  } catch (e) {}

  // 5. Priority 5: meaningful visible text
  // Restricted to elements where visible text conveys its semantic name (never generic containers)
  const role = el.getAttribute ? el.getAttribute("role") : null;
  const isSemanticTextHost =
    ["button", "a", "h1", "h2", "h3", "h4", "h5", "h6", "option", "summary", "legend"].includes(tagName) ||
    (role && ["button", "link", "tab", "menuitem", "heading"].includes(role.toLowerCase()));

  if (isSemanticTextHost) {
    try {
      const rawText = el.textContent || "";
      const clean = rawText.trim().replace(/\s+/g, " ").slice(0, 200);
      if (clean) {
        return includeSource ? { name: clean, source: "visible-text" } : clean;
      }
    } catch (e) {}
  }

  // 6. Priority 6: placeholder
  if (["input", "textarea"].includes(tagName)) {
    try {
      const placeholder = el.getAttribute ? el.getAttribute("placeholder") : null;
      if (placeholder && typeof placeholder === "string" && placeholder.trim()) {
        const clean = placeholder.trim().replace(/\s+/g, " ");
        return includeSource ? { name: clean, source: "placeholder" } : clean;
      }
    } catch (e) {}
  }

  // 7. Priority 7: alt text
  if (tagName === "img" || tagName === "area" || (tagName === "input" && (el.type || "").toLowerCase() === "image")) {
    try {
      const alt = el.getAttribute ? el.getAttribute("alt") : null;
      if (alt !== null && typeof alt === "string" && alt.trim()) {
        const clean = alt.trim().replace(/\s+/g, " ");
        return includeSource ? { name: clean, source: "alt" } : clean;
      }
    } catch (e) {}
  }

  // 8. Priority 8: title attribute
  try {
    const title = el.getAttribute ? el.getAttribute("title") : null;
    if (title && typeof title === "string" && title.trim()) {
      const clean = title.trim().replace(/\s+/g, " ");
      return includeSource ? { name: clean, source: "title" } : clean;
    }
  } catch (e) {}

  // No useful name found
  return includeSource ? { name: "", source: "none" } : "";
}

/**
 * Expose getAccessibleName on window for external / testing access
 */
if (typeof window !== "undefined") {
  window.getAccessibleName = getAccessibleName;
}

/**
 * Determine the semantic / ARIA role of the element.
 */
function computeSemanticRole(el) {
  try {
    const explicitRole = el.getAttribute ? el.getAttribute("role") : null;
    if (explicitRole && typeof explicitRole === "string" && explicitRole.trim()) {
      return explicitRole.trim().toLowerCase().split(/\s+/)[0];
    }
  } catch (e) {}

  const tag = (el.tagName || "").toLowerCase();

  switch (tag) {
    case "button":
      return "button";

    case "a":
      return el.hasAttribute && el.hasAttribute("href") ? "link" : "generic";

    case "input": {
      const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "text").toLowerCase();
      switch (type) {
        case "checkbox":
          return "checkbox";
        case "radio":
          return "radio";
        case "button":
        case "submit":
        case "reset":
        case "image":
          return "button";
        case "search":
          return "searchbox";
        case "range":
          return "slider";
        case "number":
          return "spinbutton";
        case "hidden":
          return "none";
        default:
          return "textbox";
      }
    }

    case "textarea":
      return "textbox";

    case "select":
      return el.multiple ? "listbox" : "combobox";

    case "option":
      return "option";

    case "img":
      return "img";

    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";

    case "form":
      return "form";

    case "nav":
      return "navigation";

    case "dialog":
      return "dialog";

    default:
      return tag || "generic";
  }
}

/**
 * Extract human-useful text from the element without exposing sensitive user inputs.
 * PRIVACY: Never returns user-typed input values.
 */
function computeElementText(el, tag, role) {
  try {
    if (tag === "input") {
      const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "text").toLowerCase();
      // Button-like input controls expose button label, not sensitive user data
      if (["button", "submit", "reset"].includes(type)) {
        return el.value || "";
      }
      // PRIVACY REQUIREMENT: Do NOT expose typed input values (passwords, emails, texts)
      return "";
    }

    if (tag === "textarea") {
      // PRIVACY REQUIREMENT: Do NOT expose user textarea content
      return "";
    }

    if (tag === "select") {
      const selectedOption = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      return selectedOption && selectedOption.text ? selectedOption.text.trim() : "";
    }

    if (["button", "a", "option", "h1", "h2", "h3", "h4", "h5", "h6", "dialog"].includes(tag) || role === "button") {
      const rawText = el.textContent || "";
      return rawText.trim().replace(/\s+/g, " ").slice(0, 300);
    }
  } catch (e) {}

  return "";
}

/**
 * Check if the element is visible in the page.
 */
function computeVisibility(el, tag, bbox) {
  try {
    if (tag === "input") {
      const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "").toLowerCase();
      if (type === "hidden") return false;
    }

    if (tag === "option") {
      const select = el.closest ? el.closest("select") : null;
      if (!select) return false;
      const sRect = select.getBoundingClientRect ? select.getBoundingClientRect() : { width: 1, height: 1 };
      return computeVisibility(select, "select", {
        x: Math.round(sRect.x ?? sRect.left ?? 0),
        y: Math.round(sRect.y ?? sRect.top ?? 0),
        width: Math.round(sRect.width ?? 0),
        height: Math.round(sRect.height ?? 0)
      });
    }

    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return false;
    }

    if (typeof window !== "undefined" && window.getComputedStyle) {
      const style = window.getComputedStyle(el);
      if (!style) return false;

      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        parseFloat(style.opacity || "1") === 0
      ) {
        return false;
      }

      if (el.offsetParent === null && style.position !== "fixed" && tag !== "dialog" && tag !== "body") {
        return false;
      }
    }

    return true;
  } catch (e) {
    return !!(bbox && bbox.width > 0 && bbox.height > 0);
  }
}

/**
 * Check if the element is enabled.
 */
function computeEnabled(el) {
  try {
    if (typeof el.disabled === "boolean" && el.disabled) {
      return false;
    }
    if (el.getAttribute && el.getAttribute("aria-disabled") === "true") {
      return false;
    }
    if (el.closest && el.closest("fieldset[disabled]")) {
      return false;
    }
  } catch (e) {}
  return true;
}

/**
 * Check if the element is checked (checkboxes, radio buttons, aria-checked).
 */
function computeChecked(el, tag) {
  try {
    if (tag === "input") {
      const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "").toLowerCase();
      if (["checkbox", "radio"].includes(type)) {
        return Boolean(el.checked);
      }
    }
    if (el.getAttribute) {
      const ariaChecked = el.getAttribute("aria-checked");
      if (ariaChecked !== null) {
        return ariaChecked === "true";
      }
    }
  } catch (e) {}
  return false;
}

/**
 * Check if the element is selected (<option>, aria-selected).
 */
function computeSelected(el, tag) {
  try {
    if (tag === "option") {
      return Boolean(el.selected);
    }
    if (el.getAttribute) {
      const ariaSelected = el.getAttribute("aria-selected");
      if (ariaSelected !== null) {
        return ariaSelected === "true";
      }
    }
  } catch (e) {}
  return false;
}

/**
 * Check if the element is currently focused.
 */
/**
 * Extract human-useful label for a container or landmark element.
 */
function getContainerLabel(containerEl, tag) {
  if (!containerEl) return "";

  try {
    // 1. Explicit aria-label
    if (containerEl.getAttribute) {
      const ariaLabel = containerEl.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim().replace(/\s+/g, " ").slice(0, 60);
      }

      // 2. aria-labelledby
      const labelledBy = containerEl.getAttribute("aria-labelledby");
      if (labelledBy && labelledBy.trim()) {
        const doc = containerEl.ownerDocument || (typeof document !== "undefined" ? document : null);
        if (doc && doc.getElementById) {
          const target = doc.getElementById(labelledBy.trim().split(/\s+/)[0]);
          if (target && target.textContent) {
            const t = target.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
            if (t) return t;
          }
        }
      }
    }

    // 3. Fieldset legend
    if (tag === "fieldset") {
      const legend = containerEl.querySelector ? containerEl.querySelector("legend") : null;
      if (legend && legend.textContent) {
        const t = legend.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
        if (t) return t;
      }
    }

    // 4. Heading inside container (e.g. <section><h2>Payment</h2>...</section>)
    if (["section", "article", "dialog", "aside", "nav", "form", "main"].includes(tag) || 
        (containerEl.getAttribute && ["region", "dialog", "form", "tabpanel"].includes(containerEl.getAttribute("role")))) {
      const heading = containerEl.querySelector ? containerEl.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']") : null;
      if (heading && heading.textContent) {
        const t = heading.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
        if (t) return t;
      }
    }

    // 5. Name or ID attribute
    if (containerEl.getAttribute) {
      const name = containerEl.getAttribute("name");
      if (name && typeof name === "string" && name.trim()) {
        return name.trim().slice(0, 50);
      }

      const id = containerEl.id;
      if (id && typeof id === "string" && id.trim()) {
        return id.trim().slice(0, 50);
      }

      const title = containerEl.getAttribute("title");
      if (title && typeof title === "string" && title.trim()) {
        return title.trim().slice(0, 50);
      }
    }

    // 6. Natural tag fallbacks for landmark tags
    if (tag === "footer") return "Footer";
    if (tag === "header") return "Header";
    if (tag === "nav") return "Navigation";
    if (tag === "main") return "Main";
  } catch (e) {}

  return "";
}

/**
 * Find closest preceding heading in document flow when not enclosed in a named section.
 */
function findClosestPrecedingHeading(el) {
  try {
    let curr = el;
    const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
    const root = doc ? doc.body : null;

    while (curr && curr !== root) {
      let prev = curr.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/i.test(prev.tagName) || (prev.getAttribute && prev.getAttribute("role") === "heading")) {
          const t = (prev.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
          if (t) return t;
        }
        if (prev.querySelector) {
          const h = prev.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
          if (h && h.textContent) {
            const t = h.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
            if (t) return t;
          }
        }
        prev = prev.previousElementSibling;
      }
      curr = curr.parentElement;
    }
  } catch (e) {}
  return null;
}

/**
 * Extract compact semantic parent/context (section, article, form, dialog, navigation, heading).
 * Does NOT serialize the entire ancestor DOM tree.
 * 
 * @param {Element} el - DOM element
 * @returns {Object} context object (e.g. { section: "Payment" })
 */
function computeSemanticContext(el) {
  const context = {};
  if (!el || !el.parentElement) return context;

  try {
    let curr = el.parentElement;
    let depth = 0;
    const maxDepth = 15;

    while (curr && curr.tagName && depth < maxDepth) {
      const tag = (curr.tagName || "").toLowerCase();
      const role = curr.getAttribute ? (curr.getAttribute("role") || "").toLowerCase() : "";

      if (tag === "body" || tag === "html") break;

      // 1. Dialog context
      if ((tag === "dialog" || role === "dialog" || role === "alertdialog") && !context.dialog) {
        const label = getContainerLabel(curr, "dialog") || "Dialog";
        context.dialog = label;
      }

      // 2. Form context
      else if ((tag === "form" || role === "form") && !context.form) {
        const label = getContainerLabel(curr, "form") || "Form";
        context.form = label;
      }

      // 3. Navigation context
      else if ((tag === "nav" || role === "navigation") && !context.navigation) {
        const label = getContainerLabel(curr, "nav") || "Navigation";
        context.navigation = label;
      }

      // 4. Section / Landmark context
      else if (["section", "article", "fieldset", "aside", "main", "footer", "header"].includes(tag) || 
               ["region", "tabpanel", "article"].includes(role)) {
        const key = (tag === "article" || role === "article") ? "article" : "section";
        if (!context[key]) {
          const label = getContainerLabel(curr, tag);
          if (label) {
            context[key] = label;
          } else if (tag === "footer") {
            context[key] = "Footer";
          } else if (tag === "header") {
            context[key] = "Header";
          }
        }
      }

      // 5. Explicitly named container (e.g. <div aria-label="Cart Summary">)
      else if (curr.getAttribute && (curr.getAttribute("aria-label") || curr.getAttribute("aria-labelledby")) && !context.container) {
        const label = getContainerLabel(curr, tag);
        if (label && !context.section && !context.form && !context.dialog) {
          context.container = label;
        }
      }

      curr = curr.parentElement;
      depth++;
    }

    // If no container/landmark context was detected, find nearest preceding heading
    if (Object.keys(context).length === 0) {
      const heading = findClosestPrecedingHeading(el);
      if (heading) {
        context.heading = heading;
      }
    }
  } catch (err) {}

  return context;
}

/**
 * Check if the element is currently focused.
 */
function computeFocused(el) {
  try {
    const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
    return Boolean(doc && doc.activeElement === el);
  } catch (e) {}
  return false;
}

/**
 * Determine if the element is interactive and actionable by an agent.
 */
function computeInteractivity(el, tag, role, enabled) {
  try {
    if (tag === "img" && !(el.hasAttribute && el.hasAttribute("onclick")) && role === "img") {
      return false;
    }
    if (["h1", "h2", "h3", "h4", "h5", "h6", "nav", "form"].includes(tag) && !(el.hasAttribute && el.hasAttribute("role"))) {
      return false;
    }

    if (["button", "select", "option", "textarea"].includes(tag)) {
      return enabled;
    }

    if (tag === "input") {
      const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "text").toLowerCase();
      return type !== "hidden" && enabled;
    }

    if (tag === "a") {
      return !!(el.hasAttribute && el.hasAttribute("href"));
    }

    const interactiveRoles = new Set([
      "button",
      "link",
      "checkbox",
      "radio",
      "combobox",
      "listbox",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "tab",
      "switch",
      "textbox",
      "searchbox",
      "slider",
      "spinbutton",
      "treeitem"
    ]);

    if (interactiveRoles.has(role)) {
      return enabled;
    }

    if (el.isContentEditable) {
      return true;
    }

    if (el.getAttribute) {
      const tabIndex = el.getAttribute("tabindex");
      if (tabIndex !== null && parseInt(tabIndex, 10) >= 0) {
        return true;
      }
    }

    if (el.hasAttribute && el.hasAttribute("onclick")) {
      return true;
    }
  } catch (e) {}

  return false;
}

/**
 * Check if element is an irrelevant tracking or beacon element.
 */
function isTrackingElement(el, tag) {
  try {
    if (tag === "img") {
      const src = (el.getAttribute ? el.getAttribute("src") : "") || "";
      const width = el.getAttribute ? el.getAttribute("width") : null;
      const height = el.getAttribute ? el.getAttribute("height") : null;
      // 1x1 or 0x0 tracking pixel
      if ((width === "1" || width === "0") && (height === "1" || height === "0")) {
        return true;
      }
      if (/pixel|telemetry|analytics|beacon|track|collect/i.test(src) && !el.getAttribute("alt")) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/**
 * Check if element is an irrelevant decorative element.
 */
function isDecorativeElement(el, tag, role) {
  try {
    if (role === "presentation" || role === "none") {
      // Check if it has an explicit click handler; if not, decorative
      if (el.hasAttribute && el.hasAttribute("onclick")) return false;
      return true;
    }
    const ariaHidden = el.getAttribute ? el.getAttribute("aria-hidden") : null;
    if (ariaHidden === "true") {
      // If marked aria-hidden and has no user-interaction handler or href, discard
      if (!el.hasAttribute || (!el.hasAttribute("onclick") && !el.hasAttribute("href"))) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/**
 * V.I.S.T.A. DOM Reduction Pipeline:
 * RAW DOM -> candidate elements -> meaningful semantic elements -> compact Semantic DOM
 * 
 * Excludes:
 * - script, style, meta, comments, tracking elements
 * - hidden / zero-dimension elements
 * - irrelevant decorative elements
 * - meaningless nested div/span nodes
 * - React/framework internal attributes
 * - huge SVG path data
 * 
 * Preserves elements necessary for:
 * - browser interaction
 * - semantic understanding
 * - task grounding
 * - spatial reasoning
 * 
 * @returns {{ elements: Array<Object>, stats: Object }}
 */
function extractSemanticDOM() {
  const startTime = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

  // -------------------------------------------------------------
  // Stage 1: Measure RAW DOM element count
  // -------------------------------------------------------------
  const doc = typeof document !== "undefined" ? document : null;
  const rawElements = (doc && doc.querySelectorAll) ? doc.querySelectorAll("*") : [];
  const rawCount = rawElements.length;

  // -------------------------------------------------------------
  // Stage 2: Candidate elements selection
  // -------------------------------------------------------------
  const selector = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "option",
    "img",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "form",
    "nav",
    "dialog",
    "main",
    "section",
    "article",
    "fieldset",
    "summary",
    "[role]",
    "[tabindex]"
  ].join(", ");

  const candidates = (doc && doc.querySelectorAll) ? Array.from(doc.querySelectorAll(selector)) : [];
  const semanticElements = [];

  // Reset internal mapping for this snapshot
  if (typeof window !== "undefined" && window.__VISTA_DOM_MAP__) {
    window.__VISTA_DOM_MAP__.clear();
  }

  let counter = 1;

  for (const el of candidates) {
    try {
      const tag = (el.tagName || "").toLowerCase();

      // 1. Exclude non-renderable/meta tags & SVG sub-paths
      if ([
        "script", "style", "noscript", "template", "meta", "link", "param", "source", "track",
        "head", "title", "path", "g", "defs", "clippath", "circle", "rect", "line", "polyline",
        "polygon", "use", "symbol"
      ].includes(tag)) {
        continue;
      }

      // 2. Exclude hidden inputs
      if (tag === "input") {
        const type = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "").toLowerCase();
        if (type === "hidden") continue;
      }

      // 3. Exclude tracking / beacon pixels
      if (isTrackingElement(el, tag)) {
        continue;
      }

      const role = computeSemanticRole(el);

      // 4. Exclude decorative elements
      if (isDecorativeElement(el, tag, role)) {
        continue;
      }

      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
      const bbox = {
        x: Math.round(rect.x ?? rect.left ?? 0),
        y: Math.round(rect.y ?? rect.top ?? 0),
        width: Math.round(rect.width ?? 0),
        height: Math.round(rect.height ?? 0)
      };

      // 5. Visibility filter: Exclude hidden / zero-dimension elements (spatial reasoning)
      const visible = computeVisibility(el, tag, bbox);
      if (!visible && tag !== "option") {
        continue; // Discard non-visible elements from the compact Semantic DOM
      }

      const enabled = computeEnabled(el);
      const interactive = computeInteractivity(el, tag, role, enabled);
      const nameDetails = getAccessibleName(el, { includeSource: true });
      const text = computeElementText(el, tag, role);

      // 6. Meaningful Semantic Element filter:
      // Exclude meaningless nested div/span nodes without name, text, or interactive role
      if (!interactive && !nameDetails.name && !text && ["div", "span", "section", "article", "fieldset"].includes(tag) && (!role || role === "generic")) {
        continue;
      }

      // -------------------------------------------------------------
      // Stage 3 & 4: Compact Semantic DOM object generation
      // Framework internal attributes (React, Angular, Vue) and SVG paths are NOT serialized
      // -------------------------------------------------------------
      const agentId = `e${counter}`;
      const semanticObject = {
        id: agentId,
        tag: tag,
        role: role,
        name: nameDetails.name,
        nameSource: nameDetails.source,
        text: text,
        context: computeSemanticContext(el),
        visible: visible,
        enabled: enabled,
        disabled: !enabled,
        checked: computeChecked(el, tag),
        selected: computeSelected(el, tag),
        focused: computeFocused(el),
        interactive: interactive,
        bbox: bbox
      };

      // For inputs (and textareas), capture privacy-preserving type and value_present
      if (tag === "input") {
        const inputType = ((el.getAttribute ? el.getAttribute("type") : null) || el.type || "text").toLowerCase();
        semanticObject.type = inputType;
        semanticObject.value_present = Boolean(el.value && String(el.value).length > 0);
      } else if (tag === "textarea") {
        semanticObject.type = "textarea";
        semanticObject.value_present = Boolean(el.value && String(el.value).length > 0);
      }

      semanticElements.push(semanticObject);

      // Maintain internal agent ID -> DOM element mapping
      if (typeof window !== "undefined" && window.__VISTA_DOM_MAP__) {
        window.__VISTA_DOM_MAP__.set(agentId, el);
      }

      // Tag the actual element in the DOM
      try {
        if (el.setAttribute) {
          el.setAttribute("data-vista-id", agentId);
        }
      } catch (e) {}

      counter++;
    } catch (nodeErr) {
      // Safely skip any single problematic node
    }
  }

  // -------------------------------------------------------------
  // Pipeline Statistics Calculation
  // -------------------------------------------------------------
  const endTime = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const extractionTimeMs = Math.max(1, Math.round(endTime - startTime));
  const semanticCount = semanticElements.length;
  const reductionPctNumber = rawCount > 0 ? ((rawCount - semanticCount) / rawCount) * 100 : 0;
  const reductionPct = `${reductionPctNumber.toFixed(1)}%`;

  const jsonString = JSON.stringify(semanticElements, null, 2);
  const jsonBytes = typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(jsonString).length
    : jsonString.length;

  const jsonSizeFormatted = jsonBytes >= 1024 * 1024
    ? `${(jsonBytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(jsonBytes / 1024).toFixed(1)} KB`;

  const stats = {
    raw_element_count: rawCount,
    semantic_element_count: semanticCount,
    reduction_percentage: reductionPct,
    serialized_json_size: jsonSizeFormatted,
    extraction_time_ms: extractionTimeMs
  };

  // Extension console formatted summary
  console.group(`📊 [V.I.S.T.A.] DOM Reduction Pipeline (${reductionPct} reduction in ${extractionTimeMs}ms)`);
  console.log(`Raw DOM elements:        ${rawCount.toLocaleString().padStart(8)}`);
  console.log(`Semantic elements:       ${semanticCount.toLocaleString().padStart(8)}`);
  console.log(`Reduction:               ${reductionPct.padStart(8)}`);
  console.log(`Semantic JSON size:      ${jsonSizeFormatted.padStart(8)}`);
  console.log(`Extraction time:         ${(extractionTimeMs + " ms").padStart(8)}`);
  console.log("Compact Semantic DOM:", semanticElements);
  if (typeof window !== "undefined") {
    console.log("Agent Map (agentId -> DOM Node):", window.__VISTA_DOM_MAP__);
  }
  console.groupEnd();

  return {
    elements: semanticElements,
    stats: stats
  };
}

// Listen for messages from the popup or background
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Health check ping
    if (request && request.action === "ping") {
      sendResponse({ status: "pong", version: "2.3.0" });
      return true;
    }

    // Extract DOM action
    if (request && request.action === "extract_dom") {
      try {
        const result = extractSemanticDOM();
        const extractedElements = result.elements || [];
        const stats = result.stats || {};

        const interactiveCount = extractedElements.filter((el) => el && el.interactive).length;
        const visibleCount = extractedElements.filter((el) => el && el.visible).length;

        sendResponse({
          success: true,
          data: {
            elements: extractedElements,
            stats: stats,
            totalCount: extractedElements.length,
            interactiveCount: interactiveCount,
            visibleCount: visibleCount,
            pageTitle: document.title || "Untitled Page",
            url: window.location.href
          }
        });
      } catch (error) {
        console.error("[V.I.S.T.A.] Extraction error:", error);
        sendResponse({
          success: false,
          error: error.message || "Failed to extract Semantic DOM."
        });
      }
      return true;
    }

    return true;
  });
}

// Export for automated testing in Node.js environments
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getAccessibleName,
    computeSemanticRole,
    computeElementText,
    computeVisibility,
    computeEnabled,
    computeChecked,
    computeSelected,
    computeFocused,
    computeInteractivity,
    computeSemanticContext,
    extractSemanticDOM
  };
}
