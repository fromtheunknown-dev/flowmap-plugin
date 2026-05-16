/**
 * React Navigation framework adapter for the Flowmap static analyzer.
 *
 * Handles plain React Native projects using @react-navigation/* (NOT Expo
 * Router — that is a separate adapter). React Navigation has NO file-based
 * routing: screens are registered in code and navigation targets are screen
 * NAMES, not URL paths. This adapter therefore:
 *
 *   1. Builds a screen registry by static analysis of every source file,
 *      detecting both the JSX form (`<Stack.Screen name="..." component={...}/>`)
 *      and the static-config form (`createNativeStackNavigator({ screens })`).
 *   2. Synthesizes a routePath of the form `screen:<Name>` per screen — a
 *      non-empty, schema-valid string namespaced away from Expo/Next `/paths`.
 *
 * Exports the adapter interface documented in ./shared.mjs:
 *   framework            string    — "react-navigation"
 *   discoverRoutes       (cwd, framework) -> Route[]
 *   extractNavigations   (ast, source, filePath, ctx) -> Nav[]
 *   resolveTarget        (nav, routes) -> { targetId } | { targetId: null, syntheticScreen }
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  traverse,
  parseSource,
  extractImports,
  resolveString,
  jsxTagName,
  discoverSources,
  resolveImportToFile,
  hashId,
} from "./shared.mjs";

export const framework = "react-navigation";

// ─────────────────────────────────────────────────────────────────────────────
// React Navigation heuristics
// ─────────────────────────────────────────────────────────────────────────────
/** Navigator factory call names: createNativeStackNavigator, createBottomTabNavigator, etc. */
const NAVIGATOR_FACTORY_RE = /^create.*(Stack|Tab|Drawer)?Navigator$/;
/** Methods on a navigation object that carry a static screen-name target. */
const NAV_PUSH_METHODS = new Set([
  "navigate",
  "push",
  "navigateDeprecated",
  "popTo",
]);
const NAV_REPLACE_METHODS = new Set(["replace"]);
/** Fallback heuristic names for navigation objects. */
const NAV_NAME_HEURISTIC = new Set(["navigation", "nav", "navigationRef"]);
/** @react-navigation/* import sources are gated by this prefix. */
const RN_PACKAGE_PREFIX = "@react-navigation/";

// ─────────────────────────────────────────────────────────────────────────────
// Route discovery — build the screen registry
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Scan ALL source files for screen registrations and synthesize one Route per
 * registered screen. Two registration forms are supported (see module header).
 * Returns Route[], de-duplicated by routePath.
 */
export async function discoverRoutes(cwd, _framework) {
  const sources = await discoverSources(cwd);
  // routePath → Route
  const registry = new Map();

  for (const file of sources) {
    let source;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    let ast;
    try {
      ast = parseSource(source);
    } catch {
      // Parse error — skip this file.
      continue;
    }

    const imports = extractImports(ast);
    // Map of local identifier name → import specifier source string, so a
    // `component` identifier can be resolved back to a file.
    const importSourceByLocal = new Map();
    for (const imp of imports) {
      for (const s of imp.specifiers) {
        importSourceByLocal.set(s.local, imp.source);
      }
    }

    /** Register one screen entry; resolves the component identifier to a file. */
    async function register(screenName, componentLocalName) {
      if (typeof screenName !== "string" || screenName.length === 0) return;
      const routePath = "screen:" + screenName;
      if (registry.has(routePath)) return; // de-dupe by routePath

      let absolutePath = null;
      let filePath = "<unresolved>";
      if (componentLocalName) {
        const spec = importSourceByLocal.get(componentLocalName);
        if (spec) {
          const resolved = await resolveImportToFile(cwd, file, spec).catch(
            () => null,
          );
          if (resolved) {
            absolutePath = resolved;
            filePath = path.relative(cwd, resolved).replaceAll(path.sep, "/");
          }
        }
      }
      registry.set(routePath, {
        id: hashId(routePath),
        routePath,
        filePath,
        absolutePath,
        componentName: screenName,
        metadata: { title: screenName },
      });
    }

    // Collect (screenName, componentLocalName) pairs synchronously, then resolve
    // their files afterwards (traverse visitors must be synchronous).
    const pending = [];

    traverse(ast, {
      // ── Form (A): <X.Screen name="Home" component={HomeScreen} /> ──────────
      JSXOpeningElement(p) {
        const node = p.node.name;
        // Match <X.Screen> for ANY X (Stack/Tab/Drawer/RootStack/custom).
        if (
          node?.type !== "JSXMemberExpression" ||
          node.property?.type !== "JSXIdentifier" ||
          node.property.name !== "Screen"
        ) {
          return;
        }
        let screenName = null;
        let componentLocal = null;
        for (const attr of p.node.attributes) {
          if (attr.type !== "JSXAttribute" || !attr.name?.name) continue;
          if (attr.name.name === "name") {
            const v = attr.value;
            if (v?.type === "StringLiteral") screenName = v.value;
          } else if (attr.name.name === "component") {
            const v = attr.value;
            if (
              v?.type === "JSXExpressionContainer" &&
              v.expression?.type === "Identifier"
            ) {
              componentLocal = v.expression.name;
            }
          }
        }
        if (screenName) pending.push([screenName, componentLocal]);
      },

      // ── Form (B): createXNavigator({ screens: { ... } }) ───────────────────
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee?.type !== "Identifier") return;
        const isNavigatorFactory = NAVIGATOR_FACTORY_RE.test(callee.name);
        const isStaticNav = callee.name === "createStaticNavigation";
        if (!isNavigatorFactory && !isStaticNav) return;
        const arg0 = p.node.arguments[0];
        if (arg0?.type !== "ObjectExpression") return;
        walkConfigObject(arg0, pending);
      },
    });

    for (const [screenName, componentLocal] of pending) {
      await register(screenName, componentLocal);
    }
  }

  return [...registry.values()];
}

