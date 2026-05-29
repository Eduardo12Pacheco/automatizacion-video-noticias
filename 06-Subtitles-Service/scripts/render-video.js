#!/usr/bin/env node

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

function numeric(value, fallback, min = null) {
  const parsed = Number(value);
  const next = Number.isFinite(parsed) ? parsed : fallback;
  return min == null ? next : Math.max(min, next);
}

function resolveSourceVideo(payload, propsPath) {
  const candidates = [
    payload.source_video_path,
    payload.source_video,
    payload.input_video,
    payload.video_path,
    path.join(path.dirname(propsPath), 'source.mp4'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(path.dirname(propsPath), String(candidate));
    if (fs.existsSync(resolved)) return resolved;
  }
  return '';
}

function subtitleEndSeconds(payload) {
  const rows = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  return Math.max(1, ...rows.map((row) => Number(row?.timing?.end_ms || 0) / 1000));
}

function probeSourceDurationSeconds(sourceVideo) {
  if (!sourceVideo) return 0;
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    sourceVideo,
  ], { encoding: 'utf8' });
  if (result.status !== 0) return 0;
  const duration = Number(String(result.stdout || '').trim());
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function makeRenderPublicDir(name) {
  const publicDir = path.resolve(__dirname, '..', 'public');
  const renderDirName = `.remotion-${name}-${process.pid}-${Date.now()}`;
  const renderDir = path.join(publicDir, renderDirName);
  fs.mkdirSync(renderDir, { recursive: true });
  return { renderDir, publicPathPrefix: renderDirName };
}

function copyStaticAsset(sourcePath, targetDir, publicPathPrefix, targetName) {
  const safeName = targetName.replace(/[^a-zA-Z0-9._-]/g, '-');
  fs.copyFileSync(sourcePath, path.join(targetDir, safeName));
  return `${publicPathPrefix}/${safeName}`;
}

function prepareStaticSource(sourceVideo) {
  if (!sourceVideo) return { publicPath: '', cleanupDir: '' };
  const { renderDir, publicPathPrefix } = makeRenderPublicDir('input');
  const extension = path.extname(sourceVideo) || '.mp4';
  const publicPath = copyStaticAsset(sourceVideo, renderDir, publicPathPrefix, `source${extension}`);
  return { publicPath, cleanupDir: renderDir };
}

function subtitleFontFaces() {
  const fontsDir = path.resolve(__dirname, '..', 'assets', 'fonts', 'subtitles');
  if (!fs.existsSync(fontsDir)) return [];
  const { renderDir, publicPathPrefix } = makeRenderPublicDir('fonts');
  const metadata = {
    'Khand-Bold.ttf': { family: 'Khand', weight: '700' },
    'Oswald-Bold.ttf': { family: 'Oswald', weight: '700' },
    'BebasNeue-Regular.ttf': { family: 'Bebas Neue', weight: '400' },
    'Anton-Regular.ttf': { family: 'Anton', weight: '400' },
    'LeagueGothic-Regular.ttf': { family: 'League Gothic', weight: '400' },
  };
  return fs.readdirSync(fontsDir)
    .filter((entry) => /\.(ttf|otf|ttc)$/i.test(entry))
    .map((entry) => ({
      family: metadata[entry]?.family || path.basename(entry, path.extname(entry)),
      weight: metadata[entry]?.weight || '400',
      public_path: copyStaticAsset(path.join(fontsDir, entry), renderDir, publicPathPrefix, entry),
      cleanup_dir: renderDir,
    }));
}

function remotionCommand() {
  const executable = process.platform === 'win32' ? 'remotion.cmd' : 'remotion';
  const local = path.resolve(__dirname, '..', 'node_modules', '.bin', executable);
  if (fs.existsSync(local)) return { command: local, prefixArgs: [] };
  return { command: process.platform === 'win32' ? 'npx.cmd' : 'npx', prefixArgs: ['--yes', 'remotion'] };
}

const propsPath = readArg('--props');
const outputPath = readArg('--output');
if (!propsPath || !outputPath) fail('Usage: node scripts/render-video.js --props <render-props.json> --output <video-final.mp4>');
if (!fs.existsSync(propsPath)) fail(`Render props not found: ${propsPath}`);

const payload = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
const width = Math.round(numeric(payload.width, 1920, 1));
const height = Math.round(numeric(payload.height, 1080, 1));
const fps = Math.round(numeric(payload.fps, 30, 1));
const sourceVideo = resolveSourceVideo(payload, propsPath);
const durationSeconds = Math.max(subtitleEndSeconds(payload), probeSourceDurationSeconds(sourceVideo));
const durationInFrames = Math.max(1, Math.ceil(durationSeconds * fps));
const staticSource = prepareStaticSource(sourceVideo);
const fontFaces = subtitleFontFaces();
const cleanupDirs = [
  staticSource.cleanupDir,
  ...fontFaces.map((font) => font.cleanup_dir),
].filter(Boolean);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitles-remotion-'));
const enrichedPropsPath = path.join(tempDir, 'render-props.remotion.json');
const enrichedPayload = {
  ...payload,
  width,
  height,
  fps,
  durationInFrames,
  source_video_path: sourceVideo || payload.source_video_path || '',
  source_static_path: staticSource.publicPath,
  font_faces: fontFaces.map(({ cleanup_dir, ...font }) => font),
};
fs.writeFileSync(enrichedPropsPath, JSON.stringify(enrichedPayload, null, 2), 'utf8');

const entry = path.resolve(__dirname, '..', 'src', 'remotion', 'Root.tsx');
const { command, prefixArgs } = remotionCommand();
const args = [
  ...prefixArgs,
  'render',
  entry,
  'SubtitlesRender',
  outputPath,
  `--props=${enrichedPropsPath}`,
  '--codec=h264',
  '--hardware-acceleration=if-possible',
  '--gl=angle',
  `--width=${width}`,
  `--height=${height}`,
  `--fps=${fps}`,
];

const result = spawnSync(command, args, {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
  maxBuffer: 1024 * 1024 * 64,
  shell: process.platform === 'win32',
});
fs.rmSync(tempDir, { recursive: true, force: true });
for (const dir of new Set(cleanupDirs)) fs.rmSync(dir, { recursive: true, force: true });
if (result.error) fail('Remotion subtitle render failed', result.error.stack || result.error.message);
if (result.status !== 0) fail('Remotion subtitle render failed', result.stderr || result.stdout || 'unknown Remotion error');
if (!fs.existsSync(outputPath)) fail(`Render output was not created: ${outputPath}`);
console.log(`Rendered subtitles video with Remotion: ${outputPath}`);
