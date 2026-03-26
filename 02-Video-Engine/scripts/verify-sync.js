const fs = require("fs");
const path = require("path");
const { validateTimeline } = require("./lib/timeline-utils");

const timelinePath =
  process.argv[2] || path.join(process.cwd(), "output", "timeline.json");

if (!fs.existsSync(timelinePath)) {
  throw new Error(`No existe timeline.json en: ${timelinePath}`);
}

const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const issues = validateTimeline(timeline.frames || []);

if (issues.length > 0) {
  console.error("Verificacion fallida. Problemas encontrados:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log("Sincronizacion validada: sin huecos ni solapamientos.");
