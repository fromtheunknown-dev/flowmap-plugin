/**
 * DOM snapshot capture — the editable counterpart to the PNG.
 *
 * A screenshot throws away everything the browser already knows. At the moment
 * `Page.captureScreenshot` runs, the layout engine is holding an absolute box,
 * a full set of resolved styles and a parent chain for every element on the
 * page; flattening to pixels discards all of it. `DOMSnapshot.captureSnapshot`
 * hands that same state over in one call, and it costs *less* than the PNG:
 * measured against the deployed site, the gzipped scene graph is 7-47x smaller
 * than the screenshot of the same route.
 *
 * This module owns the CDP coupling. Everything downstream sees the normalised
 * `SceneGraph` below and never has to know how Chrome shapes its snapshot.
 */

/**
 * The design-relevant slice of the ~340 computed properties.
 *
 * The whitelist is the single biggest lever on payload size, so it holds only
 * what a property panel, a layers tree or the renderer actually reads. Order is
 * significant: CDP returns `styles` arrays parallel to this list, and the
 * normalised output keeps that convention.
 */
export const DESIGN_PROPS = [
  "display","position","top","right","bottom","left","z-index","float","clear",
  "width","height","min-width","min-height","max-width","max-height",
  "margin-top","margin-right","margin-bottom","margin-left",
  "padding-top","padding-right","padding-bottom","padding-left",
  "flex-direction","flex-wrap","flex-grow","flex-shrink","flex-basis",
  "justify-content","align-items","align-self","align-content","gap",
  "grid-template-columns","grid-template-rows","grid-column","grid-row",
  "font-family","font-size","font-weight","font-style","line-height",
  "letter-spacing","text-align","text-decoration-line","text-decoration-color",
  "text-transform","white-space","overflow-wrap","color","opacity",
  "background-color","background-image","background-size","background-position",
  "background-repeat","background-clip","-webkit-background-clip",
  "-webkit-text-fill-color","border-top-width","border-right-width",
  "border-bottom-width","border-left-width","border-top-style",
  "border-right-style","border-bottom-style","border-left-style",
  "border-top-color","border-right-color","border-bottom-color","border-left-color",
  "border-top-left-radius","border-top-right-radius",
  "border-bottom-left-radius","border-bottom-right-radius",
  "box-shadow","text-shadow","overflow-x","overflow-y","transform",
  "transform-origin","filter","backdrop-filter","mix-blend-mode","isolation",
  "visibility","pointer-events","cursor","object-fit","object-position",
  "aspect-ratio","clip-path","mask-image",
];

/** Nothing under these ever paints; walking into them only inflates the graph. */
const DROP_TAGS = new Set([
  "script","style","link","meta","head","title","noscript","template","base",
]);

export const SCENE_VERSION = 1;

/**
 * @typedef {object} SceneGraph
 * @property {number}   v          Format version.
 * @property {string}   url
 * @property {string}   capturedAt ISO 8601.
 * @property {{width:number,height:number,dpr:number}} viewport
 * @property {string[]} props      Property names; `styles` rows are parallel.
 * @property {string[]} strings    Interned string table.
 * @property {object[]} nodes      Flat list; `parent` indexes into this array.
 * @property {string[]} svgs       Captured <svg> markup, in document order.
 */

/**
 * Capture the scene graph for the page currently loaded in `page`.
 *
 * `page` is a puppeteer Page — the same one the screenshot is taken from, so
 * both artefacts describe the same paint and only one navigation is paid for.
 *
 * `fontFaces` comes back alongside the graph rather than inside it. The rules
 * are byte-identical on every route — Pretendard alone ships ~100 of them for
 * its unicode-range subsets — and measured 13.6 KB gzipped, which was 70% of a
 * small route's payload. One copy per snapshot, not one per screen.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {{width:number,height:number,deviceScaleFactor?:number}} viewport
 * @returns {Promise<{scene: SceneGraph, fontFaces: string}>}
 */
