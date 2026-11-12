import { AdapterError } from './http.js';

const DEMO_SCRIPT = [
  'Aurenia prepara su próximo partido con una variante en el mediocampo y la vuelta de Nicolás Arbelo como eje del equipo.',
  'El cuerpo técnico probó una salida más rápida por las bandas durante la práctica abierta del martes.',
  'La idea es ganar terreno antes de que el rival se organice y darle más libertad al jugador que llega desde atrás.',
  'Arbelo completó la sesión sin molestias y trabajó junto al resto del grupo durante todo el entrenamiento.',
  'Los asistente midieron la presión alta y la recuperación inmediata después de cada pérdida.',
  'El equipo busca sostener el ritmo durante los noventa minutos y evitar los pasajes de desconcierto que aparecieron en el último amistoso.',
  'La práctica terminó con una serie de definiciones y trabajos de pelota parada.',
  'El plantel volverá a entrenar este miércoles con la mirada puesta en el once que presentará el fin de semana.',
  'La delegación confirmó que no hay bajas por lesión y que todos los convocados están disponibles para el partido.',
  'El entrenador insistió en la importancia de cuidar el balón y de no regalar espacios en la salida.',
  'Los jugadores coincidieron en que el grupo está tranquilo y enfocado en el objetivo.',
  'La afición agotó las entradas para el sector popular en pocas horas y se espera un estadio lleno.',
  'El equipo cerrará la preparación con una sesión táctica a puertas cerradas.',
  'Después del partido, el cuerpo técnico evaluará el rendimiento y definirá la carga para la siguiente fecha.',
  'La noticia principal es la recuperación de Arbelo, que vuelve a estar disponible en un momento importante del calendario.',
  'El mediocampista había trabajado de manera diferenciada la semana pasada y ahora completó todas las tareas con normalidad.',
  'Su regreso le da al equipo una salida más limpia y una referencia clara para la presión rival.',
  'El grupo mantiene la misma idea de juego y confía en el trabajo realizado durante la pretemporada.',
  'La práctica de este martes fue la más exigente de la semana y dejó buenas sensaciones en el cuerpo técnico.',
].join(' ');

/**
 * Deterministic local adapters used only by the keyless demo profile. They are
 * selected with LLM=demo / ARTICLE_EXTRACTOR=demo and never make network calls,
 * so `docker compose up` can complete the approval-to-script path without
 * Ollama, a GPU or a model download.
 */
export class DemoLLMAdapter {
  constructor({ text = DEMO_SCRIPT } = {}) {
    this.text = String(text || '').trim();
  }

  async complete({ prompt = '' } = {}) {
    if (!String(prompt || '').trim()) throw new AdapterError('llm_empty_prompt', 'LLM prompt is required', { statusCode: 400 });
    return { text: this.text, model: 'demo-deterministic', provider: 'demo', raw: { demo: true } };
  }
}

export class DemoArticleExtractor {
  async extract({ url = '', job = {} } = {}) {
    const target = String(url || '').trim();
    if (!target) throw new AdapterError('extract_url_missing', 'Article URL is required', { statusCode: 400 });
    const topic = [job.titular, job.tema_principal, job.jugador, job.seleccion].filter(Boolean).join('. ');
    const body = [
      `${topic}.`,
      'La información fue confirmada por el cuerpo técnico y por dos fuentes del entorno del plantel.',
      'El equipo entrenó con normalidad y prepara una variante táctica para el próximo compromiso.',
      'Los jugadores completaron trabajos de presión, salida y definición durante la sesión abierta.',
      'El cuerpo técnico evalúa el estado físico del grupo y definirá el once titular en las próximas horas.',
      'La práctica terminó sin novedades y el plantel quedó concentrado a la espera del partido.',
    ].join(' ');
    return {
      article: {
        title: String(job.titular || job.tema_principal || 'Demo story'),
        url: target,
        main_content: body,
        author: 'Demo Sports News',
        published_at: job.fecha_publicacion || '',
      },
      data: { title: String(job.titular || 'Demo story'), main_content: body },
      url: target,
      extractor: 'demo',
    };
  }
}

function demoWavBytes({ durationSeconds = 0.25, sampleRate = 8000 } = {}) {
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}

/** Deterministic keyless TTS adapter used by demo/showcase mode. */
export class DemoTTSAdapter {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.jobs = new Map();
    this.sequence = 0;
  }

  async createJob({ text = '', title = '', voiceProfile = 'default' } = {}) {
    const value = String(text || '').trim();
    if (!value) throw new AdapterError('tts_text_required', 'TTS text is required', { statusCode: 400 });
    this.sequence += 1;
    const jobId = `tts-demo-${this.sequence}`;
    this.jobs.set(jobId, {
      job_id: jobId,
      status: 'done',
      title: String(title || ''),
      voice_profile: String(voiceProfile || 'default'),
      created_at: this.now().toISOString(),
    });
    return { job_id: jobId, status: 'done' };
  }

  async getJob(jobId = '') {
    const job = this.jobs.get(String(jobId));
    if (!job) throw new AdapterError('tts_job_not_found', `unknown TTS job: ${jobId}`, { statusCode: 404 });
    return { job_id: job.job_id, status: job.status, download_url: `/api/tts/jobs/${job.job_id}/download` };
  }

  async download(jobId = '') {
    const job = await this.getJob(jobId);
    return { bytes: demoWavBytes(), content_type: 'audio/wav', job_id: job.job_id };
  }
}

