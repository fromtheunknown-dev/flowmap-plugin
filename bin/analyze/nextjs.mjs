/**
 * Next.js framework adapter for the Flowmap static analyzer.
 *
 * Handles both the App Router and the Pages Router. Mechanically extracted
 * from the original monolithic analyze.mjs — ZERO behavior change.
 *
 * Exports the adapter interface documented in ./shared.mjs:
 *   framework            string[]  — ["nextjs-app", "nextjs-pages"]
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
  isWindowLocation,
  exists,
  hashId,
  IGNORED,
} from "./shared.mjs";

export const framework = ["nextjs-app", "nextjs-pages"];

// ─────────────────────────────────────────────────────────────────────────────
// Next.js navigation heuristics
// ─────────────────────────────────────────────────────────────────────────────
const LINK_LIKE_TAGS = new Set(["Link", "NavLink", "a", "A"]);
const ROUTER_NAMES = new Set(["router", "nav", "navigation", "r"]);
const ROUTER_METHODS = new Set(["push", "replace"]);

// ─────────────────────────────────────────────────────────────────────────────
// Detection helpers (used by the orchestrator's detectFramework)
// ─────────────────────────────────────────────────────────────────────────────
export async function hasNextAppDir(cwd) {
  return (
    (await exists(path.join(cwd, "app", "page.tsx"))) ||
    (await exists(path.join(cwd, "app", "page.ts"))) ||
    (await exists(path.join(cwd, "app", "page.jsx"))) ||
    (await exists(path.join(cwd, "app", "page.js"))) ||
    (await exists(path.join(cwd, "app", "layout.tsx"))) ||
    (await exists(path.join(cwd, "src/app", "page.tsx"))) ||
    (await exists(path.join(cwd, "src/app", "page.ts"))) ||
    (await exists(path.join(cwd, "src/app", "page.jsx"))) ||
    (await exists(path.join(cwd, "src/app", "page.js"))) ||
    (await exists(path.join(cwd, "src/app", "layout.tsx")))
  );
}

export async function hasNextPagesDir(cwd) {
  return (
    (await exists(path.join(cwd, "pages"))) ||
    (await exists(path.join(cwd, "src", "pages")))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route discovery
// ─────────────────────────────────────────────────────────────────────────────
export async function discoverRoutes(cwd, framework) {
  if (framework === "nextjs-app") return discoverAppRouterRoutes(cwd);
  if (framework === "nextjs-pages") return discoverPagesRouterRoutes(cwd);
  return [];
}

async function discoverAppRouterRoutes(cwd) {
  const roots = ["app", "src/app"];
  const routes = [];
  for (const root of roots) {
    const absRoot = path.join(cwd, root);
    if (!(await exists(absRoot))) continue;
    const files = await fg("**/page.{ts,tsx,js,jsx}", {
      cwd: absRoot,
      ignore: IGNORED,
      onlyFiles: true,
    });
    for (const f of files) {
      const dirSegments = path.dirname(f).split(path.sep).filter((s) => s !== ".");
      // Strip route groups: (foo) and parallel routes: @foo
      const routeSegments = dirSegments.filter((s) => !s.startsWith("(") && !s.startsWith("@"));
      const routePath = "/" + routeSegments.join("/");
      const normalizedRoutePath = routePath === "/" ? "/" : routePath.replace(/\/+$/, "");
      const filePath = path.posix.join(root, f.replaceAll(path.sep, "/"));
      routes.push({
        id: hashId(filePath),
        routePath: normalizedRoutePath || "/",
        filePath,
        absolutePath: path.join(cwd, filePath),
        componentName: null,
        metadata: null,
      });
    }
  }
  // De-dupe (in case both app/ and src/app/ exist for same path — unlikely)
  const seen = new Map();
  for (const r of routes) seen.set(r.routePath, r);
  return [...seen.values()];
}

