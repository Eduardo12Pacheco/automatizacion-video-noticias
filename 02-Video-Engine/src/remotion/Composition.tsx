import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { resolveCoverPanLayer } from "./cover-pan-layer";

type OverlayVideoLayer = {
  src?: string | null;
  opacity?: number;
  blendMode?: CSSProperties["mixBlendMode"];
};

type LogoLayer = {
  src?: string | null;
  enabled?: boolean;
  placeholder?: boolean;
  label?: string;
};

type VideoSegmentMedia = {
  kind: "video-segment";
  sourceVideoSrc: string;
  sourceInSeconds: number;
  durationSeconds: number;
  sourceOutSeconds?: number;
  overlayColor?: "#3835AF";
  overlayOpacity?: 0.3;
  effect1Src: string;
  effect1BlendMode?: "screen";
  effect2Src: string;
  effect2BlendMode?: "multiply";
};

type TimelineSegment = {
  image: string;
  imageWidth?: number;
  imageHeight?: number;
  phrase?: string;
  startTime: number;
  endTime: number;
  motion?: string | { fromX?: number; fromY?: number; toX?: number; toY?: number; fromScale?: number; toScale?: number; easing?: string };
  dust?: { enabled?: boolean; type?: string; opacity?: number; blendMode?: CSSProperties["mixBlendMode"] };
  logo?: { enabled?: boolean; source?: string };
  filter?: { enabled?: boolean };
  transition?: string;
  caption?: string;
  mediaMode?: "image" | "newspaper";
  media?: { kind: "image" } | VideoSegmentMedia;
};

type WhipTransitionEvent = {
  id: string;
  type?: "whip" | "overlay-video";
  startFrame: number;
  cutFrame: number;
  sfxStartTime?: number;
  sfxStartFrame?: number;
  durationInFrames: number;
  previousImage: string;
  nextImage: string;
  sfx?: "whip" | null;
  sfxSrc?: string | null;
  src?: string;
  blendMode?: "screen";
  audio?: boolean;
};

export type AutomaticVideoProps = {
  audioSrc?: string;
  audio?: {
    voiceSrc?: string;
    musicSrc?: string;
    voice?: {
      volume?: number;
    };
    music?: {
      volume?: number;
      loop?: boolean;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
    };
  };
  segments: TimelineSegment[];
  fps?: number;
  logo?: LogoLayer;
  overlays?: {
    dust?: OverlayVideoLayer;
  };
  outro?: { enabled?: boolean; src?: string; durationSeconds?: number; label?: string };
  whipTransitions?: WhipTransitionEvent[];
  lastRenderedSnapshotHash?: string;
  compositionDurationSeconds?: number;
};

const Fps = 30;
const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;
const WHIP_TRANSITION_DURATION_SECONDS = 0.43;
const WHIP_SMEAR_SAMPLE_COUNT = 7;

const getFadedMusicVolume = ({
  frame,
  baseVolume,
  fps,
  totalFrames,
  fadeInSeconds,
  fadeOutSeconds,
}: {
  frame: number;
  baseVolume: number;
  fps: number;
  totalFrames: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
}) => {
  const fadeInFrames = Math.max(0, Math.round(fadeInSeconds * fps));
  const fadeOutFrames = Math.max(0, Math.round(fadeOutSeconds * fps));
  const fadeInMultiplier = fadeInFrames > 0 ? Math.min(1, frame / fadeInFrames) : 1;
  const remainingFrames = Math.max(0, totalFrames - frame);
  const fadeOutMultiplier = fadeOutFrames > 0 ? Math.min(1, remainingFrames / fadeOutFrames) : 1;

  return baseVolume * Math.min(fadeInMultiplier, fadeOutMultiplier);
};

const isVideoSource = (src?: string | null) => /\.(mp4|webm|mov|m4v)$/i.test(src || "");
const isGreenScreenLogoSource = (src?: string | null) => /(?:logo-green|logo-demo-co(?:-keyed)?)\.(?:mp4|webm)$/i.test(src || "");
const isLogoFrameSequenceSource = (src?: string | null) => /logo-(?:colombia|ecuador)-alpha-frames$/i.test(src || "");
const logoFrameSequenceSrc = (src: string, frame: number) => `${src}/frame-${String(frame % 900).padStart(4, "0")}.png`;

const resolveMotionRange = (motion?: TimelineSegment["motion"] | null) => {
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
};

