/**
 * Expo Router framework adapter for the Flowmap static analyzer.
 *
 * Expo Router is a file-based router and a structural twin of the Next.js App
 * Router — this adapter mirrors nextjs.mjs. Every non-special file under the
 * app directory is a route (files are NOT named `page.tsx`).
 *
 * Exports the adapter interface documented in ./shared.mjs:
 *   framework            string    — "expo-router"
 *   discoverRoutes       (cwd, framework) -> Route[]
 *   extractNavigations   (ast, source, filePath, ctx) -> Nav[]
 *   resolveTarget        (nav, routes) -> { targetId }
 */
import path from "node:path";
import fg from "fast-glob";
import {
  traverse,
  resolveString,
  jsxTagName,
  exists,
  hashId,
  IGNORED,
} from "./shared.mjs";

export const framework = "expo-router";

// ─────────────────────────────────────────────────────────────────────────────
// Expo Router navigation heuristics
// ─────────────────────────────────────────────────────────────────────────────
/** Heuristic identifier names treated as a router even without a useRouter() binding. */
const ROUTER_NAMES = new Set(["router", "nav", "navigation"]);
/** Router methods that imply a static navigation target. */
const PUSH_METHODS = new Set(["push", "navigate"]);
const REPLACE_METHODS = new Set(["replace"]);
/** Router methods with no static target — explicitly skipped. */
const SKIP_METHODS = new Set(["back", "dismiss", "dismissAll", "dismissTo"]);

// ─────────────────────────────────────────────────────────────────────────────
// Route discovery
// ─────────────────────────────────────────────────────────────────────────────
export async function discoverRoutes(cwd, _framework) {
  const roots = ["app", "src/app"];
  const routes = [];
  for (const root of roots) {
    const absRoot = path.join(cwd, root);
    if (!(await exists(absRoot))) continue;
    const files = await fg("**/*.{ts,tsx,js,jsx}", {
      cwd: absRoot,
      ignore: IGNORED,
      onlyFiles: true,
    });
    for (const f of files) {
      const routePath = fileToRoutePath(f);
      if (routePath == null) continue; // excluded (layout / api / special)
      const filePath = path.posix.join(root, f.replaceAll(path.sep, "/"));
      routes.push({
        id: hashId(filePath),
        routePath,
        filePath,
        absolutePath: path.join(cwd, filePath),
        componentName: null,
        metadata: null,
      });
    }
  }
  // De-dupe by routePath (in case both app/ and src/app/ exist for same path).
  const seen = new Map();
  for (const r of routes) {
    if (!seen.has(r.routePath)) seen.set(r.routePath, r);
  }
  return [...seen.values()];
}

/**
 * Map a file path (relative to the app root, posix or native separators) to an
 * Expo Router route path, or null when the file is NOT a route.
 *
 * Excluded (returns null):
 *   - any segment whose basename starts with `_` (e.g. `_layout.tsx`)
 *   - special files: `+html.*`, `+native-intent.*`, `+middleware.*`
 *   - anything under an `api/` directory, or files matching `*+api.*`
 * Kept:
 *   - `+not-found.tsx` → `/+not-found`
 */
