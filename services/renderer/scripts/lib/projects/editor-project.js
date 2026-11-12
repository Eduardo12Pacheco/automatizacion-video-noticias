const fs = require("fs");
const path = require("path");
const { writeJsonSchema } = require("../contracts/json-contracts");
const {
  assertNoSelectedVideoAssets,
  diagnosticsSchema,
  editorProjectSchema,
  projectConfigSchema,
  renderPropsV2Schema,
} = require("../contracts/schemas");
const { adaptCompositionContractToRenderProps } = require("../contracts/composition-contract");
const { secondsToDurationFrames, secondsToFrame } = require("../timing/timeline-utils");

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|svg)$/i;
const AUDIO_EXT_RE = /\.(wav|mp3|m4a|aac)$/i;
const BUNDLED_OVERLAYS_DIR = path.resolve(__dirname, "..", "..", "..", "assets", "overlays");
const LOGO_ALPHA_OVERLAY = "logo-demo-alpha.webm";
const DUST_OVERLAY = "particle-1.mp4";
const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zz5QAAAAASUVORK5CYII=";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stableId(input) {
  return String(input)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function relativeFromProject(projectRoot, absolutePath) {
  return path.relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

function listFiles(dirPath, matcher) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath)
    .filter((file) => matcher.test(file))
    .sort((a, b) => a.localeCompare(b));
}

function readScriptPhrases(scriptPath) {
  const content = fs.readFileSync(scriptPath, "utf8").trim();
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n|\|/)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function readTimelineOrScript(projectRoot) {
  const timelinePath = path.join(projectRoot, "output", "timeline.json");
  if (fs.existsSync(timelinePath)) {
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    return (timeline.frames || []).map((frame, index) => ({
      id: `row-${frame.id || index + 1}`,
      index,
      phrase: frame.phrase,
      image: frame.image,
      startTime: Number(frame.startTime),
      endTime: Number(frame.endTime),
    }));
  }

  const scriptPath = path.join(projectRoot, "guion", "guion.txt");
  const phrases = readScriptPhrases(scriptPath);
  return phrases.map((phrase, index) => ({
    id: `row-${index + 1}`,
    index,
    phrase,
    image: null,
    startTime: index * 3,
    endTime: (index + 1) * 3,
  }));
}

function buildAssets(projectRoot, { seedMedia = false } = {}) {
  const imagesDir = path.join(projectRoot, "imagenes");
  const audioDir = path.join(projectRoot, "audio");
  const imageAssets = seedMedia ? listFiles(imagesDir, IMAGE_EXT_RE).map((file) => ({
    id: `image-${stableId(file)}`,
    type: "image",
    source: { kind: "local" },
    localPath: `imagenes/${file}`,
    publicPath: `generated/images/${file}`,
    status: "ready",
  })) : [];

  const audioFiles = seedMedia ? listFiles(audioDir, AUDIO_EXT_RE) : [];
  const voiceFile =
    audioFiles.find((file) => file === "audio-48khz.wav") ||
    audioFiles.find((file) => file === "audio-16khz.wav") ||
    audioFiles.find((file) => /voice|voz|audio|source/i.test(file));
  const musicFile =
    audioFiles.find((file) => /music|musica|background|bgm|ambient/i.test(file)) ||
    audioFiles.find((file) => file !== voiceFile);

  const audioAssets = [];
  if (voiceFile) {
    audioAssets.push({
      id: `voice-${stableId(voiceFile)}`,
      type: "audio",
      source: { kind: "local" },
      localPath: `audio/${voiceFile}`,
      publicPath: `generated/${voiceFile}`,
      status: "ready",
    });
  }
  if (musicFile) {
    audioAssets.push({
      id: `music-${stableId(musicFile)}`,
      type: "music",
      source: { kind: "local" },
      localPath: `audio/${musicFile}`,
      publicPath: `generated/${musicFile}`,
      status: "ready",
    });
  }

  return [
    ...imageAssets,
    ...audioAssets,
    {
      id: "logo-placeholder",
      type: "logo",
      source: { kind: "generated" },
      localPath: "public/generated/logo-placeholder.png",
      publicPath: "generated/logo-placeholder.png",
      status: "placeholder",
    },
    {
      id: "outro-placeholder",
      type: "outro",
      source: { kind: "generated" },
      localPath: "public/generated/outro-placeholder.png",
      publicPath: "generated/outro-placeholder.png",
      status: "placeholder",
    },
  ];
}

