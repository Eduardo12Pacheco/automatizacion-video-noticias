const { z } = require("zod");

const numericSecondsSchema = z.number().finite().nonnegative();

const imageMotionObjectSchema = z.object({
  fromScale: z.number().finite().positive(),
  toScale: z.number().finite().positive(),
  fromX: z.number().finite(),
  fromY: z.number().finite(),
  toX: z.number().finite(),
  toY: z.number().finite(),
  easing: z.string().min(1).optional(),
});

const imageMotionSchema = z.union([z.string(), imageMotionObjectSchema]);

const whipTransitionConfigSchema = z.object({
  type: z.literal("whip").default("whip"),
  durationSeconds: numericSecondsSchema.default(0.5),
  direction: z.literal("left-to-right").default("left-to-right"),
});

const whipRenderEventSchema = z.object({
  id: z.string().min(1),
  rowId: z.string().min(1),
  nextRowId: z.string().min(1),
  cutTime: numericSecondsSchema,
  startTime: numericSecondsSchema,
  durationSeconds: numericSecondsSchema,
  startFrame: z.number().int().nonnegative(),
  cutFrame: z.number().int().nonnegative(),
  sfxStartTime: numericSecondsSchema,
  sfxStartFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  previousImage: z.string().min(1),
  nextImage: z.string().min(1),
  direction: z.literal("left-to-right"),
  sfx: z.literal("whip").nullable().default(null),
  sfxSrc: z.string().min(1).nullable().default(null),
});

const videoSegmentMediaSchema = z.object({
  kind: z.literal("video-segment"),
  sourceVideoAssetId: z.string().min(1).optional(),
  sourceVideoSrc: z.string().min(1).optional(),
  sourceInSeconds: numericSecondsSchema,
  durationSeconds: numericSecondsSchema,
  sourceOutSeconds: numericSecondsSchema.optional(),
  overlayColor: z.literal("#3835AF").default("#3835AF"),
  overlayOpacity: z.literal(0.3).default(0.3),
  effect1AssetId: z.literal("overlay-layer-01").optional(),
  effect1Src: z.string().min(1).optional(),
  effect1BlendMode: z.literal("screen").default("screen"),
  effect2AssetId: z.literal("overlay-layer-02").optional(),
  effect2Src: z.string().min(1).optional(),
  effect2BlendMode: z.literal("multiply").default("multiply"),
});

const rowMediaSchema = z.union([
  z.object({ kind: z.literal("image") }).passthrough(),
  videoSegmentMediaSchema,
]);

const scriptPhraseSchema = z.object({
  id: z.number().int().positive(),
  blockIndex: z.number().int().nonnegative().optional(),
  phrase: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  image: z.string().min(1),
  imageSelection: z.lazy(() => imageSelectionSchema).optional(),
});

const scriptPhrasesSchema = z.object({
  phrases: z.array(scriptPhraseSchema),
});

const transcriptWordSchema = z.object({
  word: z.string().min(1),
  start: numericSecondsSchema,
  end: numericSecondsSchema,
});

const transcriptSegmentSchema = z.object({
  id: z.number().int().optional(),
  text: z.string(),
  start: numericSecondsSchema,
  end: numericSecondsSchema,
});

const transcriptSchema = z.object({
  backend: z.string().optional(),
  totalDurationSeconds: numericSecondsSchema,
  words: z.array(transcriptWordSchema).default([]),
  segments: z.array(transcriptSegmentSchema).default([]),
});

const severitySchema = z.enum(["ok", "warn", "error"]);

const alignmentSchema = z.object({
  source: z.string().min(1),
  confidence: z.number().finite().min(0).max(1).optional(),
  matchedWords: z.number().int().nonnegative().optional(),
  totalWords: z.number().int().nonnegative().optional(),
  maxDriftMs: z.number().finite().nonnegative().optional(),
  severity: severitySchema.optional(),
  warnings: z.array(z.string()).optional(),
});

