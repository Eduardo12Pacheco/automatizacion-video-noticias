import { AdapterError } from './http.js';

const DEMO_SCRIPT = [
  'Aurenia prepara su próximo partido con una variante en el mediocampo y la vuelta de Nicolás Andrade como eje del equipo.',
  'El cuerpo técnico probó una salida más rápida por las bandas durante la práctica abierta del martes.',
  'La idea es ganar terreno antes de que el rival se organice y darle más libertad al jugador que llega desde atrás.',
  'Andrade completó la sesión sin molestias y trabajó junto al resto del grupo durante todo el entrenamiento.',
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
  'La noticia principal es la recuperación de Andrade, que vuelve a estar disponible en un momento importante del calendario.',
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