export async function captureSceneGraph(page, viewport) {
  const client = await page.createCDPSession();
  try {
    // <svg> children never reach the snapshot — CDP carries no path data — so
    // the markup is collected separately and re-inlined at render time.
    const svgs = await page.evaluate(() =>
      [...document.querySelectorAll("svg")].map((s) => s.outerHTML),
    );

    // Webfonts have to travel with the graph: re-rendering with fallback
    // metrics moves every line box and the capture stops being a record of
    // what the user saw.
    //
    // The document's custom properties travel with them, in the same blob.
    // Captured styles are computed, so `var(--x)` has already resolved to a
    // literal — but carrying the definitions lets an editor write a `var()`
    // reference back and have it keep resolving, which is what turns "picked a
    // token" into a binding rather than a copy.
    const fontFaces = await page.evaluate(() => {
      const out = [];
      const custom = new Map();

      for (const sheet of document.styleSheets) {
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin stylesheet
        }
        for (const rule of rules) {
          if (rule.constructor.name === "CSSFontFaceRule") {
            out.push(rule.cssText);
            continue;
          }
          // Only :root declarations. A custom property scoped to a component
          // means something different inside that component, and hoisting it
          // to the document would change what it resolves to.
          if (rule.constructor.name !== "CSSStyleRule") continue;
          if (rule.selectorText !== ":root" && rule.selectorText !== "html") continue;
          for (const property of rule.style) {
            if (property.startsWith("--")) {
              custom.set(property, rule.style.getPropertyValue(property).trim());
            }
          }
        }
      }

      if (custom.size > 0) {
        const declarations = [...custom]
          .map(([name, value]) => `  ${name}: ${value};`)
          .join("\n");
        out.push(`:root {\n${declarations}\n}`);
      }
      return out.join("\n");
    });

    await client.send("DOMSnapshot.enable");
    const raw = await client.send("DOMSnapshot.captureSnapshot", {
      computedStyles: DESIGN_PROPS,
      includePaintOrder: true,
      includeDOMRects: true,
    });

    return {
      scene: normalise(raw, { url: page.url(), viewport, svgs }),
      fontFaces,
    };
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * CDP's snapshot → the flat scene graph the rest of Flowmap consumes.
 *
 * The string table survives the trip. It is what keeps the payload small: a
 * page repeats the same font stack and colour hundreds of times, and interning
 * turns each repeat into one integer.
 */
export function normalise(raw, { url, viewport, svgs = [] }) {
  const S = raw.strings;
  const doc = raw.documents[0];
  const N = doc.nodes;
  const L = doc.layout;
  const T = doc.textBoxes;

  const layoutOf = new Map();
  L.nodeIndex.forEach((nodeIdx, layoutIdx) => layoutOf.set(nodeIdx, layoutIdx));

  // One entry per laid-out line, keyed by the text node's layout index.
  const linesOf = new Map();
  (T.layoutIndex ?? []).forEach((layoutIdx, i) => {
    if (!linesOf.has(layoutIdx)) linesOf.set(layoutIdx, []);
    linesOf.get(layoutIdx).push([...T.bounds[i], T.start[i], T.length[i]]);
  });

  const paintOrder = new Map();
  (L.paintOrders ?? []).forEach((order, layoutIdx) => paintOrder.set(layoutIdx, order));

  const str = (i) => (i === undefined || i === -1 ? null : S[i]);

  const attrsOf = (nodeIdx) => {
    const flat = N.attributes[nodeIdx] ?? [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[str(flat[i])] = str(flat[i + 1]);
    return out;
  };

  // Re-intern into a table holding only the strings that survive the filter.
  const strings = [];
  const seen = new Map();
  const intern = (value) => {
    if (value === null || value === undefined) return -1;
    let i = seen.get(value);
    if (i === undefined) {
      i = strings.length;
      strings.push(value);
      seen.set(value, i);
    }
    return i;
  };

  const children = new Map();
  N.parentIndex.forEach((parent, nodeIdx) => {
    if (parent < 0) return;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(nodeIdx);
  });

  const nodes = [];
  const emitted = new Map(); // CDP node index -> our node index

  function walk(cdpIdx, parentOut) {
    const rawName = str(N.nodeName[cdpIdx]);
    const tag = rawName ? rawName.toLowerCase() : "";
    if (DROP_TAGS.has(tag)) return;

    const type = N.nodeType[cdpIdx];
    const layoutIdx = layoutOf.get(cdpIdx);

    // Elements with no box (display:none, or outside the layout tree) may still
    // contain laid-out descendants, so the walk continues through them with the
    // same parent rather than pruning the subtree.
    if (type !== 1 && type !== 3) return;
    if (layoutIdx === undefined) {
      (children.get(cdpIdx) ?? []).forEach((k) => walk(k, parentOut));
      return;
    }

    const isText = type === 3;
    const bounds = L.bounds[layoutIdx];
    const styleRow = L.styles[layoutIdx];
    const attrs = isText ? {} : attrsOf(cdpIdx);

    const node = {
      p: parentOut,
      tag: isText ? -1 : intern(tag),
      b: bounds ? bounds.map((v) => Math.round(v * 100) / 100) : null,
      s: styleRow?.length ? styleRow.map((i) => intern(str(i))) : null,
    };

    if (!isText) {
      if (attrs.class) node.cls = intern(attrs.class);
      if (attrs.id) node.eid = intern(attrs.id);
      if (attrs.alt) node.alt = intern(attrs.alt);
      const pseudo = str(N.pseudoType?.[cdpIdx]);
      if (pseudo) node.pseudo = intern(pseudo);
      if (tag === "img") {
        node.src = intern(str(N.currentSourceURL?.[cdpIdx]) ?? attrs.src ?? "");
      }
      if (N.isClickable?.index?.includes(cdpIdx)) node.click = 1;
    } else {
      const full = str(L.text[layoutIdx]);
      const lines = linesOf.get(layoutIdx) ?? [];
      // A text node with no laid-out line boxes painted nothing.
      if (!full || lines.length === 0) return;
      node.tx = intern(full);
      node.lines = lines.map((l) => l.map((v) => Math.round(v * 100) / 100));
    }

    const ourIdx = nodes.length;
    nodes.push(node);
    emitted.set(cdpIdx, ourIdx);

    // Paint order decides sibling stacking; document order alone gets it wrong
    // wherever a stacking context reorders things.
    const kids = [...(children.get(cdpIdx) ?? [])].sort((a, b) => {
      const pa = paintOrder.get(layoutOf.get(a)) ?? 0;
      const pb = paintOrder.get(layoutOf.get(b)) ?? 0;
      return pa - pb;
    });
    kids.forEach((k) => walk(k, ourIdx));
  }

  (children.get(0) ?? []).forEach((k) => walk(k, -1));

  return {
    v: SCENE_VERSION,
    url,
    capturedAt: new Date().toISOString(),
    viewport: {
      width: viewport.width,
      height: viewport.height,
      dpr: viewport.deviceScaleFactor ?? 1,
    },
    props: DESIGN_PROPS,
    strings,
    nodes,
    svgs,
  };
}
