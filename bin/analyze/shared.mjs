/**
 * Framework-agnostic infrastructure for the Flowmap static analyzer.
 *
 * Everything in this module is shared between framework adapters (Next.js,
 * Expo Router, React Navigation). It is a FROZEN, stable API — adapters and
 * the orchestrator import from here, and nothing here makes framework-specific
 * assumptions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Adapter interface — every framework adapter module (e.g. nextjs.mjs) MUST
 * export exactly the following:
 *
 *   export const framework
 *     A string id, or string[] of ids, that this adapter handles.
 *     (nextjs.mjs handles two: ["nextjs-app", "nextjs-pages"].)
 *
 *   export async function discoverRoutes(cwd, framework) -> Route[]
 *     Route = {
 *       id: string,             // hashId of filePath
 *       routePath: string,      // normalized route path, e.g. "/users/[id]"
 *       filePath: string,       // posix-relative path from cwd
 *       absolutePath: string,   // absolute path on disk
 *       componentName: string | null,
 *       metadata: object | null,
 *     }
 *
 *   export function extractNavigations(ast, source, filePath, ctx) -> Nav[]
 *     ctx = { imports }  // imports as returned by extractImports(ast)
 *     Nav = {
 *       kind: string,           // e.g. "link", "router-push", "redirect"
 *       urlValue: string|null,  // resolved URL value, or null if unresolvable
 *       urlText: string,        // human-readable source text of the URL expr
 *       confidence: number,     // 0..1
 *       line: number,
 *     }
 *
 *   export function resolveTarget(nav, routes) -> { targetId, syntheticScreen? }
 *     Resolves a Nav to a target screen id. When the nav points at a real
 *     route, returns { targetId }. When it cannot be matched, the orchestrator
 *     falls back to a synthetic screen (see makeSyntheticScreen). Adapters may
 *     instead return { syntheticScreen } to fully describe an unresolved
 *     target; the Next.js adapter only does route matching (returns
 *     { targetId } or { targetId: null }).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import fg from "fast-glob";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

export const traverse = traverseModule.default ?? traverseModule;

// ─────────────────────────────────────────────────────────────────────────────
// Glob constants
// ─────────────────────────────────────────────────────────────────────────────
export const SRC_GLOBS = ["**/*.{ts,tsx,js,jsx,mjs,cjs}"];
export const IGNORED = [
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/.flowmap/**",
];

// ─────────────────────────────────────────────────────────────────────────────
// Source discovery
// ─────────────────────────────────────────────────────────────────────────────
export async function discoverSources(cwd) {
  const files = await fg(SRC_GLOBS, { cwd, ignore: IGNORED, onlyFiles: true });
  return files.map((f) => path.join(cwd, f));
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────
export function parseSource(source) {
  return parse(source, {
    sourceType: "module",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    plugins: ["jsx", "typescript", "decorators-legacy", "importAttributes"],
    errorRecovery: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Import extraction
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Collect every import declaration from an AST.
 * Returns: Import[] = Array<{ source: string, specifiers: Spec[], line }>
 * where Spec is one of:
 *   { kind: "default",   local }
 *   { kind: "namespace", local }
 *   { kind: "named",     imported, local }
 */
export function extractImports(ast) {
  const imports = [];
  traverse(ast, {
    ImportDeclaration(p) {
      const src = p.node.source.value;
      const specs = p.node.specifiers.map((s) => {
        if (s.type === "ImportDefaultSpecifier") return { kind: "default", local: s.local.name };
        if (s.type === "ImportNamespaceSpecifier") return { kind: "namespace", local: s.local.name };
        return {
          kind: "named",
          imported: s.imported?.name ?? s.imported?.value ?? s.local.name,
          local: s.local.name,
        };
      });
      imports.push({ source: src, specifiers: specs, line: p.node.loc?.start?.line ?? 0 });
    },
  });
  return imports;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST value resolution helpers (used by framework adapters)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve an AST node to a string value, following a single level of variable
 * bindings. Returns a resolution object, or { multi: [...] } for conditional
 * expressions (caller flattens), or null.
 *
 * NOTE: this implementation needs the source text to produce `text` for
 * unresolved expressions. It is closed over a `nodeText` derived from the AST
 * node `start`/`end` offsets, so callers must pass the original `source`.
 */
export function resolveString(node, scope, source) {
  function nodeText(n) {
    if (n?.start == null || n?.end == null) return "<expr>";
    return source.slice(n.start, n.end);
  }
  function rec(n, sc) {
    if (!n) return null;
    if (n.type === "StringLiteral") {
      return { value: n.value, text: n.value, confidence: 1.0, kind: "static" };
    }
    if (n.type === "TemplateLiteral") {
      let pattern = "";
      for (let i = 0; i < n.quasis.length; i++) {
        pattern += n.quasis[i].value.cooked ?? "";
        if (i < n.expressions.length) pattern += "[param]";
      }
      return { value: pattern, text: nodeText(n), confidence: 0.85, kind: "pattern" };
    }
    if (n.type === "Identifier") {
      const binding = sc?.getBinding(n.name);
      const init = binding?.path?.node?.init;
      if (init) {
        if (init.type === "StringLiteral") {
          return { value: init.value, text: init.value, confidence: 0.7, kind: "static-via-var" };
        }
        if (init.type === "TemplateLiteral") {
          let pattern = "";
          for (let i = 0; i < init.quasis.length; i++) {
            pattern += init.quasis[i].value.cooked ?? "";
            if (i < init.expressions.length) pattern += "[param]";
          }
          return { value: pattern, text: nodeText(n), confidence: 0.6, kind: "pattern-via-var" };
        }
      }
      return { value: null, text: n.name, confidence: 0.4, kind: "unresolved-ident" };
    }
    if (n.type === "JSXExpressionContainer") {
      return rec(n.expression, sc);
    }
    if (n.type === "ConditionalExpression") {
      // Capture both branches as separate navigations — caller flattens
      const a = rec(n.consequent, sc);
      const b = rec(n.alternate, sc);
      const branches = [a, b].filter(Boolean);
      if (branches.length === 0) {
        return { value: null, text: nodeText(n), confidence: 0.4, kind: "unresolved-cond" };
      }
      return { multi: branches };
    }
    return { value: null, text: nodeText(n), confidence: 0.4, kind: "unresolved-expr" };
  }
  return rec(node, scope);
}

export function jsxTagName(node) {
  if (!node) return null;
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") {
    // e.g. <Foo.Bar />
    const parts = [];
    let cur = node;
    while (cur?.type === "JSXMemberExpression") {
      parts.unshift(cur.property?.name);
      cur = cur.object;
    }
    if (cur?.name) parts.unshift(cur.name);
    return parts[parts.length - 1] ?? null;
  }
  return null;
}

export function isWindowLocation(node) {
  // window.location  OR  location  (global)
  if (node.type === "MemberExpression") {
    if (
      node.object?.type === "Identifier" &&
      node.object.name === "window" &&
      node.property?.type === "Identifier" &&
      node.property.name === "location"
    )
      return true;
  }
  if (node.type === "Identifier" && node.name === "location") return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import-graph attribution
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve an import specifier (as written in source) to an absolute file path
 * on disk, or null. Handles relative imports, the tsconfig "@/" alias, and
 * any tsconfig `paths` wildcard mappings.
 *
 * `aliasResolvers` / `defaultAlias` are derived once per project by
 * buildImportGraph and threaded through here. When omitted (standalone use),
 * the function reads tsconfig.json itself.
 */
export async function resolveImportToFile(cwd, fromFile, specifier, opts = {}) {
  let aliasResolvers = opts.aliasResolvers;
  let defaultAlias = opts.defaultAlias ?? ["", "src/"];
  if (!aliasResolvers) {
    const built = await buildAliasResolvers(cwd);
    aliasResolvers = built.aliasResolvers;
    defaultAlias = built.defaultAlias;
  }
  const target = resolveAlias(specifier, fromFile, cwd, aliasResolvers, defaultAlias);
  return resolveToFile(target);
}

/** Build the tsconfig-derived alias resolvers for a project. */
async function buildAliasResolvers(cwd) {
  const tsconfig = await readJson(path.join(cwd, "tsconfig.json")).catch(() => null);
  const baseUrl = tsconfig?.compilerOptions?.baseUrl;
  const paths = tsconfig?.compilerOptions?.paths ?? {};
  const aliasResolvers = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    for (const t of targets) {
      if (!t.endsWith("*")) continue;
      const tprefix = t.slice(0, -1);
      const resolveBase = baseUrl ? path.resolve(cwd, baseUrl) : cwd;
      aliasResolvers.push({ prefix, replace: path.resolve(resolveBase, tprefix) });
    }
  }
  // Default Next.js: "@/" → cwd or src/
  const defaultAlias = ["", "src/"];
  return { aliasResolvers, defaultAlias };
}

/** Map an import specifier to a candidate path (without an extension). */
function resolveAlias(spec, fromFile, cwd, aliasResolvers, defaultAlias) {
  for (const a of aliasResolvers) {
    if (spec.startsWith(a.prefix)) {
      return path.join(a.replace, spec.slice(a.prefix.length));
    }
  }
  if (spec.startsWith("@/")) {
    const tail = spec.slice(2);
    for (const root of defaultAlias) {
      const candidate = path.join(cwd, root, tail);
      return candidate;
    }
  }
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
    return spec.startsWith("/") ? spec : path.resolve(path.dirname(fromFile), spec);
  }
  return null;
}

/** Resolve a candidate path to an actual file by trying extensions / index. */
async function resolveToFile(target) {
  if (!target) return null;
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.jsx`,
    `${target}.mjs`,
    `${target}.cjs`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
    path.join(target, "index.js"),
    path.join(target, "index.jsx"),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
}

/**
 * Build the who-imports-whom graph: importedFile → Set<importerFile>.
 * Resolves "./Header", "@/components/Header", tsconfig path aliases, etc.
 */
export async function buildImportGraph(cwd, sourceFiles, fileImports) {
  const { aliasResolvers, defaultAlias } = await buildAliasResolvers(cwd);

  const importedBy = new Map();
  for (const importerFile of sourceFiles) {
    const imports = fileImports.get(importerFile) ?? [];
    for (const imp of imports) {
      const file = await resolveImportToFile(cwd, importerFile, imp.source, {
        aliasResolvers,
        defaultAlias,
      });
      if (!file) continue;
      let set = importedBy.get(file);
      if (!set) {
        set = new Set();
        importedBy.set(file, set);
      }
      set.add(importerFile);
    }
  }
  return importedBy;
}

/**
 * For a given source file, return the set of route absolute paths that
 * (transitively) import it. Cap at maxDepth hops to bound traversal.
 */
export function findOwningRoutes(file, importedBy, routeAbsSet, maxDepth = 5) {
  if (routeAbsSet.has(file)) return new Set([file]);
  const found = new Set();
  const seen = new Set([file]);
  const queue = [{ file, depth: 0 }];
  while (queue.length) {
    const { file: cur, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const importers = importedBy.get(cur) ?? new Set();
    for (const im of importers) {
      if (seen.has(im)) continue;
      seen.add(im);
      if (routeAbsSet.has(im)) {
        found.add(im);
        // continue — don't return yet, we want all owning routes
      } else {
        queue.push({ file: im, depth: depth + 1 });
      }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic screens + edge construction
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build a synthetic Screen from a synthetic key. The key is one of:
 *   "external:<url>"  → an external link
 *   "unknown:<expr>"  → an unresolvable in-app navigation target
 */
export function makeSyntheticScreen(key) {
  const isExternal = key.startsWith("external:");
  return {
    id: hashId(key),
    routePath: key,
    filePath: isExternal ? "<external>" : "<unknown>",
    componentName: isExternal ? "External link" : "Unresolved",
    metadata: null,
  };
}

/**
 * Construct an edge object from a resolved navigation.
 * `targetId` is the resolved target screen id. `sourceRoute` is the owning
 * Route. `nav` is the Nav. `file` is the absolute path the nav was found in.
 */
export function edgeBuilder({ sourceRoute, targetId, nav, cwd, file }) {
  const sourceLocation = path.relative(cwd, file);
  return {
    id: hashId(`${sourceRoute.id}|${targetId}|${nav.kind}|${sourceLocation}|${nav.line}`),
    sourceId: sourceRoute.id,
    targetId,
    type: edgeType(nav.kind),
    label: nav.kind === "link" ? undefined : nav.kind,
    confidence: nav.confidence,
    sourceLocation: { filePath: sourceLocation, line: nav.line },
    isUserAdded: false,
  };
}

export function edgeType(kind) {
  switch (kind) {
    case "link":
      return "link";
    case "router-push":
      return "router-push";
    case "router-replace":
      return "router-replace";
    case "redirect":
      return "redirect";
    case "window-location":
      return "window-location";
    default:
      return "manual";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────
export async function readJson(file) {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw);
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function hashId(s) {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}
