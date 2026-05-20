const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { adaptCompositionContractToRenderProps } = require("../scripts/lib/composition-contract");
const { computeApprovalSnapshotHash } = require("../../03-Contracts-Core/approval-contract-pipeline");

function loadCompositionMotionResolver() {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");
  const start = source.indexOf("const resolveMotionRange = ");
  assert.notEqual(start, -1, "Composition.tsx must define resolveMotionRange");
  const end = source.indexOf(";\n\nconst DustOverlay", start);
  assert.notEqual(end, -1, "Composition.tsx motion resolver extraction boundary changed");
  const snippet = source
    .slice(start, end + 1)
    .replace(/\?: TimelineSegment\["motion"\] \| null/, "");
  return Function(`${snippet}; return resolveMotionRange;`)();
}

function loadPreviewMotionResolver() {
  const source = fs.readFileSync(
    path.join(__dirname, "../../01-Control-Panel/js/modules/features/video-projects/composition/renderer/frame-math.js"),
    "utf8",
  );
  const constantsStart = source.indexOf("const ZOOM_SLOW_IN = ");
  assert.notEqual(constantsStart, -1, "frame-math.js must define ZOOM_SLOW_IN");
  const constantsEnd = source.indexOf(";", constantsStart);
  assert.notEqual(constantsEnd, -1, "frame-math.js must define ZOOM_SLOW_IN boundary");
  const start = source.indexOf("export function resolveZoomRange", constantsEnd);
  assert.notEqual(start, -1, "frame-math.js must define resolveZoomRange");
  const end = source.indexOf("\n}\n\nfunction resolveComparableUrl", start);
  assert.notEqual(end, -1, "frame-math.js preview motion resolver extraction boundary changed");
  const constantsSnippet = source.slice(constantsStart, constantsEnd + 1);
  const functionSnippet = source.slice(start, end + 3).replace("export function resolveZoomRange", "function resolveZoomRange");
  return Function(`${constantsSnippet}${functionSnippet}; return resolveZoomRange;`)();
}

function normalizePreviewMotionRange(range) {
  return {
    fromScale: range.from,
    toScale: range.to,
    fromX: range.fromX,
    fromY: range.fromY,
    toX: range.toX,
    toY: range.toY,
  };
}

function makeFixture() {
  return {
    contract: {
      fps: 30,
      renderProfile: { fps: 30 },
      audio: {
        voiceAssetId: "voice-1",
        musicAssetId: "music-1",
        voice: { volume: 0.8, muted: false },
        music: { volume: 0.25, muted: false, loop: true, fadeInSeconds: 0.5, fadeOutSeconds: 1 },
      },
      segments: [
        {
          rowId: "row-1",
          phrase: "Hola",
          startTime: 0,
          endTime: 1,
          effectiveEndTime: 1.3,
          selectedAssetId: "img-1",
          motion: "slow-zoom-in",
          dust: { enabled: true },
          logo: { enabled: true },
          filter: { enabled: true, mode: "cover" },
          transition: "none",
        },
      ],
      globalLayers: { logoAssetId: "logo-1", dustDefault: true, filterDefault: true },
      outro: { enabled: true, durationSeconds: 2, label: "Gracias por mirar" },
    },
    manifest: {
      version: 1,
      assets: {
        "img-1": { renderPath: "generated/images/uno.jpg", status: "ready" },
        "voice-1": { renderPath: "generated/audio/voice.wav", status: "ready" },
        "music-1": { renderPath: "generated/audio/music.wav", status: "ready" },
        "logo-1": { renderPath: "generated/logo.png", status: "ready" },
      },
    },
  };
}

test("adapter maps contract + manifest to renderPropsV2 shape", () => {
  const { contract, manifest } = makeFixture();

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.schemaVersion, 2);
  assert.equal(props.audio.voiceSrc, "generated/audio/voice.wav");
  assert.equal(props.audio.musicSrc, "generated/audio/music.wav");
  assert.equal(props.audio.voice.volume, 0.8);
  assert.equal(props.audio.music.volume, 0.25);
  assert.equal(props.segments[0].image, "generated/images/uno.jpg");
  assert.equal(props.logo.src, "generated/logo.png");
  assert.equal(props.outro.enabled, true);
});

