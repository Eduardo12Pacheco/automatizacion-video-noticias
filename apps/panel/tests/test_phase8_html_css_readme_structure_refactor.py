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


