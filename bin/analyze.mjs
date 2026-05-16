/**
 * Static analyzer: extracts routes and ALL navigation edges from a supported
 * project. Designed for completeness — every navigation (Link / router.push /
 * redirect / window.location, etc.) is captured. Components imported by
 * multiple pages produce one edge per importing page. Unresolvable URLs are
 * recorded with low confidence pointing at synthetic "unknown" screens, so
 * they are visible in the diagram instead of silently dropped.
 *
 * This module is a thin orchestrator. Framework-agnostic infrastructure lives
 * in ./analyze/shared.mjs; per-framework logic lives in adapter modules
 * (./analyze/nextjs.mjs, with Expo Router / React Navigation adapters added in
 * a later step). The orchestrator detects the framework, dispatches to the
 * matching adapter, and runs the shared import-graph attribution + edge build.
 *
 * Public exports:
 *   detectFramework(cwd)            → string
 *   discoverRoutes(cwd, framework)  → Route[]
 *   analyze(cwd, opts?)             → { manifest, stats }
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as shared from "./analyze/shared.mjs";
import * as nextjs from "./analyze/nextjs.mjs";
import * as expoRouter from "./analyze/expo-router.mjs";
import * as reactNavigation from "./analyze/react-navigation.mjs";

// Adapter registry — framework id → framework adapter module.
const ADAPTERS = {
  "nextjs-app": nextjs,
  "nextjs-pages": nextjs,
  "expo-router": expoRouter,
  "react-navigation": reactNavigation,
};

// ─────────────────────────────────────────────────────────────────────────────
// Framework detection
// ─────────────────────────────────────────────────────────────────────────────
export async function detectFramework(cwd) {
  const pkg = await shared.readJson(path.join(cwd, "package.json")).catch(() => null);
  if (!pkg) return "unknown";
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  // 1. Next.js first.
  if (deps.next) {
    if (await nextjs.hasNextAppDir(cwd)) return "nextjs-app";
    if (await nextjs.hasNextPagesDir(cwd)) return "nextjs-pages";
  }
  // 2. Expo Router before React Navigation (expo-router is built on React
  //    Navigation). File-based routing is the stronger signal, so it wins when
  //    both apply.
  if (deps["expo-router"]) {
    const root = await findExpoAppDir(cwd); // "app" or "src/app" containing a _layout.*
    if (root) return "expo-router";
  }
  // 3. Plain React Native + React Navigation.
  const hasReactNavigation = Object.keys(deps).some((d) => d.startsWith("@react-navigation/"));
  if ((deps["react-native"] || deps.expo) && hasReactNavigation) return "react-navigation";
  return "unknown";
}

/**
 * Returns the first of ["app", "src/app"] that exists AND contains a
 * `_layout.{tsx,ts,jsx,js}` file. The `_layout` requirement disambiguates an
 * Expo `app/` from a Next.js `app/`. Used only for detection.
 */
async function findExpoAppDir(cwd) {
  for (const root of ["app", "src/app"]) {
    const absRoot = path.join(cwd, root);
    if (!(await shared.exists(absRoot))) continue;
    for (const ext of ["tsx", "ts", "jsx", "js"]) {
      if (await shared.exists(path.join(absRoot, `_layout.${ext}`))) return root;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route discovery — dispatched to the matching adapter
// ─────────────────────────────────────────────────────────────────────────────
export async function discoverRoutes(cwd, framework) {
  const adapter = ADAPTERS[framework];
  if (!adapter) return [];
  return adapter.discoverRoutes(cwd, framework);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main analyze entry
// ─────────────────────────────────────────────────────────────────────────────
export async function analyze(cwd, opts = {}) {
  const framework = await detectFramework(cwd);
  const adapter = ADAPTERS[framework];
  if (!adapter) {
    throw new Error(
      `Unable to detect framework. Supported: Next.js, Expo Router, React Native + React Navigation. cwd=${cwd}`,
    );
  }

  const routes = await adapter.discoverRoutes(cwd, framework);
  const sources = await shared.discoverSources(cwd);

  // Parse all sources, collect imports + navigations per file
  const fileImports = new Map();
  const fileNavigations = new Map();
  for (const file of sources) {
    let source;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    let ast;
    try {
      ast = shared.parseSource(source);
    } catch {
      // Parse error — skip this file
      continue;
    }
    const imports = shared.extractImports(ast);
    const navigations = adapter.extractNavigations(ast, source, file, { imports });
    fileImports.set(file, imports);
    if (navigations.length) fileNavigations.set(file, navigations);
  }

  const routeAbsSet = new Set(routes.map((r) => r.absolutePath));
  const importedBy = await shared.buildImportGraph(cwd, sources, fileImports);

  // Build edges: for each navigation, find owning routes and resolve target
  const edges = [];
  const unknownScreens = new Map(); // synthKey → Screen
  let unresolvedCount = 0;

  for (const [file, navs] of fileNavigations.entries()) {
    const owningRouteAbs = routeAbsSet.has(file)
      ? new Set([file])
      : shared.findOwningRoutes(file, importedBy, routeAbsSet);
    if (owningRouteAbs.size === 0) {
      // Unattributed — lib code that no route imports won't render in the flow.
      continue;
    }

    for (const ownerAbs of owningRouteAbs) {
      const sourceRoute = routes.find((r) => r.absolutePath === ownerAbs);
      if (!sourceRoute) continue;

      for (const nav of navs) {
        const resolution = adapter.resolveTarget(nav, routes);
        let targetId = resolution?.targetId ?? null;

        if (!targetId) {
          // Adapter may fully describe the synthetic target; otherwise build a
          // standard synthetic "unknown" / "external" screen (de-duplicated).
          let synth = resolution?.syntheticScreen;
          let synthKey;
          if (synth) {
            synthKey = synth.routePath;
          } else {
            const isExternal = /^(https?:|\/\/)/i.test(nav.urlValue ?? nav.urlText ?? "");
            synthKey = isExternal
              ? `external:${(nav.urlValue ?? nav.urlText)?.slice(0, 80)}`
              : `unknown:${nav.urlValue ?? nav.urlText ?? "<expr>"}`;
            synth = shared.makeSyntheticScreen(synthKey);
          }
          if (!unknownScreens.has(synthKey)) {
            unknownScreens.set(synthKey, synth);
          }
          targetId = unknownScreens.get(synthKey).id;
          unresolvedCount++;
        }

        edges.push(shared.edgeBuilder({ sourceRoute, targetId, nav, cwd, file }));
      }
    }
  }

  // De-dup edges by full content
  const seenEdges = new Set();
  const uniqEdges = [];
  for (const e of edges) {
    const key = `${e.sourceId}|${e.targetId}|${e.type}|${e.sourceLocation?.filePath}|${e.sourceLocation?.line}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    uniqEdges.push(e);
  }

  const screens = [
    ...routes.map(({ absolutePath: _abs, ...rest }) => rest),
    ...unknownScreens.values(),
  ];

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    framework,
    projectRoot: cwd,
    devServerUrl: opts.devServerUrl,
    screens,
    edges: uniqEdges,
  };

  return {
    manifest,
    stats: {
      framework,
      routes: routes.length,
      unknowns: unknownScreens.size,
      edges: uniqEdges.length,
      unresolvedEdges: unresolvedCount,
      filesScanned: sources.length,
    },
  };
}