test("adapter throws useful error when referenced asset is missing", () => {
  const { contract, manifest } = makeFixture();
  delete manifest.assets["img-1"];

  assert.throws(
    () => adaptCompositionContractToRenderProps({ contract, manifest }),
    /missing.*img-1/i,
  );
});

test("adapter uses effectiveEndTime for segment render end", () => {
  const { contract, manifest } = makeFixture();
  contract.segments[0].endTime = 1;
  contract.segments[0].effectiveEndTime = 1.75;

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].endTime, 1.75);
});

test("adapter maps mute controls to zero volume semantics", () => {
  const { contract, manifest } = makeFixture();
  contract.audio.voice.muted = true;
  contract.audio.music.muted = true;

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.audio.voice.volume, 0);
  assert.equal(props.audio.music.volume, 0);
});

test("adapter preserves final render fidelity contract for audio sync, alpha logo, dust, motion, and segment duration", () => {
  for (const { dustAssetId, dustRenderPath, logoRenderPath } of [
    { dustAssetId: "particle-1", dustRenderPath: "overlays/particle-1.mp4", logoRenderPath: "overlays/logo-demo-co-alpha-frames" },
    { dustAssetId: "particle-2", dustRenderPath: "overlays/particle-2.mp4", logoRenderPath: "overlays/logo-ecuador-alpha-frames" },
  ]) {
    const snapshot = {
      contractVersion: "approval-editor-service-v1",
      snapshotHash: `hash-${dustAssetId}`,
      fps: 30,
      audio: {
        totalDurationSeconds: 7.25,
        voice: { assetId: "voice-1", volume: 0.82, muted: false },
        music: { assetId: "music-1", volume: 0.18, muted: false, loop: true, fadeInSeconds: 0.3, fadeOutSeconds: 1.1 },
      },
      globalLayers: {
        logo: { enabled: true, assetId: "brand-logo" },
        logoAssetId: "brand-logo",
        outro: { enabled: true, assetId: "brand-outro" },
        outroAssetId: "brand-outro",
      },
      assets: {
        "image-1": { assetId: "image-1", type: "image", renderPath: "generated/images/one.jpg", status: "ready" },
        "voice-1": { assetId: "voice-1", type: "audio", renderPath: "generated/audio/audio-48khz.wav", status: "ready" },
        "music-1": { assetId: "music-1", type: "music", renderPath: "generated/audio/music.wav", status: "ready" },
        "brand-logo": { assetId: "brand-logo", type: "logo", renderPath: logoRenderPath, status: "ready" },
        "brand-outro": { assetId: "brand-outro", type: "outro", renderPath: "overlays/final-demo-co.mp4", durationSeconds: 30.16, status: "ready" },
        [dustAssetId]: { assetId: dustAssetId, type: "overlay", renderPath: dustRenderPath, status: "ready" },
      },
      rows: [{
        rowId: "row-1",
        phrase: "Linea final",
        startTime: 0,
        endTime: 5,
        effectiveEndTime: 5,
        selectedAssetId: "image-1",
        motion: { fromX: -8, fromY: 3, toX: 8, toY: -3, fromScale: 1.02, toScale: 1.18, easing: "linear" },
        dust: { enabled: true, type: dustAssetId, opacity: 0.41, blendMode: "screen" },
        logo: { enabled: true },
        media: { kind: "image" },
      }],
    };

    const props = adaptCompositionContractToRenderProps({ contract: snapshot });

    assert.equal(props.audio.voiceSrc, "generated/audio/audio-48khz.wav");
    assert.equal(props.audio.musicSrc, "generated/audio/music.wav");
    assert.equal(props.audio.voice.volume, 0.82);
    assert.equal(props.audio.music.volume, 0.18);
    assert.equal(props.audio.music.fadeOutSeconds, 1.1);
    assert.equal(props.compositionDurationSeconds, 7.25);
    assert.equal(props.segments[0].endTime, 7.25);
    assert.deepEqual(props.segments[0].motion, snapshot.rows[0].motion);
    assert.equal(props.logo.src, logoRenderPath);
    assert.equal(props.logo.enabled, true);
    assert.equal(props.overlays.dust.src, dustRenderPath);
    assert.equal(props.overlays.dust.opacity, 0.41);
    assert.equal(props.outro.src, "overlays/final-demo-co.mp4");
    assert.equal(props.outro.durationSeconds, 30.16);
  }
});

