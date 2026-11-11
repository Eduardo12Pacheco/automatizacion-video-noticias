# Apply Progress: Harden Automatic Video Pipeline

## Batch A: Audio + contracts base

Status: complete

### Completed Tasks

- [x] 1.1 Added RED-first audio normalization tests for source resolution, skip-existing, `--force`, and render fallback order.
- [x] 1.2 Added RED-first JSON contract tests for invalid JSON/schema diagnostics with path and field evidence.
- [x] 1.3 Created `scripts/lib/schemas.js` with shared Zod schemas for core pipeline contracts.
- [x] 1.4 Created `scripts/lib/json-contracts.js` with `readJsonSchema`/`writeJsonSchema` helpers.
- [x] 1.5 Created `scripts/normalize-audio.js` with `ffmpeg-static` normalization planning/CLI and added media audio resolvers.
- [x] 1.6 Updated `package.json`/lockfile with `normalize:audio`, pipeline normalization before STT, and direct `zod`/`ffmpeg-static` dependencies.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 1.1 | `tests/audio-normalization.test.js` | Unit | ✅ `npm test` 13/13 baseline | ✅ Missing `scripts/normalize-audio`/new resolver exports failed | ✅ Batch tests passed | ✅ 4 cases | ✅ Extracted pure resolver/plan helpers |
| 1.2 | `tests/json-contracts.test.js` | Unit | ✅ `npm test` 13/13 baseline | ✅ Missing `scripts/lib/json-contracts` failed | ✅ Batch tests passed | ✅ 3 cases | ✅ Centralized Zod issue formatting |
| 1.3 | `tests/json-contracts.test.js` | Unit | N/A (new file) | ✅ Schema usage exercised via contract tests | ✅ Batch tests passed | ✅ Multiple schema paths | ➖ None needed |
| 1.4 | `tests/json-contracts.test.js` | Unit | N/A (new file) | ✅ Read/write helpers referenced before implementation | ✅ Batch tests passed | ✅ Invalid JSON, invalid schema, write validation | ✅ Shared validate helper |
| 1.5 | `tests/audio-normalization.test.js` | Unit | ✅ `npm test` 13/13 baseline | ✅ Resolver/plan helpers referenced before implementation | ✅ Batch tests passed | ✅ Existing/source/force/fallback paths | ✅ Pure planning separated from FFmpeg side effect |
| 1.6 | `tests/audio-normalization.test.js` + `npm test` | Unit/Script | ✅ `npm test` 13/13 baseline | ✅ New deps/scripts absent before implementation | ✅ `npm test` passed | ✅ Pipeline/dependency checks via implementation and full suite | ➖ None needed |

### Tests Run

- `npm test` before changes: 13/13 passing.
- `node --test tests/audio-normalization.test.js tests/json-contracts.test.js` RED: failed on missing new modules.
- `node --test tests/audio-normalization.test.js tests/json-contracts.test.js` GREEN: 7/7 passing.
- `npm test`: 20/20 passing.

### Deviations / Notes

- Batch A deliberately avoided Batch B/C/D behavior; later batches completed guion parsing, alignment diagnostics, image scoring, canonical timeline strictness, render props validation, README cleanup and spaCy cleanup.
- `npm install zod ffmpeg-static` reported existing audit findings: 9 vulnerabilities (2 low, 2 moderate, 4 high, 1 critical). Not addressed because dependency audit/remediation is outside Batch A.

### Remaining Batches

- Batch B: guion empty-block validation, alignment diagnostics, metadata-aware image selection. **Complete**
- Batch C: canonical timeline invariants and derived render props validation. **Complete**
- Batch D: docs/dependency cleanup and final verification.

## Batch B: Guion + alignment + images

Status: complete

### Completed Tasks

