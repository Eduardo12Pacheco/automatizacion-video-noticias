import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML_PATH = ROOT / "index.html"
RADAR_TEMPLATE_PATH = ROOT / "js" / "modules" / "app-shell" / "views" / "templates" / "radar-view.js"
APP_SHELL_PATH = ROOT / "js" / "modules" / "app-shell.js"
BOOTSTRAP_PATH = ROOT / "js" / "modules" / "core" / "bootstrap.js"
SELECTORS_PATH = ROOT / "js" / "modules" / "shared" / "dom" / "selectors.js"
APP_STORE_PATH = ROOT / "js" / "modules" / "core" / "state" / "app-store.js"
RADAR_CHECK_PATH = ROOT / "js" / "modules" / "features" / "radar" / "__checks__" / "radar-panel-check.js"
RADAR_CSS_PATH = ROOT / "styles" / "features" / "radar.css"


def _run_node_file(path: Path):
    return subprocess.run(
        ["node", str(path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_ai_rescue_is_not_exposed_as_a_shell_view():
    index_source = INDEX_HTML_PATH.read_text(encoding="utf-8")
    script = r"""
import { normalizeShellView } from './js/modules/app-shell/navigation.js';

if (normalizeShellView('ai-rescue') !== 'approval') {
  throw new Error('AI Rescue must normalize to the safe default view');
}
"""
    result = _run_node(script)

    assert 'data-view="ai-rescue"' not in index_source
    assert 'Prensa IA' not in index_source
    assert result.returncode == 0, result.stderr


def test_radar_gateway_requests_include_session_credentials():
    script = r"""
import { createRadarApiClient } from './js/modules/features/radar/api-client.js';

const settings = {
  apiProfileMode: 'unified',
  apiOrigin: 'https://api.example.test',
  sharedApiKey: '',
  serviceOverrides: { radar: false, monitor: false },
  transcriptServiceBaseUrl: 'https://direct-radar.example.test',
  channelMonitorBaseUrl: 'https://direct-monitor.example.test',
};
const calls = [];
const fetchImpl = async (url, options = {}) => {
  calls.push({ url, options });
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, items: [] }) };
};

const radar = createRadarApiClient({ getSettings: () => settings, fetchImpl, locationLike: { hostname: 'panel.example.local' } });
await radar.monitorCards();
await radar.health();


for (const call of calls) {
  if (call.options.credentials !== 'include') {
    throw new Error(`missing session credentials for ${call.url}: ${JSON.stringify(call.options)}`);
  }
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


