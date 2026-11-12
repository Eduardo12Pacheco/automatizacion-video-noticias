const ALLOWED_BUCKETS = new Set([
  'video-project-audio',
  'video-candidates-temp',
  'video-project-videos',
]);

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function jsonResponse(status, body) {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function splitPath(pathname) {
  return pathname.split('/').filter(Boolean);
}

function isSafeUploadKey(key) {
  if (!key) return false;
  if (key.startsWith('/') || key.includes('\\')) return false;
  return key.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function uploadMetadata({ bucket, key, stored, headers }) {
  const publicUrl = stored.url;
  const name = String(headers['x-file-name'] || key.split('/').pop() || '');
  return {
    ok: true,
    bucket,
    storage_bucket: bucket,
    storage_path: key,
    path: key,
    storage_public_url: publicUrl,
    public_url: publicUrl,
    name,
    file_name: name,
    size: stored.size,
    mime_type: stored.content_type,
    content_type: stored.content_type,
    etag: stored.etag,
    uploaded_at: stored.created_at,
  };
}

async function readJson(readBody) {
  const raw = await readBody({ maxBodyBytes: MAX_JSON_BODY_BYTES });
  if (!raw || !raw.length) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed;
}

/**
 * HTTP surface for the local data layer. The gateway owns authentication,
 * CSRF and role checks; this router only translates routes to repository and
 * blob-storage calls.
 */
export function createDataRouter({
  repository,
  blobStorage,
  maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES,
} = {}) {
  if (!repository) throw new Error('repository is required');
  if (!blobStorage) throw new Error('blobStorage is required');

  async function handleMutations(method, pathname, readBody) {
    const match = pathname.match(/^\/panel\/video-projects\/([^/]+)\/(selections|editor-state|audio|custom-images|disable)$/);
    if (!match) return null;
    const draftId = decodeSegment(match[1]);
    if (!draftId) return jsonResponse(400, { ok: false, error: 'invalid_draft_id' });
    const action = match[2];
    const expectedMethod = action === 'editor-state' ? 'PUT' : 'POST';
    if (method !== expectedMethod) {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }

    try {
      if (action === 'selections') {
        const body = await readJson(readBody);
        const selected = body.selectedImageIds ?? body.selected_image_ids ?? [];
        return jsonResponse(200, await repository.saveVideoProjectSelections({
          draftId,
          selectedImageIds: selected,
        }));
      }
      if (action === 'editor-state') {
        const body = await readJson(readBody);
        return jsonResponse(200, await repository.saveVideoProjectEditorState({
          draftId,
          editorState: body.editorState ?? body.editor_state ?? body,
        }));
      }
      if (action === 'audio') {
        const body = await readJson(readBody);
        return jsonResponse(200, await repository.saveVideoProjectAudio({
          draftId,
          voiceAudio: body.voiceAudio ?? body.voice_audio ?? {},
          backgroundAudio: body.backgroundAudio ?? body.background_audio ?? {},
        }));
      }
      if (action === 'custom-images') {
        const body = await readJson(readBody);
        return jsonResponse(200, await repository.addVideoProjectCustomImages({
          draftId,
          customCandidates: body.customCandidates ?? body.custom_candidates ?? [],
        }));
      }
      if (action === 'disable') {
        return jsonResponse(200, await repository.disableVideoEditProject({ draftId }));
      }
    } catch (error) {
      if (String(error?.message || '').includes('not found')) {
        return jsonResponse(404, { ok: false, error: 'video_project_not_found' });
      }
      throw error;
    }
    return null;
  }

  async function handleUpload(method, pathname, headers, readBody) {
    const match = pathname.match(/^\/panel\/uploads\/([^/]+)\/(.+)$/);
    if (!match) return null;
    if (method !== 'POST') return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    const bucket = decodeSegment(match[1]);
    const key = decodeSegment(match[2]);
    if (!ALLOWED_BUCKETS.has(bucket)) {
      return jsonResponse(400, { ok: false, error: 'invalid_bucket' });
    }
    if (!isSafeUploadKey(key)) {
      return jsonResponse(400, { ok: false, error: 'invalid_storage_path' });
    }
    const bytes = await readBody({ maxBodyBytes: maxUploadBytes });
    const stored = await blobStorage.put(`${bucket}/${key}`, bytes, {
      contentType: headers['content-type'] || 'application/octet-stream',
    });
    return jsonResponse(201, uploadMetadata({ bucket, key, stored, headers }));
  }

  async function handleBlob(method, pathname) {
    if (!pathname.startsWith('/panel/blobs/')) return null;
    if (method !== 'GET' && method !== 'HEAD') {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }
    const key = decodeSegment(pathname.slice('/panel/blobs/'.length));
    if (!key) return jsonResponse(400, { ok: false, error: 'invalid_blob_key' });
    let blob;
    try {
      blob = method === 'GET' ? await blobStorage.get(key) : await blobStorage.head(key);
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_blob_key' });
    }
    if (!blob) return jsonResponse(404, { ok: false, error: 'blob_not_found' });
    return {
      status: 200,
      headers: {
        'content-type': blob.content_type || 'application/octet-stream',
        'content-length': String(blob.size ?? blob.data?.length ?? 0),
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      },
      body: method === 'HEAD' ? null : blob.data,
    };
  }

  async function handleReadModel(method, pathname, searchParams) {
    if (pathname !== '/panel/read-models/video-projects') return null;
    if (method !== 'GET') return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    const draftId = searchParams.get('draft_id');
    const limitValue = Number.parseInt(searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(limitValue) ? limitValue : 50;
    return jsonResponse(200, await repository.getVideoEditProjects({
      draftId: draftId || null,
      limit,
      includeDetail: true,
    }));
  }

  return {
    matches(pathname) {
      return pathname === '/panel/read-models/video-projects'
        || pathname.startsWith('/panel/video-projects/')
        || pathname.startsWith('/panel/uploads/')
        || pathname.startsWith('/panel/blobs/');
    },

    async handle({ method = 'GET', pathname, searchParams = new URLSearchParams(), headers = {}, readBody }) {
      const upperMethod = String(method).toUpperCase();
      const read = readBody || (async () => Buffer.alloc(0));

      const readModel = await handleReadModel(upperMethod, pathname, searchParams);
      if (readModel) return readModel;

      const mutation = await handleMutations(upperMethod, pathname, read);
      if (mutation) return mutation;

      const upload = await handleUpload(upperMethod, pathname, headers, read);
      if (upload) return upload;

      const blob = await handleBlob(upperMethod, pathname);
      if (blob) return blob;

      return jsonResponse(404, { ok: false, error: 'not_found' });
    },
  };
}

export function isMutationDataRequest(pathname = '') {
  return pathname.startsWith('/panel/uploads/')
    || /^\/panel\/video-projects\/[^/]+\/(selections|audio|custom-images|disable)$/.test(pathname);
}
