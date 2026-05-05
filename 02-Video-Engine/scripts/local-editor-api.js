const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createProjectStore } = require("./lib/local-project-store");

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5270",
  "http://localhost:5270",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "https://panel.example.local",
];

function resolveCorsOrigin(request, env = process.env) {
  const origin = request.headers.origin || "";
  const configured = (env.REMOTION_EDITOR_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  if (allowed.includes("*")) return "*";
  if (!origin) return allowed[0];
  return allowed.includes(origin) ? origin : "";
}

function sendJson(request, response, status, payload, env) {
  const corsOrigin = resolveCorsOrigin(request, env);
  response.writeHead(status, {
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin } : {}),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function ok(request, response, data, status = 200, env) {
  sendJson(request, response, status, { ok: true, data }, env);
}

function fail(request, response, error, status = 500, env) {
  sendJson(request, response, status, { ok: false, error: { code: error.code || "internal_error", message: error.message || String(error), details: error.details } }, env);
}

function sendMedia(request, response, media, env, extraHeaders = {}) {
  const corsOrigin = resolveCorsOrigin(request, env);
  response.writeHead(200, {
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin } : {}),
    "cache-control": "no-store",
    "content-type": media.contentType,
    ...extraHeaders,
  });
  fs.createReadStream(media.filePath).pipe(response);
}

function errorStatus(error) {
  if (["invalid_project_id", "invalid_json", "missing_asset_id", "unsafe_media_path", "missing_script", "missing_voice_audio", "missing_background_audio", "invalid_remote_asset_url"].includes(error.code)) return 400;
  if (["unknown_project", "missing_project", "missing_project_file", "unknown_row", "unknown_candidate", "unknown_asset", "missing_media_file"].includes(error.code)) return 404;
  if (["unsupported_asset_type", "unsupported_remote_image_type", "unsupported_media_type"].includes(error.code)) return 415;
  if (["invalid_remote_image_url", "remote_image_too_large"].includes(error.code)) return 400;
  if (["remote_image_download_failed", "remote_asset_download_failed"].includes(error.code)) return 502;
  if (["ffmpeg_unavailable", "audio_derivative_failed"].includes(error.code)) return 503;
  return 500;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        error.code = "invalid_json";
        reject(error);
      }
    });
  });
}

function runScript({ repoRoot, script, projectRoot, extraArgs = [], env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, "scripts", script), `--project-root=${projectRoot}`, ...extraArgs], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: "error", exitCode: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ status: code === 0 ? "success" : "error", exitCode: code || 0, stdout, stderr }));
  });
}

function createLocalEditorApi({ projectsRoot = path.resolve(__dirname, "..", "projects"), repoRoot = path.resolve(__dirname, ".."), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const store = createProjectStore({ projectsRoot, env, fetchImpl });
  const queues = new Map();

  function serialize(projectId, fn) {
    const previous = queues.get(projectId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (queues.get(projectId) === next) queues.delete(projectId);
    });
    queues.set(projectId, next);
    return next;
  }

  async function action(projectId, actionName) {
    const projectRoot = store.resolveProjectRoot(projectId);
    const specs = {
      prepare: { script: "prepare-editor-project.js" },
      validate: { script: "validate-editor-project.js", allowFailure: true },
      "render-dry-run": { script: "render-video.js", extraArgs: ["--dry-run", "--profile=preview"] },
      render: { script: "render-video.js", extraArgs: ["--profile=final"] },
      "render-preview": { script: "render-video.js", extraArgs: ["--dry-run", "--profile=preview"] },
      "render-final": { script: "render-video.js", extraArgs: ["--profile=final"] },
    };
    const spec = specs[actionName];
    if (!spec) {
      const error = new Error(`Unknown action: ${actionName}`);
      error.code = "not_found";
      throw error;
    }
    const command = await runScript({ repoRoot, projectRoot, script: spec.script, extraArgs: spec.extraArgs || [], env: spec.env || {} });
    const snapshot = store.readProject(projectId);
    return { command: { id: `${projectId}:${actionName}:${Date.now()}`, action: actionName, ...command }, project: snapshot.project, diagnostics: snapshot.diagnostics, output: snapshot.output };
  }

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") return sendJson(request, response, 204, null, env);
      const url = new URL(request.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/api/projects") return ok(request, response, store.listProjects(), 200, env);
      if (request.method === "POST" && url.pathname === "/api/projects/create-from-approval") return ok(request, response, await store.createFromApproval(await readBody(request)), 201, env);
      if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) return fail(request, response, Object.assign(new Error("Not found"), { code: "not_found" }), 404, env);
      const projectId = parts[2];

      if (request.method === "GET" && parts.length === 3) return ok(request, response, store.readProject(projectId), 200, env);
      if (request.method === "PUT" && parts.length === 3) return ok(request, response, store.saveProject(projectId, await readBody(request)), 200, env);
      if (request.method === "PUT" && parts[3] === "composition") return ok(request, response, store.saveComposition(projectId, await readBody(request)), 200, env);
      if (request.method === "GET" && parts[3] === "status") return ok(request, response, store.readProjectStatus(projectId), 200, env);
      if (request.method === "GET" && parts[3] === "media") return sendMedia(request, response, store.resolveMediaAsset(projectId, url.searchParams.get("assetId"), { allowedTypes: ["image", "logo", "outro"] }), env);
      if (request.method === "GET" && parts[3] === "diagnostics") return ok(request, response, { diagnostics: store.readDiagnostics(projectId) }, 200, env);
      if (request.method === "POST" && parts[3] === "render-preview") return ok(request, response, await serialize(projectId, () => action(projectId, "render-preview")).then((result) => ({ ...result, profile: { width: 1280, height: 720, fps: 30 } })), 200, env);
      if (request.method === "POST" && parts[3] === "render-final") return ok(request, response, await serialize(projectId, () => action(projectId, "render-final")).then((result) => ({ ...result, profile: { width: 1920, height: 1080, fps: 30 } })), 200, env);
      if (request.method === "GET" && parts[3] === "download" && parts[4] === "final") return sendMedia(request, response, store.resolveFinalVideo(projectId), env, { "content-disposition": `attachment; filename="${projectId}-final.mp4"` });
      if (request.method === "POST" && parts[3] === "assets" && parts[4] === "upload") return ok(request, response, store.uploadAsset(projectId, await readBody(request)), 201, env);
      if (request.method === "POST" && parts[3] === "images" && parts[4] === "search") return ok(request, response, await store.searchImages(projectId, await readBody(request)), 200, env);
      if (request.method === "POST" && parts[3] === "images" && parts[4] === "search-bulk") return ok(request, response, await store.searchImagesBulk(projectId, await readBody(request)), 200, env);
      if (request.method === "POST" && parts[3] === "images" && parts[4] === "import") return ok(request, response, await store.importImage(projectId, await readBody(request)), 200, env);
      if (request.method === "POST" && parts[3] === "actions" && parts[4]) return ok(request, response, await serialize(projectId, () => action(projectId, parts[4])), 200, env);

      return fail(request, response, Object.assign(new Error("Not found"), { code: "not_found" }), 404, env);
    } catch (error) {
      return fail(request, response, error, errorStatus(error), env);
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.REMOTION_EDITOR_API_PORT || 3037);
  const server = createLocalEditorApi();
  server.listen(port, "127.0.0.1", () => {
    console.log(`RemotionEditor local API listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createLocalEditorApi };
