import subprocess
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML_PATH = ROOT / "index.html"
SUBTITLES_TEMPLATE_PATH = ROOT / "js" / "modules" / "app-shell" / "views" / "templates" / "subtitles-view.js"
APP_SHELL_PATH = ROOT / "js" / "modules" / "app-shell.js"
SUBTITLE_WORKFLOW_PATH = ROOT / "js" / "modules" / "subtitles-workflow.mjs"
SUBTITLE_RUNTIME_SERVICES_PATH = ROOT / "js" / "modules" / "features" / "subtitles" / "runtime" / "services.js"
SUBTITLE_RUNTIME_PRESENTATION_PATH = ROOT / "js" / "modules" / "features" / "subtitles" / "runtime" / "presentation.js"
SUBTITLE_CONTROLLER_PATH = ROOT / "js" / "modules" / "features" / "subtitles" / "controller.js"
SUBTITLE_CONTROLLER_SUPPORT_PATHS = [
    ROOT / "js" / "modules" / "features" / "subtitles" / "controller" / file_name
    for file_name in [
        "context.js",
        "session.js",
        "render-workflow.js",
        "table-editor.js",
        "preview-player.js",
        "render-commands.js",
    ]
]
SUBTITLE_CSS_DIR = ROOT / "styles" / "features" / "subtitles"


def _read_subtitle_css() -> str:
    return "\n".join(
        (SUBTITLE_CSS_DIR / file_name).read_text(encoding="utf-8")
        for file_name in [
            "legacy-base.css",
            "tokens.css",
            "layout.css",
            "upload.css",
            "preview.css",
            "history.css",
            "phases.css",
            "table.css",
            "responsive.css",
        ]
    )


def _subtitle2_scoped_css(css: str) -> str:
    """Return only Subtítulos 2 scoped rule blocks, including responsive overrides."""
    scoped_blocks = []
    for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        if "#viewSubtitulos2" in selector or ".subtitle2-screen" in selector:
            scoped_blocks.append(f"{selector}{{{body}}}")
    return "\n".join(scoped_blocks)


def _border_radius_values(css: str) -> list[str]:
    return re.findall(r"border-radius\s*:\s*([^;]+);", css)


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def _read_subtitle_controller_sources() -> str:
    return "\n".join(
        [SUBTITLE_CONTROLLER_PATH.read_text(encoding="utf-8")]
        + [path.read_text(encoding="utf-8") for path in SUBTITLE_CONTROLLER_SUPPORT_PATHS]
    )


def test_subtitle2_preview_runtime_helpers_scale_overlay_and_clamp_timeline_seek():
    script = r"""
import {
  buildSubtitlePreviewPresentationRuntime,
  resolveSubtitleTimelineSeekMsRuntime,
} from './js/modules/features/subtitles/runtime/services.js';

const centered = buildSubtitlePreviewPresentationRuntime({
  activeCue: {
    phrase: 'demo total',
    color: '#FFF000',
    fontFamily: 'Anton',
    size: '110',
    maxWidthPx: 960,
    align: 'center',
  },
  currentMs: 2500,
  durationMs: 10000,
  stageWidth: 960,
  stageHeight: 540,
});

if (!centered.hasCue) throw new Error('expected active cue presentation');
if (centered.text !== 'DEMO TOTAL') throw new Error(`unexpected cue text: ${centered.text}`);
if (centered.justifyContent !== 'center') throw new Error(`unexpected justify: ${centered.justifyContent}`);
if (centered.playheadPercent !== 25) throw new Error(`unexpected playhead: ${centered.playheadPercent}`);
if (centered.fontSizePx !== 55) throw new Error(`expected scaled font size, got ${centered.fontSizePx}`);
if (centered.cueWidthPx !== 480) throw new Error(`expected scaled cue width, got ${centered.cueWidthPx}`);
if (centered.fontWeight !== 'normal') throw new Error(`expected Anton normal weight, got ${centered.fontWeight}`);

const rightAligned = buildSubtitlePreviewPresentationRuntime({
  activeCue: {
    phrase: 'cierre',
    color: '#FFFFFF',
    fontFamily: 'Khand',
    size: '90',
    maxWidthPx: 840,
    align: 'right',
  },
  currentMs: 9000,
  durationMs: 10000,
  stageWidth: 480,
  stageHeight: 270,
});

if (rightAligned.justifyContent !== 'flex-end') throw new Error(`right align drift: ${rightAligned.justifyContent}`);
if (rightAligned.playheadPercent !== 90) throw new Error(`expected 90 percent, got ${rightAligned.playheadPercent}`);
if (rightAligned.fontWeight !== 'Bold') throw new Error(`expected Khand Bold export weight, got ${rightAligned.fontWeight}`);

const beforeTrack = resolveSubtitleTimelineSeekMsRuntime({ clientX: 10, rectLeft: 100, rectWidth: 400, durationMs: 10000 });
const middleTrack = resolveSubtitleTimelineSeekMsRuntime({ clientX: 300, rectLeft: 100, rectWidth: 400, durationMs: 10000 });
const afterTrack = resolveSubtitleTimelineSeekMsRuntime({ clientX: 800, rectLeft: 100, rectWidth: 400, durationMs: 10000 });

if (beforeTrack != 0) throw new Error(`seek should clamp before track, got ${beforeTrack}`);
if (middleTrack != 5000) throw new Error(`seek should resolve middle point, got ${middleTrack}`);
if (afterTrack != 10000) throw new Error(`seek should clamp after track, got ${afterTrack}`);
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_subtitle2_preview_playback_state_is_available_to_app_shell_events():
    script = r"""
import { createSubtitlePreviewPlayer } from './js/modules/features/subtitles/controller/preview-player.js';

