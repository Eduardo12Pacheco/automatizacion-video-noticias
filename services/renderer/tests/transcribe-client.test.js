const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const scriptPath = path.join(__dirname, "..", "scripts", "transcribe-audio.py");

function pythonBin() {
  if (process.env.REMOTION_EDITOR_PYTHON_BIN) return process.env.REMOTION_EDITOR_PYTHON_BIN;
  if (process.platform === "win32") return "py";
  return "python3";
}

test("legacy STT diagnostics delegate Whisper to the shared asr-worker", () => {
  const result = spawnSync(pythonBin(), [scriptPath, "--diagnose-backends"], {
    encoding: "utf8",
    env: { ...process.env, ASR_WORKER_URL: "http://127.0.0.1:9" },
    timeout: 15000,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.asrWorkerUrl, "http://127.0.0.1:9");
  assert.equal(payload.asrWorkerReachable, false);
  assert.match(payload.recommendation, /asr-worker/);
  assert.equal(Object.hasOwn(payload, "whisperModuleAvailable"), false);
});

test("legacy STT script no longer imports faster-whisper in process", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.equal(source.includes("from faster_whisper import"), false);
  assert.match(source, /\/api\/radar\/transcribe/);
});
