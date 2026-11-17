const test = require('node:test');
const assert = require('node:assert/strict');

const { matchesAnyToken, readInternalToken, tokenMatches } = require('../security/internal-token.js');

test('tokenMatches compares the exact token in constant time', () => {
  assert.equal(tokenMatches('shared-secret', 'shared-secret'), true);
  assert.equal(tokenMatches('shared-secret', 'shared-secreT'), false);
  assert.equal(tokenMatches('short', 'a-longer-secret'), false);
  assert.equal(tokenMatches('', 'shared-secret'), false);
  assert.equal(tokenMatches('shared-secret', ''), false);
});

test('matchesAnyToken accepts any configured worker token', () => {
  assert.equal(matchesAnyToken('tts-key', ['tts-key', 'subtitles-key']), true);
  assert.equal(matchesAnyToken('subtitles-key', ['tts-key', 'subtitles-key']), true);
  assert.equal(matchesAnyToken('other', ['tts-key', 'subtitles-key']), false);
});

test('readInternalToken accepts the API key or the approval secret header', () => {
  assert.equal(readInternalToken({ 'x-api-key': 'a' }), 'a');
  assert.equal(readInternalToken({ 'x-approval-secret': 'b' }), 'b');
  assert.equal(readInternalToken({}), '');
});
