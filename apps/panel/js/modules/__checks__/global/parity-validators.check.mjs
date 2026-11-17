import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_ARCHIVE_PATH,
  validateDependencyBoundaries,
  validateNoLegacyArchiveRuntimeReferences,
  validateNoSiblingFeatureImports,
} from './dependency-boundary-validator.js';
import { runComputedStyleParityCheck } from './css-computed-style-parity.js';
import { evaluateRollbackPlan } from './rollback-scope-validator.js';

test('dependency boundary validator flags only the forbidden import edge', () => {
  const graph = {
    'features/approval/index.js': ['core/http/approval-api.js', 'features/scripts/index.js'],
    'features/scripts/index.js': ['core/http/approval-api.js'],
  };
  const rules = { 'features/approval/index.js': ['features/scripts/index.js'] };

  assert.deepEqual(validateDependencyBoundaries(graph, rules), {
    ok: false,
    violations: [{ from: 'features/approval/index.js', to: 'features/scripts/index.js', rule: 'features/approval/index.js -> features/scripts/index.js' }],
  });
  assert.equal(validateDependencyBoundaries({ 'features/scripts/index.js': ['core/http/approval-api.js'] }, rules).ok, true);
});

test('sibling feature imports are detected from real source text', () => {
  const clean = validateNoSiblingFeatureImports({
    'js/modules/features/radar/index.js': "import { x } from '../radar/state.js';\n",
  });
  const mutated = validateNoSiblingFeatureImports({
    'js/modules/features/radar/index.js': "import { x } from '../approval/index.js';\n",
  });

  assert.equal(clean.ok, true);
  assert.equal(mutated.ok, false);
  assert.equal(mutated.violations[0].to, '../approval/index.js');
});

test('the legacy archive must never be referenced at runtime', () => {
  assert.equal(validateNoLegacyArchiveRuntimeReferences({ 'js/main.js': "import './modules/app-shell.js';" }).ok, true);
  const violation = validateNoLegacyArchiveRuntimeReferences({ 'js/main.js': `import './${LEGACY_ARCHIVE_PATH}';` });
  assert.equal(violation.ok, false);
  assert.equal(violation.violations[0].path, 'js/main.js');
});

test('rollback scope allows checkpoint files and rejects out-of-scope edits', () => {
  const allowed = evaluateRollbackPlan({ checkpoint: 'P1', changedFiles: ['js/modules/core/http/approval-api.js'] });
  const rejected = evaluateRollbackPlan({ checkpoint: 'P1', changedFiles: ['js/modules/features/audio/index.js'] });

  assert.deepEqual(allowed.allowed, true);
  assert.deepEqual(rejected.allowed, false);
  assert.deepEqual(rejected.offendingFiles, ['js/modules/features/audio/index.js']);
});

test('the guarded selectors still match their computed style baseline', async () => {
  const result = await runComputedStyleParityCheck();

  assert.equal(result.ok, true, `computed style drift: ${JSON.stringify(result.failures)}`);
  assert.ok(Object.keys(result.baseline).length >= 8);
  assert.ok(Object.keys(result.computed).length >= 8);
});