- [x] 2.1 Added RED-first guion parsing tests for `intro || cierre`, leading/trailing delimiters, whitespace-only block failures, and original block index preservation.
- [x] 2.2 Created `scripts/lib/guion-parsing.js` and updated `scripts/process-script.js` to fail empty `|` blocks before emitting `script-phrases.json` while preserving block indexes.
- [x] 2.3 Added RED-first alignment tests for confidence fields, threshold severity, fallback warnings/errors, and ±250ms drift diagnostics.
- [x] 2.4 Updated `scripts/lib/phrase-alignment.js` and `scripts/align-phrases.js` to emit `confidence`, matched evidence, source, `severity`, `warnings`, `maxDriftMs`, and top-level alignment diagnostics.
- [x] 2.5 Added RED-first image selection tests for optional metadata aliases/tags/weights, anti-repetition, score diagnostics, and placeholder warning behavior.
- [x] 2.6 Updated `scripts/lib/image-selection.js` and `scripts/process-script.js` to load optional `imagenes/metadata.json`, score candidates by filename/metadata, avoid immediate repetition when alternatives exist, and emit warning diagnostics for placeholders.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 2.1 | `tests/guion-parsing.test.js` | Unit | ✅ `npm test` 20/20 baseline | ✅ Missing `scripts/lib/guion-parsing` failed | ✅ Batch tests passed | ✅ `||`, leading/trailing delimiter, whitespace block, valid indexed parse | ✅ Extracted pure parser |
| 2.2 | `tests/guion-parsing.test.js` | Unit/Script | ✅ `npm test` 20/20 baseline | ✅ Parser contract failed before implementation | ✅ `npm test` 29/29 passed | ✅ Empty-block and valid parse paths | ✅ `process-script.js` delegates parsing to pure helper |
| 2.3 | `tests/phrase-alignment.test.js` | Unit | ✅ `npm test` 20/20 baseline | ✅ Missing confidence/severity/warnings/drift fields failed | ✅ Batch tests passed | ✅ ok confidence, fallback error, partial confidence, drift warning | ✅ Diagnostics helper extracted |
| 2.4 | `tests/phrase-alignment.test.js` | Unit/Script | ✅ `npm test` 20/20 baseline | ✅ Alignment diagnostics absent before implementation | ✅ `npm test` 29/29 passed | ✅ Word-match, segment fallback, tail fallback, drift paths | ✅ Top-level diagnostics aggregation added |
| 2.5 | `tests/image-selection.test.js` | Unit | ✅ `npm test` 20/20 baseline | ✅ Metadata/anti-repetition/placeholder warning expectations failed | ✅ Batch tests passed | ✅ Metadata match, no images, no acceptable match, repetition alternative | ✅ Scoring split into metadata-aware helper |
| 2.6 | `tests/image-selection.test.js` | Unit/Script | ✅ `npm test` 20/20 baseline | ✅ `readImageMetadata` and diagnostics absent before implementation | ✅ `npm test` 29/29 passed | ✅ Optional missing metadata and selection diagnostics | ✅ `process-script.js` carries previous-image state |

### Tests Run

- `npm test` before Batch B changes: 20/20 passing.
- `node --test tests/guion-parsing.test.js tests/phrase-alignment.test.js tests/image-selection.test.js` RED: failed on missing guion parser and missing Batch B diagnostics/metadata/repetition behavior.
- `node --test tests/guion-parsing.test.js tests/phrase-alignment.test.js tests/image-selection.test.js` GREEN: 17/17 passing.
- `npm test`: 29/29 passing.
- `node --test tests/guion-parsing.test.js tests/phrase-alignment.test.js tests/image-selection.test.js && npm test` after refactor: 17/17 and 29/29 passing.

### Deviations / Notes

- Captions/subtitles/text rendering remain out of scope; guion text is used only for parsing, alignment, and image selection.
- Placeholder behavior now applies when images exist but no acceptable keyword/metadata match is found, matching Batch B spec.
- Batch B deliberately avoided Batch C/D behavior; later batches completed timeline strictness, render-props derivation, README cleanup and spaCy cleanup.

### Remaining Batches

- Batch C: canonical timeline invariants and derived render props validation. **Complete**
- Batch D: docs/dependency cleanup and final verification.

## Batch C: Canonical timeline + render props derivation

Status: complete

### Completed Tasks

