/**
 * Constant-time comparison for the internal worker token.
 *
 * The bundled services (approval editor, renderer, demo worker) are only
 * reachable from the API gateway over the Compose network, but they still
 * reject requests without the token the installer generated into `.env`. The
 * comparison mirrors the ASR/channel-monitor `x-api-key` pattern.
 */
const { timingSafeEqual } = require('node:crypto');

function tokenMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''), 'utf8');
  const right = Buffer.from(String(expected || ''), 'utf8');
  if (!left.length || !right.length || left.length !== right.length) {
    // Still touch both buffers so an early length mismatch is not the only
    // timing signal; the result is always false here.
    const size = Math.max(left.length, right.length, 1);
    timingSafeEqual(Buffer.alloc(size), Buffer.alloc(size));
    return false;
  }
  return timingSafeEqual(left, right);
}

function matchesAnyToken(provided, expectedTokens = []) {
  let matched = false;
  for (const expected of expectedTokens) {
    if (tokenMatches(provided, expected)) matched = true;
  }
  return matched;
}

function readInternalToken(headers = {}) {
  return String(headers['x-api-key'] || headers['x-approval-secret'] || '');
}

module.exports = { tokenMatches, matchesAnyToken, readInternalToken };
