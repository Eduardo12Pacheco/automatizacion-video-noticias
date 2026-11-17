# Panel contract matrix

The panel is plain HTML, CSS and ES modules with no build step. These are the
contracts a change must preserve; the visual and behavioural proof lives in
`apps/panel/tests/`, `apps/panel/js/modules/__checks__/` and `e2e/`.

## DOM contract

- Element IDs in `index.html` and `data-action` values are public hooks used by
  the renderers, checks and Playwright flows. Do not rename or remove one
  without updating every consumer.
- Feature entry points (`js/modules/features/*/index.js`) keep their exported
  shape. Internal modules may move behind that facade.
- User-visible copy comes from the ES/EN catalogs in
  `js/modules/core/i18n/`; generated editorial data (news titles, scripts,
  player names) stays in its source language.

## HTTP contract

The browser talks only to `apps/api` on the same origin. The API owns auth,
sessions, CSRF and the role gate.

| Flow | Read | Mutation |
|---|---|---|
| Approval | `GET /panel/read-models/approval/pending`, `/queue`, `/topic` | `POST /webhook/approval/decision/v2`, `/search-refresh/v2` |
| Scripts | `GET /panel/read-models/scripts/drafts` | `POST /webhook/mvp-script-draft-save/v2`, `/mvp-script-publish/v2`, `/mvp-script-download-doc/v1` |
| Video projects | `GET /panel/read-models/video-projects` | `POST /webhook/video-projects/manual-create/v1`, `/panel/video-projects/:draftId/*` |
| Uploads and blobs | `GET /panel/blobs/*` | `POST /panel/uploads/:bucket/*` |

Mutating requests keep their method, trusted `Origin` check and session cookie.
The Supabase-era `/webhook/.../supabase/...` paths remain accepted as
deprecated aliases for existing webhooks; new code uses the neutral paths.

## Style contract

- `styles.css` stays import-only and keeps the documented cascade order.
- `styles/features/video-projects/index.css` stays import-only: layout →
  project-list → setup-images → setup-audio → editor-shell → editor-controls →
  preview-composition → video-selector → responsive.
- Protected selectors: `.sidebar`, `.topbar`, `.card`, `.audio-queue-card`,
  `.subtitle-phase-bar`, `.video-projects-layout`, `.video-project-card`,
  `.composition-stage`.
- Component and feature CSS use the semantic tokens from `styles/tokens.css`;
  no raw colour literals outside the token file.

## Runtime checks

```bash
pnpm test:panel      # pytest contracts and behavioural checks
pnpm test:checks     # node checks under js/modules/__checks__/
pnpm test:visual     # Playwright visual QA, axe and i18n matrix
```

The executable computed-style parity snapshot and the dependency-boundary
validators run from `js/modules/__checks__/global/` and are covered by the
panel test suite.