function ensurePlaceholderAssets(projectRoot) {
  const generatedDir = path.join(projectRoot, "public", "generated");
  ensureDir(generatedDir);
  for (const file of ["logo-placeholder.png", "outro-placeholder.png"]) {
    const destination = path.join(generatedDir, file);
    if (!fs.existsSync(destination)) {
      fs.writeFileSync(destination, Buffer.from(PLACEHOLDER_PNG_BASE64, "base64"));
    }
  }
}

function buildRows(projectRoot, assets, { seedMedia = false } = {}) {
  const imageAssets = assets.filter((asset) => asset.type === "image");
  return readTimelineOrScript(projectRoot).map((item, index) => {
    const requestedFile = item.image ? path.basename(String(item.image)) : null;
    const selected = seedMedia ?
      imageAssets.find((asset) => requestedFile && path.basename(asset.localPath) === requestedFile) ||
      imageAssets[index] ||
      null : null;
    const candidates = seedMedia ? imageAssets.map((asset) => ({
      id: `candidate-${item.id}-${asset.id}`,
      assetId: asset.id,
      label: path.basename(asset.localPath),
      source: { kind: "local" },
      localPath: asset.localPath,
      publicPath: asset.publicPath,
      provider: "local",
      reason: asset.id === selected?.id ? "selected local candidate" : "local candidate",
    })) : [];

    return {
      id: item.id,
      index,
      phrase: item.phrase,
      startTime: item.startTime,
      endTime: item.endTime,
      selectedAssetId: selected?.id || null,
      candidates,
      motion: "slow-zoom-in",
      dust: { enabled: false },
      filter: { enabled: true, mode: "cover" },
      transition: "none",
      sfx: null,
      caption: item.phrase,
      lockedPhrase: true,
      warnings: selected ? [] : ["missing selected image"],
      status: selected ? "ready" : "missing_asset",
    };
  });
}

function createEditorProject(projectRoot, { projectId, title, seedMedia = false } = {}) {
  ensurePlaceholderAssets(projectRoot);
  const assets = buildAssets(projectRoot, { seedMedia });
  const rows = buildRows(projectRoot, assets, { seedMedia });
  const editorProject = editorProjectSchema.parse({
    schemaVersion: 1,
    projectId: projectId || path.basename(projectRoot),
    title: title || projectId || path.basename(projectRoot),
    fps: 30,
    canvas: { width: 1280, height: 720 },
    assets,
      globalLayers: {
        logoAssetId: "logo-placeholder",
        outroAssetId: "outro-placeholder",
        logo: { enabled: false, position: "top-left" },
        dustDefault: false,
        filterDefault: true,
      },
    audio: {
      music: { volume: 0.15, muted: false },
      voice: { volume: 1, muted: false },
    },
    rows,
    selectedRowId: rows[0]?.id || null,
    preview: { status: "blocked", lastGeneratedAt: null },
    renderStatus: { status: "idle", outputPath: null, diagnosticsPath: null },
  });

  return editorProject;
}

function resolveAssetPath(projectRoot, asset) {
  return asset?.localPath ? path.join(projectRoot, asset.localPath) : null;
}

function validateEditorProject(projectRoot, editorProject) {
  const parsed = assertNoSelectedVideoAssets(editorProject, path.join(projectRoot, "editor-project.json"));
  const prepared = markEditorProjectDiagnostics(projectRoot, parsed);
  return prepared.diagnostics;
}

