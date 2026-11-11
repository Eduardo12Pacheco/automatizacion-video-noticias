# Automatic Video Pipeline Specification

## Purpose

Define the Windows-first headless contract for normalized audio, guion-driven visual segments, diagnosed alignment, automatic image selection, canonical timeline JSON, and derived Remotion render props. UI/editor visuals, captions, subtitles, and guion text rendering are out of scope.

## Requirements

### Requirement: Audio Source Resolution and Normalization

The system MUST resolve audio by preferring existing normalized files, then `audio/source.*`, then the first compatible audio in `audio/`. It SHALL generate `audio/audio-16khz.wav` for STT and `audio/audio-48khz.wav` for render with `ffmpeg-static`, preserving existing normalized files unless `--force` is supplied. Render audio resolution MUST prefer `audio-48khz.wav`, then `audio-16khz.wav`.

#### Scenario: Normalize missing files
- GIVEN `audio/source.mp3` exists and normalized WAVs are missing
- WHEN the pipeline or normalization command runs
- THEN both normalized WAV files are created
- AND STT uses 16 kHz while render uses 48 kHz

#### Scenario: Respect existing files unless forced
- GIVEN `audio/audio-16khz.wav` and `audio/audio-48khz.wav` already exist
- WHEN normalization runs without `--force`
- THEN those files are not overwritten
- WHEN normalization runs with `--force`
- THEN normalized files are regenerated from the resolved source

### Requirement: Guion Segment Parsing

The system MUST parse `guion/guion.txt` with `|` as the segment delimiter. Each non-empty block SHALL map to exactly one image segment, and any empty or whitespace-only block MUST fail before timeline generation.

#### Scenario: Empty guion block fails
- GIVEN a guion contains `intro || cierre` or a leading/trailing delimiter
- WHEN guion processing runs
- THEN processing fails with the offending block index
- AND no segment contract is emitted

### Requirement: STT and Alignment Diagnostics

The system SHOULD prefer Whisper through `faster-whisper` in `auto` mode while keeping Vosk/DeepSpeech-compatible fallback available. Alignment output MUST include confidence, matched evidence, fallback source, and warning/failure severity; approximate alignment is allowed when within configured thresholds and targeting ±250 ms precision.

#### Scenario: Alignment reports confidence and fallback
- GIVEN STT output only partially matches a guion segment
- WHEN alignment runs
- THEN the segment records confidence, matched/total words, and source strategy
- AND low confidence produces a warning or failure according to thresholds

### Requirement: Canonical Timeline Invariants and Diagnostics

`output/timeline.json` MUST be the canonical timeline contract. Its first segment MUST start at `0.00`, segments MUST be gapless and non-overlapping, and the last segment MUST reach the full resolved render-audio duration. Timeline diagnostics SHALL report duration, segment count, image strategy, alignment warnings, and validation failures.

#### Scenario: Gap or overlap fails
- GIVEN generated segments contain a timing gap or overlap
- WHEN timeline validation runs
- THEN validation fails with segment indexes and timing evidence
- AND no corrected timeline is silently accepted

### Requirement: Render Props Derivation

`output/render-props.json` MUST be derived from the canonical timeline and render-audio resolution. It SHALL contain Remotion-facing props only and MUST NOT become an independent source of timing truth.

#### Scenario: Derive render props from timeline
- GIVEN a valid `timeline.json` and resolved render audio
- WHEN render props generation runs
- THEN render props mirror timeline segment timing deterministically
- AND audio paths follow the render fallback order

### Requirement: Automatic Image Selection

The system MUST select images automatically using segment text and available image data. It SHOULD improve scoring with optional `imagenes/metadata.json`, avoid immediate repetition when acceptable alternatives exist, and use a placeholder only when no acceptable match exists, with a strong warning.

#### Scenario: Avoid repetition when alternatives exist
- GIVEN two adjacent segments and multiple acceptable image candidates
- WHEN images are selected
- THEN the same image is not reused immediately
- AND diagnostics include score and selection strategy

#### Scenario: Placeholder warning
- GIVEN no acceptable image candidate exists
- WHEN images are selected
- THEN a placeholder segment is assigned
- AND diagnostics include a strong warning for that segment

### Requirement: JSON Contract Validation

All generated JSON contracts, including timeline and render props, MUST be validated with Zod-compatible schemas before downstream use. Invalid JSON or schema violations MUST fail immediately with actionable diagnostics.

#### Scenario: Invalid JSON fails
- GIVEN a generated contract is malformed or violates schema
- WHEN a downstream step reads it
- THEN the step fails before rendering or further mutation
- AND reports the path and violated fields

### Requirement: Dependency Cleanup and Documentation

The system SHALL document the hardened flow, audio conventions, JSON contracts, diagnostics, and Windows-first scope in README. Unused `spaCy` dependency entries MUST be removed if no production usage remains.

#### Scenario: Docs and dependency contract
- GIVEN the hardened pipeline is available
- WHEN maintainers inspect README and dependency manifests
- THEN docs describe normalization, guion delimiter, diagnostics, and contracts
- AND unused `spaCy` is absent if still unused

### Requirement: Out-of-Scope Constraints

The change MUST NOT add UI/editor visual behavior, captions, subtitles, or text rendering from the guion. Remotion changes SHALL remain limited to explicit media/timeline handling with deterministic frame math.

#### Scenario: No caption output
- GIVEN a guion segment has text
- WHEN the pipeline and render props are produced
- THEN the text is used for alignment and image selection only
- AND no caption/subtitle/text-rendering prop is introduced
