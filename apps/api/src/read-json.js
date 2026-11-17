/**
 * Reads a JSON object body from a router-provided `readBody` callback. Every
 * panel router uses the same shape validation; only the body limit differs.
 */
export async function readJson(readBody, { maxBodyBytes } = {}) {
  const raw = await readBody(maxBodyBytes ? { maxBodyBytes } : {});
  if (!raw || !raw.length) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed;
}
