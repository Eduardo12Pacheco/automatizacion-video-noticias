const test = require("node:test");
const assert = require("node:assert/strict");

const { adaptCompositionContractToRenderProps, buildWhipRenderEvents } = require("../scripts/lib/contracts/composition-contract");
const timing = require("../src/remotion/composition-timing");
const { computeApprovalSnapshotHash } = require("@newsroom/contracts/approval-contract-pipeline");


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

test("adapter passes row motion image and pan viewport metadata when asset dimensions are absent", () => {
  const { contract, manifest } = makeFixture();
  contract.segments[0].motion = {
    fromX: 0,
    fromY: 267,
    toX: 0,
    toY: 341,
    fromScale: 1,
    toScale: 1.27,
    imageWidth: 951,
    imageHeight: 1171,
    panViewportWidth: 950.53125,
    panViewportHeight: 533.796875,
  };
  delete manifest.assets["img-1"].imageWidth;
  delete manifest.assets["img-1"].imageHeight;

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, 951);
  assert.equal(props.segments[0].imageHeight, 1171);
  assert.equal(props.segments[0].panViewportWidth, 950.53125);
  assert.equal(props.segments[0].panViewportHeight, 533.796875);
});

test("adapter keeps manifest asset dimensions ahead of row motion image metadata", () => {
  const { contract, manifest } = makeFixture();
  manifest.assets["img-1"].imageWidth = 2400;
  manifest.assets["img-1"].imageHeight = 3200;
  contract.segments[0].motion = {
    fromX: 0,
    fromY: 267,
    toX: 0,
    toY: 341,
    fromScale: 1,
    toScale: 1.27,
    imageWidth: 951,
    imageHeight: 1171,
    panViewportWidth: 950.53125,
    panViewportHeight: 533.796875,
  };

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, 2400);
  assert.equal(props.segments[0].imageHeight, 3200);
  assert.equal(props.segments[0].panViewportWidth, 950.53125);
  assert.equal(props.segments[0].panViewportHeight, 533.796875);
});

test("adapter rejects manual image motion when rows 6 and 7 reach render without complete geometry", () => {
  const { contract, manifest } = makeFixture();
  contract.segments = Array.from({ length: 7 }, (_, index) => {
    const rowNumber = index + 1;
    const assetId = `img-${rowNumber}`;
    manifest.assets[assetId] = { renderPath: `generated/images/${assetId}.jpg`, status: "ready" };
    return {
      rowId: `seg-00${rowNumber}`,
      phrase: `Fila ${rowNumber}`,
      startTime: index,
      endTime: index + 1,
      effectiveEndTime: index + 1,
      selectedAssetId: assetId,
      media: { kind: "image" },
      motion: rowNumber <= 5
        ? { fromX: 0, fromY: rowNumber * 10, toX: 0, toY: rowNumber * 12, fromScale: 1, toScale: 1.2, imageWidth: 900 + index, imageHeight: 1200 + index, panViewportWidth: 950.53125, panViewportHeight: 533.796875 }
        : { fromX: 0, fromY: rowNumber * 10, toX: 0, toY: rowNumber * 12, fromScale: 1, toScale: 1.2 },
    };
  });

  assert.throws(
    () => adaptCompositionContractToRenderProps({ contract, manifest }),
    /geometry.*seg-006, seg-007/i,
  );
});

test("adapter maps active outgoing-row Whip boundaries to render overlay and SFX events without changing duration", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-whip-active",
    fps: 30,
    audio: {
      totalDurationSeconds: 3,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "img-2": { assetId: "img-2", renderPath: "imagenes/dos.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    rows: [
      {
        rowId: "row-1",
        phrase: "Hola",
        startTime: 0,
        endTime: 1.5,
        effectiveEndTime: 1.5,
        selectedAssetId: "img-1",
        paragraphBoundaryAfter: true,
        nextRowId: "row-2",
        transition: "whip",
        transitionConfig: { type: "whip", durationSeconds: 0.5, direction: "left-to-right" },
        sfx: { type: "whip", assetId: "whip", src: "sfx/sound-demo.wav" },
        media: { kind: "image" },
      },
      {
        rowId: "row-2",
        phrase: "Mundo",
        startTime: 1.5,
        endTime: 3,
        effectiveEndTime: 3,
        selectedAssetId: "img-2",
        media: { kind: "image" },
      },
    ],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 5);
  assert.deepEqual(
    props.segments.map((segment) => [segment.rowId, segment.startTime, segment.endTime]),
    [["row-1", 0, 1.5], ["row-2", 1.5, 5]],
  );
  assert.equal(props.segments[0].sfx, "whip");
  assert.deepEqual(props.whipTransitions, [
    {
      id: "row-1->row-2:whip:1.5",
      type: "whip",
      rowId: "row-1",
      nextRowId: "row-2",
      cutTime: 1.5,
      startTime: 1.285,
      durationSeconds: 0.43,
      startFrame: 39,
      cutFrame: 45,
      sfxStartTime: 1.285,
      sfxStartFrame: 39,
      durationInFrames: 13,
      previousImage: "imagenes/uno.jpg",
      nextImage: "imagenes/dos.jpg",
      direction: "left-to-right",
      sfx: "whip",
      sfxSrc: "sfx/sound-demo.wav",
    },
  ]);
});

test("adapter leaves eligible inactive Whip metadata inert", () => {
  const rows = [
    { rowId: "row-1", startTime: 0, endTime: 1, paragraphBoundaryAfter: true, nextRowId: "row-2", transition: "none", sfx: "whip", image: "one.jpg" },
    { rowId: "row-2", startTime: 1, endTime: 2, image: "two.jpg" },
  ];

  assert.deepEqual(buildWhipRenderEvents(rows, { fps: 30 }), []);
});

test("adapter clamps Whip render duration to the preview-effective 0.43s window", () => {
  const events = buildWhipRenderEvents([
    {
      rowId: "row-1",
      startTime: 0,
      endTime: 1.5,
      paragraphBoundaryAfter: true,
      nextRowId: "row-2",
      transition: "whip",
      transitionConfig: { type: "whip", durationSeconds: 0.8, direction: "left-to-right" },
      image: "one.jpg",
    },
    { rowId: "row-2", startTime: 1.5, endTime: 3, image: "two.jpg" },
  ], { fps: 30 });

  assert.equal(events[0].durationSeconds, 0.43);
  assert.equal(events[0].startTime, 1.285);
  assert.equal(events[0].durationInFrames, 13);
});

test("adapter maps active Transition boundaries to overlay video render events with audio", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-transition-active",
    fps: 30,
    audio: {
      totalDurationSeconds: 3,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "img-2": { assetId: "img-2", renderPath: "imagenes/dos.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
    },
    rows: [
      {
        rowId: "row-1",
        phrase: "Hola",
        startTime: 0,
        endTime: 1.5,
        effectiveEndTime: 1.5,
        selectedAssetId: "img-1",
        paragraphBoundaryAfter: true,
        nextRowId: "row-2",
        transition: "transition-3",
        transitionConfig: { type: "overlay-video", assetId: "transition-3", src: "./assets/boundary-transitions/transition-3.mp4", renderPath: "overlays/transition-3.mp4", previewUrl: "./assets/boundary-transitions/transition-3.mp4", blendMode: "screen", durationSeconds: 1, audio: true },
        media: { kind: "image" },
      },
      { rowId: "row-2", phrase: "Mundo", startTime: 1.5, endTime: 3, effectiveEndTime: 3, selectedAssetId: "img-2", media: { kind: "image" } },
    ],
    outro: { enabled: false, durationSeconds: 0, label: "" },
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.deepEqual(props.whipTransitions, [
    {
      id: "row-1->row-2:transition-3:1.5",
      type: "overlay-video",
      rowId: "row-1",
      nextRowId: "row-2",
      cutTime: 1.5,
      startTime: 1,
      durationSeconds: 1,
      startFrame: 30,
      cutFrame: 45,
      sfxStartTime: 1,
      sfxStartFrame: 30,
      durationInFrames: 30,
      previousImage: "imagenes/uno.jpg",
      nextImage: "imagenes/dos.jpg",
      direction: "left-to-right",
      sfx: null,
      sfxSrc: null,
      assetId: "transition-3",
      src: "overlays/transition-3.mp4",
      blendMode: "screen",
      audio: true,
    },
  ]);
});

