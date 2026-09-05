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
import { gzipSync } from "node:zlib";
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

export async function syncSnapshot({
  projectId,
  manifest,
  screenshots,
  fontFaces,
  pluginVersion,
}) {
  // Each screen's assets, packed once and then dealt into requests.
  const assets = [];
  let uploadedShots = 0;
  let uploadedScenes = 0;
  for (const s of screenshots ?? []) {
    if (s.error) continue;
    if (s.buffer) {
      assets.push({
        field: `screenshot[${s.screenId}][${s.viewport}]`,
        name: `${s.screenId}.${s.viewport}.png`,
        type: "image/png",
        data: s.buffer,
      });
      uploadedShots++;
    }
    // Gzipped on the client: the graph is repetitive JSON and compresses ~8x,
    // which is what makes it cheaper to ship than the PNG beside it.
    if (s.scene) {
      const gz = gzipSync(Buffer.from(JSON.stringify(s.scene), "utf8"), { level: 9 });
      assets.push({
        field: `scene[${s.screenId}][${s.viewport}]`,
        name: `${s.screenId}.${s.viewport}.json.gz`,
        type: "application/gzip",
        data: gz,
      });
      uploadedScenes++;
    }
  }

  /*
   * Sent in batches, because a working capture is bigger than one request.
   *
   * A sync used to be a single multipart body, which held only while the
   * screens came back as spinners. Once they rendered for real, 96 of them
   * came to 5.3MB and the gateway refused the lot — and that size is not an
   * anomaly to be trimmed, it is what a real app weighs.
   *
   * The first request carries the manifest and makes the snapshot; the rest
   * name that snapshot and carry only assets. A single file larger than the
   * budget still goes on its own rather than being dropped: it is one screen,
   * and the server can refuse it more usefully than the plugin can.
   */
  const BUDGET = 3 * 1024 * 1024;
  const batches = [[]];
  let batchBytes = 0;
  for (const asset of assets) {
    if (batchBytes > 0 && batchBytes + asset.data.byteLength > BUDGET) {
      batches.push([]);
      batchBytes = 0;
    }
    batches.at(-1).push(asset);
    batchBytes += asset.data.byteLength;
  }

  const manifestBlob = () =>
    new Blob([JSON.stringify(manifest)], { type: "application/json" });

  let res;
  let snapshotId = null;
  // Summed across the batches. Each response counts only its own share, so
  // reading the last one reported a fraction of what was actually stored.
  const totals = {
    uploaded_screenshots: 0,
    reused_screenshots: 0,
    uploaded_scenes: 0,
    reused_scenes: 0,
  };
  for (const [index, batch] of batches.entries()) {
    const form = new FormData();
    form.set("manifest", manifestBlob(), "manifest.json");
    form.set(
      "syncedFrom",
      new Blob(
        [JSON.stringify({ hostname: os.hostname(), pluginVersion: pluginVersion ?? "0.1.0" })],
        { type: "application/json" },
      ),
    );
    if (snapshotId) form.set("snapshotId", snapshotId);
    for (const a of batch) {
      form.set(a.field, new Blob([a.data], { type: a.type }), a.name);
    }
    // One copy per sync, not per screen — see the route's own note on why
    // these are both unskippable and worth deduplicating.
    if (fontFaces && index === 0) {
      form.set("fontFaces", new Blob([fontFaces], { type: "text/css" }), "fonts.css");
    }

    res = await apiFetch(`/api/projects/${projectId}/snapshots`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) break;
    const reply = await res.clone().json().catch(() => null);
    for (const key of Object.keys(totals)) totals[key] += reply?.[key] ?? 0;
    if (!snapshotId) {
      // Read once, from the request that created it; the rest are follow-ups
      // to the same snapshot and say so.
      snapshotId = reply?.snapshot_id ?? null;
      if (!snapshotId && batches.length > 1) {
        throw new Error("sync: server did not return a snapshotId to continue with");
      }
    }
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`snapshot sync failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return {
    ...body,
    ...totals,
    uploadedShotsAttempted: uploadedShots,
    uploadedScenesAttempted: uploadedScenes,
  };
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