function markEditorProjectDiagnostics(projectRoot, editorProject) {
  const parsed = editorProjectSchema.parse(editorProject);
  const assetsById = new Map(parsed.assets.map((asset) => [asset.id, asset]));
  const staleAssetIds = new Set();
  const missing = [];
  const stale = [];
  const blocking = [];

  const voice = parsed.assets.find((asset) => asset.type === "audio" && asset.status !== "missing");
  const music = parsed.assets.find((asset) => asset.type === "music" && asset.status !== "missing");
  if (!voice) missing.push("voice");
  if (!music) missing.push("music");

  for (const asset of parsed.assets) {
    const assetPath = resolveAssetPath(projectRoot, asset);
    if (asset.localPath && !fs.existsSync(assetPath)) {
      stale.push(asset.id);
      staleAssetIds.add(asset.id);
    }
  }

  const rowsWithMissingSelection = new Set();
  const rowsWithStaleSelection = new Set();
  const rowsWithInvalidSelection = new Set();

  for (const row of parsed.rows) {
    const selected = row.selectedAssetId ? assetsById.get(row.selectedAssetId) : null;
    if (!selected) {
      missing.push(`row:${row.id}:image`);
      rowsWithMissingSelection.add(row.id);
      continue;
    }
    if (selected.type === "video") {
      blocking.push(`row:${row.id}:video-not-supported`);
      rowsWithInvalidSelection.add(row.id);
    }
    if (selected.type !== "image") {
      blocking.push(`row:${row.id}:selected-asset-not-image`);
      rowsWithInvalidSelection.add(row.id);
    }
    const selectedPath = resolveAssetPath(projectRoot, selected);
    if (selected.localPath && !fs.existsSync(selectedPath)) {
      stale.push(`row:${row.id}:${selected.id}`);
      staleAssetIds.add(selected.id);
      rowsWithStaleSelection.add(row.id);
    }
  }

  blocking.push(...missing, ...stale.map((entry) => `stale:${entry}`));
  const gates = { ok: blocking.length === 0, missing, stale, blocking };
  const diagnostics = diagnosticsSchema.parse({
    generatedAt: nowIso(),
    errors: gates.ok ? [] : blocking,
    warnings: [],
    gates,
  });

  const nextAssets = parsed.assets.map((asset) => {
    if (staleAssetIds.has(asset.id)) {
      return { ...asset, status: "stale" };
    }
    if (asset.status === "stale" && asset.localPath && fs.existsSync(resolveAssetPath(projectRoot, asset))) {
      return { ...asset, status: "ready" };
    }
    return asset;
  });

  const nextRows = parsed.rows.map((row) => {
    let status = row.status;
    const warnings = new Set(row.warnings || []);
    warnings.delete("missing selected image");
    warnings.delete("stale selected asset");
    warnings.delete("invalid selected asset");

    if (rowsWithMissingSelection.has(row.id)) {
      status = "missing_asset";
      warnings.add("missing selected image");
    } else if (rowsWithStaleSelection.has(row.id)) {
      status = "stale_asset";
      warnings.add("stale selected asset");
    } else if (rowsWithInvalidSelection.has(row.id)) {
      status = "invalid";
      warnings.add("invalid selected asset");
    } else {
      status = "ready";
    }

    return { ...row, status, warnings: Array.from(warnings) };
  });

  return {
    project: editorProjectSchema.parse({ ...parsed, assets: nextAssets, rows: nextRows }),
    diagnostics,
  };
}

