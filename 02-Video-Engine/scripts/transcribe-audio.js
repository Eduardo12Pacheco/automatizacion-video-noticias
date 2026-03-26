const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = process.cwd();
const scriptPath = path.join(projectRoot, "scripts", "transcribe-audio.py");

const args = [scriptPath, ...process.argv.slice(2)];
const result = spawnSync("py", args, {
  cwd: projectRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