/**
 * Walk a navigator static-config ObjectExpression, collecting screen entries
 * into `out` as [screenName, componentLocalName|null] pairs.
 *
 * Handles the `screens` property and nested `groups.*.screens`. Each screen
 * value may be an Identifier (component), an ObjectExpression with a `screen`
 * property (component), or a nested ObjectExpression with its own `screens`
 * (recurse). Anything computed at runtime is silently skipped.
 */
function walkConfigObject(objExpr, out) {
  for (const prop of objExpr.properties ?? []) {
    if (prop.type !== "ObjectProperty") continue;
    const key = staticKeyName(prop.key);
    if (key === "screens" && prop.value?.type === "ObjectExpression") {
      walkScreensObject(prop.value, out);
    } else if (key === "groups" && prop.value?.type === "ObjectExpression") {
      // groups: { GroupA: { screens: {...} }, ... }
      for (const groupProp of prop.value.properties ?? []) {
        if (
          groupProp.type === "ObjectProperty" &&
          groupProp.value?.type === "ObjectExpression"
        ) {
          walkConfigObject(groupProp.value, out);
        }
      }
    }
  }
}

/** Walk a `screens` ObjectExpression: each key is a screen name. */
function walkScreensObject(screensObj, out) {
  for (const prop of screensObj.properties ?? []) {
    if (prop.type !== "ObjectProperty") continue;
    const screenName = staticKeyName(prop.key);
    if (!screenName) continue; // dynamic/computed key — skip silently
    const value = prop.value;
    if (value?.type === "Identifier") {
      // Home: HomeScreen
      out.push([screenName, value.name]);
    } else if (value?.type === "ObjectExpression") {
      // Either { screen: ProfileScreen } or a nested navigator { screens: {...} }
      const screenProp = value.properties.find(
        (pr) => pr.type === "ObjectProperty" && staticKeyName(pr.key) === "screen",
      );
      const nestedScreens = value.properties.find(
        (pr) => pr.type === "ObjectProperty" && staticKeyName(pr.key) === "screens",
      );
      if (screenProp?.value?.type === "Identifier") {
        out.push([screenName, screenProp.value.name]);
      } else if (screenProp) {
        // screen present but computed — register the name with no component.
        out.push([screenName, null]);
      } else {
        // No `screen` key. Register the name itself (it is still a route),
        // and recurse into any nested `screens` for child navigators.
        out.push([screenName, null]);
      }
      if (nestedScreens?.value?.type === "ObjectExpression") {
        walkScreensObject(nestedScreens.value, out);
      }
    }
    // Anything else (computed component, .map() result) — skip silently.
  }
}