test("adapter throws useful error when referenced asset is missing", () => {
  const { contract, manifest } = makeFixture();
  delete manifest.assets["img-1"];

  assert.throws(
    () => adaptCompositionContractToRenderProps({ contract, manifest }),
    /missing.*img-1/i,
  );
});

test("adapter rejects out-of-order overlapping contract rows before final render props", () => {
  const { contract, manifest } = makeFixture();
  contract.segments = [
    { ...contract.segments[0], rowId: "seg-018", startTime: 97.7, endTime: 98.7, effectiveEndTime: 98.7, selectedAssetId: "img-1" },
    { ...contract.segments[0], rowId: "seg-019", startTime: 88.74, endTime: 93.64, effectiveEndTime: 93.64, selectedAssetId: "img-2" },
  ];
  manifest.assets["img-2"] = { renderPath: "generated/images/dos.jpg", status: "ready" };

  assert.throws(
    () => adaptCompositionContractToRenderProps({ contract, manifest }),
    /Invalid timeline:.*row seg-019 starts at 88\.74 before previous row seg-018 endTime 98\.7/is,
  );
});

test("adapter uses effectiveEndTime for segment render end", () => {
  const { contract, manifest } = makeFixture();
  contract.segments[0].endTime = 1;
  contract.segments[0].effectiveEndTime = 1.75;

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].endTime, 3.75);
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
    { dustAssetId: "particle-1", dustRenderPath: "overlays/particle-1.webm", logoRenderPath: "overlays/logo-secondary.webm" },
    { dustAssetId: "particle-2", dustRenderPath: "overlays/particle-2.webm", logoRenderPath: "overlays/logo-primary.webm" },
    { dustAssetId: "particle-3", dustRenderPath: "overlays/particle-3.webm", logoRenderPath: "overlays/logo-secondary.webm" },
    { dustAssetId: "particle-4", dustRenderPath: "overlays/particle-4.webm", logoRenderPath: "overlays/logo-primary.webm" },
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
        "brand-outro": { assetId: "brand-outro", type: "outro", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 30.16, status: "ready" },
        [dustAssetId]: { assetId: dustAssetId, type: "overlay", renderPath: dustRenderPath, status: "ready" },
      },
      rows: [{
        rowId: "row-1",
        phrase: "Linea final",
        startTime: 0,
        endTime: 5,
        effectiveEndTime: 5,
        selectedAssetId: "image-1",
        motion: { fromX: -8, fromY: 3, toX: 8, toY: -3, fromScale: 1.02, toScale: 1.18, easing: "linear", imageWidth: 2400, imageHeight: 3200, panViewportWidth: 950.53125, panViewportHeight: 533.796875 },
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
    assert.equal(props.compositionDurationSeconds, 9.25);
    assert.equal(props.segments[0].endTime, 9.25);
    assert.deepEqual(props.segments[0].motion, { fromX: -8, fromY: 3, toX: 8, toY: -3, fromScale: 1.02, toScale: 1.18, easing: "linear" });
    assert.equal(props.segments[0].imageWidth, 2400);
    assert.equal(props.segments[0].imageHeight, 3200);
    assert.equal(props.segments[0].panViewportWidth, 950.53125);
    assert.equal(props.segments[0].panViewportHeight, 533.796875);
    assert.equal(props.logo.src, logoRenderPath);
    assert.equal(props.logo.enabled, true);
    assert.equal(props.overlays.dust.src, dustRenderPath);
    assert.equal(props.overlays.dust.opacity, 0.41);
    assert.equal(props.outro.src, "overlays/outro-secondary.mp4");
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
      "logo-primary": { assetId: "logo-primary", renderPath: "logo-primary.webm", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 0.9, muted: false },
      music: { assetId: "music-1", volume: 0.12, muted: false, loop: true, fadeInSeconds: 0.25, fadeOutSeconds: 0.75 },
    },
    globalLayers: { logo: { enabled: true, assetId: "logo-primary", source: "logo-primary.webm" } },
    rows: [{
      rowId: "row-1",
      phrase: "Hola",
      caption: "Hola caption",
      startTime: 0,
      endTime: 1,
      effectiveEndTime: 1.5,
      selectedAssetId: "img-1",
      motionPresetId: "Zoom-125",
      motion: { fromX: 0, fromY: 0, toX: 0, toY: 0, fromScale: 1, toScale: 1.25, easing: "linear", imageWidth: 2400, imageHeight: 3200, panViewportWidth: 950.53125, panViewportHeight: 533.796875 },
      dust: { enabled: true, type: "particle-2", assetId: "particle-2", opacity: 0.4, blendMode: "screen" },
      logo: { enabled: true },
    }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.lastRenderedSnapshotHash, "hash-v1");
  assert.equal(props.segments[0].image, "imagenes/uno.jpg");
  assert.deepEqual(props.segments[0].motion, { fromX: 0, fromY: 0, toX: 0, toY: 0, fromScale: 1, toScale: 1.25, easing: "linear" });
  assert.equal(props.segments[0].imageWidth, 2400);
  assert.equal(props.segments[0].imageHeight, 3200);
  assert.equal(props.segments[0].panViewportWidth, 950.53125);
  assert.equal(props.segments[0].panViewportHeight, 533.796875);
  assert.equal(props.overlays.dust.src, "overlays/particle-2.webm");
  assert.equal(props.logo.src, "logo-primary.webm");
  assert.equal(props.audio.voiceSrc, "audio/voice.wav");
  assert.equal(props.audio.music.fadeOutSeconds, 0.75);
});

