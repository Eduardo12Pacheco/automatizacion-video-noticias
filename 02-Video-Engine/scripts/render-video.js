const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dryRun = process.argv.includes("--dry-run");

const projectRoot = process.cwd();
const timelinePath = path.join(projectRoot, "output", "timeline.json");
const imagesDir = path.join(projectRoot, "imagenes");
const audioDir = path.join(projectRoot, "audio");
const publicGeneratedDir = path.join(projectRoot, "public", "generated");
const publicImagesDir = path.join(publicGeneratedDir, "images");
const outputVideoPath = path.join(projectRoot, "output", "video-final.mp4");

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

if (!fs.existsSync(timelinePath)) {
  throw new Error(
    "No existe output/timeline.json. Ejecuta generate:timeline primero.",
  );
}

const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const timelineFrames = timeline.frames || [];

if (timelineFrames.length === 0) {
  throw new Error("timeline.json no tiene frames para renderizar.");
}

fs.mkdirSync(publicImagesDir, { recursive: true });
fs.mkdirSync(path.dirname(outputVideoPath), { recursive: true });

const placeholderPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";
const placeholderImageName = "placeholder.png";
const placeholderImagePath = path.join(publicImagesDir, placeholderImageName);

if (!fs.existsSync(placeholderImagePath)) {
  fs.writeFileSync(placeholderImagePath, Buffer.from(placeholderPng, "base64"));
}

const normalizedFrames = timelineFrames.map((segment) => {
  const fileName = path.basename(segment.image || "");
  const sourceImage = path.join(imagesDir, fileName);

  let imageRelativePath = `generated/images/${placeholderImageName}`;
  if (fileName && fs.existsSync(sourceImage)) {
    const destination = path.join(publicImagesDir, fileName);
    fs.copyFileSync(sourceImage, destination);
    imageRelativePath = `generated/images/${fileName}`;
  }

  return {
    ...segment,
    image: imageRelativePath,
  };
});

const supportedAudioExt = [".wav", ".mp3", ".m4a", ".aac"];
let audioFile;
if (fs.existsSync(audioDir)) {
  const files = fs.readdirSync(audioDir);
  const preferredRenderAudio = "audio-48khz.wav";
  const fallbackRenderAudio = "audio-16khz.wav";

  if (files.includes(preferredRenderAudio)) {
    audioFile = preferredRenderAudio;
  } else if (files.includes(fallbackRenderAudio)) {
    audioFile = fallbackRenderAudio;
  } else {
    audioFile = files.find((file) =>
      supportedAudioExt.includes(path.extname(file).toLowerCase()),
    );
  }
}

let audioRelativePath;
let selectedAudioDurationSeconds;
if (audioFile) {
  const sourceAudio = path.join(audioDir, audioFile);
  const destinationAudio = path.join(
    publicGeneratedDir,
    `audio${path.extname(audioFile)}`,
  );
  fs.mkdirSync(publicGeneratedDir, { recursive: true });
  fs.copyFileSync(sourceAudio, destinationAudio);
  audioRelativePath = `generated/${path.basename(destinationAudio)}`;

  if (path.extname(audioFile).toLowerCase() === ".wav") {
    selectedAudioDurationSeconds = parseWavDurationSeconds(sourceAudio);
  }
} else {
  throw new Error(
    "No se encontro audio para render. Esperado: audio/audio-48khz.wav (o fallback audio/audio-16khz.wav).",
  );
}

if (
  normalizedFrames.length > 0 &&
  typeof selectedAudioDurationSeconds === "number"
) {
  const lastFrame = normalizedFrames[normalizedFrames.length - 1];
  if (selectedAudioDurationSeconds > Number(lastFrame.endTime || 0)) {
    lastFrame.endTime = selectedAudioDurationSeconds;
  }
}

const props = {
  audioSrc: audioRelativePath,
  segments: normalizedFrames,
};

const renderPropsPath = path.join(projectRoot, "output", "render-props.json");
fs.writeFileSync(
  renderPropsPath,
  `${JSON.stringify(props, null, 2)}\n`,
  "utf8",
);

const remotionCliPath = path.join(
  projectRoot,
  "node_modules",
  "@remotion",
  "cli",
  "remotion-cli.js",
);

if (!fs.existsSync(remotionCliPath)) {
  throw new Error(
    `No se encontro la CLI de Remotion en: ${remotionCliPath}. Ejecuta npm install.`,
  );
}

const renderArgs = [
  remotionCliPath,
  "render",
  "MyComp",
  outputVideoPath,
  "--codec=h264",
  `--props=${renderPropsPath}`,
];

if (dryRun) {
  console.log(
    `Dry run OK. Comando listo: ${process.execPath} ${renderArgs.join(" ")}`,
  );
  process.exit(0);
}

const result = spawnSync(process.execPath, renderArgs, {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`Video exportado en: ${outputVideoPath}`);
