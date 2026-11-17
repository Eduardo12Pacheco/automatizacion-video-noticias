import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_SHELL_PATH = ROOT / "js" / "modules" / "app-shell.js"
PARITY_CHECKLIST_PATH = ROOT / "js" / "modules" / "__checks__" / "parity-checklist.js"
DEPENDENCY_VALIDATOR_PATH = ROOT / "js" / "modules" / "__checks__" / "dependency-boundary-validator.js"
ROLLBACK_VALIDATOR_PATH = ROOT / "js" / "modules" / "__checks__" / "rollback-scope-validator.js"
SUBTITLES_RUNTIME_DIR = ROOT / "js" / "modules" / "features" / "subtitles" / "runtime"
AUDIO_RUNTIME_DIR = ROOT / "js" / "modules" / "features" / "audio" / "runtime"
ROOT_APP_JS_PATH = ROOT / "app.js"
LEGACY_APP_JS_PATH = ROOT / "js" / "legacy" / "app.js"
MAIN_JS_PATH = ROOT / "js" / "main.js"
INDEX_HTML_PATH = ROOT / "index.html"
COMPOSITION_ROOT_PATH = ROOT / "js" / "modules" / "composition-root.js"
CONTRACT_MATRIX_PATH = ROOT / "docs" / "parity" / "contract-matrix.md"
STYLE_GUARDS_PATH = ROOT / "docs" / "parity" / "style-guards.md"


def _run_node(script: str):
    return subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def _read_check_implementation_source(implementation_path: str) -> str:
    script = r"""
import { readFile } from 'node:fs/promises';
import { CHECK_MANIFEST } from './js/modules/__checks__/manifest.js';

const implementationPath = process.argv[1];
const entry = CHECK_MANIFEST.find((candidate) => candidate.path === implementationPath);
if (!entry) throw new Error(`missing check manifest entry for ${implementationPath}`);
process.stdout.write(await readFile(entry.path, 'utf8'));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, implementation_path],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_dependency_boundary_validator_enforces_archive_non_runtime_reference_rule():
    script = r"""
import {
  validateNoLegacyArchiveRuntimeReferences,
  LEGACY_ARCHIVE_PATH,
} from './js/modules/__checks__/global/dependency-boundary-validator.js';

const clean = validateNoLegacyArchiveRuntimeReferences({
  'js/modules/app-shell.js': "import { x } from './features/audio/index.js';",
  'index.html': '<script src="./js/main.js" type="module"></script>',
});

if (!clean.ok) {
  throw new Error(`expected clean references, got ${JSON.stringify(clean.violations)}`);
}

const bad = validateNoLegacyArchiveRuntimeReferences({
  'js/modules/app-shell.js': "import '../legacy/app.js';",
  'index.html': '<script src="./js/legacy/app.js"></script>',
});

if (bad.ok) {
  throw new Error('expected archive runtime reference violation');
}

if (!bad.violations.some((row) => row.path === 'js/modules/app-shell.js')) {
  throw new Error('missing app-shell violation evidence');
}

if (!String(LEGACY_ARCHIVE_PATH).includes('js/legacy/app.js')) {
  throw new Error('legacy archive path constant drift');
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_rollback_scope_validator_supports_s1_s2_s3_s4_slice_boundaries():
    script = r"""
import { evaluateRollbackPlan } from './js/modules/__checks__/global/rollback-scope-validator.js';

const s1 = evaluateRollbackPlan({
  checkpoint: 'S1',
  changedFiles: [
    'js/modules/features/subtitles/runtime/index.js',
    'js/modules/features/subtitles/index.js',
    'js/modules/app-shell.js',
  ],
});
if (!s1.allowed) {
  throw new Error(`S1 should be allowed: ${JSON.stringify(s1.offendingFiles)}`);
}

const s4 = evaluateRollbackPlan({
  checkpoint: 'S4',
  changedFiles: [
    'js/legacy/app.js',
    'docs/parity/contract-matrix.md',
    'docs/parity/style-guards.md',
    'js/modules/__checks__/global/dependency-boundary-validator.js',
  ],
});
if (!s4.allowed) {
  throw new Error(`S4 should be allowed: ${JSON.stringify(s4.offendingFiles)}`);
}

const blocked = evaluateRollbackPlan({
  checkpoint: 'S4',
  changedFiles: ['js/main.js'],
});
if (blocked.allowed || !blocked.offendingFiles.includes('js/main.js')) {
  throw new Error('expected S4 to block non-archive rollback file drift');
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr


def test_legacy_app_js_is_removed_after_archive_retirement():
    assert not ROOT_APP_JS_PATH.exists(), "Root apps/panel/app.js must stay removed"
    assert not LEGACY_APP_JS_PATH.exists(), "Archived js/legacy/app.js must stay deleted"


def test_s4_archival_rollback_simulation_moves_legacy_app_back_in_isolation_and_restores_state():
    script = r"""
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simulateS4ArchivalRollback } from './js/modules/__checks__/global/rollback-scope-validator.js';

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'approval-panel-s4-'));
try {
  const jsLegacyDir = path.join(sandbox, 'js', 'legacy');
  await mkdir(jsLegacyDir, { recursive: true });

  const legacyPath = path.join(jsLegacyDir, 'app.js');
  const rootPath = path.join(sandbox, 'app.js');
  const marker = '/* LEGACY ARCHIVE - non-runtime */\nconst x = 1;\n';
  await writeFile(legacyPath, marker, 'utf8');

  const result = await simulateS4ArchivalRollback({
    projectRoot: sandbox,
  });

  if (!result.ok) {
    throw new Error(`rollback simulation failed: ${JSON.stringify(result)}`);
  }

  const rootContent = await readFile(rootPath, 'utf8');
  if (rootContent !== marker) {
    throw new Error('root app.js content drift after rollback simulation');
  }

  let legacyStillExists = true;
  try {
    await access(legacyPath);
  } catch {
    legacyStillExists = false;
  }

  if (legacyStillExists) {
    throw new Error('legacy app.js should be moved out during rollback simulation');
  }

  const undo = await simulateS4ArchivalRollback({
    projectRoot: sandbox,
    direction: 'archive',
  });

  if (!undo.ok) {
    throw new Error(`archive simulation failed: ${JSON.stringify(undo)}`);
  }

  const legacyAgain = await readFile(legacyPath, 'utf8');
  if (legacyAgain !== marker) {
    throw new Error('legacy app.js content drift after archive simulation');
  }
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
"""
    result = _run_node(script)
    assert result.returncode == 0, result.stderr
