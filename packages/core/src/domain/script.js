const STOPWORDS = new Set([
  'para', 'pero', 'como', 'sobre', 'desde', 'hasta', 'entre', 'esta', 'este', 'estos', 'estas', 'todo',
  'toda', 'todos', 'todas', 'tras', 'ante', 'contra', 'porque', 'cuando', 'donde', 'quien', 'quienes',
  'cual', 'cuales', 'tambien', 'también', 'luego', 'mientras', 'segun', 'según', 'sera', 'será', 'fue',
  'son', 'con', 'sin', 'por', 'del', 'los', 'las', 'una', 'uno', 'unos', 'unas', 'que', 'mas', 'más',
  'sus', 'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'has', 'will', 'after', 'before',
  'about',
]);

const BETTING_REGEX = /\b(casas?\s+de\s+apuestas?|apuestas?\s+(deportivas|online|en\s+vivo)|apostar|cuotas?|odds|betting|bookmaker|sportsbook|bono\s+de\s+bienvenida|pron[oó]sticos?\s+(deportivos|de\s+apuestas?)|momios?)\b/iu;
const BOILERPLATE_REGEX = /\b(enable\s+javascript|javascript\s+disabled|access\s+denied|forbidden|captcha|cloudflare|just\s+a\s+moment|cookie\s+policy|privacy\s+policy|suscribete|suscríbete|newsletter|iniciar\s+sesion|iniciar\s+sesión|sign\s+in|login)\b/iu;

const MIN_DRAFT_WORDS = 120;
const MAX_DRAFT_WORDS = 350;
const MIN_SOURCE_WORDS = 30;

export function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

function normalizeForTokens(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function keywords(value) {
  const normalized = normalizeForTokens(value);
  return [...new Set(normalized
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token)))];
}

export function validateSourceArticle(article = {}, job = {}) {
  const body = String(article.main_content || article.markdown || '').trim();
  const bodyWords = wordCount(body);
  const cleanText = [article.title, article.subtitle, body].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const contentNorm = normalizeForTokens(cleanText);
  const expectedTokens = keywords([job.jugador, job.seleccion, job.tema_principal, job.titular, job.snippet].filter(Boolean).join(' '));
  const playerTokens = keywords(job.jugador);
  const matchedTokens = expectedTokens.filter((token) => contentNorm.includes(token));
  const playerMatched = playerTokens.length === 0 || playerTokens.some((token) => contentNorm.includes(token));
  const minExpectedMatches = expectedTokens.length >= 8 ? 3 : (expectedTokens.length >= 4 ? 2 : Math.min(1, expectedTokens.length));

  let error = '';
  if (!job.link) {
    error = 'Missing article URL from claimed script job';
  } else if (bodyWords <= MIN_SOURCE_WORDS) {
    error = `Article body below the minimum source threshold (${body.length} chars, ${bodyWords} words; required > ${MIN_SOURCE_WORDS} words)`;
  } else if (BOILERPLATE_REGEX.test(cleanText) && bodyWords < 160) {
    error = 'Article content appears to be login/captcha/cookie boilerplate instead of an article';
  } else if (BETTING_REGEX.test(cleanText)) {
    error = 'Article content was rejected because it appears to be betting-related';
  } else if (expectedTokens.length > 0 && matchedTokens.length < minExpectedMatches && !playerMatched) {
    error = `Article content does not appear relevant to the claimed news (${matchedTokens.length}/${expectedTokens.length} topic signals matched)`;
  } else if (playerTokens.length > 0 && !playerMatched && matchedTokens.length < 3) {
    error = 'Article content does not mention the expected player or enough related topic signals';
  }

  const combinedContext = [
    'Fuente 1',
    `URL: ${article.url || job.link || ''}`,
    `Titulo: ${article.title || job.titular || ''}`,
    `Subtitulo: ${article.subtitle || ''}`,
    `Autor: ${article.author || ''}`,
    `Fecha: ${article.published_at || job.fecha_publicacion || ''}`,
    'Contenido:',
    body,
  ].join('\n');

  return {
    ok: !error,
    error: error || null,
    combined_context: combinedContext,
    validation: {
      body_chars: body.length,
      body_words: bodyWords,
      expected_signal_count: expectedTokens.length,
      matched_signal_count: matchedTokens.length,
      matched_signals: matchedTokens.slice(0, 12),
      player_matched: playerMatched,
    },
  };
}