test("adapter maps approval editor V1 canonical snapshot fields for final render", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-v1",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "particle-2": { assetId: "particle-2", renderPath: "overlays/particle-2.webm", status: "ready" },
      "logo-demo-alpha": { assetId: "logo-demo-alpha", renderPath: "logo-demo-alpha.webm", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 0.9, muted: false },
      music: { assetId: "music-1", volume: 0.12, muted: false, loop: true, fadeInSeconds: 0.25, fadeOutSeconds: 0.75 },
    },
    globalLayers: { logo: { enabled: true, assetId: "logo-demo-alpha", source: "logo-demo-alpha.webm" } },
    rows: [{
      rowId: "row-1",
      phrase: "Hola",
      caption: "Hola caption",
      startTime: 0,
      endTime: 1,
      effectiveEndTime: 1.5,
      selectedAssetId: "img-1",
      motionPresetId: "Zoom-125",
      motion: { fromX: 0, fromY: 0, toX: 0, toY: 0, fromScale: 1, toScale: 1.25, easing: "linear" },
      dust: { enabled: true, type: "particle-2", assetId: "particle-2", opacity: 0.4, blendMode: "screen" },
      logo: { enabled: true },
    }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.lastRenderedSnapshotHash, "hash-v1");
  assert.equal(props.segments[0].image, "imagenes/uno.jpg");
  assert.deepEqual(props.segments[0].motion, snapshot.rows[0].motion);
  assert.equal(props.overlays.dust.src, "overlays/particle-2.webm");
  assert.equal(props.logo.src, "logo-demo-alpha.webm");
  assert.equal(props.audio.voiceSrc, "audio/voice.wav");
  assert.equal(props.audio.music.fadeOutSeconds, 0.75);
});

test("adapter maps channel logo and outro render assets from safe overlay paths", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-brand",
    brandChannel: "golazo-colombia",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-logo-demo-co": { assetId: "brand-logo-demo-co", type: "logo", renderPath: "overlays/logo-demo-co.mp4", status: "ready" },
      "brand-outro-colombia": { assetId: "brand-outro-colombia", type: "outro", renderPath: "overlays/final-demo-co.mp4", durationSeconds: 3.5, status: "ready" },
    },
    audio: {
      totalDurationSeconds: 6,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    globalLayers: {
      logo: { enabled: true, assetId: "brand-logo-demo-co", source: "logo-demo-co.webm" },
      logoAssetId: "brand-logo-demo-co",
      outro: { enabled: true, assetId: "brand-outro-colombia" },
      outroAssetId: "brand-outro-colombia",
    },
    rows: [{
      rowId: "row-1",
      phrase: "Hola",
      startTime: 0,
      endTime: 4,
      effectiveEndTime: 4,
      selectedAssetId: "img-1",
      media: { kind: "image" },
      logo: { enabled: true },
    }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.logo.src, "overlays/logo-demo-co.mp4");
  assert.equal(props.logo.enabled, true);
  assert.equal(props.outro.enabled, true);
  assert.equal(props.outro.src, "overlays/final-demo-co.mp4");
  assert.equal(props.outro.durationSeconds, 3.5);
  assert.equal(props.compositionDurationSeconds, 6);
});

test("adapter prefers channel outro asset duration over stale contract duration", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-stale-outro-duration",
    fps: 30,
    audio: {
      totalDurationSeconds: 50.26,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-outro-colombia": { assetId: "brand-outro-colombia", type: "outro", renderPath: "overlays/final-demo-co.mp4", durationSeconds: 30.16, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-colombia", outro: { enabled: true, assetId: "brand-outro-colombia" } },
    outro: { enabled: true, durationSeconds: 3.56, label: "stale" },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 50.26, effectiveEndTime: 50.26, selectedAssetId: "img-1", media: { kind: "image" } }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 50.26);
  assert.equal(props.outro.durationSeconds, 30.16);
  assert.equal(props.outro.src, "overlays/final-demo-co.mp4");
});