test("adapter maps channel logo and outro render assets from safe overlay paths", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-brand",
    brandChannel: "demo-secondary",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-logo-secondary": { assetId: "brand-logo-secondary", type: "logo", renderPath: "overlays/logo-secondary.mp4", status: "ready" },
      "brand-outro-secondary": { assetId: "brand-outro-secondary", type: "outro", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 3.5, status: "ready" },
    },
    audio: {
      totalDurationSeconds: 6,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    globalLayers: {
      logo: { enabled: true, assetId: "brand-logo-secondary", source: "logo-secondary.webm" },
      logoAssetId: "brand-logo-secondary",
      outro: { enabled: true, assetId: "brand-outro-secondary" },
      outroAssetId: "brand-outro-secondary",
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

  assert.equal(props.logo.src, "overlays/logo-secondary.mp4");
  assert.equal(props.logo.enabled, true);
  assert.equal(props.outro.enabled, true);
  assert.equal(props.outro.src, "overlays/outro-secondary.mp4");
  assert.equal(props.outro.durationSeconds, 3.5);
  assert.equal(props.compositionDurationSeconds, 8);
});

test("adapter maps demo-final static PNG logo and original outro render assets", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-brand-copa internacional",
    brandChannel: "demo-final",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-logo-final": { assetId: "brand-logo-final", type: "logo", renderPath: "overlays/logo-final.png", status: "ready" },
      "brand-outro-final": { assetId: "brand-outro-final", type: "outro", renderPath: "overlays/outro-final.mp4", durationSeconds: 30.12, status: "ready" },
    },
    audio: {
      totalDurationSeconds: 6,
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.8, muted: false },
    },
    globalLayers: {
      logo: { enabled: true, assetId: "brand-logo-final", source: "logo-final.png" },
      logoAssetId: "brand-logo-final",
      outro: { enabled: true, assetId: "brand-outro-final" },
      outroAssetId: "brand-outro-final",
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

  assert.equal(props.logo.src, "overlays/logo-final.png");
  assert.equal(props.logo.enabled, true);
  assert.equal(props.outro.enabled, true);
  assert.equal(props.outro.src, "overlays/outro-final.mp4");
  assert.equal(props.outro.durationSeconds, 30.12);
  assert.equal(props.compositionDurationSeconds, 8);
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
      "brand-outro-secondary": { assetId: "brand-outro-secondary", type: "outro", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 30.16, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-secondary", outro: { enabled: true, assetId: "brand-outro-secondary" } },
    outro: { enabled: true, durationSeconds: 3.56, label: "stale" },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 50.26, effectiveEndTime: 50.26, selectedAssetId: "img-1", media: { kind: "image" } }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 52.26);
  assert.equal(props.outro.durationSeconds, 30.16);
  assert.equal(props.outro.src, "overlays/outro-secondary.mp4");
});

