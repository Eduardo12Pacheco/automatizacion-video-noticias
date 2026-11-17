import {
  AbsoluteFill,
  Img,
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
} from "remotion";
import { useEffect, useState } from "react";
import {
  NEWSPAPER_BACKGROUND_STYLE,
  NEWSPAPER_FOREGROUND_STYLE,
  NEWSPAPER_LABEL_FONT_SIZE,
  NEWSPAPER_LABEL_LINES,
  NEWSPAPER_LABEL_STYLE,
  NEWSPAPER_LOCAL_FONT_FAMILY,
  NEWSPAPER_LOCAL_FONT_URL,
  resolveNewspaperMotion,
} from "./composition-timing";
type MotionSource = {
  fromScale?: number;
  toScale?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
};

type NewspaperSegment = {
  image: string;
  newspaper?: {
    foregroundMotion?: MotionSource | string | null;
    labelEnabled?: boolean;
  } | null;
};

const NEWSPAPER_FONT_FACE_CSS = `@font-face {
  font-family: "${NEWSPAPER_LOCAL_FONT_FAMILY}";
  src: url("${staticFile(NEWSPAPER_LOCAL_FONT_URL)}") format("woff2");
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
  const { scale, x, y } = resolveNewspaperMotion({
    frame,
    durationInFrames,
    foregroundMotion: segment.newspaper?.foregroundMotion,
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
          ...NEWSPAPER_BACKGROUND_STYLE,
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
          ...NEWSPAPER_FOREGROUND_STYLE,
          transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})`,
        }}
      />
      {segment.newspaper?.labelEnabled === false ? null : <div
        data-layer="newspaper-artistic-label"
        style={{
          position: "absolute",
          ...NEWSPAPER_LABEL_STYLE,
          color: "#000",
          letterSpacing: "0.02em",
          whiteSpace: "pre-line",
        }}
      >
        {NEWSPAPER_LABEL_LINES.join("\n")}
      </div>}
    </AbsoluteFill>
  );
};
