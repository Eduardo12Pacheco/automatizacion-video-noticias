import { extractModelText, parseModelJson } from '../domain/news.js';

function compactNews(rows) {
  return rows.map((row) => ({
    id_noticia: row.id_noticia,
    seleccion: row.seleccion,
    jugador: row.jugador,
    titular: row.titular,
    fuente: row.fuente,
    fecha_publicacion: row.fecha_publicacion,
    snippet: row.snippet,
    tema_principal: row.tema_principal,
  }));
}

export function buildClusterPrompt(rows = []) {
  return [
    'Agrupa las noticias deportivas por tema principal. Dos noticias pertenecen al mismo cluster solo si cuentan el mismo hecho o una evolucion directa del mismo tema.',
    '',
    'Devuelve SOLO JSON valido con este formato:',
    '{',
    '  "clusters": [',
    '    {',
    '      "cluster_id": "slug-estable",',
    '      "seleccion": "...",',
    '      "jugador": "...",',
    '      "tema_principal": "...",',
    '      "resumen_cluster": "...",',
    '      "tag_editorial": "club|seleccion|elogio_prensa|elogio_director_tecnico|emotividad|otros",',
    '      "source_ids": ["id_noticia-1", "id_noticia-2"]',
    '    }',
    '  ]',
    '}',
    '',
    'Reglas:',
    '- Cada noticia puede aparecer en un solo cluster.',
    '- No inventes id_noticia.',
    '- Si no hay clusters claros devuelve {"clusters":[]}.',
    '',
    'Noticias:',
    JSON.stringify(compactNews(rows), null, 2),
  ].join('\n');
}

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function average(values) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 100) / 100;
}

function buildCluster(raw, rowsById, index, nowIso) {
  const sourceIds = Array.isArray(raw.source_ids)
    ? raw.source_ids.map(String)
    : (Array.isArray(raw.sources) ? raw.sources.map((source) => String(source?.id_noticia || source)).filter(Boolean) : []);
  const matched = [...new Set(sourceIds)].map((id) => rowsById.get(id)).filter(Boolean);
  if (!matched.length) return null;
  const first = matched[0];
  const id = String(raw.cluster_id || raw.id || '').trim()
    || `cluster-${slug(raw.tema_principal || first.tema_principal || first.jugador || first.id_noticia) || 'topic'}-${slug(nowIso.slice(0, 10))}-${index + 1}`;
  return {
    cluster_id: id,
    seleccion: raw.seleccion || first.seleccion || null,
    jugador: raw.jugador || first.jugador || null,
    tema_principal: raw.tema_principal || first.tema_principal || first.titular || 'Sin tema',
    resumen_cluster: raw.resumen_cluster || raw.resumen || null,
    tag_editorial: raw.tag_editorial || null,
    avg_google_position: average(matched.map((row) => row.google_position)),
    estado_revision: 'pendiente',
    fecha_creacion_cluster: raw.fecha_creacion_cluster || nowIso,
    sources: matched.map((row, sourceIndex) => ({
      id_noticia: row.id_noticia,
      source_order: sourceIndex,
      source_title_snapshot: row.titular || null,
    })),
  };
}

/**
 * Port of "MVP - Cluster Topics v2 - Supabase": asks the model for topic
 * clusters over the discovery universe and persists them (staged when a run
 * id is supplied).
 */
export class ClusterTopics {
  constructor({ repository, llm, now = () => new Date() } = {}) {
    if (!repository) throw new Error('repository is required');
    this.repository = repository;
    this.llm = llm || null;
    this.now = now;
  }

  async execute({ runId = null } = {}) {
    const effectiveRunId = runId ? String(runId) : null;
    const listed = await this.repository.listNewsForClustering(effectiveRunId ? { runId: effectiveRunId } : {});
    const rows = listed.rows || [];
    if (!rows.length) return { status: 'ok', clustered: 0, clusters: [] };
    if (!this.llm) throw new Error('llm adapter is required to cluster topics');

    if (effectiveRunId) {
      await this.repository.updateNewsSearchRun(effectiveRunId, { status: 'cluster_running' });
    }
    const response = await this.llm.complete({
      prompt: buildClusterPrompt(rows),
      system: 'Agrupa noticias deportivas y responde solo con JSON valido.',
      temperature: 0,
    });
    const parsed = parseModelJson(extractModelText(response));
    const rawClusters = Array.isArray(parsed?.clusters) ? parsed.clusters : [];
    const rowsById = new Map(rows.map((row) => [String(row.id_noticia), row]));
    const nowIso = new Date(this.now()).toISOString();
    const clusters = rawClusters
      .map((raw, index) => buildCluster(raw, rowsById, index, nowIso))
      .filter(Boolean);

    const persisted = await this.repository.persistClusters(
      clusters,
      effectiveRunId ? { runId: effectiveRunId } : {},
    );
    if (effectiveRunId) {
      const previous = await this.repository.getNewsSearchRun(effectiveRunId);
      await this.repository.updateNewsSearchRun(effectiveRunId, {
        status: 'cluster_succeeded',
        stats: {
          ...(previous?.stats || {}),
          staged_clusters: persisted.upserted,
          clustered_sources: clusters.reduce((sum, cluster) => sum + cluster.sources.length, 0),
        },
      });
    }
    return {
      status: 'ok',
      clustered: clusters.reduce((sum, cluster) => sum + cluster.sources.length, 0),
      clusters,
    };
  }
}
