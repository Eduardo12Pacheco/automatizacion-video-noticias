#!/usr/bin/env node
/**
 * Materializes the runtime media copies from the canonical `examples/brand`
 * demo set. Only `examples/brand` is tracked; the panel, renderer and approval
 * editor copies are build/runtime artifacts produced by this script (pnpm
 * postinstall, Docker images and the test runner).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BRAND = path.join(ROOT, 'examples', 'brand');
const RENDERER_OVERLAYS = path.join(ROOT, 'services', 'renderer', 'assets', 'overlays');
const RENDERER_PUBLIC = path.join(ROOT, 'services', 'renderer', 'public');
const APPROVAL_OVERLAYS = path.join(ROOT, 'services', 'approval-editor', 'assets', 'overlays');

const BRAND_COPIES = [
  ['logo-demo.webm', 'apps/panel/assets/logo-primary.webm'],
  ['logo-demo.webm', 'apps/panel/assets/logo-secondary.webm'],
  ['logo-demo-green.mp4', 'apps/panel/assets/logo-green.mp4'],
  ['logo-demo-green.mp4', 'apps/panel/assets/logo-clean.mp4'],
  ['logo-demo.png', 'apps/panel/assets/logo-final.png'],
  ['particle-1.webm', 'apps/panel/assets/particle-1.webm'],
  ['particle-2.webm', 'apps/panel/assets/particle-2.webm'],
  ['particle-3.webm', 'apps/panel/assets/particle-3.webm'],
  ['particle-4.webm', 'apps/panel/assets/particle-4.webm'],
  ['overlay-1.webm', 'apps/panel/assets/overlay-layer-01.webm'],
  ['overlay-2.webm', 'apps/panel/assets/overlay-layer-02.webm'],
  ['transition-1.mp4', 'apps/panel/assets/boundary-transitions/transition-1.mp4'],
  ['transition-2.mp4', 'apps/panel/assets/boundary-transitions/transition-2.mp4'],
  ['transition-3.mp4', 'apps/panel/assets/boundary-transitions/transition-3.mp4'],
  ['sfx/sting.wav', 'apps/panel/assets/sfx/sting.wav'],
  ['sfx/whip.wav', 'apps/panel/assets/sfx/whip.wav'],
  ['sfx/whoosh.wav', 'apps/panel/assets/sfx/whoosh.wav'],
  ['sfx/whip.wav', 'apps/panel/assets/sfx/sound-demo.wav'],
  ['fonts/Demo-Display.woff2', 'apps/panel/assets/fonts/display/Demo-Display.woff2'],
  ['logo-demo.webm', 'services/renderer/assets/overlays/logo-primary.webm'],
  ['logo-demo.webm', 'services/renderer/assets/overlays/logo-secondary.webm'],
  ['logo-demo-green.mp4', 'services/renderer/assets/overlays/logo-green.mp4'],
  ['logo-demo-green.mp4', 'services/renderer/assets/overlays/logo-clean.mp4'],
  ['logo-demo-green.mp4', 'services/renderer/assets/overlays/logo-secondary.mp4'],
  ['logo-demo.png', 'services/renderer/assets/overlays/logo-final.png'],
  ['logo-demo.png', 'services/renderer/assets/overlays/logo-primary-alpha-frames/frame-0000.png'],
  ['logo-demo.png', 'services/renderer/assets/overlays/logo-secondary-alpha-frames/frame-0000.png'],
  ['final-demo.mp4', 'services/renderer/assets/overlays/outro-final.mp4'],
  ['particle-1.webm', 'services/renderer/assets/overlays/particle-1.webm'],
  ['particle-2.webm', 'services/renderer/assets/overlays/particle-2.webm'],
  ['particle-3.webm', 'services/renderer/assets/overlays/particle-3.webm'],
  ['particle-4.webm', 'services/renderer/assets/overlays/particle-4.webm'],
  ['overlay-1.webm', 'services/renderer/assets/overlays/overlay-layer-01.webm'],
  ['overlay-2.webm', 'services/renderer/assets/overlays/overlay-layer-02.webm'],
  ['transition-1.mp4', 'services/renderer/assets/overlays/transition-1.mp4'],
  ['transition-2.mp4', 'services/renderer/assets/overlays/transition-2.mp4'],
  ['transition-3.mp4', 'services/renderer/assets/overlays/transition-3.mp4'],
  ['sfx/sting.wav', 'services/renderer/public/sfx/sting.wav'],
  ['sfx/whip.wav', 'services/renderer/public/sfx/whip.wav'],
  ['sfx/whoosh.wav', 'services/renderer/public/sfx/whoosh.wav'],
  ['sfx/whip.wav', 'services/renderer/public/sfx/sound-demo.wav'],
  ['fonts/Demo-Display.woff2', 'services/renderer/public/fonts/display/Demo-Display.woff2'],
];

// The approval editor's overlay set is built from canonical sources only, so
// the image build never depends on renderer copies another build step creates.
const APPROVAL_BRAND_COPIES = [
  ['overlay-1.webm', 'overlay-layer-01.webm'],
  ['overlay-2.webm', 'overlay-layer-02.webm'],
  ['particle-1.webm', 'particle-1.webm'],
  ['particle-2.webm', 'particle-2.webm'],
  ['particle-3.webm', 'particle-3.webm'],
  ['particle-4.webm', 'particle-4.webm'],
  ['logo-demo.webm', 'logo-primary.webm'],
  ['logo-demo.webm', 'logo-secondary.webm'],
  ['logo-demo-green.mp4', 'logo-secondary.mp4'],
  ['logo-demo.png', 'logo-final.png'],
  ['final-demo.mp4', 'outro-final.mp4'],
];

// These two outtros are tracked renderer assets (not generated from the brand
// set), and the approval editor serves them alongside its generated overlays.
const APPROVAL_RENDERER_FILES = ['outro-primary.mp4', 'outro-secondary.mp4'];

function copy(relativeSource, relativeTarget) {
  const source = path.join(BRAND, relativeSource);
  const target = path.join(ROOT, relativeTarget);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function syncApprovalEditor() {
  mkdirSync(APPROVAL_OVERLAYS, { recursive: true });
  for (const [source, destination] of APPROVAL_BRAND_COPIES) {
    copyFileSync(path.join(BRAND, source), path.join(APPROVAL_OVERLAYS, destination));
  }
  for (const fileName of APPROVAL_RENDERER_FILES) {
    copyFileSync(path.join(RENDERER_OVERLAYS, fileName), path.join(APPROVAL_OVERLAYS, fileName));
  }
}

function main() {
  const target = process.argv.includes('--target=approval-editor') ? 'approval-editor' : 'all';
  if (target === 'all') {
    for (const [source, destination] of BRAND_COPIES) copy(source, destination);
  }
  syncApprovalEditor();
  console.log(`runtime demo assets synced (${target})`);
}

main();
