import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  annotateGooglePositions,
  buildFeedRequests,
  buildPipedScript,
  buildPronunciationPrompt,
  buildScriptPrompt,
  buildVideoSegments,
  extractModelText,
  filterRecentUnique,
  normalizeImageCandidates,
  normalizeWindow,
  parseModelJson,
  splitFootballNews,
  validateDraft,
  validateSourceArticle,
} from '../src/index.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');

describe('news domain', () => {
  it('normalizes the supported discovery windows', () => {
    assert.deepEqual(normalizeWindow('1h'), {
      requested_window: '1h',
      google_when: '1h',
      window_ms: 60 * 60 * 1000,
    });
    assert.deepEqual(normalizeWindow('última_hora'), normalizeWindow('1h'));
    assert.equal(normalizeWindow('24h').window_ms, 24 * 60 * 60 * 1000);
    assert.equal(normalizeWindow('anything').requested_window, '24h');
  });

  it('builds one Google News RSS feed request per player', () => {
    const requests = buildFeedRequests([{ seleccion: 'Aurenia', jugador: 'Nicolás Arbelo' }], '1h', {
      runId: 'run-1',
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].jugador, 'Nicolás Arbelo');
    assert.equal(requests[0].source_kind, 'google_news_rss');
    assert.equal(requests[0].run_id, 'run-1');
    assert.match(requests[0].feed_url, /news\.google\.com\/rss\/search/);
    assert.match(requests[0].feed_url, /when%3A1h/);
  });

  it('drops stale, incomplete and duplicate rows and annotates positions', () => {
    const rows = [
      { id_noticia: 'a', jugador: 'P', titular: 'T', link: 'l1', fecha_publicacion: NOW.toISOString() },
      { id_noticia: 'b', jugador: 'P', titular: 'T', link: 'l1', fecha_publicacion: NOW.toISOString() },
      { id_noticia: 'c', jugador: 'P', titular: '', link: 'l2', fecha_publicacion: NOW.toISOString() },
      { id_noticia: 'd', jugador: 'P', titular: 'T', link: 'l3', fecha_publicacion: '2020-01-01T00:00:00.000Z' },
      { id_noticia: 'e', jugador: 'P', titular: 'Titular 2', link: 'l4', fecha_publicacion: 'not-a-date' },
    ];
    const filtered = filterRecentUnique(rows, { windowMs: 60 * 60 * 1000, now: NOW });
    assert.deepEqual(filtered.map((row) => row.id_noticia), ['a', 'e']);
    const annotated = annotateGooglePositions(filtered);
    assert.deepEqual(annotated.map((row) => row.google_position), [1, 2]);
  });

  it('splits direct football news from rows that need model classification', () => {
    const split = splitFootballNews([
      {
        jugador: 'Nicolás Arbelo',
        titular: 'Arbelo anotó un gol con el Costa Azul FC',
        fuente: 'Example',
        snippet: 'Victoria en la Liga Demo',
      },
      {
        jugador: 'Nicolás Arbelo',
        titular: 'Arbelo visitó una escuela',
        fuente: 'Example',
        snippet: 'Actividad social',
      },
    ]);
    assert.equal(split.direct.length, 1);
    assert.equal(split.direct[0].pass_direct, true);
    assert.equal(split.ambiguous.length, 1);
    assert.equal(split.ambiguous[0].pass_direct, false);
  });

  it('extracts model text and JSON from common provider shapes', () => {
    assert.equal(extractModelText({ choices: [{ message: { content: 'hello' } }] }), 'hello');
    assert.equal(extractModelText({
      candidates: [{ content: { parts: [{ text: 'hola' }, { thought: true, text: 'ignore' }] } }],
    }), 'hola');
    assert.deepEqual(parseModelJson('```json\n{"results":[{"id_noticia":"a","es_futbol":true}]}\n```'), {
      results: [{ id_noticia: 'a', es_futbol: true }],
    });
    assert.deepEqual(parseModelJson('prefix {"ok":true} suffix'), { ok: true });
    assert.throws(() => parseModelJson('no json here'), /parse/i);
  });
});

