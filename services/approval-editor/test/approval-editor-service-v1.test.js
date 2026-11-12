const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { createApprovalEditorService } = require("../server");

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
      const finalPath = path.join(projectsRoot, projectId, "final.mp4");
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, "mock final mp4\n", "utf8");
      return { finalPath };
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

async function raw(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, options);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
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
    assert.equal(created.body.data.snapshot.rows[0].motionPresetId, "Zoom 150");
    assert.equal(created.body.data.snapshot.rows[0].motionTransform.toScale, 1.5);
    assert.equal(created.body.data.snapshotHash, created.body.data.snapshot.snapshotHash);
    assert.equal(created.body.data.previewAssets.assets[created.body.data.snapshot.rows[0].selectedAssetId].type, "image");
  });
});

test("approval editor service preserves paragraph eligibility from raw guion_piped", async () => {
  await withService(async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify({
        ...basePayload(),
        segments: undefined,
        guion_piped: "Intro|Cuerpo\n\n|Cierre",
        selected_images: ["https://cdn.test/image-1.jpg", "https://cdn.test/image-2.jpg", "https://cdn.test/image-3.jpg"],
      }),
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.snapshot.rows[0].paragraphBoundaryAfter, undefined);
    assert.equal(created.body.data.snapshot.rows[1].paragraphBoundaryAfter, true);
    assert.equal(created.body.data.snapshot.rows[1].nextRowId, "row-3");
    assert.equal(created.body.data.snapshot.rows[1].transition, "transition-3");
    assert.equal(created.body.data.snapshot.rows[1].transitionSource, "auto");
    assert.deepEqual(created.body.data.snapshot.rows[1].transitionConfig, { type: "overlay-video", assetId: "transition-3", src: "./assets/boundary-transitions/efecto-transition-3.mp4", renderPath: "overlays/efecto-transition-3.mp4", previewUrl: "./assets/boundary-transitions/efecto-transition-3.mp4", blendMode: "screen", durationSeconds: 1, audio: true });
    assert.equal(created.body.data.snapshot.rows[1].sfx, null);
    assert.equal(created.body.data.snapshot.assets["transition-3"].renderPath, "overlays/efecto-transition-3.mp4");
    assert.equal(created.body.data.snapshot.rows[2].paragraphBoundaryAfter, undefined);
  });
});

test("approval editor service merges raw guion paragraph metadata onto supplied segments", async () => {
  await withService(async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify({
        ...basePayload(),
        segments: [
          { id: "custom-1", phrase: "Intro", startTime: 0, endTime: 1 },
          { id: "custom-2", phrase: "Cuerpo", startTime: 1, endTime: 2 },
          { id: "custom-3", phrase: "Cierre", startTime: 2, endTime: 3 },
        ],
        guion_piped: "Intro|Cuerpo\n\n|Cierre",
        selected_images: ["https://cdn.test/image-1.jpg", "https://cdn.test/image-2.jpg", "https://cdn.test/image-3.jpg"],
      }),
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.data.snapshot.rows[0].paragraphBoundaryAfter, undefined);
    assert.equal(created.body.data.snapshot.rows[1].paragraphBoundaryAfter, true);
    assert.equal(created.body.data.snapshot.rows[1].nextRowId, "custom-3");
    assert.equal(created.body.data.snapshot.rows[1].transition, "transition-3");
    assert.equal(created.body.data.snapshot.rows[1].transitionSource, "auto");
    assert.deepEqual(created.body.data.snapshot.rows[1].transitionConfig, { type: "overlay-video", assetId: "transition-3", src: "./assets/boundary-transitions/efecto-transition-3.mp4", renderPath: "overlays/efecto-transition-3.mp4", previewUrl: "./assets/boundary-transitions/efecto-transition-3.mp4", blendMode: "screen", durationSeconds: 1, audio: true });
    assert.equal(created.body.data.snapshot.rows[1].sfx, null);
    assert.equal(created.body.data.snapshot.assets["transition-3"].renderPath, "overlays/efecto-transition-3.mp4");
  });
});

