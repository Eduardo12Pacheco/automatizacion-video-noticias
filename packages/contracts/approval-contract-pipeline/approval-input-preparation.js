const path = require("node:path");
const { stableId, ALIGNMENT_FALLBACK_WARNING } = require("./index");

const WHISPER_DERIVATIVE_FILE = "voice-whisper-16khz-mono.wav";

function resolveRemoteUrl(entry) {
  if (typeof entry === "string") return entry;
  return entry?.public_url || entry?.publicUrl || entry?.url || entry?.storage_public_url || "";
}

function extensionFor(contentType, remoteUrl, remoteTypes = new Map()) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (remoteTypes.has(normalized)) return remoteTypes.get(normalized);
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mpeg")) return ".mp3";
  const ext = path.extname(String(remoteUrl || "").split(/[?#]/)[0]);
  return ext || ".bin";
}

async function prepareApprovalInputs({ projectId, payload = {}, projectRoot, dependencies = {} } = {}) {
  const fs = dependencies.fs || require("node:fs");
  const nowIso = dependencies.nowIso || (() => new Date().toISOString());
  const remoteTypes = dependencies.REMOTE_IMAGE_TYPES || new Map();
  const whisperFile = dependencies.WHISPER_DERIVATIVE_FILE || WHISPER_DERIVATIVE_FILE;
  const selectedImages = Array.isArray(payload.selectedImages) ? payload.selectedImages : [];
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const voiceUrl = (dependencies.resolveRemoteUrl || resolveRemoteUrl)(payload.voiceAudio);
  const musicUrl = (dependencies.resolveRemoteUrl || resolveRemoteUrl)(payload.backgroundAudio);
  const download = dependencies.downloadRemoteBinary;
  if (typeof download !== "function") throw new Error("downloadRemoteBinary dependency is required");

  fs.mkdirSync(path.join(projectRoot, "audio"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "imagenes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "output"), { recursive: true });

  const voice = await download(dependencies.fetchImpl, voiceUrl);
  const music = await download(dependencies.fetchImpl, musicUrl);
  const voiceExt = extensionFor(voice.contentType, voiceUrl);
  const musicExt = extensionFor(music.contentType, musicUrl);
  const voiceLocalPath = `audio/voice-original${voiceExt}`;
  const musicLocalPath = `audio/background-music${musicExt}`;
  fs.writeFileSync(path.join(projectRoot, voiceLocalPath), voice.bytes);
  fs.writeFileSync(path.join(projectRoot, musicLocalPath), music.bytes);

  const whisperLocalPath = `audio/${whisperFile}`;
  dependencies.writeAudioDerivative16kMono?.({ inputPath: path.join(projectRoot, voiceLocalPath), outputPath: path.join(projectRoot, whisperLocalPath) });

  const preparedImageAssets = [];
  for (let index = 0; index < selectedImages.length; index += 1) {
    const image = selectedImages[index];
    const remoteUrl = (dependencies.resolveRemoteUrl || resolveRemoteUrl)(image);
    const bytes = await download(dependencies.fetchImpl, remoteUrl);
    const ext = extensionFor(bytes.contentType, remoteUrl, remoteTypes);
    const localPath = `imagenes/${String(index + 1).padStart(3, "0")}${ext}`;
    fs.writeFileSync(path.join(projectRoot, localPath), bytes.bytes);
    preparedImageAssets.push({ id: image?.id || `image-${index + 1}`, type: "image", localPath, publicPath: remoteUrl, source: { kind: "local", bridge: "approval-panel" }, status: "ready" });
  }

  const scriptPhrases = dependencies.buildScriptPhrasesForAlignment ? dependencies.buildScriptPhrasesForAlignment(segments) : segments.map((segment, index) => ({ id: index + 1, phrase: segment.phrase }));
  dependencies.writeJsonSchema?.(path.join(projectRoot, "output", "script-phrases.json"), dependencies.scriptPhrasesSchema || {}, { phrases: scriptPhrases });
  let alignedTimings = dependencies.parseAlignedTimingsFromFile?.(path.join(projectRoot, "output", "phrase-timestamps.json")) || null;
  let alignmentStatus;
  try {
    if (!alignedTimings) {
      dependencies.runTranscribePipeline?.({ projectRoot, projectId, whisperPath: path.join(projectRoot, whisperLocalPath) });
      alignedTimings = dependencies.parseAlignedTimingsFromFile?.(path.join(projectRoot, "output", "phrase-timestamps.json")) || null;
    }
    alignmentStatus = alignedTimings ? { status: "ready", source: "whisper-alignment", generatedAt: nowIso() } : { status: "pending", source: "whisper-alignment", generatedAt: nowIso() };
  } catch (error) {
    alignmentStatus = { status: "failed", source: "whisper-alignment", warning: dependencies.ALIGNMENT_FALLBACK_WARNING || ALIGNMENT_FALLBACK_WARNING, details: error.message, generatedAt: nowIso() };
  }

  return {
    projectId,
    preparedImageAssets,
    preparedAudioAssets: {
      voiceAsset: { id: `voice-${stableId(voiceUrl) || "voice"}`, type: "audio", localPath: voiceLocalPath, publicPath: voiceUrl, source: { kind: "local", bridge: "approval-panel" }, status: "ready" },
      musicAsset: { id: `music-${stableId(musicUrl) || "music"}`, type: "music", localPath: musicLocalPath, publicPath: musicUrl, source: { kind: "local", bridge: "approval-panel" }, status: "ready" },
    },
    alignmentResult: { alignedTimings, alignmentStatus },
    projectPhase: alignmentStatus.status === "ready" ? "editing" : "pending_alignment",
    paths: { voiceLocalPath, musicLocalPath, whisperLocalPath },
  };
}

module.exports = { prepareApprovalInputs, WHISPER_DERIVATIVE_FILE, ALIGNMENT_FALLBACK_WARNING };
