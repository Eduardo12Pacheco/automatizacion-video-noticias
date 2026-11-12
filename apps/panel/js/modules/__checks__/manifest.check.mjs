import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_MANIFEST, validateCheckManifestCoverage } from './manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_ROOT = path.resolve(__dirname, '..');

test('check manifest accounts for every check implementation exactly once', async () => {
  const result = validateCheckManifestCoverage(CHECK_MANIFEST);
  const pathCount = new Set(CHECK_MANIFEST.map((entry) => entry.path)).size;

  assert.deepEqual(result.failures, [], `manifest coverage failures: ${result.failures.join('; ')}`);
  assert.equal(result.summary.total, CHECK_MANIFEST.length, 'current __checks__ inventory must stay fully accounted for');
  assert.equal(result.summary.paths, pathCount, 'every check path must be listed once');
});

test('check manifest paths resolve and expose ownership metadata', async () => {
  assert.ok(CHECK_MANIFEST.some((entry) => entry.owner === 'global' && entry.path.includes('/global/')), 'global checks must live under their global implementations');
  assert.ok(CHECK_MANIFEST.some((entry) => entry.owner === 'video-projects' && entry.exportedHelpers.includes('runEditorAssetsTabCheck')), 'feature helper exports must remain inventoried');

  for (const entry of CHECK_MANIFEST) {
    assert.ok(entry.path.startsWith('js/modules/'), `${entry.path} must live under js/modules`);
    assert.ok(entry.owner, `${entry.path} must declare an owner`);
    assert.ok(entry.commandKind, `${entry.path} must declare how it is executed`);
    await access(path.join(MODULES_ROOT, entry.path.replace('js/modules/', '')));
  }
});

test('feature-owned checks live beside their feature instead of a duplicated root copy', () => {
  for (const entry of CHECK_MANIFEST) {
    if (entry.owner === 'global') {
      continue;
    }
    assert.ok(entry.path.includes('/__checks__/'), `${entry.path} must live in an owner __checks__ folder`);
    assert.ok(!entry.path.startsWith('js/modules/__checks__/'), `${entry.path} must not duplicate a root facade`);
  }
});

test('assertion inventory reads the owner implementation source', async () => {
  const assertionTokens = new Map([
    ['js/modules/features/audio/__checks__/audio-seams.check.mjs', 'Audio endpoint contract'],
    ['js/modules/app-shell/__checks__/app-shell-seams.check.mjs', 'app-shell lifecycle replay preserves public boot'],
    ['js/modules/features/subtitles/__checks__/subtitles-controller-seams.check.mjs', 'subtitles public facades keep stable exports'],
    ['js/modules/features/radar/__checks__/radar-panel-check.js', 'monitor cards payload drift'],
    ['js/modules/features/video-projects/__checks__/video-projects-composition-payload.check.mjs', 'buildCompositionPayloadForCheck'],
  ]);

  for (const [implementationPath, token] of assertionTokens) {
    const source = await readFile(path.join(MODULES_ROOT, implementationPath.replace('js/modules/', '')), 'utf8');
    assert.ok(source.includes(token), `${implementationPath} must preserve assertion token ${token}`);
  }
});
