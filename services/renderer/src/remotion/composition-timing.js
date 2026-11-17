/**
 * Pure timing and layout helpers shared by the Remotion composition and its
 * behavioural tests. Keeping them free of React/Remotion imports lets the
 * tests evaluate real frames and values instead of matching source text.
 */

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const WHIP_TRANSITION_DURATION_SECONDS = 0.43;
const WHIP_SMEAR_SAMPLE_COUNT = 7;

const NEWSPAPER_LABEL_LINES = ["RECREACIÓN", "ARTÍSTICA"];
const NEWSPAPER_MOTION = { fromScale: 1, toScale: 1.1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
const NEWSPAPER_BACKGROUND_BLUR = 15;
const NEWSPAPER_LOCAL_FONT_FAMILY = "Demo Display";
const NEWSPAPER_LOCAL_FONT_URL = "fonts/display/Demo-Display.woff2";
const NEWSPAPER_LABEL_FONT_FAMILY = '"Demo Display", Inter, Arial, sans-serif';
const NEWSPAPER_LABEL_FONT_SIZE = 40;
const NEWSPAPER_LABEL_LINE_HEIGHT = 1.12;
const NEWSPAPER_LABEL_TOP = 40;
const NEWSPAPER_LABEL_RIGHT = 40;
/** @type {{ objectFit: "cover", objectPosition: string, filter: string, transform: string }} */
const NEWSPAPER_BACKGROUND_STYLE = {
  objectFit: "cover",
  objectPosition: "center top",
  filter: `blur(${NEWSPAPER_BACKGROUND_BLUR}px)`,
  transform: "scale(1.08)",
};
/** @type {{ objectFit: "contain", objectPosition: string, transformOrigin: string }} */
const NEWSPAPER_FOREGROUND_STYLE = {
  objectFit: "contain",
  objectPosition: "center center",
  transformOrigin: "center center",
};
/** @type {{ left: string, right: number, top: number, background: string, padding: number, borderRadius: number, fontFamily: string, fontSize: number, fontWeight: number, lineHeight: number, textAlign: "center", transform: string }} */
const NEWSPAPER_LABEL_STYLE = {
  left: "auto",
  right: NEWSPAPER_LABEL_RIGHT,
  top: NEWSPAPER_LABEL_TOP,
  background: "transparent",
  padding: 0,
  borderRadius: 0,
  fontFamily: NEWSPAPER_LABEL_FONT_FAMILY,
  fontSize: NEWSPAPER_LABEL_FONT_SIZE,
  fontWeight: 900,
  lineHeight: NEWSPAPER_LABEL_LINE_HEIGHT,
  textAlign: "center",
  transform: "none",
};

/** @type {{ background: { transform: string, filter: string, objectFit: "cover" }, colorOverlay: { backgroundColor: string, opacity: number }, effect1: { mixBlendMode: "screen", opacity: number }, effect2: { mixBlendMode: "multiply", opacity: number }, foreground: { objectFit: "contain", transformOrigin: string } }} */
const VIDEO_SEGMENT_LAYER_STYLE = {
  background: { transform: "scale(1.18)", filter: "blur(10px) saturate(1.05)", objectFit: "cover" },
  colorOverlay: { backgroundColor: "#3835AF", opacity: 0.3 },
  effect1: { mixBlendMode: "screen", opacity: 1 },
  effect2: { mixBlendMode: "multiply", opacity: 1 },
  foreground: { objectFit: "contain", transformOrigin: "center center" },
};

const MEDIA_LAYER_AUDIO_POLICY = {
  channelOutro: { muted: false },
  overlayLayer01: { muted: true },
  overlayLayer02: { muted: true },
  foregroundVideo: { muted: true },
  backgroundVideo: { muted: true },
  logoVideo: { muted: true },
};

const WHIP_RENDER_POLICY = {
  previousTranslate: (eased) => Number((eased * 120).toFixed(3)),
  nextTranslate: (eased) => Number((-35 + eased * 35).toFixed(3)),
  smear: (intensity) => Number((intensity * 16).toFixed(3)),
  blur: (intensity) => Number((intensity * 10).toFixed(3)),
  previousOpacity: (progress) => Number((1 - progress * 0.22).toFixed(3)),
  nextOpacity: (progress) => Number((0.58 + progress * 0.42).toFixed(3)),
  previousScale: (intensity) => Number((1.035 + intensity * 0.018).toFixed(4)),
  nextScale: (intensity) => Number((1.015 + intensity * 0.012).toFixed(4)),
  nextBlur: (blur) => Number((blur * 0.86).toFixed(3)),
  nextSmear: (smear) => Number((smear * 0.82).toFixed(3)),
  previousContrast: 1.08,
  nextContrast: 1.05,
  outerBlurContrast: 1.08,
  innerBlurContrast: 1.05,
};

function interpolateClamped(frame, inputRange, outputRange) {
  const [inputStart, inputEnd] = inputRange;
  const [outputStart, outputEnd] = outputRange;
  if (inputEnd === inputStart) return outputStart;
  const ratio = Math.max(0, Math.min(1, (frame - inputStart) / (inputEnd - inputStart)));
  return outputStart + (outputEnd - outputStart) * ratio;
}

function resolveMotionRange(motion) {
  if (motion && typeof motion === "object") {
    return {
      fromScale: motion.fromScale ?? 1,
      toScale: motion.toScale ?? 1,
      fromX: motion.fromX ?? 0,
      fromY: motion.fromY ?? 0,
      toX: motion.toX ?? 0,
      toY: motion.toY ?? 0,
    };
  }
  const normalized = (motion || "").toString().trim().toLowerCase();

  if (normalized === "still" || normalized === "none") return { fromScale: 1, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom") return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom-out") return { fromScale: 1.08, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom-in") return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "pan-left") return { fromScale: 1.1, toScale: 1.1, fromX: 72, fromY: 0, toX: -72, toY: 0 };
  if (normalized === "pan-right") return { fromScale: 1.1, toScale: 1.1, fromX: -72, fromY: 0, toX: 72, toY: 0 };

  // Unknown values fallback to slow-zoom-in.
  return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
}

function resolveSegmentMotion(segment, frame, fps) {
  const durationInFrames = Math.max(1, Math.round((segment.endTime - segment.startTime) * fps));
  const motionRange = resolveMotionRange(segment.motion);
  return {
    durationInFrames,
    scale: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromScale, motionRange.toScale]),
    x: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromX, motionRange.toX]),
    y: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromY, motionRange.toY]),
  };
}

