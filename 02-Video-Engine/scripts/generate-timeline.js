const fs = require("fs");
const path = require("path");

const phraseTimestampsPath =
  process.argv[2] ||
  path.join(process.cwd(), "output", "phrase-timestamps.json");
const outputPath =
  process.argv[3] || path.join(process.cwd(), "output", "timeline.json");

if (!fs.existsSync(phraseTimestampsPath)) {
  throw new Error(
    `No existe output/phrase-timestamps.json. Ejecuta align-phrases primero. Ruta: ${phraseTimestampsPath}`,
  );
}

const phraseData = JSON.parse(fs.readFileSync(phraseTimestampsPath, "utf8"));
const phrases = phraseData.phrases || [];

const frames = phrases.map((item) => ({
  image: item.image,
  phrase: item.phrase,
  startTime: item.startTime,
  endTime: item.endTime,
}));

const payload = {
  totalDurationSeconds: phraseData.totalDurationSeconds,
  frames,
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Timeline generada en ${outputPath}`);
