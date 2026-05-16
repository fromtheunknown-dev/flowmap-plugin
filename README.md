# flowmap (Claude Code plugin)

Analyze your **Next.js, Expo Router, or React Native** project's screen flow and
sync it to flowmap.app.

Supported frameworks (auto-detected from `package.json` + project layout):

| Framework | Routes | Navigation edges |
|---|---|---|
| Next.js App / Pages Router | `app/**/page.*`, `pages/**` | `<Link>`, `router.push/replace`, `redirect`, `window.location` |
| Expo Router | file-based `app/**` (`index`, `[id]`, `(groups)`, `_layout`) | `<Link href>`, `<Redirect href>`, `router.push/replace/navigate` |
| React Native + React Navigation | code-registered screens (`<Stack.Screen>`, `create*Navigator({screens})`) | `navigation.navigate/push/replace/popTo`, `<Link to>`, `linkTo`, `CommonActions.navigate` |

## Install (development / local testing)

In Claude Code, point the `--plugin-dir` flag at this directory:

```
claude --plugin-dir /Users/hello/Desktop/projects/claude-vibecoder-visualization/plugins/flowmap
```

Then within that session:

```
/flowmap login
/flowmap visualize
/flowmap status
/flowmap logout
```

## What it captures

Per the "no miss" requirement:

| Pattern | Confidence |
|---|---|
| `<Link href="/x">`, `<a href="/x">`, `<NavLink href="/x">` | 1.0 |
| Template literal href: `<Link href={\`/post/${id}\`}>` | 0.85 |
| Identifier reference whose static binding is a string | 0.7 |
| Unresolvable expression (`<Link href={t.href}>`) | 0.4 → routed to a synthetic "unknown:..." screen so it shows up in the diagram |
| `router.push("/x")`, `router.replace("/x")` (next/navigation, next/router) | 1.0 / 0.85 |
| `redirect("/x")`, `permanentRedirect("/x")` (next/navigation) | 1.0 / 0.85 |
| `window.location.href = "/x"`, `assign("/x")`, `replace("/x")` | 1.0 / 0.85 |

Components imported by multiple pages produce one edge per importing page (1-hop static import graph traversal).

## What it does NOT do (V1)

- Multi-hop import graph (component imported by another component imported by a page → only 1 hop is followed)
- Vite + React Router, Remix, SvelteKit, Nuxt — Phase 2
- Server actions that internally redirect — caught only via `redirect()` calls, not via the form action prop
- **Screenshots for React Native** — Expo Router / React Navigation apps have no
  web target for puppeteer; RN syncs are metadata-only (routes + edges, no images)
- **React Navigation runtime-registered screens** — screens whose name or
  component is computed at runtime (e.g. `.map()` over a config) can't be
  resolved statically; unresolved targets become low-confidence `unknown:` nodes

## Files

```
.claude-plugin/plugin.json   plugin manifest
skills/                      Claude-invoked entry points
  login/SKILL.md
  visualize/SKILL.md
  status/SKILL.md
  logout/SKILL.md
bin/                         Node.js executables
  cli.mjs                    main dispatcher
  auth.mjs                   OAuth device flow + token storage
  analyze.mjs                framework detection + orchestration
  analyze/
    shared.mjs               framework-agnostic AST / import-graph infra
    nextjs.mjs               Next.js App + Pages Router adapter
    expo-router.mjs          Expo Router adapter
    react-navigation.mjs     React Native + React Navigation adapter
  screenshot.mjs             puppeteer-core capture (web frameworks only)
  sync.mjs                   API upload
package.json                 deps (@babel/parser, fast-glob, puppeteer-core)
```

## Local dev pointing at a self-hosted backend

```
FLOWMAP_API_BASE=http://localhost:3030 /flowmap visualize
```

Or once, baked into the token at login:

```
node bin/cli.mjs login --api-base http://localhost:3030
```

## Token storage

`~/.config/flowmap/token.json` (chmod 600). Delete to log out.
