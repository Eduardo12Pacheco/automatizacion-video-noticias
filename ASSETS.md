# Asset Manifest

All media in this repository is fictional demo material for the portfolio
build. The owner's original brand media, ripped transition overlays and the
legacy display font are intentionally **not** included (decision D5).

## Generated Brand Assets

Canonical files live under `examples/brand/` and are mirrored into the runtime
folders used by the panel and renderer. Every file below is generated
reproducibly by [`tools/assets/generate_demo_assets.py`](tools/assets/generate_demo_assets.py):

```sh
python tools/assets/generate_demo_assets.py
```

Requirements: `ffmpeg`, `woff2_compress` and Python Pillow. Video/audio
metadata is stripped by the generator (`-map_metadata -1`), and still images
carry no EXIF data.

| Asset | Role | Origin | License |
|---|---|---|---|
| `examples/brand/logo-demo.webm` | Alpha logo sting (VP9, alpha) | Generated code | CC0 |
| `examples/brand/logo-demo-green.mp4` | Green-screen logo for chroma key | Generated code | CC0 |
| `examples/brand/logo-demo.png` | Static logo still | Generated code | CC0 |
| `examples/brand/final-demo.mp4` / `.webm` | Outro card (30.12 s) | Generated code | CC0 |
| `examples/brand/particle-1..2.webm` | Dust/particle overlay loops | Generated code | CC0 |
| `examples/brand/overlay-1..2.webm` | Screen/multiply overlay loops | Generated code | CC0 |
| `examples/brand/transition-1..3.mp4` | Boundary transition stand-ins | Generated code | CC0 |
| `examples/brand/sfx/whip.wav`, `whoosh.wav`, `sting.wav` | Transition SFX, synthesized | Generated code | CC0 |
| `examples/brand/fonts/Demo-Display.woff2` | Display font for the fictional brand | Derived from **Anton Regular** (SIL Open Font License 1.1) | OFL-1.1 |

Runtime mirrors (same origin/license) are written to:

- `services/renderer/assets/overlays/` — render roles: `logo-primary.webm`,
  `logo-secondary.webm`, `logo-green.mp4`, `logo-clean.mp4`, `logo-final.png`,
  `outro-{primary,secondary,final}.mp4`, `particle-1..4.webm`,
  `overlay-layer-01/02.webm` + `.mp4`, the alpha logo frame folders, and the
  three boundary transitions.
- `services/renderer/public/` — `fonts/display/Demo-Display.woff2`,
  `sfx/sound-demo.wav` and the generated SFX set.
- `apps/panel/assets/` — browser previews for the same roles, plus
  `boundary-transitions/`.

The fictional brand name is **Demo Sports News**. Brand roles use neutral
names (`logo-primary`, `logo-secondary`, `logo-final`, `outro-primary`,
`outro-secondary`, `outro-final`); no country or tournament name is baked into
an asset path.

The generated logo stills carry the tagline **LOCAL DEMO / CC0**. `CC0` is the
license dedication for the generated art, not a brand or a person; an earlier
draft misspelled that license dedication with a three-letter look-alike, and no
shipped asset carries the misspelling.

## Panel Icon

| Asset | Role | Origin | License |
|---|---|---|---|
| `apps/panel/favicon.svg` | Browser favicon for Demo Sports News | Hand-authored SVG in this repository | CC0 |

The icon is an original broadcast mark (a central dot with two signal arcs),
not a copy of any owner file.

## Font Licensing

All shipped fonts are distributed under the SIL Open Font License, Version 1.1.
An `OFL.txt` file sits next to every font directory and contains the original
copyright notice plus the full license text:

| Font directory | Fonts | OFL file |
|---|---|---|
| `services/subtitles/assets/fonts/subtitles/` | Anton, Bebas Neue, Khand, League Gothic, Oswald | `OFL.txt` |
| `examples/brand/fonts/` | `Demo-Display.woff2` (derived from Anton) | `OFL.txt` |
| `apps/panel/assets/fonts/display/` | `Demo-Display.woff2` | `OFL.txt` |
| `services/renderer/public/fonts/display/` | `Demo-Display.woff2` | `OFL.txt` |

`Demo-Display.woff2` is a renamed, subsetted repackaging of the OFL-licensed
Anton font; the reserved-name rules do not apply because Anton's copyright
notice does not declare a Reserved Font Name. The generated display face keeps
the OFL notice and may not be redistributed under another license.

## Recorded Demo

`docs/images/demo.gif` (short loop) and `docs/images/demo.mp4` (34-second walkthrough) are
screen recordings of the panel in **demo mode** on the keyless stack, in
Spanish with the seeded fictional story: login, Prensa, Guiones, Voz,
Subtítulos, Proyectos and Settings. They are product screenshots, not brand
media, and contain only the fictional demo data.

The recording is reproducible and app-viewport only:

```sh
cp e2e/.env.example .env
docker compose up -d --build postgres searxng mailpit demo-worker api panel
docker compose run --rm seed
NEWSROOM_DEMO_PASSWORD=e2e-demo-password node tools/record-demo.mjs
```

`tools/record-demo.mjs` captures the browser viewport through Playwright, fails
if the page logs a console error or throws, converts the capture with `ffmpeg`
(`-map_metadata -1`) and writes the MP4 plus the optimized under-1-MB GIF. Both
files are well below the 5 MB blob limit enforced for history.

## Not Included

- Owner-made brand overlays, intros, outros and the legacy display font.
- Ripped YouTube transition overlays and third-party music.
- Any model binaries, caches or generated render output.
