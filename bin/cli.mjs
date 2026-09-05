#!/usr/bin/env node
/**
 * Flowmap plugin CLI.
 *
 * Subcommands:
 *   login        OAuth device flow + token save
 *   logout       Revoke + delete token
 *   status       Show login + last sync state
 *   visualize    Analyze + (optional) screenshot + sync + return view URL
 *
 * All output for the `visualize` command finishes with a single JSON line on
 * stdout so the calling Skill (Claude) can parse it deterministically.
 */
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as auth from "./auth.mjs";
import { analyze } from "./analyze.mjs";
import { captureScreenshots } from "./screenshot.mjs";
import { ensureProject, syncSnapshot } from "./sync.mjs";

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_PKG = JSON.parse(
  await fs.readFile(path.join(PLUGIN_ROOT, "package.json"), "utf8"),
);

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
  switch (cmd) {
    case "login":
      await runLogin(args);
      break;
    case "logout":
      await runLogout();
      break;
    case "status":
      await runStatus(args);
      break;
    case "analyze":
      await runAnalyzeOnly(args);
      break;
    case "visualize":
      await runVisualize(args);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
  }
} catch (err) {
  console.error("✕", err?.message ?? err);
  if (process.env.FLOWMAP_DEBUG) console.error(err?.stack);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
async function runLogin(args) {
  const apiBase = args["api-base"] ?? auth.DEFAULT_API_BASE;
  const result = await auth.login({ apiBase });
  if (result.ok) {
    console.log(`✓ Logged in. Token saved.`);
    process.exit(0);
  }
  if (result.reason === "expired") {
    console.error("✕ Code expired. Please run /flowmap login again.");
    process.exit(2);
  }
  if (result.reason === "denied") {
    console.error("✕ Authorization denied.");
    process.exit(1);
  }
  console.error(`✕ Login failed: ${result.reason}`);
  process.exit(1);
}

async function runLogout() {
  await auth.logout();
  console.log("✓ Logged out.");
}

async function runStatus(args) {
  const s = await auth.status();
  if (args.json) {
    console.log(JSON.stringify(s));
    return;
  }
  if (!s.loggedIn) {
    console.error("✕ Not logged in. Run /flowmap login.");
    process.exit(1);
  }
  console.log(`▸ Logged in   (api: ${s.apiBase})`);
  console.log(`▸ Token expires ${s.expiresAt}`);
}

async function runVisualize(args) {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const devServerUrl = args["dev-server"] ?? "http://localhost:3000";

  const tokenStatus = await auth.status();
  if (!tokenStatus.loggedIn) {
    console.error("✕ Not logged in. Run /flowmap login first.");
    process.exit(1);
  }

  process.stderr.write(`▸ Analyzing ${cwd} ...\n`);
  const t0 = Date.now();
  // `.flowmap/config.json` may also say what a URL fragment stands for, so a
  // `${base}/chat` resolves to real screens instead of a dead end; see
  // `aliases` in the help text.
  const config = await readFlowmapConfig(cwd);
  const { manifest, stats } = await analyze(cwd, {
    devServerUrl,
    aliases: config?.aliases,
  });
  process.stderr.write(
    `✓ ${stats.routes} routes, ${stats.edges} edges (${stats.unresolvedEdges} unresolved) — ${Date.now() - t0}ms\n`,
  );

  // Merge AI-drafted screen descriptions. The `visualize` Skill writes these
  // into .flowmap/descriptions.json after reading the local source; only the
  // resulting text is uploaded — never the source code itself.
  const descriptions =
    (await readJsonSafe(path.join(cwd, ".flowmap", "descriptions.json"))) ?? {};
  let describedCount = 0;
  for (const s of manifest.screens) {
    const text = descriptions[s.routePath];
    if (typeof text === "string" && text.trim()) {
      s.aiDescription = text.trim().slice(0, 2000);
      describedCount++;
    }
  }
  if (describedCount > 0) {
    process.stderr.write(`✓ ${describedCount} screen descriptions merged\n`);
  }

  // Ensure project (idempotent via fingerprint)
  const fingerprint = await deriveFingerprint(cwd);
  const projectName = path.basename(cwd);
  const { projectId, reused } = await ensureProject({
    cwd,
    name: projectName,
    fingerprint,
  });
  process.stderr.write(`${reused ? "▸" : "✓"} Project ${projectId.slice(0, 8)}…  (${reused ? "reused" : "created"})\n`);

  // Screenshots — best effort. Not possible for React Native: puppeteer drives
  // a web browser, and Expo Router / React Navigation apps have no web target.
  const RN_FRAMEWORKS = new Set(["expo-router", "react-navigation"]);
  let shots = [];
  let fontFaces = "";
  if (RN_FRAMEWORKS.has(stats.framework)) {
    process.stderr.write(
      `⚠ Screenshots skipped: React Native (${stats.framework}) has no web target — metadata-only sync\n`,
    );
  } else if (!args["no-screenshots"]) {
    process.stderr.write(`▸ Capturing screenshots from ${devServerUrl} ...\n`);
    const cap = await captureScreenshots({
      devServerUrl,
      screens: manifest.screens,
      viewports: ["desktop", "mobile"],
      // `.flowmap/config.json` may name a URL per dynamic route; see
      // screenshot.mjs for why discovery alone is not always enough.
      sampleUrls: config?.routeSamples ?? {},
    });
    if (cap.skipped) {
      process.stderr.write(`⚠ Screenshots skipped: ${cap.reason}\n`);
    } else {
      shots = cap.shots;
      fontFaces = cap.fontFaces ?? "";
      const ok = shots.filter((s) => !s.error).length;
      const failed = shots.length - ok;
      const scenes = shots.filter((s) => s.scene).length;
      process.stderr.write(`✓ ${ok} screenshots captured (${failed} failed)\n`);
      process.stderr.write(`✓ ${scenes} editable scenes captured\n`);
    }
  }

  // Sync
  process.stderr.write(`▸ Syncing to ${tokenStatus.apiBase} ...\n`);
  const result = await syncSnapshot({
    projectId,
    manifest,
    screenshots: shots,
    fontFaces,
    pluginVersion: PLUGIN_PKG.version,
  });

  // Persist last sync
  const lastSync = {
    syncedAt: new Date().toISOString(),
    routes: stats.routes,
    edges: stats.edges,
    unresolvedEdges: stats.unresolvedEdges,
    viewUrl: result.view_url,
    snapshotId: result.snapshot_id,
  };
  await fs.writeFile(
    path.join(cwd, ".flowmap", "last-sync.json"),
    JSON.stringify(lastSync, null, 2),
  );

  // Final JSON result line for the Skill to parse
  const out = {
    projectId,
    snapshotId: result.snapshot_id,
    viewUrl: result.view_url,
    routes: stats.routes,
    edges: stats.edges,
    unresolvedEdges: stats.unresolvedEdges,
    descriptions: describedCount,
    screenshotsUploaded: result.uploaded_screenshots ?? 0,
    screenshotsReused: result.reused_screenshots ?? 0,
    scenesUploaded: result.uploaded_scenes ?? 0,
    scenesReused: result.reused_scenes ?? 0,
    framework: stats.framework,
  };
  console.log(JSON.stringify(out));
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Analyze only — write .flowmap/manifest.json and report which routes still
 * need an AI description. Used by the `visualize` Skill as a first pass: it
 * reads `needsDescriptions`, drafts descriptions from the local source, saves
 * them to .flowmap/descriptions.json, then runs the full `visualize`.
 */
async function runAnalyzeOnly(args) {
  const cwd = path.resolve(args.cwd ?? process.cwd());
  process.stderr.write(`▸ Analyzing ${cwd} ...\n`);
  const { manifest, stats } = await analyze(cwd, {
    aliases: (await readFlowmapConfig(cwd))?.aliases,
  });

  const flowmapDir = path.join(cwd, ".flowmap");
  await fs.mkdir(flowmapDir, { recursive: true });
  await fs.writeFile(
    path.join(flowmapDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  // Skip synthetic targets (unknown:/external:) and routes already cached.
  const existing =
    (await readJsonSafe(path.join(flowmapDir, "descriptions.json"))) ?? {};
  const needsDescriptions = manifest.screens
    .filter(
      (s) =>
        !s.routePath.startsWith("unknown:") &&
        !s.routePath.startsWith("external:") &&
        // React Navigation screens whose component file couldn't be resolved
        // statically have no real file for the Skill to read.
        s.filePath !== "<unresolved>" &&
        !(existing[s.routePath] && String(existing[s.routePath]).trim()),
    )
    .map((s) => ({
      routePath: s.routePath,
      filePath: s.filePath,
      componentName: s.componentName ?? null,
    }));

  process.stderr.write(
    `✓ ${stats.routes} routes — ${needsDescriptions.length} need descriptions\n`,
  );
  console.log(
    JSON.stringify({
      manifestPath: ".flowmap/manifest.json",
      descriptionsPath: ".flowmap/descriptions.json",
      routes: stats.routes,
      needsDescriptions,
    }),
  );
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function deriveFingerprint(cwd) {
  // Prefer the git remote origin URL; else fall back to absolute path.
  try {
    const config = await fs.readFile(path.join(cwd, ".git", "config"), "utf8");
    const m = config.match(/url\s*=\s*(\S+)/);
    if (m) return `git:${m[1]}`;
  } catch {
    // not a git repo
  }
  return `path:${path.basename(cwd)}@${os.hostname()}`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * The project's own `.flowmap/config.json`.
 *
 * Written by `ensureProject` to hold the project id; anything else in it is the
 * developer's, and read from here. Missing or unreadable is not an error — the
 * file is optional and a malformed one should not stop a sync.
 */
async function readFlowmapConfig(cwd) {
  try {
    const raw = await fs.readFile(path.join(cwd, ".flowmap", "config.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`flowmap ${PLUGIN_PKG.version}

Usage:
  flowmap login [--api-base URL]
  flowmap logout
  flowmap status [--json]
  flowmap analyze [--cwd PATH]
  flowmap visualize [--cwd PATH] [--dev-server URL] [--no-screenshots]

The plugin is invoked via Claude Code skills:
  /flowmap login
  /flowmap visualize
  /flowmap status
  /flowmap logout

.flowmap/config.json (optional, yours to edit):
  routeSamples  a real URL per dynamic route, so it can be captured
                  { "/s/chat/[id]": ["/s/chat/42"] }
  aliases       what a URL fragment stands for, so a navigation built from a
                variable resolves to real screens instead of a dead end
                  { "useRoleBase": ["/s", "/t"] }
                Name the function a value comes from where you can — a variable
                called \`base\` means something different in every other file.
`);
}
