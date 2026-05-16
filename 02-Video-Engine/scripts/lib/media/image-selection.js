const path = require("path");
const fs = require("fs");
const { imageMetadataSchema } = require("../contracts/schemas");

const PIPELINE_PLACEHOLDER_TOKEN = "__pipeline_placeholder__";
const STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "y",
  "a",
  "en",
  "que",
  "con",
  "por",
  "para",
  "del",
  "los",
  "las",
  "un",
  "una",
  "sin",
  "esto",
  "nada",
  "hay",
]);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywords(text) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function sortImageFiles(imageFiles) {
  return [...imageFiles].sort((left, right) =>
    left.localeCompare(right, undefined, {
      sensitivity: "base",
      numeric: true,
    }),
  );
}

function scoreImageCandidate(fileName, keywords) {
  return scoreImageCandidateWithMetadata(fileName, keywords);
}

function getMetadataForFile(metadata, fileName) {
  return (metadata?.images || []).find(
    (entry) =>
      entry.file.localeCompare(fileName, undefined, { sensitivity: "base" }) ===
      0,
  );
}

function scoreImageCandidateWithMetadata(fileName, keywords, metadataEntry) {
  const normalizedFileName = normalizeText(
    path.basename(fileName, path.extname(fileName)),
  );
  const metadataTerms = [
    ...(metadataEntry?.aliases || []),
    ...(metadataEntry?.tags || []),
  ]
    .map(normalizeText)
    .filter(Boolean);
  const searchableTerms = [normalizedFileName, ...metadataTerms];
  const matchedKeywords = [...new Set(keywords)].filter((keyword) =>
    searchableTerms.some((term) => term.includes(keyword)),
  );
  const weight = Number(metadataEntry?.weight || 1);
  const score = matchedKeywords.length * (Number.isFinite(weight) ? weight : 1);

  return {
    fileName,
    matchedKeywords,
    score,
    hasMetadataMatch: Boolean(metadataEntry && matchedKeywords.length > 0),
  };
}

function readImageMetadata(metadataPath) {
  if (!fs.existsSync(metadataPath)) {
    return { images: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const result = imageMetadataSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Metadata de imagenes invalida en ${metadataPath}: ${issues}`,
    );
  }

  return result.data;
}

function selectImageForPhrase({
  phrase,
  keywords = extractKeywords(phrase),
  imageFiles,
  metadata = { images: [] },
  previousImage = null,
}) {
  const sortedImages = sortImageFiles(imageFiles || []);
  if (sortedImages.length === 0) {
    return {
      image: PIPELINE_PLACEHOLDER_TOKEN,
      strategy: "placeholder",
      matchedKeywords: [],
      score: 0,
      reason: "no-images-available",
      severity: "warn",
      warnings: ["Sin imagenes disponibles: se usa placeholder del pipeline."],
    };
  }

  const scored = sortedImages
    .map((fileName) =>
      scoreImageCandidateWithMetadata(
        fileName,
        keywords,
        getMetadataForFile(metadata, fileName),
      ),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.fileName.localeCompare(right.fileName, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });
  const acceptableCandidates = scored.filter((candidate) => candidate.score > 0);
  const winner =
    acceptableCandidates.find(
      (candidate) => candidate.fileName !== previousImage,
    ) ||
    acceptableCandidates[0];

  if (winner) {
    const avoidedRepetition =
      previousImage &&
      winner.fileName !== previousImage &&
      acceptableCandidates[0]?.fileName === previousImage;
    return {
      image: winner.fileName,
      strategy: winner.hasMetadataMatch ? "metadata-match" : "keyword-match",
      matchedKeywords: winner.matchedKeywords,
      score: winner.score,
      reason: avoidedRepetition
        ? "avoided-immediate-repetition"
        : "highest-keyword-score",
      severity: "ok",
      warnings: [],
    };
  }

  return {
    image: PIPELINE_PLACEHOLDER_TOKEN,
    strategy: "placeholder",
    matchedKeywords: [],
    score: 0,
    reason: "no-acceptable-match",
    severity: "warn",
    warnings: [
      "Sin match aceptable para la frase: se usa placeholder del pipeline.",
    ],
  };
}

module.exports = {
  PIPELINE_PLACEHOLDER_TOKEN,
  extractKeywords,
  normalizeText,
  readImageMetadata,
  scoreImageCandidate,
  selectImageForPhrase,
  sortImageFiles,
};
