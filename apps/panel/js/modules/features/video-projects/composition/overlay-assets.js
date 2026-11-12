const DEFAULT_COMPOSITION_ASSET_BASE_URL = './assets';
let compositionAssetBaseUrl = DEFAULT_COMPOSITION_ASSET_BASE_URL;

/**
 * Point composition media at the server-provided overlay base. The panel only
 * talks to `apps/api`, so `/panel/bootstrap` is the single source for this URL.
 */
export function configureCompositionAssetBaseUrl(value = '') {
  const base = String(value || '').trim().replace(/\/+$/, '');
  compositionAssetBaseUrl = base || DEFAULT_COMPOSITION_ASSET_BASE_URL;
  return compositionAssetBaseUrl;
}

export function getCompositionAssetBaseUrl() {
  return compositionAssetBaseUrl;
}

export const VIDEO_SEGMENT_EFFECT_ASSETS = [
  { assetId: 'overlay-layer-01', fileName: 'overlay-layer-01.webm', blendMode: 'screen' },
  { assetId: 'overlay-layer-02', fileName: 'overlay-layer-02.webm', blendMode: 'multiply' },
];

export const DEFAULT_BRAND_CHANNEL = 'demo-primary';
export const BRAND_CHANNEL_ASSETS = {
  'demo-primary': {
    channel: 'demo-primary',
    label: 'Demo Sports Uno',
    logo: {
      assetId: 'brand-logo-primary',
      previewPath: 'logo-primary.webm',
      renderPath: 'overlays/logo-primary.webm',
      source: 'logo-primary.webm',
    },
    outro: {
      assetId: 'brand-outro-primary',
      previewPath: 'outro-primary.mp4',
      renderPath: 'overlays/outro-primary.mp4',
      durationSeconds: 30.53,
      label: 'Demo Sports Uno',
    },
  },
  'demo-secondary': {
    channel: 'demo-secondary',
    label: 'Demo Sports Dos',
    logo: {
      assetId: 'brand-logo-secondary',
      previewPath: 'logo-secondary.webm',
      renderPath: 'overlays/logo-secondary.mp4',
      source: 'logo-secondary.webm',
    },
    outro: {
      assetId: 'brand-outro-secondary',
      previewPath: 'outro-secondary.mp4',
      renderPath: 'overlays/outro-secondary.mp4',
      durationSeconds: 30.16,
      label: 'Demo Sports Dos',
    },
  },
  'demo-final': {
    channel: 'demo-final',
    label: 'Final Liga Demo',
    logo: {
      assetId: 'brand-logo-final',
      previewPath: 'logo-final.png',
      renderPath: 'overlays/logo-final.png',
      source: 'logo-final.png',
    },
    outro: {
      assetId: 'brand-outro-final',
      previewPath: 'outro-final.mp4',
      renderPath: 'overlays/outro-final.mp4',
      durationSeconds: 30.12,
      label: 'Final Liga Demo',
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

export function resolveStaticCompositionAssetUrl(fileName = '') {
  const cleanFileName = (fileName || '').toString().trim().replace(/^\/+/, '');
  if (!cleanFileName) return '';
  return `${compositionAssetBaseUrl}/${cleanFileName}`;
}

export function resolveVideoSegmentEffectAsset(assetId = '') {
  const normalized = (assetId || '').toString().trim();
  return VIDEO_SEGMENT_EFFECT_ASSETS.find((asset) => asset.assetId === normalized) || null;
}

export function resolveVideoSegmentEffectUrl(assetId = '') {
  const asset = resolveVideoSegmentEffectAsset(assetId);
  return asset ? resolveStaticCompositionAssetUrl(asset.fileName) : '';
}
