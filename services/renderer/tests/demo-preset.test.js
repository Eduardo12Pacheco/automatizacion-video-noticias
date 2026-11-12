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

test("local preset renders 720p on CPU for the local product mode", () => {
  const preset = resolveRenderPreset("local");
  assert.equal(preset.width, 1280);
  assert.equal(preset.height, 720);
  assert.equal(preset.fps, 30);
  assert.equal(preset.hardwareAcceleration, "disable");
  assert.equal(preset.concurrency, 1);
  assert.equal(resolveRenderProfile("local"), "local");
});

test("presets only expose the documented profiles", () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), ["demo", "final", "local", "preview"]);
});

test("render CLI dry-run uses the demo resolution and CPU switches", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const { createEditorProject } = require("../scripts/lib/projects/editor-project");
  const repoRoot = path.resolve(__dirname, "..");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=",
    "base64",
  );
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-demo-preset-"));
  for (const dir of ["guion", "imagenes", "audio", "output"]) {
    fs.mkdirSync(path.join(projectRoot, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(projectRoot, "guion", "guion.txt"), "Intro|Cierre\n");
  fs.writeFileSync(path.join(projectRoot, "imagenes", "intro.jpg"), png);
  fs.writeFileSync(path.join(projectRoot, "imagenes", "cierre.jpg"), png);
  fs.writeFileSync(path.join(projectRoot, "audio", "audio-48khz.wav"), "RIFF");
  fs.writeFileSync(path.join(projectRoot, "audio", "music.wav"), "RIFF");
  fs.writeFileSync(
    path.join(projectRoot, "project.json"),
    JSON.stringify({
      id: "demo",
      title: "Demo",
      schemaVersion: 1,
      phase: "editing",
      paths: {
        projectRoot,
        script: "guion/guion.txt",
        editorProject: "editor-project.json",
        output: "output",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const project = createEditorProject(projectRoot, { projectId: "demo", title: "Demo", seedMedia: true });
  fs.writeFileSync(path.join(projectRoot, "editor-project.json"), JSON.stringify(project, null, 2));

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "render-video.js"), `--project-root=${projectRoot}`, "--profile=demo", "--dry-run"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /--width=640/);
  assert.match(result.stdout, /--height=360/);
  assert.match(result.stdout, /--frames-per-second=24/);
  assert.match(result.stdout, /--hardware-acceleration=disable/);
  assert.match(result.stdout, /video-demo\.mp4/);
});