test("adapter rejects unsafe channel overlay render paths with diagnostics", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-unsafe",
    brandChannel: "golazo-colombia",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-logo-demo-co": { assetId: "brand-logo-demo-co", type: "logo", renderPath: "../secret/logo.mp4", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    globalLayers: { logoAssetId: "brand-logo-demo-co", logo: { enabled: true, assetId: "brand-logo-demo-co" } },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 1, effectiveEndTime: 1, selectedAssetId: "img-1", media: { kind: "image" } }],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  assert.throws(
    () => adaptCompositionContractToRenderProps({ contract: snapshot }),
    /unsafe.*global\.logo/i,
  );
});

test("adapter passes optional image dimensions from asset metadata to render segments", () => {
  const { contract, manifest } = makeFixture();
  manifest.assets["img-1"].width = 4000;
  manifest.assets["img-1"].height = 2000;

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, 4000);
  assert.equal(props.segments[0].imageHeight, 2000);
});

test("adapter omits image dimensions when asset metadata is unavailable", () => {
  const { contract, manifest } = makeFixture();

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, undefined);
  assert.equal(props.segments[0].imageHeight, undefined);
});

test("Remotion motion resolver keeps string preset parity with preview", () => {
  const resolveMotionRange = loadCompositionMotionResolver();
  const resolvePreviewMotionRange = loadPreviewMotionResolver();

  for (const preset of [
    "still",
    "none",
    "slow-zoom",
    "slow-zoom-in",
    "slow-zoom-out",
    "pan-left",
    "pan-right",
    "unknown-motion",
  ]) {
    assert.deepEqual(
      resolveMotionRange(preset),
      normalizePreviewMotionRange(resolvePreviewMotionRange(preset)),
      `Expected Remotion motion preset ${preset} to match preview semantics`,
    );
  }
});

test("adapter preserves image selectedAssetId while mapping explicit video segment media", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-v1",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "video-1": { assetId: "video-1", renderPath: "videos/source.mp4", status: "ready" },
      "overlay-layer-01": { assetId: "overlay-layer-01", renderPath: "overlays/overlay-layer-01.mp4", status: "ready" },
      "overlay-layer-02": { assetId: "overlay-layer-02", renderPath: "overlays/overlay-layer-02.mp4", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    rows: [{
      rowId: "row-1",
      phrase: "Hola",
      startTime: 0,
      endTime: 2.5,
      effectiveEndTime: 2.5,
      selectedAssetId: "img-1",
      media: {
        kind: "video-segment",
        sourceVideoAssetId: "video-1",
        sourceInSeconds: 4,
        durationSeconds: 2.5,
        overlayColor: "#3835AF",
        overlayOpacity: 0.3,
        effect1AssetId: "overlay-layer-01",
        effect2AssetId: "overlay-layer-02",
      },
    }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(snapshot.rows[0].selectedAssetId, "img-1");
  assert.equal(props.segments[0].image, "imagenes/uno.jpg");
  assert.deepEqual(props.segments[0].media, {
    kind: "video-segment",
    sourceVideoSrc: "videos/source.mp4",
    sourceInSeconds: 4,
    durationSeconds: 2.5,
    sourceOutSeconds: 6.5,
    overlayColor: "#3835AF",
    overlayOpacity: 0.3,
    effect1Src: "overlays/overlay-layer-01.mp4",
    effect1BlendMode: "screen",
    effect2Src: "overlays/overlay-layer-02.mp4",
    effect2BlendMode: "multiply",
  });
});

test("adapter preserves newspaper media mode as an image-driven render segment", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-newspaper",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    rows: [{
      rowId: "row-news",
      phrase: "Recreación",
      startTime: 0,
      endTime: 3,
      effectiveEndTime: 3,
      selectedAssetId: "img-1",
      mediaMode: "newspaper",
      media: { kind: "image" },
    }],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.segments[0].mediaMode, "newspaper");
  assert.equal(props.segments[0].image, "imagenes/uno.jpg");
  assert.equal(props.segments[0].media.kind, "image");
  assert.deepEqual(props.segments[0].motion, { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0, easing: "linear" });
});

