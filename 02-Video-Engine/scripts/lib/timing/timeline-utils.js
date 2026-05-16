const { timelineSchema } = require("../contracts/schemas");
const { validateJsonSchema } = require("../contracts/json-contracts");

function sortByStart(segments) {
  return [...segments].sort((a, b) => a.startTime - b.startTime);
}

function roundTime(value) {
  return Number(Number(value || 0).toFixed(6));
}

function secondsToFrame(seconds, fps = 30) {
  return Math.max(0, Math.round(roundTime(seconds) * fps));
}

function secondsToDurationFrames(startSeconds, endSeconds, fps = 30) {
  return Math.max(1, secondsToFrame(endSeconds, fps) - secondsToFrame(startSeconds, fps));
}

function frameToSeconds(frame, fps = 30) {
  return roundTime(Math.max(0, frame) / fps);
}

function normalizeTimelineFrames(segments, totalDurationSeconds = null) {
  const sorted = sortByStart(segments).map((segment) => ({
    ...segment,
    startTime: roundTime(segment.startTime),
    endTime: roundTime(segment.endTime),
  }));

  if (sorted.length === 0) {
    return sorted;
  }

  sorted[0].startTime = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (next) {
      current.endTime = roundTime(next.startTime);
      continue;
    }

    if (
      typeof totalDurationSeconds === "number" &&
      Number.isFinite(totalDurationSeconds)
    ) {
      current.endTime = roundTime(totalDurationSeconds);
    }
  }

  return sorted;
}

function validateTimeline(segments, toleranceSeconds = 0.001) {
  const sorted = sortByStart(segments);
  const issues = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current.endTime <= current.startTime) {
      issues.push(
        `Segmento invalido (${current.image}): endTime debe ser mayor a startTime`,
      );
    }

    const next = sorted[i + 1];
    if (!next) {
      continue;
    }

    const delta = Number((next.startTime - current.endTime).toFixed(6));
    if (delta > toleranceSeconds) {
      issues.push(
        `Hueco detectado entre ${current.image} y ${next.image}: ${delta}s`,
      );
    }
    if (delta < -toleranceSeconds) {
      issues.push(
        `Solapamiento detectado entre ${current.image} y ${next.image}: ${Math.abs(delta)}s`,
      );
    }
  }

  return issues;
}

function validateCanonicalTimeline(
  timeline,
  { expectedDurationSeconds = null, toleranceSeconds = 0.001 } = {},
) {
  const frames = timeline.frames || [];
  const issues = [];

  if (frames.length === 0) {
    issues.push("timeline.json debe contener al menos un segmento canonico.");
    return issues;
  }

  if (Math.abs(frames[0].startTime - 0) > toleranceSeconds) {
    issues.push(
      `segmento 0 debe iniciar en 0.00; inicio actual ${roundTime(frames[0].startTime)}s`,
    );
  }

  for (let i = 0; i < frames.length; i += 1) {
    const current = frames[i];

    if (current.endTime <= current.startTime) {
      issues.push(
        `segmento ${i} invalido: endTime ${roundTime(current.endTime)}s debe ser mayor a startTime ${roundTime(current.startTime)}s`,
      );
    }

    const next = frames[i + 1];
    if (!next) {
      continue;
    }

    const delta = roundTime(next.startTime - current.endTime);
    if (delta > toleranceSeconds) {
      issues.push(
        `gap entre segmento ${i} y segmento ${i + 1}: endTime ${roundTime(current.endTime)}s -> startTime ${roundTime(next.startTime)}s (${delta}s)`,
      );
    }
    if (delta < -toleranceSeconds) {
      issues.push(
        `overlap entre segmento ${i} y segmento ${i + 1}: endTime ${roundTime(current.endTime)}s -> startTime ${roundTime(next.startTime)}s (${Math.abs(delta)}s)`,
      );
    }
  }

  const expected =
    typeof expectedDurationSeconds === "number" &&
    Number.isFinite(expectedDurationSeconds)
      ? expectedDurationSeconds
      : timeline.totalDurationSeconds;
  const lastFrame = frames[frames.length - 1];

  if (Math.abs(lastFrame.endTime - expected) > toleranceSeconds) {
    issues.push(
      `ultimo segmento debe terminar en ${roundTime(expected)}s; endTime actual ${roundTime(lastFrame.endTime)}s`,
    );
  }

  if (Math.abs(timeline.totalDurationSeconds - expected) > toleranceSeconds) {
    issues.push(
      `totalDurationSeconds debe ser ${roundTime(expected)}s; valor actual ${roundTime(timeline.totalDurationSeconds)}s`,
    );
  }

  return issues;
}

