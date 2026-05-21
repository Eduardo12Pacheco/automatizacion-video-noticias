const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  assertNoSelectedVideoAssets,
  editorProjectSchema,
  renderPropsV2Schema,
} = require("../scripts/lib/schemas");
const {
  createEditorProject,
  deriveRenderPropsFromEditorProject,
  validateEditorProject,
} = require("../scripts/lib/editor-project");
const { readJsonSchema } = require("../scripts/lib/json-contracts");
const { secondsToDurationFrames, secondsToFrame, frameToSeconds } = require("../scripts/lib/timeline-utils");

const repoRoot = path.resolve(__dirname, "..");
const pngPixelBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";

function createSilentWavBuffer() {
  const sampleRate = 48000;
  const dataSize = sampleRate * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, 4, "ascii");
  buffer.write("fmt ", 12, 4, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, 4, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-editor-local-"));
  fs.mkdirSync(path.join(projectRoot, "guion"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "imagenes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "audio"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "output"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "guion", "guion.txt"), "Intro local|Cierre local\n");
  fs.writeFileSync(path.join(projectRoot, "imagenes", "intro.jpg"), Buffer.from(pngPixelBase64, "base64"));
  fs.writeFileSync(path.join(projectRoot, "imagenes", "cierre.jpg"), Buffer.from(pngPixelBase64, "base64"));
  fs.writeFileSync(path.join(projectRoot, "audio", "audio-48khz.wav"), createSilentWavBuffer());
  fs.writeFileSync(path.join(projectRoot, "audio", "music.wav"), createSilentWavBuffer());
  return projectRoot;
}

function writeProjectConfig(projectRoot, id = "test-project") {
  fs.writeFileSync(
    path.join(projectRoot, "project.json"),
    JSON.stringify(
      {
        id,
        title: id,
        schemaVersion: 1,
        phase: "editing",
        paths: {
          projectRoot,
          script: "guion/guion.txt",
          editorProject: "editor-project.json",
          output: "output",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function writeEditorProject(projectRoot, editorProject) {
  fs.writeFileSync(path.join(projectRoot, "editor-project.json"), JSON.stringify(editorProject, null, 2));
}

test("editor contracts default dust OFF and enforce voice/music/image gates", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p1", title: "P1", seedMedia: true });
  const parsed = editorProjectSchema.parse(editorProject);

  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].dust.enabled, false);
  assert.equal(parsed.rows[0].filter.enabled, true);
  assert.equal(validateEditorProject(projectRoot, parsed).gates.ok, true);

  fs.rmSync(path.join(projectRoot, "audio", "music.wav"));
  const blocked = validateEditorProject(projectRoot, parsed);
  assert.equal(blocked.gates.ok, false);
  assert.match(blocked.gates.blocking.join(";"), /stale:music|music/);
});

test("editor contracts accept object-shaped Whip SFX metadata", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p1-whip", title: "P1 Whip", seedMedia: true });
  editorProject.rows[0].transition = "whip";
  editorProject.rows[0].sfx = { type: "whip", assetId: "whip", src: "sfx/whoosh-demo.wav" };

  const parsed = editorProjectSchema.parse(editorProject);

  assert.deepEqual(parsed.rows[0].sfx, { type: "whip", assetId: "whip", src: "sfx/whoosh-demo.wav" });
  assert.equal(validateEditorProject(projectRoot, parsed).gates.ok, true);
});

test("selected video asset is valid contract shape but hard-fails MVP render use", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p2", title: "P2", seedMedia: true });
  editorProject.assets.push({ id: "video-future", type: "video", source: { kind: "api-candidate" }, localPath: "imagenes/future.mp4", status: "ready" });
  editorProject.rows[0].selectedAssetId = "video-future";

  assert.throws(
    () => assertNoSelectedVideoAssets(editorProject),
    /asset\.type='video'.*reservado para futuro/i,
  );
});

test("deriveRenderPropsFromEditorProject produces render props v2 from same editor JSON", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p3", title: "P3", seedMedia: true });
  editorProject.rows[0].dust.enabled = true;
  editorProject.rows[1].dust.enabled = false;
  editorProject.rows[0].endTime = 1.5;
  editorProject.rows[1].startTime = 2.25;
  editorProject.rows[1].endTime = 4;
  const props = deriveRenderPropsFromEditorProject(projectRoot, editorProject);
  const parsed = renderPropsV2Schema.parse(props);

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.audio.voiceSrc, "generated/audio-48khz.wav");
  assert.equal(parsed.audio.voice.volume, 1);
  assert.equal(parsed.audio.musicSrc, "generated/music.wav");
  assert.equal(parsed.segments[0].endTime, parsed.segments[1].startTime);
  assert.equal(parsed.segments[0].dust.enabled, true);
  assert.equal(parsed.segments[1].dust.enabled, false);
  assert.equal(parsed.segments[0].logo.enabled, true);
  assert.match(parsed.logo.src || "", /generated\/(overlays\/logo-demo-alpha\.webm|logo-placeholder\.png)$/);
  assert.equal(parsed.overlays.dust?.blendMode, "screen");
  assert.equal(parsed.outro.enabled, true);
});

