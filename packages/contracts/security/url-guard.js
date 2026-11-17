/**
 * Server-side URL guard for values that come from news or user data.
 *
 * Article extraction and preview fetches receive URLs that originated in RSS
 * feeds, job rows or editor payloads. Before a socket is opened, reject
 * loopback, private, link-local, CGNAT/shared, multicast, reserved and
 * unspecified addresses, every IPv6 equivalent, and single-label hosts
 * (Docker Compose service names). Hostnames are resolved and every returned
 * address must be public.
 *
 * This module is deliberately dependency-free and CommonJS so both the
 * ESM adapters and the CommonJS approval-extraction service can use it.
 */
const dns = require('node:dns');
const net = require('node:net');

class BlockedUrlError extends Error {
  constructor(message = 'url is not a public http(s) destination') {
    super(message);
    this.name = 'BlockedUrlError';
    this.code = 'ssrf_blocked_url';
  }
}

const BLOCKED_IPV4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function isBlockedIpv4(value) {
  const address = ipv4ToInt(value);
  if (address == null) return true;
  return BLOCKED_IPV4.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (ipv4ToInt(network) & mask);
  });
}

function normalizeIpv6(value) {
  const text = String(value || '').trim().toLowerCase();
  const withoutZone = text.split('%')[0];
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return { family: 4, value: mapped[1] };
  // Hex-compressed IPv4-mapped form, e.g. ::ffff:a00:1 => 10.0.0.1.
  const hexMapped = withoutZone.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return {
      family: 4,
      value: `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`,
    };
  }
  return { family: 6, value: withoutZone };
}

function isBlockedIpv6(value) {
  const text = String(value || '');
  if (text === '::' || text === '::1') return true;
  // Unique-local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8),
  // IPv4-translated (::ffff:0:0/96), discard-only (100::/64) and docs
  // (2001:db8::/32).
  if (/^f[cd][0-9a-f]{2}:/.test(text)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(text)) return true;
  if (/^ff[0-9a-f]{2}:/.test(text)) return true;
  if (/^100::/.test(text)) return true;
  if (/^2001:db8:/.test(text)) return true;
  if (/^64:ff9b:/.test(text)) return true;
  return false;
}

function isBlockedAddress(value) {
  const text = String(value || '').trim();
  const family = net.isIP(text);
  if (family === 4) return isBlockedIpv4(text);
  if (family === 6) {
    const normalized = normalizeIpv6(text);
    return normalized.family === 4 ? isBlockedIpv4(normalized.value) : isBlockedIpv6(normalized.value);
  }
  return false;
}

function assertPublicHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('url has no host');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedUrlError('url host is not public');
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    throw new BlockedUrlError('url host is not public');
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrlError('url host is not public');
    return { host, isIp: true };
  }
  if (!host.includes('.')) throw new BlockedUrlError('url host is a single-label name');
  return { host, isIp: false };
}

async function defaultResolve(host) {
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Throw BlockedUrlError unless `value` is an absolute http(s) URL whose host is
 * public after DNS resolution. `resolver` is injectable for tests.
 */
async function assertPublicUrl(value, { resolver = defaultResolve } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new BlockedUrlError('url must be an absolute http(s) url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError('url must be an absolute http(s) url');
  }
  const { host, isIp } = assertPublicHost(parsed.hostname);
  if (isIp) return parsed.toString();
  let addresses;
  try {
    addresses = await resolver(host);
  } catch {
    throw new BlockedUrlError('url host could not be resolved');
  }
  if (!addresses || !addresses.length) throw new BlockedUrlError('url host resolved to no addresses');
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new BlockedUrlError('url host resolves to a non-public address');
  }
  return parsed.toString();
}

module.exports = {
  BlockedUrlError,
  assertPublicUrl,
  assertPublicHost,
  isBlockedAddress,
};