function resolvePanViewport(segment) {
  return {
    panViewportWidth: segment.panViewportWidth ?? segment.imageWidth,
    panViewportHeight:
      segment.panViewportHeight ??
      (segment.imageWidth ? segment.imageWidth * (VIEWPORT_HEIGHT / VIEWPORT_WIDTH) : undefined),
  };
}

function resolveNewspaperMotion({ frame, durationInFrames, foregroundMotion }) {
  const motionRange = foregroundMotion ? resolveMotionRange(foregroundMotion) : NEWSPAPER_MOTION;
  return {
    scale: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromScale, motionRange.toScale]),
    x: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromX, motionRange.toX]),
    y: interpolateClamped(frame, [0, durationInFrames], [motionRange.fromY, motionRange.toY]),
  };
}

function getFadedMusicVolume({ frame, baseVolume, fps, totalFrames, fadeInSeconds, fadeOutSeconds }) {
  const fadeInFrames = Math.max(0, Math.round(fadeInSeconds * fps));
  const fadeOutFrames = Math.max(0, Math.round(fadeOutSeconds * fps));
  const fadeInMultiplier = fadeInFrames > 0 ? Math.min(1, frame / fadeInFrames) : 1;
  const remainingFrames = Math.max(0, totalFrames - frame);
  const fadeOutMultiplier = fadeOutFrames > 0 ? Math.min(1, remainingFrames / fadeOutFrames) : 1;

  return baseVolume * Math.min(fadeInMultiplier, fadeOutMultiplier);
}

function easeInOutCubic(value) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

function buildWhipSmearSamples({ src, smear, opacity, blur, scale, contrast }) {
  const center = (WHIP_SMEAR_SAMPLE_COUNT - 1) / 2;
  return Array.from({ length: WHIP_SMEAR_SAMPLE_COUNT }, (_, index) => {
    const ratio = (index - center) / center;
    const offset = Number((ratio * smear).toFixed(3));
    const sampleOpacity = Number((opacity * (0.18 + (1 - Math.abs(ratio)) * 0.22)).toFixed(3));
    return {
      src,
      transform: `translate3d(${offset}%, 0, 0) scale(${scale})`,
      filter: `blur(${blur}px) contrast(${contrast}) saturate(0.96)`,
      opacity: sampleOpacity,
    };
  });
}

function resolveWhipTransition({ progress, previousImage, nextImage, durationInFrames }) {
  const clamped = Math.max(0, Math.min(1, progress));
  const eased = easeInOutCubic(clamped);
  const intensity = Math.sin(clamped * Math.PI);
  const smear = WHIP_RENDER_POLICY.smear(intensity);
  const blur = WHIP_RENDER_POLICY.blur(intensity);
  const previousScale = WHIP_RENDER_POLICY.previousScale(intensity);
  const nextScale = WHIP_RENDER_POLICY.nextScale(intensity);
  const nextBlur = WHIP_RENDER_POLICY.nextBlur(blur);

  return {
    durationInFrames,
    eased,
    intensity,
    previousTranslate: WHIP_RENDER_POLICY.previousTranslate(eased),
    nextTranslate: WHIP_RENDER_POLICY.nextTranslate(eased),
    previousOpacity: WHIP_RENDER_POLICY.previousOpacity(clamped),
    nextOpacity: WHIP_RENDER_POLICY.nextOpacity(clamped),
    previousScale,
    nextScale,
    previousBlur: blur,
    nextBlur,
    previousSamples: buildWhipSmearSamples({
      src: previousImage,
      smear,
      opacity: intensity,
      blur,
      scale: previousScale,
      contrast: WHIP_RENDER_POLICY.previousContrast,
    }),
    nextSamples: buildWhipSmearSamples({
      src: nextImage,
      smear: WHIP_RENDER_POLICY.nextSmear(smear),
      opacity: intensity,
      blur: nextBlur,
      scale: nextScale,
      contrast: WHIP_RENDER_POLICY.nextContrast,
    }),
  };
}

