# Panel style guards

The panel keeps its look stable across refactors through computed-style parity,
not through frozen CSS snapshots.

## Protected views

`#authGate`, `#appShell`, `#viewApproval`, `#viewScripts`, `#viewAudio`,
`#viewSubtitulos2`.

## Guarded selectors

`.sidebar`, `.topbar`, `.card`, `.audio-queue-card`,
`.subtitle-phase-bar`, `.video-projects-layout`, `.video-project-card`,
`.composition-stage`.

## Rules

- `styles.css` stays import-only and keeps its cascade order.
- Video Projects CSS enters through
  `styles/features/video-projects/index.css` in the same cascade slot it has
  always used, with this chunk order: layout → project-list → setup-images →
  setup-audio → editor-shell → editor-controls → preview-composition →
  video-selector → responsive.
- A selector rename, import-order change or specificity change is a parity
  failure until the computed-style snapshot in
  `js/modules/__checks__/global/css-computed-style-parity.js` is updated with
  the intended change.

## Rollback

If a Video Projects style guard fails, revert only that CSS slice: restore the
previous `styles.css` import target and remove the extracted
`styles/features/video-projects/` chunk files. Do not mix in Radar, render,
controller, app-shell or composition changes.

## Evidence

- Runtime checker: `js/modules/__checks__/global/css-computed-style-parity.js`
- Panel tests: `apps/panel/tests/test_phase5_css_split_parity.py` and the
  `__checks__` runner (`pnpm test:checks`).
