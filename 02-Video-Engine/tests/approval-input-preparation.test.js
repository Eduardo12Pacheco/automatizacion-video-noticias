const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prepareApprovalInputs } = require("../scripts/lib/contracts/approval-input-preparation");
const sharedApprovalPipeline = require("../../03-Contracts-Core/approval-contract-pipeline");

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-approval-prep-"));
  fs.mkdirSync(path.join(root, "audio"), { recursive: true });
  fs.mkdirSync(path.join(root, "imagenes"), { recursive: true });
  fs.mkdirSync(path.join(root, "output"), { recursive: true });
  return root;
}

test("prepareApprovalInputs prepara audio e imagenes con dependencias inyectadas", async () => {
  const projectRoot = makeProjectRoot();
  const calls = [];
  const payload = {
    segments: [{ id: "row-1", phrase: "Linea 1" }, { id: "row-2", phrase: "Linea 2" }],
    selectedImages: [{ id: "img-uno", public_url: "https://cdn.test/image-1.jpg" }, { id: "img-dos", public_url: "https://cdn.test/image-2.jpg" }],
    voiceAudio: { public_url: "https://cdn.test/voice.wav" },
    backgroundAudio: { public_url: "https://cdn.test/music.wav" },
  };

  const result = await prepareApprovalInputs({
    projectId: "demo",
    payload,
    projectRoot,
    dependencies: {
      fs,
      fetchImpl: async () => {
        throw new Error("network must not be called directly");
      },
      env: {},
      stableId: (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      nowIso: () => "2026-01-01T00:00:00.000Z",
      REMOTE_IMAGE_TYPES: new Map([["image/jpeg", ".jpg"]]),
      WHISPER_DERIVATIVE_FILE: "voice-whisper-16khz-mono.wav",
      ALIGNMENT_FALLBACK_WARNING: "timing_fallback_not_whisper_aligned",
      scriptPhrasesSchema: {},
      resolveRemoteUrl: (entry) => (typeof entry === "string" ? entry : entry?.public_url || null),
      downloadRemoteBinary: async (_fetchImpl, remoteUrl) => {
        calls.push(remoteUrl);
        if (remoteUrl.includes("voice")) return { bytes: Buffer.from("voice-bytes"), contentType: "audio/wav" };
        if (remoteUrl.includes("music")) return { bytes: Buffer.from("music-bytes"), contentType: "audio/wav" };
        return { bytes: Buffer.from(`img:${remoteUrl}`), contentType: "image/jpeg" };
      },
      writeAudioDerivative16kMono: ({ inputPath, outputPath }) => {
        assert.match(inputPath, /voice-original\.wav$/);
        fs.writeFileSync(outputPath, Buffer.from("whisper"));
      },
      buildScriptPhrasesForAlignment: (segments) => segments.map((segment, index) => ({ id: index + 1, phrase: segment.phrase })),
      writeJsonSchema: (target, _schema, data) => {
        fs.writeFileSync(target, JSON.stringify(data, null, 2));
      },
      parseAlignedTimingsFromFile: () => ({ phrases: [{ startTime: 0, endTime: 1 }, { startTime: 1, endTime: 2 }] }),
      runTranscribePipeline: () => {
        throw new Error("no deberia correr transcribe si ya hay timings");
      },
    },
  });

  assert.deepEqual(calls, [
    "https://cdn.test/voice.wav",
    "https://cdn.test/music.wav",
    "https://cdn.test/image-1.jpg",
    "https://cdn.test/image-2.jpg",
  ]);
  assert.equal(result.preparedImageAssets.length, 2);
  assert.equal(result.preparedAudioAssets.voiceAsset.localPath, "audio/voice-original.wav");
  assert.equal(result.preparedAudioAssets.musicAsset.localPath, "audio/background-music.wav");
  assert.equal(result.alignmentResult.alignmentStatus.status, "ready");
  assert.equal(result.projectPhase, "editing");
  assert.equal(fs.existsSync(path.join(projectRoot, "audio", "voice-original.wav")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "audio", "background-music.wav")), true);
  assert.equal(fs.existsSync(path.join(projectRoot, "audio", "voice-whisper-16khz-mono.wav")), true);
});