test("adapter rejects unsafe channel overlay render paths with diagnostics", () => {
  const snapshot = {
    contractVersion: "approval-editor-service-v1",
    snapshotHash: "hash-unsafe",
    brandChannel: "demo-secondary",
    fps: 30,
    assets: {
      "img-1": { assetId: "img-1", renderPath: "imagenes/uno.jpg", status: "ready" },
      "voice-1": { assetId: "voice-1", renderPath: "audio/voice.wav", status: "ready" },
      "music-1": { assetId: "music-1", renderPath: "audio/music.wav", status: "ready" },
      "brand-logo-secondary": { assetId: "brand-logo-secondary", type: "logo", renderPath: "../secret/logo.mp4", status: "ready" },
    },
    audio: {
      voice: { assetId: "voice-1", volume: 1, muted: false },
      music: { assetId: "music-1", volume: 0.15, muted: false },
    },
    globalLayers: { logoAssetId: "brand-logo-secondary", logo: { enabled: true, assetId: "brand-logo-secondary" } },
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

test("adapter passes optional image dimensions from nested selected asset metadata", () => {
  const { contract, manifest } = makeFixture();
  manifest.assets["img-1"].metadata = { imageWidth: 2400, imageHeight: 3200 };

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, 2400);
  assert.equal(props.segments[0].imageHeight, 3200);
});

test("adapter omits image dimensions when asset metadata is unavailable", () => {
  const { contract, manifest } = makeFixture();

  const props = adaptCompositionContractToRenderProps({ contract, manifest });

  assert.equal(props.segments[0].imageWidth, undefined);
  assert.equal(props.segments[0].imageHeight, undefined);
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
    durationSeconds: 4.5,
    sourceOutSeconds: 8.5,
    overlayColor: "#3835AF",
    overlayOpacity: 0.3,
    effect1Src: "overlays/overlay-layer-01.mp4",
    effect1BlendMode: "screen",
    effect2Src: "overlays/overlay-layer-02.mp4",
    effect2BlendMode: "multiply",
  });
});

test("adapter passes video segment foreground transform through render media", () => {
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
      rowId: "row-video",
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
        foregroundTransform: { x: -42, y: 18, scale: 1.35 },
      },
    }],
  };

  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.deepEqual(props.segments[0].media.foregroundTransform, { x: -42, y: 18, scale: 1.35 });
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
  assert.deepEqual(props.segments[0].motion, { fromScale: 1, toScale: 1.1, fromX: 0, fromY: 0, toX: 0, toY: 0, easing: "linear" });
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

  assert.equal(props.compositionDurationSeconds, 7.25);
  assert.deepEqual(
    props.segments.map((segment) => [segment.startTime, segment.endTime]),
    [[0, 2.25], [2.25, 7.25]],
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

  assert.equal(props.segments[0].endTime, 8);
  assert.equal(props.compositionDurationSeconds, 8);
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
      "brand-outro-secondary": { assetId: "brand-outro-secondary", type: "outro", renderPath: "overlays/outro-secondary.mp4", durationSeconds: 30.16, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-secondary", outro: { enabled: true, assetId: "brand-outro-secondary" } },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 4.5, effectiveEndTime: 4.5, selectedAssetId: "img-1", media: { kind: "image" } }],
  };
  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 12);
  assert.equal(props.segments[0].endTime, 12);
  assert.equal(props.outro.durationSeconds, 30.16);
  const timeline = timing.resolveCompositionTimeline({
    segments: props.segments,
    fps: 30,
    outro: props.outro,
    compositionDurationSeconds: props.compositionDurationSeconds,
  });
  assert.equal(timeline.outroStartFrame, 360, "outro starts after the full official audio duration");
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
      "brand-outro-primary": { assetId: "brand-outro-primary", type: "outro", renderPath: "overlays/outro-primary.mp4", durationSeconds: 4, status: "ready" },
    },
    globalLayers: { outroAssetId: "brand-outro-primary", outro: { enabled: true, assetId: "brand-outro-primary" } },
    rows: [{ rowId: "row-1", phrase: "Hola", startTime: 0, endTime: 4.5, effectiveEndTime: 4.5, selectedAssetId: "img-1", media: { kind: "image" } }],
  };
  const props = adaptCompositionContractToRenderProps({ contract: snapshot });

  assert.equal(props.compositionDurationSeconds, 8);
  assert.equal(props.outro.src, "overlays/outro-primary.mp4");
  assert.equal(props.outro.durationSeconds, 4);
  assert.equal(timing.resolveRootDurationFrames({ props }).durationInFrames, 360, "root duration is composition plus outro");
});

