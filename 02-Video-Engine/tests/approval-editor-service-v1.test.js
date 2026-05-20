const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createApprovalEditorService } = require("../../01-Control-Panel/services/approval-editor/server");
const { createVideoEngineRenderAdapter } = require("../../01-Control-Panel/services/approval-editor/lib/video-engine-render-adapter");
const { adaptCompositionContractToRenderProps } = require("../scripts/lib/composition-contract");

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
          { type: "setRowMediaMode", rowId: "row-2", mediaMode: "newspaper", media: { kind: "image" } },
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
    assert.equal(finalRender.body.error.code, "render_adapter_not_configured");
    assert.match(finalRender.body.error.message, /Remotion render adapter is not configured/);
    assert.match(finalRender.body.error.message, /APPROVAL_EDITOR_RENDER_ADAPTER/);

    const download = await api(baseUrl, `/api/projects/${encodeURIComponent(projectId)}/download/final`);
    assert.equal(download.status, 200);
    assert.equal(download.body.data.finalUrl, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("video engine render adapter persists canonical snapshot and invokes render-video final profile", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");
  fs.mkdirSync(path.join(videoEngineRoot, "assets", "overlays"), { recursive: true });
  fs.mkdirSync(path.join(videoEngineRoot, "assets", "overlays", "logo-demo-co-alpha-frames"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "assets", "overlays", "logo-demo-co-alpha-frames", "frame-0000.png"), "source logo png\n", "utf8");
  fs.writeFileSync(path.join(videoEngineRoot, "assets", "overlays", "final-demo-co.mp4"), "source final mp4\n", "utf8");
  const commands = [];
  const adapter = createVideoEngineRenderAdapter({
    videoEngineRoot,
    projectsRoot,
    runCommand: async (command) => {
      commands.push(command);
      fs.mkdirSync(path.dirname(command.outputPath), { recursive: true });
      fs.writeFileSync(command.outputPath, "mock mp4\n", "utf8");
      return { status: "success", exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const snapshot = { ...baseCanonicalSnapshot(), snapshotHash: "hash-canonical" };
  const result = await adapter({ projectId: "Draft V1", snapshot, snapshotHash: "hash-canonical" });

  const projectRoot = path.join(projectsRoot, "draft-v1");
  const persisted = JSON.parse(fs.readFileSync(path.join(projectRoot, "composition-contract.json"), "utf8"));
  assert.equal(persisted.contract.snapshotHash, "hash-canonical");
  assert.equal(persisted.contract.rows[0].selectedAssetId, "image-1");
  assert.equal(persisted.contract.globalLayers.outro.assetId, "brand-outro-colombia");
  assert.equal(persisted.manifest.assets["brand-logo-demo-co"].renderPath, "overlays/logo-demo-co-alpha-frames");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "overlays", "logo-demo-co-alpha-frames", "frame-0000.png"), "utf8"), "source logo png\n");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "overlays", "final-demo-co.mp4"), "utf8"), "source final mp4\n");
  assert.equal(fs.existsSync(path.join(projectRoot, "editor-project.json")), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectsRoot, "index.json"), "utf8")).projects.map((entry) => entry.id), ["draft-v1"]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].scriptPath, path.join(videoEngineRoot, "scripts", "render-video.js"));
  assert.equal(fs.existsSync(commands[0].scriptPath), true);
  assert.deepEqual(commands[0].args, [commands[0].scriptPath, `--project-root=${projectRoot}`, "--profile=final"]);
  assert.equal(commands[0].args.includes("--profile=preview"), false);
  assert.equal(commands[0].outputPath, path.join(projectRoot, "output", "video-final.mp4"));
  assert.equal(result.finalPath, path.join(projectRoot, "output", "video-final.mp4"));
});

