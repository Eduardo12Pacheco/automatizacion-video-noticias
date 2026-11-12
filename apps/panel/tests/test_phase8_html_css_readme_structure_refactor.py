import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
STYLES_ENTRY_PATH = ROOT / "styles.css"
BASE_PATH = ROOT / "styles" / "base.css"
LAYOUT_PATH = ROOT / "styles" / "layout.css"
RESPONSIVE_PATH = ROOT / "styles" / "responsive.css"
BUTTONS_PATH = ROOT / "styles" / "components" / "buttons.css"
DIALOGS_PATH = ROOT / "styles" / "components" / "dialogs.css"
CARDS_PATH = ROOT / "styles" / "components" / "cards.css"
FORMS_PATH = ROOT / "styles" / "components" / "forms.css"
TOAST_PATH = ROOT / "styles" / "components" / "toast.css"
APPROVAL_PATH = ROOT / "styles" / "features" / "approval.css"
SCRIPTS_PATH = ROOT / "styles" / "features" / "scripts.css"
AUDIO_PATH = ROOT / "styles" / "features" / "audio.css"
SUBTITLES_PATH = ROOT / "styles" / "features" / "subtitles" / "legacy-base.css"
AUTH_PATH = ROOT / "styles" / "features" / "auth.css"
README_PATH = ROOT / "README.md"
ROOT_GITIGNORE_PATH = ROOT.parents[1] / ".gitignore"
CONTROL_PANEL_GITIGNORE_PATH = ROOT / ".gitignore"
VIDEO_PROJECTS_README_PATH = ROOT / "js" / "modules" / "features" / "video-projects" / "README.md"
VIDEO_PROJECTS_PLAN_PATH = ROOT / "docs" / "video-projects-refactor-plan.md"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_index_html_adds_readability_block_delimiters_without_contract_drift():
    source = _read(INDEX_PATH)
    for required_comment in [
        "<!-- Slice A: Auth gate -->",
        "<!-- Slice A: App shell -->",
        "<!-- Slice A: Main views -->",
        "<!-- Slice A: Dialogs -->",
    ]:
        assert required_comment in source

    for selector_id in [
        "authGate",
        "appShell",
        "authForm",
        "sidebarNav",
        "viewApproval",
        "viewScripts",
        "viewAudio",
        "viewSubtitulos2",
        "viewAdminUsers",
        "settingsDialog",
    ]:
        assert f'id="{selector_id}"' in source


def test_index_html_keeps_bootstrap_boundary_script_reference():
    source = _read(INDEX_PATH)
    assert '<script src="./js/main.js" type="module"></script>' in source


def test_styles_entry_order_stays_locked_while_rules_move_to_layer_files():
    lines = [line.strip() for line in _read(STYLES_ENTRY_PATH).splitlines() if line.strip()]
    assert lines == [
        "@import './styles/tokens.css';",
        "@import './styles/base.css';",
        "@import './styles/layout.css';",
        "@import './styles/components/buttons.css';",
        "@import './styles/components/dialogs.css';",
        "@import './styles/components/cards.css';",
        "@import './styles/components/forms.css';",
        "@import './styles/components/toast.css';",
        "@import './styles/features/approval.css';",
        "@import './styles/features/scripts.css';",
        "@import './styles/features/video-projects/index.css';",
        "@import './styles/features/audio.css';",
        "@import './styles/features/radar.css';",
        "@import './styles/features/subtitles/index.css';",
        "@import './styles/features/auth.css';",
        "@import './styles/responsive.css';",
        "@import './styles/components/scrollbars.css';",
    ]


def test_css_redistribution_moves_guarded_selectors_out_of_base_css():
    base = _read(BASE_PATH)
    assert ".sidebar {" not in base
    assert "@media (max-width: 859px)" not in base
    assert ".card {" not in base
    assert ".audio-queue-card {" not in base
    assert ".subtitle-phase-bar {" not in base
    assert ".auth-gate {" not in base

    assert ".sidebar {" in _read(LAYOUT_PATH)
    assert "@media (max-width: 859px)" in _read(RESPONSIVE_PATH)
    assert ".card {" in _read(CARDS_PATH)
    assert ".audio-queue-card {" in _read(AUDIO_PATH)
    assert ".subtitle-phase-bar {" in _read(SUBTITLES_PATH)
    assert ".auth-gate {" in _read(AUTH_PATH)


def test_css_component_layers_receive_expected_rules():
    assert "button.approve" in _read(BUTTONS_PATH)
    assert "dialog::backdrop" in _read(DIALOGS_PATH)
    assert ".script-area" in _read(FORMS_PATH)
    assert ".toast:popover-open" in _read(TOAST_PATH)
    assert ".queue-list" in _read(APPROVAL_PATH)
    assert "#scriptEditorDialog" not in _read(SCRIPTS_PATH)


