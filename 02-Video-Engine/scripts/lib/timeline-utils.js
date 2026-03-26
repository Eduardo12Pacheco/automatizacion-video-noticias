function sortByStart(segments) {
  return [...segments].sort((a, b) => a.startTime - b.startTime);
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

function closeTimelineGaps(segments, totalDurationSeconds = null) {
  const sorted = sortByStart(segments).map((segment) => ({ ...segment }));

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    const next = sorted[i + 1];

    if (next) {
      current.endTime = Number(next.startTime.toFixed(6));
      continue;
    }

    if (typeof totalDurationSeconds === "number") {
      current.endTime = Number(totalDurationSeconds.toFixed(6));
    }
  }

  return sorted;
}

module.exports = {
  closeTimelineGaps,
  validateTimeline,
};
