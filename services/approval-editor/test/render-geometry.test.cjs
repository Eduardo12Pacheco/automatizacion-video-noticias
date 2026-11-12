const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRenderReadyRowSeeds, normalizeUrlAsset } = require("../server");

test("headless create produces complete render geometry from image metadata", () => {
  const image = normalizeUrlAsset({ id: "image-1", public_url: "https://example.local/a.png", width: 1600, height: 900 }, 0, "image");
  assert.equal(image.imageWidth, 1600);
  assert.equal(image.imageHeight, 900);

  const [row] = buildRenderReadyRowSeeds([{ id: "row-1", phrase: "Hola" }], [image]);
  assert.equal(row.motion.imageWidth, 1600);
  assert.equal(row.motion.imageHeight, 900);
  assert.equal(row.motion.panViewportWidth, 1280);
  assert.equal(row.motion.panViewportHeight, 720);
  assert.equal(row.motion.fromScale, 1);
});

test("rows without image dimensions fall back to the render viewport", () => {
  const [row] = buildRenderReadyRowSeeds([{ id: "row-1", phrase: "Hola" }], [{}]);
  assert.equal(row.motion.imageWidth, 1280);
  assert.equal(row.motion.imageHeight, 720);
  assert.equal(row.motion.panViewportWidth, 1280);
  assert.equal(row.motion.panViewportHeight, 720);
});
