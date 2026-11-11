const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeProjectsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remotion-approval-store-"));
}

test("approval project store persists index, project, and status across restarts", () => {
  const { createApprovalProjectStore } = require("../scripts/lib/approval-project-store");
  const projectsRoot = makeProjectsRoot();

  const store = createApprovalProjectStore({ projectsRoot });
  const record = {
    projectId: "draft-42",
    title: "Approval Bridge",
    alignmentStatus: { ok: true, status: "ready", service: "approval-contract-pipeline-local-service" },
    snapshot: { project: { rows: [{ id: "row-1", phrase: "Linea 1", selectedAssetId: "image-1" }] } },
    previewAssets: {
      version: 1,
      images: [{ rowId: "row-1", assetId: "image-1", mediaUrl: "https://cdn.test/image-1.jpg" }],
      audio: {
        voice: { assetId: "voice-1", mediaUrl: "https://cdn.test/voice.wav" },
        music: { assetId: "music-1", mediaUrl: "https://cdn.test/music.wav" },
      },
    },
    manifest: { version: 1, cacheKey: "cache-1" },
  };

  store.saveApprovalProject(record);

  assert.equal(fs.existsSync(path.join(projectsRoot, "index.json")), true);
  assert.equal(fs.existsSync(path.join(projectsRoot, "draft-42", "project.json")), true);
  assert.equal(fs.existsSync(path.join(projectsRoot, "draft-42", "status.json")), true);

  const restarted = createApprovalProjectStore({ projectsRoot });
  const project = restarted.readApprovalProject("draft-42");
  const status = restarted.readApprovalStatus("draft-42");

  assert.equal(project.projectId, "draft-42");
  assert.equal(project.snapshot.project.rows[0].selectedAssetId, "image-1");
  assert.equal(status.projectId, "draft-42");
  assert.equal(status.previewAssets.audio.voice.mediaUrl, "https://cdn.test/voice.wav");
  assert.equal(restarted.listApprovalProjects().projects[0].id, "draft-42");
});