/** Deterministic keyless ASR adapter used by demo/showcase mode. */
export class DemoASRAdapter {
  async transcribe({ audioPath = '', language = 'es' } = {}) {
    const path = String(audioPath || '').trim();
    if (!path) throw new AdapterError('asr_audio_path_required', 'audioPath is required', { statusCode: 400 });
    const text = 'Aurenia ajusta su mediocampo para el próximo partido.';
    return {
      segments: [
        { id: 0, start_ms: 0, end_ms: 1800, text },
        { id: 1, start_ms: 1800, end_ms: 3600, text: 'El equipo entrenó con normalidad.' },
      ],
      language: String(language || 'es'),
      device: 'demo',
      fallback_used: false,
    };
  }
}

/** Deterministic keyless translation adapter used by demo/showcase mode. */
export class DemoTranslationAdapter {
  async translate({ segments = [], sourceLanguage = 'auto', targetLanguage = 'es' } = {}) {
    if (!Array.isArray(segments)) throw new AdapterError('translation_segments_invalid', 'segments must be an array', { statusCode: 400 });
    const target = String(targetLanguage || 'es');
    return {
      segments: segments.map((segment, index) => ({
        ...segment,
        id: segment.id ?? index,
        source_language: String(sourceLanguage || 'auto'),
        target_language: target,
        translated_text: String(segment.text ?? segment.translated_text ?? ''),
      })),
      target_language: target,
    };
  }
}

/** Deterministic keyless renderer adapter used by demo/showcase mode. */
export class DemoVideoRendererAdapter {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.projects = new Map();
    this.sequence = 0;
  }

  async createProject(payload = {}) {
    this.sequence += 1;
    const projectId = `demo-project-${this.sequence}`;
    this.projects.set(projectId, { project_id: projectId, status: 'queued', title: String(payload.title || ''), created_at: this.now().toISOString() });
    return { project_id: projectId, status: 'queued' };
  }

  async renderProject(projectId = '', { profile = 'final' } = {}) {
    const project = this.projects.get(String(projectId));
    if (!project) throw new AdapterError('renderer_project_not_found', `unknown render project: ${projectId}`, { statusCode: 404 });
    project.status = 'done';
    project.output = `/api/projects/${project.project_id}/download/${profile === 'preview' ? 'preview' : 'final'}`;
    return { project_id: project.project_id, status: 'done', output: project.output };
  }

  async getRenderStatus(projectId = '') {
    const project = this.projects.get(String(projectId));
    if (!project) throw new AdapterError('renderer_project_not_found', `unknown render project: ${projectId}`, { statusCode: 404 });
    return { project_id: project.project_id, status: project.status, ...(project.output ? { output: project.output } : {}) };
  }

  async downloadRender(projectId = '') {
    const project = await this.getRenderStatus(projectId);
    return { bytes: new Uint8Array(Buffer.from(`demo-mp4:${project.project_id}`)), content_type: 'video/mp4' };
  }
}

/** Deterministic keyless auth adapter used by demo/showcase mode. */
export class DemoAuthAdapter {
  constructor({ users = [{ email: 'demo@example.local', password: 'demo-password', display_name: 'Demo User', roles: ['admin'] }] } = {}) {
    this.users = new Map(users.map((user) => [String(user.email).toLowerCase(), { ...user }]));
    this.sessions = new Map();
    this.sequence = 0;
  }

  async authenticate({ user = '', password = '' } = {}) {
    const record = this.users.get(String(user || '').toLowerCase());
    if (!record || record.password !== String(password || '')) {
      throw new AdapterError('invalid_credentials', 'Invalid credentials', { statusCode: 401 });
    }
    return {
      user: { user_id: record.user_id || record.email, email: record.email, display_name: record.display_name || record.email },
      roles: [...(record.roles || ['viewer'])],
      source: 'demo',
    };
  }

  async createSession({ user = {}, roles = [], ipAddress = '', userAgent = '' } = {}) {
    this.sequence += 1;
    const token = `demo-session-${this.sequence}`;
    const session = {
      user: { user_id: user.user_id || user.email, email: user.email, display_name: user.display_name || user.email },
      roles: [...roles],
      session_id: `demo-session-id-${this.sequence}`,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen_at: null,
      token,
      ipAddress: String(ipAddress || ''),
      userAgent: String(userAgent || ''),
    };
    this.sessions.set(token, session);
    return session;
  }

  async getSession(token = '') {
    const session = this.sessions.get(String(token || ''));
    if (!session) return null;
    return { ...session, token: undefined };
  }

  async revokeSession(token = '') {
    this.sessions.delete(String(token || ''));
    return undefined;
  }
}
