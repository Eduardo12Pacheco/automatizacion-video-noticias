const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pngPixelBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";
const packageJsonPath = path.join(__dirname, "..", "package.json");
const readmePath = path.join(__dirname, "..", "README.md");

function makeFetchFixture() {
  const image = Buffer.from(pngPixelBase64, "base64");
  const voice = Buffer.from("voice-bytes");
  const music = Buffer.from("music-bytes");
  const byUrl = new Map([
    ["https://cdn.test/image-1.jpg", { bytes: image, contentType: "image/jpeg" }],
    ["https://cdn.test/image-2.jpg", { bytes: image, contentType: "image/jpeg" }],
    ["https://cdn.test/voice.wav", { bytes: voice, contentType: "audio/wav" }],
    ["https://cdn.test/music.wav", { bytes: music, contentType: "audio/wav" }],
  ]);

  return async function fetchFixture(url) {
    const found = byUrl.get(String(url));
    if (!found) return new Response("not found", { status: 404 });
    return new Response(found.bytes, { status: 200, headers: { "content-type": found.contentType } });
  };
}

function baseApprovalPayload() {
  return {
    draft_id: "Draft 42",
    title: "Approval Bridge",
    guion_piped: "Linea 1|Linea 2",
    selected_images: ["https://cdn.test/image-1.jpg", "https://cdn.test/image-2.jpg"],
    voice_audio: { public_url: "https://cdn.test/voice.wav" },
    background_audio: { public_url: "https://cdn.test/music.wav" },
  };
}

async function withService(projectsRoot, fn) {
  const { createApprovalPipelineLocalService } = require("../scripts/approval-pipeline-local-service");
  const server = createApprovalPipelineLocalService({ projectsRoot, env: {}, fetchImpl: makeFetchFixture() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep retrying until the launcher is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`timed out waiting for health at ${baseUrl}/health`);
}

async function withNpmLaunchedService(fn) {
  const port = await getFreePort();
  const serviceRoot = path.join(__dirname, "..");
  const child = spawn(
    process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run approval:service:local"]
      : ["run", "approval:service:local"],
    {
      cwd: serviceRoot,
      env: {
        ...process.env,
        APPROVAL_PIPELINE_LOCAL_SERVICE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
    await fn(`http://127.0.0.1:${port}`);
  } catch (error) {
    error.message = `${error.message}\n${output.join("")}`;
    throw error;
  } finally {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }

    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

async function api(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
}

test("approval pipeline local service exposes health, create, and status contract", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-approval-service-"));

  await withService(projectsRoot, async (baseUrl) => {
    const health = await api(baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.data.ok, true);
    assert.equal(health.body.data.status, "ready");
    assert.equal(health.body.data.service, "approval-contract-pipeline-local-service");

    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify(baseApprovalPayload()),
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.data.projectId, "draft-42");
    assert.equal(created.body.data.alignmentStatus.status, "ready");
    assert.equal(created.body.data.snapshot.project.rows.length, 2);
    assert.equal(created.body.data.previewAssets.version, 1);
    assert.equal(Object.keys(created.body.data.manifest.assets).length, 4);

    const status = await api(baseUrl, "/api/projects/draft-42/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.data.projectId, "draft-42");
    assert.equal(status.body.data.project.rows.length, 2);
    assert.equal(Object.keys(status.body.data.previewAssets.assets).length, 4);
    assert.equal(status.body.data.manifest.cacheKey, created.body.data.manifest.cacheKey);

    assert.equal(fs.existsSync(path.join(projectsRoot, "index.json")), true);
    assert.equal(fs.existsSync(path.join(projectsRoot, "draft-42", "project.json")), true);
    assert.equal(fs.existsSync(path.join(projectsRoot, "draft-42", "status.json")), true);
  });
});

test("approval pipeline local service survives restart with persisted status", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-approval-service-"));

  await withService(projectsRoot, async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify(baseApprovalPayload()),
    });
    assert.equal(created.status, 201);
  });

  await withService(projectsRoot, async (baseUrl) => {
    const status = await api(baseUrl, "/api/projects/draft-42/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.data.projectId, "draft-42");
    assert.equal(status.body.data.project.rows[0].phrase, "Linea 1");
  });
});

test("approval pipeline local service exposes the launcher script and runtime docs", async () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  assert.equal(packageJson.scripts["approval:service:local"], "node scripts/approval-pipeline-local-service.js");

  const readme = fs.readFileSync(readmePath, "utf8");
  for (const expected of [
    "http://127.0.0.1:3041",
    "APPROVAL_PIPELINE_LOCAL_SERVICE_PORT",
    "solo cubre preparación/status",
    "fallback de Remotion siguen igual",
  ]) {
    assert.equal(readme.includes(expected), true, expected);
  }

  assert.equal(readme.includes("node -e \"fetch('http://127.0.0.1:3041/health')"), true);
});

test("approval pipeline local service launcher starts through npm and answers /health", async () => {
  await withNpmLaunchedService(async (baseUrl) => {
    const health = await api(baseUrl, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.data.status, "ready");
    assert.equal(health.body.data.service, "approval-contract-pipeline-local-service");
  });
});

test("approval pipeline local service persists video segment edits and rejects stale final render", async () => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remotion-approval-service-"));

  await withService(projectsRoot, async (baseUrl) => {
    const created = await api(baseUrl, "/api/projects/create-from-approval", {
      method: "POST",
      body: JSON.stringify({
        ...baseApprovalPayload(),
        segments: [
          { id: "row-1", phrase: "Linea 1", startTime: 0, endTime: 2 },
          { id: "row-2", phrase: "Linea 2", startTime: 2, endTime: 4 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const beforeHash = created.body.data.snapshotHash;
    const beforeRows = created.body.data.snapshot.rows;

    const updated = await api(baseUrl, "/api/projects/draft-42/snapshot", {
      method: "PATCH",
      body: JSON.stringify({
        baseSnapshotHash: beforeHash,
        operations: [{
          type: "setRowVideoSegment",
          rowId: "row-1",
          asset: { assetId: "video-1", type: "video", renderPath: "videos/source.mp4", previewUrl: "/media/source.mp4" },
          sourceInSeconds: 3.25,
          durationSeconds: 2,
        }],
      }),
    });

    assert.equal(updated.status, 200);
    assert.notEqual(updated.body.data.snapshotHash, beforeHash);
    assert.equal(updated.body.data.snapshot.rows[0].media.kind, "video-segment");
    assert.equal(updated.body.data.snapshot.rows[0].media.sourceVideoAssetId, "video-1");
    assert.equal(updated.body.data.snapshot.rows[0].media.durationSeconds, 2);
    assert.equal(updated.body.data.snapshot.rows[0].selectedAssetId, beforeRows[0].selectedAssetId);
    assert.deepEqual(updated.body.data.snapshot.rows[1], beforeRows[1]);

    const staleRender = await api(baseUrl, "/api/projects/draft-42/render-final", {
      method: "POST",
      body: JSON.stringify({ snapshotHash: beforeHash }),
    });
    assert.equal(staleRender.status, 409);
    assert.equal(staleRender.body.error.code, "stale_snapshot");
  });
});
