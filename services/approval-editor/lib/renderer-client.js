/**
 * VideoRendererPort client used by the approval editor.
 *
 * The renderer is a separate service; this module never imports renderer files
 * or spawns its CLI. Tests can inject a `renderAdapter` directly into
 * `createApprovalEditorService`.
 */
function createRendererClient({ baseUrl = '', fetchImpl = globalThis.fetch, timeoutMs = 30 * 60 * 1000, headers = {} } = {}) {
  const endpoint = String(baseUrl || '').trim().replace(/\/+$/, '');

  return async function rendererRenderAdapter({ projectId, snapshot, snapshotHash }) {
    if (!endpoint) {
      const error = new Error("Renderer service URL is not configured (APPROVAL_EDITOR_RENDERER_URL).");
      error.code = "renderer_unavailable";
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${endpoint}/api/render`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ project_id: projectId, snapshot, snapshot_hash: snapshotHash || "" }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
      if (!response.ok || payload?.ok === false) {
        const error = new Error(payload?.error?.message || `Renderer request failed (HTTP ${response.status}).`);
        error.code = payload?.error?.code || "render_command_failed";
        throw error;
      }
      const finalPath = payload?.data?.final_path;
      if (!finalPath) {
        const error = new Error("Renderer completed without a final output path.");
        error.code = "render_output_missing";
        throw error;
      }
      return { finalPath, projectRoot: payload?.data?.project_root || "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createRendererClient };