export function buildScriptPrompt(source = {}) {
  const tag = String(source.tag_editorial || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
  const baseInstructions = [
    'Redacta un guion breve de noticia deportiva, listo para locución.',
    '',
    'Escribe en tercera persona, con tono informativo y periodístico, y una redacción fluida, natural y clara.',
    '',
    'La extensión debe estar entre 200 y 280 palabras. No menos de 200 y no más de 280.',
    'No inventes información. No uses markdown. No uses encabezados.',
    'Prohibido mencionar apuestas, cuotas, momios, odds, pronósticos o casas de apuestas.',
  ];
  const tagSpecific = {
    elogio_prensa: ['Enfoque especial: destacar elogios de prensa con equilibrio periodístico.'],
    elogio_director_tecnico: ['Enfoque especial: destacar respaldo del DT y su impacto táctico.'],
    emotividad: ['Enfoque especial: tono humano sin dramatizar en exceso.'],
  };
  return [
    ...baseInstructions,
    '',
    ...(tagSpecific[tag] || ['Enfoque especial: tratamiento informativo estándar.']),
    '',
    `Tema principal: ${source.tema_principal || ''}`,
    `Jugador: ${source.jugador || ''}`,
    `Seleccion: ${source.seleccion || ''}`,
    `Tag editorial: ${tag || '(vacio)'}`,
    '',
    'Fuentes extraidas:',
    source.combined_context || '',
    '',
    'Entrega únicamente el guion final, en texto plano.',
  ].join('\n');
}

export function validateDraft(text) {
  const cleaned = String(text || '')
    .replace(/^```[\w-]*\n?/i, '')
    .replace(/```$/i, '')
    .replace(/^aquí tenés el guion:\s*/i, '')
    .replace(/^aqui tenes el guion:\s*/i, '')
    .replace(/^aquí tienes el guion:\s*/i, '')
    .replace(/^aqui tienes el guion:\s*/i, '')
    .trim();
  const count = wordCount(cleaned);
  if (!cleaned) return { ok: false, temporary: false, word_count: 0, text: '', error: 'The model returned empty content' };
  if (count < MIN_DRAFT_WORDS) {
    return {
      ok: false,
      temporary: true,
      word_count: count,
      text: cleaned,
      error: `The model generated a too-short draft (${count} words; minimum ${MIN_DRAFT_WORDS})`,
    };
  }
  if (count > MAX_DRAFT_WORDS) {
    return {
      ok: false,
      temporary: true,
      word_count: count,
      text: cleaned,
      error: `The model generated a too-long draft (${count} words; maximum ${MAX_DRAFT_WORDS})`,
    };
  }
  return { ok: true, temporary: false, word_count: count, text: cleaned, error: null };
}

export function buildPipedScript(script = '') {
  const text = String(script || '');
  if (!text.trim()) return '';

  const connectors = new Set(['y', 'pero', 'aunque', 'sin', 'ademas', 'además', 'mientras', 'por', 'en']);
  const semanticConnectors = new Set(['que', 'porque', 'cuando', 'mientras', 'aunque', 'pero', 'y', 'ademas', 'además', 'con', 'para', 'donde', 'si', 'tras']);
  const danglingLeftWords = new Set(['y', 'e', 'o', 'u', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'en', 'por', 'con', 'sin', 'a', 'al', 'para']);
  const weakRightWords = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas']);
  const maxBlockWords = 18;
  const minSplitWords = 7;

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizeToken = (value) => (value || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  const isCapitalized = (value) => /^[A-ZÁÉÍÓÚÑÜ]/.test((value || '').toString().replace(/^[¿¡"'“”‘’(]+/, ''));
  const protect = (value) => {
    let out = value;
    for (const abbr of ['Sr.', 'Sra.', 'Dr.', 'Dra.', 'etc.', 'vs.', 'No.', 'Nro.']) {
      out = out.replace(new RegExp(escapeRegExp(abbr), 'g'), abbr.replace('.', '§'));
    }
    return out.replace(/(\d)\.(\d)/g, '$1§$2');
  };
  const unprotect = (value) => value.replace(/§/g, '.');
  const getWordsWithSpans = (value) => Array.from(value.matchAll(/\S+/g)).map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    normalized: normalizeToken(match[0]),
  }));

  function isBadBoundary(words, boundaryIndex) {
    const left = words[boundaryIndex - 1];
    const right = words[boundaryIndex];
    const next = words[boundaryIndex + 1];
    if (!left || !right) return true;
    if (danglingLeftWords.has(left.normalized)) return true;
    if (weakRightWords.has(right.normalized)) return true;
    if ((right.normalized === 'y' || right.normalized === 'e') && next && isCapitalized(next.text)) return true;
    if ((left.normalized === 'y' || left.normalized === 'e') && isCapitalized(right.text)) return true;
    return false;
  }

  function scoreBoundary(words, boundaryIndex, midpoint) {
    const left = words[boundaryIndex - 1];
    const right = words[boundaryIndex];
    let score = Math.abs(boundaryIndex - midpoint) * 3;
    if (semanticConnectors.has(right.normalized)) score -= 8;
    if (/[,:;]$/.test(left.text)) score -= 5;
    if (/[.!?]$/.test(left.text)) score -= 10;
    if (isCapitalized(right.text) && boundaryIndex > 1) score += 3;
    return score;
  }

  function splitLongBlock(block) {
    const words = getWordsWithSpans(block);
    if (words.length <= maxBlockWords) return [block.trim()];
    const midpoint = Math.round(words.length / 2);
    const minIndex = Math.max(minSplitWords, midpoint - 6);
    const maxIndex = Math.min(words.length - minSplitWords, midpoint + 6);
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = minIndex; index <= maxIndex; index += 1) {
      if (isBadBoundary(words, index)) continue;
      const score = scoreBoundary(words, index, midpoint);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) {
      for (let index = minSplitWords; index <= words.length - minSplitWords; index += 1) {
        if (isBadBoundary(words, index)) continue;
        const score = scoreBoundary(words, index, midpoint);
        if (score < bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    }
    if (bestIndex === -1) return [block.trim()];
    const cutAt = words[bestIndex].start;
    const left = block.slice(0, cutAt).trim();
    const right = block.slice(cutAt).trim();
    if (!left || !right) return [block.trim()];
    return [left, right].flatMap((part) => splitLongBlock(part));
  }

  function splitByCommaRule(sentence) {
    const parts = [];
    let last = 0;
    const regex = /,\s+/g;
    let match;
    while ((match = regex.exec(sentence)) !== null) {
      const commaIndex = match.index;
      const left = sentence.slice(last, commaIndex + 1);
      const right = sentence.slice(commaIndex + match[0].length).trim();
      const leftWords = getWordsWithSpans(left);
      const firstNext = (right.split(/\s+/)[0] || '').toLowerCase();
      const previousWord = leftWords[leftWords.length - 1];
      const badCommaCut = previousWord && danglingLeftWords.has(previousWord.normalized);
      const shouldCut = !badCommaCut && (wordCount(left) >= 12 || connectors.has(firstNext));
      if (shouldCut) {
        const chunk = sentence.slice(last, commaIndex + 1).trim();
        if (chunk) parts.push(...splitLongBlock(chunk));
        last = commaIndex + 1;
      }
    }
    const tail = sentence.slice(last).trim();
    if (tail) parts.push(...splitLongBlock(tail));
    return parts.length ? parts : splitLongBlock(sentence.trim());
  }

  const paragraphs = text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const blocks = [];
  for (let p = 0; p < paragraphs.length; p += 1) {
    const protectedParagraph = protect(paragraphs[p]);
    const rawSentences = protectedParagraph.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
    for (const rawSentence of rawSentences) {
      const sentence = unprotect(rawSentence).trim();
      if (!sentence) continue;
      for (const block of splitByCommaRule(sentence)) {
        const clean = block.trim();
        if (clean) blocks.push(clean);
      }
    }
    if (p < paragraphs.length - 1) blocks.push('__PARA_BREAK__');
  }

  let piped = '';
  for (const block of blocks) {
    if (block === '__PARA_BREAK__') {
      piped = piped.replace(/\s*$/, '');
      piped += ' |\n\n';
      continue;
    }
    if (!piped) piped = block;
    else if (piped.endsWith('|\n\n')) piped += block;
    else piped += ` | ${block}`;
  }
  return piped
    .replace(/\|\s*\|/g, '|')
    .replace(/^\s*\|+\s*/, '')
    .replace(/\s*\|+\s*$/, '')
    .trim();
}

export function buildPronunciationPrompt(script = '') {
  return [
    'Tomá el siguiente guion periodístico en español y devolvé el MISMO texto, sin resumirlo, sin reescribirlo y sin cambiar su estructura.',
    '',
    'Tu única tarea es reemplazar palabras, nombres propios, clubes, torneos, marcas o expresiones en inglés por una aproximación fonética natural para locución en español latinoamericano.',
    '',
    'Reglas estrictas:',
    '- Conservá todo lo que ya está en español exactamente igual.',
    '- No cambies datos, cifras, nombres en español, tono editorial ni orden de párrafos.',
    '- No agregues explicación, notas, listas ni comillas.',
    '- No traduzcas conceptos: solo cambiá la escritura inglesa por cómo debería pronunciarse.',
    '- Mantené los saltos de párrafo del guion original.',
    '- Si dudás, dejá la palabra igual.',
    '',
    'GUION:',
    String(script || '').trim(),
  ].join('\n');
}

export function buildVideoSegments(pipedScript = '') {
  return String(pipedScript || '')
    .replace(/\r\n/g, '\n')
    .split('|')
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((text, index) => ({
      id: `seg-${String(index + 1).padStart(3, '0')}`,
      order: index + 1,
      text,
      selected_image_id: null,
      duration_seconds: null,
      notes: '',
      source: 'guion_piped',
    }));
}

export function buildDocTitle(row = {}, now = new Date()) {
  const date = (typeof now === 'function' ? now() : new Date(now)).toISOString().slice(0, 10);
  const player = String(row.jugador || 'sin-jugador').trim();
  const topic = [
    row.titulo_noticia,
    row.titular,
    row.headline,
    row.title,
    row.titulo,
    row.tema_principal,
  ].map((part) => (part || '').toString().trim()).find(Boolean) || row.id_noticia || 'sin-tema';
  return `Guion - ${player} - ${String(topic).trim().slice(0, 80)} - ${date}`;
}

const BLOCKED_IMAGE_DOMAINS = Object.freeze([
  'tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'instagram.com', 'facebook.com', 'fbcdn.net',
  'cdninstagram.com', 'youtube.com', 'ytimg.com', 'ebay.com', 'alamy.com',
]);

function stableId(value) {
  const input = String(value || '');
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36) || '0';
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

export function normalizeImageCandidates(images = [], { query = '' } = {}) {
  const list = Array.isArray(images) ? images : [];
  return list
    .filter((item) => {
      const haystack = [item.domain, item.source, item.link, item.googleUrl, item.imageUrl, item.thumbnailUrl, item.image_url, item.thumbnail_url]
        .map((part) => String(part || '').toLowerCase())
        .join(' ');
      return !BLOCKED_IMAGE_DOMAINS.some((blocked) => haystack.includes(blocked));
    })
    .map((item, index) => {
      const imageUrl = item.imageUrl || item.image_url || item.image || item.url || '';
      const thumbnailUrl = item.thumbnailUrl || item.thumbnail_url || item.thumbnail || '';
      const link = item.link || '';
      const domain = item.domain || (link ? safeHostname(link) : '');
      const position = Number.isFinite(Number(item.position)) ? Number(item.position) : index + 1;
      const idInput = imageUrl || link || item.googleUrl || `${query}-${position}`;
      return {
        id: `serper-${stableId(idInput)}`,
        order: position,
        provider: 'serper-images',
        title: item.title || item.source || domain || `Imagen ${position}`,
        image_url: imageUrl,
        thumbnail_url: thumbnailUrl,
        link,
        google_url: item.googleUrl || '',
        source: item.source || '',
        domain,
        position,
        image_width: Number(item.imageWidth || item.image_width || item.width) || null,
        image_height: Number(item.imageHeight || item.image_height || item.height) || null,
        thumbnail_width: Number(item.thumbnailWidth || item.thumbnail_width) || null,
        thumbnail_height: Number(item.thumbnailHeight || item.thumbnail_height) || null,
        selected: false,
        segment_ids: [],
      };
    })
    .filter((candidate) => candidate.image_url || candidate.thumbnail_url);
}