test("approval editor service enables and disables Transition only for eligible paragraph boundaries", async () => {
  await withService(async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify({
        ...basePayload(),
        segments: undefined,
        guion_piped: "Intro|Cuerpo\n\n|Cierre",
        selected_images: ["https://cdn.test/image-1.jpg", "https://cdn.test/image-2.jpg", "https://cdn.test/image-3.jpg"],
      }),
    });
    const projectId = created.body.data.projectId;
    const hashA = created.body.data.snapshotHash;

    const enabled = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: hashA,
        operations: [{ type: "setBoundaryTransition", rowId: "row-2", nextRowId: "row-3", transition: "transition-1" }],
      }),
    });

    assert.equal(enabled.status, 200);
    const hashB = enabled.body.data.snapshotHash;
    assert.notEqual(hashB, hashA);
    assert.equal(enabled.body.data.snapshot.rows[1].paragraphBoundaryAfter, true);
    assert.equal(enabled.body.data.snapshot.rows[1].nextRowId, "row-3");
    assert.equal(enabled.body.data.snapshot.rows[1].transition, "transition-1");
    assert.deepEqual(enabled.body.data.snapshot.rows[1].transitionConfig, { type: "overlay-video", assetId: "transition-1", src: "./assets/boundary-transitions/TRANSITION 1 NUEVO.mp4", renderPath: "overlays/TRANSITION 1 NUEVO.mp4", previewUrl: "./assets/boundary-transitions/TRANSITION 1 NUEVO.mp4", blendMode: "screen", durationSeconds: 0.833333, audio: true });
    assert.deepEqual(enabled.body.data.snapshot.rows[1].sfx, null);
    assert.equal(enabled.body.data.snapshot.assets["transition-1"].renderPath, "overlays/TRANSITION 1 NUEVO.mp4");
    assert.equal(enabled.body.data.snapshot.rows[1].mediaMode, created.body.data.snapshot.rows[1].mediaMode);
    assert.equal(enabled.body.data.snapshot.rows[1].selectedAssetId, created.body.data.snapshot.rows[1].selectedAssetId);
    assert.equal(enabled.body.data.snapshot.rows[0].transition, "none");

    const disabled = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: hashB,
        operations: [{ type: "setBoundaryTransition", rowId: "row-2", nextRowId: "row-3", transition: "none" }],
      }),
    });

    assert.equal(disabled.status, 200);
    assert.notEqual(disabled.body.data.snapshotHash, hashB);
    assert.equal(disabled.body.data.snapshot.rows[1].transition, "none");
    assert.equal(disabled.body.data.snapshot.rows[1].transitionConfig, undefined);
    assert.equal(disabled.body.data.snapshot.rows[1].sfx, null);

    const rejected = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: disabled.body.data.snapshotHash,
        operations: [{ type: "setBoundaryTransition", rowId: "row-1", nextRowId: "row-2", transition: "transition-1" }],
      }),
    });

    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "invalid_boundary_transition");
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
          { type: "setRowMediaMode", rowId: "row-2", mediaMode: "newspaper", media: { kind: "image" } },
          { type: "setRowImage", rowId: "row-2", asset: { assetId: "custom-asset", previewUrl: "https://cdn.test/custom.webp", renderPath: "https://cdn.test/custom.webp" } },
          { type: "setRowMotion", rowId: "row-2", motionPresetId: "Zoom-125", motion: { fromX: 0, fromY: 0, toX: 0, toY: 0, fromScale: 1, toScale: 1.25, easing: "linear" } },
          { type: "setRowDust", rowId: "row-2", enabled: true, dustType: "particle-2" },
          { type: "setLogo", enabled: true, source: "logo-primary.webm" },
          { type: "setAudio", kind: "voice", settings: { volume: 0.35, muted: false } },
          { type: "setAudio", kind: "music", settings: { muted: true, volume: 0.05, loop: true, fadeInSeconds: 0.25, fadeOutSeconds: 0.75 } },
        ],
      }),
    });

    assert.equal(updated.status, 200);
    const hashB = updated.body.data.snapshotHash;
    assert.notEqual(hashB, hashA);
    assert.equal(updated.body.data.snapshot.rows[1].selectedAssetId, "custom-asset");
    assert.equal(updated.body.data.snapshot.rows[1].mediaMode, "newspaper");
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

    const download = await raw(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/download/final?download=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "video/mp4");
    assert.match(download.headers.get("content-disposition"), /^attachment; filename="video-final\.mp4"/);
    assert.equal(download.text, "mock final mp4\n");
  });
});

