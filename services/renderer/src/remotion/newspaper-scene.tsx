import {
  AbsoluteFill,
  Img,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
} from "remotion";
import { useEffect, useState } from "react";
import { resolveMotionRange, type MotionSource } from "./motion-range";

const NEWSPAPER_LABEL_LINES = ["RECREACIÓN", "ARTÍSTICA"];
const NEWSPAPER_MOTION = { fromScale: 1, toScale: 1.1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
const NEWSPAPER_BACKGROUND_BLUR = 15;

type NewspaperSegment = {
  image: string;
  newspaper?: {
    foregroundMotion?: MotionSource | string | null;
    labelEnabled?: boolean;
  } | null;
};

const NEWSPAPER_LOCAL_FONT_FAMILY = "Demo Display";
const NEWSPAPER_LOCAL_FONT_URL = staticFile("fonts/display/Demo-Display.woff2");
const NEWSPAPER_LABEL_FONT_FAMILY = "\"Demo Display\", Inter, Arial, sans-serif";
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
  const [fontHandle] = useState(() => delayRender("Loading Demo Display newspaper font"));

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

export const NewspaperScene = ({
  segment,
  frame,
  durationInFrames,
}: {
  segment: NewspaperSegment;
  frame: number;
  durationInFrames: number;
}) => {
  useNewspaperFont();
  const motionRange = segment.newspaper?.foregroundMotion ? resolveMotionRange(segment.newspaper.foregroundMotion) : NEWSPAPER_MOTION;
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
          transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
          transformOrigin: "center center",
        }}
      />
      {segment.newspaper?.labelEnabled === false ? null : <div
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
      </div>}
    </AbsoluteFill>
  );
};