test("approval editor owns non-render prep imports and writes only a minimal render scaffold", async () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "..", "01-Control-Panel", "services", "approval-editor", "server.js"), "utf8");
  const alignmentSource = fs.readFileSync(path.join(__dirname, "..", "..", "01-Control-Panel", "services", "approval-editor", "lib", "real-alignment.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(__dirname, "..", "..", "01-Control-Panel", "services", "approval-editor", "lib", "video-engine-render-adapter.js"), "utf8");

  assert.equal(serverSource.includes("02-Video-Engine/scripts/lib/guion-parsing"), false);
  assert.equal(alignmentSource.includes("02-Video-Engine/scripts/lib/phrase-alignment"), false);
  assert.equal(adapterSource.includes("02-Video-Engine/scripts/lib/editor-project"), false);
  assert.equal(adapterSource.includes("createEditorProject"), false);

  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-minimal-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-minimal-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");
  const adapter = createVideoEngineRenderAdapter({
    videoEngineRoot,
    projectsRoot,
    runCommand: async (command) => {
      fs.mkdirSync(path.dirname(command.outputPath), { recursive: true });
      fs.writeFileSync(command.outputPath, "mock mp4\n", "utf8");
      return { status: "success", exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  await adapter({ projectId: "Draft Minimal", snapshot: { ...baseCanonicalSnapshot(), projectId: "draft-minimal" }, snapshotHash: "hash-minimal" });

  const projectRoot = path.join(projectsRoot, "draft-minimal");
  const scaffold = JSON.parse(fs.readFileSync(path.join(projectRoot, "editor-project.json"), "utf8"));
  assert.equal(scaffold.schemaVersion, 1);
  assert.equal(scaffold.projectId, "draft-minimal");
  assert.equal(scaffold.title, "Approval V1");
  assert.equal(scaffold.rows.length, 2);
  assert.equal(scaffold.rows[0].phrase, "Linea 1");
  assert.deepEqual(scaffold.assets, []);
  assert.equal(scaffold.preview.status, "ready");
});

test("video engine render adapter localizes remote render assets before final render", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-remote-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-remote-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");

  const downloaded = new Map([
    ["https://cdn.test/assets/voice-48khz.wav", Buffer.from("voice wav")],
    ["https://cdn.test/assets/music-track.mp3", Buffer.from("music mp3")],
    ["https://cdn.test/images/image-one.webp", Buffer.from("image one")],
    ["https://cdn.test/images/image-two.jpg?token=secret", Buffer.from("image two")],
    ["https://cdn.test/brand/logo.webm", Buffer.from("logo webm")],
  ]);
  const fetchCalls = [];
  const commands = [];
  const adapter = createVideoEngineRenderAdapter({
    videoEngineRoot,
    projectsRoot,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      assert.equal(downloaded.has(url), true, `unexpected download url: ${url}`);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => downloaded.get(url),
      };
    },
    runCommand: async (command) => {
      commands.push(command);
      const persisted = JSON.parse(fs.readFileSync(path.join(command.projectRoot, "composition-contract.json"), "utf8"));
      const assets = persisted.contract.assets;
      assert.equal(assets["voice-1"].renderPath, "generated/audio/voice-1.wav");
      assert.equal(assets["music-1"].renderPath, "generated/audio/music-1.mp3");
      assert.equal(assets["image-1"].renderPath, "generated/images/image-1.webp");
      assert.equal(assets["image-2"].renderPath, "generated/images/image-2.jpg");
      assert.equal(assets["brand-logo-demo-co"].renderPath, "overlays/logo-demo-co-alpha-frames");
      assert.equal(assets["brand-logo-demo-co"].publicUrl, "./assets/logo-demo-co.webm");
      assert.equal(assets["brand-outro-colombia"].renderPath, "overlays/final-demo-co.mp4");
      const renderProps = adaptCompositionContractToRenderProps({ contract: persisted.contract, manifest: persisted.manifest });
      assert.equal(renderProps.audio.voiceSrc, "generated/audio/voice-1.wav");
      assert.equal(renderProps.audio.musicSrc, "generated/audio/music-1.mp3");
      assert.equal(renderProps.segments[0].image, "generated/images/image-1.webp");
      assert.equal(renderProps.segments[1].image, "generated/images/image-2.jpg");
      fs.mkdirSync(path.dirname(command.outputPath), { recursive: true });
      fs.writeFileSync(command.outputPath, "mock mp4\n", "utf8");
      return { status: "success", exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const snapshot = baseCanonicalSnapshot();
  snapshot.assets["voice-1"] = { ...snapshot.assets["voice-1"], renderPath: "https://cdn.test/assets/voice-48khz.wav", publicUrl: "https://cdn.test/assets/voice-48khz.wav" };
  snapshot.assets["music-1"] = { ...snapshot.assets["music-1"], renderPath: "https://cdn.test/assets/music-track.mp3", publicUrl: "https://cdn.test/assets/music-track.mp3" };
  snapshot.assets["image-1"] = { ...snapshot.assets["image-1"], renderPath: "https://cdn.test/images/image-one.webp", publicUrl: "https://cdn.test/images/image-one.webp" };
  snapshot.assets["image-2"] = { ...snapshot.assets["image-2"], renderPath: "https://cdn.test/images/image-two.jpg?token=secret", publicUrl: "https://cdn.test/images/image-two.jpg?token=secret" };
  snapshot.assets["brand-logo-demo-co"] = { ...snapshot.assets["brand-logo-demo-co"], renderPath: "https://cdn.test/brand/logo.webm", publicUrl: "https://cdn.test/brand/logo.webm" };

  await adapter({ projectId: "Draft Remote", snapshot, snapshotHash: "hash-remote" });

  const projectRoot = commands[0].projectRoot;
  assert.equal(commands.length, 1);
  assert.deepEqual(fetchCalls.sort(), Array.from(downloaded.keys()).filter((url) => url !== "https://cdn.test/brand/logo.webm").sort());
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "audio", "voice-1.wav"), "utf8"), "voice wav");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "audio", "music-1.mp3"), "utf8"), "music mp3");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "images", "image-1.webp"), "utf8"), "image one");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "images", "image-2.jpg"), "utf8"), "image two");
});