/** Return the static string name of an ObjectProperty key, or null if dynamic. */
function staticKeyName(keyNode) {
  if (!keyNode) return null;
  if (keyNode.type === "Identifier") return keyNode.name;
  if (keyNode.type === "StringLiteral") return keyNode.value;
  if (keyNode.type === "NumericLiteral") return String(keyNode.value);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation extraction
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns: Nav[] = Array<{ kind, urlValue, urlText, confidence, line }>
 * ctx = { imports } — imports as returned by shared.extractImports(ast).
 *
 * nav.kind is mapped onto the four schema-valid kinds:
 *   navigate/push/navigateDeprecated/popTo → "router-push"
 *   replace                                → "router-replace"
 *   <Link to/screen> / linkTo(path)        → "link"
 */
export function extractNavigations(ast, source, filePath, ctx) {
  const navigations = [];

  // ── Import gate ───────────────────────────────────────────────────────────
  // Local names imported from any @react-navigation/* package.
  const linkComponentNames = new Set(); // local name for `Link`
  const linkToFnNames = new Set(); // local name for `useLinkTo`/`linkTo`
  const commonActionsNames = new Set(); // local name for `CommonActions`
  let hasReactNavigationImport = false;

  for (const imp of ctx?.imports ?? []) {
    if (!imp.source.startsWith(RN_PACKAGE_PREFIX)) continue;
    hasReactNavigationImport = true;
    for (const s of imp.specifiers) {
      if (s.kind === "named") {
        if (s.imported === "Link") linkComponentNames.add(s.local);
        if (s.imported === "useLinkTo" || s.imported === "linkTo") {
          linkToFnNames.add(s.local);
        }
        if (s.imported === "CommonActions") commonActionsNames.add(s.local);
      } else if (s.kind === "default" && imp.source === RN_PACKAGE_PREFIX + "native") {
        // Defensive: a default-imported Link is unusual, but keep nothing here.
      }
    }
  }

  // ── Navigation-object bindings ────────────────────────────────────────────
  // Identifiers bound to a navigation object (useNavigation() result, a
  // `{ navigation }` destructured component param, or a heuristic name).
  const navBindings = new Set(NAV_NAME_HEURISTIC);
  // Identifiers bound to a useLinkTo() result, so `linkTo(...)` can be detected
  // even when the call result is assigned to a renamed variable.
  const linkToBindings = new Set(linkToFnNames);

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
   * Resolve a navigation target argument to a resolveString-like result.
   * Accepts a string-literal screen name or an ObjectExpression carrying a
   * `name`/`screen` property. Returns null when no static target is present.
   */
  function resolveTargetArg(arg, scope, objectKey) {
    if (!arg) return null;
    if (arg.type === "ObjectExpression") {
      const prop = arg.properties.find(
        (pr) =>
          pr.type === "ObjectProperty" && staticKeyName(pr.key) === objectKey,
      );
      if (!prop) return null;
      return resolveString(prop.value, scope, source);
    }
    return resolveString(arg, scope, source);
  }

  traverse(ast, {
    VariableDeclarator(p) {
      const init = p.node.init;
      if (init?.type !== "CallExpression") return;
      const callee = init.callee;
      if (callee?.type !== "Identifier") return;
      // const navigation = useNavigation();
      if (callee.name === "useNavigation" && p.node.id?.type === "Identifier") {
        navBindings.add(p.node.id.name);
      }
      // const linkTo = useLinkTo();
      if (
        (callee.name === "useLinkTo" || linkToFnNames.has(callee.name)) &&
        p.node.id?.type === "Identifier"
      ) {
        linkToBindings.add(p.node.id.name);
      }
    },

    // A screen component whose params destructure { navigation }.
    Function(p) {
      collectNavParam(p.node, navBindings);
    },
    ArrowFunctionExpression(p) {
      collectNavParam(p.node, navBindings);
    },
    FunctionDeclaration(p) {
      collectNavParam(p.node, navBindings);
    },

    // ── <Link to={{screen:'Home'}}> / <Link screen="Home"> ──────────────────
    JSXOpeningElement(p) {
      const tag = jsxTagName(p.node.name);
      if (!tag || !linkComponentNames.has(tag)) return;
      // <Link screen="Home" />
      const screenAttr = p.node.attributes.find(
        (a) => a.type === "JSXAttribute" && a.name?.name === "screen",
      );
      if (screenAttr) {
        const v = screenAttr.value;
        if (v?.type === "StringLiteral") {
          emit(
            "link",
            { value: v.value, text: v.value, confidence: 1.0, kind: "static" },
            screenAttr,
          );
          return;
        }
        if (v?.type === "JSXExpressionContainer") {
          emit("link", resolveString(v.expression, p.scope, source), screenAttr);
          return;
        }
      }
      // <Link to={{ screen: 'Home' }} />  or  <Link to="/path" />
      const toAttr = p.node.attributes.find(
        (a) => a.type === "JSXAttribute" && a.name?.name === "to",
      );
      if (!toAttr) return;
      const v = toAttr.value;
      if (v?.type === "StringLiteral") {
        // to="/path" — a path string, best-effort lower confidence.
        emit(
          "link",
          { value: v.value, text: v.value, confidence: 0.7, kind: "path" },
          toAttr,
        );
        return;
      }
      if (v?.type === "JSXExpressionContainer") {
        const expr = v.expression;
        if (expr?.type === "ObjectExpression") {
          emit("link", resolveTargetArg(expr, p.scope, "screen"), toAttr);
          return;
        }
        // to={someVar} — string-ish, treat as path best-effort.
        emit("link", resolveString(expr, p.scope, source), toAttr);
      }
    },

    CallExpression(p) {
      const callee = p.node.callee;
      const arg0 = p.node.arguments[0];

      // ── navObj.navigate('Home') / .push / .replace / etc. ─────────────────
      if (callee.type === "MemberExpression" && callee.property?.type === "Identifier") {
        const method = callee.property.name;
        const obj = callee.object;

        // CommonActions.navigate('Home' | {name:'Home'})
        if (
          obj?.type === "Identifier" &&
          (commonActionsNames.has(obj.name) || obj.name === "CommonActions") &&
          method === "navigate"
        ) {
          emit("router-push", resolveTargetArg(arg0, p.scope, "name"), p.node);
          return;
        }

        // navObj.<method>(...)
        const isNavObj =
          obj?.type === "Identifier" && navBindings.has(obj.name);
        // Also accept useNavigation().navigate('Home')
        const isNavCall =
          obj?.type === "CallExpression" &&
          obj.callee?.type === "Identifier" &&
          obj.callee.name === "useNavigation";
        if (isNavObj || isNavCall) {
          if (NAV_PUSH_METHODS.has(method)) {
            emit("router-push", resolveTargetArg(arg0, p.scope, "name"), p.node);
            return;
          }
          if (NAV_REPLACE_METHODS.has(method)) {
            emit(
              "router-replace",
              resolveTargetArg(arg0, p.scope, "name"),
              p.node,
            );
            return;
          }
          // goBack / pop / popToTop — no static target, skip silently.
        }
        return;
      }

      // ── linkTo('/path') ───────────────────────────────────────────────────
      if (callee.type === "Identifier" && linkToBindings.has(callee.name)) {
        // Guard against false positives when nothing was imported from
        // @react-navigation/*: only trust an explicit binding/import.
        if (hasReactNavigationImport || linkToFnNames.size > 0) {
          emit("link", resolveString(arg0, p.scope, source), p.node);
        }
        return;
      }
    },
  });

  return navigations;
}

/**
 * If a function's first param is an ObjectPattern containing a `navigation`
 * property, add `navigation`'s local name to navBindings.
 */
function collectNavParam(fnNode, navBindings) {
  const param = fnNode?.params?.[0];
  if (param?.type !== "ObjectPattern") return;
  for (const prop of param.properties) {
    if (prop.type !== "ObjectProperty") continue;
    if (prop.key?.type === "Identifier" && prop.key.name === "navigation") {
      // Local name is the value pattern's name when renamed, else `navigation`.
      if (prop.value?.type === "Identifier") {
        navBindings.add(prop.value.name);
      } else {
        navBindings.add("navigation");
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Target resolution — match by exact screen name
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Resolve a Nav to a target screen.
 *
 * nav.urlValue is a screen NAME (for navigate/push/replace/Link) or a path
 * (for linkTo path-form). Matching:
 *   - Exact screen-name match against a registered route → { targetId }.
 *   - No match, value looks like a screen name → return a fully-described
 *     { targetId: null, syntheticScreen } (orchestrator dedupes by routePath).
 *   - No match, value is a path ("/..." form) → { targetId: null } so the
 *     orchestrator builds a standard `unknown:/path` synthetic.
 *   - Unresolvable value → { targetId: null }.
 */
export function resolveTarget(nav, routes) {
  const value = nav?.urlValue;
  if (value == null || value === "") return { targetId: null };

  const isPath = value.startsWith("/");
  if (!isPath) {
    const wanted = "screen:" + value;
    for (const r of routes) {
      if (r.routePath === wanted) return { targetId: r.id };
    }
    // Unresolved screen name — fully describe the synthetic target so the
    // orchestrator dedupes by routePath and uses it directly.
    const routePath = "unknown:screen:" + value;
    return {
      targetId: null,
      syntheticScreen: {
        id: hashId(routePath),
        routePath,
        filePath: "<unknown>",
        componentName: value,
        metadata: null,
      },
    };
  }

  // Path form (linkTo('/path') / <Link to="/path">): no screen registry
  // matches paths. Let the orchestrator build a standard unknown:/path synth.
  return { targetId: null };
}
