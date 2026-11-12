import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryRepository } from '../../../packages/data/src/index.js';
import { createCoreRuntime } from '../src/core-runtime.js';

describe('core runtime adapter injection', () => {
  it('keeps class adapter methods when it adds defaults', async () => {
    class Extractor {
      async extract() {
        return {
          article: {
            title: 'Andrade vuelve',
            main_content: 'Andrade vuelve a entrenar con Aurenia. '.repeat(20),
          },
        };
      }
    }
    class Llm {
      async complete() {
        return { text: 'Aurenia ajusta su mediocampo. '.repeat(50) };
      }
    }

    const repository = new InMemoryRepository();
    await repository.migrate();
    const runtime = createCoreRuntime({
      repository,
      adapters: { articleExtractor: new Extractor(), llm: new Llm() },
    });
    await repository.upsertNews([{
      id_noticia: 'news-1',
      seleccion: 'Aurenia',
      jugador: 'Nicolás Andrade',
      titular: 'Andrade vuelve',
      link: 'https://example.local/news-1',
      estado_revision: 'aprobado',
      tema_principal: 'Andrade vuelve',
    }]);
    await repository.applyApprovalDecision({ idNoticia: 'news-1', clusterId: null, action: 'approve' });
    const result = await runtime.useCases.draftScript.execute({ id_noticia: 'news-1' });
    assert.equal(result.status, 'completed');
  });

  it('exposes the save-draft use case and injected worker ports', async () => {
    const repository = new InMemoryRepository();
    await repository.migrate();
    const tts = { async createJob() { return { job_id: 'job-1', status: 'queued' }; } };
    const runtime = createCoreRuntime({ repository, adapters: { tts } });
    assert.equal(typeof runtime.useCases.saveScriptDraft.execute, 'function');
    assert.equal(runtime.adapters.tts, tts);
    assert.equal(runtime.adapters.asr, null);
  });
});
