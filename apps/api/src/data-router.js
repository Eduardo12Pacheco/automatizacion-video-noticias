import { readJson } from './read-json.js';

const ALLOWED_BUCKETS = new Set([
  'video-project-audio',
  'video-candidates-temp',
  'video-project-videos',
]);

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export const DATA_MUTATION_ROUTES = Object.freeze([
  {
    id: 'data-selections',
    action: 'selections',
    methods: ['POST'],
    pattern: /^\/panel\/video-projects\/[^/]+\/selections$/,
    examplePath: '/panel/video-projects/draft-1/selections',
  },
  {
    id: 'data-editor-state',
    action: 'editor-state',
    methods: ['PUT'],
    pattern: /^\/panel\/video-projects\/[^/]+\/editor-state$/,
    examplePath: '/panel/video-projects/draft-1/editor-state',
  },
  {
    id: 'data-audio',
    action: 'audio',
    methods: ['POST'],
    pattern: /^\/panel\/video-projects\/[^/]+\/audio$/,
    examplePath: '/panel/video-projects/draft-1/audio',
  },
  {
    id: 'data-custom-images',
    action: 'custom-images',
    methods: ['POST'],
    pattern: /^\/panel\/video-projects\/[^/]+\/custom-images$/,
    examplePath: '/panel/video-projects/draft-1/custom-images',
  },
  {
    id: 'data-disable',
    action: 'disable',
    methods: ['POST'],
    pattern: /^\/panel\/video-projects\/[^/]+\/disable$/,
    examplePath: '/panel/video-projects/draft-1/disable',
  },
  {
    id: 'data-upload',
    action: 'upload',
    methods: ['POST'],
    pattern: /^\/panel\/uploads\/[^/]+\/.+$/,
    examplePath: '/panel/uploads/video-project-audio/projects/draft-1/voice.m4a',
  },
]);

// Uploads are buffered in process memory. 64 MiB is enough for voice tracks,
// candidate images and short clips; subtitles source videos use the subtitles
// worker's streaming endpoint instead of the panel blob store.
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

const INLINE_CONTENT_TYPE_PATTERNS = Object.freeze([
  /^audio\/[a-z0-9.+-]+$/,
  /^video\/[a-z0-9.+-]+$/,
  /^image\/(?:png|jpeg|jpg|webp|gif)$/,
]);

const BLOB_SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "sandbox; default-src 'none'",
  'x-content-type-options': 'nosniff',
});

function baseContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function isInlineContentType(value) {
  const type = baseContentType(value);
  return Boolean(type) && INLINE_CONTENT_TYPE_PATTERNS.some((pattern) => pattern.test(type));
}

