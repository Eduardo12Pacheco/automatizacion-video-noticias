function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

const NUMBER_WORDS = new Map(Object.entries({
  cero: "0",
  un: "1",
  uno: "1",
  una: "1",
  dos: "2",
  tres: "3",
  cuatro: "4",
  cinco: "5",
  seis: "6",
  siete: "7",
  ocho: "8",
  nueve: "9",
  diez: "10",
  veinte: "20",
  treinta: "30",
}));

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeNumberishToken(token) {
  const normalized = normalizeToken(token);
  if (!normalized) return "";
  if (NUMBER_WORDS.has(normalized)) return NUMBER_WORDS.get(normalized);
  if (/^\d+$/.test(normalized)) return String(Number(normalized));
  return normalized;
}

function splitRawToken(value) {
  const raw = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const scoreLike = raw.match(/\d+/g);
  if (scoreLike && /[-–—]/.test(raw)) return scoreLike;
  return raw.split(/\s+/).filter(Boolean);
}

function phraseTokens(phrase) {
  return String(phrase || "").split(/\s+/).map(normalizeNumberishToken).filter(Boolean);
}

function wordTokens(word = {}) {
  const tokens = [];
  for (const rawToken of splitRawToken(word.word || word.text || "")) {
    const token = normalizeNumberishToken(rawToken);
    if (token) tokens.push(token);
  }
  return tokens;
}

function findSegmentDrift(match, segment) {
  if (!segment) return 0;
  const startDrift = Math.abs(Number(match.start || 0) - Number(segment.start || 0));
  const endDrift = Math.abs(Number(match.end || 0) - Number(segment.end || 0));
  return Math.round(Math.max(startDrift, endDrift) * 1000);
}