test("composition timeline keeps the outro after the full audio duration and music spans it", () => {
  const segments = [
    { startTime: 0, endTime: 4.5 },
    { startTime: 4.5, endTime: 10 },
  ];

  assert.deepEqual(
    timing.resolveCompositionTimeline({ segments, fps: 30, outro: { durationSeconds: 2 } }),
    { latestEnd: 10, compositionEnd: 10, outroStartFrame: 300, outroFrames: 60, totalFrames: 360 },
  );
  assert.equal(
    timing.resolveCompositionTimeline({ segments, fps: 30, outro: { enabled: false, durationSeconds: 30 }, compositionDurationSeconds: 12 }).totalFrames,
    360,
    "a disabled outro must not extend the composition",
  );
  assert.equal(
    timing.resolveCompositionTimeline({ segments: [], fps: 30, outro: { durationSeconds: 2 } }).totalFrames,
    60,
    "an empty visual list with audio still needs room for the outro",
  );
});

test("music fades in and out over the computed total frames", () => {
  const base = { baseVolume: 0.8, fps: 30, totalFrames: 300, fadeInSeconds: 1, fadeOutSeconds: 2 };

  assert.equal(timing.getFadedMusicVolume({ ...base, frame: 0 }), 0);
  assert.equal(timing.getFadedMusicVolume({ ...base, frame: 30 }), 0.8);
  assert.equal(timing.getFadedMusicVolume({ ...base, frame: 240 }), 0.8);
  assert.equal(timing.getFadedMusicVolume({ ...base, frame: 300 }), 0);
  assert.equal(timing.getFadedMusicVolume({ ...base, frame: 270 }), 0.4);
  assert.equal(timing.getFadedMusicVolume({ ...base, fadeInSeconds: 0, fadeOutSeconds: 0, frame: 0 }), 0.8);
});

test("segment sequences and motion resolve to real frames and clamped values", () => {
  const segment = { startTime: 1.5, endTime: 3.5, motion: "slow-zoom-in" };

  assert.deepEqual(timing.resolveSegmentSequence(segment, 30), { from: 45, durationInFrames: 60 });
  assert.deepEqual(timing.resolveSegmentMotion(segment, 0, 30), { durationInFrames: 60, scale: 1, x: 0, y: 0 });
  assert.deepEqual(timing.resolveSegmentMotion(segment, 60, 30), { durationInFrames: 60, scale: 1.25, x: 0, y: 0 });
  assert.equal(timing.resolveSegmentMotion(segment, 999, 30).scale, 1.25, "motion clamps after the last frame");
  assert.equal(timing.resolveSegmentMotion({ ...segment, motion: "pan-right" }, 0, 30).x, -72);
  assert.equal(timing.resolveSegmentMotion({ ...segment, motion: "pan-right" }, 60, 30).x, 72);
});

test("pan viewport falls back to the 16:9 preview basis from image width", () => {
  assert.deepEqual(timing.resolvePanViewport({ imageWidth: 1920 }), {
    panViewportWidth: 1920,
    panViewportHeight: 1080,
  });
  assert.deepEqual(timing.resolvePanViewport({ imageWidth: 951, panViewportWidth: 950, panViewportHeight: 534 }), {
    panViewportWidth: 950,
    panViewportHeight: 534,
  });
  assert.deepEqual(timing.resolvePanViewport({}), { panViewportWidth: undefined, panViewportHeight: undefined });
});

