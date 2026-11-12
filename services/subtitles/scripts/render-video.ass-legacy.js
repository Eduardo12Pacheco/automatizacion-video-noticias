#!/usr/bin/env node

// Legacy ASS/libass renderer retained intentionally while the Remotion/Chromium path is proven.
// Not invoked by the production render wrapper.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return '';
  return process.argv[index + 1];
}

function fail(message, details = '') {
  console.error(details ? `${message}\n${details}` : message);
  process.exit(1);
}

function assEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function assText(value, uppercase = true) {
  const text = assEscape(value).replace(/\s+/g, ' ').trim();
  return uppercase ? text.toUpperCase() : text;
}

function assTime(ms) {
  const totalCs = Math.max(0, Math.round(Number(ms || 0) / 10));
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assColor(hex) {
  const clean = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F').slice(0, 6);
  const rr = clean.slice(0, 2);
  const gg = clean.slice(2, 4);
  const bb = clean.slice(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function boldFlag(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'bold') return 1;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric >= 600 ? 1 : 0;
}

function numeric(value, fallback, min = null) {
  const parsed = Number(value);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return min == null ? next : Math.max(min, next);
}

const ASS_FONT_NAME = {
  Impact: 'Bebas Neue',
};

const ASS_FONT_SCALE = {
  Khand: { x: 145 },
};

function resolveAssFontScale(fontFamily, fontName) {
  return ASS_FONT_SCALE[fontFamily] || ASS_FONT_SCALE[fontName] || {};
}

function assFontScaleTags(scale) {
  const tags = [];
  const scaleX = Number(scale?.x);
  const scaleY = Number(scale?.y);
  if (Number.isFinite(scaleX) && scaleX > 0 && scaleX !== 100) tags.push(`\\fscx${Math.round(scaleX)}`);
  if (Number.isFinite(scaleY) && scaleY > 0 && scaleY !== 100) tags.push(`\\fscy${Math.round(scaleY)}`);
  return tags.join('');
}

function resolveCueStyle(row, width) {
  const style = row?.style || {};
  const stripe = style.stripe || style.accent || {};
  const fontSize = numeric(style.font_size, 110, 1);
  return {
    align: style.align || 'left',
    color: style.color || '#FFFFFF',
    fontFamily: style.font_family || 'Khand',
    fontSize,
    fontWeight: style.font_weight || ((style.font_family === 'Khand' || style.font_family === 'Oswald') ? 'Bold' : 'normal'),
    lineHeight: numeric(style.line_height, 1.02, 0.1),
    maxWidth: Math.min(width, numeric(style.max_width_px, 1080, 1)),
    paddingX: numeric(style.padding_x_px ?? style.left_px, 22, 0),
    paddingY: numeric(style.padding_y_px ?? stripe.padding_y_px, 14, 0),
    stripeEnabled: style.stripe_enabled !== false && stripe.enabled !== false,
    stripeThickness: numeric(style.stripe_thickness_px ?? stripe.thickness_px, 3, 0),
    textAlign: style.text_align || 'center',
    textTransform: style.text_transform || 'uppercase',
    textShadow: style.text_shadow || 'none',
  };
}

function readBrowserComputedLines(row, uppercase = true) {
  const candidates = [row?.layout?.lines, row?.style?.layout?.lines];
  const rawLines = candidates.find((value) => Array.isArray(value));
  if (!rawLines) return [];
  return rawLines.map((line) => assText(line, uppercase)).filter(Boolean);
}

function estimateAverageGlyphWidth(fontFamily, fontSize) {
  const family = String(fontFamily || '').toLowerCase();
  if (family.includes('oswald')) return fontSize * 0.62;
  if (family.includes('anton')) return fontSize * 0.60;
  if (family.includes('impact') || family.includes('bebas')) return fontSize * 0.58;
  if (family.includes('khand')) return fontSize * 0.55;
  if (family.includes('league gothic')) return fontSize * 0.52;
  return fontSize * 0.54;
}

function wrapCueText(text, style) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const maxChars = Math.max(1, Math.floor(style.maxWidth / estimateAverageGlyphWidth(style.fontFamily, style.fontSize)));
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function resolveCueLines(row, style) {
  const uppercase = style.textTransform === 'uppercase';
  const browserLines = readBrowserComputedLines(row, uppercase);
  if (browserLines.length) return browserLines;
  return wrapCueText(assText(row?.text, uppercase), style);
}

function cueCenterX(style, width) {
  const align = String(style.align || 'left').toLowerCase();
  if (align === 'right') return width - style.paddingX - style.maxWidth / 2;
  if (align === 'center') return width / 2;
  return style.paddingX + style.maxWidth / 2;
}

function drawingRectangle(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return `m 0 0 l ${w} 0 l ${w} ${h} l 0 ${h}`;
}

function buildAss(payload) {
  const width = Number(payload.width || 1920);
  const height = Number(payload.height || 1080);
  const rows = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Khand,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,70,70,0,1',
    'Style: Stripe,Arial,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = rows.flatMap((row) => {
    const timing = row?.timing || {};
    const style = resolveCueStyle(row, width);
    const lines = resolveCueLines(row, style);
    if (!lines.length) return [];
    const start = assTime(timing.start_ms);
    const end = assTime(timing.end_ms);
    const color = assColor(style.color);
    const centerX = cueCenterX(style, width);
    const centerY = height / 2;
    const lineHeightPx = style.fontSize * style.lineHeight;
    const blockHeight = lines.length * lineHeightPx + style.paddingY * 2 + style.stripeThickness * 2;
    const stripeLeft = Math.round(centerX - style.maxWidth / 2);
    const stripeTop = Math.round(centerY - blockHeight / 2);
    const stripeBottom = Math.round(centerY + blockHeight / 2 - style.stripeThickness);
    const fontName = ASS_FONT_NAME[style.fontFamily] || style.fontFamily;
    const fontScaleTags = assFontScaleTags(resolveAssFontScale(style.fontFamily, fontName));
    const anValue = style.textAlign === 'left' ? 4 : style.textAlign === 'right' ? 6 : 5;
    let baseOverrideTags = `\\fn${fontName}\\fs${Math.round(style.fontSize)}${fontScaleTags}\\b${boldFlag(style.fontWeight)}\\c${color}\\an${anValue}`;
    if (style.textShadow !== 'none') baseOverrideTags += '\\shad1\\bord1.5';
    const firstLineY = centerY - (lines.length - 1) * lineHeightPx / 2;
    const textEvents = lines.map((line, i) => {
      const lineY = Math.round(firstLineY + i * lineHeightPx);
      const override = `{${baseOverrideTags}\\pos(${Math.round(centerX)},${lineY})}`;
      return `Dialogue: 1,${start},${end},Default,,0,0,0,,${override}${line}`;
    });
    if (!style.stripeEnabled || style.stripeThickness <= 0) return textEvents;
    const stripeOverride = `{\\p1\\an7\\pos(${stripeLeft},${stripeTop})\\c${color}\\bord0\\shad0}`;
    const bottomStripeOverride = `{\\p1\\an7\\pos(${stripeLeft},${stripeBottom})\\c${color}\\bord0\\shad0}`;
    const stripePath = drawingRectangle(style.maxWidth, style.stripeThickness);
    return [
      `Dialogue: 0,${start},${end},Stripe,,0,0,0,,${stripeOverride}${stripePath}`,
      `Dialogue: 0,${start},${end},Stripe,,0,0,0,,${bottomStripeOverride}${stripePath}`,
      ...textEvents,
    ];
  });
  return [...header, ...events, ''].join(os.EOL);
}