const imageSelectionSchema = z.object({
  strategy: z.string().min(1),
  score: z.number().finite().optional(),
  matchedKeywords: z.array(z.string()).optional(),
  reason: z.string().optional(),
  severity: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

const phraseTimestampSchema = scriptPhraseSchema.extend({
  startTime: numericSecondsSchema,
  endTime: numericSecondsSchema,
  alignment: alignmentSchema.optional(),
  imageSelection: imageSelectionSchema.optional(),
});

const phraseTimestampsSchema = z.object({
  totalDurationSeconds: numericSecondsSchema,
  diagnostics: z.unknown().optional(),
  phrases: z.array(phraseTimestampSchema),
}).passthrough();

const timelineDiagnosticsSchema = z.object({
  durationSeconds: numericSecondsSchema.optional(),
  segmentCount: z.number().int().nonnegative().optional(),
  warnings: z.array(z.string()).default([]).optional(),
  failures: z.array(z.string()).default([]).optional(),
}).passthrough();

const timelineFrameSchema = z.object({
  id: z.number().int().positive().optional(),
  phrase: z.string().min(1),
  image: z.string().min(1),
  startTime: numericSecondsSchema,
  endTime: numericSecondsSchema,
  alignment: alignmentSchema.optional(),
  imageSelection: imageSelectionSchema.optional(),
});

const timelineSchema = z.object({
  totalDurationSeconds: numericSecondsSchema,
  frames: z.array(timelineFrameSchema),
  diagnostics: timelineDiagnosticsSchema.optional(),
});

const imageMetadataSchema = z.object({
  images: z.array(
    z.object({
      file: z.string().min(1),
      aliases: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      weight: z.number().finite().positive().optional(),
    }),
  ),
});

const renderSegmentSchema = timelineFrameSchema.extend({
  requestedImage: z.string().nullable().optional(),
  imageWidth: z.number().finite().positive().optional(),
  imageHeight: z.number().finite().positive().optional(),
  imageStrategy: z.string().optional(),
  rowId: z.string().optional(),
  paragraphBoundaryAfter: z.boolean().optional(),
  nextRowId: z.string().nullable().optional(),
  motion: imageMotionSchema.optional(),
  dust: z.object({ enabled: z.boolean().default(true), type: z.string().optional(), assetId: z.string().nullable().optional(), opacity: z.number().finite().optional(), blendMode: z.string().optional() }).optional(),
  logo: z.object({ enabled: z.boolean().default(true), source: z.string().optional(), assetId: z.string().nullable().optional() }).optional(),
  filter: z.object({ enabled: z.boolean().default(true) }).optional(),
  transition: z.string().optional(),
  transitionConfig: whipTransitionConfigSchema.optional(),
  sfx: z.string().nullable().optional(),
  caption: z.string().optional(),
  mediaMode: z.enum(["image", "newspaper"]).default("image").optional(),
  media: rowMediaSchema.optional(),
});

const legacyRenderPropsSchema = z.object({
  audioSrc: z.string().min(1),
  segments: z.array(renderSegmentSchema),
});

const projectPhaseSchema = z.enum([
  "created",
  "script_processed",
  "images_ready",
  "audio_ready",
  "preview_ready",
  "editing",
  "pending_alignment",
  "rendering",
  "done",
  "error",
]);

const assetSourceSchema = z.object({
  kind: z.enum(["local", "api-candidate", "generated"]),
});

const assetSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["image", "audio", "music", "logo", "outro", "video"]),
    source: assetSourceSchema.passthrough(),
    localPath: z.string().min(1).optional(),
    publicPath: z.string().min(1).optional(),
    candidateId: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    durationSeconds: numericSecondsSchema.optional(),
    status: z.enum(["ready", "missing", "stale", "placeholder"]).default("ready"),
  })
  .passthrough();

const rowCandidateSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(1).optional(),
    label: z.string().optional(),
    source: assetSourceSchema.passthrough(),
    localPath: z.string().min(1).optional(),
    publicPath: z.string().min(1).optional(),
    score: z.number().finite().optional(),
    provider: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const editorRowSchema = z
  .object({
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    phrase: z.string().min(1),
    startTime: numericSecondsSchema,
    endTime: numericSecondsSchema,
    selectedAssetId: z.string().min(1).nullable(),
    candidates: z.array(rowCandidateSchema).default([]),
    motion: imageMotionSchema.default("slow-zoom-in"),
    mediaMode: z.enum(["image", "newspaper"]).default("image").optional(),
    dust: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
    logo: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    filter: z.object({ enabled: z.boolean().default(true), mode: z.string().default("cover") }).default({ enabled: true, mode: "cover" }),
    transition: z.string().default("none"),
    sfx: z.string().nullable().default(null),
    caption: z.string().default(""),
    lockedPhrase: z.boolean().default(true),
    warnings: z.array(z.string()).default([]),
    status: z.enum(["ready", "missing_asset", "stale_asset", "invalid"]).default("missing_asset"),
    media: rowMediaSchema.optional(),
  })
  .refine((row) => row.endTime > row.startTime, {
    message: "endTime debe ser mayor a startTime",
    path: ["endTime"],
  });