test("approval editor service records actor audit metadata, increments versions, and reports actionable conflicts", async () => {
  await withService(async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      headers: { "x-panel-actor-id": "creator-1", "x-panel-actor-email": "creator@example.test", "x-panel-actor-roles": "editor" },
      body: JSON.stringify(basePayload()),
    });
    const projectId = created.body.data.projectId;
    assert.equal(created.body.data.version, 1);
    assert.equal(created.body.data.audit.actor.id, "creator-1");
    assert.equal(created.body.data.audit.action, "snapshot.create");

    const updated = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      headers: { "x-panel-actor-id": "editor-2", "x-panel-actor-email": "editor2@example.test", "x-panel-actor-roles": "editor" },
      body: JSON.stringify({
        baseSnapshotHash: created.body.data.snapshotHash,
        lease_id: "lease-editor-2",
        operations: [{ type: "setLogo", enabled: false }],
      }),
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.version, 2);
    assert.equal(updated.body.data.audit.actor.id, "editor-2");
    assert.equal(updated.body.data.audit.action, "snapshot.update");
    assert.equal(updated.body.data.audit.base_snapshot_hash, created.body.data.snapshotHash);
    assert.equal(updated.body.data.audit.new_version, 2);
    assert.equal(updated.body.data.audit.lease_id, "lease-editor-2");

    const staleUpdate = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({ baseSnapshotHash: created.body.data.snapshotHash, operations: [{ type: "setLogo", enabled: true }] }),
    });

    assert.equal(staleUpdate.status, 409);
    assert.equal(staleUpdate.body.error.code, "version_conflict");
    assert.equal(staleUpdate.body.error.details.expected_version, 2);
    assert.equal(staleUpdate.body.error.details.received_version, 1);
    assert.equal(staleUpdate.body.error.details.expected_snapshot_hash, updated.body.data.snapshotHash);
    assert.equal(staleUpdate.body.error.details.received_snapshot_hash, created.body.data.snapshotHash);
  });
});

test("approval editor service blocks writes when another actor holds a live lease", async () => {
  await withService(async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify(basePayload()) });
    const projectId = created.body.data.projectId;
    const first = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      headers: { "x-panel-actor-id": "editor-1", "x-panel-actor-email": "one@example.test", "x-panel-actor-roles": "editor" },
      body: JSON.stringify({ baseSnapshotHash: created.body.data.snapshotHash, lease_id: "lease-one", operations: [{ type: "setLogo", enabled: false }] }),
    });

    const blocked = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      headers: { "x-panel-actor-id": "editor-2", "x-panel-actor-email": "two@example.test", "x-panel-actor-roles": "editor" },
      body: JSON.stringify({ baseSnapshotHash: first.body.data.snapshotHash, lease_id: "lease-two", operations: [{ type: "setLogo", enabled: true }] }),
    });

    assert.equal(blocked.status, 423);
    assert.equal(blocked.body.error.code, "lease_held");
    assert.equal(blocked.body.error.details.owner.id, "editor-1");
    assert.equal(blocked.body.error.details.lease_id, "lease-one");
    assert.match(blocked.body.error.details.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("approval editor service persists brand channel changes, asset references, and render handoff snapshot", async () => {
  await withService(async (baseUrl, renderCalls) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify({ ...basePayload(), brandChannel: "demo-primary" }) });
    const projectId = created.body.data.projectId;
    const hashA = created.body.data.snapshotHash;
    assert.equal(created.body.data.snapshot.brandChannel, "demo-primary");
    assert.equal(created.body.data.snapshot.globalLayers.logo.assetId, "brand-logo-primary");

    const updated = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/snapshot`, {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: hashA,
        operations: [{ type: "setBrandChannel", brandChannel: "demo-secondary" }],
      }),
    });

    assert.equal(updated.status, 200);
    const hashB = updated.body.data.snapshotHash;
    assert.notEqual(hashB, hashA);
    assert.equal(updated.body.data.snapshot.brandChannel, "demo-secondary");
    assert.equal(updated.body.data.snapshot.globalLayers.logo.assetId, "brand-logo-secondary");
    assert.equal(updated.body.data.snapshot.globalLayers.outro.assetId, "brand-outro-secondary");
    assert.equal(updated.body.data.snapshot.assets["brand-logo-secondary"].previewUrl, "./assets/logo-secondary.webm");
    assert.equal(updated.body.data.snapshot.assets["brand-outro-secondary"].renderPath, "overlays/outro-secondary.mp4");

    const staleRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashA }) });
    assert.equal(staleRender.status, 409);
    assert.equal(renderCalls.length, 0);

    const finalRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: hashB }) });
    assert.equal(finalRender.status, 202);
    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0].snapshotHash, hashB);
    assert.equal(renderCalls[0].snapshot.brandChannel, "demo-secondary");
    assert.equal(renderCalls[0].snapshot.globalLayers.outro.assetId, "brand-outro-secondary");
  });
});

test("approval editor service fails loudly when final render adapter is not configured", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "approval-editor-v1-no-render-"));
  const server = createApprovalEditorService({
    projectsRoot,
    alignVoiceAudio: async ({ segments }) => ({
      segments,
      alignedTimings: { phrases: segments.map((segment) => ({ startTime: segment.startTime, endTime: segment.endTime })) },
      alignmentStatus: { status: "ready", source: "test-alignment", generatedAt: "2026-05-08T00:00:00.000Z" },
      paths: null,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify(basePayload()) });
    const projectId = created.body.data.projectId;
    const snapshotHash = created.body.data.snapshotHash;

    const finalRender = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash }) });
    assert.equal(finalRender.status, 500);
    assert.equal(finalRender.body.ok, false);
    assert.equal(finalRender.body.error.code, "renderer_unavailable");
    assert.match(finalRender.body.error.message, /Renderer service URL is not configured/);
    assert.match(finalRender.body.error.message, /APPROVAL_EDITOR_RENDERER_URL/);

    const download = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/download/final`);
    assert.equal(download.status, 200);
    assert.equal(download.body.data.finalUrl, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("approval editor service calls the renderer over http and rejects a missing output path", async () => {
  const rendererRequests = [];
  const rendererServer = http.createServer((request, response) => {
    rendererRequests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { project_root: "/tmp/fake-renderer" } }));
  });
  await new Promise((resolve) => rendererServer.listen(0, "127.0.0.1", resolve));
  const rendererPort = rendererServer.address().port;
  const server = createApprovalEditorService({
    projectsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "approval-editor-configured-")),
    env: {
      APPROVAL_EDITOR_RENDER_ADAPTER: "http",
      APPROVAL_EDITOR_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
    },
    alignVoiceAudio: async ({ segments }) => ({
      segments,
      alignedTimings: { phrases: segments.map((segment) => ({ startTime: segment.startTime, endTime: segment.endTime })) },
      alignmentStatus: { status: "ready", source: "test-alignment", generatedAt: "2026-05-08T00:00:00.000Z" },
      paths: null,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const created = await api(baseUrl, "/api/projects/create-from-approval", { method: "POST", body: JSON.stringify(basePayload()) });
    const finalRender = await api(baseUrl, `/api/projects/${encodeURIComponent(created.body.data.projectId)}/render-final`, { method: "POST", body: JSON.stringify({ snapshotHash: created.body.data.snapshotHash }) });

    assert.deepEqual(rendererRequests, ["/api/render"]);
    assert.equal(finalRender.status, 500);
    assert.equal(finalRender.body.error.code, "render_output_missing");
    assert.match(finalRender.body.error.message, /without a final output path/);
    const download = await api(baseUrl, `/api/projects/${encodeURIComponent(created.body.data.projectId)}/download/final`);
    assert.equal(download.body.data.finalUrl, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => rendererServer.close(resolve));
  }
});

