/**
 * OAuth device-flow client + token storage.
 *
 * Token file: ~/.config/flowmap/token.json   (chmod 600)
 *   { access_token, refresh_token, expires_at, api_base, email? }
 *
 * Exports: login, logout, status, loadToken, ensureFreshToken, apiFetch
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const DEFAULT_API_BASE =
  process.env.FLOWMAP_API_BASE ?? "https://main.d7e1xpcc6umrt.amplifyapp.com";

const TOKEN_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "flowmap",
);
const TOKEN_FILE = path.join(TOKEN_DIR, "token.json");

export async function login({ apiBase = DEFAULT_API_BASE } = {}) {
  const initRes = await fetch(`${apiBase}/api/oauth/device`, { method: "POST" });
  if (!initRes.ok) throw new Error(`device init: ${initRes.status}`);
  const init = await initRes.json();
  const { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in } = init;

  process.stdout.write(
    JSON.stringify({
      kind: "device_prompt",
      user_code,
      verification_uri,
      verification_uri_complete,
      interval,
      expires_in,
    }) + "\n",
  );

  // Poll until success or expiration
  const pollIntervalMs = (interval ?? 5) * 1000;
  const deadline = Date.now() + (expires_in ?? 600) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const r = await fetch(`${apiBase}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "device_code", device_code }),
    });
    const body = await r.json();
    if (r.ok && body.access_token) {
      const token = {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
        api_base: apiBase,
      };
      await saveToken(token);
      return { ok: true, token };
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      await sleep(pollIntervalMs);
      continue;
    }
    if (body.error === "access_denied") return { ok: false, reason: "denied" };
    if (body.error === "expired_token") return { ok: false, reason: "expired" };
    if (body.error === "invalid_grant") return { ok: false, reason: "invalid_grant" };
    // Unknown error — bail
    return { ok: false, reason: body.error_description ?? body.error ?? "unknown" };
  }
  return { ok: false, reason: "expired" };
}

export async function logout() {
  const token = await loadToken().catch(() => null);
  if (token) {
    // Best-effort revoke
    await fetch(`${token.api_base}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token.access_token }),
    }).catch(() => {});
    await fetch(`${token.api_base}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token.refresh_token }),
    }).catch(() => {});
  }
  await fs.rm(TOKEN_FILE, { force: true });
}

export async function status() {
  const token = await loadToken().catch(() => null);
  if (!token) return { loggedIn: false };
  const expired = new Date(token.expires_at).getTime() < Date.now();
  return { loggedIn: !expired, apiBase: token.api_base, expiresAt: token.expires_at };
}

export async function loadToken() {
  const raw = await fs.readFile(TOKEN_FILE, "utf8");
  return JSON.parse(raw);
}

export async function saveToken(token) {
  await fs.mkdir(TOKEN_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/**
 * Returns a valid access_token, refreshing if needed.
 */
export async function ensureFreshToken() {
  const token = await loadToken();
  const buffer = 60 * 1000; // 1 minute buffer
  if (new Date(token.expires_at).getTime() - buffer > Date.now()) {
    return token;
  }
  // Try refresh
  const r = await fetch(`${token.api_base}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: token.refresh_token }),
  });
  const body = await r.json();
  if (!r.ok || !body.access_token) {
    throw Object.assign(new Error("token refresh failed; please run /flowmap login"), {
      code: "REFRESH_FAILED",
    });
  }
  const refreshed = {
    ...token,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  };
  await saveToken(refreshed);
  return refreshed;
}

export async function apiFetch(pathname, init = {}) {
  const token = await ensureFreshToken();
  const res = await fetch(`${token.api_base}${pathname}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token.access_token}`,
    },
  });
  return res;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
