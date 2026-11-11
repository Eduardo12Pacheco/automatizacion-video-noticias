# Exploration: Browser Composition Preview

## Status: COMPLETE

## Composition Structure (`src/Composition.tsx`)

### Registration
- `src/index.ts` → `registerRoot(RemotionRoot)` → `src/Root.tsx` → `<Composition id="MyComp" ...>`
- Default canvas: **1920×1080** (render), **1280×720** (preview profile)
- FPS: **30** (hardcoded constant `Fps = 30` in Composition.tsx, also `fps` prop with default 30)
- Duration: calculated dynamically via `calculateMetadata` → `max(1, ceil((latestEnd + outroSeconds) * fps))`

### Segment Structure (`TimelineSegment`)
Each segment has:
- `image: string` — relative path to image in public dir
- `phrase?: string` — text (not rendered, used for alignment/selection only)
- `startTime: number` — seconds
- `endTime: number` — seconds
- `motion?: string` — "still" | "slow-zoom" | "slow-zoom-in" | "ken-burns" (any string)
- `dust?: { enabled?: boolean }` — per-segment dust toggle
- `logo?: { enabled?: boolean }` — per-segment logo toggle
- `filter?: { enabled?: boolean }` — contrast/saturation filter
- `transition?: string` — "none" | "fade" | "flash" (not implemented in Composition)
- `caption?: string` — not rendered

### Layer Stack (bottom to top)
1. **Background**: `#101828` (dark navy) when no segments
2. **Voice Audio**: `<Audio src={voiceSrc} volume={() => voice.volume ?? 1} />`
3. **Music Audio**: `<Audio src={musicSrc} volume={getFadedMusicVolume(...)} loop />`
4. **Segment Sequences**: Each segment wrapped in `<Sequence from={from} durationInFrames={durationInFrames}>`
   - Inside each `<SegmentScene>`:
     - `<Img>` with motion transform + optional filter
     - `<DustOverlay>` (per-segment, respects `segment.dust?.enabled`)
     - `<LogoOverlay>` (per-segment, respects `segment.logo?.enabled`)
5. **Outro Sequence**: Dark background `#11100e` with centered gold text

### Timing Math
- `from = max(0, round(segment.startTime * fps))`
- `durationInFrames = max(1, round((segment.endTime - segment.startTime) * fps))`
- `outroStartFrame = max(0, round(latestEnd * fps))`
- `outroFrames = max(1, round((outro.durationSeconds ?? 2) * fps))`
- `totalFrames = outroStartFrame + (outro.enabled === false ? 0 : outroFrames)`

---

## Render Pipeline (`scripts/render-video.js`)

### Two Paths
1. **Editor project path** (primary): Reads `editor-project.json` → `deriveRenderPropsFromEditorProject()` → writes `render-props.json` → spawns Remotion CLI
2. **Legacy timeline path** (fallback): Reads `output/timeline.json` → resolves audio/images → writes `render-props.json` → spawns Remotion CLI

### Render Profiles
- `--profile=preview`: 1280×720, output `video-preview.mp4`, phase → `preview_ready`
- `--profile=final` (default): 1920×1080, output `video-final.mp4`, phase → `done`

### Remotion CLI Invocation
```
node remotion-cli.js render MyComp output/video-{profile}.mp4 \
  --codec=h264 \
  --frames-per-second=30 \
  --width={1280|1920} \
  --height={720|1080} \
  --public-dir={projectRoot}/public \
  --props={projectRoot}/output/render-props.json
```

### Test Flags
- `REMOTION_EDITOR_MOCK_RENDER_SUCCESS=1`: writes mock mp4, skips real render
- `REMOTION_EDITOR_FORCE_RENDER_FAILURE=1`: simulates failure for diagnostics
- `--dry-run`: validates props without rendering

---

## Data Contract (`render-props.json`)

### Schema Version 2 (`renderPropsV2Schema`)
```json
{
  "schemaVersion": 2,
  "fps": 30,
  "audio": {
    "voiceSrc": "generated/audio-48khz.wav",
    "musicSrc": "generated/music.wav",
    "voice": { "volume": 1 },
    "music": {
      "volume": 0.15,
      "loop": true,
      "fadeInSeconds": 0.5,
      "fadeOutSeconds": 1
    }
  },
  "segments": [
    {
      "rowId": "row-1",
      "id": 1,
      "phrase": "Intro text",
      "image": "generated/images/intro.jpg",
      "startTime": 0,
      "endTime": 2.5,
      "requestedImage": "imagenes/intro.jpg",
      "imageStrategy": "local",
      "motion": "slow-zoom-in",
      "dust": { "enabled": false },
      "logo": { "enabled": true },
      "filter": { "enabled": true, "mode": "cover" },
      "transition": "none",
      "sfx": null,
      "caption": "Intro text",
      "startFrame": 0,
      "durationInFrames": 75
    }
  ],
  "globalLayers": { "logoAssetId": "...", "dustDefault": false, "filterDefault": true },
  "logo": {
    "src": "generated/overlays/logo-demo-alpha.webm",
    "enabled": true,
    "placeholder": false,
    "label": "LOGO"
  },
  "overlays": {
    "dust": {
      "src": "generated/overlays/particle-1.mp4",
      "opacity": 0.36,
      "blendMode": "screen"
    }
  },
  "outro": {
    "enabled": true,
    "durationSeconds": 2,
    "label": "Gracias por mirar"
  }
}
```

