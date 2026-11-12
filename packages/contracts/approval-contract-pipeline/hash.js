const crypto = require("node:crypto");

const VOLATILE_KEYS = new Set(["snapshotHash", "snapshotId", "render"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .filter((key) => !VOLATILE_KEYS.has(key))
    .sort()
    .reduce((next, key) => {
      next[key] = canonicalize(value[key]);
      return next;
    }, {});
}

function computeApprovalSnapshotHash(snapshot = {}) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(snapshot))).digest("hex");
}

module.exports = { computeApprovalSnapshotHash, canonicalize };
