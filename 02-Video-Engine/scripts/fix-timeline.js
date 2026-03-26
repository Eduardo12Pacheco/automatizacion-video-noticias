const fs = require("fs");
const path = require("path");
const { closeTimelineGaps } = require("./lib/timeline-utils");

const timelinePath =
  process.argv[2] || path.join(process.cwd(), "output", "timeline.json");

if (!fs.existsSync(timelinePath)) {
  throw new Error(`No existe timeline.json en: ${timelinePath}`);
}

const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
const fixedFrames = closeTimelineGaps(
  timeline.frames || [],
  Number(timeline.totalDurationSeconds || 0),
);

const fixedTimeline = {
  ...timeline,
  frames: fixedFrames,
};

fs.writeFileSync(
  timelinePath,
  `${JSON.stringify(fixedTimeline, null, 2)}\n`,
  "utf8",
);
console.log("Timeline ajustada para cerrar huecos entre imagenes.");
