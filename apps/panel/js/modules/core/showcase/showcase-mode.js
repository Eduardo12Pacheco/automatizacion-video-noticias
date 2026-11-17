/**
 * Showcase mode.
 *
 * A visitor can open `/?showcase=1` (or `?demo=1`) and click through the panel
 * without Docker, a GPU, seeded Postgres or API keys. The panel keeps using its
 * real API clients; a local fetch interceptor answers every service prefix the
 * panel talks to with fictional fixtures, so no request leaves the browser.
 *
 * Deterministic screen states are available for the visual QA suite:
 *   ?showcase=1&state=empty   -> every collection is empty
 *   ?showcase=1&state=error   -> every data read returns a JSON 503
 *   ?showcase=1&state=slow    -> data reads resolve after a short delay
 */
const SHOWCASE_USERS = Object.freeze([
  { user_id: 'u-admin', email: 'admin@example.local', display_name: 'Demo Admin', roles: ['admin'], status: 'active', last_login_at: '2026-11-12T09:00:00.000Z' },
  { user_id: 'u-editor', email: 'editor@example.local', display_name: 'Demo Editor', roles: ['editor'], status: 'active', last_login_at: '2026-11-12T08:45:00.000Z' },
  { user_id: 'u-viewer', email: 'viewer@example.local', display_name: 'Demo Observer', roles: ['viewer'], status: 'disabled', last_login_at: null },
]);

const PENDING_ITEMS = Object.freeze([
  {
    cluster_id: 'demo-cluster-1',
    tema_principal: 'La selección define su once para el próximo partido',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    cantidad_fuentes: 7,
    avg: 0.82,
    resumen_cluster: 'Tres medios locales coinciden en la probable alineación y el rol de la mitad de cancha.',
    tag_editorial: 'Fútbol',
  },
  {
    cluster_id: 'demo-cluster-2',
    tema_principal: 'Récord de ventas de camisetas conmemorativas',
    seleccion: 'Valdoria',
    jugador: 'Leonel Márquez',
    cantidad_fuentes: 4,
    avg: 0.74,
    resumen_cluster: 'La tienda oficial agotó el stock en pocas horas y los revendedores duplicaron el precio.',
    tag_editorial: 'Negocio',
  },
  {
    cluster_id: 'demo-cluster-3',
    tema_principal: 'Un juvenil sorprende en el entrenamiento abierto',
    seleccion: 'Montelia',
    jugador: 'Jhon Duarte',
    cantidad_fuentes: 3,
    avg: 0.69,
    resumen_cluster: 'El cuerpo técnico probó una dupla ofensiva distinta pensando en el próximo amistoso.',
    tag_editorial: 'Selecciones',
  },
]);

const SCRIPTS = Object.freeze([
  {
    draft_id: 'demo-draft-1',
    cluster_id: 'demo-cluster-1',
    id_noticia: 'demo-news-1',
    titulo_noticia: 'Aurenia prepara un mediocampo más dinámico',
    jugador: 'Nicolás Arbelo',
    seleccion: 'Aurenia',
    estado_guion: 'borrador',
    guion_draft: 'Aurenia ajusta su mediocampo para el próximo partido. Nicolás Arbelo vuelve a ser el eje del equipo. El cuerpo técnico probó una salida más rápida por las bandas.',
    guion_editado: '',
    guion_pronunciacion: 'Aurenia ajusta su mediocampo para el próximo partido. Nicolás Arbelo vuelve a ser el eje del equipo.',
    cantidad_fuentes: 7,
  },
  {
    draft_id: 'demo-draft-2',
    cluster_id: 'demo-cluster-2',
    id_noticia: 'demo-news-2',
    titulo_noticia: 'La camiseta conmemorativa agota su stock',
    jugador: 'Leonel Márquez',
    seleccion: 'Valdoria',
    estado_guion: 'borrador',
    guion_draft: 'La camiseta conmemorativa se agotó en pocas horas. La demanda superó cualquier pronóstico y los revendedores ya duplicaron el precio.',
    guion_editado: '',
    guion_pronunciacion: 'La camiseta conmemorativa se agotó en pocas horas.',
    cantidad_fuentes: 4,
  },
]);

const VIDEO_PROJECTS = Object.freeze([
  {
    draft_id: 'demo-project-1',
    titulo: 'Aurenia prepara un mediocampo más dinámico',
    jugador: 'Nicolás Arbelo',
    seleccion: 'Aurenia',
    status: 'draft',
    created_at: '2026-11-12T09:05:00.000Z',
    updated_at: '2026-11-12T09:20:00.000Z',
    thumbnail_url: '',
    rows: [],
    images: [],
  },
]);

const RADAR_HISTORY = Object.freeze([
  {
    job_id: 'demo-radar-job-1',
    status: 'succeeded',
    title: 'Entrevista a Nicolás Arbelo',
    selected_countries: ['aurenia'],
    detected_language: 'es',
    mention_count: 4,
    artifacts: { export_txt: true },
  },
]);

const MONITOR_CARDS = Object.freeze([
  {
    video_id: 'demo-video-1',
    radar_job_id: 'demo-radar-job-1',
    title: 'Rueda de prensa: la previa del clásico',
    channel_name: 'Demo Sports News',
    target_country: 'aurenia',
    target_country_label: 'Aurenia',
    status: 'transcrito',
    published_at: '2026-11-12T08:10:00.000Z',
    mention_counts: [
      { label: 'Nicolás Arbelo', count: 3 },
      { label: 'Aurenia', count: 1 },
    ],
  },
  {
    video_id: 'demo-video-2',
    radar_job_id: '',
    title: 'Análisis táctico del fin de semana',
    channel_name: 'Demo Wire',
    target_country: 'valdoria',
    target_country_label: 'Valdoria',
    status: 'monitor',
    published_at: '2026-11-12T07:40:00.000Z',
    mention_counts: [],
  },
]);

const SUBTITLE_SESSIONS = Object.freeze([
  { id: 'demo-subtitle-1', display_name: 'Previa del clásico', status: 'ready', created_at: '2026-11-12T08:30:00.000Z' },
]);

const CONNECTORS = Object.freeze([
  { id: 'repository', port: 'RepositoryPort', adapter: 'postgres', status: 'local', detail: 'Postgres 16', env: ['DATABASE_URL'], last_checked_at: null, testable: true },
  { id: 'blob-storage', port: 'BlobStoragePort', adapter: 'fs', status: 'local', detail: './data/blobs', env: ['BLOB_ROOT'], last_checked_at: null, testable: true },
  { id: 'news-source', port: 'NewsSourcePort', adapter: 'rss', status: 'local', detail: 'Public RSS feeds', env: ['NEWS_DISCOVERY_FEED_URL'], last_checked_at: null, testable: true },
  { id: 'article-extractor', port: 'ArticleExtractorPort', adapter: 'trafilatura', status: 'local', detail: 'Local extraction', env: ['ARTICLE_EXTRACTOR'], last_checked_at: null, testable: true },
  { id: 'llm', port: 'LLMPort', adapter: 'demo', status: 'local', detail: 'Deterministic demo model', env: ['LLM'], last_checked_at: null, testable: true },
  { id: 'image-search', port: 'ImageSearchPort', adapter: 'searxng', status: 'local', detail: 'Local SearXNG', env: ['IMAGE_SEARCH'], last_checked_at: null, testable: true },
  { id: 'tts', port: 'TTSPort', adapter: 'demo', status: 'local', detail: 'Demo worker', env: ['TTS'], last_checked_at: null, testable: true },
  { id: 'asr', port: 'ASRPort', adapter: 'demo', status: 'local', detail: 'Demo worker', env: ['ASR'], last_checked_at: null, testable: true },
  { id: 'translation', port: 'TranslationPort', adapter: 'demo', status: 'local', detail: 'Demo worker', env: ['TRANSLATION'], last_checked_at: null, testable: true },
  { id: 'video-renderer', port: 'VideoRendererPort', adapter: 'demo', status: 'local', detail: 'Demo worker', env: ['RENDERER'], last_checked_at: null, testable: true },
  { id: 'channel-feed', port: 'ChannelFeedPort', adapter: 'rss', status: 'local', detail: 'Public channel feeds', env: [], last_checked_at: null, testable: true },
  { id: 'media-download', port: 'MediaDownloadPort', adapter: 'worker', status: 'local', detail: 'ASR worker', env: ['MEDIA_DOWNLOAD'], last_checked_at: null, testable: true },
  { id: 'document-export', port: 'DocumentExportPort', adapter: 'local', status: 'local', detail: 'python-docx', env: ['DOCUMENT_EXPORT'], last_checked_at: null, testable: true },
  { id: 'workflow', port: 'WorkflowTriggerPort', adapter: 'disabled', status: 'disabled', detail: 'Off by default', env: ['WORKFLOW'], last_checked_at: null, testable: false },
  { id: 'notification', port: 'NotificationPort', adapter: 'console', status: 'local', detail: 'Console notifications', env: ['NOTIFY'], last_checked_at: null, testable: true },
  { id: 'auth', port: 'AuthPort', adapter: 'local', status: 'local', detail: 'Local sessions', env: [], last_checked_at: null, testable: true },
]);