describe('script domain', () => {
  it('validates article extraction with the n8n relevance rules', () => {
    const job = {
      link: 'https://news.example.local/andrade-1',
      jugador: 'Nicolás Arbelo',
      seleccion: 'Aurenia',
      tema_principal: 'Gol de Arbelo',
      titular: 'Arbelo anotó en la victoria del Costa Azul FC',
      snippet: 'El mediocampista marcó el primer gol del partido.',
    };
    const article = {
      title: 'Arbelo anotó en la victoria del Costa Azul FC',
      main_content: [
        'Nicolás Arbelo anotó el primer gol del Costa Azul FC en la victoria del partido.',
        'El mediocampista aureniano jugó los noventa minutos y fue elegido figura.',
        'El técnico destacó su rendimiento después del entrenamiento y confirmó que seguirá como titular.',
        'La selección de Aurenia también sigue de cerca su recuperación y su próximo partido de clasificatorias.',
      ].join(' '),
    };
    const valid = validateSourceArticle(article, job);
    assert.equal(valid.ok, true);
    assert.ok(valid.combined_context.includes('Nicolás Arbelo'));
    assert.equal(valid.validation.body_words > 30, true);

    const betting = validateSourceArticle({
      ...article,
      main_content: `${article.main_content} Las casas de apuestas ya publicaron sus cuotas.`,
    }, job);
    assert.equal(betting.ok, false);
    assert.match(betting.error, /betting/i);

    const tooShort = validateSourceArticle({ ...article, main_content: 'texto corto' }, job);
    assert.equal(tooShort.ok, false);
    assert.match(tooShort.error, /below the minimum/i);
  });

  it('builds a deterministic script prompt for the editorial tag', () => {
    const prompt = buildScriptPrompt({
      tema_principal: 'Tema',
      jugador: 'Jugador',
      seleccion: 'Aurenia',
      tag_editorial: 'elogio_director_tecnico',
      combined_context: 'Fuente 1\nContenido: ejemplo',
    });
    assert.match(prompt, /Entre 200 y 280 palabras/i);
    assert.match(prompt, /respaldo del DT/i);
    assert.match(prompt, /Fuente 1/);
  });

  it('accepts drafts in the workflow word range and rejects empty or huge output', () => {
    const text = Array.from({ length: 150 }, () => 'palabra').join(' ');
    assert.deepEqual(validateDraft(text), { ok: true, temporary: false, word_count: 150, text, error: null });
    assert.equal(validateDraft('').ok, false);
    assert.equal(validateDraft(Array.from({ length: 351 }, () => 'x').join(' ')).ok, false);
  });

  it('builds the piped script and video segments used by the renderer', () => {
    const piped = buildPipedScript(
      'Arbelo anotó el primer gol del partido y fue elegido figura. El técnico destacó su rendimiento después del entrenamiento y confirmó que seguirá como titular.\n\nSegundo párrafo con otra idea para el cierre.',
    );
    assert.ok(piped.includes(' | '));
    assert.ok(piped.includes(' |\n\n'));
    const segments = buildVideoSegments(piped);
    assert.equal(segments[0].id, 'seg-001');
    assert.equal(segments[0].order, 1);
    assert.equal(segments[0].source, 'guion_piped');
    assert.ok(segments.length > 1);
  });

  it('builds pronunciation prompts and normalizes image candidates', () => {
    assert.match(buildPronunciationPrompt('Costa Azul FC ganó'), /Costa Azul FC/);
    const candidates = normalizeImageCandidates([
      { imageUrl: 'https://img.example.local/1.jpg', link: 'https://tiktok.com/x', title: 'blocked' },
      { imageUrl: 'https://img.example.local/2.jpg', thumbnailUrl: 'https://img.example.local/2-thumb.jpg', source: 'Demo' },
    ]);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].provider, 'image-search');
    assert.equal(candidates[0].selected, false);
  });
});
