/**
 * Showcase mode (S5.9).
 *
 * A visitor can open `/?showcase=1` (or `?demo=1`) and click through the panel
 * without Docker, a GPU, seeded Postgres or API keys. The panel keeps using
 * its real API clients; a local fetch interceptor answers those paths with
 * fictional fixtures so no network request leaves the browser.
 */
const SHOWCASE_USERS = Object.freeze([
  { user_id: 'u-admin', email: 'admin@example.local', display_name: 'Demo Admin', roles: ['admin'], status: 'active', last_login_at: '2026-11-12T09:00:00.000Z' },
  { user_id: 'u-editor', email: 'editor@example.local', display_name: 'Demo Editor', roles: ['editor'], status: 'active', last_login_at: '2026-11-12T08:45:00.000Z' },
  { user_id: 'u-viewer', email: 'viewer@example.local', display_name: 'Demo Viewer', roles: ['viewer'], status: 'disabled', last_login_at: null },
]);

const PENDING_ITEMS = Object.freeze([
  {
    cluster_id: 'demo-cluster-1',
    tema_principal: 'La selección define su once para el próximo partido',
    seleccion: 'Aurenia',
    jugador: 'Nicolás Andrade',
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
    jugador: 'Nicolás Andrade',
    seleccion: 'Aurenia',
    estado_guion: 'borrador',
    guion_draft: 'Aurenia ajusta su mediocampo para el próximo partido. Nicolás Andrade vuelve a ser el eje del equipo. El cuerpo técnico probó una salida más rápida por las bandas.',
    guion_editado: '',
    guion_pronunciacion: 'Aurenia ajusta su mediocampo para el próximo partido. Nicolás Andrade vuelve a ser el eje del equipo.',
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
    jugador: 'Nicolás Andrade',
    seleccion: 'Aurenia',
    status: 'draft',
    created_at: '2026-11-12T09:05:00.000Z',
    updated_at: '2026-11-12T09:20:00.000Z',
    thumbnail_url: '',
    rows: [],
    images: [],
  },
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

function createShowcaseResponse(url, options = {}) {
  const pathname = pathOf(url);
  const method = String(options?.method || 'GET').toUpperCase();

  if (pathname === '/panel/session') {
    return jsonResponse({
      user: { user_id: 'u-admin', email: 'admin@example.local', display_name: 'Demo Admin' },
      roles: ['admin'],
      session_id: 'showcase-session',
    });
  }
  if (pathname === '/panel/login' && method === 'POST') {
    return jsonResponse({ ok: true, user: { user_id: 'u-admin', display_name: 'Demo Admin' }, roles: ['admin'] });
  }
  if (pathname === '/panel/logout') return jsonResponse({ ok: true });
  if (pathname === '/panel/bootstrap') {
    return jsonResponse({
      api_origin: globalThis.location?.origin || '',
      app_version: 'showcase',
      routes: { approval: '/panel/read-models/approval', audio: '/panel/read-models/audio' },
    });
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
  if (pathname === '/panel/read-models/video-projects') return jsonResponse({ projects: VIDEO_PROJECTS });
  if (pathname === '/panel/read-models/audio/jobs') return jsonResponse({ jobs: [] });
  if (pathname === '/panel/read-models/subtitles/health') return jsonResponse({ ok: true, status: 'ready' });
  if (pathname.startsWith('/panel/read-models/subtitles/sessions')) return jsonResponse({ sessions: [] });
  if (pathname === '/panel/read-models/gateway/presence') {
    return jsonResponse({
      sessions: [
        { actorLabel: 'Demo Admin', mode: 'admin', area: 'Approval', resourceLabel: 'demo-cluster-1', lastActivityAt: new Date().toISOString() },
      ],
    });
  }
  if (pathname === '/panel/read-models/gateway/events') return jsonResponse({ events: [], items: [] });
  if (pathname === '/panel/admin/users') {
    if (method === 'POST') return jsonResponse({ ok: true, user: SHOWCASE_USERS[0] }, 201);
    return jsonResponse({ ok: true, users: SHOWCASE_USERS });
  }
  if (pathname.startsWith('/panel/admin/users/')) return jsonResponse({ ok: true, user: SHOWCASE_USERS[0] });
  if (pathname === '/panel/admin/roles') return jsonResponse({ ok: true, roles: ['admin', 'editor', 'viewer'] });
  if (pathname.includes('/search-refresh/status')) return jsonResponse({ status: 'succeeded', clusters_created: 2 });
  if (method !== 'GET' && (pathname.includes('/approval/') || pathname.includes('/scripts/') || pathname.includes('/video-projects'))) {
    return jsonResponse({ ok: true, status: 'queued' });
  }
  return jsonResponse({ ok: true });
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
  globalThis.__CONTROL_PANEL_SESSION__ = { status: 'ok', ...state };
  globalThis.__CONTROL_PANEL_BOOTSTRAP__ = {
    api_origin: locationLike?.origin || '',
    app_version: 'showcase',
    routes: { approval: '/panel/read-models/approval' },
  };

  const originalFetch = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = async (input, options = {}) => {
    const pathname = pathOf(input);
    if (pathname.startsWith('/panel/')) {
      return createShowcaseResponse(input, options);
    }
    if (originalFetch) return originalFetch(input, options);
    throw new Error('showcase_network_disabled');
  };

  windowRef?.document?.documentElement?.setAttribute?.('data-showcase', 'true');
  const badge = windowRef?.document?.createElement?.('div');
  if (badge) {
    badge.className = 'showcase-badge';
    badge.textContent = 'Showcase · datos ficticios';
    badge.setAttribute('role', 'status');
    windowRef.document.body?.appendChild?.(badge);
  }
  return state;
}
