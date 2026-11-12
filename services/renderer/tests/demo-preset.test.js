const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRESETS,
  buildPresetArgs,
  resolveRenderPreset,
  resolveRenderProfile,
} = require("../scripts/render/render-presets");

test("render profiles resolve known names and fall back to final", () => {
  assert.equal(resolveRenderProfile("demo"), "demo");
  assert.equal(resolveRenderProfile("PREVIEW"), "preview");
  assert.equal(resolveRenderProfile("unknown"), "final");
  assert.equal(resolveRenderProfile(undefined), "final");
});

test("demo preset is a CPU-only low-resolution render", () => {
  const preset = resolveRenderPreset("demo");
  assert.equal(preset.name, "demo");
  assert.equal(preset.width, 640);
  assert.equal(preset.height, 360);
  assert.equal(preset.fps, 24);
  assert.equal(preset.hardwareAcceleration, "disable");
  assert.equal(preset.gl, "swangle");
  assert.equal(preset.concurrency, 1);
});

test("preset arguments carry the profile resolution and CPU switches", () => {
  assert.deepEqual(buildPresetArgs("demo"), [
    "--codec=h264",
    "--frames-per-second=24",
    "--width=640",
    "--height=360",
    "--hardware-acceleration=disable",
    "--gl=swangle",
    "--concurrency=1",
    "--crf=30",
  ]);
  assert.equal(buildPresetArgs("final").includes("--width=1920"), true);
  assert.equal(buildPresetArgs("preview").includes("--width=1280"), true);
  assert.equal(buildPresetArgs("final").some((arg) => arg.startsWith("--concurrency")), false);
});

test("presets only expose the documented profiles", () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ["demo", "final", "preview"]);
});
