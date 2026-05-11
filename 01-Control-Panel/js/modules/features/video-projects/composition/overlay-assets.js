export const COMPOSITION_LOCAL_OVERLAY_BASE_URL = 'http://127.0.0.1:3042/api/overlays';
export const COMPOSITION_STATIC_ASSET_BASE_URL = './assets';

export const VIDEO_SEGMENT_EFFECT_ASSETS = [
  { assetId: 'overlay-layer-01', fileName: 'overlay-layer-01.webm', blendMode: 'screen' },
  { assetId: 'overlay-layer-02', fileName: 'overlay-layer-02.webm', blendMode: 'multiply' },
];

export const DEFAULT_BRAND_CHANNEL = 'golazo-ecuador';
export const BRAND_CHANNEL_ASSETS = {
  'golazo-ecuador': {
    channel: 'golazo-ecuador',
    label: 'Golazo Ecuador',
    logo: {
      assetId: 'brand-logo-ecuador',
      previewPath: 'logo-demo-alpha.webm',
      renderPath: 'overlays/logo-demo-alpha.webm',
      source: 'logo-demo-alpha.webm',
    },
    outro: {
      assetId: 'brand-outro-ecuador',
      previewPath: 'final-demo-ec.webm',
      renderPath: 'overlays/final-demo-ec.mp4',
      durationSeconds: 2,
      label: 'Golazo Ecuador',
    },
  },
  'golazo-colombia': {
    channel: 'golazo-colombia',
    label: 'Golazo Colombia',
    logo: {
      assetId: 'brand-logo-demo-co',
      previewPath: 'logo-demo-co.webm',
      renderPath: 'overlays/logo-demo-co.mp4',
      source: 'logo-demo-co.webm',
    },
    outro: {
      assetId: 'brand-outro-colombia',
      previewPath: 'final-demo-co.webm',
      renderPath: 'overlays/final-demo-co.mp4',
      durationSeconds: 3.5,
      label: 'Golazo Colombia',
    },
  },
};

export function normalizeBrandChannel(value = DEFAULT_BRAND_CHANNEL) {
  const normalized = (value || '').toString().trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BRAND_CHANNEL_ASSETS, normalized) ? normalized : DEFAULT_BRAND_CHANNEL;
}

export function resolveBrandChannelAssets(channel = DEFAULT_BRAND_CHANNEL) {
  const normalized = normalizeBrandChannel(channel);
  return BRAND_CHANNEL_ASSETS[normalized];
}

export function resolveBrandChannelPreviewAssetUrl({ channel = DEFAULT_BRAND_CHANNEL, kind = 'logo' } = {}) {
  const assets = resolveBrandChannelAssets(channel);
  const asset = kind === 'outro' ? assets.outro : assets.logo;
  return resolveStaticCompositionAssetUrl(asset.previewPath);
}

export function resolveLocalOverlayAssetUrl(fileName = '') {
  const cleanFileName = (fileName || '').toString().trim().replace(/^\/+/, '');
  if (!cleanFileName) return '';
  return `${COMPOSITION_LOCAL_OVERLAY_BASE_URL}/${cleanFileName}`;
}

export function resolveStaticCompositionAssetUrl(fileName = '') {
  const cleanFileName = (fileName || '').toString().trim().replace(/^\/+/, '');
  if (!cleanFileName) return '';
  return `${COMPOSITION_STATIC_ASSET_BASE_URL}/${cleanFileName}`;
}

export function resolveVideoSegmentEffectAsset(assetId = '') {
  const normalized = (assetId || '').toString().trim();
  return VIDEO_SEGMENT_EFFECT_ASSETS.find((asset) => asset.assetId === normalized) || null;
}

export function resolveVideoSegmentEffectUrl(assetId = '') {
  const asset = resolveVideoSegmentEffectAsset(assetId);
  return asset ? resolveStaticCompositionAssetUrl(asset.fileName) : '';
}
