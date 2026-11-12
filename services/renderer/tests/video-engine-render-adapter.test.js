const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createVideoEngineRenderAdapter, buildMinimalRenderScaffold } = require("../scripts/lib/render/video-engine-render-adapter");
const { adaptCompositionContractToRenderProps } = require("../scripts/lib/contracts/composition-contract");
const { editorProjectSchema } = require("../scripts/lib/contracts/schemas");

test("video engine render adapter persists canonical snapshot and invokes render-video final profile", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");
  fs.mkdirSync(path.join(videoEngineRoot, "assets", "overlays"), { recursive: true });
  fs.mkdirSync(path.join(videoEngineRoot, "assets", "overlays", "logo-secondary.webm"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "assets", "overlays", "logo-secondary.webm", "frame-0000.png"), "source logo png\n", "utf8");
  fs.writeFileSync(path.join(videoEngineRoot, "assets", "overlays", "outro-secondary.mp4"), "source final mp4\n", "utf8");
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
  assert.equal(persisted.contract.globalLayers.outro.assetId, "brand-outro-secondary");
  assert.equal(persisted.manifest.assets["brand-logo-secondary"].renderPath, "overlays/logo-secondary.webm");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "overlays", "logo-secondary.webm", "frame-0000.png"), "utf8"), "source logo png\n");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "overlays", "outro-secondary.mp4"), "utf8"), "source final mp4\n");
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
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "..", "approval-editor", "server.js"), "utf8");
  const alignmentSource = fs.readFileSync(path.join(__dirname, "..", "..", "approval-editor", "lib", "real-alignment.js"), "utf8");
  const adapterSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "lib", "render", "video-engine-render-adapter.js"), "utf8");

  assert.equal(serverSource.includes("services/renderer/scripts/lib/guion-parsing"), false);
  assert.equal(alignmentSource.includes("services/renderer/scripts/lib/phrase-alignment"), false);
  assert.equal(adapterSource.includes("services/renderer/scripts/lib/editor-project"), false);
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
  assert.equal(scaffold.assets.some((asset) => asset.id === "image-1" && asset.type === "image"), true);
  assert.equal(scaffold.assets.some((asset) => asset.id === "brand-logo-secondary" && asset.type === "logo"), true);
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
      assert.equal(assets["brand-logo-secondary"].renderPath, "overlays/logo-secondary.webm");
      assert.equal(assets["brand-logo-secondary"].publicUrl, "./assets/logo-secondary.webm");
      assert.equal(assets["brand-outro-secondary"].renderPath, "overlays/outro-secondary.mp4");
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
  snapshot.assets["brand-logo-secondary"] = { ...snapshot.assets["brand-logo-secondary"], renderPath: "https://cdn.test/brand/logo.webm", publicUrl: "https://cdn.test/brand/logo.webm" };

  await adapter({ projectId: "Draft Remote", snapshot, snapshotHash: "hash-remote" });

  const projectRoot = commands[0].projectRoot;
  assert.equal(commands.length, 1);
  assert.deepEqual(fetchCalls.sort(), Array.from(downloaded.keys()).filter((url) => url !== "https://cdn.test/brand/logo.webm").sort());
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "audio", "voice-1.wav"), "utf8"), "voice wav");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "audio", "music-1.mp3"), "utf8"), "music mp3");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "images", "image-1.webp"), "utf8"), "image one");
  assert.equal(fs.readFileSync(path.join(projectRoot, "public", "generated", "images", "image-2.jpg"), "utf8"), "image two");
});

