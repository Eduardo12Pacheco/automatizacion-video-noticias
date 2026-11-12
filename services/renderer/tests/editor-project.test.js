const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEditorProject, validateEditorProject } = require("../scripts/lib/projects/editor-project");

const pngPixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";

function silentWav() {
  const buffer = Buffer.alloc(48);
  buffer.write("RIFF", 0, 4, "ascii");
  buffer.write("WAVE", 8, 4, "ascii");
  return buffer;
}

function makeProjectRoot(id = "clean-demo") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `remotion-editor-${id}-`));
  fs.mkdirSync(path.join(projectRoot, "guion"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "imagenes"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "audio"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "output"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "guion", "guion.txt"), "Intro clean|Cierre clean\n");
  fs.writeFileSync(path.join(projectRoot, "imagenes", "intro.jpg"), Buffer.from(pngPixelBase64, "base64"));
  fs.writeFileSync(path.join(projectRoot, "imagenes", "cierre.jpg"), Buffer.from(pngPixelBase64, "base64"));
  fs.writeFileSync(path.join(projectRoot, "audio", "audio-48khz.wav"), silentWav());
  fs.writeFileSync(path.join(projectRoot, "audio", "music.wav"), silentWav());
  fs.writeFileSync(path.join(projectRoot, "project.json"), JSON.stringify({ id, title: id, schemaVersion: 1, phase: "created", paths: { projectRoot, script: "guion/guion.txt", editorProject: "editor-project.json", output: "output" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2));
  return projectRoot;
}

test("createEditorProject defaults to clean rows even when project media folders contain files", () => {
  const projectRoot = makeProjectRoot("clean-default");

  const project = createEditorProject(projectRoot, { projectId: "clean-default", title: "Clean Default" });
  const diagnostics = validateEditorProject(projectRoot, project);

  assert.deepEqual(project.assets.filter((asset) => ["image", "audio", "music"].includes(asset.type)), []);
  assert.equal(project.rows.length, 2);
  assert.deepEqual(project.rows.map((row) => row.selectedAssetId), [null, null]);
  assert.deepEqual(project.rows.map((row) => row.candidates), [[], []]);
  assert.deepEqual(project.rows.map((row) => row.status), ["missing_asset", "missing_asset"]);
  assert.deepEqual(diagnostics.gates.missing, ["voice", "music", "row:row-1:image", "row:row-2:image"]);
  assert.equal(diagnostics.gates.ok, false);
  assert.equal(project.canvas.width, 1280);
  assert.equal(project.canvas.height, 720);
  assert.equal(project.rows.every((row) => row.motion === "slow-zoom-in"), true);
  assert.equal(project.rows.every((row) => row.dust?.enabled === false), true);
  assert.equal(project.rows.every((row) => row.transition === "none"), true);
  assert.equal(project.rows.every((row) => row.filter?.mode === "cover"), true);
  assert.equal(project.rows.every((row) => row.lockedPhrase === true), true);
  assert.equal(project.globalLayers.logo?.position, "top-left");
  assert.equal(project.globalLayers.logo?.enabled, false);
  assert.equal(project.audio?.music?.volume, 0.15);
  assert.equal(project.audio?.voice?.volume, 1);
  assert.equal(project.audio?.music?.muted, false);
  assert.equal(project.audio?.voice?.muted, false);
});

test("createEditorProject seedMedia opt-in keeps legacy local media candidates and readiness", () => {
  const projectRoot = makeProjectRoot("seeded-default");

  const project = createEditorProject(projectRoot, { projectId: "seeded-default", title: "Seeded Default", seedMedia: true });
  const diagnostics = validateEditorProject(projectRoot, project);

  assert.deepEqual(project.assets.filter((asset) => asset.type === "image").map((asset) => asset.localPath), ["imagenes/cierre.jpg", "imagenes/intro.jpg"]);
  assert.deepEqual(project.assets.filter((asset) => ["audio", "music"].includes(asset.type)).map((asset) => asset.type).sort(), ["audio", "music"]);
  assert.deepEqual(project.rows.map((row) => row.selectedAssetId), ["image-cierre-jpg", "image-intro-jpg"]);
  assert.equal(project.rows[0].candidates.length, 2);
  assert.equal(project.rows[0].status, "ready");
  assert.equal(diagnostics.gates.ok, true);
});