function baseCanonicalSnapshot() {
  return {
    contractVersion: "approval-editor-service-v1",
    projectId: "draft-v1",
    title: "Approval V1",
    snapshotHash: "hash-canonical",
    totalDurationSeconds: 2.8,
    audio: {
      totalDurationSeconds: 2.8,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false, loop: true },
    },
    globalLayers: {
      logo: { enabled: true, assetId: "brand-logo-secondary" },
      outro: { enabled: true, assetId: "brand-outro-secondary" },
    },
    rows: [
      { id: "row-1", phrase: "Linea 1", startTime: 0, endTime: 1.2, selectedAssetId: "image-1", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true } },
      { id: "row-2", phrase: "Linea 2", startTime: 1.2, endTime: 2.8, selectedAssetId: "image-2", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true } },
    ],
    assets: {
      "image-1": { id: "image-1", type: "image", renderPath: "generated/images/image-1.jpg", status: "ready" },
      "image-2": { id: "image-2", type: "image", renderPath: "generated/images/image-2.jpg", status: "ready" },
      "voice-1": { id: "voice-1", type: "audio", renderPath: "generated/audio/voice.wav", status: "ready" },
      "music-1": { id: "music-1", type: "music", renderPath: "generated/audio/music.wav", status: "ready" },
      "brand-logo-secondary": { id: "brand-logo-secondary", type: "logo", renderPath: "overlays/logo-secondary.webm", status: "ready" },
      "brand-outro-secondary": { id: "brand-outro-secondary", type: "outro", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 30.16, status: "ready" },
    },
  };
}
