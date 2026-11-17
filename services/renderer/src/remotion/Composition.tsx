import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import type { CSSProperties } from "react";
import { resolveCoverPanLayer } from "./cover-pan-layer";
import { NewspaperScene } from "./newspaper-scene";
import {
  MEDIA_LAYER_AUDIO_POLICY,
  VIDEO_SEGMENT_LAYER_STYLE,
  VIEWPORT_HEIGHT,
  VIEWPORT_WIDTH,
  WHIP_RENDER_POLICY,
  WHIP_TRANSITION_DURATION_SECONDS,
  getFadedMusicVolume,
  isGreenScreenLogoSource,
  isLogoFrameSequenceSource,
  isVideoSource,
  logoFrameSequenceSrc,
  resolveCompositionTimeline,
  resolveLogoLayout,
  resolvePanViewport,
  resolveSegmentMotion,
  resolveSegmentSequence,
  resolveVideoSegmentTiming,
  resolveWhipTransition,
} from "./composition-timing";

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
  foregroundTransform?: { x?: number; y?: number; scale?: number };
};

type TimelineSegment = {
  image: string;
  imageWidth?: number;
  imageHeight?: number;
  panViewportWidth?: number;
  panViewportHeight?: number;
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
  newspaper?: { labelEnabled?: boolean; foregroundMotion?: { fromX?: number; fromY?: number; toX?: number; toY?: number; fromScale?: number; toScale?: number; easing?: string } };
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


const WhipOverlay = ({ transition }: { transition: WhipTransitionEvent }) => {
  const frame = useCurrentFrame();
  const durationInFrames = Math.max(1, transition.durationInFrames || Math.round(WHIP_TRANSITION_DURATION_SECONDS * Fps));
  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const whip = resolveWhipTransition({
    progress,
    previousImage: transition.previousImage,
    nextImage: transition.nextImage,
    durationInFrames,
  });
  const { previousTranslate, nextTranslate, previousOpacity, nextOpacity, previousScale, nextScale, previousBlur, nextBlur, previousSamples, nextSamples } = whip;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        data-layer="whip-previous"
        style={{
          transform: `translate3d(${previousTranslate}%, 0, 0) scale(${previousScale})`,
          filter: `blur(${previousBlur}px) contrast(${WHIP_RENDER_POLICY.outerBlurContrast}) saturate(0.95)`,
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
          filter: `blur(${nextBlur}px) contrast(${WHIP_RENDER_POLICY.innerBlurContrast}) saturate(0.96)`,
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

  const layout = resolveLogoLayout(logo.src);
  const style: CSSProperties = {
    position: "absolute",
    left: layout.left,
    top: layout.top,
    width: layout.width,
    height: layout.height,
    opacity: layout.opacity,
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
          muted={MEDIA_LAYER_AUDIO_POLICY.logoVideo.muted}
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
        muted={MEDIA_LAYER_AUDIO_POLICY.logoVideo.muted}
        startFrom={startFrom}
        style={{ ...style, objectFit: layout.objectFit }}
      />
    );
  }

  if (logo.src) {
    return <Img src={staticFile(logo.src)} style={{ ...style, objectFit: layout.objectFit }} />;
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
  const { durationInFrames, startFromFrame, foregroundTransform } = resolveVideoSegmentTiming(media, fps);
  const layers = VIDEO_SEGMENT_LAYER_STYLE;

  return (
    <AbsoluteFill>
      <AbsoluteFill data-layer="background-video" style={layers.background}>
        <OffthreadVideo
          src={staticFile(media.sourceVideoSrc)}
          muted={MEDIA_LAYER_AUDIO_POLICY.backgroundVideo.muted}
          startFrom={startFromFrame}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        data-layer="color-overlay"
        style={{
          ...layers.colorOverlay,
          backgroundColor: media.overlayColor ?? layers.colorOverlay.backgroundColor,
          opacity: media.overlayOpacity ?? layers.colorOverlay.opacity,
          pointerEvents: "none",
        }}
      />
      <AbsoluteFill
        data-layer="overlay-layer-01"
        style={{ ...layers.effect1, mixBlendMode: media.effect1BlendMode ?? layers.effect1.mixBlendMode, pointerEvents: "none" }}
      >
        <OffthreadVideo
          src={staticFile(media.effect1Src)}
          muted={MEDIA_LAYER_AUDIO_POLICY.overlayLayer01.muted}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        data-layer="overlay-layer-02"
        style={{ ...layers.effect2, mixBlendMode: media.effect2BlendMode ?? layers.effect2.mixBlendMode, pointerEvents: "none" }}
      >
        <OffthreadVideo
          src={staticFile(media.effect2Src)}
          muted={MEDIA_LAYER_AUDIO_POLICY.overlayLayer02.muted}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <Sequence durationInFrames={durationInFrames} premountFor={Math.min(15, durationInFrames)}>
        <OffthreadVideo
          data-layer="foreground-video"
          src={staticFile(media.sourceVideoSrc)}
          muted={MEDIA_LAYER_AUDIO_POLICY.foregroundVideo.muted}
          startFrom={startFromFrame}
          style={{ width: "100%", height: "100%", ...layers.foreground, transform: `translate(${foregroundTransform.x}px, ${foregroundTransform.y}px) scale(${foregroundTransform.scale})` }}
        />
      </Sequence>
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
    return (
      <AbsoluteFill>
        <VideoSegmentScene media={segment.media} fps={fps} />
        {segment.logo?.enabled !== false ? <LogoOverlay logo={logo} startFrom={0} /> : null}
      </AbsoluteFill>
    );
  }

  const { durationInFrames, scale, x, y } = resolveSegmentMotion(segment, frame, fps);
  if (segment.mediaMode === "newspaper") {
    return (
      <AbsoluteFill>
        <NewspaperScene segment={segment} frame={frame} durationInFrames={durationInFrames} />
        {segment.logo?.enabled !== false ? <LogoOverlay logo={logo} startFrom={0} /> : null}
      </AbsoluteFill>
    );
  }
  const layer = resolveCoverPanLayer({
    viewportWidth: VIEWPORT_WIDTH,
    viewportHeight: VIEWPORT_HEIGHT,
    imageWidth: segment.imageWidth,
    imageHeight: segment.imageHeight,
    ...resolvePanViewport(segment),
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
  const { outroStartFrame, outroFrames, totalFrames } = resolveCompositionTimeline({
    segments,
    fps,
    outro,
    compositionDurationSeconds,
  });

  return (
    <AbsoluteFill>
      {voiceSrc ? <Audio src={staticFile(voiceSrc)} volume={() => audio?.voice?.volume ?? 1} /> : null}
      {musicSrc ? (
        <Audio
          src={staticFile(musicSrc)}
          volume={(frame) =>
            getFadedMusicVolume({
              frame,
              baseVolume: audio?.music?.volume ?? 0.8,
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
        const { from, durationInFrames } = resolveSegmentSequence(segment, fps);

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
              muted={MEDIA_LAYER_AUDIO_POLICY.channelOutro.muted}
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
