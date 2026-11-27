import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(ipInt, baseStr, maskBits) {
  const baseInt = ipv4ToInt(baseStr);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Returns true if the IP (IPv4, IPv6, or IPv4-mapped IPv6) is private, loopback,
 * link-local, CGNAT, ULA, or otherwise reserved.
 */
export function isBlockedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase();
  if (!ip) return true;

  if (net.isIPv4(ip)) {
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) return true;
    const blockedCidrs = [
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
    return blockedCidrs.some(([base, bits]) => inCidr4(ipInt, base, bits));
  }

  if (net.isIPv6(ip)) {
    const clean = ip.split('%')[0];
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('::ffff:')) {
      const mapped = clean.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isBlockedIp(mapped);
      // Handle hex-encoded IPv4-mapped like ::ffff:7f00:1
      const hexParts = mapped.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isBlockedIp(v4);
        }
      }
      return true;
    }
    const firstHextet = parseInt(clean.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }

  return true;
}

/**
 * Validates a webhook URL, resolves DNS once, and rejects private/reserved IPs.
 */
export async function validateWebhookUrl(
  rawUrl,
  { allowHttp = false, allowPrivateIp = false, lookupFn = dns.lookup } = {}
) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Webhook URL must not contain embedded credentials');
  }

  if (parsedUrl.protocol !== 'https:' && !(allowHttp && parsedUrl.protocol === 'http:')) {
    throw new Error('Webhook URL must use HTTPS');
  }

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (!allowPrivateIp && isBlockedIp(hostname)) {
      throw new Error(`Webhook target IP ${hostname} is blocked`);
    }
    return {
      parsedUrl,
      pinnedAddress: hostname,
      pinnedFamily: net.isIPv6(hostname) ? 6 : 4,
    };
  }

  const records = await lookupFn(hostname, { all: true });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Webhook hostname could not be resolved');
  }

  for (const rec of records) {
    if (!allowPrivateIp && isBlockedIp(rec.address)) {
      throw new Error(`Webhook resolved IP ${rec.address} is blocked`);
    }
  }

  return {
    parsedUrl,
    pinnedAddress: records[0].address,
    pinnedFamily: records[0].family || (net.isIPv6(records[0].address) ? 6 : 4),
  };
}

/**
 * Performs an HTTP/HTTPS request pinning the single validated DNS IP (defeating
 * DNS rebinding), rejecting redirects, and enforcing a 5s timeout.
 */
export async function safeWebhookRequest(
  rawUrl,
  { method = 'POST', headers = {}, body = '' } = {},
  options = {}
) {
  const { parsedUrl, pinnedAddress, pinnedFamily } = await validateWebhookUrl(rawUrl, options);
  const timeoutMs = options.timeoutMs ?? 5000;
  const transport = parsedUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      parsedUrl,
      {
        method,
        headers,
        timeout: timeoutMs,
        lookup: (_host, opts, cb) => {
          if (opts?.all) {
            return cb(null, [{ address: pinnedAddress, family: pinnedFamily }]);
          }
          return cb(null, pinnedAddress, pinnedFamily);
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return reject(new Error(`Webhook redirects are blocked (HTTP ${res.statusCode})`));
        }
        const chunks = [];
        res.on('data', (chunk) => {
          if (chunks.length < 16) chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 1024),
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Webhook request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
