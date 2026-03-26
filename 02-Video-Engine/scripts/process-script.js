const fs = require("fs");
const path = require("path");

const HELP_FLAG = process.argv.includes("--help");

if (HELP_FLAG) {
  console.log(
    "Uso: node scripts/process-script.js [guionPath] [imagenesDir] [outputPath]",
  );
  process.exit(0);
}

const stopwords = new Set([
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
]);

const guionPath =
  process.argv[2] || path.join(process.cwd(), "guion", "guion.txt");
const imagenesDir = process.argv[3] || path.join(process.cwd(), "imagenes");
const outputDir = process.argv[4] || path.join(process.cwd(), "output");

if (!fs.existsSync(guionPath)) {
  throw new Error(`No existe el guion en: ${guionPath}`);
}

fs.mkdirSync(outputDir, { recursive: true });

const guionRaw = fs.readFileSync(guionPath, "utf8").trim();
const phrases = guionRaw
  .split("|")
  .map((phrase) => phrase.trim())
  .filter(Boolean);

const imageFiles = fs.existsSync(imagenesDir)
  ? fs
      .readdirSync(imagenesDir)
      .filter((file) => /\.(png|jpg|jpeg|webp|svg)$/i.test(file))
  : [];

const fallbackImage =
  imageFiles[0] ||
  "https://images.unsplash.com/photo-1470229722913-7c0e2dbbafd3";

const extractKeywords = (text) => {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopwords.has(token));
};

const findImageForPhrase = (keywords) => {
  if (imageFiles.length === 0) {
    return fallbackImage;
  }

  const match = imageFiles.find((fileName) => {
    const normalizedFile = fileName.toLowerCase();
    return keywords.some((keyword) => normalizedFile.includes(keyword));
  });

  if (match) {
    return match;
  }

  const randomIndex = Math.floor(Math.random() * imageFiles.length);
  return imageFiles[randomIndex];
};

const phraseData = phrases.map((phrase, index) => {
  const keywords = extractKeywords(phrase);
  return {
    id: index + 1,
    phrase,
    keywords,
    image: findImageForPhrase(keywords),
  };
});

fs.writeFileSync(
  path.join(outputDir, "script-phrases.json"),
  `${JSON.stringify({ phrases: phraseData }, null, 2)}\n`,
  "utf8",
);

console.log(`Guion procesado. Frases detectadas: ${phraseData.length}`);
