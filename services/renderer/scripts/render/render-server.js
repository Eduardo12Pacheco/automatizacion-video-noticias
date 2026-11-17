#!/usr/bin/env node
/**
 * Render-only HTTP boundary for the Remotion worker.
 *
 * The approval editor owns editor snapshots; it calls this service through the
 * VideoRendererPort instead of importing renderer files or spawning its CLI.
 */
const http = require("node:http");
const path = require("node:path");
const { createVideoEngineRenderAdapter } = require("../lib/render/video-engine-render-adapter");
const { readInternalToken, tokenMatches } = require("@newsroom/contracts/security/internal-token");

const JSON_LIMIT = 32 * 1024 * 1024;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        reject(Object.assign(new Error("payload_too_large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function createRenderServer({ projectsRoot, videoEngineRoot = path.resolve(__dirname, "..", ".."), env = process.env, renderAdapter, apiToken = null } = {}) {
  const adapter = renderAdapter || createVideoEngineRenderAdapter({ videoEngineRoot, projectsRoot, env });
  const expectedToken = String(apiToken ?? env.RENDERER_API_KEY ?? "").trim();
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://renderer.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, data: { status: "ready", service: "renderer-service" } });
      }
      if (request.method === "POST" && url.pathname === "/api/render") {
        if (!expectedToken) {
          return sendJson(response, 503, { ok: false, error: { code: "internal_token_not_configured", message: "Renderer API token is not configured" } });
        }
        if (!tokenMatches(readInternalToken(request.headers), expectedToken)) {
          return sendJson(response, 401, { ok: false, error: { code: "unauthorized", message: "Invalid or missing internal API token" } });
        }
        const body = await readJson(request);
        const projectId = String(body.project_id || body.projectId || "").trim();
        const snapshot = body.snapshot && typeof body.snapshot === "object" ? body.snapshot : null;
        if (!projectId || !snapshot) {
          return sendJson(response, 400, { ok: false, error: { code: "invalid_render_request", message: "project_id and snapshot are required" } });
        }
        const result = await adapter({ projectId, snapshot, snapshotHash: body.snapshot_hash || body.snapshotHash || "" });
        return sendJson(response, 200, { ok: true, data: { final_path: result.finalPath, project_root: result.projectRoot } });
      }
      return sendJson(response, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
    } catch (error) {
      const status = Number(error?.statusCode) || (["render_command_missing", "render_command_failed", "render_output_missing"].includes(error?.code) ? 502 : 500);
      return sendJson(response, status, { ok: false, error: { code: error?.code || "render_failed", message: error?.message || String(error) } });
    }
  });
}

if (require.main === module) {
  const host = process.env.RENDER_SERVER_HOST || "127.0.0.1";
  const port = Number(process.env.RENDER_SERVER_PORT || 3042);
  const projectsRoot = process.env.RENDER_OUTPUT_ROOT || path.resolve(__dirname, "..", "..", "projects", "renderer");
  const server = createRenderServer({ projectsRoot });
  server.listen(port, host, () => {
    console.log(`renderer-service listening on http://${host}:${port}`);
  });
}

module.exports = { createRenderServer };