test("video engine render adapter retries transient remote render asset download failures", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-remote-retry-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-remote-retry-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");

  const imageUrl = "https://example.local/media/demo-emiliano.jpg";
  const fetchCalls = [];
  const commands = [];
  const adapter = createVideoEngineRenderAdapter({
    videoEngineRoot,
    projectsRoot,
    renderAssetRetryDelaysMs: [0],
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      if (url === imageUrl && fetchCalls.filter((entry) => entry === imageUrl).length === 1) {
        return { ok: false, status: 503, arrayBuffer: async () => Buffer.from("") };
      }
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(url === imageUrl ? "image after retry" : "asset") };
    },
    runCommand: async (command) => {
      commands.push(command);
      fs.mkdirSync(path.dirname(command.outputPath), { recursive: true });
      fs.writeFileSync(command.outputPath, "mock mp4\n", "utf8");
      return { status: "success", exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const snapshot = baseCanonicalSnapshot();
  snapshot.assets["image-1"] = { ...snapshot.assets["image-1"], renderPath: imageUrl, publicUrl: imageUrl };

  await adapter({ projectId: "Draft Remote Retry", snapshot, snapshotHash: "hash-remote-retry" });

  assert.equal(commands.length, 1);
  assert.equal(fetchCalls.filter((entry) => entry === imageUrl).length, 2);
  assert.equal(fs.readFileSync(path.join(commands[0].projectRoot, "public", "generated", "images", "image-1.jpg"), "utf8"), "image after retry");
});

test("video engine render adapter repairs legacy URL-keyed video segment assets before localization", async () => {
  const videoEngineRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-root-video-url-"));
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-projects-video-url-"));
  fs.mkdirSync(path.join(videoEngineRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(videoEngineRoot, "scripts", "render-video.js"), "// fake render entrypoint\n", "utf8");

  const sourceUrl = "https://cdn.test/projects/demo/videos/source.mp4";
  const sourceSrcUrl = "https://cdn.test/projects/demo/videos/source-from-media.mp4";
  const fetchCalls = [];
  const commands = [];
  const adapter = createVideoEngineRenderAdapter({
    videoEngineRoot,
    projectsRoot,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      assert.ok([sourceUrl, sourceSrcUrl].includes(url), `unexpected video download url: ${url}`);
      return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("video mp4") };
    },
    runCommand: async (command) => {
      commands.push(command);
      const persisted = JSON.parse(fs.readFileSync(path.join(command.projectRoot, "composition-contract.json"), "utf8"));
      const videoAsset = persisted.contract.assets[sourceUrl];
      assert.match(videoAsset.renderPath, /^generated\/overlays\/.+\.mp4$/);
      assert.equal(videoAsset.publicUrl, sourceUrl);
      assert.equal(videoAsset.previewUrl, sourceUrl);
      const renderProps = adaptCompositionContractToRenderProps({ contract: persisted.contract, manifest: persisted.manifest });
      assert.equal(renderProps.segments[0].media.kind, "video-segment");
      assert.equal(renderProps.segments[0].media.sourceVideoSrc, videoAsset.renderPath);
      assert.equal(renderProps.segments[1].media.kind, "video-segment");
      assert.match(renderProps.segments[1].media.sourceVideoSrc, /^generated\/overlays\/.+\.mp4$/);
      fs.mkdirSync(path.dirname(command.outputPath), { recursive: true });
      fs.writeFileSync(command.outputPath, "mock mp4\n", "utf8");
      return { status: "success", exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const snapshot = baseCanonicalSnapshot();
  snapshot.rows[0] = {
    ...snapshot.rows[0],
    media: {
      kind: "video-segment",
      sourceVideoAssetId: sourceUrl,
      sourceInSeconds: 1.5,
      durationSeconds: 1.2,
      overlayColor: "#3835AF",
      overlayOpacity: 0.3,
      effect1AssetId: "overlay-layer-01",
      effect2AssetId: "overlay-layer-02",
    },
  };
  snapshot.rows[1] = {
    ...snapshot.rows[1],
    media: {
      kind: "video-segment",
      sourceVideoAssetId: "legacy-video-from-media-src",
      sourceVideoSrc: sourceSrcUrl,
      sourceInSeconds: 0,
      durationSeconds: 1.6,
      overlayColor: "#3835AF",
      overlayOpacity: 0.3,
      effect1AssetId: "overlay-layer-01",
      effect2AssetId: "overlay-layer-02",
    },
  };
  snapshot.assets[sourceUrl] = { assetId: sourceUrl, id: sourceUrl, type: "video", role: "video", publicUrl: null, previewUrl: null, renderPath: null, status: "ready" };
  snapshot.assets["legacy-video-from-media-src"] = { assetId: "legacy-video-from-media-src", id: "legacy-video-from-media-src", type: "video", role: "video", publicUrl: null, previewUrl: null, renderPath: null, status: "ready" };
  snapshot.assets["overlay-layer-01"] = { assetId: "overlay-layer-01", type: "video", role: "effect", renderPath: "overlays/overlay-layer-01.mp4", status: "ready" };
  snapshot.assets["overlay-layer-02"] = { assetId: "overlay-layer-02", type: "video", role: "effect", renderPath: "overlays/overlay-layer-02.mp4", status: "ready" };

  await adapter({ projectId: "Draft Video Url", snapshot, snapshotHash: "hash-video-url" });

  assert.equal(commands.length, 1);
  assert.deepEqual(fetchCalls.sort(), [sourceUrl, sourceSrcUrl].sort());
  assert.equal(fs.readFileSync(path.join(commands[0].projectRoot, "public", "generated", "overlays", `${sourceUrl.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}.mp4`), "utf8"), "video mp4");
});

test("video engine scaffold keeps selected image and Aurenia brand asset references valid", () => {
  const snapshot = {
    ...baseCanonicalSnapshot(),
    brandChannel: "demo-primary",
    globalLayers: {
      logoAssetId: "brand-logo-primary",
      outroAssetId: "brand-outro-primary",
      logo: { enabled: true, assetId: "brand-logo-primary" },
      outro: { enabled: true, assetId: "brand-outro-primary" },
    },
    rows: [
      { id: "row-1", phrase: "Linea URL", startTime: 0, endTime: 1.2, selectedAssetId: "https://cdn.test/custom/row-1.png", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true } },
      { id: "row-2", phrase: "Linea generated", startTime: 1.2, endTime: 2.8, selectedAssetId: "image-https-cdn-test-generated-row-2-png", motion: "slow-zoom-in", dust: { enabled: false }, logo: { enabled: true }, candidates: [
        { id: "candidate-row-2", assetId: "image-https-cdn-test-generated-row-2-png", publicPath: "https://cdn.test/generated/row-2.png", source: { kind: "approval-editor-service" } },
      ] },
    ],
    assets: {},
  };

  const scaffold = buildMinimalRenderScaffold({ projectId: "draft-aurenia", title: "Draft Aurenia", snapshot });
  const parsed = editorProjectSchema.parse(scaffold);

  assert.equal(parsed.globalLayers.logoAssetId, "brand-logo-primary");
  assert.equal(parsed.globalLayers.outroAssetId, "brand-outro-primary");
  assert.deepEqual(parsed.rows.map((row) => row.selectedAssetId), [
    "https://cdn.test/custom/row-1.png",
    "image-https-cdn-test-generated-row-2-png",
  ]);
  assert.equal(parsed.assets.some((asset) => asset.id === "brand-logo-primary" && asset.type === "logo"), true);
  assert.equal(parsed.assets.some((asset) => asset.id === "brand-outro-primary" && asset.type === "outro"), true);
  assert.equal(parsed.assets.some((asset) => asset.id === "https://cdn.test/custom/row-1.png" && asset.type === "image"), true);
  assert.equal(parsed.assets.some((asset) => asset.id === "image-https-cdn-test-generated-row-2-png" && asset.publicPath === "https://cdn.test/generated/row-2.png"), true);
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
