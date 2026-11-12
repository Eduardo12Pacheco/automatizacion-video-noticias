import {
  API_DATA_PREFIX,
  VIDEO_PROJECT_AUDIO_BUCKET,
  VIDEO_CANDIDATES_TEMP_BUCKET,
  VIDEO_PROJECT_VIDEO_BUCKET,
  buildAudioMetadata,
  buildAudioPath,
  buildCustomImagePath,
  buildPublicStorageUrl,
  buildUploadPath,
  buildVideoUploadMetadata,
  buildVideoUploadPath,
  encodeStoragePath,
  md5ProjectStorageKey,
} from './storage-paths.js';
import {
  buildGatewayReadHeaders,
  resolveGatewayBaseUrl,
  resolveSharedReadModelUrl,
  resolveVideoProjectsSharedReadPath,
} from '../../../core/http/shared-read-models.js';
import { normalizeCustomImageMimeType } from '../domain/image-files.js';

function normalizeRpcPayload(payload = {}) {
  return {
    p_draft_id: payload.draftId || null,
    p_limit: Number.isFinite(Number(payload.limit)) ? Number(payload.limit) : 50,
    p_include_detail: Boolean(payload.includeDetail),
  };
}

async function parseResponseBody(response) {
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  return data;
}

function responseErrorMessage(data, fallback) {
  return data?.message || data?.error || data?.raw || fallback;
}

function projectRoute(draftId, suffix) {
  return `${API_DATA_PREFIX}/video-projects/${encodeURIComponent(draftId)}/${suffix}`;
}

