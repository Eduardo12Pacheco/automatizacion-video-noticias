function toApprovalStatusResponse(record) {
  if (!record) return null;
  return {
    projectId: record.projectId,
    snapshotHash: record.snapshotHash || record.snapshot?.snapshotHash || null,
    alignmentStatus: record.alignmentStatus || null,
    project: record.project || record.snapshot?.project || { rows: record.snapshot?.rows || [] },
    previewAssets: record.previewAssets || null,
    manifest: record.manifest || null,
  };
}

function withLegacyProjectRows(snapshot) {
  if (!snapshot || snapshot.project?.rows || !Array.isArray(snapshot.rows)) return snapshot || { project: { rows: [] } };
  return { ...snapshot, project: { rows: snapshot.rows } };
}

function toApprovalCreateResponse(record) {
  if (!record) return null;
  return {
    projectId: record.projectId,
    snapshotHash: record.snapshotHash || record.snapshot?.snapshotHash || null,
    alignmentStatus: record.alignmentStatus || null,
    snapshot: withLegacyProjectRows(record.snapshot),
    previewAssets: record.previewAssets || null,
    manifest: record.manifest || null,
  };
}

module.exports = {
  toApprovalStatusResponse,
  toApprovalCreateResponse,
};
