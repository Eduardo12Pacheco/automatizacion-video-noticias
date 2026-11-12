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
            title: 'Caicedo vuelve',
            main_content: 'Caicedo vuelve a entrenar con Ecuador. '.repeat(20),
          },
        };
      }
    }
    class Llm {
      async complete() {
        return { text: 'Ecuador ajusta su mediocampo. '.repeat(50) };
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
      seleccion: 'Ecuador',
      jugador: 'Moisés Caicedo',
      titular: 'Caicedo vuelve',
      link: 'https://example.local/news-1',
      estado_revision: 'aprobado',
      tema_principal: 'Caicedo vuelve',
    }]);
    await repository.applyApprovalDecision({ idNoticia: 'news-1', clusterId: null, action: 'approve' });
    const result = await runtime.useCases.draftScript.execute({ id_noticia: 'news-1' });
    assert.equal(result.status, 'completed');
  });
});
