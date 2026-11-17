/**
 * BlobStoragePort stores binary artifacts (uploads, rendered audio/video and
 * cached images) outside Postgres. Keys are opaque, slash-separated paths.
 *
 * Implementations MUST reject path traversal and absolute paths. The default
 * adapter is the local filesystem (`FS_ROOT`, usually `./data/blobs`); an S3
 * adapter is an optional local-first adapter.
 */
export class BlobStoragePort {
  async put() { throw new Error('not_implemented: put'); }
  async get() { throw new Error('not_implemented: get'); }
  async head() { throw new Error('not_implemented: head'); }
  async delete() { throw new Error('not_implemented: delete'); }
  async list() { throw new Error('not_implemented: list'); }
  getPublicUrl() { throw new Error('not_implemented: getPublicUrl'); }
}
