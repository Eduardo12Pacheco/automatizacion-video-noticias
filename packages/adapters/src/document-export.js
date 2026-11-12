import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AdapterError } from './http.js';
import { DEFAULT_ADAPTER_SCRIPT, runJsonCommand } from './spawn.js';

const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function safeDocId(value) {
  const id = String(value || '').trim();
  if (!id || !DOC_ID_PATTERN.test(id)) {
    throw new AdapterError('document_id_invalid', 'Document id is invalid', { statusCode: 400 });
  }
  return id;
}

/**
 * DocumentExportPort: python-docx for the downloadable `.docx` plus a Markdown
 * copy on disk. The old implementation exported to Google Docs/Drive.
 */
export class LocalDocumentExport {
  constructor({
    pythonBin = 'python3',
    scriptPath = DEFAULT_ADAPTER_SCRIPT,
    root = './data/documents',
    timeoutMs = 60_000,
    runCommand = runJsonCommand,
    readFileImpl = readFile,
  } = {}) {
    this.pythonBin = pythonBin;
    this.scriptPath = scriptPath;
    this.root = resolve(String(root || './data/documents'));
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 60_000);
    this.runCommand = runCommand;
    this.readFileImpl = readFileImpl;
  }

  async createDocument({ title = '', content = '', pronunciation = '', draftId = '' } = {}) {
    if (!String(content || '').trim()) {
      throw new AdapterError('document_content_empty', 'Document content is required', { statusCode: 400 });
    }
    const result = await this.runCommand({
      pythonBin: this.pythonBin,
      scriptPath: this.scriptPath,
      args: ['create-doc'],
      payload: { title, content, pronunciation, draftId, root: this.root },
      timeoutMs: this.timeoutMs,
    });
    if (!result?.doc_id) throw new AdapterError('document_create_failed', 'Local document export returned no doc_id');
    return {
      doc_id: safeDocId(result.doc_id),
      doc_url: result.doc_url || '',
      filename: result.filename || 'guion.docx',
      content_type: result.content_type || DOCX_CONTENT_TYPE,
      markdown_path: result.markdown_path || '',
    };
  }

  async exportDocument({ docId = '', title = '', content = '', piped = '', format = 'docx' } = {}) {
    const id = safeDocId(docId);
    const wanted = String(format || 'docx').toLowerCase();
    const extension = wanted === 'md' || wanted === 'markdown' ? 'md' : 'docx';
    let path = resolve(this.root, `${id}.${extension}`);
    if (extension === 'docx') {
      try {
        await this.readFileImpl(path);
      } catch {
        throw new AdapterError('document_not_found', 'Published document file is missing', { statusCode: 404 });
      }
    } else {
      path = resolve(this.root, `${id}.md`);
      try {
        await this.readFileImpl(path);
      } catch {
        const created = await this.createDocument({ title, content: piped || content, draftId: id });
        path = resolve(this.root, `${created.doc_id}.md`);
      }
    }
    const bytes = await this.readFileImpl(path);
    const filename = `${String(title || id).replace(/[^\w .-]+/g, '').trim().slice(0, 90) || id}.${extension}`;
    return {
      bytes,
      filename: extension === 'md' ? `${filename.replace(/\.md$/, '')}.md` : `${filename.replace(/\.docx$/, '')}.docx`,
      content_type: extension === 'md' ? 'text/markdown; charset=utf-8' : DOCX_CONTENT_TYPE,
    };
  }
}