test("stable approval snapshot hash ignores video-segment key order", () => {
  const base = {
    contractVersion: "approval-editor-service-v1",
    projectId: "video-demo",
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "video-1": { assetId: "video-1", renderPath: "videos/source.mp4", status: "ready" },
    },
    rows: [{
      rowId: "row-1",
      selectedAssetId: "img-1",
      startTime: 0,
      endTime: 2,
      media: { kind: "video-segment", sourceVideoAssetId: "video-1", sourceInSeconds: 1, durationSeconds: 2 },
    }],
  };
  const reordered = {
    rows: [{
      media: { durationSeconds: 2, sourceInSeconds: 1, sourceVideoAssetId: "video-1", kind: "video-segment" },
      endTime: 2,
      startTime: 0,
      selectedAssetId: "img-1",
      rowId: "row-1",
    }],
    assets: {
      "video-1": { status: "ready", renderPath: "videos/source.mp4", assetId: "video-1" },
      "img-1": { status: "ready", renderPath: "imagenes/uno.jpg", assetId: "img-1" },
    },
    projectId: "video-demo",
    contractVersion: "approval-editor-service-v1",
  };

  assert.equal(computeApprovalSnapshotHash(base), computeApprovalSnapshotHash(reordered));
  assert.equal(base.rows[0].selectedAssetId, "img-1");
});

test("adapter maps video-segment render props with gapless timeline through full audio duration", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-v1",
    fps: 30,
    totalDurationSeconds: 5.25,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "img-2": { assetId: "img-2", renderPath: "imagenes/dos.jpg", status: "ready" },
      "video-1": { assetId: "video-1", renderPath: "videos/source.mp4", status: "ready" },
      "overlay-layer-01": { assetId: "overlay-layer-01", renderPath: "overlays/overlay-layer-01.mp4", status: "ready" },
      "overlay-layer-02": { assetId: "overlay-layer-02", renderPath: "overlays/overlay-layer-02.mp4", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    rows: [
      {
        rowId: "row-1",
        phrase: "Hola",
        startTime: 0,
        endTime: 2.25,
        effectiveEndTime: 2.25,
        selectedAssetId: "img-1",
        media: {
          kind: "video-segment",
          sourceVideoAssetId: "video-1",
          sourceInSeconds: 7.5,
          durationSeconds: 2.25,
          overlayColor: "#3835AF",
          overlayOpacity: 0.3,
          effect1AssetId: "overlay-layer-01",
          effect2AssetId: "overlay-layer-02",
        },
      },
      {
        rowId: "row-2",
        phrase: "Mundo",
        startTime: 2.25,
        endTime: 5.25,
        effectiveEndTime: 5.25,
        selectedAssetId: "img-2",
        media: { kind: "image" },
      },
    ],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 5.25);
  assert.deepEqual(
    props.segments.map((segment) => [segment.startTime, segment.endTime]),
    [[0, 2.25], [2.25, 5.25]],
  );
  assert.equal(props.segments[1].endTime, props.compositionDurationSeconds);
  assert.deepEqual(props.segments[0].media, {
    kind: "video-segment",
    sourceVideoSrc: "videos/source.mp4",
    sourceInSeconds: 7.5,
    durationSeconds: 2.25,
    sourceOutSeconds: 9.75,
    overlayColor: "#3835AF",
    overlayOpacity: 0.3,
    effect1Src: "overlays/overlay-layer-01.mp4",
    effect1BlendMode: "screen",
    effect2Src: "overlays/overlay-layer-02.mp4",
    effect2BlendMode: "multiply",
  });
});

test("adapter keeps composition duration aligned when audio is longer than visual rows", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-v1",
    fps: 30,
    audio: {
      totalDurationSeconds: 6,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    rows: [{
      rowId: "row-1",
      phrase: "Hola",
      startTime: 0,
      endTime: 4.5,
      effectiveEndTime: 4.5,
      selectedAssetId: "img-1",
      media: { kind: "image" },
    }],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.segments[0].endTime, 6);
  assert.equal(props.compositionDurationSeconds, 6);
});

