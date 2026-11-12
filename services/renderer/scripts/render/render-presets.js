const DEFAULT_PROFILE = "final";

// The demo preset is intentionally cheap: CPU-only, low resolution and a single
// Remotion tab so a laptop without a GPU can render the showcase video.
const PRESETS = {
  final: {
    width: 1920,
    height: 1080,
    fps: 30,
    codec: "h264",
    hardwareAcceleration: "if-possible",
    gl: "angle",
    concurrency: null,
    crf: null,
  },
  preview: {
    width: 1280,
    height: 720,
    fps: 30,
    codec: "h264",
    hardwareAcceleration: "if-possible",
    gl: "angle",
    concurrency: null,
    crf: null,
  },
  demo: {
    width: 640,
    height: 360,
    fps: 24,
    codec: "h264",
    hardwareAcceleration: "disable",
    gl: "swangle",
    concurrency: 1,
    crf: 30,
  },
  // 720p CPU preset for the local product pipeline (D10). It keeps the final
  // handoff honest (video-final.mp4) while staying renderable without a GPU.
  local: {
    width: 1280,
    height: 720,
    fps: 30,
    codec: "h264",
    hardwareAcceleration: "disable",
    gl: "swangle",
    concurrency: 1,
    crf: 26,
  },
};

function resolveRenderProfile(value) {
  const normalized = String(value || DEFAULT_PROFILE).trim().toLowerCase();
  return Object.hasOwn(PRESETS, normalized) ? normalized : DEFAULT_PROFILE;
}

function resolveRenderPreset(value) {
  return { name: resolveRenderProfile(value), ...PRESETS[resolveRenderProfile(value)] };
}

function buildPresetArgs(profile) {
  const preset = typeof profile === "string" ? resolveRenderPreset(profile) : { ...profile };
  const args = [
    "--codec=h264",
    `--frames-per-second=${preset.fps}`,
    `--width=${preset.width}`,
    `--height=${preset.height}`,
    `--hardware-acceleration=${preset.hardwareAcceleration}`,
    `--gl=${preset.gl}`,
  ];
  if (preset.concurrency) args.push(`--concurrency=${preset.concurrency}`);
  if (preset.crf) args.push(`--crf=${preset.crf}`);
  return args;
}

module.exports = {
  PRESETS,
  buildPresetArgs,
  resolveRenderPreset,
  resolveRenderProfile,
};
