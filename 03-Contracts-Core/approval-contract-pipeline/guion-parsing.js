function isPipeOnOwnLine(input, pipeIndex) {
  const beforeLineStart = input.lastIndexOf("\n", pipeIndex - 1) + 1;
  const afterLineEndIndex = input.indexOf("\n", pipeIndex + 1);
  const afterLineEnd = afterLineEndIndex === -1 ? input.length : afterLineEndIndex;
  const beforePipe = input.slice(beforeLineStart, pipeIndex);
  const afterPipe = input.slice(pipeIndex + 1, afterLineEnd);
  const hasLineBreakBefore = beforeLineStart > 0;
  const hasLineBreakAfter = afterLineEndIndex !== -1;
  return hasLineBreakBefore && hasLineBreakAfter && /^\s*$/.test(beforePipe) && /^\s*$/.test(afterPipe);
}

function parseGuionSegments(input = "") {
  const rawInput = String(input || "");
  const parts = rawInput.split("|");
  const pipeIndexes = [];
  for (let index = rawInput.indexOf("|"); index !== -1; index = rawInput.indexOf("|", index + 1)) {
    pipeIndexes.push(index);
  }
  return parts.map((part, index) => {
    const phrase = part.trim();
    if (!phrase) throw new Error(`bloque ${index + 1} vacio`);
    const segment = { blockIndex: index + 1, phrase };
    const pipeIndex = pipeIndexes[index];
    if (index < parts.length - 1 && (/(?:\r?\n\s*){2,}$/.test(part) || isPipeOnOwnLine(rawInput, pipeIndex))) segment.paragraphBoundaryAfter = true;
    return segment;
  });
}

module.exports = { parseGuionSegments };
