import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalDocumentExport } from '../src/document-export.js';

// The adapter shells out to python-docx. A missing module is an optional
// local-runtime gap: skip with an allow-listed reason instead of failing with
// an obscure traceback. CI installs python-docx so this test really runs there.
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const docxProbe = spawnSync(PYTHON_BIN, ['-c', 'import docx'], { encoding: 'utf8' });
const docxSkip = docxProbe.status === 0
  ? false
  : `missing-python-docx: install python-docx for ${PYTHON_BIN} (see CONTRIBUTING.md)`;

test('LocalDocumentExport creates a real docx and a markdown copy through python-docx', { skip: docxSkip }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'newsroom-docs-'));
  const adapter = new LocalDocumentExport({ root, timeoutMs: 30_000 });

  const created = await adapter.createDocument({
    draftId: 'draft-1',
    title: 'Guion - Jugador - Tema',
    content: 'Primer parrafo.\n\nSegundo parrafo.',
    pronunciation: 'Primer parrafo con fonetica.',
  });

  assert.match(created.doc_id, /^doc-/);
  assert.match(created.doc_url, /^\/panel\/documents\//);
  const files = await readdir(root);
  assert.ok(files.includes(`${created.doc_id}.docx`));
  assert.ok(files.includes(`${created.doc_id}.md`));

  const exported = await adapter.exportDocument({ docId: created.doc_id, title: 'Guion final' });
  assert.ok(Buffer.isBuffer(exported.bytes));
  assert.equal(exported.bytes.subarray(0, 2).toString(), 'PK');
  assert.equal(exported.content_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  const markdown = await adapter.exportDocument({ docId: created.doc_id, title: 'Guion final', format: 'md' });
  assert.match(markdown.bytes.toString('utf8'), /Segundo parrafo/);
});

test('LocalDocumentExport rejects empty content and invalid ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newsroom-docs-'));
  const adapter = new LocalDocumentExport({ root });
  await assert.rejects(() => adapter.createDocument({ content: '' }), /content is required/);
  await assert.rejects(() => adapter.exportDocument({ docId: '../escape' }), /invalid/);
});

test('LocalDocumentExport reports a missing published document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'newsroom-docs-'));
  const adapter = new LocalDocumentExport({ root });
  await assert.rejects(() => adapter.exportDocument({ docId: 'doc-missing' }), (error) => error.code === 'document_not_found');
});
