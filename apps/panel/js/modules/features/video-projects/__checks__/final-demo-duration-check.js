import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 7 levels up from apps/panel/js/modules/features/video-projects/__checks__ to repo root.
const REPO_ROOT = resolve(__dirname, '../../../../../../..');
const CP_PREVIEW = resolve(REPO_ROOT, 'apps/panel/assets/final-demo-cup.webm');
const VE_RENDER = resolve(REPO_ROOT, 'services/renderer/assets/overlays/final-demo-cup.mp4');
const CP_CATALOG = resolve(REPO_ROOT, 'apps/panel/js/modules/features/video-projects/composition/overlay-assets.js');
const CONTRACTS_CATALOG = resolve(REPO_ROOT, 'packages/contracts/approval-contract-pipeline/index.js');
const CATALOG_TARGET_SECONDS = 30.12;
const PARITY_TOLERANCE_SECONDS = 0.1;

function fail(message) {
  throw new Error(message);
}

function assertWithinTolerance(actual, target, tolerance, message) {
  const diff = Math.abs(Number(actual) - Number(target));
  if (diff > tolerance) {
    fail(`${message}: ${JSON.stringify(actual)} differs from ${JSON.stringify(target)} by ${diff.toFixed(6)}s (> ${tolerance}s tolerance)`);
  }
}

function ffprobeDurationSeconds(filePath) {
  const stdout = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  return Number(String(stdout).trim());
}

function extractBalancedObject(source, startIndex) {
  // Find the matching closing brace for an object starting at startIndex (which must point to '{').
  let depth = 0;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  return null;
}

function extractFinalMundialBlock(source) {
  const keyMatch = source.match(/['"]final-demo-cup['"]\s*:\s*\{/);
  if (!keyMatch) return null;
  const startBraceIndex = source.indexOf('{', keyMatch.index);
  return extractBalancedObject(source, startBraceIndex);
}

function extractFinalMundialDurationFromSource(source) {
  const block = extractFinalMundialBlock(source);
  if (!block) return null;
  const outroMatch = block.match(/durationSeconds\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  return outroMatch ? Number(outroMatch[1]) : null;
}

function assertCatalogHasFinalMundialDuration30_12(label, filePath) {
  if (!existsSync(filePath)) {
    fail(`Catalog file not found at ${filePath}`);
  }
  const source = readFileSync(filePath, 'utf8');
  const catalogValue = extractFinalMundialDurationFromSource(source);
  if (!Number.isFinite(catalogValue)) {
    fail(`Could not locate outro.durationSeconds in the final-demo-cup block of ${label} (${filePath})`);
  }
  if (Math.abs(catalogValue - CATALOG_TARGET_SECONDS) > 0.0001) {
    fail(
      `${label} catalog final-demo-cup outro.durationSeconds is ${catalogValue}, expected ${CATALOG_TARGET_SECONDS}`,
    );
  }
  return { value: catalogValue, block: extractFinalMundialBlock(source) };
}

function runFinalMundialDurationParityCheck() {
  if (!existsSync(CP_PREVIEW)) {
    fail(`Final Mundial preview webm not found at ${CP_PREVIEW}`);
  }
  if (!existsSync(VE_RENDER)) {
    fail(`Final Mundial render mp4 not found at ${VE_RENDER}`);
  }

  const webmDuration = ffprobeDurationSeconds(CP_PREVIEW);
  const mp4Duration = ffprobeDurationSeconds(VE_RENDER);

  if (!Number.isFinite(webmDuration) || !Number.isFinite(mp4Duration)) {
    fail(`Invalid ffprobe output: webm=${webmDuration}s, mp4=${mp4Duration}s`);
  }

  // Parity assertion: preview and render durations must agree within 0.1s.
  const parityDelta = Math.abs(webmDuration - mp4Duration);
  if (parityDelta > PARITY_TOLERANCE_SECONDS) {
    fail(
      `Final Mundial preview/render duration parity violated: |${webmDuration} - ${mp4Duration}| = ${parityDelta.toFixed(6)}s > ${PARITY_TOLERANCE_SECONDS}s`,
    );
  }

  // Catalog value (30.12) must agree with both files within 0.1s. This is the
  // contract the two mirrored catalog entries in `overlay-assets.js:58` and
  // `packages/contracts/approval-contract-pipeline/index.js:25` must respect.
  assertWithinTolerance(
    webmDuration,
    CATALOG_TARGET_SECONDS,
    PARITY_TOLERANCE_SECONDS,
    'Final Mundial preview webm duration',
  );
  assertWithinTolerance(
    mp4Duration,
    CATALOG_TARGET_SECONDS,
    PARITY_TOLERANCE_SECONDS,
    'Final Mundial render mp4 duration',
  );
}

function runFinalMundialCatalogMirrorParityCheck() {
  const cp = assertCatalogHasFinalMundialDuration30_12('Control Panel', CP_CATALOG);
  const contracts = assertCatalogHasFinalMundialDuration30_12('Contracts Core', CONTRACTS_CATALOG);
  if (cp.value !== contracts.value) {
    fail(`Catalogs disagree: Control Panel says ${cp.value}, Contracts Core says ${contracts.value}`);
  }
  // Both catalogs have the same outro key set (semantic invariant: same render path, same asset id, same duration).
  // The two files use different formatting (single vs double quotes; multi-line vs single-line) — that pre-existing
  // difference is acceptable as long as the semantic values match. The value-level comparison above is what
  // matters for runtime correctness.
  for (const field of ['assetId', 'previewPath', 'renderPath', 'durationSeconds', 'label']) {
    // Match a value that is either a quoted string or a number literal.
    const pattern = new RegExp(`\\b${field}\\s*:\\s*(?:["']([^"']+)["']|([0-9]+(?:\\.[0-9]+)?))`);
    const cpField = pattern.exec(cp.block);
    const contractsField = pattern.exec(contracts.block);
    if (!cpField || !contractsField) {
      fail(`Mirror parity check could not extract field ${field} from both catalog blocks`);
    }
    const cpValue = cpField[1] !== undefined ? cpField[1] : cpField[2];
    const contractsValue = contractsField[1] !== undefined ? contractsField[1] : contractsField[2];
    if (cpValue !== contractsValue) {
      fail(`Field ${field} differs between catalogs: Control Panel=${cpValue}, Contracts Core=${contractsValue}`);
    }
  }
}

export async function runFinalMundialDurationCheck() {
  runFinalMundialDurationParityCheck();
  runFinalMundialCatalogMirrorParityCheck();
}

if (process.argv[1] && __filename === process.argv[1]) {
  await runFinalMundialDurationCheck();
  console.log('final-demo-cup-duration-check: ok');
}
