# Archive Report: harden-automatic-video-pipeline

## Status

Archived successfully after verification reported **PASS WITH WARNINGS** and **no CRITICAL findings**.

## Traceability

### Engram observation IDs

- Explore: `#1228` (`sdd/harden-automatic-video-pipeline/explore`)
- Proposal: `#1232` (`sdd/harden-automatic-video-pipeline/proposal`)
- Spec: `#1235` (`sdd/harden-automatic-video-pipeline/spec`)
- Design: `#1237` (`sdd/harden-automatic-video-pipeline/design`)
- Tasks: `#1241` (`sdd/harden-automatic-video-pipeline/tasks`)
- Apply progress: `#1245` (`sdd/harden-automatic-video-pipeline/apply-progress`)
- Verify report: `#1266` (`sdd/harden-automatic-video-pipeline/verify-report`)

### OpenSpec artifacts read

- `openspec/changes/harden-automatic-video-pipeline/exploration.md`
- `openspec/changes/harden-automatic-video-pipeline/proposal.md`
- `openspec/changes/harden-automatic-video-pipeline/specs/automatic-video-pipeline/spec.md`
- `openspec/changes/harden-automatic-video-pipeline/design.md`
- `openspec/changes/harden-automatic-video-pipeline/tasks.md`
- `openspec/changes/harden-automatic-video-pipeline/apply-progress.md`
- `openspec/changes/harden-automatic-video-pipeline/verify-report.md`

## Spec Sync

The delta spec for `automatic-video-pipeline` was promoted as the source-of-truth spec because no existing main spec was present.

- Created: `openspec/specs/automatic-video-pipeline/spec.md`
- Source delta: `openspec/changes/harden-automatic-video-pipeline/specs/automatic-video-pipeline/spec.md`
- Action: created main spec with 9 requirements.

## Final Verified State

- `npm test` passed **38/38** during verify.
- No UI, captions, subtitles, or guion text rendering were introduced.
- Previous critical finding 1 fixed: `generate-timeline.js` now builds canonical `timeline.json` to the resolved render-audio duration, including trailing silence.
- Previous critical finding 2 fixed: JSON contract validation now covers the real `script-phrases.json` object contract and JS pipeline boundaries.
- `output/timeline.json` remains the canonical timing contract; `output/render-props.json` is derived for Remotion.

## Warnings Preserved

1. No `npm test` coverage proves actual FFmpeg side-effect output/sample rates; resolver/planning/force behavior is covered, but normalized WAV creation should get a future fixture test.
2. Working tree is broad/dirty; review before commit to avoid accidental generated artifacts or unrelated files.
3. Historical/stale references to spaCy/captions exist outside production pipeline scope; production scripts and active dependency files are clean.

## Archive Location

After this report is written, the active change directory is moved to:

- `openspec/changes/archive/2026-04-26-harden-automatic-video-pipeline/`

## Closure Summary

The change `harden-automatic-video-pipeline` is closed in SDD: explored, proposed, specified, designed, implemented, verified, synced to main OpenSpec specs, and archived. Next recommended work is repository review and commit preparation, not another SDD phase.