def test_readme_documents_architecture_guardrails_and_slice_workflow_in_spanish():
    source = _read(README_PATH)
    for expected_section in [
        "# Approval Panel Web",
        "## Arquitectura",
        "## Mapa de carpetas",
        "## Guardrails de paridad",
        "## Workflow seguro por slices",
    ]:
        assert expected_section in source

    assert "sin cambios de features, API ni UX" in source


def test_readme_does_not_claim_new_capabilities_for_this_change_set():
    source = _read(README_PATH)
    assert "Próximas mejoras sugeridas" not in source


def test_readme_documents_current_docs_hygiene_paths_and_no_build_validation():
    source = _read(README_PATH)
    for expected in [
        "assets/",
        "services/approval-editor/",
        "services/approval-editor/projects/",
        "video-projects/controller/*",
        "video-projects/__checks__/*",
        "fachadas de compatibilidad",
        "pytest tests/test_phase8_html_css_readme_structure_refactor.py",
        "No correr builds",
    ]:
        assert expected in source

    assert "servicio local activo" in source


def test_video_projects_module_readme_maps_controller_checks_and_split_clients():
    source = _read(VIDEO_PROJECTS_README_PATH)
    for expected in [
        "controller/",
        "__checks__/",
        "data/video-projects-client.js",
        "data/remotion-client.js",
        "data/approval-pipeline-client.js",
        "composition/renderer/",
        "domain/image-files.js",
    ]:
        assert expected in source

    assert "Compatibility facades remain at root" in source


def test_video_projects_refactor_plan_is_marked_historical_before_old_plan_details():
    source = _read(VIDEO_PROJECTS_PLAN_PATH)
    historical_note = "## Historical status"
    assert historical_note in source
    assert source.index(historical_note) < source.index("## Goal")
    assert "partially completed" in source
    assert "js/modules/features/video-projects/README.md" in source


def test_control_panel_and_workspace_ignores_protect_runtime_and_python_caches():
    control_panel_ignore = _read(CONTROL_PANEL_GITIGNORE_PATH)
    root_ignore = _read(ROOT_GITIGNORE_PATH)

    for expected in [
        "services/approval-editor/projects/",
        "__pycache__/",
        "*.py[cod]",
        ".pytest_cache/",
    ]:
        assert expected in control_panel_ignore

    for expected in [
        "services/approval-editor/projects/",
        "__pycache__/",
        "*.py[cod]",
        ".pytest_cache/",
    ]:
        assert expected in root_ignore


def test_settings_are_server_managed_and_expose_no_worker_or_api_origin_inputs():
    source = _read(INDEX_PATH)
    for removed_selector_id in [
        "apiProfileModeSelect",
        "apiOriginInput",
        "advancedSettingsSection",
        "approvalPipelineBaseUrlInput",
        "baseUrlInput",
        "secretInput",
        "ttsBaseUrlInput",
        "subtitlesBaseUrlInput",
        "transcriptServiceBaseUrlInput",
        "remotionApiUrlInput",
        "channelMonitorBaseUrlInput",
    ]:
        assert f'id="{removed_selector_id}"' not in source

    visible_settings = source.split('<div class="settings-form">', 1)[1].split('<footer class="dialog-actions">', 1)[0]
    assert "Endpoint del proyecto" not in visible_settings
    assert "Las API keys y Basic Auth ya no se configuran en el navegador" in visible_settings
    assert "API Gateway" in visible_settings
    assert 'id="openConnectorsBtn"' in visible_settings
    assert 'id="languageSelect"' in visible_settings
    assert 'id="themeSelect"' in visible_settings
    assert visible_settings.count('<section class="settings-section"') == 4
    for section in ("Configuración del proyecto", "Conectores", "Idioma", "Tema"):
        assert section in visible_settings