const GATEWAY_EVENTS = Object.freeze([
  {
    event_id: 'demo-event-1',
    kind: 'audit',
    status: 'success',
    service: 'gateway',
    actor: { display_name: 'Demo Admin' },
    message: 'Approval decision applied',
    correlation_id: 'demo-corr-1',
    timestamp: '2026-11-12T09:01:00.000Z',
    context: { route: '/webhook/approval/decision/v2' },
  },
  {
    event_id: 'demo-event-2',
    kind: 'error',
    status: 'failure',
    service: 'renderer',
    actor: { display_name: 'Demo Editor' },
    message: 'Render retried once',
    correlation_id: 'demo-corr-2',
    timestamp: '2026-11-12T09:03:00.000Z',
    context: { route: '/remotion/render' },
  },
]);

const PRESENCE = Object.freeze({
  sessions: [
    { actorLabel: 'Demo Admin', mode: 'admin', area: 'demo', resourceLabel: 'demo-cluster-1', lastActivityAt: '2026-11-12T09:05:00.000Z' },
    { actorLabel: 'Demo Editor', mode: 'editor', area: 'demo', resourceLabel: 'demo-subtitle-1', lastActivityAt: '2026-11-12T09:02:00.000Z' },
  ],
});

const SERVICE_PREFIXES = Object.freeze([
  '/panel/',
  '/radar/',
  '/monitor/',
  '/tts/',
  '/subtitles/',
  '/remotion/',
  '/approval/',
  '/webhook/',
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function showcaseScenario(locationLike = globalThis.location) {
  try {
    const scenario = new URLSearchParams(locationLike?.search || '').get('state') || '';
    return ['empty', 'error', 'slow'].includes(scenario) ? scenario : 'default';
  } catch {
    return 'default';
  }
}

export function isShowcasePath(input) {
  const pathname = pathOf(input);
  return SERVICE_PREFIXES.some((prefix) => matches(pathname, prefix.replace(/\/$/, '')));
}

function pathOf(input) {
  const raw = typeof input === 'string' ? input : input?.url || '';
  try {
    return new URL(raw, globalThis.location?.origin || 'http://localhost').pathname;
  } catch {
    return raw;
  }
}

function matches(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function emptyCollectionResponse(pathname, method) {
  if (pathname.startsWith('/panel/read-models/approval/pending')) return jsonResponse({ items: [] });
  if (pathname.startsWith('/panel/read-models/approval/queue')) return jsonResponse({ items: [] });
  if (pathname.startsWith('/panel/read-models/approval/topic')) return jsonResponse({ item: { ...PENDING_ITEMS[0], sources: [] } });
  if (pathname.startsWith('/panel/read-models/approval/search-refresh/status')) return jsonResponse({ status: 'succeeded', clusters_created: 0 });
  if (pathname.startsWith('/panel/read-models/scripts/drafts')) return jsonResponse({ drafts: [] });
  if (pathname.startsWith('/panel/read-models/video-projects')) return jsonResponse({ projects: [] });
  if (pathname.startsWith('/panel/read-models/audio/jobs')) return jsonResponse({ jobs: [] });
  if (pathname.startsWith('/panel/read-models/subtitles')) return jsonResponse({ sessions: [], items: [], ok: true, status: 'ready' });
  if (pathname.startsWith('/panel/read-models/gateway/presence')) return jsonResponse({ sessions: [], resources: [], ttl_seconds: 30 });
  if (pathname.startsWith('/panel/read-models/gateway/events')) return jsonResponse({ events: [], items: [] });
  if (pathname.startsWith('/panel/admin/users')) return jsonResponse({ ok: true, users: [] });
  if (pathname.startsWith('/panel/admin/roles')) return jsonResponse({ ok: true, roles: ['admin', 'editor', 'viewer'] });
  if (pathname.startsWith('/panel/connectors')) return jsonResponse({ connectors: [] });
  if (pathname.startsWith('/radar/api/radar/jobs')) return jsonResponse({ items: [] });
  if (pathname.startsWith('/radar/api/radar/health')) return jsonResponse({ status: 'ok' });
  if (pathname.startsWith('/monitor/api/monitor/cards')) return jsonResponse({ items: [], pagination: { total: 0, limit: 200, offset: 0, has_more: false } });
  if (pathname.startsWith('/monitor/api/monitor/summary')) return jsonResponse({ items: [], basura_count: 0 });
  if (pathname.startsWith('/monitor/api/monitor/basura')) return jsonResponse({ items: [], total: 0, pagination: { total: 0, limit: 200, offset: 0, has_more: false } });
  if (pathname.startsWith('/tts/api/tts/jobs')) return jsonResponse({ jobs: [] });
  if (pathname.startsWith('/subtitles/api/subtitles/health')) return jsonResponse({ ok: true, status: 'ready' });
  if (pathname.startsWith('/subtitles/api/subtitles/sessions')) return jsonResponse({ sessions: [], items: [] });
  return method === 'GET' ? jsonResponse({ ok: true }) : jsonResponse({ ok: true, status: 'queued' });
}

export async function createShowcaseResponse(url, options = {}, { scenario = showcaseScenario() } = {}) {
  const pathname = pathOf(url);
  const method = String(options?.method || 'GET').toUpperCase();
  const isRead = method === 'GET';

  if (scenario === 'slow' && isRead && !pathname.endsWith('/panel/session') && !pathname.endsWith('/panel/bootstrap')) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (pathname === '/panel/session') {
    if (new URLSearchParams(globalThis.location?.search || '').get('login') === 'error') {
      return jsonResponse({ error: 'anonymous', message: 'Showcase anonymous scenario' }, 401);
    }
    return jsonResponse({
      user: { user_id: 'u-admin', email: 'admin@example.local', display_name: 'Demo Admin' },
      roles: ['admin'],
      session_id: 'showcase-session',
    });
  }
  if (pathname === '/panel/login' && method === 'POST') {
    if (new URLSearchParams(globalThis.location?.search || '').get('login') === 'error') {
      return jsonResponse({ error: 'invalid_credentials', message: 'Showcase invalid credentials' }, 401);
    }
    return jsonResponse({ ok: true, user: { user_id: 'u-admin', display_name: 'Demo Admin' }, roles: ['admin'] });
  }
  if (pathname === '/panel/logout') return jsonResponse({ ok: true });
  if (pathname === '/panel/bootstrap') {
    return jsonResponse({
      api_origin: globalThis.location?.origin || '',
      app_version: 'showcase',
      run_mode: 'demo',
      feature_flags: { localWorkflows: true },
      routes: { approval: '/panel/read-models/approval', audio: '/panel/read-models/audio' },
    });
  }

  if (scenario === 'error' && isRead) {
    const status = pathname.startsWith('/panel/connectors') ? 503 : 503;
    return jsonResponse({ error: 'showcase_unavailable', message: 'Showcase error scenario' }, status);
  }
  if (scenario === 'empty') {
    return emptyCollectionResponse(pathname, method);
  }

  if (pathname === '/panel/read-models/approval/pending') return jsonResponse({ items: PENDING_ITEMS });
  if (pathname === '/panel/read-models/approval/queue') return jsonResponse({ items: [] });
  if (pathname.startsWith('/panel/read-models/approval/topic')) {
    const clusterId = new URL(url, 'http://localhost').searchParams.get('cluster_id') || 'demo-cluster-1';
    const item = PENDING_ITEMS.find((row) => row.cluster_id === clusterId) || PENDING_ITEMS[0];
    return jsonResponse({
      item: {
        ...item,
        sources: [
          { id_noticia: 'demo-source-1', titulo: item.tema_principal, url: 'https://example.local/news/1', seleccion: item.seleccion, jugador: item.jugador, fuente: 'Demo Sports News' },
          { id_noticia: 'demo-source-2', titulo: `${item.jugador} entrenó con el grupo`, url: 'https://example.local/news/2', seleccion: item.seleccion, jugador: item.jugador, fuente: 'Demo Wire' },
        ],
      },
    });
  }
  if (pathname === '/panel/read-models/scripts/drafts') return jsonResponse({ drafts: SCRIPTS });
  if (pathname === '/panel/read-models/video-projects') {
    const draftId = new URL(url, 'http://localhost').searchParams.get('draft_id');
    if (draftId) {
      const project = VIDEO_PROJECTS.find((item) => item.draft_id === draftId) || VIDEO_PROJECTS[0];
      return jsonResponse({ project: { ...project, image_candidates: [] } });
    }
    return jsonResponse({ projects: VIDEO_PROJECTS });
  }
  if (pathname === '/panel/read-models/audio/jobs') return jsonResponse({ jobs: [] });
  if (pathname === '/panel/read-models/subtitles/health') return jsonResponse({ ok: true, status: 'ready' });
  if (pathname.startsWith('/panel/read-models/subtitles/sessions')) return jsonResponse({ sessions: SUBTITLE_SESSIONS, items: SUBTITLE_SESSIONS });
  if (pathname === '/panel/read-models/gateway/presence') {
    return jsonResponse({ ...PRESENCE, resources: [], ttl_seconds: 30 });
  }
  if (pathname === '/panel/read-models/gateway/events') return jsonResponse({ events: GATEWAY_EVENTS, items: GATEWAY_EVENTS });
  if (pathname === '/panel/connectors') return jsonResponse({ connectors: CONNECTORS });
  if (pathname.startsWith('/panel/connectors/') && pathname.endsWith('/test')) {
    return jsonResponse({ ok: true, result: { ok: true, status: 'local', message: 'Showcase adapter ready', checked_at: new Date().toISOString() } });
  }
  if (pathname === '/panel/admin/users') {
    if (method === 'POST') return jsonResponse({ ok: true, user: SHOWCASE_USERS[0] }, 201);
    return jsonResponse({ ok: true, users: SHOWCASE_USERS });
  }
  if (pathname.startsWith('/panel/admin/users/')) return jsonResponse({ ok: true, user: SHOWCASE_USERS[0] });
  if (pathname === '/panel/admin/roles') return jsonResponse({ ok: true, roles: ['admin', 'editor', 'viewer'] });

  if (pathname === '/radar/api/radar/health') return jsonResponse({ status: 'ok', service: 'showcase' });
  if (pathname === '/radar/api/radar/jobs' && method === 'GET') return jsonResponse({ items: RADAR_HISTORY });
  if (pathname === '/radar/api/radar/jobs' && method === 'POST') {
    return jsonResponse({ job_id: 'demo-radar-job-new', status: 'queued', title: 'Demo research', progress: { percent: 0, stage: 'queued' } });
  }
  if (/^\/radar\/api\/radar\/jobs\/[^/]+$/.test(pathname)) {
    return jsonResponse({ job_id: pathname.split('/').pop(), status: 'succeeded', progress: { percent: 100 }, mention_count: 2 });
  }
  if (/^\/radar\/api\/radar\/jobs\/[^/]+\/summary$/.test(pathname)) {
    return jsonResponse({ items: [{ label: 'Nicolás Arbelo', count: 2 }, { label: 'Aurenia', count: 1 }] });
  }
  if (/^\/radar\/api\/radar\/jobs\/[^/]+\/export\.txt$/.test(pathname)) {
    return new Response('(00:01) Nicolás Arbelo — entrevista de demostración.\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (pathname === '/monitor/api/monitor/cards') {
    return jsonResponse({ items: MONITOR_CARDS, pagination: { total: MONITOR_CARDS.length, limit: 200, offset: 0, has_more: false } });
  }
  if (pathname === '/monitor/api/monitor/summary') return jsonResponse({ items: [], basura_count: 0 });
  if (pathname === '/monitor/api/monitor/basura') return jsonResponse({ items: [], total: 0, pagination: { total: 0, limit: 200, offset: 0, has_more: false } });
  if (pathname === '/monitor/api/monitor/card-dismissals') return jsonResponse({ ok: true });

  if (pathname.startsWith('/tts/api/tts/jobs') && method === 'GET') return jsonResponse({ jobs: [] });
  if (pathname === '/tts/api/tts/jobs' && method === 'POST') {
    return jsonResponse({ job_id: 'demo-tts-job', status: 'queued', progress: { percent: 0, stage: 'queued' } });
  }
  if (pathname.startsWith('/tts/api/tts/jobs/')) return jsonResponse({ job_id: 'demo-tts-job', status: 'done', progress: { percent: 100, stage: 'done' } });

  if (pathname === '/subtitles/api/subtitles/health') return jsonResponse({ ok: true, status: 'ready' });
  if (pathname === '/subtitles/api/subtitles/sessions' && method === 'GET') return jsonResponse({ sessions: SUBTITLE_SESSIONS, items: SUBTITLE_SESSIONS });
  if (pathname === '/subtitles/api/subtitles/sessions' && method === 'POST') return jsonResponse({ session: SUBTITLE_SESSIONS[0], ...SUBTITLE_SESSIONS[0] }, 201);
  if (pathname.startsWith('/subtitles/api/subtitles/sessions/')) {
    const suffix = pathname.split('/').pop();
    if (suffix === 'segments') return jsonResponse({ segments: [] });
    if (suffix === 'render') return jsonResponse({ status: 'ready', ok: true });
    if (suffix === 'download') return jsonResponse({ ok: true, url: '' });
    return jsonResponse({ ...SUBTITLE_SESSIONS[0], segments: [] });
  }

  if (pathname.startsWith('/panel/read-models/approval/search-refresh/status')) return jsonResponse({ status: 'succeeded', clusters_created: 2 });
  if (pathname === '/panel/presence/heartbeat') return jsonResponse({ ok: true });

  if (!isRead) return jsonResponse({ ok: true, status: 'queued' });

  return jsonResponse({ error: 'not_found', message: 'Showcase route unavailable' }, 404);
}

export function isShowcaseRequested({ locationLike = globalThis.location, storage = globalThis.localStorage } = {}) {
  try {
    const params = new URLSearchParams(locationLike?.search || '');
    if (params.get('showcase') === '1' || params.get('demo') === '1') return true;
    return storage?.getItem?.('newsroom-showcase') === '1';
  } catch {
    return false;
  }
}

export function installShowcaseMode({ windowRef = globalThis.window, locationLike = globalThis.location } = {}) {
  const state = { user: { user_id: 'u-admin', email: 'admin@example.local', display_name: 'Demo Admin' }, roles: ['admin'], session_id: 'showcase-session' };
  const anonymous = new URLSearchParams(locationLike?.search || '').get('login') === 'error';
  globalThis.__CONTROL_PANEL_SESSION__ = anonymous ? { status: 'anonymous' } : { status: 'ok', ...state };
  globalThis.__CONTROL_PANEL_BOOTSTRAP__ = {
    api_origin: locationLike?.origin || '',
    app_version: 'showcase',
    run_mode: 'demo',
    feature_flags: { localWorkflows: true },
    asset_base_url: './assets',
    routes: { approval: '/panel/read-models/approval' },
  };

  const originalFetch = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = async (input, options = {}) => {
    if (isShowcasePath(input)) {
      return createShowcaseResponse(input, options);
    }
    if (originalFetch) return originalFetch(input, options);
    throw new Error('showcase_network_disabled');
  };

  // Showcase mode is labelled by the single persistent demo badge in the app
  // header (see syncRunModeChrome); it deliberately adds no second indicator.
  windowRef?.document?.documentElement?.setAttribute?.('data-showcase', 'true');
  return state;
}