const gateStateSchema = z.object({
  ok: z.boolean(),
  missing: z.array(z.string()).default([]),
  stale: z.array(z.string()).default([]),
  blocking: z.array(z.string()).default([]),
});

const diagnosticsSchema = z
  .object({
    generatedAt: z.string().optional(),
    errors: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    gates: gateStateSchema.optional(),
  })
  .passthrough();

const projectsIndexSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      status: projectPhaseSchema,
      projectPath: z.string().min(1),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      lastRender: z.string().nullable().optional(),
    }),
  ),
});

const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

const assetUploadRequestSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  contentBase64: z.string().min(1),
  type: z.enum(["image", "logo", "outro", "audio", "music", "video"]),
});

const imageSearchRequestSchema = z.object({
  rowId: z.string().min(1),
  query: z.string().min(1),
});

const imageImportRequestSchema = z.object({
  rowId: z.string().min(1),
  candidateId: z.string().min(1),
});

const commandStatusSchema = z.object({
  id: z.string().min(1).optional(),
  action: z.enum(["prepare", "validate", "render-dry-run", "render"]),
  status: z.enum(["queued", "running", "success", "error"]),
  exitCode: z.number().int().nullable().optional(),
  stdout: z.string().default("").optional(),
  stderr: z.string().default("").optional(),
});

const outputMetadataSchema = z.object({
  renderStatus: z.unknown().nullable().optional(),
  outputPath: z.string().nullable().optional(),
  exists: z.boolean().default(false),
});

const projectConfigSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    schemaVersion: z.literal(1).default(1),
    phase: projectPhaseSchema.default("created"),
    paths: z.object({
      projectRoot: z.string().min(1),
      script: z.string().min(1),
      editorProject: z.string().min(1),
      output: z.string().min(1),
    }),
    gates: gateStateSchema.optional(),
    diagnostics: diagnosticsSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

const editorProjectBaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projectId: z.string().min(1),
  title: z.string().min(1).optional(),
  phase: projectPhaseSchema.optional(),
  fps: z.number().int().positive().default(30),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  assets: z.array(assetSchema).default([]),
  globalLayers: z
    .object({
      logoAssetId: z.string().nullable().default(null),
      outroAssetId: z.string().nullable().default(null),
      logo: z.object({ enabled: z.boolean().default(false), position: z.string().default("top-left") }).default({ enabled: false, position: "top-left" }),
      dustDefault: z.boolean().default(true),
      filterDefault: z.boolean().default(true),
    })
    .default({ logoAssetId: null, outroAssetId: null, logo: { enabled: false, position: "top-left" }, dustDefault: false, filterDefault: true }),
  audio: z
    .object({
      music: z.object({ volume: z.number().finite().min(0).max(1).default(0.15), muted: z.boolean().default(false) }).default({ volume: 0.15, muted: false }),
      voice: z.object({ volume: z.number().finite().min(0).max(1).default(1), muted: z.boolean().default(false) }).default({ volume: 1, muted: false }),
    })
    .default({ music: { volume: 0.15, muted: false }, voice: { volume: 1, muted: false } }),
  rows: z.array(editorRowSchema),
  selectedRowId: z.string().nullable().default(null),
  preview: z
    .object({ status: z.enum(["blocked", "ready", "rendering", "error"]).default("blocked"), lastGeneratedAt: z.string().nullable().default(null) })
    .default({ status: "blocked", lastGeneratedAt: null }),
  renderStatus: z
    .object({ status: z.enum(["idle", "ready", "rendering", "done", "error"]).default("idle"), outputPath: z.string().nullable().default(null), diagnosticsPath: z.string().nullable().default(null) })
    .default({ status: "idle", outputPath: null, diagnosticsPath: null }),
  alignmentStatus: z
    .object({
      status: z.enum(["pending", "ready", "failed"]).default("pending"),
      source: z.string().optional(),
      warning: z.string().optional(),
      details: z.string().optional(),
      generatedAt: z.string().nullable().default(null),
    })
    .default({ status: "pending", generatedAt: null }),
});