function assertCanonicalTimeline(timeline, options = {}) {
  const contractPath = options.contractPath || "timeline.json";
  const parsed = validateJsonSchema(contractPath, timelineSchema, timeline);
  const issues = validateCanonicalTimeline(parsed, options);

  if (issues.length > 0) {
    throw new Error(
      `Contrato timeline canonico invalido en ${contractPath}: ${issues.join("; ")}`,
    );
  }

  return parsed;
}

function buildCanonicalDiagnostics({
  totalDurationSeconds,
  frames,
  diagnostics = {},
}) {
  const alignmentWarnings = frames.flatMap(
    (frame) => frame.alignment?.warnings || [],
  );
  const imageWarnings = frames.flatMap(
    (frame) => frame.imageSelection?.warnings || [],
  );

  return {
    ...diagnostics,
    durationSeconds: roundTime(totalDurationSeconds),
    segmentCount: frames.length,
    warnings: [
      ...(diagnostics.warnings || []),
      ...alignmentWarnings,
      ...imageWarnings,
    ],
    failures: diagnostics.failures || [],
  };
}

function buildCanonicalTimeline({
  totalDurationSeconds,
  phrases = [],
  diagnostics = {},
}) {
  const duration = roundTime(totalDurationSeconds);
  const frames = normalizeTimelineFrames(
    phrases.map((item) => ({
      id: item.id,
      phrase: item.phrase,
      image: item.image,
      startTime: item.startTime,
      endTime: item.endTime,
      alignment: item.alignment,
      imageSelection: item.imageSelection,
    })),
    duration,
  );
  const timeline = {
    totalDurationSeconds: duration,
    frames,
    diagnostics: buildCanonicalDiagnostics({
      totalDurationSeconds: duration,
      frames,
      diagnostics,
    }),
  };

  return assertCanonicalTimeline(timeline);
}

function closeTimelineGaps(segments, totalDurationSeconds = null) {
  return normalizeTimelineFrames(segments, totalDurationSeconds);
}

function buildTimelineQualityReport({
  timelineFrames,
  timelineTotalDurationSeconds,
  expectedDurationSeconds = null,
  visualSegments = [],
}) {
  const issues = validateTimeline(timelineFrames || []);
  const sorted = sortByStart(timelineFrames || []);
  const firstFrameStartsAtZero =
    sorted.length === 0 || sorted[0].startTime === 0;
  const lastFrameEndsAtExpectedDuration =
    sorted.length === 0 || typeof expectedDurationSeconds !== "number"
      ? true
      : roundTime(sorted[sorted.length - 1].endTime) ===
        roundTime(expectedDurationSeconds);

  if (!firstFrameStartsAtZero) {
    issues.push("La primera imagen no arranca en 0.00.");
  }
  if (
    !lastFrameEndsAtExpectedDuration &&
    typeof expectedDurationSeconds === "number"
  ) {
    issues.push(
      `El ultimo segmento no termina en la duracion esperada (${roundTime(expectedDurationSeconds)}s).`,
    );
  }

  const placeholderSegments = visualSegments.filter(
    (segment) => segment.strategy === "placeholder",
  ).length;
  const deterministicFallbackSegments = visualSegments.filter(
    (segment) => segment.strategy === "deterministic-fallback",
  ).length;

  return {
    summary: {
      frameCount: sorted.length,
      timelineTotalDurationSeconds: roundTime(timelineTotalDurationSeconds),
      expectedDurationSeconds:
        typeof expectedDurationSeconds === "number"
          ? roundTime(expectedDurationSeconds)
          : null,
      placeholderSegments,
      deterministicFallbackSegments,
    },
    checks: {
      firstFrameStartsAtZero,
      hasNoGapsOrOverlaps: issues.every(
        (issue) => !/Hueco detectado|Solapamiento detectado/.test(issue),
      ),
      lastFrameEndsAtExpectedDuration,
    },
    issues,
  };
}

module.exports = {
  assertCanonicalTimeline,
  buildCanonicalTimeline,
  buildTimelineQualityReport,
  closeTimelineGaps,
  normalizeTimelineFrames,
  secondsToDurationFrames,
  secondsToFrame,
  frameToSeconds,
  validateCanonicalTimeline,
  validateTimeline,
};