test("adapter uses actual channel outro asset duration and starts it after official audio duration", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-full-outro",
    fps: 30,
    audio: {
      totalDurationSeconds: 10,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/audio-48khz.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-outro-colombia": { assetId: "brand-outro-colombia", type: "outro", renderPath: "overlays/final-demo-co.mp4", durationSeconds: 30.16, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-colombia", outro: { enabled: true, assetId: "brand-outro-colombia" } },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 4.5, effectiveEndTime: 4.5, selectedAssetId: "img-1", media: { kind: "image" } }],
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 10);
  assert.equal(props.segments[0].endTime, 10);
  assert.equal(props.outro.durationSeconds, 30.16);
  assert.match(source, /outroStartFrame = Math\.max\(0, Math\.round\(compositionEnd \* fps\)\)/);
});

test("adapter and metadata include full audio duration plus deterministic channel outro timing", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-outro-duration",
    fps: 30,
    audio: {
      totalDurationSeconds: 6,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-outro-ecuador": { assetId: "brand-outro-ecuador", type: "outro", renderPath: "overlays/final-demo-ec.mp4", durationSeconds: 4, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-ecuador", outro: { enabled: true, assetId: "brand-outro-ecuador" } },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 4.5, effectiveEndTime: 4.5, selectedAssetId: "img-1", media: { kind: "image" } }],
  };
  const rootSource = fs.readFileSync(path.join(__dirname, "../src/remotion/Root.tsx"), "utf8");

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 6);
  assert.equal(props.outro.src, "overlays/final-demo-ec.mp4");
  assert.equal(props.outro.durationSeconds, 4);
  assert.match(rootSource, /compositionDurationSeconds \+ outroSeconds/);
});

test("Remotion country outro video keeps embedded audio while music spans final composition", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");
  const offthreadVideoTags = Array.from(source.matchAll(/<OffthreadVideo\b([\s\S]*?)\/>/g), (match) => match[1]);
  const outroVideoSource = offthreadVideoTags.find((tag) => tag.includes('data-layer="channel-outro-video"'));
  const effectLayerOneSource = source.match(/data-layer="overlay-layer-01"[\s\S]*?<OffthreadVideo([\s\S]*?)\/>/);
  const effectLayerTwoSource = source.match(/data-layer="overlay-layer-02"[\s\S]*?<OffthreadVideo([\s\S]*?)\/>/);
  const foregroundVideoSource = offthreadVideoTags.find((tag) => tag.includes('data-layer="foreground-video"'));

  assert.ok(outroVideoSource, "country outro must render an OffthreadVideo layer");
  assert.doesNotMatch(outroVideoSource, /\bmuted\b/, "country outro must not force-mute embedded audio");
  assert.match(source, /outroStartFrame = Math\.max\(0, Math\.round\(compositionEnd \* fps\)\)/);
  assert.match(source, /totalFrames[\s\S]*outroStartFrame \+ \(outro\?\.enabled === false \? 0 : outroFrames\)/);
  assert.match(source, /getFadedMusicVolume\([\s\S]*totalFrames,/);
  assert.match(effectLayerOneSource?.[1] || "", /\bmuted\b/, "effect layer 01 must remain muted");
  assert.match(effectLayerTwoSource?.[1] || "", /\bmuted\b/, "effect layer 02 must remain muted");
  assert.match(foregroundVideoSource || "", /\bmuted\b/, "foreground segment video must remain muted");
});

test("Remotion final image and overlay source keeps preview fidelity rules", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");

  assert.match(source, /objectFit: "cover",\n\s*filter: segment\.filter/, "image render must preserve aspect ratio like preview, not stretch with object-fit fill");
  assert.match(source, /<DustOverlay layer=\{dustLayer\} startFrom=\{0\} \/>/, "dust video must start from local segment time so it remains visible on later rows");
  assert.match(source, /<LogoOverlay logo=\{logo\} startFrom=\{0\} \/>/, "logo video must start from local segment time so it remains visible on later rows");
  assert.doesNotMatch(source, /absoluteStartFrame/, "final render should not trim reusable overlay videos by absolute row time inside segment sequences");
  assert.match(source, /data-layer="green-screen-logo-video"/, "green-screen brand logo must use the full-frame logo render path instead of shrinking the whole video into a small badge box");
  assert.match(source, /isGreenScreenLogoSource/, "green-screen logo sources must have an explicit render branch");
  assert.match(source, /logo-demo-co\(\?:-keyed\)\?/, "keyed Colombia logo must use the full-frame branch instead of badge sizing");
  assert.match(source, /data-layer="alpha-logo-frame-sequence"/, "alpha PNG logo frame sequence must render full-frame with real transparency");
  assert.match(source, /logo-\(\?:colombia\|ecuador\)-alpha-frames/, "both country logos must support alpha PNG frame sequences");
  assert.match(source, /logoFrameSequenceSrc\(logo\.src, frame\)/, "alpha logo frame sequence must advance by Remotion frame");
});

