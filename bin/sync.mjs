/**
 * Upload manifest + screenshots to flowmap.app.
 *
 *  1. Read/create local .flowmap/config.json with persistent projectId.
 *  2. POST /api/projects (idempotent via fingerprint).
 *  3. POST /api/projects/{id}/snapshots (multipart).
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { apiFetch } from "./auth.mjs";

const CONFIG_DIR_NAME = ".flowmap";

export async function ensureProject({ cwd, name, fingerprint }) {
  const configPath = path.join(cwd, CONFIG_DIR_NAME, "config.json");
  let config = await readJsonSafe(configPath);
  if (config?.projectId) return { projectId: config.projectId, configPath, reused: true };

  const res = await apiFetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, fingerprint }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.project?.id) {
    throw new Error(`project create failed: ${res.status} ${JSON.stringify(body)}`);
  }
  const projectId = body.project.id;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ projectId, fingerprint, createdAt: new Date().toISOString() }, null, 2),
  );
  // Suggest gitignore
  await maybeGitignoreScreenshots(cwd);
  return { projectId, configPath, reused: false };
}

export async function syncSnapshot({ projectId, manifest, screenshots, pluginVersion }) {
  const form = new FormData();
  form.set(
    "manifest",
    new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    "manifest.json",
  );
  form.set(
    "syncedFrom",
    new Blob(
      [JSON.stringify({ hostname: os.hostname(), pluginVersion: pluginVersion ?? "0.1.0" })],
      { type: "application/json" },
    ),
  );
  let uploadedShots = 0;
  for (const s of screenshots ?? []) {
    if (s.error || !s.buffer) continue;
    form.set(
      `screenshot[${s.screenId}][${s.viewport}]`,
      new Blob([s.buffer], { type: "image/png" }),
      `${s.screenId}.${s.viewport}.png`,
    );
    uploadedShots++;
  }

  const res = await apiFetch(`/api/projects/${projectId}/snapshots`, {
    method: "POST",
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`snapshot sync failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return { ...body, uploadedShotsAttempted: uploadedShots };
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function maybeGitignoreScreenshots(cwd) {
  const gitignore = path.join(cwd, ".gitignore");
  let text = "";
  try {
    text = await fs.readFile(gitignore, "utf8");
  } catch {
    return; // no gitignore — leave alone
  }
  if (text.includes(".flowmap/screenshots") || text.includes(".flowmap/")) return;
  // Append a small block, don't overwrite
  const append = "\n# flowmap (sync to flowmap.app — keep config.json, drop local cache)\n.flowmap/screenshots/\n.flowmap/manifest.json\n.flowmap/descriptions.json\n";
  await fs.writeFile(gitignore, text + append);
}