test("editor project contract accepts explicit image motion objects and maps them to render props", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p-motion-object", title: "P Motion", seedMedia: true });
  const explicitMotion = {
    fromScale: 1,
    toScale: 1.1,
    fromX: 0,
    fromY: 0,
    toX: 0,
    toY: 0,
    easing: "linear",
  };
  editorProject.rows[0].mediaMode = "newspaper";
  editorProject.rows[0].motion = explicitMotion;

  const parsedProject = editorProjectSchema.parse(editorProject);
  const props = deriveRenderPropsFromEditorProject(projectRoot, parsedProject);

  assert.deepEqual(parsedProject.rows[0].motion, explicitMotion);
  assert.deepEqual(props.segments[0].motion, explicitMotion);
  assert.equal(props.segments[0].mediaMode, "newspaper");
});

test("persisted editor-project JSON with object motion validates before final render status update", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p-persisted-motion", title: "P Persisted Motion", seedMedia: true });
  const explicitMotion = {
    fromScale: 1.02,
    toScale: 1.16,
    fromX: -8,
    fromY: 3,
    toX: 8,
    toY: -3,
    easing: "linear",
  };
  editorProject.rows[0].mediaMode = "newspaper";
  editorProject.rows[0].motion = explicitMotion;
  writeEditorProject(projectRoot, editorProject);

  const persisted = readJsonSchema(path.join(projectRoot, "editor-project.json"), editorProjectSchema);

  assert.deepEqual(persisted.rows[0].motion, explicitMotion);
  assert.equal(persisted.rows[0].mediaMode, "newspaper");
});

test("motion object schemas stay explicit and reject malformed fields", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p-bad-motion", title: "P Bad Motion", seedMedia: true });
  editorProject.rows[0].motion = { fromScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0, easing: "linear" };

  assert.throws(
    () => editorProjectSchema.parse(editorProject),
    /toScale/i,
  );
  assert.throws(
    () => renderPropsV2Schema.parse({
      schemaVersion: 2,
      fps: 30,
      audio: { voiceSrc: "voice.wav", musicSrc: "music.wav", music: {} },
      segments: [{ phrase: "Hola", image: "image.jpg", startTime: 0, endTime: 1, motion: { bogus: true } }],
    }),
    /fromScale|toScale/i,
  );
});

test("no selected images blocks preview and lists affected rows", () => {
  const projectRoot = makeProject();
  const editorProject = createEditorProject(projectRoot, { projectId: "p-no-images", title: "P no images" });
  editorProject.rows[0].selectedAssetId = null;

  const diagnostics = validateEditorProject(projectRoot, editorProject);

  assert.equal(diagnostics.gates.ok, false);
  assert.match(diagnostics.gates.missing.join(";"), /row:row-1:image/);
});

test("render failure writes retry diagnostics without requiring full render", () => {
  const projectRoot = makeProject();
  writeProjectConfig(projectRoot, "p-render-error");
  const editorProject = createEditorProject(projectRoot, { projectId: "p-render-error", title: "P render error", seedMedia: true });
  writeEditorProject(projectRoot, editorProject);

  const render = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "render-video.js"), `--project-root=${projectRoot}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, REMOTION_EDITOR_FORCE_RENDER_FAILURE: "1" },
  });

  assert.notEqual(render.status, 0);
  const diagnostics = JSON.parse(fs.readFileSync(path.join(projectRoot, "output", "diagnostics.json"), "utf8"));
  const persisted = JSON.parse(fs.readFileSync(path.join(projectRoot, "editor-project.json"), "utf8"));
  assert.equal(persisted.renderStatus.status, "error");
  assert.match(diagnostics.errors.join(";"), /Render fallo/i);
  assert.match(diagnostics.retry.stderr, /forced render failure/i);
});

test("mocked render success writes mp4 output and done state without real Remotion render", () => {
  const projectRoot = makeProject();
  writeProjectConfig(projectRoot, "p-render-success");
  const editorProject = createEditorProject(projectRoot, { projectId: "p-render-success", title: "P render success", seedMedia: true });
  writeEditorProject(projectRoot, editorProject);

  const render = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "render-video.js"), `--project-root=${projectRoot}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, REMOTION_EDITOR_MOCK_RENDER_SUCCESS: "1" },
  });

  assert.equal(render.status, 0, render.stderr);
  const outputPath = path.join(projectRoot, "output", "video-final.mp4");
  const persisted = JSON.parse(fs.readFileSync(path.join(projectRoot, "editor-project.json"), "utf8"));
  const projectConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, "project.json"), "utf8"));
  assert.equal(fs.existsSync(outputPath), true);
  assert.equal(fs.statSync(outputPath).size > 0, true);
  assert.equal(persisted.renderStatus.status, "done");
  assert.equal(persisted.renderStatus.outputPath, outputPath);
  assert.equal(persisted.renderStatus.diagnosticsPath, null);
  assert.equal(projectConfig.phase, "done");
});

