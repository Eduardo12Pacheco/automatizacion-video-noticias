const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RenderLifecycleError,
  acquireRenderLock,
  cleanupOwnedTempArtifacts,
  runRenderCommand,
} = require("../scripts/render/render-lifecycle");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "video-render-lifecycle-"));
}

test("render lock contention fails with typed status and preserves the existing lock", () => {
  const projectRoot = makeProject();
  const lockPath = path.join(projectRoot, "output", ".render.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234, createdAt: "2026-05-24T00:00:00.000Z" }));

  assert.throws(
    () => acquireRenderLock({ projectRoot }),
    (error) => {
      assert.equal(error instanceof RenderLifecycleError, true);
      assert.equal(error.code, "RENDER_LOCKED");
      assert.equal(error.status, "locked");
      assert.match(error.message, /render.*already.*running/i);
      return true;
    },
  );
  assert.match(fs.readFileSync(lockPath, "utf8"), /1234/);
});

test("render lock release removes only the owned lock", () => {
  const projectRoot = makeProject();
  const lock = acquireRenderLock({ projectRoot, now: () => "2026-05-24T01:00:00.000Z" });
  assert.equal(fs.existsSync(lock.lockPath), true);
  assert.match(fs.readFileSync(lock.lockPath, "utf8"), /2026-05-24T01:00:00.000Z/);

  lock.release();

  assert.equal(fs.existsSync(lock.lockPath), false);
});

test("cleanup removes owned render temp artifacts without deleting unrelated output files", () => {
  const projectRoot = makeProject();
  const ownedTempDir = path.join(projectRoot, "output", ".render-tmp");
  const ownedFile = path.join(ownedTempDir, "remotion-props.tmp.json");
  const unrelatedFile = path.join(projectRoot, "output", "keep.txt");
  fs.mkdirSync(ownedTempDir, { recursive: true });
  fs.writeFileSync(ownedFile, "temp");
  fs.writeFileSync(unrelatedFile, "do not delete");

  const result = cleanupOwnedTempArtifacts({ projectRoot, ownedPaths: [ownedFile, unrelatedFile] });

  assert.deepEqual(result.removed.map((file) => path.relative(projectRoot, file).replace(/\\/g, "/")), [
    "output/.render-tmp/remotion-props.tmp.json",
  ]);
  assert.equal(fs.existsSync(ownedFile), false);
  assert.equal(fs.existsSync(unrelatedFile), true);
});

test("render command timeout returns typed status without invoking real Remotion", () => {
  const result = runRenderCommand({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    cwd: process.cwd(),
    timeoutMs: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "timeout");
  assert.equal(result.code, "RENDER_TIMEOUT");
  assert.match(result.errorMessage, /timed out/i);
});

test("render command success preserves numeric exit code separately from typed status", () => {
  const result = runRenderCommand({
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: process.cwd(),
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "done");
  assert.equal(result.exitCode, 0);
});
