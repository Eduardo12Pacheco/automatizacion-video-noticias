"""T20 screens & states contract (S10).

Mechanical checks for the pieces that are easy to regress: the login screen,
the shared screen-state vocabulary, the three-column editorial layout, the
showcase fixtures for every service prefix and the demo progress fix.
"""
from pathlib import Path
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _node(script: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_login_shows_the_product_not_the_old_studio_name():
    index = _read(ROOT / "index.html")
    auth = index.split('id="authGate"', 1)[1].split("</section>", 1)[0]
    assert "Newsroom Video Automation" in auth
    assert "auth-card__mark" in auth
    assert 'id="authLanguageSwitch"' in auth
    assert 'data-auth-language="es"' in auth and 'data-auth-language="en"' in auth
    assert 'id="authError"' in auth
    assert "Operations Studio" not in index

    for path in (ROOT / "js").rglob("*.js"):
        assert "Operations Studio" not in _read(path), path


def test_editorial_layout_is_three_columns_in_pipeline_order():
    index = _read(ROOT / "index.html")
    grid = index.split('class="approval-shell-grid"', 1)[1].split('id="viewScripts"', 1)[0]
    assert "approval-primary-column" not in grid
    news = grid.index('class="panel-shell news-panel"')
    workbench = grid.index('class="panel-shell script-workbench"')
    side = grid.index('class="approval-side-column"')
    assert news < workbench < side

    approval_css = _read(ROOT / "styles" / "features" / "approval.css")
    assert "grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.9fr) minmax(300px, 0.85fr)" in approval_css


def test_press_cards_use_a_grid_on_the_wide_layout():
    radar_css = _read(ROOT / "styles" / "features" / "radar.css")
    assert "@media (min-width: 1200px)" in radar_css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr))" in radar_css


def test_subtitles_use_one_visual_stage():
    layout = _read(ROOT / "styles" / "features" / "subtitles" / "layout.css")
    assert "#viewSubtitulos2 .subtitle2-master-card .subtitle2-upload-source-card" in layout
    assert "border: 0" in layout
    preview = _read(ROOT / "styles" / "features" / "subtitles" / "preview.css")
    assert "min-width: 0" in preview


def test_shared_screen_state_keeps_raw_error_bodies_out_of_the_dom():
    script = """
      import { renderErrorState, renderEmptyState, renderLoadingState, describeError } from './js/modules/core/ui/screen-state.js';
      const hostile = Object.assign(new Error('<html><body>stacktrace secret=abc HTTP 500</body></html>'), { status: 403, code: 'forbidden' });
      const userView = renderErrorState({ error: hostile, fallbackKey: 'errors.generic', admin: false });
      const adminView = renderErrorState({ error: hostile, fallbackKey: 'errors.generic', admin: true });
      console.log(JSON.stringify({
        userView, adminView,
        empty: renderEmptyState({ titleKey: 'state.emptyTitle', messageKey: 'state.emptyMessage' }),
        loading: renderLoadingState({ rows: 2 }),
        mapped: describeError(hostile),
        session: describeError(Object.assign(new Error('x'), { status: 401 })),
      }));
    """
    result = _node(script)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "secret=abc" not in payload["userView"]
    assert "<html>" not in payload["userView"]
    assert "stacktrace" not in payload["userView"]
    assert "screen-state--error" in payload["userView"]
    assert "Tu rol no tiene permiso" in payload["userView"]
    assert "<details" not in payload["userView"]
    assert "<details" in payload["adminView"]
    assert "403" in payload["adminView"]
    assert "screen-state--empty" in payload["empty"]
    assert "skeleton-block" in payload["loading"]
    assert payload["mapped"] == "errors.forbidden"
    assert payload["session"] == "errors.session"


def test_showcase_answers_every_service_prefix_with_no_network():
    script = """
      globalThis.location = { origin: 'http://127.0.0.1:8154', search: '?showcase=1' };
      const showcase = await import('./js/modules/core/showcase/showcase-mode.js');
      const prefixes = ['/panel/read-models/approval/pending', '/radar/api/radar/health', '/monitor/api/monitor/cards',
        '/tts/api/tts/jobs/demo', '/subtitles/api/subtitles/health', '/remotion/render', '/approval/prepare',
        '/webhook/approval/pending/v2'];
      const intercepted = prefixes.map((path) => showcase.isShowcasePath(path));
      const response = async (path, options = {}, scenario = 'default') => {
        const res = await showcase.createShowcaseResponse(path, options, { scenario });
        return { status: res.status, body: await res.json() };
      };
      const health = await response('/radar/api/radar/health');
      const cards = await response('/monitor/api/monitor/cards');
      const history = await response('/radar/api/radar/jobs');
      const presence = await response('/panel/read-models/gateway/presence');
      const users = await response('/panel/admin/users');
      const connectors = await response('/panel/connectors');
      const unknown = await response('/radar/api/radar/unimplemented');
      const empty = await response('/radar/api/radar/jobs', {}, 'empty');
      const failed = await response('/monitor/api/monitor/cards', {}, 'error');
      console.log(JSON.stringify({ intercepted, health, cards, history, presence, users, connectors, unknown, empty, failed }));
    """
    result = _node(script)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert all(payload["intercepted"])
    assert payload["health"]["body"]["status"] == "ok"
    assert len(payload["cards"]["body"]["items"]) >= 1
    assert len(payload["history"]["body"]["items"]) >= 1
    assert len(payload["presence"]["body"]["sessions"]) >= 1
    assert len(payload["users"]["body"]["users"]) >= 1
    assert len(payload["connectors"]["body"]["connectors"]) == 16
    assert payload["unknown"]["status"] == 404
    assert payload["unknown"]["body"]["error"] == "not_found"
    assert payload["empty"]["body"]["items"] == []
    assert payload["failed"]["status"] == 503


def test_demo_completed_job_always_reports_full_progress():
    script = """
      import { normalizeAudioProgressPercent } from './js/modules/features/audio/runtime/services.js';
      console.log(JSON.stringify({
        doneZero: normalizeAudioProgressPercent('done', 0, 'done'),
        doneMissing: normalizeAudioProgressPercent('done', undefined, 'done'),
        queued: normalizeAudioProgressPercent('queued', 0, 'queued'),
        running: normalizeAudioProgressPercent('processing', 42, 'synthesizing'),
      }));
    """
    result = _node(script)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload == {"doneZero": 100, "doneMissing": 100, "queued": 0, "running": 42}


def test_every_data_view_has_an_empty_loading_and_error_path():
    expectations = {
        "js/modules/features/radar/render.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/connectors/render.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/admin-users/render.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/active-users/render.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/errors-audit/render.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/video-projects/render/project-list-view.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
        "js/modules/features/audio/controller/queue-renderer.js": ("renderLoadingState", "renderEmptyState"),
        "js/modules/features/subtitles/controller/render-workflow.js": ("renderLoadingState", "renderErrorState"),
        "js/modules/app-shell/runtime-renderers.js": ("renderLoadingState", "renderEmptyState", "renderErrorState"),
    }
    for relative, functions in expectations.items():
        source = _read(ROOT / relative)
        for function in functions:
            assert f"{function}(" in source, f"{relative} is missing {function}"
