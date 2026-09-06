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

/**
 * Glob to RegExp, for matching a request URL against a mock rule.
 *
 * `*` stops at a path separator and `**` does not, which is the distinction
 * that lets `**\/chats/*` mean "any host, one chat" rather than "everything".
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The session a capture runs under.
 *
 * A real app does not render its screens to a stranger. dokitalk's dynamic
 * routes all came back as a spinner or, worse, as the onboarding screen
 * wearing another route's name: the page starts drawing, asks the API who the
 * user is, gets a 401, and redirects. Waiting longer only made the wrong
 * screen more certain.
 *
 * So the capture gets a session of its own — a token in storage, and canned
 * answers for the calls the screens make — declared in the project's config
 * and used for nothing but this. Rules are tried in order and the first match
 * answers; anything unmatched goes to the network as usual.
 */
/**
 * Count the requests a page still has outstanding.
 *
 * Must be attached before the first navigation, since the interesting requests
 * start with it.
 */
function watchRequests(page) {
  const open = new Set();
  page.on("request", (r) => open.add(r));
  const close = (r) => open.delete(r);
  page.on("requestfinished", close);
  page.on("requestfailed", close);
  return () => open.size;
}

/**
 * Wait for the page to finish, rather than for a fixed delay.
 *
 * A flat 400ms was a race the capture kept losing differently each run: the
 * same route came back as a nine-node spinner one time and a full screen the
 * next, because whether the first render had painted was pure timing.
 *
 * A settled DOM alone is not the answer either, and believing it was cost a
 * whole sync. A page waiting on a fetch holds perfectly still — one screen sat
 * at 61 nodes from 400ms to 1500ms and only then became 111 — so two equal
 * readings arrive long before the screen does, and every route came back as
 * its loading shell.
 *
 * Finished means both: nothing outstanding on the network, and a tree that has
 * stopped changing since — held for several samples running, not seen once.
 * A single quiet reading is not enough, because the quietest moment of all is
 * the one before the work starts: with two pages sharing a dev server, one
 * would be sampled after its shell painted and before React had fired a
 * request, and captured as sixteen nodes of nothing. Anything the page is
 * about to do begins well inside the streak and resets it.
 *
 * A page that never reaches that (a spinner animating nodes in and out, a poll
 * on a timer, an open socket) hits the ceiling and is captured as it is, which
 * is all that can be said about it.
 */
async function settle(page, inFlight, { step = 250, quiet = 3, floor = 1200, ceiling = 10000 } = {}) {
  let previous = -1;
  let still = 0;
  for (let waited = step; waited <= ceiling; waited += step) {
    await new Promise((r) => setTimeout(r, step));
    let count;
    try {
      count = await page.evaluate(() => document.getElementsByTagName("*").length);
    } catch {
      return; // navigated away mid-poll; the next read would be meaningless
    }
    const idle = (!inFlight || inFlight() === 0) && count === previous;
    still = idle ? still + 1 : 0;
    previous = count;
    if (still >= quiet && waited >= floor) return;
  }
}

async function prepareSession(page, session, unmocked) {
  if (!session) return;
  const { localStorage: seed, cookies, mocks } = session;

  if (seed && Object.keys(seed).length > 0) {
    // Before the document's own scripts, so the first thing the app's auth
    // check reads is already there. Setting it after the load is too late —
    // the redirect has usually fired by then.
    await page.evaluateOnNewDocument((entries) => {
      try {
        for (const [key, value] of entries) window.localStorage.setItem(key, value);
      } catch {
        // A page served from about:blank or a sandbox has no storage; the
        // capture is still worth taking without it.
      }
    }, Object.entries(seed).map(([k, v]) => [k, String(v)]));
  }

  if (Array.isArray(cookies) && cookies.length > 0) {
    try {
      await page.setCookie(...cookies);
    } catch {
      // A malformed cookie should cost that cookie, not the screenshot.
    }
  }

  if (!Array.isArray(mocks) || mocks.length === 0) return;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    const method = request.method().toUpperCase();
    const rule = mocks.find(
      (m) => (!m.method || m.method.toUpperCase() === method) && m.pattern.test(url),
    );
    if (!rule) {
      // Note what the screens asked for and did not get. Defeating the login
      // is only half of a rendered screen — the other half is the screen's own
      // data, and a developer cannot write a fixture for a call they cannot
      // see. Reported at the end of the capture as the list to fill in.
      const kind = request.resourceType();
      if (kind === "xhr" || kind === "fetch") {
        unmocked?.add(`${method} ${url.replace(/[?#].*$/, "")}`);
      }
      request.continue().catch(() => {});
      return;
    }
    request
      .respond({
        status: rule.status ?? 200,
        contentType: rule.contentType ?? "application/json",
        headers: {
          // The screens call another origin; without this the browser rejects
          // the answer before the app ever sees it.
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
        body: rule.body,
      })
      .catch(() => {});
  });
}

/*
 * One page at a time.
 *
 * Two was faster and wrong. With two pages sharing a dev server, one of them
 * came back as its sixteen-node shell — a different one each run, sometimes
 * the desktop capture and sometimes the mobile — while the same route captured
 * alone was complete every time. The server compiles a route on first request,
 * and under a second concurrent visit that page can be left never finishing
 * its hydration.
 *
 * No amount of waiting fixes it: the stalled page is genuinely quiet, with
 * nothing outstanding and nothing changing, so it looks finished. A sync runs
 * occasionally and its output is the whole product; taking twice as long to be
 * reproducible is the easy side of that trade.
 */
export async function captureScreenshots({ devServerUrl, screens, viewports = ["desktop", "mobile"], timeout = 8000, concurrency = 1, samplesPerRoute = 1, sampleUrls = {}, session = null }) {
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
  /** API calls the screens made that no mock answered. */
  const unmocked = new Set();
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
        const inFlight = watchRequests(page);
        await prepareSession(page, session, unmocked);
        await page.setViewport(VIEWPORTS[viewport]);
        const url = `${devServerUrl.replace(/\/$/, "")}${routePath}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        await settle(page, inFlight);
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
    unmocked: [...unmocked].sort(),
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