### Legacy Schema V1
```json
{ "audioSrc": "generated/audio.wav", "segments": [...] }
```
Union type: `renderPropsSchema = z.union([renderPropsV2Schema, legacyRenderPropsSchema])`

---

## Preview vs Final Render

| Aspect | Preview | Final |
|--------|---------|-------|
| Resolution | 1280×720 | 1920×1080 |
| Output file | `video-preview.mp4` | `video-final.mp4` |
| Phase after | `preview_ready` | `done` |
| CLI flag | `--profile=preview` | `--profile=final` (default) |

Both use identical composition logic, props, and codec (h264). Only resolution differs.

---

## Motion/Zoom Implementation

### In `SegmentScene` (Composition.tsx, lines 192-196)
```typescript
const scaleTo = segment.motion === "still" ? 1 
  : segment.motion === "slow-zoom" ? 1.04 
  : 1.08; // default for "slow-zoom-in", "ken-burns", etc.

const scale = interpolate(frame, [0, durationInFrames], [1, scaleTo], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});
```

### Behavior
- **"still"**: `scale` stays at 1.0 (no zoom)
- **"slow-zoom"**: linear interpolation from 1.0 → 1.04 over segment duration
- **"slow-zoom-in" / "ken-burns" / default**: linear interpolation from 1.0 → 1.08

### Applied to Image
```typescript
<Img style={{
  transform: `scale(${scale})`,
  filter: segment.filter?.enabled === false ? "none" : "contrast(1.06) saturate(0.92)",
}} />
```

**No pan-left/pan-right implementation exists.** The editor UI shows motion options but only zoom is implemented. The `motion` field is a string that maps to zoom behavior only.

---

## Overlay Implementation

### Dust Overlay (`DustOverlay` component)
- **With video source** (`overlays.dust.src`):
  - `<OffthreadVideo>` with `muted`, `startFrom={absoluteStartFrame}`
  - Style: `mixBlendMode: layer.blendMode ?? "screen"`, `opacity: layer.opacity ?? 0.36`
  - `objectFit: "cover"`, full width/height
- **Without video source** (fallback):
  - CSS radial-gradient pattern simulating dust particles
  - `mixBlendMode: "screen"`, `opacity: 0.28`
- **Per-segment control**: `segment.dust?.enabled !== false` → renders dust
- **Bundled overlays** in `assets/overlays/`: `particle-1.mp4`, `particle-2.mp4`

### Logo Overlay (`LogoOverlay` component)
- **Position**: `left: 52, top: 38` (absolute)
- **Size**: `width: 220, height: 124`
- **Opacity**: 0.94
- **Shadow**: `drop-shadow(0 10px 24px rgba(0,0,0,0.55))`
- **With video source** (`logo.src` ending in .mp4/.webm/.mov/.m4v):
  - `<OffthreadVideo>` muted, `startFrom={absoluteStartFrame}`
- **With image source**:
  - `<Img src={staticFile(logo.src)}>` with `objectFit: "contain"`
- **Placeholder** (no src, `placeholder !== false`):
  - Bordered pill with "LOGO" text
  - Position: `left: 56, top: 44` (slightly offset)
- **Per-segment control**: `segment.logo?.enabled !== false` → renders logo
- **Bundled**: `assets/overlays/logo-demo-alpha.webm` (video with alpha), `logo-green.mp4`

### Filter
- Default: `contrast(1.06) saturate(0.92)` applied to every segment image
- Disabled when `segment.filter?.enabled === false`

---

## Audio Implementation

### Voice
- Source: `audio.voiceSrc || audioSrc` (legacy fallback)
- Volume: `audio.voice.volume ?? 1`
- Volume is a static function: `volume={() => audio?.voice?.volume ?? 1}` (never changes)
- Muted when editor project has `audio.voice.muted = true` → volume becomes 0

### Music
- Source: `audio.musicSrc`
- Default volume: `audio.music.volume ?? 0.16`
- Loop: `audio.music.loop ?? true`
- Fade in: `audio.music.fadeInSeconds ?? 0`
- Fade out: `audio.music.fadeOutSeconds ?? 0`

### Fade Algorithm (`getFadedMusicVolume`)
```
fadeInMultiplier = fadeInFrames > 0 ? min(1, frame / fadeInFrames) : 1
remainingFrames = max(0, totalFrames - frame)
fadeOutMultiplier = fadeOutFrames > 0 ? min(1, remainingFrames / fadeOutFrames) : 1
volume = baseVolume * min(fadeInMultiplier, fadeOutMultiplier)
```
Linear fade, not eased. Both fades computed independently, takes minimum.