function resolveCompositionTimeline({ segments, fps, outro, compositionDurationSeconds }) {
  const latestEnd = segments.reduce((max, segment) => Math.max(max, segment.endTime), 0);
  const compositionEnd = Math.max(latestEnd, compositionDurationSeconds ?? 0);
  const outroStartFrame = Math.max(0, Math.round(compositionEnd * fps));
  const outroFrames = Math.max(1, Math.round((outro?.durationSeconds ?? 2) * fps));
  const totalFrames = Math.max(
    Math.round(compositionEnd * fps),
    outroStartFrame + (outro?.enabled === false ? 0 : outroFrames),
  );

  return { latestEnd, compositionEnd, outroStartFrame, outroFrames, totalFrames };
}

function resolveRootDurationFrames({ props }) {
  const fps = props.fps ?? 30;
  const latestEnd = props.segments.reduce((max, segment) => Math.max(max, segment.endTime), 0);
  const compositionDurationSeconds = Math.max(latestEnd, props.compositionDurationSeconds ?? 0);
  const outroSeconds = props.outro?.enabled === false ? 0 : props.outro?.durationSeconds ?? 0;

  return {
    durationInFrames: Math.max(1, Math.ceil((compositionDurationSeconds + outroSeconds) * fps)),
  };
}

function resolveSegmentSequence(segment, fps) {
  return {
    from: Math.max(0, Math.round(segment.startTime * fps)),
    durationInFrames: Math.max(1, Math.round((segment.endTime - segment.startTime) * fps)),
  };
}

function resolveVideoSegmentTiming(media, fps) {
  return {
    durationInFrames: Math.max(1, Math.round(media.durationSeconds * fps)),
    startFromFrame: Math.round(media.sourceInSeconds * fps),
    foregroundTransform: {
      x: media.foregroundTransform?.x ?? 0,
      y: media.foregroundTransform?.y ?? 0,
      scale: Math.max(0.1, media.foregroundTransform?.scale ?? 1),
    },
  };
}

const isVideoSource = (src) => /\.(mp4|webm|mov|m4v)$/i.test(src || "");
const isGreenScreenLogoSource = (src) => /(?:logo-green|logo-secondary(?:-keyed)?)\.(?:mp4|webm)$/i.test(src || "");
const isLogoFrameSequenceSource = (src) => /logo-[a-z0-9-]+-alpha-frames$/i.test(src || "");
const isFinalLogoSource = (src) => /logo-final\.png$/i.test(src || "");
const logoFrameSequenceSrc = (src, frame) => `${src}/frame-${String(frame % 900).padStart(4, "0")}.png`;

/** @returns {{ left: number, top: number, width: number, height: number, opacity: number, objectFit: "contain" }} */
function resolveLogoLayout(src) {
  const isFinal = isFinalLogoSource(src);
  return {
    left: isFinal ? -42 : 52,
    top: isFinal ? -9 : 38,
    width: isFinal ? 412 : 220,
    height: isFinal ? 232 : 124,
    opacity: 0.94,
    objectFit: "contain",
  };
}

module.exports = {
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
  WHIP_TRANSITION_DURATION_SECONDS,
  WHIP_SMEAR_SAMPLE_COUNT,
  NEWSPAPER_LABEL_LINES,
  NEWSPAPER_MOTION,
  NEWSPAPER_BACKGROUND_BLUR,
  NEWSPAPER_LOCAL_FONT_FAMILY,
  NEWSPAPER_LOCAL_FONT_URL,
  NEWSPAPER_LABEL_FONT_FAMILY,
  NEWSPAPER_LABEL_FONT_SIZE,
  NEWSPAPER_LABEL_LINE_HEIGHT,
  NEWSPAPER_LABEL_TOP,
  NEWSPAPER_LABEL_RIGHT,
  NEWSPAPER_BACKGROUND_STYLE,
  NEWSPAPER_FOREGROUND_STYLE,
  NEWSPAPER_LABEL_STYLE,
  VIDEO_SEGMENT_LAYER_STYLE,
  MEDIA_LAYER_AUDIO_POLICY,
  WHIP_RENDER_POLICY,
  interpolateClamped,
  resolveMotionRange,
  resolveSegmentMotion,
  resolvePanViewport,
  resolveNewspaperMotion,
  getFadedMusicVolume,
  easeInOutCubic,
  buildWhipSmearSamples,
  resolveWhipTransition,
  resolveCompositionTimeline,
  resolveRootDurationFrames,
  resolveSegmentSequence,
  resolveVideoSegmentTiming,
  isVideoSource,
  isGreenScreenLogoSource,
  isLogoFrameSequenceSource,
  isFinalLogoSource,
  logoFrameSequenceSrc,
  resolveLogoLayout,
};
