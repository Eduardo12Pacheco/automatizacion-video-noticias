function parseGuionSegments(input = "") {
  const parts = String(input || "").split("|");
  return parts.map((part, index) => {
    const phrase = part.trim();
    if (!phrase) throw new Error(`bloque ${index + 1} vacio`);
    const segment = { blockIndex: index + 1, phrase };
    if (index < parts.length - 1 && /(?:\r?\n\s*){2,}$/.test(part)) segment.paragraphBoundaryAfter = true;
    return segment;
  });
}

module.exports = { parseGuionSegments };