function startsWithBytes(bytes, signature) {
  if (!bytes || bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function hasAscii(bytes, offset, text) {
  if (!bytes || bytes.length < offset + text.length) return false;
  return text.split('').every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

const MEDIA_SIGNATURES = Object.freeze({
  png: (bytes) => startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (bytes) => startsWithBytes(bytes, [0xff, 0xd8, 0xff]),
  gif: (bytes) => hasAscii(bytes, 0, 'GIF87a') || hasAscii(bytes, 0, 'GIF89a'),
  webp: (bytes) => hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WEBP'),
  wav: (bytes) => hasAscii(bytes, 0, 'RIFF') && hasAscii(bytes, 8, 'WAVE'),
  ogg: (bytes) => hasAscii(bytes, 0, 'OggS'),
  flac: (bytes) => hasAscii(bytes, 0, 'fLaC'),
  mp3: (bytes) => hasAscii(bytes, 0, 'ID3') || (bytes?.[0] === 0xff && (bytes?.[1] & 0xe0) === 0xe0),
  aac: (bytes) => bytes?.[0] === 0xff && (bytes?.[1] & 0xf6) === 0xf0,
  mp4: (bytes) => hasAscii(bytes, 4, 'ftyp'),
  webm: (bytes) => startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3]),
});

const MEDIA_VALIDATORS = Object.freeze({
  'image/png': [MEDIA_SIGNATURES.png],
  'image/jpeg': [MEDIA_SIGNATURES.jpeg],
  'image/jpg': [MEDIA_SIGNATURES.jpeg],
  'image/gif': [MEDIA_SIGNATURES.gif],
  'image/webp': [MEDIA_SIGNATURES.webp],
  'audio/wav': [MEDIA_SIGNATURES.wav],
  'audio/x-wav': [MEDIA_SIGNATURES.wav],
  'audio/wave': [MEDIA_SIGNATURES.wav],
  'audio/ogg': [MEDIA_SIGNATURES.ogg],
  'audio/flac': [MEDIA_SIGNATURES.flac],
  'audio/mpeg': [MEDIA_SIGNATURES.mp3],
  'audio/mp3': [MEDIA_SIGNATURES.mp3],
  'audio/mp4': [MEDIA_SIGNATURES.mp4],
  'audio/x-m4a': [MEDIA_SIGNATURES.mp4],
  'audio/m4a': [MEDIA_SIGNATURES.mp4],
  'audio/aac': [MEDIA_SIGNATURES.aac],
  'audio/webm': [MEDIA_SIGNATURES.webm],
  'video/mp4': [MEDIA_SIGNATURES.mp4],
  'video/webm': [MEDIA_SIGNATURES.webm],
  'video/ogg': [MEDIA_SIGNATURES.ogg],
  'video/quicktime': [MEDIA_SIGNATURES.mp4],
});

const AUDIO_FALLBACK_SIGNATURES = Object.values(MEDIA_SIGNATURES).filter(
  (validator) => ![MEDIA_SIGNATURES.png, MEDIA_SIGNATURES.jpeg, MEDIA_SIGNATURES.gif, MEDIA_SIGNATURES.webp].includes(validator),
);
const VIDEO_FALLBACK_SIGNATURES = [MEDIA_SIGNATURES.mp4, MEDIA_SIGNATURES.webm, MEDIA_SIGNATURES.ogg];

function matchesDeclaredMediaType(contentType, bytes) {
  const type = baseContentType(contentType);
  if (!isInlineContentType(type)) return true;
  const validators = MEDIA_VALIDATORS[type]
    || (type.startsWith('audio/') ? AUDIO_FALLBACK_SIGNATURES : VIDEO_FALLBACK_SIGNATURES);
  return validators.some((validator) => validator(bytes));
}

function safeAttachmentName(key) {
  const name = String(key || '').split('/').pop() || 'download';
  return name.replace(/["\\\r\n]/g, '_');
}

function blobResponseHeaders(blob, key) {
  const declaredType = baseContentType(blob.content_type) || 'application/octet-stream';
  const inline = isInlineContentType(declaredType);
  return {
    'content-type': inline ? declaredType : 'application/octet-stream',
    'content-length': String(blob.size ?? blob.data?.length ?? 0),
    'cache-control': 'private, max-age=60',
    ...BLOB_SECURITY_HEADERS,
    ...(inline ? {} : { 'content-disposition': `attachment; filename="${safeAttachmentName(key)}"` }),
  };
}

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
    const route = DATA_MUTATION_ROUTES.find(
      (candidate) => candidate.action !== 'upload' && candidate.pattern.test(pathname),
    );
    if (!route) return null;
    if (!route.methods.includes(method)) {
      return jsonResponse(405, { ok: false, error: 'method_not_allowed' });
    }
    const match = pathname.match(/^\/panel\/video-projects\/([^/]+)\//);
    const draftId = decodeSegment(match?.[1]);
    if (!draftId) return jsonResponse(400, { ok: false, error: 'invalid_draft_id' });
    const action = route.action;

    try {
      if (action === 'selections') {
        const body = await readJson(readBody, { maxBodyBytes: MAX_JSON_BODY_BYTES });
        const selected = body.selectedImageIds ?? body.selected_image_ids ?? [];
        return jsonResponse(200, await repository.saveVideoProjectSelections({
          draftId,
          selectedImageIds: selected,
        }));
      }
      if (action === 'editor-state') {
        const body = await readJson(readBody, { maxBodyBytes: MAX_JSON_BODY_BYTES });
        return jsonResponse(200, await repository.saveVideoProjectEditorState({
          draftId,
          editorState: body.editorState ?? body.editor_state ?? body,
        }));
      }
      if (action === 'audio') {
        const body = await readJson(readBody, { maxBodyBytes: MAX_JSON_BODY_BYTES });
        return jsonResponse(200, await repository.saveVideoProjectAudio({
          draftId,
          voiceAudio: body.voiceAudio ?? body.voice_audio ?? {},
          backgroundAudio: body.backgroundAudio ?? body.background_audio ?? {},
        }));
      }
      if (action === 'custom-images') {
        const body = await readJson(readBody, { maxBodyBytes: MAX_JSON_BODY_BYTES });
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
    const declaredLength = Number.parseInt(String(headers['content-length'] || ''), 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return jsonResponse(413, { ok: false, error: 'payload_too_large' });
    }
    const bytes = await readBody({ maxBodyBytes: maxUploadBytes });
    const contentType = headers['content-type'] || 'application/octet-stream';
    if (!matchesDeclaredMediaType(contentType, bytes)) {
      return jsonResponse(415, { ok: false, error: 'unsupported_media_type' });
    }
    const stored = await blobStorage.put(`${bucket}/${key}`, bytes, {
      contentType,
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
      headers: blobResponseHeaders(blob, key),
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
    mutationRoutes: DATA_MUTATION_ROUTES,
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
  return DATA_MUTATION_ROUTES.some((route) => route.pattern.test(pathname));
}