function resolveSourceVideo(payload, propsPath) {
  const candidates = [payload.source_video, payload.source_video_path, payload.input_video, payload.video_path, path.join(path.dirname(propsPath), 'source.mp4')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(path.dirname(propsPath), String(candidate));
    if (fs.existsSync(resolved)) return resolved;
  }
  return '';
}

function copySubtitleFonts(tempDir) {
  const fontsDir = path.resolve(__dirname, '..', 'assets', 'fonts', 'subtitles');
  if (!fs.existsSync(fontsDir)) return false;
  let copied = false;
  for (const entry of fs.readdirSync(fontsDir)) {
    if (!/\.(ttf|otf|ttc)$/i.test(entry)) continue;
    fs.copyFileSync(path.join(fontsDir, entry), path.join(tempDir, entry));
    copied = true;
  }
  return copied;
}

const propsPath = readArg('--props');
const outputPath = readArg('--output');
if (!propsPath || !outputPath) fail('Usage: node scripts/render-video.ass-legacy.js --props <render-props.json> --output <video-final.mp4>');
if (!fs.existsSync(propsPath)) fail(`Render props not found: ${propsPath}`);

const payload = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const width = Number(payload.width || 1920);
const height = Number(payload.height || 1080);
const fps = Number(payload.fps || 30);
const sourceVideo = resolveSourceVideo(payload, propsPath);
const durationSeconds = Math.max(1, ...((Array.isArray(payload.subtitles) ? payload.subtitles : []).map((row) => Number(row?.timing?.end_ms || 0) / 1000)));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitles-render-'));
const assPath = path.join(tempDir, 'subtitles.ass');
fs.writeFileSync(assPath, buildAss(payload), 'utf8');
const hasSubtitleFonts = copySubtitleFonts(tempDir);
const assFilter = hasSubtitleFonts ? 'ass=subtitles.ass:fontsdir=.' : 'ass=subtitles.ass';
const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,${assFilter}`;
const baseArgs = sourceVideo
  ? ['-y', '-hide_banner', '-i', sourceVideo, '-vf', videoFilter, '-map', '0:v:0', '-map', '0:a?', '-c:a', 'copy', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
  : ['-y', '-hide_banner', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${durationSeconds}`, '-vf', assFilter, '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];

let result = spawnSync('ffmpeg', [...baseArgs, '-c:v', 'h264_nvenc', outputPath], { cwd: tempDir, encoding: 'utf8' });
if (result.status !== 0) result = spawnSync('ffmpeg', [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', outputPath], { cwd: tempDir, encoding: 'utf8' });
fs.rmSync(tempDir, { recursive: true, force: true });
if (result.status !== 0) fail('ffmpeg subtitle render failed', result.stderr || result.stdout || 'unknown ffmpeg error');
if (!fs.existsSync(outputPath)) fail(`Render output was not created: ${outputPath}`);
console.log(`Rendered subtitles video with legacy ASS/libass: ${outputPath}`);
