const fs = require("fs");
const path = require("path");
const {
  PIPELINE_PLACEHOLDER_TOKEN,
  sortImageFiles,
} = require("./image-selection");

const PREFERRED_RENDER_AUDIO = "audio-48khz.wav";
const FALLBACK_RENDER_AUDIO = "audio-16khz.wav";
const SUPPORTED_AUDIO_EXT = [".wav", ".mp3", ".m4a", ".aac"];
const NORMALIZED_AUDIO_FILES = [FALLBACK_RENDER_AUDIO, PREFERRED_RENDER_AUDIO];

function parseWavDurationSeconds(audioPath) {
  const buffer = fs.readFileSync(audioPath);

  if (buffer.length < 44) {
    throw new Error(`WAV invalido o truncado: ${audioPath}`);
  }

  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`El archivo no es WAV valido: ${audioPath}`);
  }

  let offset = 12;
  let byteRate = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt " && chunkSize >= 16) {
      byteRate = buffer.readUInt32LE(chunkDataStart + 8);
    }

    if (chunkId === "data") {
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (!byteRate || !dataSize) {
    throw new Error(`No se pudo leer metadata WAV: ${audioPath}`);
  }

  return Number((dataSize / byteRate).toFixed(6));
}

function resolveProjectRoot(argv) {
  const explicit = argv.find((entry) => entry.startsWith("--project-root="));
  return explicit
    ? path.resolve(explicit.slice("--project-root=".length))
    : process.cwd();
}

function isSupportedAudioFile(file) {
  return SUPPORTED_AUDIO_EXT.includes(path.extname(file).toLowerCase());
}

function listSupportedAudioFiles(audioDir) {
  if (!fs.existsSync(audioDir)) {
    return [];
  }

  return fs
    .readdirSync(audioDir)
    .filter((file) => isSupportedAudioFile(file))
    .sort((a, b) => a.localeCompare(b));
}

function toAudioSelection(audioDir, selectedFile, strategy) {
  if (!selectedFile) {
    return null;
  }

  const absolutePath = path.join(audioDir, selectedFile);
  return {
    selectedFile,
    absolutePath,
    strategy,
    durationSeconds:
      path.extname(selectedFile).toLowerCase() === ".wav"
        ? parseWavDurationSeconds(absolutePath)
        : null,
  };
}

function resolveAudioSource(audioDir) {
  const files = listSupportedAudioFiles(audioDir);

  if (files.includes(PREFERRED_RENDER_AUDIO)) {
    return toAudioSelection(
      audioDir,
      PREFERRED_RENDER_AUDIO,
      "existing-normalized-render-audio",
    );
  }

  if (files.includes(FALLBACK_RENDER_AUDIO)) {
    return toAudioSelection(
      audioDir,
      FALLBACK_RENDER_AUDIO,
      "existing-normalized-stt-audio",
    );
  }

  const sourceFile = files.find(
    (file) => path.parse(file).name.toLowerCase() === "source",
  );
  if (sourceFile) {
    return toAudioSelection(audioDir, sourceFile, "source-audio");
  }

  return toAudioSelection(audioDir, files[0] || null, "first-supported-audio");
}

function resolveSttAudio(audioDir) {
  const files = listSupportedAudioFiles(audioDir);
  return toAudioSelection(
    audioDir,
    files.includes(FALLBACK_RENDER_AUDIO) ? FALLBACK_RENDER_AUDIO : null,
    "normalized-stt-audio",
  );
}

function resolveRenderAudio(audioDir) {
  const files = listSupportedAudioFiles(audioDir);
  let selectedFile = null;
  let strategy = null;

  if (files.includes(PREFERRED_RENDER_AUDIO)) {
    selectedFile = PREFERRED_RENDER_AUDIO;
    strategy = "preferred-render-audio";
  } else if (files.includes(FALLBACK_RENDER_AUDIO)) {
    selectedFile = FALLBACK_RENDER_AUDIO;
    strategy = "stt-fallback-audio";
  } else {
    selectedFile = files.find((file) =>
      SUPPORTED_AUDIO_EXT.includes(path.extname(file).toLowerCase()),
    );
    strategy = selectedFile ? "first-supported-audio" : null;
  }

  if (!selectedFile) {
    return null;
  }

  return toAudioSelection(audioDir, selectedFile, strategy);
}

function resolveVisualSegment(segmentImage, imagesDir) {
  const availableImages = fs.existsSync(imagesDir)
    ? sortImageFiles(
        fs
          .readdirSync(imagesDir)
          .filter((file) => /\.(png|jpg|jpeg|webp|svg)$/i.test(file)),
      )
    : [];
  const requestedFile = path.basename(String(segmentImage || ""));

  if (requestedFile === PIPELINE_PLACEHOLDER_TOKEN) {
    return {
      requestedImage: segmentImage || null,
      resolvedImage: PIPELINE_PLACEHOLDER_TOKEN,
      strategy: "placeholder",
    };
  }

  if (requestedFile && availableImages.includes(requestedFile)) {
    return {
      requestedImage: segmentImage || null,
      resolvedImage: requestedFile,
      strategy: "requested",
    };
  }

  if (availableImages.length > 0) {
    return {
      requestedImage: segmentImage || null,
      resolvedImage: availableImages[0],
      strategy: "deterministic-fallback",
    };
  }

  return {
    requestedImage: segmentImage || null,
    resolvedImage: PIPELINE_PLACEHOLDER_TOKEN,
    strategy: "placeholder",
  };
}

module.exports = {
  FALLBACK_RENDER_AUDIO,
  NORMALIZED_AUDIO_FILES,
  PIPELINE_PLACEHOLDER_TOKEN,
  PREFERRED_RENDER_AUDIO,
  listSupportedAudioFiles,
  parseWavDurationSeconds,
  resolveAudioSource,
  resolveProjectRoot,
  resolveRenderAudio,
  resolveSttAudio,
  resolveVisualSegment,
};
