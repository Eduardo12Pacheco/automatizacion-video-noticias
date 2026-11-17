const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveFfmpegPath } = require("../lib/real-alignment");

test("ffmpeg-static is resolved from the configured video-engine root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alignment-root-"));
  const packageDir = path.join(root, "node_modules", "ffmpeg-static");
  fs.mkdirSync(packageDir, { recursive: true });
  const binary = path.join(packageDir, "ffmpeg");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "ffmpeg-static", main: "index.js" }));
  fs.writeFileSync(path.join(packageDir, "index.js"), `module.exports = ${JSON.stringify(binary)};\n`);

  assert.equal(resolveFfmpegPath({ env: {}, moduleRoot: root }), binary);

  const explicit = path.join(root, "custom-ffmpeg");
  fs.writeFileSync(explicit, "", { mode: 0o755 });
  assert.equal(resolveFfmpegPath({ env: { FFMPEG_PATH: explicit }, moduleRoot: root }), explicit);
});
