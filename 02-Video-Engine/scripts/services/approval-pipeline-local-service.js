const http = require("http");
const path = require("path");
const fs = require("fs");
const {
  buildApprovalContractPipeline,
  ALIGNMENT_FALLBACK_WARNING,
} = require("../../../03-Contracts-Core/approval-contract-pipeline");
const { createApprovalProjectStore } = require("../lib/approval-project-store");
const { toApprovalCreateResponse, toApprovalStatusResponse } = require("../lib/approval-response-adapter");
const { applyContractOperations } = require("../../../01-Control-Panel/services/approval-editor/lib/contract-updates");

function stableId(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function ok(response, data, status = 200) {
  sendJson(response, status, { ok: true, data });
}

function fail(response, error, status = 500) {
  sendJson(response, status, { ok: false, error: { code: error.code || "internal_error", message: error.message || String(error) } });
}

function errorStatus(error) {
  if (["invalid_json", "missing_audio", "unsupported_operation", "invalid_asset", "invalid_video_segment", "invalid_video_segment_duration"].includes(error.code)) return 400;
  if (["unknown_project", "unknown_row"].includes(error.code)) return 404;
  if (["stale_snapshot"].includes(error.code)) return 409;
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

function normalizeApprovalPayload(input = {}) {
  const draftId = String(input.draft_id || input.projectId || "").trim();
  const title = String(input.title || draftId || "Approval project").trim();
  const segments = Array.isArray(input.segments)
    ? input.segments
    : String(input.guion_piped || "")
      .split("|")
      .map((phrase, index) => ({ id: `row-${index + 1}`, phrase: phrase.trim() }))
      .filter((segment) => segment.phrase);

  return {
    projectId: stableId(draftId || title || `approval-${Date.now()}`) || `approval-${Date.now()}`,
    title,
    draftId: draftId || null,
    selectedImages: Array.isArray(input.selected_images) ? input.selected_images : [],
    segments,
    voiceAudio: input.voice_audio || null,
    backgroundAudio: input.background_audio || null,
  };
}

function buildRowSeeds(segments = []) {
  return segments.map((segment, index) => ({
    id: String(segment.id || `row-${index + 1}`),
    index,
    phrase: String(segment.phrase || segment.text || segment.caption || `Segment ${index + 1}`).trim(),
    caption: String(segment.phrase || segment.text || segment.caption || `Segment ${index + 1}`).trim(),
    startTime: Number.isFinite(Number(segment.startTime)) ? Number(segment.startTime) : index * 1.5,
    endTime: Number.isFinite(Number(segment.endTime)) ? Number(segment.endTime) : index * 1.5 + 1.5,
    motion: "slow-zoom-in",
    dust: { enabled: false },
    logo: { enabled: true },
    filter: { enabled: true, mode: "cover" },
    transition: "none",
    sfx: null,
  }));
}

function createApprovalPipelineLocalService({ projectsRoot = path.resolve(__dirname, "..", "..", "projects", "approval-contract-pipeline"), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const store = createApprovalProjectStore({ projectsRoot });

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        return ok(response, { ok: true, status: "ready", service: "approval-contract-pipeline-local-service" });
      }

      if (request.method === "POST" && url.pathname === "/api/projects/create-from-approval") {
        const payload = normalizeApprovalPayload(await readBody(request));
        if (!payload.voiceAudio?.public_url || !payload.backgroundAudio?.public_url) {
          throw Object.assign(new Error("approval payload requires voice and background audio"), { code: "missing_audio" });
        }

        const projectRoot = store.resolveProjectRoot(payload.projectId);
        fs.mkdirSync(path.join(projectRoot, "audio"), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, "imagenes"), { recursive: true });
        fs.mkdirSync(path.join(projectRoot, "output"), { recursive: true });

        const alignedTimings = {
          phrases: payload.segments.map((segment, index) => ({
            startTime: Number.isFinite(Number(segment.startTime)) ? Number(segment.startTime) : index * 1.5,
            endTime: Number.isFinite(Number(segment.endTime)) ? Number(segment.endTime) : index * 1.5 + 1.5,
          })),
        };

        const imageAssets = payload.selectedImages.map((image, index) => {
          const sourceUrl = typeof image === "string" ? image : image?.public_url || image?.url || "";
          const fileName = `${String(index + 1).padStart(3, "0")}-${stableId(image?.id || image?.label || sourceUrl || `image-${index + 1}`) || `image-${index + 1}`}.jpg`;
          return {
            id: `image-${stableId(image?.id || sourceUrl || fileName) || `image-${index + 1}`}`,
            type: "image",
            source: { kind: "local", bridge: "approval-panel" },
            localPath: `imagenes/${fileName}`,
            publicPath: sourceUrl,
            status: "ready",
          };
        });

        const voiceAsset = {
          id: `voice-${stableId(payload.voiceAudio?.public_url || payload.voiceAudio?.storage_path || "voice") || "voice"}`,
          type: "audio",
          source: { kind: "local", bridge: "approval-panel" },
          localPath: `audio/${stableId(payload.voiceAudio.public_url || "voice") || "voice"}.wav`,
          publicPath: payload.voiceAudio.public_url,
          status: "ready",
        };
        const musicAsset = {
          id: `music-${stableId(payload.backgroundAudio?.public_url || payload.backgroundAudio?.storage_path || "music") || "music"}`,
          type: "music",
          source: { kind: "local", bridge: "approval-panel" },
          localPath: `audio/${stableId(payload.backgroundAudio.public_url || "music") || "music"}.wav`,
          publicPath: payload.backgroundAudio.public_url,
          status: "ready",
        };

        const pipeline = buildApprovalContractPipeline({
          projectId: payload.projectId,
          title: payload.title,
          draftId: payload.draftId,
          rowsSeed: buildRowSeeds(payload.segments),
          segments: payload.segments,
          alignedTimings,
          alignmentStatus: { status: "ready", source: "whisper-alignment", generatedAt: new Date().toISOString() },
          imageAssets,
          voiceAsset,
          musicAsset,
        });

        const record = store.saveApprovalProject({
          projectId: payload.projectId,
          title: payload.title,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          alignmentStatus: pipeline.alignmentStatus,
          snapshot: pipeline.contract,
          snapshotHash: pipeline.contract.snapshotHash,
          previewAssets: pipeline.manifest,
          manifest: pipeline.manifest,
        });

        return ok(response, toApprovalCreateResponse(record), 201);
      }

      const match = /^\/api\/projects\/([^/]+)\/(status|snapshot|render-final)$/.exec(url.pathname);
      if (match) {
        const projectId = decodeURIComponent(match[1]);
        const record = store.readApprovalProject(projectId);
        if (!record) throw Object.assign(new Error(`unknown project: ${projectId}`), { code: "unknown_project" });

        if (request.method === "GET" && match[2] === "status") return ok(response, toApprovalStatusResponse(record));
        if (request.method === "GET" && match[2] === "snapshot") return ok(response, { snapshot: record.snapshot, snapshotHash: record.snapshotHash });
        if (request.method === "PATCH" && match[2] === "snapshot") {
          const body = await readBody(request);
          if (body.baseSnapshotHash !== record.snapshotHash) throw Object.assign(new Error("stale baseSnapshotHash"), { code: "stale_snapshot" });
          const snapshot = applyContractOperations(record.snapshot, Array.isArray(body.operations) ? body.operations : []);
          const updated = store.saveApprovalProject({ ...record, updatedAt: new Date().toISOString(), snapshot, snapshotHash: snapshot.snapshotHash });
          return ok(response, { snapshot: updated.snapshot, snapshotHash: updated.snapshotHash });
        }
        if (request.method === "POST" && match[2] === "render-final") {
          const body = await readBody(request);
          if (body.snapshotHash !== record.snapshotHash) throw Object.assign(new Error("stale snapshotHash for final render"), { code: "stale_snapshot" });
          return ok(response, { projectId, snapshotHash: record.snapshotHash, render: { status: "queued" } }, 202);
        }
      }

      throw Object.assign(new Error("Not found"), { code: "not_found" });
    } catch (error) {
      return fail(response, error, errorStatus(error));
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.APPROVAL_PIPELINE_LOCAL_SERVICE_PORT || 3041);
  const server = createApprovalPipelineLocalService();
  server.listen(port, "127.0.0.1", () => {
    console.log(`approval-contract-pipeline-local-service listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createApprovalPipelineLocalService };
