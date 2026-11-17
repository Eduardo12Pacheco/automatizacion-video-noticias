import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveZoomRange } from '../composition/renderer/frame-math.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererRoot = resolve(currentDir, '../../../../../../../services/renderer');

const require = createRequire(import.meta.url);
const rendererTiming = require(resolve(rendererRoot, 'src/remotion/composition-timing.js'));

function previewRange(motion) {
  const range = resolveZoomRange(motion);
  return { fromScale: range.from, toScale: range.to, fromX: range.fromX, fromY: range.fromY, toX: range.toX, toY: range.toY };
}

test('Remotion motion presets keep string parity with the panel preview', () => {
  const rendererRange = rendererTiming.resolveMotionRange;
  for (const preset of ['still', 'none', 'slow-zoom', 'slow-zoom-in', 'slow-zoom-out', 'pan-left', 'pan-right', 'unknown-motion']) {
    assert.deepEqual(rendererRange(preset), previewRange(preset), `preset drift for ${preset}`);
  }
});

test('the editorial newspaper label keeps its preview and render sizes', () => {
  const previewSource = readFileSync(resolve(currentDir, '../composition/renderer/frame-math.js'), 'utf8');
  const rendererSource = readFileSync(resolve(rendererRoot, 'src/remotion/newspaper-scene.tsx'), 'utf8');
  assert.match(previewSource, /const NEWSPAPER_LABEL_FONT_SIZE = 18/);
  assert.equal(rendererTiming.NEWSPAPER_LABEL_FONT_SIZE, 40);
  assert.doesNotMatch(rendererSource, /const NEWSPAPER_LABEL_FONT_SIZE/);
});