test("approval editor service can use configured video engine adapter and still rejects missing output", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "approval-video-engine-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "approval-video-engine-projects-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");
  const commands = [];
  const server = createApprovalEditorService({
    projectsRoot: fs.mkdtempSync(path.join(os.tmpdir(), "approval-editor-configured-")),
    env: {
      APPROVAL_EDITOR_RENDER_ADAPTER: "02-video-engine",
      APPROVAL_EDITOR_VIDEO_ENGINE_ROOT: videoEngineRoot,
      APPROVAL_EDITOR_VIDEO_ENGINE_PROJECTS_ROOT: projectsRoot,
    },
    renderCommandRunner: async (command) => {
      commands.push(command);
      return { status: "success", exitCode: 0, stdout: "no output created", stderr: "" };
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from("localized asset"),
    }),
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

    assert.equal(commands.length, 1);
    assert.equal(finalRender.status, 500);
    assert.equal(finalRender.body.error.code, "render_output_missing");
    assert.match(finalRender.body.error.message, /without creating final output/);
    const download = await api(baseUrl, `/api/projects/${encodeURIComponent(created.body.data.projectId)}/download/final`);
    assert.equal(download.body.data.finalUrl, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
      logo: { enabled: true, assetId: "brand-logo-demo-co" },
      outro: { enabled: true, assetId: "brand-outro-colombia" },
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
      "brand-logo-demo-co": { id: "brand-logo-demo-co", type: "logo", renderPath: "overlays/logo-demo-co-alpha-frames", status: "ready" },
      "brand-outro-colombia": { id: "brand-outro-colombia", type: "outro", renderPath: "overlays/final-demo-co.mp4", durationSeconds: 30.16, status: "ready" },
    },
  };
}
