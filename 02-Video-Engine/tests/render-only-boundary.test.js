const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const videoEngineRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(videoEngineRoot, "..");
const packageJsonPath = path.join(videoEngineRoot, "package.json");
const readmePath = path.join(videoEngineRoot, "README.md");
const approvalEditorRoot = path.join(workspaceRoot, "01-Control-Panel", "services", "approval-editor");

function readPackageScripts() {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).scripts || {};
}

function walkJsFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walkJsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

test("package scripts keep official commands and drop deleted legacy manual pipeline entries", () => {
  const scripts = readPackageScripts();
  const officialScripts = ["render:video", "test", "check:render-boundary"];
  for (const name of officialScripts) {
    assert.equal(typeof scripts[name], "string", `${name} should remain an official script`);
    assert.equal(scripts[name].startsWith("npm run legacy:"), false, `${name} must not proxy through a legacy script`);
  }

  assert.equal(
    scripts["legacy:approval-service:local"],
    "node scripts/approval-pipeline-local-service.js",
    "medium-confidence local approval service stays deferred while its file exists",
  );
  assert.equal(
    scripts["legacy:diagnose:stt"],
    "py scripts/transcribe-audio.py --diagnose-backends",
    "Control Panel Python STT compatibility script stays available",
  );
  assert.equal(
    scripts["legacy:install:python-deps"],
    "py -m pip install -r requirements.txt",
    "Python dependency helper may stay because it does not reference a deleted file",
  );

  const retiredManualScripts = [
    "approval:service:local",
    "diagnose:stt",
    "download:vosk-model",
    "fix:timeline",
    "generate:timeline",
    "install:python-deps",
    "normalize:audio",
    "pipeline",
    "process:script",
    "setup:project",
    "transcribe:audio",
    "verify:sync",
    "legacy:download:vosk-model",
    "legacy:fix:timeline",
    "legacy:generate:timeline",
    "legacy:normalize:audio",
    "legacy:pipeline",
    "legacy:process:script",
    "legacy:setup:project",
    "legacy:transcribe:audio",
    "legacy:verify:sync",
  ];
  for (const name of retiredManualScripts) {
    assert.equal(Object.hasOwn(scripts, name), false, `${name} should not reference the deleted manual pipeline`);
  }
});

test("README leads with render-only happy path, deletion criteria, deferred paths, and safe checks", () => {
  const readme = fs.readFileSync(readmePath, "utf8");
  const expectedSnippets = [
    "## Official render-only flow",
    "node scripts/render-video.js --project-root=projects/<id> --profile=final",
    "projects/<id>/output/video-final.mp4",
    "## Deletion boundary for legacy cleanup",
    "Deleted in this work unit",
    "Deferred, still present",
    "scripts/transcribe-audio.py",
    "npm run check:render-boundary",
    "Do not run builds, heavy Remotion renders, model/CUDA/audio generation, or visual exports for this cleanup check.",
  ];
  for (const snippet of expectedSnippets) {
    assert.equal(readme.includes(snippet), true, `README should document: ${snippet}`);
  }
});

