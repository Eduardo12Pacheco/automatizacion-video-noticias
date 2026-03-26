const fs = require("fs");
const path = require("path");
const { alignPhrasesToTranscript } = require("./lib/phrase-alignment");

const HELP_FLAG = process.argv.includes("--help");

if (HELP_FLAG) {
  console.log(
    "Uso: node scripts/align-phrases.js [phrasesJson] [transcriptJson] [outputPath]",
  );
  process.exit(0);
}

const phrasesPath =
  process.argv[2] || path.join(process.cwd(), "output", "script-phrases.json");
const transcriptPath =
  process.argv[3] || path.join(process.cwd(), "output", "transcript.json");
const outputPath =
  process.argv[4] ||
  path.join(process.cwd(), "output", "phrase-timestamps.json");

if (!fs.existsSync(phrasesPath)) {
  throw new Error(
    `No existe output/script-phrases.json. Ejecuta primero process-script. Ruta buscada: ${phrasesPath}`,
  );
}

if (!fs.existsSync(transcriptPath)) {
  throw new Error(
    `No existe output/transcript.json. Ejecuta primero transcribe-audio para obtener segmentos reales. Ruta buscada: ${transcriptPath}`,
  );
}

const phrasesJson = JSON.parse(fs.readFileSync(phrasesPath, "utf8"));
const phrases = phrasesJson.phrases || [];
const transcriptJson = JSON.parse(fs.readFileSync(transcriptPath, "utf8"));

const alignedPayload = alignPhrasesToTranscript(phrases, transcriptJson);

fs.writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      totalDurationSeconds: alignedPayload.totalDurationSeconds,
      transcriptBackend: transcriptJson.backend || "unknown",
      phrases: alignedPayload.phrases,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Frases alineadas con transcript real. Duracion total: ${alignedPayload.totalDurationSeconds}s`,
);