function fileToRoutePath(relFile) {
  const noExt = relFile.replace(/\.(ts|tsx|js|jsx)$/, "");
  const segments = noExt.split(/[\\/]/).filter((s) => s && s !== ".");
  if (segments.length === 0) return null;

  const fileSegment = segments[segments.length - 1];

  // Exclude anything in an `api/` directory (Expo API routes live there).
  if (segments.slice(0, -1).some((s) => s === "api")) return null;
  // Exclude API route files: `*+api.*`.
  if (/\+api$/.test(fileSegment)) return null;
  // Exclude reserved special files.
  if (/^\+(html|native-intent|middleware)$/.test(fileSegment)) return null;
  // Exclude any file/dir segment starting with `_` (e.g. `_layout`).
  if (segments.some((s) => s.startsWith("_"))) return null;

  // Drop route-group segments `(...)`; a trailing `index` maps to its parent.
  const routeSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (/^\(.*\)$/.test(seg)) continue; // route group — stripped
    if (isLast && seg === "index") continue; // trailing index → parent
    routeSegments.push(seg);
  }

  const routePath = "/" + routeSegments.join("/");
  return routePath === "/" ? "/" : routePath.replace(/\/+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation extraction: <Link> / <Redirect> / router.push|replace|navigate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns: Nav[] = Array<{ kind, urlValue, urlText, confidence, line }>
 * ctx = { imports } — imports as returned by shared.extractImports(ast).
 *
 * GATE: only symbols imported from "expo-router" are treated as navigation.
 */
export function extractNavigations(ast, source, filePath, ctx) {
  const navigations = [];

  // Local names imported from "expo-router".
  const linkBindings = new Set(); // imported as `Link`
  const redirectBindings = new Set(); // imported as `Redirect`
  const useRouterBindings = new Set(); // imported as `useRouter`
  const routerSingletonBindings = new Set(); // imported as `router`

  for (const imp of ctx?.imports ?? []) {
    if (imp.source !== "expo-router") continue;
    for (const s of imp.specifiers) {
      if (s.kind !== "named") continue;
      if (s.imported === "Link") linkBindings.add(s.local);
      else if (s.imported === "Redirect") redirectBindings.add(s.local);
      else if (s.imported === "useRouter") useRouterBindings.add(s.local);
      else if (s.imported === "router") routerSingletonBindings.add(s.local);
    }
  }

  /** Identifiers bound to a useRouter() call, in any scope. */
  const routerInstanceBindings = new Set();

  function pushNav(kind, urlValue, urlText, confidence, node) {
    navigations.push({
      kind,
      urlValue,
      urlText,
      confidence,
      line: node?.loc?.start?.line ?? 0,
    });
  }

  function emit(kind, resolved, node) {
    if (!resolved) return;
    if (resolved.multi) {
      for (const r of resolved.multi) emit(kind, r, node);
      return;
    }
    pushNav(kind, resolved.value, resolved.text, resolved.confidence, node);
  }

  /**
   * Resolve an href / first-argument expression that may be a plain string
   * expression OR an object-form `{ pathname: "/x", params: {...} }`. Returns a
   * resolution object (as produced by resolveString), { multi }, or null.
   */
  function resolveHref(expr, scope) {
    if (!expr) return null;
    if (expr.type === "ObjectExpression") {
      for (const prop of expr.properties) {
        if (
          prop.type === "ObjectProperty" &&
          !prop.computed &&
          ((prop.key.type === "Identifier" && prop.key.name === "pathname") ||
            (prop.key.type === "StringLiteral" && prop.key.value === "pathname"))
        ) {
          const inner = resolveString(prop.value, scope, source);
          if (!inner) return null;
          if (inner.multi) return inner;
          // Object-form pathname — slightly lower confidence than a bare string.
          return { ...inner, confidence: Math.min(inner.confidence, 0.9) };
        }
      }
      return null; // object href with no static pathname
    }
    return resolveString(expr, scope, source);
  }

  traverse(ast, {
    VariableDeclarator(p) {
      // const r = useRouter();
      const init = p.node.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        useRouterBindings.has(init.callee.name) &&
        p.node.id?.type === "Identifier"
      ) {
        routerInstanceBindings.add(p.node.id.name);
      }
    },

    JSXOpeningElement(p) {
      const tag = jsxTagName(p.node.name);
      if (!tag) return;
      let kind = null;
      if (linkBindings.has(tag)) kind = "link";
      else if (redirectBindings.has(tag)) kind = "redirect";
      if (!kind) return;

      const hrefAttr = p.node.attributes.find(
        (a) => a.type === "JSXAttribute" && a.name?.name === "href",
      );
      if (!hrefAttr) return;
      const value = hrefAttr.value;
      let resolved;
      if (value?.type === "StringLiteral") {
        resolved = { value: value.value, text: value.value, confidence: 1.0, kind: "static" };
      } else if (value?.type === "JSXExpressionContainer") {
        resolved = resolveHref(value.expression, p.scope);
      }
      if (!resolved) return;
      // Skip external / non-route schemas (mailto:, tel:, #anchor).
      if (resolved.value && /^(mailto:|tel:|#)/i.test(resolved.value)) return;
      emit(kind, resolved, hrefAttr);
    },

    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== "MemberExpression") return;
      if (callee.property?.type !== "Identifier") return;
      const method = callee.property.name;

      // Skip target-less router methods entirely.
      if (SKIP_METHODS.has(method)) return;

      let mappedKind = null;
      if (PUSH_METHODS.has(method)) mappedKind = "router-push";
      else if (REPLACE_METHODS.has(method)) mappedKind = "router-replace";
      if (!mappedKind) return;

      const obj = callee.object;
      let isRouter = false;
      if (obj.type === "Identifier") {
        if (
          routerInstanceBindings.has(obj.name) ||
          routerSingletonBindings.has(obj.name) ||
          ROUTER_NAMES.has(obj.name)
        ) {
          isRouter = true;
        }
      }
      // Also allow useRouter().push("/foo").
      if (
        obj.type === "CallExpression" &&
        obj.callee?.type === "Identifier" &&
        useRouterBindings.has(obj.callee.name)
      ) {
        isRouter = true;
      }
      if (!isRouter) return;

      const resolved = resolveHref(p.node.arguments[0], p.scope);
      emit(mappedKind, resolved, p.node);
    },
  });

  return navigations;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL → route matching
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve a Nav to a target screen. Returns { targetId } where targetId is the
 * matched route's id, or null when no route matches (the orchestrator then
 * builds a synthetic screen).
 */
export function resolveTarget(nav, routes) {
  const targetRoute = matchRoute(nav.urlValue, routes);
  return { targetId: targetRoute ? targetRoute.id : null };
}

function matchRoute(url, routes) {
  if (!url) return null;
  const stripped = url.split("?")[0].split("#")[0];
  // Exact match.
  for (const r of routes) {
    if (r.routePath === stripped) return r;
  }
  // Pattern match — treat [param] in the route AND in the url as wildcards.
  for (const r of routes) {
    const routeRegex = new RegExp(
      "^" +
        r.routePath
          .replaceAll(/\[\.{3}.+?\]/g, "(?:.+)")
          .replaceAll(/\[.+?\]/g, "[^/]+") +
        "/?$",
    );
    const urlNormalized = stripped.replaceAll(/\[param\]/g, "wildcard");
    if (routeRegex.test(urlNormalized)) return r;
  }
  return null;
}
