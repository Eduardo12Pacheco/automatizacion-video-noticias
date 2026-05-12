const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApprovalEditorService } = require("../../01-Control-Panel/services/approval-editor/server");

function basePayload() {
  return {
    draft_id: "Draft V1",
    title: "Approval V1",
    segments: [
      { id: "row-1", phrase: "Linea 1", startTime: 0, endTime: 1.2 },
      { id: "row-2", phrase: "Linea 2", startTime: 1.2, endTime: 2.8 },
    ],
    selected_images: ["https://cdn.test/image-1.jpg", "https://cdn.test/image-2.jpg"],
    voice_audio: { public_url: "https://cdn.test/voice.wav" },
    background_audio: { public_url: "https://cdn.test/music.wav" },
  };
}

async function withService(fn) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "approval-editor-v1-"));
  const renderCalls = [];
  const server = createApprovalEditorService({
    projectsRoot,
    alignVoiceAudio: async ({ segments }) => ({
      segments,
      alignedTimings: { phrases: segments.map((segment) => ({ startTime: segment.startTime, endTime: segment.endTime })) },
      alignmentStatus: { status: "ready", source: "test-alignment", generatedAt: "2026-05-08T00:00:00.000Z" },
      paths: null,
    }),
    renderAdapter: async ({ projectId, snapshot, snapshotHash }) => {
      renderCalls.push({ projectId, snapshot, snapshotHash });
      return { finalPath: path.join(projectsRoot, projectId, "final.mp4") };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, renderCalls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function api(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("approval editor service health is browser-safe and prepare returns canonical snapshot", async () => {
  await withService(async (baseUrl) => {
    const health = await api(baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.data.service, "approval-editor-service");
    assert.equal(JSON.stringify(health.body).includes("service_role"), false);

    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify(basePayload()) });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.snapshot.contractVersion, "approval-editor-service-v1");
    assert.equal(created.body.data.snapshot.rows.length, 2);
    assert.equal(created.body.data.snapshotHash, created.body.data.snapshot.snapshotHash);
    assert.equal(created.body.data.previewAssets.assets[created.body.data.snapshot.rows[0].selectedAssetId].type, "image");
  });
});

test("approval editor service updates immutable snapshots and rejects stale update/render hashes", async () => {
  await withService(async (baseUrl, renderCalls) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify(basePayload()) });
    const projectId = created.body.data.projectId;
    const hashA = created.body.data.snapshotHash;

    const updated = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: hashA,
        operations: [
          { type: "setRowImage", rowId: "row-2", asset: { assetId: "custom-asset", previewUrl: "https://cdn.test/custom.webp", renderPath: "https://cdn.test/custom.webp" } },
          { type: "setRowMotion", rowId: "row-2", motionPresetId: "Zoom-125", motion: { fromX: 0, fromY: 0, toX: 0, toY: 0, fromScale: 1, toScale: 1.25, easing: "linear" } },
          { type: "setRowDust", rowId: "row-2", enabled: true, dustType: "particle-2" },
          { type: "setLogo", enabled: true, source: "logo-demo-alpha.webm" },
          { type: "setAudio", kind: "voice", settings: { volume: 0.35, muted: false } },
          { type: "setAudio", kind: "music", settings: { muted: true, volume: 0.05, loop: true, fadeInSeconds: 0.25, fadeOutSeconds: 0.75 } },
        ],
      }),
    });

    assert.equal(updated.status, 200);
    const hashB = updated.body.data.snapshotHash;
    assert.notEqual(hashB, hashA);
    assert.equal(updated.body.data.snapshot.rows[1].selectedAssetId, "custom-asset");
    assert.equal(updated.body.data.snapshot.rows[0].selectedAssetId, created.body.data.snapshot.rows[0].selectedAssetId);
    assert.equal(updated.body.data.snapshot.rows[1].dust.type, "particle-2");
    assert.equal(updated.body.data.snapshot.audio.voice.volume, 0.35);
    assert.equal(updated.body.data.snapshot.audio.voice.muted, false);
    assert.equal(updated.body.data.snapshot.audio.music.muted, true);

    const staleUpdate = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({ baseSnapshotHash: hashA, operations: [{ type: "setLogo", enabled: false }] }),
    });
    assert.equal(staleUpdate.status, 409);

    const staleRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashA }) });
    assert.equal(staleRender.status, 409);
    assert.equal(renderCalls.length, 0);

    const finalRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashB }) });
    assert.equal(finalRender.status, 202);
    assert.equal(finalRender.body.data.lastRenderedSnapshotHash, hashB);
    assert.equal(renderCalls.length, 1);
  });
});

test("approval editor service persists brand channel changes, asset references, and render handoff snapshot", async () => {
  await withService(async (baseUrl, renderCalls) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify({ ...basePayload(), brandChannel: "golazo-ecuador" }) });
    const projectId = created.body.data.projectId;
    const hashA = created.body.data.snapshotHash;
    assert.equal(created.body.data.snapshot.brandChannel, "golazo-ecuador");
    assert.equal(created.body.data.snapshot.globalLayers.logo.assetId, "brand-logo-ecuador");

    const updated = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: hashA,
        operations: [{ type: "setBrandChannel", brandChannel: "golazo-colombia" }],
      }),
    });

    assert.equal(updated.status, 200);
    const hashB = updated.body.data.snapshotHash;
    assert.notEqual(hashB, hashA);
    assert.equal(updated.body.data.snapshot.brandChannel, "golazo-colombia");
    assert.equal(updated.body.data.snapshot.globalLayers.logo.assetId, "brand-logo-demo-co");
    assert.equal(updated.body.data.snapshot.globalLayers.outro.assetId, "brand-outro-colombia");
    assert.equal(updated.body.data.snapshot.assets["brand-logo-demo-co"].previewUrl, "./assets/logo-demo-co.webm");
    assert.equal(updated.body.data.snapshot.assets["brand-outro-colombia"].renderPath, "overlays/final-demo-co.mp4");

    const staleRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashA }) });
    assert.equal(staleRender.status, 409);
    assert.equal(renderCalls.length, 0);

    const finalRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashB }) });
    assert.equal(finalRender.status, 202);
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].snapshotHash, hashB);
    assert.equal(renderCalls[0].snapshot.brandChannel, "golazo-colombia");
    assert.equal(renderCalls[0].snapshot.globalLayers.outro.assetId, "brand-outro-colombia");
  });
});