test("prepareApprovalInputs devuelve fallback failed si falla transcribe", async () => {
  const projectRoot = makeProjectRoot();
  const payload = {
    segments: [{ id: "row-1", phrase: "Linea 1" }],
    selectedImages: [],
    voiceAudio: { public_url: "https://cdn.test/voice.wav" },
    backgroundAudio: { public_url: "https://cdn.test/music.wav" },
  };

  const result = await prepareApprovalInputs({
    projectId: "demo",
    payload,
    projectRoot,
    dependencies: {
      fs,
      fetchImpl: async () => new Response(""),
      env: {},
      stableId: (value) => String(value),
      nowIso: () => "2026-01-01T00:00:00.000Z",
      REMOTE_IMAGE_TYPES: new Map(),
      WHISPER_DERIVATIVE_FILE: "voice-whisper-16khz-mono.wav",
      ALIGNMENT_FALLBACK_WARNING: "timing_fallback_not_whisper_aligned",
      scriptPhrasesSchema: {},
      resolveRemoteUrl: (entry) => entry.public_url,
      downloadRemoteBinary: async () => ({ bytes: Buffer.from("x"), contentType: "audio/wav" }),
      writeAudioDerivative16kMono: ({ outputPath }) => fs.writeFileSync(outputPath, Buffer.from("whisper")),
      buildScriptPhrasesForAlignment: () => [{ id: 1, phrase: "Linea 1" }],
      writeJsonSchema: () => {},
      parseAlignedTimingsFromFile: () => null,
      runTranscribePipeline: () => {
        throw new Error("whisper explotó");
      },
    },
  });

  assert.equal(result.alignmentResult.alignmentStatus.status, "failed");
  assert.equal(result.alignmentResult.alignmentStatus.warning, "timing_fallback_not_whisper_aligned");
  assert.match(result.alignmentResult.alignmentStatus.details, /whisper explotó/);
  assert.equal(result.projectPhase, "pending_alignment");
});

test("shared prepareApprovalInputs keeps injected orchestration seam", async () => {
  const projectRoot = makeProjectRoot();
  const calls = [];
  const payload = {
    segments: [{ id: "row-1", phrase: "Linea 1" }],
    selectedImages: [{ id: "img-uno", public_url: "https://cdn.test/image-1.jpg" }],
    voiceAudio: { public_url: "https://cdn.test/voice.wav" },
    backgroundAudio: { public_url: "https://cdn.test/music.wav" },
  };

  const result = await sharedApprovalPipeline.prepareApprovalInputs({
    projectId: "shared-demo",
    payload,
    projectRoot,
    dependencies: {
      fs,
      fetchImpl: async () => new Response(""),
      env: {},
      stableId: (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      nowIso: () => "2026-01-01T00:00:00.000Z",
      REMOTE_IMAGE_TYPES: new Map([["image/jpeg", ".jpg"]]),
      WHISPER_DERIVATIVE_FILE: "voice-whisper-16khz-mono.wav",
      ALIGNMENT_FALLBACK_WARNING: "timing_fallback_not_whisper_aligned",
      scriptPhrasesSchema: {},
      resolveRemoteUrl: (entry) => (typeof entry === "string" ? entry : entry?.public_url || null),
      downloadRemoteBinary: async (_fetchImpl, remoteUrl) => {
        calls.push(remoteUrl);
        return { bytes: Buffer.from("x"), contentType: remoteUrl.includes("image") ? "image/jpeg" : "audio/wav" };
      },
      writeAudioDerivative16kMono: ({ outputPath }) => fs.writeFileSync(outputPath, Buffer.from("whisper")),
      buildScriptPhrasesForAlignment: (segments) => segments.map((segment, index) => ({ id: index + 1, phrase: segment.phrase })),
      writeJsonSchema: (target, _schema, data) => fs.writeFileSync(target, JSON.stringify(data, null, 2)),
      parseAlignedTimingsFromFile: () => ({ phrases: [{ startTime: 0, endTime: 1 }] }),
      runTranscribePipeline: () => {
        throw new Error("no deberia correr transcribe con timings existentes");
      },
    },
  });

  assert.deepEqual(calls, [
    "https://cdn.test/voice.wav",
    "https://cdn.test/music.wav",
    "https://cdn.test/image-1.jpg",
  ]);
  assert.equal(result.preparedImageAssets.length, 1);
  assert.equal(result.alignmentResult.alignmentStatus.status, "ready");
  assert.equal(result.paths.whisperLocalPath, "audio/voice-whisper-16khz-mono.wav");
});

test("legacy approval input path re-exports shared module warnings/constants", () => {
  assert.equal(typeof sharedApprovalPipeline.ALIGNMENT_FALLBACK_WARNING, "string");
  assert.equal(
    sharedApprovalPipeline.ALIGNMENT_FALLBACK_WARNING,
    "timing_fallback_not_whisper_aligned",
  );
});