async function discoverPagesRouterRoutes(cwd) {
  const roots = ["pages", "src/pages"];
  const routes = [];
  for (const root of roots) {
    const absRoot = path.join(cwd, root);
    if (!(await exists(absRoot))) continue;
    const files = await fg("**/*.{ts,tsx,js,jsx}", {
      cwd: absRoot,
      ignore: ["**/api/**", "_app.*", "_document.*", "_error.*", "**/_*.*", ...IGNORED],
      onlyFiles: true,
    });
    for (const f of files) {
      const noExt = f.replace(/\.(ts|tsx|js|jsx)$/, "");
      let routePath = "/" + noExt.replaceAll(path.sep, "/");
      routePath = routePath.replace(/\/index$/, "/");
      if (routePath !== "/") routePath = routePath.replace(/\/+$/, "");
      const filePath = path.posix.join(root, f.replaceAll(path.sep, "/"));
      routes.push({
        id: hashId(filePath),
        routePath: routePath || "/",
        filePath,
        absolutePath: path.join(cwd, filePath),
        componentName: null,
        metadata: null,
      });
    }
  }
  const seen = new Map();
  for (const r of routes) seen.set(r.routePath, r);
  return [...seen.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation extraction: Link / router.push / redirect / window.location
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns: Nav[] = Array<{ kind, urlValue, urlText, confidence, line }>
 * ctx = { imports } — imports as returned by shared.extractImports(ast).
 */
export function extractNavigations(ast, source, filePath, ctx) {
  /* URL fragments the project has named in `.flowmap/config.json`. */
  const aliases = ctx?.aliases ?? null;
  const navigations = [];

  /** Lookup table for identifiers bound to a useRouter() call, in any scope. */
  const routerBindings = new Set();
  /** Lookup table for identifiers imported as `redirect` / `permanentRedirect` etc. */
  const redirectBindings = new Set();
  const permanentRedirectBindings = new Set();

  // Track redirect/permanentRedirect bindings from imports (accepts any source
  // for completeness — matches the original inline behavior).
  for (const imp of ctx?.imports ?? []) {
    for (const s of imp.specifiers) {
      if (s.kind === "named") {
        if (s.imported === "redirect") redirectBindings.add(s.local);
        if (s.imported === "permanentRedirect") permanentRedirectBindings.add(s.local);
      }
    }
  }

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

  traverse(ast, {
    VariableDeclarator(p) {
      // const router = useRouter();
      const init = p.node.init;
      if (
        init?.type === "CallExpression" &&
        init.callee?.type === "Identifier" &&
        init.callee.name === "useRouter" &&
        p.node.id?.type === "Identifier"
      ) {
        routerBindings.add(p.node.id.name);
      }
    },

    JSXOpeningElement(p) {
      const tag = jsxTagName(p.node.name);
      if (!tag || !LINK_LIKE_TAGS.has(tag)) return;
      const hrefAttr = p.node.attributes.find(
        (a) => a.type === "JSXAttribute" && a.name?.name === "href",
      );
      if (!hrefAttr) return;
      const value = hrefAttr.value;
      let resolved;
      if (value?.type === "StringLiteral") {
        resolved = { value: value.value, text: value.value, confidence: 1.0, kind: "static" };
      } else if (value?.type === "JSXExpressionContainer") {
        resolved = resolveString(value.expression, p.scope, source, aliases);
      }
      if (!resolved) return;
      // Skip pure external/non-http schemas if it's a plain <a>
      // (mailto:, tel:, javascript:) — not a route navigation
      if (resolved.value && /^(mailto:|tel:|javascript:|#)/i.test(resolved.value)) return;
      emit("link", resolved, hrefAttr);
    },

    CallExpression(p) {
      const callee = p.node.callee;
      const arg0 = p.node.arguments[0];

      // router.push('/foo')  /  router.replace('/foo')
      if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
        const method = callee.property.name;
        if (ROUTER_METHODS.has(method)) {
          const obj = callee.object;
          let isRouter = false;
          if (obj.type === "Identifier") {
            if (routerBindings.has(obj.name) || ROUTER_NAMES.has(obj.name)) isRouter = true;
          }
          // Also allow useRouter().push("/foo")
          if (
            obj.type === "CallExpression" &&
            obj.callee?.type === "Identifier" &&
            obj.callee.name === "useRouter"
          ) {
            isRouter = true;
          }
          // Conservative fallback: if first arg is a string starting with "/", accept
          if (!isRouter && arg0?.type === "StringLiteral" && arg0.value.startsWith("/")) {
            isRouter = true;
          }
          if (isRouter) {
            const resolved = resolveString(arg0, p.scope, source, aliases);
            emit(`router-${method}`, resolved, p.node);
            return;
          }
        }

        // window.location.assign / replace
        if (
          (method === "assign" || method === "replace") &&
          isWindowLocation(callee.object)
        ) {
          const resolved = resolveString(arg0, p.scope, source, aliases);
          emit("window-location", resolved, p.node);
          return;
        }
      }

      // redirect(...) / permanentRedirect(...)
      if (callee.type === "Identifier") {
        if (redirectBindings.has(callee.name) || callee.name === "redirect") {
          const resolved = resolveString(arg0, p.scope, source, aliases);
          emit("redirect", resolved, p.node);
          return;
        }
        if (permanentRedirectBindings.has(callee.name) || callee.name === "permanentRedirect") {
          const resolved = resolveString(arg0, p.scope, source, aliases);
          emit("redirect", resolved, p.node);
          return;
        }
      }
    },

    AssignmentExpression(p) {
      // window.location.href = '/foo'
      const left = p.node.left;
      if (
        left.type === "MemberExpression" &&
        left.property?.type === "Identifier" &&
        left.property.name === "href" &&
        isWindowLocation(left.object)
      ) {
        const resolved = resolveString(p.node.right, p.scope, source, aliases);
        emit("window-location", resolved, p.node);
      }
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
  // Exact
  for (const r of routes) {
    if (r.routePath === stripped) return r;
  }
  // Pattern (treat [param] in route AND in url as wildcards)
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
