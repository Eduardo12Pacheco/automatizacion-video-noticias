export const DEFAULT_PLAYERS = Object.freeze([
  { seleccion: 'Ecuador', jugador: 'Moisés Caicedo' },
  { seleccion: 'Ecuador', jugador: 'Piero Hincapié' },
  { seleccion: 'Ecuador', jugador: 'Willian Pacho' },
  { seleccion: 'Ecuador', jugador: 'Gonzalo Plata' },
  { seleccion: 'Ecuador', jugador: 'Kendry Páez' },
  { seleccion: 'Ecuador', jugador: 'Enner Valencia' },
  { seleccion: 'Colombia', jugador: 'James Rodríguez' },
  { seleccion: 'Colombia', jugador: 'Luis Díaz' },
  { seleccion: 'Colombia', jugador: 'Juan Fernando Quintero' },
  { seleccion: 'Colombia', jugador: 'Jhon Arias' },
  { seleccion: 'Argentina', jugador: 'Lionel Messi' },
  { seleccion: 'Argentina', jugador: 'Julián Álvarez' },
  { seleccion: 'Argentina', jugador: 'Emiliano Martínez' },
  { seleccion: 'Uruguay', jugador: 'Federico Valverde' },
  { seleccion: 'Paraguay', jugador: 'Julio Enciso' },
  { seleccion: 'Paraguay', jugador: 'Miguel Almirón' },
]);

const FOOTBALL_KEYWORDS = Object.freeze([
  'gol', 'goles', 'asistencia', 'asistencias', 'anoto', 'anotó', 'marco', 'marcó', 'convirtio', 'convirtió',
  'partido', 'partidos', 'entrenador', 'tecnico', 'técnico', 'dt', 'club', 'seleccion', 'selección',
  'convocado', 'convocatoria', 'alineacion', 'alineación', 'titular', 'suplente', 'capitan', 'capitán',
  'vestuario', 'lesion', 'lesión', 'lesionado', 'recuperacion', 'recuperación', 'fichaje', 'transferencia',
  'mercado', 'renovacion', 'renovación', 'contrato', 'debut', 'victoria', 'derrota', 'empate', 'torneo',
  'liga', 'copa', 'champions', 'libertadores', 'sudamericana', 'eliminatorias', 'mundial', 'chelsea',
  'liverpool', 'leverkusen', 'psg', 'barcelona', 'real madrid', 'arsenal', 'brighton', 'premier league',
  'bundesliga', 'ligue 1', 'serie a', 'la liga',
]);

export function normalizeWindow(value) {
  const raw = String(value ?? '24h').trim().toLowerCase();
  if (['1h', 'hour', 'last_hour', 'ultima_hora', 'última_hora'].includes(raw)) {
    return { requested_window: '1h', google_when: '1h', window_ms: 60 * 60 * 1000 };
  }
  return { requested_window: '24h', google_when: '1d', window_ms: 24 * 60 * 60 * 1000 };
}

