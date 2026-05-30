import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';

type SubtitleTiming = {
  start_ms?: number;
  end_ms?: number;
};

type SubtitleStyle = {
  align?: 'left' | 'center' | 'right' | string;
  color?: string;
  font_family?: string;
  font_size?: number;
  font_weight?: string | number;
  max_width_px?: number;
};

type SubtitleLayout = {
  lines?: string[];
};

type SubtitleCue = {
  text?: string;
  timing?: SubtitleTiming;
  style?: SubtitleStyle;
  layout?: SubtitleLayout;
};

type FontFace = {
  family: string;
  weight?: string;
  public_path: string;
};

export type SubtitleRenderProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  background?: string;
  source_static_path?: string;
  subtitles: SubtitleCue[];
  font_faces?: FontFace[];
};

const previewOverlayPaddingX = 94;
const previewPaddingY = 14;
const previewStripeThickness = 3;
const previewLineHeight = 1.02;

function justifyContentForAlign(align: string | undefined): React.CSSProperties['justifyContent'] {
  if (align === 'right') return 'flex-end';
  if (align === 'center') return 'center';
  return 'flex-start';
}

function safeNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function fontFaceCss(fontFaces: FontFace[] = []): string {
  return fontFaces
    .map((font) => `@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(staticFile(font.public_path))}) format('truetype');font-weight:${font.weight || '400'};font-style:normal;font-display:block;}`)
    .join('\n');
}

function activeCueAtFrame(subtitles: SubtitleCue[], frame: number, fps: number): SubtitleCue | null {
  const timeMs = (frame / fps) * 1000;
  return subtitles.find((cue) => {
    const startMs = safeNumber(cue.timing?.start_ms, 0);
    const endMs = safeNumber(cue.timing?.end_ms, 0);
    return endMs > startMs && timeMs >= startMs && timeMs < endMs;
  }) || null;
}

const SubtitleOverlay: React.FC<{cue: SubtitleCue}> = ({cue}) => {
  const style = cue.style || {};
  const align = String(style.align || 'left').toLowerCase();
  const lines = Array.isArray(cue.layout?.lines)
    ? cue.layout.lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    : [];
  const text = String(cue.text || '');
  const fontFamily = String(style.font_family || 'Khand');
  const fontSize = safeNumber(style.font_size, 110);
  const maxWidth = safeNumber(style.max_width_px, 1080);
  const color = String(style.color || '#FFFFFF');
  const fontWeight = style.font_weight || (fontFamily === 'Khand' || fontFamily === 'Oswald' ? '700' : 'normal');

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: justifyContentForAlign(align),
        paddingLeft: previewOverlayPaddingX,
        paddingRight: previewOverlayPaddingX,
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: maxWidth,
          maxWidth,
          boxSizing: 'border-box',
          color,
          fontFamily,
          fontSize,
          fontWeight,
          lineHeight: previewLineHeight,
          textTransform: 'uppercase',
          textAlign: 'center',
          borderTop: `${previewStripeThickness}px solid currentColor`,
          borderBottom: `${previewStripeThickness}px solid currentColor`,
          padding: `${previewPaddingY}px 0`,
          textShadow: 'none',
          whiteSpace: lines.length > 0 ? 'pre' : 'normal',
        }}
      >
        {lines.length > 0
          ? lines.map((line, index) => (
            <span key={`${line}-${index}`} style={{display: 'block'}}>{line}</span>
          ))
          : text}
      </div>
    </AbsoluteFill>
  );
};

export const SubtitleRender: React.FC<SubtitleRenderProps> = ({
  background = '#000000',
  source_static_path: sourceStaticPath = '',
  subtitles = [],
  font_faces: fontFaces = [],
}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const cue = activeCueAtFrame(subtitles, frame, fps);

  return (
    <AbsoluteFill style={{backgroundColor: background || '#000000'}}>
      <style>{fontFaceCss(fontFaces)}</style>
      {sourceStaticPath ? (
        <OffthreadVideo
          src={staticFile(sourceStaticPath)}
          style={{
            width,
            height,
            objectFit: 'cover',
          }}
        />
      ) : null}
      {cue ? <SubtitleOverlay cue={cue} /> : null}
    </AbsoluteFill>
  );
};
