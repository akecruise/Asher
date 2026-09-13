'use strict';
/**
 * ชั้นความปลอดภัยของ ASHER Marketing Intelligence
 *
 * โปรเจกต์นี้ตั้งใจให้รันบนเครื่องตัวเอง (localhost) เท่านั้น — ระบบ login อยู่ที่
 * ASHER Connect ไม่ได้อยู่ที่นี่ ที่เหลือในไฟล์นี้จึงเป็นการกันพลาดล้วน ๆ:
 * ไม่เผลอเปิดออกอินเทอร์เน็ต, ไม่เผลอเสิร์ฟไฟล์ที่ไม่ควรเสิร์ฟ, ไม่ให้เว็บอื่นยิง API เรา
 *
 * ไม่มี dependency ภายนอก
 */

/* ------------------------------ config ------------------------------ */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return Boolean(fallback);
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

const TRUST_PROXY = flag('ASHER_TRUST_PROXY', false);
/** มี proxy กี่ชั้นหน้า Node (ใช้เฉพาะตอนตั้ง ASHER_TRUST_PROXY=1) */
const PROXY_HOPS = Math.max(1, Math.min(Number(process.env.ASHER_PROXY_HOPS || 1), 5));
const ALLOW_INSECURE = flag('ASHER_ALLOW_INSECURE', false);
const SCRAPE_ENABLED = flag('ASHER_ENABLE_SCRAPE', true);

/** origin ที่ยอมให้เรียกข้ามโดเมนได้ คั่นด้วย comma — ไม่ตั้ง = same-origin เท่านั้น */
const ALLOWED_ORIGINS = String(process.env.ASHER_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host || '').trim().toLowerCase());
}

/* --------------------------- ตรวจ config ตอนบูต --------------------------- */

/**
 * ระบบนี้ไม่มี login — เปิดออกอินเทอร์เน็ตเมื่อไหร่คือใครก็แก้/ลบข้อมูลได้
 * เลยไม่ยอมบูตถ้า bind นอก localhost (fail closed)
 */
function assertSafeConfig({ host }) {
  const warnings = [];
  const publicBind = !isLoopbackHost(host);

  if (publicBind && !ALLOW_INSECURE) {
    throw new Error(
      `ปฏิเสธการเปิด server ที่ ${host} — ระบบนี้ไม่มี login ออกแบบมาให้รันบนเครื่องตัวเองเท่านั้น\n` +
      '  ถ้าต้องการให้คนอื่นเข้าถึงได้ ต้องมีระบบ login ก่อน (ของเดิมอยู่ใน git commit 6ac878e)\n' +
      '  ยืนยันว่าอยู่หลัง firewall จริงและรับความเสี่ยงเอง ใช้ ASHER_ALLOW_INSECURE=1'
    );
  }
  if (publicBind) {
    warnings.push('!! เปิดออกนอก localhost โดยไม่มี login — ใครเข้าถึง host นี้ได้ ก็ลบข้อมูลได้');
  }
  if (ALLOWED_ORIGINS.length) {
    warnings.push(`ยอมให้เรียกข้ามโดเมนจาก: ${ALLOWED_ORIGINS.join(', ')}`);
  }
  if (!SCRAPE_ENABLED) {
    warnings.push('ปิด /api/scrape อยู่ (ASHER_ENABLE_SCRAPE=0)');
  }
  return warnings;
}

/* ------------------------------ CORS / CSRF ------------------------------ */

function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function requestOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
}

function isAllowedOrigin(req, origin) {
  if (!origin) return true; // ไม่มี Origin = เรียกตรงจาก address bar / เครื่องมือ CLI
  const value = origin.replace(/\/$/, '');
  if (value === requestOrigin(req)) return true;
  // เทียบเฉพาะ host เผื่อ proto ตรวจไม่ตรงตอนอยู่หลัง proxy
  try {
    if (new URL(value).host === req.headers.host) return true;
  } catch {
    return false;
  }
  return ALLOWED_ORIGINS.includes(value);
}

/**
 * header CORS: default = ไม่ส่งอะไรเลย (same-origin เท่านั้น)
 * ของเดิมเคยส่ง * ซึ่งแปลว่าเว็บไหนก็สั่ง API ที่รันอยู่บนเครื่องเราได้ ตอนเปิดเว็บนั้นค้างไว้
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { vary: 'Origin' };
  const value = String(origin).replace(/\/$/, '');
  if (!ALLOWED_ORIGINS.includes(value)) return { vary: 'Origin' };
  return {
    vary: 'Origin',
    'access-control-allow-origin': value,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600'
  };
}

/** request ที่เปลี่ยนข้อมูลต้องมาจาก origin ของเราเองหรือ origin ที่อนุญาตไว้ */
function isSafeStateChange(req) {
  return isAllowedOrigin(req, req.headers.origin);
}

/* --------------------------- security headers --------------------------- */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join('; ');

function securityHeaders(req) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'content-security-policy': CSP
  };
  if (isSecureRequest(req)) {
    headers['strict-transport-security'] = 'max-age=15552000; includeSubDomains';
  }
  return headers;
}

/* ------------------------------ rate limit ------------------------------ */

const buckets = new Map();
const MAX_BUCKETS = 5000;

/**
 * IP ของคนที่ยิงเข้ามา
 * X-Forwarded-For ฝั่งซ้ายคือค่าที่ผู้ยิงใส่มาเอง ปลอมได้ — ตัวที่เชื่อได้คือตัวที่
 * proxy ของเราต่อท้ายไว้ เลยนับจากขวาตามจำนวน proxy จริง
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((value) => value.trim()).filter(Boolean);
    if (chain.length) return chain[Math.max(0, chain.length - PROXY_HOPS)];
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** fixed window แบบง่าย ๆ เก็บใน memory — กันสคริปต์หลุดยิงรัวจนไฟล์ข้อมูลพัง */
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS) {
    for (const [id, bucket] of buckets) {
      if (bucket.reset <= now) buckets.delete(id);
    }
    if (buckets.size > MAX_BUCKETS) buckets.clear();
  }

  let bucket = buckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)) };
  }
  return { ok: true, remaining: limit - bucket.count };
}

module.exports = {
  SCRAPE_ENABLED,
  TRUST_PROXY,
  PROXY_HOPS,
  ALLOWED_ORIGINS,
  assertSafeConfig,
  isLoopbackHost,
  corsHeaders,
  isAllowedOrigin,
  isSafeStateChange,
  securityHeaders,
  clientIp,
  rateLimit
};
