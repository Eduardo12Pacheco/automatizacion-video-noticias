# ADR 0004 — Vanilla UI instead of a React rewrite

## Status

Accepted.

## Context

The panel is a large vanilla HTML/CSS/ES-module application with real features:
approval inbox, script editor, audio, subtitles, video projects, settings and
admin. Its problems were visual and structural — inconsistent typography,
button hierarchy, colors, dialogs, mixed-language copy and accessibility — not a
lack of a component framework. A React rewrite would cost several weeks and
add a build step to a project whose value is the local pipeline.

## Decision

Keep the panel on vanilla HTML, CSS and ES modules, and improve it in place:

- One `tokens.css` with typography, color, spacing and radius tokens.
- Two font families only: Inter for UI, JetBrains Mono for timecodes and IDs.
- Neutral buttons with explicit `.primary`, `.secondary`, `.ghost` and `.danger`
  variants.
- One dialog pattern, one i18n module (`es.json` / `en.json`), pipeline-ordered
  navigation and three responsive breakpoints.
- Admin-only views and presence for the local multi-user model.

The panel talks only to `apps/api`, configured from `/panel/bootstrap`.

## Consequences

- There is no bundler, framework upgrade treadmill or hydration layer.
- Feature code stays directly inspectable in the browser.
- Parity and behavioural tests replace some frozen grep-only assertions.
- The team must keep discipline around tokens and i18n; nothing enforces the
  design system at compile time. The S5/T7 contract test is the guardrail.
- If the UI grows substantially, this decision should be revisited rather than
  silently abandoned.
