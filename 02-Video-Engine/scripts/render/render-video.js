const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { assertCanonicalTimeline } = require("../lib/timeline-utils");
const { readJsonSchema, writeJsonSchema } = require("../lib/json-contracts");
const { diagnosticsSchema, editorProjectSchema, renderPropsSchema, timelineSchema } = require("../lib/schemas");
const {
  deriveRenderPropsFromEditorProject,
  updateProjectConfig,
} = require("../lib/editor-project");
const { adaptCompositionContractToRenderProps } = require("../lib/composition-contract");
const {
  PIPELINE_PLACEHOLDER_TOKEN,
  resolveProjectRoot,
  resolveRenderAudio,
  resolveVisualSegment,
} = require("../lib/media-utils");

const dryRun = process.argv.includes("--dry-run");
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
const renderProfile = String(profileArg ? profileArg.split("=")[1] : "final").toLowerCase() === "preview" ? "preview" : "final";
const explicitFinalProfile = profileArg && String(profileArg.split("=")[1] || "").toLowerCase() === "final";

const projectRoot = resolveProjectRoot(process.argv.slice(2));
const remotionProjectRoot = path.resolve(__dirname, "..", "..");
const timelinePath = path.join(projectRoot, "output", "timeline.json");
const editorProjectPath = path.join(projectRoot, "editor-project.json");
const imagesDir = path.join(projectRoot, "imagenes");
const audioDir = path.join(projectRoot, "audio");
const publicGeneratedDir = path.join(projectRoot, "public", "generated");
const publicImagesDir = path.join(publicGeneratedDir, "images");
const publicDir = path.join(projectRoot, "public");
const projectFontsDir = path.join(publicDir, "fonts", "versa");
const repoVersaFontPath = path.join(remotionProjectRoot, "public", "fonts", "versa", "Demo-Display.woff2");
const projectVersaFontPath = path.join(projectFontsDir, "Demo-Display.woff2");
const outputVideoPath = path.join(projectRoot, "output", renderProfile === "preview" ? "video-preview.mp4" : "video-final.mp4");
const diagnosticsPath = path.join(projectRoot, "output", "diagnostics.json");
const persistedCompositionContractPath = path.join(projectRoot, "composition-contract.json");
const remotionHardwareAcceleration = process.env.REMOTION_HARDWARE_ACCELERATION || "if-possible";
const remotionGl = process.env.REMOTION_GL || "angle";

function readPersistedCompositionContract() {
  if (!fs.existsSync(persistedCompositionContractPath)) {
    return null;
  }
  const persisted = JSON.parse(fs.readFileSync(persistedCompositionContractPath, "utf8"));
  if (persisted?.contract && persisted?.manifest) {
    return persisted;
  }
  throw new Error(
    `composition-contract.json exists but is invalid. Expected { contract, manifest } at: ${persistedCompositionContractPath}`,
  );
}

function assertFinalCompositionContract() {
  const persisted = readPersistedCompositionContract();
  if (persisted) return persisted;
  if (explicitFinalProfile) {
    throw new Error(
      `Missing required composition-contract.json for --profile=final at: ${persistedCompositionContractPath}. Prepare the project through the Approval Editor final-render handoff before invoking Video Engine final render.`,
    );
  }
  return null;
}

function deriveRenderPropsWithMigrationFallback(editorProject) {
  const persisted = assertFinalCompositionContract();
  if (persisted) {
    return adaptCompositionContractToRenderProps({ contract: persisted.contract, manifest: persisted.manifest });
  }
  return deriveRenderPropsFromEditorProject(projectRoot, editorProject);
}

function updateEditorRenderStatus(patch) {
  if (!fs.existsSync(editorProjectPath)) {
    return null;
  }
  const current = readJsonSchema(editorProjectPath, editorProjectSchema);
  const next = editorProjectSchema.parse({
    ...current,
    renderStatus: { ...current.renderStatus, ...patch },
  });
  writeJsonSchema(editorProjectPath, editorProjectSchema, next);
  return next;
}

function writeRenderFailureDiagnostics(reason, details = {}) {
  const diagnostics = diagnosticsSchema.parse({
    generatedAt: new Date().toISOString(),
    errors: [reason],
    warnings: [],
    gates: { ok: false, missing: [], stale: [], blocking: ["render:error"] },
    retry: {
      command: details.command || null,
      exitCode: details.exitCode ?? null,
      stdout: details.stdout || "",
      stderr: details.stderr || "",
    },
  });
  writeJsonSchema(diagnosticsPath, diagnosticsSchema, diagnostics);
  updateEditorRenderStatus({ status: "error", diagnosticsPath });
  updateProjectConfig(projectRoot, { phase: "error", diagnostics });
  return diagnostics;
}