### Muting
In `deriveRenderPropsFromEditorProject`:
- Voice muted → `volume: 0`
- Music muted → `volume: 0`

---

## Test Infrastructure

### Test Files (16 total)
| File | Purpose |
|------|---------|
| `tests/editor-project.test.js` | createEditorProject, validateEditorProject, prepare-editor-project CLI |
| `tests/editor-contracts.test.js` | Schema validation, deriveRenderProps, render dry-run, mock render, timing helpers |
| `tests/pipeline-smoke.test.js` | Full pipeline integration: process→align→generate→fix→verify→render dry-run |
| `tests/timeline-utils.test.js` | Timeline normalization, validation, canonical timeline |
| `tests/editor-state.test.js` | Editor state reducer |
| `tests/app-view-model.test.js` | App view model (preview, timeline, gates) |
| `tests/api-client.test.js` | API client |
| `tests/local-editor-api.test.js` | Local editor API server |
| `tests/local-project-store.test.js` | Project store |
| `tests/action-gates.test.js` | Action gate logic |
| `tests/json-contracts.test.js` | JSON contract validation |
| `tests/image-selection.test.js` | Image selection logic |
| `tests/image-search-provider.test.js` | Image search provider |
| `tests/guion-parsing.test.js` | Guion parsing |
| `tests/phrase-alignment.test.js` | Phrase alignment |
| `tests/audio-normalization.test.js` | Audio normalization |

### Test Runner
- `node --test tests` (Node.js built-in test runner)
- No Jest, no Vitest, no external test framework

### Mock Patterns
- `REMOTION_EDITOR_MOCK_RENDER_SUCCESS=1` env var for render tests
- `REMOTION_EDITOR_FORCE_RENDER_FAILURE=1` for error path tests
- Temp directories via `fs.mkdtempSync` for isolation
- Silent WAV buffer construction for audio fixtures

---

## What Browser Preview Needs to Replicate

### Must-Have (Visual Fidelity)
1. **Segment sequencing**: Each segment displayed for `[startTime, endTime]` range
2. **Image rendering**: `<img>` with `objectFit: cover`, full bleed
3. **Motion zoom**: Linear scale interpolation 1.0 → scaleTo over segment duration
4. **Default filter**: `contrast(1.06) saturate(0.92)` on images (unless disabled)
5. **Dust overlay**: Either video overlay with screen blend + opacity, or CSS gradient fallback
6. **Logo overlay**: Positioned top-left, 220×124, with drop shadow
7. **Outro**: Dark background with centered gold text after last segment

### Must-Have (Audio)
8. **Voice playback**: Synced to timeline
9. **Music playback**: With volume, fade-in/fade-out, loop
10. **Mute controls**: Voice and music independently mutable

### Must-Have (Timing)
11. **Frame-accurate timing**: 30fps, same `round(startTime * fps)` math
12. **Gapless segments**: endTime of N = startTime of N+1
13. **Outro timing**: Starts at `latestEnd`, duration from `outro.durationSeconds`

### Nice-to-Have
14. **Scrubbing/seeking**: Jump to specific time
15. **Current segment highlight**: Show which segment is active
16. **Playback controls**: Play/pause, timeline scrubber

### Out of Scope (for now)
- Caption/subtitle rendering (not implemented in Remotion either)
- Transition effects (field exists but not implemented)
- Pan-left/pan-right motion (not implemented)
- SFX (field exists but not implemented)

---

## Files Inspected

| File | What It Does |
|------|--------------|
| `src/Composition.tsx` | Main Remotion composition: segments, overlays, audio, motion |
| `src/Root.tsx` | Remotion root registration, composition metadata |
| `src/index.ts` | Entry point, registerRoot |
| `scripts/render-video.js` | Render CLI orchestration, props derivation, Remotion spawn |
| `scripts/lib/editor-project.js` | Editor project CRUD, deriveRenderPropsFromEditorProject |
| `scripts/lib/schemas.js` | All Zod schemas: editorProject, renderPropsV2, timeline, etc. |
| `scripts/lib/media-utils.js` | Audio resolution, WAV duration parsing, image resolution |
| `scripts/lib/timeline-utils.js` | Timeline normalization, validation, frame math |
| `scripts/lib/json-contracts.js` | JSON read/write with schema validation |
| `src/editor/App.jsx` | Editor UI (React), preview shows single image only |
| `src/editor/appViewModel.mjs` | View model: preview state, timeline percentages, gates |
| `tests/editor-project.test.js` | Project creation/validation tests |
| `tests/editor-contracts.test.js` | Schema and render contract tests |
| `tests/pipeline-smoke.test.js` | Full pipeline integration tests |
| `tests/app-view-model.test.js` | View model tests |
| `remotion.config.ts` | Remotion config (jpeg image format, overwrite) |
| `package.json` | Dependencies and scripts |
| `assets/overlays/` | Bundled overlay files (particle-1.mp4, particle-2.mp4, logo-demo-alpha.webm, logo-green.mp4) |
| `openspec/specs/automatic-video-pipeline/spec.md` | Pipeline specification |
