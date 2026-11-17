"""Screens & states contract.

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