function finalizeRenderSuccess() {
  if (fs.existsSync(diagnosticsPath)) {
    fs.rmSync(diagnosticsPath, { force: true });
  }
  updateProjectConfig(projectRoot, { phase: renderProfile === "preview" ? "preview_ready" : "done" });
  updateEditorRenderStatus({ status: "done", outputPath: outputVideoPath, diagnosticsPath: null });
  console.log(`Video exportado en: ${outputVideoPath}`);
}

function ensureRenderFontAssets() {
  if (!fs.existsSync(repoVersaFontPath)) {
    throw new Error(`Missing Versa Versa font asset at: ${repoVersaFontPath}`);
  }
  fs.mkdirSync(projectFontsDir, { recursive: true });
  fs.copyFileSync(repoVersaFontPath, projectVersaFontPath);
}

function renderWithProps(renderPropsPath) {
  ensureRenderFontAssets();
  const remotionCliPath = path.join(
    remotionProjectRoot,
    "node_modules",
    "@remotion",
    "cli",
    "remotion-cli.js",
  );

  if (!fs.existsSync(remotionCliPath)) {
    throw new Error(
      `No se encontro la CLI de Remotion en: ${remotionCliPath}. Ejecuta npm install.`,
    );
  }

  const renderArgs = [
    remotionCliPath,
    "render",
    "MyComp",
    outputVideoPath,
    "--codec=h264",
    "--frames-per-second=30",
    renderProfile === "preview" ? "--width=1280" : "--width=1920",
    renderProfile === "preview" ? "--height=720" : "--height=1080",
    `--public-dir=${publicDir}`,
    `--props=${renderPropsPath}`,
    `--hardware-acceleration=${remotionHardwareAcceleration}`,
    `--gl=${remotionGl}`,
  ];

  if (process.env.REMOTION_EDITOR_MOCK_RENDER_SUCCESS === "1") {
    fs.writeFileSync(outputVideoPath, "mock mp4 render placeholder\n");
    finalizeRenderSuccess();
    return;
  }

  if (dryRun) {
    console.log(
      `Dry run OK. Comando listo: ${process.execPath} ${renderArgs.join(" ")}`,
    );
    process.exit(0);
  }

  if (process.env.REMOTION_EDITOR_FORCE_RENDER_FAILURE === "1") {
    const command = `${process.execPath} ${renderArgs.join(" ")}`;
    writeRenderFailureDiagnostics("Render fallo: REMOTION_EDITOR_FORCE_RENDER_FAILURE=1", {
      command,
      exitCode: 1,
      stderr: "forced render failure for diagnostics coverage",
    });
    process.exit(1);
  }

  const result = spawnSync(process.execPath, renderArgs, {
    cwd: remotionProjectRoot,
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    writeRenderFailureDiagnostics(`Render fallo antes de iniciar Remotion: ${result.error.message}`, {
      command: `${process.execPath} ${renderArgs.join(" ")}`,
      stderr: result.error.stack || result.error.message,
    });
    throw result.error;
  }

  if (result.status !== 0) {
    writeRenderFailureDiagnostics(`Render fallo con exit code ${result.status || 1}`, {
      command: `${process.execPath} ${renderArgs.join(" ")}`,
      exitCode: result.status || 1,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    process.exit(result.status || 1);
  }

  finalizeRenderSuccess();
}

const persistedCompositionContract = renderProfile === "final" ? assertFinalCompositionContract() : readPersistedCompositionContract();

if (persistedCompositionContract) {
  fs.mkdirSync(path.dirname(outputVideoPath), { recursive: true });
  const props = adaptCompositionContractToRenderProps({
    contract: persistedCompositionContract.contract,
    manifest: persistedCompositionContract.manifest,
  });
  const renderPropsPath = path.join(projectRoot, "output", "render-props.json");
  writeJsonSchema(renderPropsPath, renderPropsSchema, props);

  if (fs.existsSync(editorProjectPath)) {
    const editorProject = readJsonSchema(editorProjectPath, editorProjectSchema);
    writeJsonSchema(
      editorProjectPath,
      editorProjectSchema,
      editorProjectSchema.parse({
        ...editorProject,
        preview: { status: "ready", lastGeneratedAt: new Date().toISOString() },
        renderStatus: dryRun
          ? { status: "ready", outputPath: null, diagnosticsPath: null }
          : { status: "rendering", outputPath: null, diagnosticsPath: null },
      }),
    );
  }
  updateProjectConfig(projectRoot, {
    phase: dryRun ? "preview_ready" : "rendering",
  });
  renderWithProps(renderPropsPath);
  process.exit(0);
}

if (fs.existsSync(editorProjectPath)) {
  fs.mkdirSync(path.dirname(outputVideoPath), { recursive: true });
  const editorProject = readJsonSchema(editorProjectPath, editorProjectSchema);
  const props = deriveRenderPropsWithMigrationFallback(editorProject);
  const renderPropsPath = path.join(projectRoot, "output", "render-props.json");
  writeJsonSchema(renderPropsPath, renderPropsSchema, props);
  writeJsonSchema(
    editorProjectPath,
    editorProjectSchema,
    editorProjectSchema.parse({
      ...editorProject,
      preview: { status: "ready", lastGeneratedAt: new Date().toISOString() },
      renderStatus: dryRun
        ? { status: "ready", outputPath: null, diagnosticsPath: null }
        : { status: "rendering", outputPath: null, diagnosticsPath: null },
    }),
  );
  updateProjectConfig(projectRoot, {
    phase: dryRun ? "preview_ready" : "rendering",
  });
  renderWithProps(renderPropsPath);
  process.exit(0);
}

if (!fs.existsSync(timelinePath)) {
  throw new Error(
    "No existe output/timeline.json. Ejecuta generate:timeline primero.",
  );
}

const timeline = readJsonSchema(timelinePath, timelineSchema);
const placeholderPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";
const placeholderImageName = "placeholder.png";
const placeholderImagePath = path.join(publicImagesDir, placeholderImageName);

const selectedAudio = resolveRenderAudio(audioDir);
if (!selectedAudio) {
  throw new Error(
    "No se encontro audio para render. Esperado: audio/audio-48khz.wav (o fallback audio/audio-16khz.wav).",
  );
}

const canonicalTimeline = assertCanonicalTimeline(timeline, {
  contractPath: timelinePath,
  expectedDurationSeconds:
    selectedAudio.durationSeconds || Number(timeline.totalDurationSeconds || 0),
});

if (canonicalTimeline.frames.length === 0) {
  throw new Error("timeline.json no tiene frames para renderizar.");
}

fs.mkdirSync(publicImagesDir, { recursive: true });
fs.mkdirSync(path.dirname(outputVideoPath), { recursive: true });

if (!fs.existsSync(placeholderImagePath)) {
  fs.writeFileSync(placeholderImagePath, Buffer.from(placeholderPng, "base64"));
}

const normalizedFrames = canonicalTimeline.frames.map((segment) => {
  const visualSelection = resolveVisualSegment(segment.image, imagesDir);

  let imageRelativePath = `generated/images/${placeholderImageName}`;
  if (visualSelection.resolvedImage !== PIPELINE_PLACEHOLDER_TOKEN) {
    const destination = path.join(
      publicImagesDir,
      visualSelection.resolvedImage,
    );
    const sourceImage = path.join(imagesDir, visualSelection.resolvedImage);
    fs.copyFileSync(sourceImage, destination);
    imageRelativePath = `generated/images/${visualSelection.resolvedImage}`;
  }

  return {
    ...segment,
    image: imageRelativePath,
    requestedImage: visualSelection.requestedImage,
    imageStrategy: visualSelection.strategy,
  };
});

const destinationAudio = path.join(
  publicGeneratedDir,
  `audio${path.extname(selectedAudio.selectedFile)}`,
);
fs.mkdirSync(publicGeneratedDir, { recursive: true });
fs.copyFileSync(selectedAudio.absolutePath, destinationAudio);
const audioRelativePath = `generated/${path.basename(destinationAudio)}`;

const props = {
  audioSrc: audioRelativePath,
  segments: normalizedFrames,
};

const renderPropsPath = path.join(projectRoot, "output", "render-props.json");
writeJsonSchema(renderPropsPath, renderPropsSchema, props);

renderWithProps(renderPropsPath);
