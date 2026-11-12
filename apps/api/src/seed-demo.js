import { randomBytes } from 'node:crypto';

import { createAuthService } from './auth.js';

const DEMO_STORY = Object.freeze({
  pendingClusterId: 'demo-cluster-pending',
  draftClusterId: 'demo-cluster-draft',
  approvedNewsId: 'demo-news-draft',
  pendingNewsId: 'demo-news-pending',
  draftId: 'draft-demo-news-draft',
  videoProjectId: 'demo-project-1',
});

const DEMO_NEWS = Object.freeze([
  {
    id_noticia: DEMO_STORY.approvedNewsId,
    cluster_id: DEMO_STORY.draftClusterId,
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    titular: 'Arbelo vuelve a entrenar con el grupo',
    fuente: 'Demo Sports News',
    fecha_publicacion: '2026-11-10T09:00:00.000Z',
    link: 'http://panel/assets/demo/andrade.html',
    snippet: 'El mediocampista completó la sesión y quedó disponible para el próximo partido.',
    tema_principal: 'Arbelo vuelve a entrenar con el grupo',
    google_position: 1,
    estado_revision: 'pendiente',
  },
  {
    id_noticia: DEMO_STORY.pendingNewsId,
    cluster_id: DEMO_STORY.pendingClusterId,
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    titular: 'El cuerpo técnico prueba una variante en el mediocampo',
    fuente: 'Demo Wire',
    fecha_publicacion: '2026-11-10T10:00:00.000Z',
    link: 'http://panel/assets/demo/variant.html',
    snippet: 'La práctica del martes mostró una salida distinta por las bandas.',
    tema_principal: 'Variante táctica en el mediocampo',
    google_position: 2,
    estado_revision: 'pendiente',
  },
]);

const DEMO_CLUSTERS = Object.freeze([
  {
    cluster_id: DEMO_STORY.draftClusterId,
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    tema_principal: 'Arbelo vuelve a entrenar con el grupo',
    resumen_cluster: 'Dos fuentes locales confirman el regreso del mediocampista a los entrenamientos.',
    tag_editorial: 'Selecciones',
    avg_google_position: 1.4,
    estado_revision: 'pendiente',
    fecha_creacion_cluster: '2026-11-10T09:05:00.000Z',
    sources: [{ id_noticia: DEMO_STORY.approvedNewsId, source_order: 0 }],
  },
  {
    cluster_id: DEMO_STORY.pendingClusterId,
    seleccion: 'Aurenia',
    jugador: 'Nicolás Arbelo',
    tema_principal: 'Variante táctica en el mediocampo',
    resumen_cluster: 'El cuerpo técnico probó una dupla distinta pensando en el próximo amistoso.',
    tag_editorial: 'Selecciones',
    avg_google_position: 2.1,
    estado_revision: 'pendiente',
    fecha_creacion_cluster: '2026-11-10T10:05:00.000Z',
    sources: [{ id_noticia: DEMO_STORY.pendingNewsId, source_order: 0 }],
  },
]);

const DEMO_DRAFT_TEXT = [
  'Aurenia ajusta su mediocampo para el próximo partido.',
  'Nicolás Arbelo completó la práctica y vuelve a ser el eje del equipo.',
  'El cuerpo técnico probó una salida más rápida por las bandas.',
].join(' ');

const DEMO_PROJECT_SEGMENTS = Object.freeze([
  {
    id: 'demo-segment-1',
    start_ms: 0,
    end_ms: 4000,
    source_text: DEMO_DRAFT_TEXT,
    translated_text: 'Aurenia ajusta su mediocampo para el próximo partido.',
    style: {
      font_size: 110,
      font_family: 'Khand',
      color: '#FFFFFF',
      align: 'left',
      max_width_px: 1080,
    },
  },
]);

function requirePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw new Error('a demo password of at least 8 characters is required');
  return value;
}

async function ensureDemoUser({ repository, email, displayName, password, roles }) {
  const auth = createAuthService({ repository });
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('demo user email is required');
  const existing = await repository.getUserByEmail(normalized);
  if (existing) {
    const mergedRoles = [...new Set([...(existing.roles || []), ...roles])].sort();
    const rolesChanged = mergedRoles.length !== (existing.roles || []).length;
    const user = rolesChanged
      ? await repository.setUserRoles(existing.user_id, mergedRoles)
      : existing;
    return { created: false, rolesChanged, user };
  }
  const user = await auth.createUser({
    email: normalized,
    display_name: displayName || normalized,
    password,
    roles,
  });
  return { created: true, rolesChanged: true, user };
}

