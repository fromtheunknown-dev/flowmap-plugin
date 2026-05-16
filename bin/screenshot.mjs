/**
 * Screenshot capture against the user's already-running dev server.
 * Uses puppeteer-core + system Chromium / Chrome (no bundled binary).
 *
 * Skips dynamic routes ([param], [...slug]) for V1 — they require sample data.
 * Skips synthetic "unknown:" / "external:" routes from the analyzer.
 */
import { existsSync } from "node:fs";

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

export async function captureScreenshots({ devServerUrl, screens, viewports = ["desktop", "mobile"], timeout = 8000, concurrency = 2 }) {
  const browserExe = findBrowserExecutable();
  if (!browserExe) {
    return { skipped: true, reason: "no-browser", shots: [] };
  }
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default ?? (await import("puppeteer-core"));
  } catch {
    return { skipped: true, reason: "puppeteer-core not installed", shots: [] };
  }

  // Health check
  try {
    const r = await fetch(devServerUrl, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok && r.status !== 404 && r.status !== 401 && r.status !== 307) {
      // 404/401/307 are still proof the server is up
    }
  } catch (err) {
    return { skipped: true, reason: `dev server unreachable at ${devServerUrl}: ${err.message}`, shots: [] };
  }

  const browser = await puppeteer.launch({
    executablePath: browserExe,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  // Filter targets: skip dynamic and synthetic
  const targets = screens.filter((s) =>
    s.routePath.startsWith("/") &&
    !/\[/.test(s.routePath),
  );

  const shots = [];
  let pending = targets.flatMap((s) => viewports.map((vp) => ({ screen: s, viewport: vp })));

  async function worker() {
    while (pending.length) {
      const job = pending.shift();
      if (!job) return;
      const { screen, viewport } = job;
      try {
        const page = await browser.newPage();
        await page.setViewport(VIEWPORTS[viewport]);
        const url = `${devServerUrl.replace(/\/$/, "")}${screen.routePath}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        // small settle delay so client-side hydration paints
        await new Promise((r) => setTimeout(r, 400));
        const buf = await page.screenshot({ type: "png", fullPage: false });
        shots.push({ screenId: screen.id, viewport, buffer: buf });
        await page.close();
      } catch (err) {
        // Skip this one but don't fail the run
        shots.push({ screenId: screen.id, viewport, error: err.message ?? "unknown" });
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker());
  await Promise.all(workers);

  await browser.close();
  return { skipped: false, shots };
}
