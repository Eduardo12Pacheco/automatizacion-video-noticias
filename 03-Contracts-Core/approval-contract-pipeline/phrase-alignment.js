function roundTime(value) {
  return Number(Number(value || 0).toFixed(3));
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function phraseTokens(phrase) {
  return String(phrase || "").split(/\s+/).map(normalizeToken).filter(Boolean);
}

function wordToken(word = {}) {
  return normalizeToken(word.word || word.text || "");
}

function findSegmentDrift(match, segment) {
  if (!segment) return 0;
  const startDrift = Math.abs(Number(match.start || 0) - Number(segment.start || 0));
  const endDrift = Math.abs(Number(match.end || 0) - Number(segment.end || 0));
  return Math.round(Math.max(startDrift, endDrift) * 1000);
}

function alignPhrasesToTranscript(phrases = [], transcript = {}) {
  const words = Array.isArray(transcript.words) ? transcript.words : [];
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const aligned = [];
  let cursor = 0;
  let lastEnd = 0;

  phrases.forEach((phrase, index) => {
    const tokens = phraseTokens(phrase.phrase || phrase.text || "");
    const matched = [];
    let searchFrom = cursor;
    for (const token of tokens) {
      const foundIndex = words.findIndex((word, wordIndex) => wordIndex >= searchFrom && wordToken(word) === token);
      if (foundIndex === -1) break;
      matched.push({ ...words[foundIndex], index: foundIndex });
      searchFrom = foundIndex + 1;
    }

    if (tokens.length && matched.length) {
      cursor = matched[matched.length - 1].index + 1;
      const start = index === 0 ? 0 : roundTime(matched[0].start);
      const end = Math.max(start + 0.001, roundTime(matched[matched.length - 1].end));
      const confidence = Number((matched.length / tokens.length).toFixed(3));
      const maxDriftMs = findSegmentDrift({ start: matched[0].start, end: matched[matched.length - 1].end }, segments[index]);
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

    const segment = segments[index];
    if (segment && Number.isFinite(Number(segment.end)) && Number(segment.end) > Number(segment.start || 0)) {
      const start = index === 0 ? 0 : roundTime(segment.start);
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

  const totalDurationSeconds = Math.max(Number(transcript.totalDurationSeconds || 0), ...aligned.map((phrase) => phrase.endTime), 0);
  return { totalDurationSeconds: roundTime(totalDurationSeconds), phrases: aligned, diagnostics: { phraseCount: phrases.length, alignedCount: aligned.length } };
}

module.exports = { alignPhrasesToTranscript };