test("whip transition computes the preview-equivalent smear state per frame", () => {
  const start = timing.resolveWhipTransition({ progress: 0, previousImage: "a.jpg", nextImage: "b.jpg", durationInFrames: 13 });
  const middle = timing.resolveWhipTransition({ progress: 0.5, previousImage: "a.jpg", nextImage: "b.jpg", durationInFrames: 13 });
  const end = timing.resolveWhipTransition({ progress: 1, previousImage: "a.jpg", nextImage: "b.jpg", durationInFrames: 13 });

  assert.equal(start.intensity, 0);
  assert.equal(start.previousTranslate, 0);
  assert.equal(start.nextTranslate, -35);
  assert.equal(start.previousOpacity, 1);
  assert.equal(start.nextOpacity, 0.58);
  assert.equal(middle.previousTranslate, 60);
  assert.equal(middle.nextTranslate, -17.5);
  assert.equal(middle.previousOpacity, 0.89);
  assert.equal(middle.nextOpacity, 0.79);
  assert.ok(Math.abs(end.intensity) < 1e-9, "the smear intensity returns to zero");
  assert.equal(end.nextTranslate, 0);
  assert.equal(middle.previousSamples.length, 7);
  assert.equal(middle.nextSamples.length, 7);
  assert.equal(middle.previousSamples[3].src, "a.jpg");
  assert.match(middle.previousSamples[3].transform, /^translate3d\(0%, 0, 0\) scale\(/);
  assert.match(middle.previousSamples[0].transform, /^translate3d\(-16%, 0, 0\) scale\(/);
});

test("whip smear samples are symmetrically distributed over seven frames", () => {
  const samples = timing.buildWhipSmearSamples({ src: "a.jpg", smear: 16, opacity: 1, blur: 10, scale: 1.05, contrast: 1.08 });

  assert.equal(samples.length, 7);
  assert.deepEqual(samples.map((sample) => sample.transform), [
    "translate3d(-16%, 0, 0) scale(1.05)",
    "translate3d(-10.667%, 0, 0) scale(1.05)",
    "translate3d(-5.333%, 0, 0) scale(1.05)",
    "translate3d(0%, 0, 0) scale(1.05)",
    "translate3d(5.333%, 0, 0) scale(1.05)",
    "translate3d(10.667%, 0, 0) scale(1.05)",
    "translate3d(16%, 0, 0) scale(1.05)",
  ]);
  assert.equal(samples[3].opacity, 0.4);
  assert.equal(samples[0].opacity, 0.18);
  assert.equal(samples[0].filter, "blur(10px) contrast(1.08) saturate(0.96)");
});

test("video segment timing starts at the media in-point and clamps the foreground transform", () => {
  const media = {
    durationSeconds: 2.5,
    sourceInSeconds: 1.2,
    foregroundTransform: { x: 12, y: -8, scale: 0 },
  };

  const resolved = timing.resolveVideoSegmentTiming(media, 30);
  assert.equal(resolved.durationInFrames, 75);
  assert.equal(resolved.startFromFrame, 36);
  assert.deepEqual(resolved.foregroundTransform, { x: 12, y: -8, scale: 0.1 });
  assert.deepEqual(timing.resolveVideoSegmentTiming({ durationSeconds: 1, sourceInSeconds: 0 }, 30).foregroundTransform, { x: 0, y: 0, scale: 1 });
});

test("logo sources resolve to the correct render layout and frame sequence", () => {
  assert.equal(timing.isGreenScreenLogoSource("overlays/logo-secondary-keyed.webm"), true);
  assert.equal(timing.isGreenScreenLogoSource("overlays/logo-green.mp4"), true);
  assert.equal(timing.isGreenScreenLogoSource("overlays/logo-primary.png"), false);
  assert.equal(timing.isLogoFrameSequenceSource("overlays/logo-demo-alpha-frames"), true);
  assert.equal(timing.isLogoFrameSequenceSource("overlays/logo-demo.mp4"), false);
  assert.equal(timing.isFinalLogoSource("overlays/logo-final.png"), true);

  assert.deepEqual(timing.resolveLogoLayout("overlays/logo-final.png"), {
    left: -42,
    top: -9,
    width: 412,
    height: 232,
    opacity: 0.94,
    objectFit: "contain",
  });
  assert.deepEqual(timing.resolveLogoLayout("overlays/logo-primary.webm"), {
    left: 52,
    top: 38,
    width: 220,
    height: 124,
    opacity: 0.94,
    objectFit: "contain",
  });
  assert.equal(timing.logoFrameSequenceSrc("overlays/logo-demo-alpha-frames", 1234), "overlays/logo-demo-alpha-frames/frame-0334.png");
});

test("newspaper layout keeps the blur, contain fit and label typography", () => {
  assert.deepEqual(timing.NEWSPAPER_LABEL_LINES, ["RECREACIÓN", "ARTÍSTICA"]);
  assert.equal(timing.NEWSPAPER_BACKGROUND_BLUR, 15);
  assert.equal(timing.NEWSPAPER_BACKGROUND_STYLE.filter, "blur(15px)");
  assert.equal(timing.NEWSPAPER_BACKGROUND_STYLE.objectFit, "cover");
  assert.equal(timing.NEWSPAPER_FOREGROUND_STYLE.objectFit, "contain");
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.fontFamily, '"Demo Display", Inter, Arial, sans-serif');
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.fontSize, 40);
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.lineHeight, 1.12);
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.right, 40);
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.top, 40);
  assert.equal(timing.NEWSPAPER_LABEL_STYLE.textAlign, "center");
  assert.equal(timing.NEWSPAPER_LOCAL_FONT_URL, "fonts/display/Demo-Display.woff2");
  assert.deepEqual(timing.resolveNewspaperMotion({ frame: 0, durationInFrames: 30 }), { scale: 1, x: 0, y: 0 });
  assert.equal(timing.resolveNewspaperMotion({ frame: 30, durationInFrames: 30 }).scale, 1.1);
  assert.equal(timing.resolveNewspaperMotion({ frame: 15, durationInFrames: 30, foregroundMotion: "pan-left" }).x, 0);
});

