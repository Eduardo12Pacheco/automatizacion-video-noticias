const test = require("node:test");
const assert = require("node:assert/strict");
const {
  closeTimelineGaps,
  validateTimeline,
} = require("../scripts/lib/timeline-utils");

test("validateTimeline detecta huecos", () => {
  const issues = validateTimeline([
    { image: "a.jpg", startTime: 0, endTime: 2 },
    { image: "b.jpg", startTime: 2.5, endTime: 4 },
  ]);

  assert.equal(issues.length, 1);
  assert.match(issues[0], /Hueco detectado/);
});

test("closeTimelineGaps ajusta el endTime al siguiente startTime", () => {
  const fixed = closeTimelineGaps([
    { image: "a.jpg", startTime: 0, endTime: 2 },
    { image: "b.jpg", startTime: 2.5, endTime: 5 },
  ]);

  assert.equal(fixed[0].endTime, 2.5);
});