const state = { subtitles2: { previewPlaying: false, rows: [], previewCurrentMs: 0 } };
const playButton = {
  textContent: '',
  attributes: {},
  setAttribute(name, value) { this.attributes[name] = value; },
};
const player = createSubtitlePreviewPlayer({
  state,
  el: { subtitle2PreviewPlayBtn: playButton },
  api: {},
  URLImpl: { revokeObjectURL() {}, createObjectURL() { return ''; } },
  windowRef: { addEventListener() {}, removeEventListener() {} },
});

player.renderPreviewPlaybackState();
if (playButton.textContent !== '▶') {
  throw new Error(`expected paused icon, got ${playButton.textContent}`);
}
if (playButton.attributes['aria-label'] !== 'Reproducir preview') {
  throw new Error(`paused aria-label drift: ${playButton.attributes['aria-label']}`);
}

state.subtitles2.previewPlaying = true;
player.renderPreviewPlaybackState();
if (playButton.textContent !== '❚❚') {
  throw new Error(`expected playing icon, got ${playButton.textContent}`);
}
if (playButton.attributes.title !== 'Pausar') {
  throw new Error(`playing title drift: ${playButton.attributes.title}`);
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_subtitle2_health_runtime_outputs_compact_remote_online_offline_chip_contract():
    script = r"""
import { buildSubtitleHealthRuntime } from './js/modules/features/subtitles/runtime/services.js';

const online = buildSubtitleHealthRuntime({ status: 'online', message: 'Servicio remoto disponible.' }, 'remote-core');
if (online.banner !== 'Servidor conectado') throw new Error(`online chip drift: ${online.banner}`);
if (online.status !== 'online') throw new Error(`online status drift: ${online.status}`);
if (online.tone !== 'online') throw new Error(`online tone drift: ${online.tone}`);

const healthy = buildSubtitleHealthRuntime({ status: 'healthy', message: 'OK' }, 'remote-core');
if (healthy.banner !== 'Servidor conectado') throw new Error(`healthy chip drift: ${healthy.banner}`);
if (healthy.tone !== 'online') throw new Error(`healthy tone drift: ${healthy.tone}`);

for (const status of ['offline', 'degraded', 'unavailable', 'failed', 'pending']) {
  const resolved = buildSubtitleHealthRuntime({ status, message: 'Una oración larga que no debe agrandar el chip.' }, 'remote-core');
  if (resolved.banner !== 'Servidor desconectado') throw new Error(`${status} chip drift: ${resolved.banner}`);
  if (resolved.tone !== 'offline') throw new Error(`${status} tone drift: ${resolved.tone}`);
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_subtitle2_hydrated_render_state_preserves_finished_downloadable_sessions():
    script = r"""
import { resolveHydratedSubtitleRenderStateRuntime } from './js/modules/features/subtitles/runtime/services.js';

const readyFromDownload = resolveHydratedSubtitleRenderStateRuntime({ status: 'editing', download: { ready: true } });
if (readyFromDownload.status !== 'succeeded') throw new Error(`download-ready status drift: ${readyFromDownload.status}`);
if (readyFromDownload.artifactReady !== true) throw new Error('download-ready artifact drift');

const readyFromSession = resolveHydratedSubtitleRenderStateRuntime({ status: 'succeeded', download: { ready: false } });
if (readyFromSession.status !== 'succeeded') throw new Error(`session-succeeded status drift: ${readyFromSession.status}`);
if (readyFromSession.artifactReady !== true) throw new Error('session-succeeded artifact drift');

const explicitRunning = resolveHydratedSubtitleRenderStateRuntime({ status: 'editing', render: { status: 'running' }, download: { ready: false } });
if (explicitRunning.status !== 'running') throw new Error(`explicit running drift: ${explicitRunning.status}`);
if (explicitRunning.artifactReady !== false) throw new Error('explicit running artifact drift');

const empty = resolveHydratedSubtitleRenderStateRuntime({ status: 'editing', download: { ready: false } });
if (empty.status !== '') throw new Error(`editing status drift: ${empty.status}`);
if (empty.artifactReady !== false) throw new Error('editing artifact drift');
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_subtitle2_reset_preserves_remote_health_history_and_language_context():
    script = r"""
import { createSubtitlesController } from './js/modules/features/subtitles/controller.js';

let revokedUrl = '';
const state = {
  subtitles2: {
    previewVideoObjectUrl: 'blob:previous-preview',
    serviceHealth: { status: 'online', message: 'Servicio remoto disponible.' },
    sessionHistory: [{ id: 'session-1', status: 'succeeded' }],
    sourceLanguage: 'en',
  },
};

const controller = createSubtitlesController({
  state,
  el: {},
  api: {},
  ui: { toast() {} },
  helpers: {
    getErrorMessage(error, fallback) { return fallback; },
    downloadBlob() {},
    escapeHtml(value) { return (value ?? '').toString(); },
  },
  customDropdowns: { refreshAll() {} },
  browser: {
    URL: { revokeObjectURL(url) { revokedUrl = url; } },
    window: {},
    setTimeout() {},
    clearTimeout() {},
    clearInterval() {},
  },
});

controller.resetRunState();

if (revokedUrl !== 'blob:previous-preview') throw new Error(`preview object URL was not revoked: ${revokedUrl}`);
if (state.subtitles2.serviceHealth.status !== 'online') throw new Error(`health was not preserved: ${state.subtitles2.serviceHealth.status}`);
if (state.subtitles2.sessionHistory.length !== 1) throw new Error(`history was not preserved: ${state.subtitles2.sessionHistory.length}`);
if (state.subtitles2.sourceLanguage !== 'en') throw new Error(`source language was not preserved: ${state.subtitles2.sourceLanguage}`);
if (state.subtitles2.sessionId !== null) throw new Error('active session should be cleared');
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr
