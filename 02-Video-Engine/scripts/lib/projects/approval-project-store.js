const fs = require("fs");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfPresent(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createApprovalProjectStore({ projectsRoot = path.resolve(__dirname, "..", "..", "..", "projects", "approval-contract-pipeline") } = {}) {
  const root = path.resolve(projectsRoot);
  const indexPath = path.join(root, "index.json");

  function projectDir(projectId) {
    return path.join(root, String(projectId));
  }

  function projectJsonPath(projectId) {
    return path.join(projectDir(projectId), "project.json");
  }

  function statusJsonPath(projectId) {
    return path.join(projectDir(projectId), "status.json");
  }

  function listApprovalProjects() {
    return readJsonIfPresent(indexPath, { projects: [] });
  }

  function updateIndex(record) {
    const current = listApprovalProjects();
    const projects = current.projects.filter((entry) => entry.id !== record.projectId).concat({
      id: record.projectId,
      title: record.title,
      status: record.alignmentStatus?.status || "pending",
      projectPath: `projects/approval-contract-pipeline/${record.projectId}`,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    writeJsonAtomic(indexPath, { projects });
  }

  function saveApprovalProject(record) {
    const createdAt = record.createdAt || nowIso();
    const updatedAt = record.updatedAt || createdAt;
    const normalized = {
      ...record,
      createdAt,
      updatedAt,
    };
    const dir = projectDir(normalized.projectId);
    ensureDir(dir);
    writeJsonAtomic(projectJsonPath(normalized.projectId), normalized);
    writeJsonAtomic(statusJsonPath(normalized.projectId), {
      projectId: normalized.projectId,
      snapshotHash: normalized.snapshotHash || normalized.snapshot?.snapshotHash || null,
      alignmentStatus: normalized.alignmentStatus,
      project: normalized.snapshot?.project || { rows: normalized.snapshot?.rows || [] },
      previewAssets: normalized.previewAssets || null,
      manifest: normalized.manifest || null,
    });
    updateIndex(normalized);
    return normalized;
  }

  function readApprovalProject(projectId) {
    return readJsonIfPresent(projectJsonPath(projectId), null);
  }

  function readApprovalStatus(projectId) {
    return readJsonIfPresent(statusJsonPath(projectId), null);
  }

  return {
    listApprovalProjects,
    saveApprovalProject,
    readApprovalProject,
    readApprovalStatus,
    resolveProjectRoot: projectDir,
  };
}

module.exports = { createApprovalProjectStore };
