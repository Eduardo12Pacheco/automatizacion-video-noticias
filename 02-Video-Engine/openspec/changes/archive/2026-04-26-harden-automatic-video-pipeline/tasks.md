# Tasks: Harden Automatic Video Pipeline

## Phase 1: Test-first contracts and audio foundation

- [x] 1.1 RED: Add `tests/audio-normalization.test.js` for source resolution, skip-existing, `--force`, and render fallback `audio-48khz.wav -> audio-16khz.wav`.
- [x] 1.2 RED: Add `tests/json-contracts.test.js` covering invalid JSON/schema diagnostics with path and field evidence.
- [x] 1.3 GREEN: Create `scripts/lib/schemas.js` with Zod schemas for script phrases, transcript, phrase timestamps, timeline diagnostics, timeline, metadata, and render props.
- [x] 1.4 GREEN: Create `scripts/lib/json-contracts.js` with `readJsonSchema`/`writeJsonSchema`; update JSON readers/writers only after schemas exist.
- [x] 1.5 GREEN: Create `scripts/normalize-audio.js` using `ffmpeg-static`; update `scripts/lib/media-utils.js` with source/STT/render audio resolvers.
- [x] 1.6 GREEN: Update `package.json` scripts/deps: add `normalize:audio`, insert before STT in `pipeline`, add direct `zod` and `ffmpeg-static`.

## Phase 2: Guion, alignment, and image selection

- [x] 2.1 RED: Extend `tests/pipeline-smoke.test.js` or add guion tests for `intro || cierre`, leading/trailing delimiter, and whitespace block index failure.
- [x] 2.2 GREEN: Update `scripts/process-script.js` to preserve `|` block indexes, fail empty blocks before timeline generation, and keep guion text render out of scope.
- [x] 2.3 RED: Extend `tests/phrase-alignment.test.js` for confidence thresholds, fallback taxonomy, ±250ms warnings, and low-confidence failures.
- [x] 2.4 GREEN: Update `scripts/lib/phrase-alignment.js` and `scripts/align-phrases.js` to emit confidence, matched evidence, source, severity, and warnings.
- [x] 2.5 RED: Extend `tests/image-selection.test.js` for optional `imagenes/metadata.json`, aliases/tags/weights, anti-repetition, score diagnostics, and placeholder warning.
- [x] 2.6 GREEN: Update `scripts/lib/image-selection.js` and `scripts/process-script.js` to apply metadata-aware scoring and image diagnostics.

## Phase 3: Canonical timeline and render props

- [x] 3.1 RED: Extend `tests/timeline-utils.test.js` for first segment `0.00`, gap/overlap failure, and last segment equal to render-audio duration.
- [x] 3.2 GREEN: Update `scripts/generate-timeline.js` to canonicalize and validate `output/timeline.json` with diagnostics; do not silently accept invalid timing.
- [x] 3.3 GREEN: Update `scripts/verify-sync.js` to fail schema/timing violations with segment indexes and timing evidence.
- [x] 3.4 RED: Extend `tests/pipeline-smoke.test.js` for `render-video --dry-run` deriving props from validated timeline and render-audio fallback.
- [x] 3.5 GREEN: Update `scripts/render-video.js` to read validated timeline and write validated `output/render-props.json` as derived Remotion props only.

## Phase 4: Cleanup, docs, and verification

- [x] 4.1 Remove `spacy==3.8.13` from `requirements.txt` if production search confirms no usage; keep Whisper/Vosk fallback intact.
- [x] 4.2 Update `README.md` with Windows-first normalization, `guion/guion.txt` delimiter rules, contracts, diagnostics, metadata, and no captions/UI scope.
- [x] 4.3 Run existing Node tests only: `npm test`; do not build, render, install, or change dependency lockfiles without explicit apply-phase approval.

## Suggested Implementation Batches

- Batch A: 1.1-1.6 audio/contracts/dependencies.
- Batch B: 2.1-2.6 guion/alignment/images.
- Batch C: 3.1-3.5 timeline/render props.
- Batch D: 4.1-4.3 cleanup/docs/tests.