const NEWSPAPER_LABEL_LINES = ["RECREACIÓN", "ARTÍSTICA"];
const NEWSPAPER_MOTION = { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
const NEWSPAPER_BACKGROUND_BLUR = 15;

const DustOverlay = ({ layer, startFrom }: { layer?: OverlayVideoLayer; startFrom: number }) => {
  if (!layer?.src) {
    return (
      <AbsoluteFill
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 30%, rgba(255,255,255,0.20) 0 1px, transparent 2px), radial-gradient(circle at 70% 60%, rgba(255,255,255,0.12) 0 1px, transparent 2px)",
          backgroundSize: "140px 140px, 220px 220px",
          mixBlendMode: "screen",
          opacity: 0.28,
        }}
      />
    );
  }

  return (
    <AbsoluteFill
      style={{
        mixBlendMode: layer.blendMode ?? "screen",
        opacity: layer.opacity ?? 0.36,
        pointerEvents: "none",
      }}
    >
      <OffthreadVideo
        src={staticFile(layer.src)}
        muted
        startFrom={startFrom}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

const easeInOutCubic = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
};

const buildWhipSmearSamples = ({
  src,
  smear,
  opacity,
  blur,
  scale,
  contrast,
}: {
  src: string;
  smear: number;
  opacity: number;
  blur: number;
  scale: number;
  contrast: number;
}) => {
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
};

const WhipOverlay = ({ transition }: { transition: WhipTransitionEvent }) => {
  const frame = useCurrentFrame();
  const durationInFrames = Math.max(1, transition.durationInFrames || Math.round(WHIP_TRANSITION_DURATION_SECONDS * Fps));
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eased = easeInOutCubic(progress);
  const intensity = Math.sin(progress * Math.PI);
  const previousTranslate = Number((eased * 120).toFixed(3));
  const nextTranslate = Number((-35 + eased * 35).toFixed(3));
  const smear = Number((intensity * 16).toFixed(3));
  const blur = Number((intensity * 10).toFixed(3));
  const previousOpacity = Number((1 - progress * 0.22).toFixed(3));
  const nextOpacity = Number((0.58 + progress * 0.42).toFixed(3));
  const previousScale = Number((1.035 + intensity * 0.018).toFixed(4));
  const nextScale = Number((1.015 + intensity * 0.012).toFixed(4));
  const previousSamples = buildWhipSmearSamples({
    src: transition.previousImage,
    smear,
    opacity: intensity,
    blur,
    scale: previousScale,
    contrast: 1.08,
  });
  const nextBlur = Number((blur * 0.86).toFixed(3));
  const nextSamples = buildWhipSmearSamples({
    src: transition.nextImage,
    smear: Number((smear * 0.82).toFixed(3)),
    opacity: intensity,
    blur: nextBlur,
    scale: nextScale,
    contrast: 1.05,
  });

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        data-layer="whip-previous"
        style={{
          transform: `translate3d(${previousTranslate}%, 0, 0) scale(${previousScale})`,
          filter: `blur(${blur}px) contrast(1.08) saturate(0.95)`,
          opacity: previousOpacity,
          transformOrigin: "center center",
        }}
      >
        {previousSamples.map((sample, index) => (
          <Img
            key={`previous-smear-${index}`}
            data-layer="whip-previous-smear"
            src={staticFile(sample.src)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center center",
              transform: sample.transform,
              filter: sample.filter,
              opacity: sample.opacity,
              transformOrigin: "center center",
            }}
          />
        ))}
      </AbsoluteFill>
      <AbsoluteFill
        data-layer="whip-next"
        style={{
          transform: `translate3d(${nextTranslate}%, 0, 0) scale(${nextScale})`,
          filter: `blur(${nextBlur}px) contrast(1.05) saturate(0.96)`,
          opacity: nextOpacity,
          transformOrigin: "center center",
        }}
      >
        {nextSamples.map((sample, index) => (
          <Img
            key={`next-smear-${index}`}
            data-layer="whip-next-smear"
            src={staticFile(sample.src)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center center",
              transform: sample.transform,
              filter: sample.filter,
              opacity: sample.opacity,
              transformOrigin: "center center",
            }}
          />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const BoundaryVideoOverlay = ({ transition }: { transition: WhipTransitionEvent }) => (
  <AbsoluteFill data-layer="boundary-video-transition" style={{ mixBlendMode: transition.blendMode ?? "screen", pointerEvents: "none" }}>
    <OffthreadVideo
      data-layer="boundary-video-transition-video"
      src={staticFile(transition.src || "")}
      muted
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  </AbsoluteFill>
);

const LogoOverlay = ({ logo, startFrom }: { logo?: LogoLayer; startFrom: number }) => {
  const frame = useCurrentFrame();
  if (!logo || logo.enabled === false) return null;

  const style: CSSProperties = {
    position: "absolute",
    left: 52,
    top: 38,
    width: 220,
    height: 124,
    opacity: 0.94,
    filter: "drop-shadow(0 10px 24px rgba(0,0,0,0.55))",
    pointerEvents: "none",
  };

  if (logo.src && isLogoFrameSequenceSource(logo.src)) {
    return (
      <Img
        data-layer="alpha-logo-frame-sequence"
        src={staticFile(logoFrameSequenceSrc(logo.src, frame))}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
        }}
      />
    );
  }

  if (logo.src && isVideoSource(logo.src)) {
    if (isGreenScreenLogoSource(logo.src)) {
      return (
        <OffthreadVideo
          data-layer="green-screen-logo-video"
          src={staticFile(logo.src)}
          muted
          startFrom={startFrom}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            pointerEvents: "none",
          }}
        />
      );
    }

    return (
      <OffthreadVideo
        src={staticFile(logo.src)}
        muted
        startFrom={startFrom}
        style={{ ...style, objectFit: "contain" }}
      />
    );
  }

  if (logo.src) {
    return <Img src={staticFile(logo.src)} style={{ ...style, objectFit: "contain" }} />;
  }

  if (logo.placeholder === false) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 56,
        top: 44,
        border: "3px solid rgba(255,255,255,0.78)",
        borderRadius: 999,
        padding: "14px 22px",
        color: "white",
        fontSize: 28,
        fontWeight: 900,
        letterSpacing: "0.12em",
      }}
    >
      {logo.label || "LOGO"}
    </div>
  );
};

