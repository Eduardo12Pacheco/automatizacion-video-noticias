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
    baseLeft: 0,
    baseTop: -420,
    layerWidth: 1920,
    layerHeight: 1920,
    maxX: 0,
    maxY: 420,
    appliedX: 0,
    appliedY: 0,
    left: 0,
    top: -420,
    transformX: 0,
    transformY: 0,
    transformScale: 1,
  });
});

test("resolveCoverPanLayer applies manual pan offsets without clamping to match browser preview", () => {
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
  assert.equal(layer.appliedX, 999);
  assert.equal(layer.appliedY, -999);
  assert.equal(layer.left, 663);
  assert.equal(layer.top, -1107);
  assert.equal(layer.transformX, 999);
  assert.equal(layer.transformY, -999);
});

test("resolveCoverPanLayer uses non-16:9 image dimensions for preview-equivalent vertical headroom", () => {
  const layer = resolveCoverPanLayer({
    viewportWidth: 1920,
    viewportHeight: 1080,
    imageWidth: 2400,
    imageHeight: 3200,
    scale: 1.1,
    x: 0,
    y: 260,
  });

  assert.equal(layer.coverScale, 0.8);
  assert.equal(layer.baseWidth, 1920);
  assert.equal(layer.baseHeight, 2560);
  assert.equal(layer.baseTop, -740);
  assert.equal(layer.layerHeight, 2816);
  assert.equal(layer.maxY, 868);
  assert.equal(layer.appliedY, 260);
  assert.equal(layer.top, -608);
  assert.equal(layer.transformY, 260);
  assert.equal(layer.transformScale, 1.1);
});

test("resolveCoverPanLayer scales manual pan from the preview viewport to the final render viewport", () => {
  const previewLayer = resolveCoverPanLayer({
    viewportWidth: 950.53125,
    viewportHeight: 533.796875,
    imageWidth: 951,
    imageHeight: 1171,
    scale: 1,
    x: 0,
    y: 267,
  });
  const finalLayer = resolveCoverPanLayer({
    viewportWidth: 1920,
    viewportHeight: 1080,
    panViewportWidth: 950.53125,
    panViewportHeight: 533.796875,
    imageWidth: 951,
    imageHeight: 1171,
    scale: 1,
    x: 0,
    y: 267,
  });
  const viewportScale = 1920 / 950.53125;

  assert.equal(Number(finalLayer.transformY.toFixed(6)), Number((267 * viewportScale).toFixed(6)));
  assert.ok(Math.abs(finalLayer.top - (previewLayer.top * viewportScale)) < 1, "final crop should keep the same scaled headroom as the browser preview");
  assert.ok(finalLayer.top > -150, "final crop should keep the head near the top instead of leaving the player-centered crop");
});