test("Remotion composition source contains newspaper visual mode parity branch", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");

  assert.match(source, /mediaMode\?: "image" \| "newspaper"/);
  assert.match(source, /const NewspaperScene = /);
  assert.match(source, /data-layer="newspaper-background"/);
  assert.match(source, /filter: "blur\(20px\)"/);
  assert.match(source, /objectPosition: "center top"/);
  assert.match(source, /toScale:\s*1\.25/);
  assert.match(source, /RECREACIÓN/);
  assert.match(source, /ARTÍSTICA/);
});

test("Remotion composition source contains deterministic five-layer VideoSegmentScene", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");
  const rootSource = fs.readFileSync(path.join(__dirname, "../src/remotion/Root.tsx"), "utf8");

  assert.match(source, /type VideoSegmentMedia = \{/);
  assert.match(source, /const VideoSegmentScene = /);
  assert.match(source, /startFrom=\{Math\.round\(media\.sourceInSeconds \* fps\)\}/);
  assert.match(source, /durationInFrames=\{durationInFrames\}/);
  assert.match(source, /background-video/);
  assert.match(source, /color-overlay/);
  assert.match(source, /overlay-layer-01/);
  assert.match(source, /overlay-layer-02/);
  assert.match(source, /foreground-video/);
  assert.match(source, /mixBlendMode: media\.effect1BlendMode \?\? "screen"/);
  assert.match(source, /mixBlendMode: media\.effect2BlendMode \?\? "multiply"/);
  assert.match(source, /backgroundColor: media\.overlayColor \?\? "#3835AF"/);
  assert.match(source, /opacity: media\.overlayOpacity \?\? 0\.3/);
  assert.match(rootSource, /compositionDurationSeconds/);
});

test("Remotion video-segment source stays lint and type compatible", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/remotion/Composition.tsx"), "utf8");
  const segmentSceneStart = source.indexOf("const SegmentScene = ");
  const segmentSceneEnd = source.indexOf(";\n\nexport const MyComposition", segmentSceneStart);
  assert.notEqual(segmentSceneStart, -1, "Composition.tsx must define SegmentScene");
  assert.notEqual(segmentSceneEnd, -1, "Composition.tsx SegmentScene extraction boundary changed");
  const segmentSceneSource = source.slice(segmentSceneStart, segmentSceneEnd);
  const frameHookIndex = segmentSceneSource.indexOf("const frame = useCurrentFrame();");
  const videoBranchIndex = segmentSceneSource.indexOf("segment.media?.kind === \"video-segment\"");
  const effectLayerOneSource = source.match(/data-layer="overlay-layer-01"[\s\S]*?<OffthreadVideo([\s\S]*?)\/>/);
  const effectLayerTwoSource = source.match(/data-layer="overlay-layer-02"[\s\S]*?<OffthreadVideo([\s\S]*?)\/>/);

  assert.notEqual(frameHookIndex, -1, "SegmentScene must read the current frame for image motion");
  assert.notEqual(videoBranchIndex, -1, "SegmentScene must keep the video-segment branch");
  assert.ok(
    frameHookIndex < videoBranchIndex,
    "useCurrentFrame must be called before the video-segment branch so hooks stay unconditional",
  );
  assert.doesNotMatch(source, /from=\{0\}/, "Sequence must omit default from={0}");
  assert.ok(effectLayerOneSource, "overlay-layer-01 must render an OffthreadVideo");
  assert.ok(effectLayerTwoSource, "overlay-layer-02 must render an OffthreadVideo");
  assert.doesNotMatch(effectLayerOneSource[1], /\bloop\b/, "overlay-layer-01 OffthreadVideo must not use unsupported loop prop");
  assert.doesNotMatch(effectLayerTwoSource[1], /\bloop\b/, "overlay-layer-02 OffthreadVideo must not use unsupported loop prop");
});