- [x] 3.1 Added RED-first canonical timeline tests for first segment `0.00`, gap/overlap failures, last segment matching render duration, diagnostics preservation, and schema/helper invalid-shape failures.
- [x] 3.2 Added canonical timeline helpers and updated `scripts/generate-timeline.js` to validate phrase timestamps, canonicalize `output/timeline.json`, preserve diagnostics, and write through schema validation.
- [x] 3.3 Updated `scripts/verify-sync.js` to read validated `timeline.json`, fail strict gap/overlap/first/last/duration invariants with segment indexes and timing evidence, and keep writing pipeline diagnostics.
- [x] 3.4 Added RED-first render dry-run smoke tests for derived render props, `audio-16khz.wav` fallback, invalid canonical timeline failure, and no implicit `fix-timeline.js` in the main pipeline.
- [x] 3.5 Updated `scripts/render-video.js` to assert the canonical timeline before side effects, derive Remotion props from validated timeline only, and validate `output/render-props.json` before writing.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 3.1 | `tests/timeline-utils.test.js` | Unit | ✅ `npm test` 29/29 baseline | ✅ Missing `buildCanonicalTimeline`/`assertCanonicalTimeline` failed | ✅ Batch tests passed | ✅ valid canonical build, timing invariant failure, schema shape failure | ✅ Extracted pure canonical validation/build helpers |
| 3.2 | `tests/timeline-utils.test.js` | Unit/Script | ✅ `npm test` 29/29 baseline | ✅ Canonical helper contract absent before implementation | ✅ `node --test tests/timeline-utils.test.js tests/pipeline-smoke.test.js` 10/10 then 11/11 passed | ✅ diagnostics preservation plus duration/gapless invariants | ✅ `generate-timeline.js` delegates to shared helpers and JSON contracts |
| 3.3 | `tests/timeline-utils.test.js` + `tests/pipeline-smoke.test.js` | Unit/CLI smoke | ✅ `npm test` 29/29 baseline | ✅ Invalid timeline/gap test passed incorrectly before strict validation | ✅ Batch tests passed | ✅ first/last/gap/overlap/schema paths | ✅ Strict validation centralized in `assertCanonicalTimeline` |
| 3.4 | `tests/pipeline-smoke.test.js` | CLI smoke | ✅ `npm test` 29/29 baseline | ✅ `render-video --dry-run` accepted invalid gap timeline; pipeline still invoked `fix-timeline.js` implicitly | ✅ Batch tests passed | ✅ valid fallback render props and invalid timeline failure paths | ➖ None needed |
| 3.5 | `tests/pipeline-smoke.test.js` | CLI smoke | ✅ `npm test` 29/29 baseline | ✅ Render props were derived after silent normalization and without strict contract validation | ✅ `npm test` 35/35 passed | ✅ fallback audio, image copy mapping, invalid timeline no-write behavior | ✅ Render side effects now happen after canonical assertion |

### Tests Run

- `npm test` before Batch C changes: 29/29 passing.
- `node --test tests/timeline-utils.test.js tests/pipeline-smoke.test.js` RED: failed on missing canonical helpers and `render-video` accepting an invalid gap timeline.
- `node --test tests/timeline-utils.test.js tests/pipeline-smoke.test.js` GREEN: 10/10 passing.
- `node --test tests/pipeline-smoke.test.js` RED for explicit pipeline behavior: failed because `pipeline` still invoked `fix-timeline.js` before `verify-sync.js`.
- `node --test tests/timeline-utils.test.js tests/pipeline-smoke.test.js` after package/script update: 11/11 passing.
- `npm test`: 35/35 passing.

### Deviations / Notes

- Main `pipeline` no longer runs `scripts/fix-timeline.js` implicitly; `fix:timeline` remains an explicit/manual canonicalization command. This matches the design goal that `verify-sync.js` must be the strict gate and must not have final gaps/overlaps hidden by an automatic repair step.
- `fix-timeline.js` now validates the input timeline schema, canonicalizes duration against resolved render audio when available, preserves diagnostics, and writes via the timeline schema.
- Captions/subtitles/UI/text rendering remain out of scope.

### Remaining Batches

- Batch D: docs/dependency cleanup and final Node-test verification. **Complete**

## Batch D: Cleanup, docs + final Node verification

Status: complete

### Completed Tasks

- [x] 4.1 Confirmed `spaCy` has no productive usage in pipeline scripts or active manifests; removed `spacy==3.8.13` from `requirements.txt` while keeping `faster-whisper` and `vosk` fallback dependencies intact.
- [x] 4.2 Updated `README.md` to document the hardened headless workflow: no UI/captions scope, `audio/source.*` preference/fallback, `npm run normalize:audio`, pipeline normalization, normalized audio roles, `guion/guion.txt` delimiter failures, optional `imagenes/metadata.json`, canonical `timeline.json`, derived `render-props.json`, diagnostics, and explicit/manual `fix:timeline`.
- [x] 4.3 Ran existing Node tests only with `npm test`; no build, render, install, or lockfile mutation was performed.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| 4.1 | N/A — dependency cleanup | Documentation/manifest | ✅ Productive usage search before edit: only SDD/historical docs plus `requirements.txt`; no `scripts/` usage | ➖ No new behavior test required by Batch D; removal gated by search evidence | ✅ `requirements.txt` now keeps only `vosk` and `faster-whisper` | ➖ Not applicable; no runtime behavior added | ✅ Removed unused Python dependency without touching STT fallbacks |
| 4.2 | N/A — README docs | Documentation | ✅ Read spec/design/tasks and existing README before edit | ➖ No new behavior test required; docs aligned to existing implemented behavior | ✅ README now reflects actual hardened workflow and scope | ✅ Covered audio, guion, metadata, contracts, diagnostics, and manual `fix:timeline` docs | ✅ Replaced stale `guion/script.txt` and implicit `fix-timeline` docs |
| 4.3 | `npm test` | Full Node suite | ✅ No pre-existing test failure discovered in final verification | ➖ Existing test suite only; Batch D did not add product behavior | ✅ `npm test` passed 35/35 | ✅ Full suite exercises prior batches/contracts | ➖ No code refactor performed |

