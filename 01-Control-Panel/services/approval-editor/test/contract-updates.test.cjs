const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDustType } = require('../lib/contract-updates');

test('normalizeDustType accepts particle-1 unchanged (existing behavior preserved)', () => {
  assert.equal(normalizeDustType('particle-1'), 'particle-1');
});

test('normalizeDustType accepts particle-2 unchanged (existing behavior preserved)', () => {
  assert.equal(normalizeDustType('particle-2'), 'particle-2');
});

test('normalizeDustType accepts particle-3 unchanged', () => {
  assert.equal(normalizeDustType('particle-3'), 'particle-3');
});

test('normalizeDustType accepts particle-4 unchanged', () => {
  assert.equal(normalizeDustType('particle-4'), 'particle-4');
});

test('normalizeDustType still rejects unknown dust types with invalid_dust_type code', () => {
  assert.throws(
    () => normalizeDustType('particle-5'),
    (err) => err.code === 'invalid_dust_type',
    'Expected particle-5 to throw with code invalid_dust_type',
  );
});

test('normalizeDustType error message lists all four valid identifiers', () => {
  assert.throws(
    () => normalizeDustType('particle-99'),
    (err) => /particle-1/.test(err.message) && /particle-2/.test(err.message) && /particle-3/.test(err.message) && /particle-4/.test(err.message),
    'Expected error message to list particle-1, particle-2, particle-3 and particle-4',
  );
});