export function createVideoProjectsClient({ fetchImpl = fetch, resolveBaseUrl = resolveGatewayBaseUrl } = {}) {
  function baseUrl() {
    return (typeof resolveBaseUrl === 'function' ? resolveBaseUrl() : '').toString().trim().replace(/\/+$/, '');
  }

  async function jsonRequest(path, { method = 'POST', body } = {}) {
    const response = await fetchImpl(`${baseUrl()}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await parseResponseBody(response);
    if (!response.ok || data?.ok === false) {
      throw new Error(responseErrorMessage(data, `Video project request ${response.status}`));
    }
    return data;
  }

  async function callVideoProjectsRpc(payload = {}) {
    normalizeRpcPayload(payload);
    const sharedReadPath = resolveVideoProjectsSharedReadPath({
      draftId: payload.draftId,
      limit: payload.limit,
    });
    const sharedResponse = await fetchImpl(resolveSharedReadModelUrl(sharedReadPath), {
      method: 'GET',
      headers: buildGatewayReadHeaders(),
      credentials: 'include',
      cache: 'no-store',
    });

    const sharedData = await parseResponseBody(sharedResponse);

    if (!sharedResponse.ok) {
      const message = responseErrorMessage(sharedData, `Video projects read model ${sharedResponse.status}`);
      throw new Error(message);
    }

    return sharedData;
  }

  async function uploadBlob({ bucket, path, file, contentType, durationSeconds = 0 }) {
    const response = await fetchImpl(`${baseUrl()}${buildUploadPath(bucket, path)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': contentType || file?.type || 'application/octet-stream' },
      body: file,
    });
    const data = await parseResponseBody(response);
    if (!response.ok || data?.ok === false) {
      throw new Error(responseErrorMessage(data, `Upload ${response.status}`));
    }
    return data;
  }

  async function saveVideoProjectSelections({ draftId, selectedImageIds = [] } = {}) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');

    const ids = Array.isArray(selectedImageIds) ? selectedImageIds : [];
    return jsonRequest(projectRoute(id, 'selections'), {
      method: 'POST',
      body: { selectedImageIds: ids },
    });
  }

  async function uploadAudioFile({ draftId, kind, file }) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');
    if (!file) throw new Error('audio file is required');

    const normalizedKind = kind === 'background' ? 'background' : 'voice';
    const path = buildAudioPath({ draftId: id, kind: normalizedKind, file });
    const uploaded = await uploadBlob({
      bucket: VIDEO_PROJECT_AUDIO_BUCKET,
      path,
      file,
      contentType: file.type || 'application/octet-stream',
    });

    return {
      ...buildAudioMetadata({ path, kind: normalizedKind, file }),
      ...uploaded,
      kind: normalizedKind,
      bucket: VIDEO_PROJECT_AUDIO_BUCKET,
      storage_path: path,
      public_url: buildPublicStorageUrl(VIDEO_PROJECT_AUDIO_BUCKET, path),
      public_url_server: uploaded.public_url,
    };
  }

  async function uploadCustomImageFile({ draftId, file }) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');
    if (!file) throw new Error('image file is required');

    const projectStorageKey = md5ProjectStorageKey(id);
    const path = buildCustomImagePath({ draftId: id, file });
    const mimeType = normalizeCustomImageMimeType(file) || file.type || 'application/octet-stream';
    const uploaded = await uploadBlob({
      bucket: VIDEO_CANDIDATES_TEMP_BUCKET,
      path,
      file,
      contentType: mimeType,
    });

    return {
      storage_bucket: VIDEO_CANDIDATES_TEMP_BUCKET,
      storage_path: path,
      storage_public_url: buildPublicStorageUrl(VIDEO_CANDIDATES_TEMP_BUCKET, path),
      project_storage_key: projectStorageKey,
      size: uploaded.size,
      mime_type: mimeType,
    };
  }

  async function uploadProjectVideoFile({ draftId, file, durationSeconds = 0 }) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');
    if (!file) throw new Error('video file is required');

    const path = buildVideoUploadPath({ draftId: id, file });
    await uploadBlob({
      bucket: VIDEO_PROJECT_VIDEO_BUCKET,
      path,
      file,
      contentType: file.type || 'application/octet-stream',
    });

    return {
      ...buildVideoUploadMetadata({ path, file, durationSeconds }),
      public_url: buildPublicStorageUrl(VIDEO_PROJECT_VIDEO_BUCKET, path),
    };
  }

  async function uploadVoiceSourceVideoFile({ draftId, file }) {
    return uploadProjectVideoFile({ draftId, file, durationSeconds: 0 });
  }

  async function addVideoProjectCustomImages({ draftId, customCandidates = [] } = {}) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');
    if (!Array.isArray(customCandidates) || !customCandidates.length) {
      throw new Error('customCandidates is required');
    }

    return jsonRequest(projectRoute(id, 'custom-images'), {
      method: 'POST',
      body: { customCandidates },
    });
  }

  async function saveVideoProjectAudio({ draftId, voiceAudio = {}, backgroundAudio = {} } = {}) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');

    return jsonRequest(projectRoute(id, 'audio'), {
      method: 'POST',
      body: { voiceAudio: voiceAudio || {}, backgroundAudio: backgroundAudio || {} },
    });
  }

  async function saveVideoProjectEditorState({ draftId, editorState = {} } = {}) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');

    return jsonRequest(projectRoute(id, 'editor-state'), {
      method: 'PUT',
      body: { editorState: editorState || {} },
    });
  }

  async function disableVideoProject({ draftId } = {}) {
    const id = (draftId || '').toString().trim();
    if (!id) throw new Error('draftId is required');

    return jsonRequest(projectRoute(id, 'disable'), { method: 'POST', body: {} });
  }

  return {
    listVideoProjects: ({ limit = 50 } = {}) => callVideoProjectsRpc({ limit, includeDetail: true }),
    getVideoProject: (draftId) => callVideoProjectsRpc({ draftId, limit: 1, includeDetail: true }),
    saveVideoProjectSelections,
    uploadAudioFile,
    saveVideoProjectAudio,
    saveVideoProjectEditorState,
    uploadCustomImageFile,
    uploadProjectVideoFile,
    uploadVoiceSourceVideoFile,
    addVideoProjectCustomImages,
    disableVideoProject,
  };
}

export { encodeStoragePath };
