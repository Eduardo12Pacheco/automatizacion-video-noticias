const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveCoverPanLayer } = require("../src/cover-pan-layer.js");

test("resolveCoverPanLayer sizes the source image as a real cover layer", () => {
  const layer = resolveCoverPanLayer({
    viewportWidth: 1920,
    viewportHeight: 1080,
    imageWidth: 1000,
    imageHeight: 1000,
    scale: 1,
    x: 0,
    y: 0,
  });

  assert.deepEqual(layer, {
    coverScale: 1.92,
    baseWidth: 1920,
    baseHeight: 1920,
    layerWidth: 1920,
    layerHeight: 1920,
    maxX: 0,
    maxY: 420,
    clampedX: 0,
    clampedY: 0,
    left: 0,
    top: -420,
  });
});

test("resolveCoverPanLayer clamps pan offsets to available overflow", () => {
  const layer = resolveCoverPanLayer({
    viewportWidth: 1920,
    viewportHeight: 1080,
    imageWidth: 4000,
    imageHeight: 2000,
    scale: 1.2,
    x: 999,
    y: -999,
  });

  assert.equal(layer.layerWidth, 2592);
  assert.equal(layer.layerHeight, 1296);
  assert.equal(layer.maxX, 336);
  assert.equal(layer.maxY, 108);
  assert.equal(layer.clampedX, 336);
  assert.equal(layer.clampedY, -108);
  assert.equal(layer.left, 0);
  assert.equal(layer.top, -216);
});