/**
 * Seeds the keyless demo: fictional editor/viewer users, a pending story for
 * the approval UI and one complete story (draft + video project). It is
 * idempotent so re-running the install does not duplicate rows or reset an
 * operator's password.
 */
export async function seedDemoData({
  repository = null,
  password,
  editorEmail = 'editor@example.local',
  viewerEmail = 'viewer@example.local',
  logger = console,
} = {}) {
  if (!repository) throw new Error('a repository is required');
  const demoPassword = requirePassword(password);

  if (typeof repository.migrate === 'function') await repository.migrate();

  const editor = await ensureDemoUser({
    repository,
    email: editorEmail,
    displayName: 'Demo Editor',
    password: demoPassword,
    roles: ['editor'],
  });
  const viewer = await ensureDemoUser({
    repository,
    email: viewerEmail,
    displayName: 'Demo Viewer',
    password: demoPassword,
    roles: ['viewer'],
  });

  // Clusters must exist before news rows because noticias_raw.cluster_id is a
  // foreign key. Persist again after the news upsert to link each source.
  await repository.persistClusters(structuredClone(DEMO_CLUSTERS));
  await repository.upsertNews(structuredClone(DEMO_NEWS));
  await repository.persistClusters(structuredClone(DEMO_CLUSTERS));

  const alreadyOwned = await repository.getPublishableScriptDraft({
    draftId: DEMO_STORY.draftId,
    idNoticia: DEMO_STORY.approvedNewsId,
    clusterId: DEMO_STORY.draftClusterId,
  });
  if (!alreadyOwned) {
    await repository.applyApprovalDecision({
      idNoticia: DEMO_STORY.approvedNewsId,
      clusterId: DEMO_STORY.draftClusterId,
      action: 'approve',
    });
    const job = await repository.claimScriptJob({ idNoticia: DEMO_STORY.approvedNewsId });
    if (job) {
      await repository.completeScriptJob({
        idNoticia: DEMO_STORY.approvedNewsId,
        draftId: DEMO_STORY.draftId,
        guionDraft: DEMO_DRAFT_TEXT,
        guionEditado: DEMO_DRAFT_TEXT,
        wordCount: DEMO_DRAFT_TEXT.split(/\s+/).filter(Boolean).length,
      });
    }
  }

  await repository.upsertVideoProject({
    draft_id: DEMO_STORY.videoProjectId,
    id_noticia: DEMO_STORY.approvedNewsId,
    cluster_id: DEMO_STORY.draftClusterId,
    jugador: 'Nicolás Arbelo',
    seleccion: 'Aurenia',
    tema_principal: 'Arbelo vuelve a entrenar con el grupo',
    guion_editado: DEMO_DRAFT_TEXT,
    guion_piped: DEMO_DRAFT_TEXT,
    segments: structuredClone(DEMO_PROJECT_SEGMENTS),
    image_candidates: [],
    image_search_meta: { query: 'Nicolás Arbelo', status: 'demo', result_count: 0 },
    selected_images: [],
    voice_audio: {},
    background_audio: {},
    editor_state: { demo: true },
    status: 'ready',
  });

  const generatedPassword = !password;
  if (generatedPassword) {
    logger.warn?.('seed-demo: generated a demo password; pass NEWSROOM_DEMO_PASSWORD to control it');
  }

  return {
    users: {
      editor: { email: editorEmail, created: editor.created },
      viewer: { email: viewerEmail, created: viewer.created },
    },
    story: {
      pending_cluster_id: DEMO_STORY.pendingClusterId,
      pending_news_id: DEMO_STORY.pendingNewsId,
      approved_news_id: DEMO_STORY.approvedNewsId,
      draft_id: DEMO_STORY.draftId,
      video_project_id: DEMO_STORY.videoProjectId,
    },
  };
}

export function generateDemoPassword() {
  return randomBytes(24).toString('base64url');
}

export { DEMO_STORY };