function copyAssetForRender(projectRoot, asset, publicGeneratedDir) {
  if (!asset?.localPath || !asset?.publicPath) {
    return null;
  }
  const source = path.join(projectRoot, asset.localPath);
  const destination = path.join(publicGeneratedDir, asset.publicPath.replace(/^generated\//, ""));
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return asset.publicPath;
}

function copyBundledOverlayForRender(fileName, publicGeneratedDir) {
  const source = path.join(BUNDLED_OVERLAYS_DIR, fileName);
  if (!fs.existsSync(source)) {
    return null;
  }

  const publicPath = `generated/overlays/${fileName}`;
  const destination = path.join(publicGeneratedDir, "overlays", fileName);
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  return publicPath;
}

function deriveRenderPropsFromEditorProject(projectRoot, editorProject) {
  const parsed = assertNoSelectedVideoAssets(editorProject, path.join(projectRoot, "editor-project.json"));
  const { project: prepared, diagnostics } = markEditorProjectDiagnostics(projectRoot, parsed);
  if (!diagnostics.gates.ok) {
    throw new Error(`Editor project no esta listo para render: ${diagnostics.gates.blocking.join("; ")}`);
  }

  const publicGeneratedDir = path.join(projectRoot, "public", "generated");
  ensureDir(publicGeneratedDir);
  const assetsById = new Map(prepared.assets.map((asset) => [asset.id, asset]));
  const voice = prepared.assets.find((asset) => asset.type === "audio");
  const music = prepared.assets.find((asset) => asset.type === "music");
  const logo = assetsById.get(prepared.globalLayers.logoAssetId);

  const voiceSrc = copyAssetForRender(projectRoot, voice, publicGeneratedDir);
  const musicSrc = copyAssetForRender(projectRoot, music, publicGeneratedDir);
  const logoOverlaySrc = copyBundledOverlayForRender(LOGO_ALPHA_OVERLAY, publicGeneratedDir);
  const dustOverlaySrc = copyBundledOverlayForRender(DUST_OVERLAY, publicGeneratedDir);
  const renderRows = prepared.rows.map((row, index) => {
    const next = prepared.rows[index + 1];
    const nextStart = Number(next?.startTime);
    const currentStart = Number(row.startTime);
    const endTime = Number.isFinite(nextStart) && nextStart > currentStart ? nextStart : row.endTime;
    return { ...row, endTime };
  });

  const segments = renderRows.map((row) => {
    const selected = assetsById.get(row.selectedAssetId);
    const image = copyAssetForRender(projectRoot, selected, publicGeneratedDir);
    return {
      rowId: row.id,
      id: row.index + 1,
      phrase: row.phrase,
      image,
      startTime: row.startTime,
      endTime: row.endTime,
      requestedImage: selected?.localPath || null,
      imageStrategy: selected?.source?.kind || "local",
      motion: row.motion || "slow-zoom-in",
      dust: row.dust,
      logo: row.logo,
      filter: row.filter,
      transition: row.transition || "none",
      sfx: row.sfx,
      caption: row.caption,
      startFrame: secondsToFrame(row.startTime, parsed.fps),
      durationInFrames: secondsToDurationFrames(row.startTime, row.endTime, parsed.fps),
    };
  });

  const contract = {
    fps: prepared.fps,
    renderProfile: { fps: prepared.fps },
    audio: {
      voiceAssetId: voice?.id || null,
      musicAssetId: music?.id || null,
      voice: prepared.audio?.voice || { volume: 1, muted: false },
      music: {
        ...prepared.audio?.music,
        loop: true,
        fadeInSeconds: 0.5,
        fadeOutSeconds: 1,
      },
    },
    segments: segments.map((segment) => ({
      rowId: segment.rowId,
      phrase: segment.phrase,
      startTime: segment.startTime,
      endTime: segment.endTime,
      effectiveEndTime: segment.endTime,
      selectedAssetId: renderRows.find((row) => row.id === segment.rowId)?.selectedAssetId,
      motion: segment.motion,
      mediaMode: renderRows.find((row) => row.id === segment.rowId)?.mediaMode,
      media: renderRows.find((row) => row.id === segment.rowId)?.media,
      dust: segment.dust,
      logo: segment.logo,
      filter: segment.filter,
      transition: segment.transition,
      sfx: segment.sfx,
      caption: segment.caption,
    })),
    globalLayers: prepared.globalLayers,
    outro: { enabled: true, durationSeconds: 2, label: "Gracias por mirar" },
  };

  const manifest = {
    version: 1,
    assets: Object.fromEntries(
      prepared.assets.map((asset) => {
        const copiedPath = copyAssetForRender(projectRoot, asset, publicGeneratedDir);
        return [asset.id, { status: asset.status || "ready", renderPath: copiedPath, localPath: asset.localPath || null }];
      }),
    ),
  };

  if (logoOverlaySrc && prepared.globalLayers?.logoAssetId) {
    const logoId = prepared.globalLayers.logoAssetId;
    manifest.assets[logoId] = {
      ...(manifest.assets[logoId] || {}),
      status: "ready",
      renderPath: logoOverlaySrc,
    };
  }

  const props = adaptCompositionContractToRenderProps({
    contract,
    manifest,
    options: {
      // Editor projects carry the canvas dimensions, so manual image motion can
      // derive its render geometry even when a legacy row omits it explicitly.
      defaultRenderGeometry: {
        imageWidth: prepared.canvas?.width,
        imageHeight: prepared.canvas?.height,
        panViewportWidth: prepared.canvas?.width,
        panViewportHeight: prepared.canvas?.height,
      },
    },
  });
  props.overlays = {
    dust: {
      src: dustOverlaySrc,
      opacity: 0.36,
      blendMode: "screen",
    },
  };
  props.logo = {
    ...(props.logo || {}),
    src: logoOverlaySrc || logo?.publicPath || null,
    placeholder: !logoOverlaySrc && logo?.status === "placeholder",
    enabled: segments.some((segment) => segment.logo?.enabled !== false),
    label: "LOGO",
  };
  return renderPropsV2Schema.parse(props);
}

function updateProjectConfig(projectRoot, patch) {
  const projectPath = path.join(projectRoot, "project.json");
  if (!fs.existsSync(projectPath)) {
    return null;
  }
  const current = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  const next = projectConfigSchema.parse({ ...current, ...patch, updatedAt: nowIso() });
  writeJsonSchema(projectPath, projectConfigSchema, next);
  return next;
}

module.exports = {
  createEditorProject,
  buildAssets,
  buildRows,
  deriveRenderPropsFromEditorProject,
  ensureDir,
  ensurePlaceholderAssets,
  nowIso,
  relativeFromProject,
  stableId,
  updateProjectConfig,
  markEditorProjectDiagnostics,
  validateEditorProject,
};
