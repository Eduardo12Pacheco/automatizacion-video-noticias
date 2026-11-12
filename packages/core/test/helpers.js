import { InMemoryRepository } from '../../data/src/index.js';

export const NEWS_FIXTURE = [
  {
    id_noticia: 'news-1',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    titular: 'Arbelo anotó en la victoria del Costa Azul FC',
    fuente: 'Example Sports',
    fecha_publicacion: '2026-11-10T10:00:00.000Z',
    link: 'https://news.example.local/andrade-1',
    snippet: 'El mediocampista marcó el primer gol del partido.',
    fuente_origen: 'google_news_rss',
    estado_revision: 'pendiente',
    tema_principal: 'Gol de Arbelo',
    google_position: 1,
    classification_source: 'heuristic',
    football_signals: 'gol || partido',
    pass_direct: true,
  },
  {
    id_noticia: 'news-2',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    titular: 'Arbelo, titular ante el Bahía Norte FC',
    fuente: 'Example Football',
    fecha_publicacion: '2026-11-10T09:00:00.000Z',
    link: 'https://news.example.local/andrade-2',
    snippet: 'El técnico confirmó la alineación.',
    fuente_origen: 'google_news_rss',
    estado_revision: 'pendiente',
    tema_principal: 'Alineación de Arbelo',
    google_position: 2,
    classification_source: 'ai',
    football_signals: 'partido || titular',
    pass_direct: false,
  },
];

export const CLUSTER_FIXTURE = {
  cluster_id: 'cluster-andrade-20261110',
  seleccion: 'Aurenia',
  jugador: 'Nicolás Arbelo',
  tema_principal: 'Regreso de Arbelo al Costa Azul FC',
  resumen_cluster: 'Arbelo entrenó y fue titular.',
  tag_editorial: 'club',
  fecha_creacion_cluster: '2026-11-10T11:00:00.000Z',
  avg_google_position: 1.5,
  sources: [
    { id_noticia: 'news-1', source_order: 0, source_title_snapshot: NEWS_FIXTURE[0].titular },
    { id_noticia: 'news-2', source_order: 1, source_title_snapshot: NEWS_FIXTURE[1].titular },
  ],
};

export const ARTICLE_FIXTURE = {
  url: 'https://news.example.local/andrade-1',
  title: 'Arbelo anotó en la victoria del Costa Azul FC',
  subtitle: 'El mediocampista fue clave',
  author: 'Demo Reporter',
  published_at: '2026-11-10T10:00:00.000Z',
  main_content: [
    'Nicolás Arbelo anotó el primer gol del Costa Azul FC en la victoria del partido.',
    'El mediocampista aureniano jugó los noventa minutos y fue elegido figura.',
    'El técnico destacó su rendimiento después del entrenamiento y confirmó que seguirá como titular.',
    'La selección de Aurenia también sigue de cerca su recuperación y su próximo partido de clasificatorias.',
  ].join(' '),
};

export function createMockLLM(...texts) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async complete(input) {
      calls.push(input);
      const text = texts[Math.min(index, texts.length - 1)];
      index += 1;
      return { text, model: 'mock-llm' };
    },
  };
}

export function createRetriableLLM(errors, successText) {
  let call = 0;
  return {
    async complete() {
      call += 1;
      if (call <= errors.length) throw errors[call - 1];
      return { text: successText, model: 'mock-llm' };
    },
  };
}

export async function seedApprovalCluster(repo) {
  await repo.upsertNews(structuredClone(NEWS_FIXTURE));
  await repo.persistClusters([structuredClone(CLUSTER_FIXTURE)]);
}

export async function seedPublishableDraft(repo) {
  await seedApprovalCluster(repo);
  await repo.applyApprovalDecision({
    idNoticia: 'news-1',
    clusterId: CLUSTER_FIXTURE.cluster_id,
    action: 'approve',
  });
  await repo.claimScriptJob({ idNoticia: 'news-1' });
  await repo.completeScriptJob({
    idNoticia: 'news-1',
    draftId: 'draft-news-1',
    guionDraft: 'Guion de prueba',
    guionEditado: 'Nicolás Arbelo anotó y fue figura del partido.',
    wordCount: 9,
  });
}

export async function createHarness() {
  const repository = new InMemoryRepository();
  await repository.migrate();
  return { repository };
}
