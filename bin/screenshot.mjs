/**
 * Screenshot capture against the user's already-running dev server.
 * Uses puppeteer-core + system Chromium / Chrome (no bundled binary).
 *
 * Each page visit yields two artefacts: the PNG, and the scene graph behind it
 * (see snapshot.mjs). They are captured from the same paint so they can never
 * disagree, and one navigation pays for both. A scene that fails to capture is
 * dropped rather than propagated — the screenshot is still worth uploading.
 *
 * Dynamic routes are captured from real URLs, found two ways.
 *
 * `/s/chat/[id]` cannot be opened without an id, and inventing one produces a
 * not-found page rather than the screen. The static pages just captured are
 * usually full of real ones — a chat list links to real chats — so their hrefs
 * are collected during the first pass and matched against the patterns
 * afterwards.
 *
 * That finds nothing in an app that navigates with `router.push` instead of
 * links, or one whose lists are empty because the dev server has no backend
 * behind it. Both are ordinary, so `sampleUrls` lets the developer name a URL
 * per pattern in `.flowmap/config.json` and always works:
 *
 *     { "routeSamples": { "/s/chat/[id]": ["/s/chat/42"] } }
 *
 * Skips synthetic "unknown:" / "external:" routes from the analyzer.
 */
import { existsSync } from "node:fs";
import { captureSceneGraph } from "./snapshot.mjs";

const VIEWPORTS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  mobile: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Arc.app/Contents/MacOS/Arc",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

function findBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = CHROME_PATHS[process.platform] ?? [];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function captureScreenshots({ devServerUrl, screens, viewports = ["desktop", "mobile"], timeout = 8000, concurrency = 2, samplesPerRoute = 1, sampleUrls = {} }) {
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    return { skipped: true, reason: "no-browser", shots: [], fontFaces: "" };
  }
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default ?? (await import("puppeteer-core"));
  } catch {
    return { skipped: true, reason: "puppeteer-core not installed", shots: [], fontFaces: "" };
  }

  // Health check
  try {
    const r = await fetch(devServerUrl, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok && r.status !== 404 && r.status !== 401 && r.status !== 307) {
      // 404/401/307 are still proof the server is up
    }
  } catch (err) {
    return { skipped: true, reason: `dev server unreachable at ${devServerUrl}: ${err.message}`, shots: [], fontFaces: "" };
  }

  const browser = await puppeteer.launch({
    executablePath: browserExe,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  // Filter targets: skip dynamic and synthetic
  const isDynamic = (routePath) => /\[/.test(routePath);
  const staticScreens = screens.filter(
    (s) => s.routePath.startsWith("/") && !isDynamic(s.routePath),
  );
  const dynamicScreens = screens.filter(
    (s) => s.routePath.startsWith("/") && isDynamic(s.routePath),
  );

  const shots = [];
  /*
   * The stylesheet rules the scenes need, pooled across every page visited.
   *
   * This used to keep the first page's blob and drop the rest, on the theory
   * that a site's fonts are the same everywhere. They are — but the same blob
   * also carries each page's `:root` tokens and its rules for the inside of
   * form controls, and those are not. The match screen's
   * `::-webkit-slider-thumb` rules were collected and then thrown away because
   * a screen with no slider happened to be captured first, so its rebuilt
   * sliders had no thumbs however well the renderer behaved.
   *
   * Deduplicated by rule, so the fonts every page shares are still stored once.
   */
  const cssRules = new Set();
  /** Hrefs the captured pages linked to, for resolving dynamic routes. */
  const discovered = new Set();
  let pending = staticScreens.flatMap((s) =>
    viewports.map((vp) => ({ screen: s, viewport: vp })),
  );

  async function worker() {
    while (pending.length) {
      const job = pending.shift();
      if (!job) return;
      const { screen, viewport } = job;
      const routePath = job.url ?? screen.routePath;
      try {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORTS[viewport]);
        const url = `${devServerUrl.replace(/\/$/, "")}${routePath}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        // small settle delay so client-side hydration paints
        await new Promise((r) => setTimeout(r, 400));
        const buf = await page.screenshot({ type: "png", fullPage: false });

        let scene = null;
        try {
          const captured = await captureSceneGraph(page, VIEWPORTS[viewport]);
          scene = captured.scene;
          // Pooled, not replaced: see `cssRules`.
          for (const rule of (captured.fontFaces ?? "").split("\n")) {
            if (rule.trim()) cssRules.add(rule);
          }
        } catch {
          // Scene capture is additive: a screen without one is still viewable,
          // just not editable. Never let it cost us the screenshot.
        }

        // Same-origin links only, and without query or hash: a dynamic route is
        // identified by its path, and carrying the rest would capture the same
        // screen several times over.
        if (job.collectLinks) {
          try {
            const hrefs = await page.evaluate(() =>
              [...document.querySelectorAll("a[href]")]
                .map((a) => a.getAttribute("href"))
                .filter((href) => href && href.startsWith("/"))
                .map((href) => href.split(/[?#]/)[0]),
            );
            for (const href of hrefs) discovered.add(href);
          } catch {
            // A page that will not hand over its links still yields its shot.
          }
        }

        shots.push({
          screenId: screen.id,
          viewport,
          buffer: buf,
          scene,
          capturedPath: job.url ?? screen.routePath,
        });
        await page.close();
      } catch (err) {
        // Skip this one but don't fail the run
        shots.push({ screenId: screen.id, viewport, error: err.message ?? "unknown" });
      }
    }
  }

  // Pass 1: the routes that can be opened by name, collecting links as they go.
  for (const job of pending) job.collectLinks = true;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker()),
  );

  // Pass 2: dynamic routes. A URL the developer named wins over a discovered
  // one — they know which record makes the screen worth looking at.
  const resolved = [];
  const claimed = new Set();
  for (const screen of dynamicScreens) {
    for (const url of sampleUrls[screen.routePath] ?? []) {
      if (typeof url !== "string" || !url.startsWith("/")) continue;
      resolved.push({ screen, url });
      claimed.add(screen.routePath);
    }
  }
  resolved.push(
    ...matchDynamicRoutes(
      dynamicScreens.filter((s) => !claimed.has(s.routePath)),
      discovered,
      samplesPerRoute,
    ),
  );
  if (resolved.length > 0) {
    pending = resolved.flatMap((entry) =>
      viewports.map((vp) => ({ screen: entry.screen, viewport: vp, url: entry.url })),
    );
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()),
    );
  }

  await browser.close();
  return {
    skipped: false,
    shots,
    fontFaces: [...cssRules].join("\n"),
    resolvedDynamic: resolved.length,
  };
}


/**
 * Turns `/s/chat/[id]` into a URL the app actually linked to.
 *
 * Longest pattern first, so `/s/chat/[id]/settings` claims its own links before
 * `/s/chat/[id]` would swallow them — otherwise the more specific screen never
 * gets captured. A catch-all (`[...slug]`) matches the rest of the path;
 * everything else matches one segment.
 */
function matchDynamicRoutes(screens, hrefs, samplesPerRoute) {
  const patterns = [...screens]
    .sort((a, b) => b.routePath.split("/").length - a.routePath.split("/").length)
    .map((screen) => ({ screen, regex: toRegex(screen.routePath) }));

  const taken = new Set();
  const out = [];
  for (const { screen, regex } of patterns) {
    let found = 0;
    for (const href of hrefs) {
      if (found >= samplesPerRoute) break;
      if (taken.has(href) || !regex.test(href)) continue;
      taken.add(href);
      out.push({ screen, url: href });
      found++;
    }
  }
  return out;
}

function toRegex(routePath) {
  const source = routePath
    .split("/")
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return "(?:[^/]+/)*[^/]+";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}$`);
}