export function buildFeedRequests(players = DEFAULT_PLAYERS, window = '24h', { runId = '' } = {}) {
  const normalized = normalizeWindow(window);
  const selected = Array.isArray(players) && players.length ? players : DEFAULT_PLAYERS;
  return selected.map((player) => {
    const query = `"${player.jugador}" when:${normalized.google_when}`;
    return {
      ...player,
      run_id: String(runId || ''),
      requested_window: normalized.requested_window,
      window_ms: normalized.window_ms,
      source_kind: 'google_news_rss',
      source_name: 'Google News RSS',
      feed_url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=es-419&gl=EC&ceid=EC:es-419`,
    };
  });
}

export function filterRecentUnique(items = [], { windowMs = 24 * 60 * 60 * 1000, now = new Date() } = {}) {
  const nowMs = typeof now === 'function' ? now().getTime() : new Date(now).getTime();
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const row = item?.json && typeof item.json === 'object' ? item.json : (item || {});
    const title = String(row.titular || '').trim();
    const link = String(row.link || '').trim();
    const source = String(row.fuente || '').trim();
    const published = Date.parse(row.fecha_publicacion || '');
    const isRecent = Number.isNaN(published) ? true : nowMs - published <= windowMs;
    const dedupeKey = `${row.jugador || ''}::${link || `${title}::${source}`}`;
    if (!title || !link || !isRecent || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    output.push(row);
  }
  return output;
}

export function annotateGooglePositions(items = []) {
  const counters = new Map();
  return items.map((row) => {
    const source = row?.json && typeof row.json === 'object' ? row.json : (row || {});
    const key = `${source.seleccion || ''}||${source.jugador || ''}`;
    const nextPosition = (counters.get(key) || 0) + 1;
    counters.set(key, nextPosition);
    return { ...source, google_position: nextPosition };
  });
}

function normalizeForMatch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitFootballNews(items = []) {
  const rows = items.map((raw) => {
    const row = raw?.json && typeof raw.json === 'object' ? raw.json : (raw || {});
    const combined = normalizeForMatch([row.jugador, row.titular, row.fuente, row.snippet].join(' '));
    const player = normalizeForMatch(row.jugador || '');
    const hasPlayer = Boolean(player) && combined.includes(player);
    const matchedSignals = FOOTBALL_KEYWORDS.filter((keyword) => combined.includes(normalizeForMatch(keyword)));
    const passDirect = hasPlayer && matchedSignals.length > 0;
    return {
      ...row,
      pass_direct: passDirect,
      football_signals: matchedSignals.slice(0, 6).join(' || '),
      ...(passDirect ? { classification_source: 'heuristic' } : {}),
    };
  });
  return {
    direct: rows.filter((row) => row.pass_direct === true),
    ambiguous: rows.filter((row) => row.pass_direct !== true),
  };
}

export function buildBatchClassificationPrompt(rows = []) {
  const compactRows = rows.map((row) => ({
    id_noticia: row.id_noticia,
    jugador: row.jugador,
    titular: row.titular,
    fuente: row.fuente,
    snippet: String(row.snippet || '').slice(0, 280),
  }));
  return [
    'Clasifica noticias y responde SOLO con JSON valido.',
    '',
    'Objetivo: determinar si cada noticia pertenece claramente al ambito del futbol profesional o de selecciones.',
    '',
    'Regla de decision:',
    '- true: si la noticia trata sobre futbol, futbolistas, clubes, selecciones, entrenadores, partidos, torneos, fichajes, lesiones deportivas, convocatorias o rendimiento futbolistico.',
    '- false: si la noticia NO deja claro el contexto futbolistico.',
    '',
    'No evalues si la noticia es buena o mala. Solo si es de futbol o no.',
    '',
    'Devuelve este formato exacto:',
    '{',
    '  "results": [',
    '    {"id_noticia": "...", "es_futbol": true, "razon": "breve"}',
    '  ]',
    '}',
    '',
    'Noticias a clasificar:',
    JSON.stringify(compactRows, null, 2),
  ].join('\n');
}

export function buildDiscoverySummary({ runId = null, upserted = [], received = 0, valid = 0 } = {}) {
  const rows = Array.isArray(upserted) ? upserted : [];
  return {
    status: 'ok',
    mode: runId ? 'staging' : 'live',
    run_id: runId,
    persisted: rows.length,
    valid,
    received,
    sample: rows.slice(0, 5).map((row) => ({
      jugador: row.jugador,
      titular: row.titular,
      fuente: row.fuente,
      source: row.classification_source || 'unknown',
    })),
    note: runId
      ? 'Discovery staged safely. Current approval universe remains untouched until promote.'
      : 'Discovery rebuilt the live news universe.',
  };
}

export function extractModelText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractModelText(item);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.candidates)) {
      for (const candidate of value.candidates) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts)) continue;
        const text = parts
          .filter((part) => !part?.thought)
          .map((part) => part?.text || '')
          .join('')
          .trim();
        if (text) return text;
      }
    }
    if (Array.isArray(value.choices)) {
      const choice = value.choices[0];
      if (choice?.message?.content) return choice.message.content;
      if (choice?.text) return choice.text;
    }
    for (const key of ['content', 'text', 'output', 'response', 'message']) {
      if (key in value) {
        const found = extractModelText(value[key]);
        if (found) return found;
      }
    }
    for (const nested of Object.values(value)) {
      const found = extractModelText(nested);
      if (found) return found;
    }
  }
  return '';
}

export function parseModelJson(text) {
  const cleaned = String(text || '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue with lenient extraction
  }
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('No se pudo parsear JSON desde la respuesta del modelo');
}