### Tests Run

- `npm test`: 35/35 passing.

### Deviations / Notes

- `spaCy` references remain only in SDD artifacts and historical planning documents (`PRD_Proyecto_Automatic_Generation.md`, `Tasks_Proyecto_Automatic_Generation_with_checkboxes.md`); active production scripts and `requirements.txt` no longer depend on it.
- Batch D intentionally added no tests because it changed docs and removed an unused Python dependency only; final verification used the existing Node suite per assignment.
- Captions/subtitles/UI/text rendering remain out of scope.

### Remaining Batches

- None — ready for `sdd-verify`.

## Batch E: Verify critical fixes

Status: complete

### Completed Tasks

- [x] E.1 Added RED-first coverage proving `generate-timeline.js` extends the final canonical segment to the resolved render-audio duration when transcript/phrase timestamps are shorter because of trailing silence.
- [x] E.2 Updated `generate-timeline.js` to resolve render audio (`audio-48khz.wav` then `audio-16khz.wav`) and build `output/timeline.json` against that duration when available, while preserving strict `verify-sync.js` gap/overlap/final-duration failures.
- [x] E.3 Added RED-first contract tests for the real `script-phrases.json` shape `{ phrases: [...] }` and JS boundary validation failures in `align-phrases.js` for invalid `script-phrases.json` and `transcript.json`.
- [x] E.4 Corrected `scriptPhrasesSchema` to the emitted object contract and updated `process-script.js`/`align-phrases.js` to use `readJsonSchema`/`writeJsonSchema` at JS contract boundaries.

### TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
|------|-----------|-------|------------|-----|-------|-------------|----------|
| E.1 | `tests/pipeline-smoke.test.js` | CLI smoke | ✅ `npm test` 35/35 baseline | ✅ `verify-sync.js` failed because generated timeline ended at 4.2s while render audio was 5s | ✅ Relevant tests passed after `generate-timeline.js` resolved render audio | ✅ Existing smoke plus trailing-silence case cover matching and shorter transcript durations | ✅ Kept canonicalization in existing timeline helper |
| E.2 | `tests/pipeline-smoke.test.js` | CLI smoke | ✅ `npm test` 35/35 baseline | ✅ New trailing-silence smoke exposed main pipeline duration risk | ✅ `npm test` 38/38 passed | ✅ `audio-48khz.wav` duration path plus existing fallback render tests | ➖ Minimal script wiring only |
| E.3 | `tests/json-contracts.test.js` + `tests/pipeline-smoke.test.js` | Unit/CLI smoke | ✅ `npm test` 35/35 baseline | ✅ `scriptPhrasesSchema` rejected object shape; `align-phrases.js` accepted array shape and continued | ✅ Relevant tests passed after schema/boundary validation | ✅ Invalid script-phrases shape and invalid transcript shape both fail before output write | ✅ Reused shared JSON contract helpers |
| E.4 | `tests/json-contracts.test.js` + `tests/pipeline-smoke.test.js` | Unit/Script | ✅ `npm test` 35/35 baseline | ✅ Boundary tests failed before implementation | ✅ `npm test` 38/38 passed | ✅ Process write schema, align read/write schemas, transcript read schema | ✅ Preserved Python boundary; JS consumers validate `transcript.json` before use |

### Tests Run

- `npm test` before Batch E changes: 35/35 passing.
- `node --test tests/json-contracts.test.js tests/pipeline-smoke.test.js` RED: 7/10 passing, 3 failing (`scriptPhrasesSchema` object shape, render-audio trailing-silence duration, `align-phrases.js` invalid contract acceptance).
- `node --test tests/json-contracts.test.js tests/pipeline-smoke.test.js` GREEN: 10/10 passing.
- `npm test`: 38/38 passing.

### Deviations / Notes

- `transcribe-audio.py` remains a Python boundary; Zod is intentionally not forced into Python. JS consumers now validate `output/transcript.json` via `transcriptSchema` before alignment.
- `verify-sync.js` remains strict and still fails invalid schema, gaps, overlaps, first-segment drift and final-duration mismatches; the fix canonicalizes at generation time using render audio when available instead of reintroducing automatic `fix-timeline.js` repair.
- Captions/subtitles/UI/text rendering remain out of scope.

### Remaining Batches

- None — ready for `sdd-verify` to re-check the two previous critical findings.
