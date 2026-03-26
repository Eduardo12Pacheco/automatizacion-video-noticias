function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

function toRoundedTimestamp(value) {
  return Number(Number(value || 0).toFixed(3));
}

function ensurePositiveRange(start, end, minimumDurationSeconds = 0.2) {
  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) ? end : safeStart;
  if (safeEnd > safeStart) {
    return {
      start: safeStart,
      end: safeEnd,
    };
  }

  return {
    start: safeStart,
    end: safeStart + minimumDurationSeconds,
  };
}

function getTranscriptWords(transcript) {
  if (!Array.isArray(transcript.words)) {
    return [];
  }

  return transcript.words
    .map((word) => {
      const token = tokenize(word.word)[0] || "";
      return {
        word: String(word.word || "").trim(),
        token,
        start: Number(word.start || 0),
        end: Number(word.end || 0),
      };
    })
    .filter(
      (word) =>
        word.token && Number.isFinite(word.start) && Number.isFinite(word.end),
    );
}

function getTranscriptSegments(transcript) {
  if (!Array.isArray(transcript.segments)) {
    return [];
  }

  return transcript.segments
    .map((segment, index) => ({
      id: segment.id || index + 1,
      text: String(segment.text || "").trim(),
      start: Number(segment.start || 0),
      end: Number(segment.end || 0),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.start) && Number.isFinite(segment.end),
    );
}

function advanceWordCursorByTime(words, currentCursor, endTime) {
  let cursor = currentCursor;
  while (cursor < words.length && words[cursor].end <= endTime) {
    cursor += 1;
  }
  return cursor;
}

function tryMatchPhraseWords(phraseTokens, transcriptWords, startCursor) {
  if (phraseTokens.length === 0 || transcriptWords.length === 0) {
    return null;
  }

  const matchedIndexes = [];
  let searchCursor = startCursor;

  for (const token of phraseTokens) {
    while (
      searchCursor < transcriptWords.length &&
      transcriptWords[searchCursor].token !== token
    ) {
      searchCursor += 1;
    }

    if (searchCursor >= transcriptWords.length) {
      break;
    }

    matchedIndexes.push(searchCursor);
    searchCursor += 1;
  }

  const minimumMatchRatio = phraseTokens.length <= 2 ? 1 : 0.6;
  const matchRatio = matchedIndexes.length / phraseTokens.length;
  if (matchedIndexes.length === 0 || matchRatio < minimumMatchRatio) {
    return null;
  }

  const first = transcriptWords[matchedIndexes[0]];
  const last = transcriptWords[matchedIndexes[matchedIndexes.length - 1]];

  return {
    start: first.start,
    end: last.end,
    nextCursor: matchedIndexes[matchedIndexes.length - 1] + 1,
    matchedWords: matchedIndexes.length,
    totalWords: phraseTokens.length,
    source: "word-match",
  };
}

function alignPhrasesToTranscript(phrases, transcript) {
  const transcriptWords = getTranscriptWords(transcript);
  const transcriptSegments = getTranscriptSegments(transcript);

  if (transcriptWords.length === 0 && transcriptSegments.length === 0) {
    throw new Error(
      "El transcript no contiene words ni segments. Ejecuta transcribe-audio para generar output/transcript.json con timestamps reales.",
    );
  }

  const inferredDuration = Number(
    transcript.totalDurationSeconds ||
      transcriptSegments[transcriptSegments.length - 1]?.end ||
      transcriptWords[transcriptWords.length - 1]?.end ||
      0,
  );

  let wordCursor = 0;
  let segmentCursor = 0;
  let lastEnd = 0;
  const minimumDurationSeconds = 0.2;

  const aligned = phrases.map((item) => {
    const phraseTokens = tokenize(item.phrase);
    const matched = tryMatchPhraseWords(
      phraseTokens,
      transcriptWords,
      wordCursor,
    );

    if (matched) {
      const range = ensurePositiveRange(
        matched.start,
        matched.end,
        minimumDurationSeconds,
      );
      wordCursor = matched.nextCursor;
      lastEnd = Math.max(lastEnd, range.end);

      while (
        segmentCursor < transcriptSegments.length &&
        transcriptSegments[segmentCursor].end <= matched.end
      ) {
        segmentCursor += 1;
      }

      return {
        ...item,
        startTime: toRoundedTimestamp(range.start),
        endTime: toRoundedTimestamp(range.end),
        alignment: {
          source: matched.source,
          matchedWords: matched.matchedWords,
          totalWords: matched.totalWords,
        },
      };
    }

    if (segmentCursor < transcriptSegments.length) {
      const segment = transcriptSegments[segmentCursor];
      segmentCursor += 1;
      const rawStart = Math.max(lastEnd, segment.start);
      const rawEnd = Math.max(rawStart, segment.end);
      const range = ensurePositiveRange(
        rawStart,
        rawEnd,
        minimumDurationSeconds,
      );
      lastEnd = range.end;
      wordCursor = advanceWordCursorByTime(
        transcriptWords,
        wordCursor,
        range.end,
      );

      return {
        ...item,
        startTime: toRoundedTimestamp(range.start),
        endTime: toRoundedTimestamp(range.end),
        alignment: {
          source: "segment-fallback",
          matchedWords: 0,
          totalWords: phraseTokens.length,
        },
      };
    }

    const tailWord = transcriptWords[wordCursor];
    const rawStart = tailWord ? Math.max(lastEnd, tailWord.start) : lastEnd;
    const tailEnd = Math.max(
      transcriptWords[transcriptWords.length - 1]?.end || 0,
      inferredDuration,
    );
    const rawEnd = Math.max(rawStart, tailEnd);
    const range = ensurePositiveRange(rawStart, rawEnd, minimumDurationSeconds);
    wordCursor = transcriptWords.length;
    lastEnd = range.end;

    return {
      ...item,
      startTime: toRoundedTimestamp(range.start),
      endTime: toRoundedTimestamp(range.end),
      alignment: {
        source: "timeline-tail-fallback",
        matchedWords: 0,
        totalWords: phraseTokens.length,
      },
    };
  });

  return {
    phrases: aligned,
    totalDurationSeconds: toRoundedTimestamp(
      Math.max(inferredDuration, lastEnd),
    ),
  };
}

module.exports = {
  alignPhrasesToTranscript,
  normalizeText,
  tokenize,
};