def test_approval_pipeline_unhealthy_service_still_falls_back_to_remotion():
    script = r"""
import { prepareVideoCompositionContract } from './js/modules/features/video-projects/contract-pipeline-client.js';

const api = {
  createApprovalPipelineClient() {
    return {
      async health() {
        return { ok: false, status: 'degraded' };
      },
    };
  },
  createRemotionClient() {
    return {
      async createFromApproval() {
        return {
          alignmentStatus: { status: 'ready' },
          projectId: 'remotion-123',
          snapshot: { project: { rows: [{ id: 'row-1', phrase: 'fallback', startTime: 0, endTime: 2 }] } },
        };
      },
      async status() {
        return { project: { rows: [{ id: 'row-1', phrase: 'fallback', startTime: 0, endTime: 2 }] } };
      },
    };
  },
};

const result = await prepareVideoCompositionContract({
  project: {
    draft_id: 'draft-1',
    title: 'Proyecto de fallback',
    guion_piped: 'una|dos',
    selected_images: [],
    voice_audio: { public_url: 'https://cdn.example.com/voice.mp3' },
    background_audio: { public_url: 'https://cdn.example.com/music.mp3' },
  },
  settings: { remotionApiUrl: 'https://remotion.local', approvalPipelineBaseUrl: 'https://approval.local' },
  api,
});

if (result.provider !== 'remotion') {
  throw new Error(`expected remotion fallback, got ${result.provider}`);
}
if (result.providerMetadata?.fallbackFrom !== 'approval') {
  throw new Error('expected fallback metadata to preserve approval origin');
}
if (result.providerMetadata?.health?.ok !== false) {
  throw new Error('expected unhealthy approval health to be preserved in metadata');
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_approval_pipeline_create_network_failure_surfaces_in_flight_guidance():
    script = r"""
import { prepareVideoCompositionContract } from './js/modules/features/video-projects/contract-pipeline-client.js';

const calls = [];
const api = {
  createApprovalPipelineClient() {
    return {
      async health() {
        calls.push('approval-health');
        return { ok: true, status: 'ready' };
      },
      async createFromApproval() {
        calls.push('approval-create');
        throw new Error('No se pudo conectar con Approval Pipeline. Failed to fetch');
      },
    };
  },
  createRemotionClient() {
    return {
      async createFromApproval() {
        calls.push('remotion-create');
        return {
          alignmentStatus: { status: 'ready' },
          projectId: 'remotion-123',
          snapshot: { project: { rows: [{ id: 'row-1', phrase: 'fallback', startTime: 0, endTime: 2 }] } },
        };
      },
      async status() {
        calls.push('remotion-status');
        return { project: { rows: [{ id: 'row-1', phrase: 'fallback', startTime: 0, endTime: 2 }] } };
      },
    };
  },
};

let error = null;
try {
  await prepareVideoCompositionContract({
    project: {
      draft_id: 'draft-1',
      title: 'Proyecto en curso',
      guion_piped: 'una|dos',
      selected_images: [],
      voice_audio: { public_url: 'https://cdn.example.com/voice.mp3' },
      background_audio: { public_url: 'https://cdn.example.com/music.mp3' },
    },
    settings: { remotionApiUrl: 'https://remotion.local', approvalPipelineBaseUrl: 'https://approval.local' },
    api,
  });
} catch (caught) {
  error = caught;
}

if (!error || error.code !== 'approval_prepare_maybe_in_flight') {
  throw new Error(`expected in-flight guidance, got ${error?.code || error?.message || 'no error'}`);
}
if (calls.includes('remotion-create') || calls.includes('remotion-status')) {
  throw new Error('a possibly in-flight approval preparation must not be duplicated on Remotion');
}
for (const expected of ['approval-health', 'approval-create']) {
  if (!calls.includes(expected)) throw new Error(`missing call ${expected}`);
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_approval_pipeline_defaults_to_the_api_route_derived_from_the_origin():
    script = r"""
import { defaultSettingsFactory, resolveServiceConfig } from './js/modules/core/state/app-store.js';

const defaults = defaultSettingsFactory();
const resolved = resolveServiceConfig(defaults, 'approvalPipeline');
const expected = `${defaults.apiOrigin.replace(/\/+$/, '')}/approval`;
if (resolved.baseUrl !== expected) throw new Error(`approval default drift: ${resolved.baseUrl} !== ${expected}`);

const explicit = resolveServiceConfig({ ...defaults, apiOrigin: 'https://panel.example.test', approvalRoutePrefix: 'approval' }, 'approvalPipeline');
if (explicit.baseUrl !== 'https://panel.example.test/approval') throw new Error(`approval origin drift: ${explicit.baseUrl}`);
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_styles_entry_order_reflects_current_feature_layer_stack():
    lines = [line.strip() for line in _read(STYLES_ENTRY_PATH).splitlines() if line.strip()]
    assert lines == [
        "@import './styles/tokens.css';",
        "@import './styles/base.css';",
        "@import './styles/layout.css';",
        "@import './styles/components/buttons.css';",
        "@import './styles/components/dialogs.css';",
        "@import './styles/components/cards.css';",
        "@import './styles/components/forms.css';",
        "@import './styles/components/toast.css';",
        "@import './styles/features/approval.css';",
        "@import './styles/features/scripts.css';",
        "@import './styles/features/video-projects/index.css';",
        "@import './styles/features/audio.css';",
        "@import './styles/features/radar.css';",
        "@import './styles/features/subtitles/index.css';",
        "@import './styles/features/auth.css';",
        "@import './styles/responsive.css';",
        "@import './styles/components/scrollbars.css';",
    ]
