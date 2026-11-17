from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
STYLE_GUARDS_PATH = ROOT / "docs" / "parity" / "style-guards.md"
STYLE_ENTRY_PATH = ROOT / "styles.css"
CONTRACT_MATRIX_PATH = ROOT / "docs" / "parity" / "contract-matrix.md"
APP_SHELL_PATH = ROOT / "js" / "modules" / "app-shell.js"


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

STYLE_FILES = [
    ROOT / "styles" / "tokens.css",
    ROOT / "styles" / "base.css",
    ROOT / "styles" / "layout.css",
    ROOT / "styles" / "components" / "buttons.css",
    ROOT / "styles" / "components" / "dialogs.css",
    ROOT / "styles" / "components" / "cards.css",
    ROOT / "styles" / "components" / "forms.css",
    ROOT / "styles" / "components" / "toast.css",
    ROOT / "styles" / "features" / "approval.css",
    ROOT / "styles" / "features" / "scripts.css",
    ROOT / "styles" / "features" / "video-projects" / "index.css",
    ROOT / "styles" / "features" / "audio.css",
    ROOT / "styles" / "features" / "subtitles" / "index.css",
    ROOT / "styles" / "features" / "auth.css",
    ROOT / "styles" / "responsive.css",
]


def test_executable_computed_style_parity_evidence_exists_for_guarded_selectors():
    script = r"""
import { runComputedStyleParityCheck } from './js/modules/__checks__/global/css-computed-style-parity.js';

const result = await runComputedStyleParityCheck();
if (!result.ok) {
  throw new Error(`computed-style parity failed: ${JSON.stringify(result.failures)}`);
}
if (!result.baseline || !result.computed) {
  throw new Error('computed-style parity result shape drift');
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_computed_style_parity_snapshot_covers_multiple_guarded_selectors():
    script = r"""
import { runComputedStyleParityCheck } from './js/modules/__checks__/global/css-computed-style-parity.js';

const result = await runComputedStyleParityCheck();
if (!result.ok) {
  throw new Error(`computed-style parity failed: ${JSON.stringify(result.failures)}`);
}

const sidebar = result.computed['.sidebar'] || {};
const card = result.computed['.card'] || {};
const phaseBar = result.computed['.subtitle-phase-bar'] || {};
const videoProjectsLayout = result.computed['.video-projects-layout'] || {};
const videoProjectCard = result.computed['.video-project-card'] || {};
const compositionStage = result.computed['.composition-stage'] || {};

if (sidebar.position !== 'fixed') throw new Error('sidebar position computed-style drift');
if (sidebar.width !== 'var(--sidebar-collapsed)') throw new Error('sidebar width computed-style drift');
if (card.display !== 'flex') throw new Error('card display computed-style drift');
if (phaseBar.display !== 'grid') throw new Error('subtitle phase bar display computed-style drift');
if (videoProjectsLayout.display !== 'grid') throw new Error('video projects layout display drift');
if (videoProjectCard.display !== 'grid') throw new Error('video project card display drift');
if (compositionStage.position !== 'relative') throw new Error('composition stage position drift');
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr
