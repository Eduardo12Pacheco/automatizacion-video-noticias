export const CHECK_MANIFEST = [
  {
    path: 'js/modules/features/video-projects/__checks__/renderer-motion-parity-check.mjs',
    owner: 'video-projects',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/audio/__checks__/audio-seams.check.mjs',
    owner: 'audio',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/__checks__/global/runtime-ui-parity-replay.js',
    owner: 'global',
    commandKind: 'module-import',
    exportedHelpers: ['runProtectedFlowsReplay', 'runAudioParityReplay', 'runAppShellLifecycleReplay', 'runAppShellSetViewReplay', 'runScriptToAudioVoiceReplay'],
  },
  {
    path: 'js/modules/app-shell/__checks__/app-shell-seams.check.mjs',
    owner: 'app-shell',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/subtitles/__checks__/subtitles-controller-seams.check.mjs',
    owner: 'subtitles',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-segment-picker-ux.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/composition-renderer-helpers.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-projects-controller-seams.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-projects-render-seams.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/editor-assets-tab-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runEditorAssetsTabCheck'],
  },
  {
    path: 'js/modules/__checks__/global/parity-checklist.js',
    owner: 'global',
    commandKind: 'module-import',
    exportedHelpers: ['REQUIRED_SELECTOR_IDS', 'SUBTITLE_REMOTE_CUTOVER_GATES', 'runParityChecklist'],
  },
  {
    path: 'js/modules/__checks__/global/dependency-boundary-validator.js',
    owner: 'global',
    commandKind: 'module-import',
    exportedHelpers: ['LEGACY_ARCHIVE_PATH', 'validateDependencyBoundaries', 'validateNoLegacyArchiveRuntimeReferences', 'validateNoSiblingFeatureImports'],
  },
  {
    path: 'js/modules/__checks__/global/css-computed-style-parity.js',
    owner: 'global',
    commandKind: 'module-import',
    exportedHelpers: ['runComputedStyleParityCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/approval-motion-draft-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runApprovalMotionDraftCheck'],
  },
  {
    path: 'js/modules/features/radar/__checks__/radar-panel-check.js',
    owner: 'radar',
    commandKind: 'node-cli',
    exportedHelpers: ['runRadarPanelCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/composition-cover-pan-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runCompositionCoverPanCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-segment-stability-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runVideoSegmentStabilityCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/editor-motion-presets-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runEditorMotionPresetsCheck'],
  },
  {
    path: 'js/modules/__checks__/approval-editor-service-timings.check.cjs',
    owner: 'global',
    commandKind: 'commonjs-test',
    exportedHelpers: [],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/contract-pipeline-client-check.js',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runContractPipelineClientCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/composition-renderer-preload-window.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runCompositionRendererPreloadWindowCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-projects-composition-payload.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runVideoProjectsCompositionPayloadCheck'],
  },
  {
    path: 'js/modules/features/video-projects/__checks__/video-projects-manifest-resolution.check.mjs',
    owner: 'video-projects',
    commandKind: 'node-cli',
    exportedHelpers: ['runVideoProjectsManifestResolutionCheck'],
  },
  {
    path: 'js/modules/__checks__/global/rollback-scope-validator.js',
    owner: 'global',
    commandKind: 'module-import',
    exportedHelpers: ['evaluateRollbackPlan', 'simulateS4ArchivalRollback'],
  },
];

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function validateCheckManifestCoverage(entries = CHECK_MANIFEST) {
  const failures = [];
  const paths = entries.map((entry) => entry.path);
  const duplicatePaths = findDuplicates(paths);

  if (duplicatePaths.length) failures.push(`duplicate check paths: ${duplicatePaths.join(', ')}`);

  for (const entry of entries) {
    if (!entry.path?.startsWith('js/modules/')) failures.push(`invalid check path: ${entry.path}`);
    if (!entry.owner) failures.push(`missing owner for ${entry.path}`);
    if (!entry.commandKind) failures.push(`missing command kind for ${entry.path}`);
    if (!Array.isArray(entry.exportedHelpers)) failures.push(`missing exported helper list for ${entry.path}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: {
      total: entries.length,
      paths: new Set(paths).size,
      owners: [...new Set(entries.map((entry) => entry.owner))].sort(),
    },
  };
}
