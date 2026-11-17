export const DEFAULT_BRAND_CHANNEL = 'demo-primary';
export const BRAND_CHANNEL_IDS = Object.freeze(['demo-primary', 'demo-secondary', 'demo-final']);

/**
 * The browser cannot import the CommonJS contracts package directly, so this
 * module is the panel's single source of truth for brand-channel ids. The
 * Node-side catalog lives in `packages/contracts/approval-contract-pipeline`.
 */
export function normalizeBrandChannel(value = DEFAULT_BRAND_CHANNEL) {
  const normalized = (value || '').toString().trim().toLowerCase();
  return BRAND_CHANNEL_IDS.includes(normalized) ? normalized : DEFAULT_BRAND_CHANNEL;
}
