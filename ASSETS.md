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

- `services/renderer/assets/overlays/` — render roles: `logo-demo-alpha.webm`,
  `logo-demo-co.webm`, `logo-green.mp4`, `logo-clean.mp4`, `logo-demo-cup.png`,
  `final-demo-{cup,co,ec}.mp4`, `particle-1..4.webm`,
  `overlay-layer-01/02.webm` + `.mp4`, the alpha logo frame folders, and the
  three boundary transitions.
- `services/renderer/public/` — `fonts/versa/Demo-Display.woff2`,
  `sfx/sound-demo.wav` and the generated SFX set.
- `apps/panel/assets/` — browser previews for the same roles, plus
  `boundary-transitions/`.

The fictional brand name is **Demo Sports News**. Country-specific filenames
(`-co`, `-ec`, `-cup`) are legacy role identifiers only and do not reference
any real team, person or channel.

## Font Licensing

`Demo-Display.woff2` is a rename/repackaging of the OFL-licensed Anton font
already shipped under `services/subtitles/assets/fonts/subtitles/`. The
original OFL license text is a T9 deliverable and must be kept next to the
font in the public tree.

## Not Included

- Owner-made brand overlays, intros, outros and the legacy display font.
- Ripped YouTube transition overlays and third-party music.
- Any model binaries, caches or generated render output.