const VideoSegmentScene = ({
  media,
  fps,
}: {
  media: VideoSegmentMedia;
  fps: number;
}) => {
  const durationInFrames = Math.max(1, Math.round(media.durationSeconds * fps));

  return (
    <AbsoluteFill>
      <AbsoluteFill data-layer="background-video" style={{ transform: "scale(1.18)", filter: "blur(10px) saturate(1.05)" }}>
        <OffthreadVideo
          src={staticFile(media.sourceVideoSrc)}
          muted
          startFrom={Math.round(media.sourceInSeconds * fps)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        data-layer="color-overlay"
        style={{
          backgroundColor: media.overlayColor ?? "#3835AF",
          opacity: media.overlayOpacity ?? 0.3,
          pointerEvents: "none",
        }}
      />
      <AbsoluteFill
        data-layer="overlay-layer-01"
        style={{ mixBlendMode: media.effect1BlendMode ?? "screen", opacity: 1, pointerEvents: "none" }}
      >
        <OffthreadVideo
          src={staticFile(media.effect1Src)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        data-layer="overlay-layer-02"
        style={{ mixBlendMode: media.effect2BlendMode ?? "multiply", opacity: 1, pointerEvents: "none" }}
      >
        <OffthreadVideo
          src={staticFile(media.effect2Src)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <Sequence durationInFrames={durationInFrames} premountFor={Math.min(15, durationInFrames)}>
        <OffthreadVideo
          data-layer="foreground-video"
          src={staticFile(media.sourceVideoSrc)}
          muted
          startFrom={Math.round(media.sourceInSeconds * fps)}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      </Sequence>
    </AbsoluteFill>
  );
};

const NEWSPAPER_LOCAL_FONT_FAMILY = "Versa Versa";
const NEWSPAPER_LOCAL_FONT_URL = staticFile("fonts/versa/Demo-Display.woff2");
const NEWSPAPER_LABEL_FONT_FAMILY = "\"Versa Versa\", Versa, VERSA, Inter, Arial, sans-serif";
const NEWSPAPER_LABEL_FONT_SIZE = 40;
const NEWSPAPER_LABEL_LINE_HEIGHT = 1.12;
const NEWSPAPER_LABEL_TOP = 40;
const NEWSPAPER_LABEL_RIGHT = 40;
const NEWSPAPER_FONT_FACE_CSS = `@font-face {
  font-family: "${NEWSPAPER_LOCAL_FONT_FAMILY}";
  src: url("${NEWSPAPER_LOCAL_FONT_URL}") format("woff2");
  font-style: normal;
  font-weight: 900;
  font-display: block;
}`;

const useNewspaperFont = () => {
  const [fontHandle] = useState(() => delayRender("Loading Versa Versa newspaper font"));

  useEffect(() => {
    if (typeof document === "undefined" || typeof FontFace === "undefined") {
      continueRender(fontHandle);
      return;
    }

    const font = new FontFace(
      NEWSPAPER_LOCAL_FONT_FAMILY,
      `url("${NEWSPAPER_LOCAL_FONT_URL}") format("woff2")`,
      { style: "normal", weight: "900" },
    );

    font
      .load()
      .then((loadedFont) => {
        document.fonts.add(loadedFont);
        return document.fonts.load(`900 ${NEWSPAPER_LABEL_FONT_SIZE}px "${NEWSPAPER_LOCAL_FONT_FAMILY}"`);
      })
      .then(() => continueRender(fontHandle))
      .catch((error) => cancelRender(error));
  }, [fontHandle]);
};

const NewspaperScene = ({
  segment,
  frame,
  durationInFrames,
}: {
  segment: TimelineSegment;
  frame: number;
  durationInFrames: number;
}) => {
  useNewspaperFont();
  const motionRange = segment.motion ? resolveMotionRange(segment.motion) : NEWSPAPER_MOTION;
  const scale = interpolate(frame, [0, durationInFrames], [motionRange.fromScale, motionRange.toScale], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <style>{NEWSPAPER_FONT_FACE_CSS}</style>
      <Img
        data-layer="newspaper-background"
        src={staticFile(segment.image)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center top",
          filter: `blur(${NEWSPAPER_BACKGROUND_BLUR}px)`,
          transform: "scale(1.08)",
        }}
      />
      <Img
        data-layer="newspaper-foreground"
        src={staticFile(segment.image)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "center center",
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
      <div
        data-layer="newspaper-artistic-label"
        style={{
          position: "absolute",
          left: "auto",
          right: NEWSPAPER_LABEL_RIGHT,
          top: NEWSPAPER_LABEL_TOP,
          color: "#000",
          background: "transparent",
          padding: 0,
          borderRadius: 0,
          fontFamily: NEWSPAPER_LABEL_FONT_FAMILY,
          fontSize: NEWSPAPER_LABEL_FONT_SIZE,
          fontWeight: 900,
          lineHeight: NEWSPAPER_LABEL_LINE_HEIGHT,
          textAlign: "center",
          letterSpacing: "0.02em",
          transform: "none",
          whiteSpace: "pre-line",
        }}
      >
        {NEWSPAPER_LABEL_LINES.join("\n")}
      </div>
    </AbsoluteFill>
  );
};

const SegmentScene = ({
  segment,
  fps,
  logo,
  dustLayer,
}: {
  segment: TimelineSegment;
  fps: number;
  logo?: LogoLayer;
  dustLayer?: OverlayVideoLayer;
}) => {
  const frame = useCurrentFrame();

  if (segment.media?.kind === "video-segment") {
    return <VideoSegmentScene media={segment.media} fps={fps} />;
  }

  const durationInFrames = Math.max(
    1,
    Math.round((segment.endTime - segment.startTime) * fps),
  );
  if (segment.mediaMode === "newspaper") {
    return (
      <AbsoluteFill>
        <NewspaperScene segment={segment} frame={frame} durationInFrames={durationInFrames} />
        {segment.logo?.enabled !== false ? <LogoOverlay logo={logo} startFrom={0} /> : null}
      </AbsoluteFill>
    );
  }
  const motionRange = resolveMotionRange(segment.motion);
  const scale = interpolate(frame, [0, durationInFrames], [motionRange.fromScale, motionRange.toScale], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(frame, [0, durationInFrames], [motionRange.fromX, motionRange.toX], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [0, durationInFrames], [motionRange.fromY, motionRange.toY], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const layer = resolveCoverPanLayer({
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    imageWidth: segment.imageWidth,
    imageHeight: segment.imageHeight,
    scale,
    x,
    y,
  });

  return (
    <AbsoluteFill>
      <Img
        src={staticFile(segment.image)}
        style={{
          position: "absolute",
          width: layer.layerWidth,
          height: layer.layerHeight,
          left: layer.left,
          top: layer.top,
          objectFit: "cover",
          filter: segment.filter?.enabled === false ? "none" : "contrast(1.06) saturate(0.92)",
        }}
      />
      {segment.dust?.enabled !== false ? (
        <DustOverlay layer={dustLayer} startFrom={0} />
      ) : null}
      {segment.logo?.enabled !== false ? <LogoOverlay logo={logo} startFrom={0} /> : null}
    </AbsoluteFill>
  );
};

export const MyComposition = ({ audioSrc, audio, segments, fps = Fps, logo, overlays, outro, whipTransitions = [], compositionDurationSeconds }: AutomaticVideoProps) => {
  if (segments.length === 0) {
    return <AbsoluteFill style={{ backgroundColor: "#101828" }} />;
  }

  const voiceSrc = audio?.voiceSrc || audioSrc;
  const musicSrc = audio?.musicSrc;
  const latestEnd = segments.reduce((max, segment) => Math.max(max, segment.endTime), 0);
  const compositionEnd = Math.max(latestEnd, compositionDurationSeconds ?? 0);
  const outroStartFrame = Math.max(0, Math.round(compositionEnd * fps));
  const outroFrames = Math.max(1, Math.round((outro?.durationSeconds ?? 2) * fps));
  const totalFrames = Math.max(Math.round(compositionEnd * fps), outroStartFrame + (outro?.enabled === false ? 0 : outroFrames));

  return (
    <AbsoluteFill>
      {voiceSrc ? <Audio src={staticFile(voiceSrc)} volume={() => audio?.voice?.volume ?? 1} /> : null}
      {musicSrc ? (
        <Audio
          src={staticFile(musicSrc)}
          volume={(frame) =>
            getFadedMusicVolume({
              frame,
              baseVolume: audio?.music?.volume ?? 0.16,
              fps,
              totalFrames,
              fadeInSeconds: audio?.music?.fadeInSeconds ?? 0,
              fadeOutSeconds: audio?.music?.fadeOutSeconds ?? 0,
            })
          }
          loop={audio?.music?.loop ?? true}
        />
      ) : null}
      {segments.map((segment) => {
        const from = Math.max(0, Math.round(segment.startTime * fps));
        const durationInFrames = Math.max(
          1,
          Math.round((segment.endTime - segment.startTime) * fps),
        );

        return (
          <Sequence
            key={`${segment.image}-${from}`}
            from={from}
            durationInFrames={durationInFrames}
          >
            <SegmentScene segment={segment} fps={fps} logo={logo} dustLayer={overlays?.dust} />
          </Sequence>
        );
      })}
      {whipTransitions.map((transition) => (
        <Sequence
          key={`${transition.id}:overlay`}
          from={transition.startFrame}
          durationInFrames={transition.durationInFrames}
        >
          {transition.type === "overlay-video" ? <BoundaryVideoOverlay transition={transition} /> : <WhipOverlay transition={transition} />}
        </Sequence>
      ))}
      {whipTransitions.filter((transition): transition is WhipTransitionEvent & { type: "overlay-video"; src: string; audio: true } => transition.type === "overlay-video" && transition.audio === true && Boolean(transition.src)).map((transition) => (
        <Sequence
          key={`${transition.id}:audio`}
          from={transition.sfxStartFrame ?? transition.startFrame}
          durationInFrames={transition.durationInFrames}
        >
          <Audio src={staticFile(transition.src)} volume={0.9} />
        </Sequence>
      ))}
      {whipTransitions.filter((transition): transition is WhipTransitionEvent & { sfx: "whip"; sfxSrc: string } => transition.sfx === "whip" && Boolean(transition.sfxSrc)).map((transition) => (
        <Sequence
          key={`${transition.id}:sfx`}
          from={transition.sfxStartFrame ?? transition.startFrame}
          durationInFrames={transition.durationInFrames}
        >
          <Audio src={staticFile(transition.sfxSrc)} volume={0.85} />
        </Sequence>
      ))}
      {outro?.enabled !== false ? (
        <Sequence from={outroStartFrame} durationInFrames={outroFrames}>
          {outro?.src ? (
            <OffthreadVideo
              data-layer="channel-outro-video"
              src={staticFile(outro.src)}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <AbsoluteFill style={{ backgroundColor: "#11100e", display: "grid", placeItems: "center" }}>
              <div style={{ color: "#f5d09a", fontFamily: "Inter, sans-serif", fontSize: 72, fontWeight: 900 }}>
                {outro?.label || "Gracias por mirar"}
              </div>
            </AbsoluteFill>
          )}
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