test("final profile fails with actionable error when composition contract is missing", () => {
  const projectRoot = makeProject();
  writeProjectConfig(projectRoot, "p-final-missing-contract");
  const editorProject = createEditorProject(projectRoot, { projectId: "p-final-missing-contract", title: "P final missing contract", seedMedia: true });
  writeEditorProject(projectRoot, editorProject);

  const render = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "render-video.js"), `--project-root=${projectRoot}`, "--profile=final"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, REMOTION_EDITOR_MOCK_RENDER_SUCCESS: "1" },
  });

  assert.notEqual(render.status, 0);
  assert.match(`${render.stdout}\n${render.stderr}`, /composition-contract\.json/i);
  assert.match(`${render.stdout}\n${render.stderr}`, /--profile=final/i);
  assert.equal(fs.existsSync(path.join(projectRoot, "output", "video-final.mp4")), false);
});

test("render dry-run prefers persisted composition contract over legacy editor rows", () => {
  const projectRoot = makeProject();
  writeProjectConfig(projectRoot, "p-contract-render");
  const editorProject = createEditorProject(projectRoot, { projectId: "p-contract-render", title: "P contract", seedMedia: true });
  editorProject.rows[0].selectedAssetId = null;
  writeEditorProject(projectRoot, editorProject);

  const persistedContract = {
    version: 1,
    contract: {
      fps: 30,
      renderProfile: { fps: 30 },
      audio: {
        voiceAssetId: "voice-asset",
        musicAssetId: "music-asset",
        voice: { volume: 1, muted: false },
        music: { volume: 0.15, muted: false, loop: true, fadeInSeconds: 0.5, fadeOutSeconds: 1 },
      },
      segments: [
        { rowId: "row-1", phrase: "Intro", startTime: 0, endTime: 1.5, effectiveEndTime: 1.5, selectedAssetId: "img-asset", paragraphBoundaryAfter: true, nextRowId: "row-2", motion: "slow-zoom-in", dust: { enabled: true }, logo: { enabled: true }, filter: { enabled: true, mode: "cover" }, transition: "whip", transitionConfig: { type: "whip", durationSeconds: 0.5, direction: "left-to-right" }, sfx: { type: "whip", assetId: "whip", src: "sfx/whoosh-demo.wav" } },
        { rowId: "row-2", phrase: "Outro", startTime: 1.5, endTime: 3, effectiveEndTime: 3, selectedAssetId: "img-asset", motion: "slow-zoom-in", dust: { enabled: true }, logo: { enabled: true }, filter: { enabled: true, mode: "cover" }, transition: "none" },
      ],
      globalLayers: {},
    },
    manifest: {
      version: 1,
      assets: {
        "img-asset": { status: "ready", renderPath: "generated/images/intro.jpg" },
        "voice-asset": { status: "ready", renderPath: "generated/audio-48khz.wav" },
        "music-asset": { status: "ready", renderPath: "generated/music.wav" },
      },
    },
  };
  fs.writeFileSync(path.join(projectRoot, "composition-contract.json"), JSON.stringify(persistedContract, null, 2));

  const render = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "render-video.js"), `--project-root=${projectRoot}`, "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(render.status, 0, render.stderr);
  const props = JSON.parse(fs.readFileSync(path.join(projectRoot, "output", "render-props.json"), "utf8"));
  assert.equal(props.audio.voiceSrc, "generated/audio-48khz.wav");
  assert.equal(props.segments[0].image, "generated/images/intro.jpg");
  assert.equal(props.whipTransitions[0].sfxSrc, "sfx/whoosh-demo.wav");
  assert.equal(fs.existsSync(path.join(projectRoot, "public", "sfx", "whoosh-demo.wav")), true);
});

test("timing helpers keep deterministic frame math", () => {
  assert.equal(secondsToFrame(1.5, 30), 45);
  assert.equal(secondsToDurationFrames(1.5, 2.25, 30), 23);
  assert.equal(frameToSeconds(45, 30), 1.5);
});