const editorProjectSchema = editorProjectBaseSchema.superRefine((project, ctx) => {
  const seenAssetIds = new Set();
  for (const [index, asset] of project.assets.entries()) {
    if (seenAssetIds.has(asset.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `asset id duplicado: ${asset.id}`,
        path: ["assets", index, "id"],
      });
    }
    seenAssetIds.add(asset.id);
  }

  for (const layerKey of ["logoAssetId", "outroAssetId"]) {
    const assetId = project.globalLayers[layerKey];
    if (assetId && !seenAssetIds.has(assetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${layerKey} referencia un asset inexistente: ${assetId}`,
        path: ["globalLayers", layerKey],
      });
    }
  }

  const seenRowIds = new Set();
  for (const [index, row] of project.rows.entries()) {
    if (seenRowIds.has(row.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `row id duplicado: ${row.id}`,
        path: ["rows", index, "id"],
      });
    }
    seenRowIds.add(row.id);

    if (row.selectedAssetId && !seenAssetIds.has(row.selectedAssetId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `selectedAssetId referencia un asset inexistente: ${row.selectedAssetId}`,
        path: ["rows", index, "selectedAssetId"],
      });
    }
  }

  if (project.selectedRowId && !seenRowIds.has(project.selectedRowId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `selectedRowId referencia una fila inexistente: ${project.selectedRowId}`,
      path: ["selectedRowId"],
    });
  }
});

const renderPropsV2Schema = z.object({
  schemaVersion: z.literal(2).default(2),
  lastRenderedSnapshotHash: z.string().optional(),
  fps: z.number().int().positive().default(30),
  compositionDurationSeconds: numericSecondsSchema.optional(),
  audio: z.object({
    voiceSrc: z.string().min(1),
    musicSrc: z.string().min(1),
    voice: z.object({
      volume: z.number().finite().min(0).max(1).default(1),
    }).default({ volume: 1 }),
    music: z.object({
      volume: z.number().finite().min(0).max(1).default(0.16),
      loop: z.boolean().default(true),
      fadeInSeconds: numericSecondsSchema.default(0.5),
      fadeOutSeconds: numericSecondsSchema.default(1),
    }),
  }),
  segments: z.array(renderSegmentSchema),
  whipTransitions: z.array(whipRenderEventSchema).default([]),
  globalLayers: z.record(z.string(), z.unknown()).default({}),
  logo: z.object({ src: z.string().nullable(), enabled: z.boolean().default(true), placeholder: z.boolean().default(true), label: z.string().default("LOGO") }).optional(),
  overlays: z
    .object({
      dust: z.object({ src: z.string().nullable(), opacity: z.number().finite().min(0).max(1).default(0.36), blendMode: z.string().default("screen") }).optional(),
    })
    .default({}),
  outro: z.object({ enabled: z.boolean().default(true), src: z.string().min(1).optional(), durationSeconds: numericSecondsSchema.default(2), label: z.string().default("Gracias por mirar") }).optional(),
});

const renderPropsSchema = z.union([renderPropsV2Schema, legacyRenderPropsSchema]);

function assertNoSelectedVideoAssets(editorProject, contractPath = "editor-project.json") {
  const parsed = editorProjectSchema.parse(editorProject);
  const assetsById = new Map(parsed.assets.map((asset) => [asset.id, asset]));
  const videoRows = parsed.rows.filter((row) => {
    const selected = row.selectedAssetId ? assetsById.get(row.selectedAssetId) : null;
    return selected?.type === "video";
  });

  if (videoRows.length > 0) {
    throw new Error(
      `Contrato MVP invalido en ${contractPath}: asset.type='video' esta reservado para futuro y no puede renderizar filas seleccionadas (${videoRows.map((row) => row.id).join(", ")}).`,
    );
  }

  return parsed;
}

module.exports = {
  alignmentSchema,
  apiErrorSchema,
  assetUploadRequestSchema,
  imageMetadataSchema,
  imageImportRequestSchema,
  imageMotionObjectSchema,
  imageMotionSchema,
  imageSelectionSchema,
  imageSearchRequestSchema,
  phraseTimestampSchema,
  phraseTimestampsSchema,
  assetSchema,
  assertNoSelectedVideoAssets,
  diagnosticsSchema,
  editorProjectSchema,
  editorRowSchema,
  gateStateSchema,
  legacyRenderPropsSchema,
  projectConfigSchema,
  projectsIndexSchema,
  commandStatusSchema,
  outputMetadataSchema,
  renderPropsV2Schema,
  renderPropsSchema,
  rowMediaSchema,
  whipRenderEventSchema,
  whipTransitionConfigSchema,
  scriptPhraseSchema,
  scriptPhrasesSchema,
  timelineDiagnosticsSchema,
  timelineFrameSchema,
  timelineSchema,
  transcriptSchema,
};