function buildTranscriptTokens(words) {
  const transcriptTokens = [];
  words.forEach((word, wordIndex) => {
    const start = Number(word.start);
    const end = Number(word.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    for (const token of wordTokens(word)) {
      transcriptTokens.push({ token, word, wordIndex, start, end });
    }
  });
  return transcriptTokens;
}

function findNearestSegment(segments, match) {
  return segments.find((segment) => {
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return start <= Number(match.end || 0) && end >= Number(match.start || 0);
  });
}

function phraseEdgeMatched(tokens, matched) {
  if (tokens.length < 3) return matched.length === tokens.length;
  return matched[0]?.phraseIndex <= 1 && matched[matched.length - 1]?.phraseIndex >= tokens.length - 2;
}

function maxUnmatchedPhraseRun(tokens, matched) {
  const matchedIndexes = new Set(matched.map((item) => item.phraseIndex));
  let maxRun = 0;
  let run = 0;
  tokens.forEach((_, index) => {
    if (matchedIndexes.has(index)) {
      run = 0;
      return;
    }
    run += 1;
    maxRun = Math.max(maxRun, run);
  });
  return maxRun;
}

function scoreCandidate(tokens, transcriptTokens, startIndex) {
  const matched = [];
  let searchIndex = startIndex;
  let maxGapWords = 0;
  let maxGapSeconds = 0;

  tokens.forEach((token, phraseIndex) => {
    for (let tokenIndex = searchIndex; tokenIndex < transcriptTokens.length; tokenIndex += 1) {
      const transcriptToken = transcriptTokens[tokenIndex];
      if (transcriptToken.token !== token) continue;
      const previous = matched[matched.length - 1];
      if (previous) {
        maxGapWords = Math.max(maxGapWords, transcriptToken.wordIndex - previous.wordIndex - 1);
        maxGapSeconds = Math.max(maxGapSeconds, transcriptToken.start - previous.end);
      }
      matched.push({ ...transcriptToken, tokenIndex, phraseIndex });
      searchIndex = tokenIndex + 1;
      break;
    }
  });

  if (!matched.length) return null;
  const confidence = matched.length / tokens.length;
  const spanSeconds = matched[matched.length - 1].end - matched[0].start;
  const firstJumpWords = matched[0].wordIndex - transcriptTokens[startIndex].wordIndex;
  const valid = confidence >= 0.75
    && phraseEdgeMatched(tokens, matched)
    && maxUnmatchedPhraseRun(tokens, matched) <= 2
    && maxGapWords <= 6
    && maxGapSeconds <= 2.5
    && firstJumpWords <= 8
    && spanSeconds <= 12;

  return { matched, confidence, maxGapWords, maxGapSeconds, firstJumpWords, spanSeconds, valid };
}

function findWordMatch(tokens, transcriptTokens, cursorWordIndex) {
  if (!tokens.length || !transcriptTokens.length) return null;
  let best = null;
  for (let startIndex = 0; startIndex < transcriptTokens.length; startIndex += 1) {
    if (transcriptTokens[startIndex].wordIndex < cursorWordIndex) continue;
    const candidate = scoreCandidate(tokens, transcriptTokens, startIndex);
    if (!candidate || !candidate.valid) continue;
    const first = candidate.matched[0];
    const last = candidate.matched[candidate.matched.length - 1];
    const score = candidate.confidence * 100
      - candidate.maxGapWords * 4
      - candidate.maxGapSeconds * 3
      - candidate.firstJumpWords
      - Math.max(0, candidate.spanSeconds - 4);
    const ranked = { ...candidate, first, last, score };
    if (!best || ranked.score > best.score || (ranked.score === best.score && first.wordIndex < best.first.wordIndex)) {
      best = ranked;
    }
  }
  return best;
}

function findNextSegment(segments, segmentCursor, lastEnd) {
  for (let index = segmentCursor; index < segments.length; index += 1) {
    const segment = segments[index];
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (end <= lastEnd) continue;
    return { segment, index };
  }
  return null;
}

const FINAL_IMAGE_TAIL_SECONDS = 2;

function phraseTimelineStart(index, detectedStart, lastEnd) {
  if (index === 0) return 0;
  return Math.max(roundTime(lastEnd), roundTime(detectedStart));
}

function alignPhrasesToTranscript(phrases = [], transcript = {}) {
  const words = Array.isArray(transcript.words) ? transcript.words : [];
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const transcriptTokens = buildTranscriptTokens(words);
  const aligned = [];
  let cursorWordIndex = 0;
  let segmentCursor = 0;
  let lastEnd = 0;

  phrases.forEach((phrase, index) => {
    const tokens = phraseTokens(phrase.phrase || phrase.text || "");
    const match = findWordMatch(tokens, transcriptTokens, cursorWordIndex);

    if (match) {
      cursorWordIndex = match.last.wordIndex + 1;
      const start = phraseTimelineStart(index, match.first.start, lastEnd);
      const end = Math.max(start + 0.001, roundTime(match.last.end));
      const confidence = Number(match.confidence.toFixed(3));
      const driftSegment = findNearestSegment(segments, { start: match.first.start, end: match.last.end });
      const maxDriftMs = findSegmentDrift({ start: match.first.start, end: match.last.end }, driftSegment);
      const warnings = maxDriftMs > 250 ? [`word alignment drift exceeds 250ms (${maxDriftMs}ms)`] : [];
      const severity = warnings.length ? "warn" : "ok";
      aligned.push({
        id: phrase.id,
        phrase: phrase.phrase,
        startTime: start,
        endTime: end,
        alignment: { source: "word-match", confidence, severity, warnings, maxDriftMs },
      });
      lastEnd = end;
      return;
    }

    const nextSegment = findNextSegment(segments, segmentCursor, lastEnd);
    if (nextSegment) {
      segmentCursor = nextSegment.index + 1;
      const segment = nextSegment.segment;
      const start = phraseTimelineStart(index, segment.start, lastEnd);
      const end = Math.max(start + 0.001, roundTime(segment.end));
      aligned.push({
        id: phrase.id,
        phrase: phrase.phrase,
        startTime: start,
        endTime: end,
        alignment: { source: "segment-fallback", confidence: 0, severity: "error", warnings: ["segment fallback used because word alignment did not match phrase"] },
      });
      lastEnd = end;
      return;
    }

    const start = roundTime(lastEnd);
    const end = roundTime(start + 1);
    aligned.push({
      id: phrase.id,
      phrase: phrase.phrase,
      startTime: start,
      endTime: end,
      alignment: { source: "timeline-tail-fallback", confidence: 0, severity: "error", warnings: ["tail fallback used because transcript timings were incomplete"] },
    });
    lastEnd = end;
  });

  const finalPhraseEnd = aligned.length ? aligned[aligned.length - 1].endTime : 0;
  const totalDurationSeconds = Math.max(Number(transcript.totalDurationSeconds || 0), finalPhraseEnd + FINAL_IMAGE_TAIL_SECONDS, 0);
  return { totalDurationSeconds: roundTime(totalDurationSeconds), phrases: aligned, diagnostics: { phraseCount: phrases.length, alignedCount: aligned.length } };
}

module.exports = { alignPhrasesToTranscript };