test("Control Panel approval editor imports only approved Video Engine render boundary paths", () => {
  const scripts = readPackageScripts();
  assert.equal(scripts["check:render-boundary"], "node --test tests/render-only-boundary.test.js");

  const disallowedImportPattern = /(?:require\(|from\s+)["'][^"']*02-Video-Engine\/(?:scripts\/lib|scripts\/legacy-pipeline|scripts\/(?:process-script|align-phrases|generate-timeline|setup-project|verify-sync|normalize-audio|transcribe-audio)\.(?:js|py))/g;
  const violations = [];
  for (const filePath of walkJsFiles(approvalEditorRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    const matches = source.match(disallowedImportPattern) || [];
    for (const match of matches) {
      violations.push(`${path.relative(workspaceRoot, filePath)}: ${match}`);
    }
  }

  assert.deepEqual(violations, []);
});

test("deleted high-confidence legacy pipeline paths stay absent while render assets and compatibility paths stay protected", () => {
  const deletedPaths = [
    "scripts/legacy-pipeline",
    "resources/legacy-pipeline",
    "scripts/setup-project.js",
    "scripts/process-script.js",
    "scripts/normalize-audio.js",
    "scripts/transcribe-audio.js",
    "scripts/align-phrases.js",
    "scripts/generate-timeline.js",
    "scripts/fix-timeline.js",
    "scripts/verify-sync.js",
    "scripts/download-vosk-model.py",
  ];
  for (const relativePath of deletedPaths) {
    assert.equal(
      fs.existsSync(path.join(videoEngineRoot, relativePath)),
      false,
      `${relativePath} should be deleted from the render-only work unit`,
    );
  }

  const shimPaths = [
    "scripts/lib/approval-contract-pipeline.js",
    "scripts/lib/approval-input-preparation.js",
    "scripts/lib/approval-project-store.js",
    "scripts/lib/approval-response-adapter.js",
    "scripts/lib/composition-contract.js",
    "scripts/lib/editor-project.js",
    "scripts/lib/guion-parsing.js",
    "scripts/lib/image-search-provider.js",
    "scripts/lib/image-selection.js",
    "scripts/lib/json-contracts.js",
    "scripts/lib/media-utils.js",
    "scripts/lib/phrase-alignment.js",
    "scripts/lib/schemas.js",
    "scripts/lib/timeline-utils.js",
  ];
  for (const relativePath of shimPaths) {
    assert.equal(
      fs.existsSync(path.join(videoEngineRoot, relativePath)),
      false,
      `${relativePath} compatibility shim should be deleted`,
    );
  }

  const protectedPaths = [
    "scripts/render-video.js",
    "scripts/render/render-video.js",
    "scripts/lib/contracts/composition-contract.js",
    "scripts/transcribe-audio.py",
    "src/remotion/Root.tsx",
    "src/remotion/Composition.tsx",
    "assets/overlays",
  ];
  for (const relativePath of protectedPaths) {
    assert.equal(
      fs.existsSync(path.join(videoEngineRoot, relativePath)),
      true,
      `${relativePath} should remain available for official render or compatibility`,
    );
  }
});

test("gitignore ignores only runtime projects while keeping source project helpers trackable", () => {
  const ignoredRuntime = spawnGitCheckIgnore("projects/draft-42/output/video-final.mp4");
  assert.equal(ignoredRuntime.status, 0, ignoredRuntime.stderr || ignoredRuntime.stdout);

  const requiredSources = [
    "scripts/lib/projects/editor-project.js",
    "scripts/lib/projects/approval-project-store.js",
  ];
  for (const relativePath of requiredSources) {
    const result = spawnGitCheckIgnore(relativePath);
    assert.equal(result.status, 1, `${relativePath} must not be hidden by the runtime projects/ ignore rule`);

    const absolutePath = path.join(videoEngineRoot, relativePath);
    assert.equal(fs.existsSync(absolutePath), true, `${relativePath} should exist in clean checkout source`);
  }
});

test("required project modules resolve from a clean checkout source tree", () => {
  const editorProject = require(path.join(videoEngineRoot, "scripts", "lib", "projects", "editor-project"));
  const approvalProjectStore = require(path.join(videoEngineRoot, "scripts", "lib", "projects", "approval-project-store"));

  assert.equal(editorProject.stableId("Draft Luis Díaz!"), "draft-luis-diaz");
  assert.equal(typeof editorProject.createEditorProject, "function");
  assert.equal(typeof approvalProjectStore.createApprovalProjectStore, "function");
});

function spawnGitCheckIgnore(relativePath) {
  return require("node:child_process").spawnSync("git", ["check-ignore", "--no-index", relativePath], {
    cwd: videoEngineRoot,
    encoding: "utf8",
  });
}