test("media layer audio policy keeps the channel outro audible and mutes effects", () => {
  assert.deepEqual(timing.MEDIA_LAYER_AUDIO_POLICY.channelOutro, { muted: false });
  for (const layer of ["overlayLayer01", "overlayLayer02", "foregroundVideo", "backgroundVideo", "logoVideo"]) {
    assert.equal(timing.MEDIA_LAYER_AUDIO_POLICY[layer].muted, true, `${layer} must stay muted`);
  }
});

test("video segment layers keep the five deterministic visual defaults", () => {
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.background.objectFit, "cover");
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.colorOverlay.backgroundColor, "#3835AF");
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.colorOverlay.opacity, 0.3);
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.effect1.mixBlendMode, "screen");
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.effect2.mixBlendMode, "multiply");
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.foreground.objectFit, "contain");
  assert.equal(timing.VIDEO_SEGMENT_LAYER_STYLE.foreground.transformOrigin, "center center");
});

test("root duration adds the enabled outro to the official composition duration", () => {
  const props = {
    fps: 30,
    compositionDurationSeconds: 10,
    outro: { enabled: true, durationSeconds: 2 },
    segments: [{ startTime: 0, endTime: 8 }],
  };

  assert.equal(timing.resolveRootDurationFrames({ props }).durationInFrames, 360);
  assert.equal(timing.resolveRootDurationFrames({ props: { ...props, outro: { enabled: false, durationSeconds: 2 } } }).durationInFrames, 300);
  assert.equal(timing.resolveRootDurationFrames({ props: { ...props, fps: 24 } }).durationInFrames, 288);
  assert.equal(timing.resolveRootDurationFrames({ props: { ...props, segments: [], compositionDurationSeconds: 0 } }).durationInFrames, 60);
});

test("motion presets resolve to their documented ranges", () => {
  assert.deepEqual(timing.resolveMotionRange("none"), { fromScale: 1, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 });
  assert.deepEqual(timing.resolveMotionRange("slow-zoom-out"), { fromScale: 1.08, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 });
  assert.deepEqual(timing.resolveMotionRange({ fromScale: 1, toScale: 1.4 }), { fromScale: 1, toScale: 1.4, fromX: 0, fromY: 0, toX: 0, toY: 0 });
  assert.deepEqual(timing.resolveMotionRange("unknown"), { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 });
});
