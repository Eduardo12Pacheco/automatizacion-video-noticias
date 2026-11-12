const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

class RenderLifecycleError extends Error {
  constructor(message, { code, status, details = {} } = {}) {
    super(message);
    this.name = "RenderLifecycleError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function defaultLockPath(projectRoot) {
  return path.join(projectRoot, "output", ".render.lock");
}

function acquireRenderLock({ projectRoot, lockPath = defaultLockPath(projectRoot), now = () => new Date().toISOString() }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const payload = { pid: process.pid, createdAt: now(), token };

  try {
    fs.writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error && error.code === "EEXIST") {
      throw new RenderLifecycleError(`A render is already running for this project: ${lockPath}`, {
        code: "RENDER_LOCKED",
        status: "locked",
        details: { lockPath },
      });
    }
    throw error;
  }

  return {
    lockPath,
    release() {
      if (!fs.existsSync(lockPath)) return false;
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (current.token !== token) return false;
      } catch {
        return false;
      }
      fs.rmSync(lockPath, { force: true });
      return true;
    },
  };
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function cleanupOwnedTempArtifacts({ projectRoot, ownedPaths = [] }) {
  const ownedTempRoot = path.resolve(projectRoot, "output", ".render-tmp");
  const removed = [];

  for (const target of ownedPaths) {
    const absoluteTarget = path.resolve(target);
    if (!isInside(absoluteTarget, ownedTempRoot) || !fs.existsSync(absoluteTarget)) {
      continue;
    }
    fs.rmSync(absoluteTarget, { recursive: true, force: true });
    removed.push(absoluteTarget);
  }

  return { removed };
}

function runRenderCommand({ executable, args, cwd, timeoutMs, env = process.env }) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
  });

  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) {
    return {
      ...result,
      ok: false,
      code: "RENDER_TIMEOUT",
      status: "timeout",
      errorMessage: `Render timed out after ${timeoutMs}ms`,
    };
  }

  const exitCode = typeof result.status === "number" ? result.status : null;
  return {
    ...result,
    exitCode,
    ok: !result.error && result.status === 0,
    code: result.error ? "RENDER_SPAWN_ERROR" : result.status === 0 ? "RENDER_OK" : "RENDER_FAILED",
    status: result.error ? "spawn_error" : result.status === 0 ? "done" : "failed",
    errorMessage: result.error?.message || "",
  };
}

module.exports = {
  RenderLifecycleError,
  acquireRenderLock,
  cleanupOwnedTempArtifacts,
  runRenderCommand,
};
