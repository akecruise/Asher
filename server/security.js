'use strict';
/**
 * ชั้นความปลอดภัยสำหรับตอนเอาขึ้น host สาธารณะ (Hostinger / VPS)
 *
 * ของเดิมออกแบบมาให้รันบนเครื่องตัวเอง (127.0.0.1) — พอเปิดออกอินเทอร์เน็ต
 * ใครก็ตามที่เดา URL ถูกจะอ่าน/แก้/ลบข้อมูลโครงการกับข้อมูลคู่แข่งได้ทันที
 * ไฟล์นี้รวม auth + rate limit + header ความปลอดภัย + นโยบาย CORS ไว้ที่เดียว
 *
 * ไม่มี dependency ภายนอก ใช้ crypto ของ Node เท่านั้น
 */
const crypto = require('crypto');

/* ------------------------------ config ------------------------------ */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return Boolean(fallback);
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

/** รหัสผ่านสำหรับคนเข้าหน้าเว็บ (login แล้วได้ cookie) */
const PASSWORD = String(process.env.ASHER_PASSWORD || '').trim();
/** token สำหรับเรียก API จากสคริปต์/โมดูลอื่น (Authorization: Bearer ...) */
const TOKEN = String(process.env.ASHER_TOKEN || '').trim();

const AUTH_ENABLED = Boolean(PASSWORD || TOKEN);
const MIN_SECRET_LENGTH = 12;

const SESSION_COOKIE = 'asher_session';
const SESSION_HOURS = Math.min(Math.max(Number(process.env.ASHER_SESSION_HOURS || 12), 1), 24 * 30);
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;

/**
 * secret ของ cookie: ถ้าไม่ตั้งเอง จะ derive จากรหัสผ่าน/token
 * ทำแบบ deterministic เพื่อให้ session ไม่หลุดตอน restart process (Hostinger restart บ่อย)
 * ผลข้างเคียงที่ตั้งใจ: เปลี่ยนรหัสผ่านเมื่อไหร่ session เก่าตายหมดทันที
 */
const SESSION_SECRET = process.env.ASHER_SESSION_SECRET
  ? Buffer.from(String(process.env.ASHER_SESSION_SECRET))
  : crypto.createHash('sha256').update(`asher-session|${PASSWORD}|${TOKEN}`).digest();

const TRUST_PROXY = flag('ASHER_TRUST_PROXY', false);
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
 * ตรวจว่า config ปลอดภัยพอจะเปิดออกสาธารณะไหม
 * คืน warning เป็น array, โยน Error ถ้าอันตรายจริง ๆ (fail closed — ไม่ยอมบูต)
 */
function assertSafeConfig({ host }) {
  const warnings = [];
  const publicBind = !isLoopbackHost(host);

  if (AUTH_ENABLED) {
    if (PASSWORD && PASSWORD.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `ASHER_PASSWORD สั้นเกินไป (ต้องอย่างน้อย ${MIN_SECRET_LENGTH} ตัวอักษร) — ` +
        'สุ่มด้วย: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'
      );
    }
    if (TOKEN && TOKEN.length < MIN_SECRET_LENGTH) {
      throw new Error(`ASHER_TOKEN สั้นเกินไป (ต้องอย่างน้อย ${MIN_SECRET_LENGTH} ตัวอักษร)`);
    }
  } else if (publicBind && !ALLOW_INSECURE) {
    throw new Error(
      `ปฏิเสธการเปิด server ที่ ${host} โดยไม่มีรหัสผ่าน — ข้อมูลโครงการและข้อมูลคู่แข่งจะเปิดให้ใครก็แก้ได้\n` +
      '  ตั้ง ASHER_PASSWORD="..." (และ/หรือ ASHER_TOKEN="...") ก่อนเริ่ม server\n' +
      '  ถ้าอยู่หลัง firewall จริง ๆ และยอมรับความเสี่ยงเอง ใช้ ASHER_ALLOW_INSECURE=1'
    );
  }

  if (!AUTH_ENABLED && publicBind) {
    warnings.push('!! เปิดสาธารณะโดยไม่มี auth (ASHER_ALLOW_INSECURE=1) — ใครก็ลบข้อมูลได้');
  }
  if (ALLOWED_ORIGINS.length && !AUTH_ENABLED) {
    warnings.push('ตั้ง ASHER_ALLOWED_ORIGINS ไว้แต่ไม่มี auth — เท่ากับเปิดให้เว็บอื่นเรียก API ได้ฟรี');
  }
  if (publicBind && !TRUST_PROXY) {
    warnings.push('อยู่หลัง reverse proxy (Hostinger/Nginx)? ตั้ง ASHER_TRUST_PROXY=1 ให้ rate limit นับ IP จริง');
  }
  if (!SCRAPE_ENABLED) {
    warnings.push('ปิด /api/scrape อยู่ (ASHER_ENABLE_SCRAPE=0)');
  }
  return warnings;
}

/* ------------------------------- auth ------------------------------- */

function safeEqual(a, b) {
  // hash ก่อนเทียบ เพื่อให้ความยาวเท่ากันเสมอและไม่หลุด timing
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
}

/** สร้างค่า cookie: <payload>.<hmac> */
function createSessionValue() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${b64url(sign(payload))}`;
}

function verifySessionValue(value) {
  const raw = String(value || '');
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  const expected = b64url(sign(payload));
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const header = req.headers['x-asher-token'];
  return header ? String(header).trim() : '';
}

/** รหัสผ่านถูกไหม (ใช้ตอน login) */
function checkPassword(input) {
  const value = String(input || '');
  if (!value) return false;
  if (PASSWORD && safeEqual(value, PASSWORD)) return true;
  // ยอมให้ใช้ token แทนรหัสผ่านได้ เผื่อ deploy แบบตั้งแต่ token อย่างเดียว
  return Boolean(TOKEN) && safeEqual(value, TOKEN);
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;

  const token = bearerToken(req);
  if (token) {
    if (TOKEN && safeEqual(token, TOKEN)) return true;
    if (PASSWORD && safeEqual(token, PASSWORD)) return true;
  }

  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return cookie ? verifySessionValue(cookie) : false;
}

function isSecureRequest(req) {
  if (flag('ASHER_COOKIE_SECURE', false)) return true;
  if (req.socket && req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, value) {
  const parts = [
    `${SESSION_COOKIE}=${value || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    value ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : 'Max-Age=0'
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

/* ------------------------------ CORS / CSRF ------------------------------ */

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
 * จะส่งก็ต่อเมื่อ origin นั้นอยู่ใน ASHER_ALLOWED_ORIGINS — ห้ามใช้ * คู่กับ auth เด็ดขาด
 */
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return { vary: 'Origin' };
  const value = String(origin).replace(/\/$/, '');
  if (!ALLOWED_ORIGINS.includes(value)) return { vary: 'Origin' };
  return {
    vary: 'Origin',
    'access-control-allow-origin': value,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, authorization, x-asher-token',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600'
  };
}

/** กัน CSRF: request ที่เปลี่ยนข้อมูลต้องมาจาก origin ของเราเองหรือ origin ที่อนุญาตไว้ */
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

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * fixed window แบบง่าย ๆ เก็บใน memory
 * พอสำหรับ instance เดียวบน Hostinger — ถ้ารันหลาย instance ต้องกัน rate ที่ proxy อีกชั้น
 */
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

/** ล้างตัวนับของ key นั้นทิ้ง (ใช้ตอน login สำเร็จ) */
function resetLimit(key) {
  buckets.delete(key);
}

module.exports = {
  AUTH_ENABLED,
  SCRAPE_ENABLED,
  TRUST_PROXY,
  SESSION_COOKIE,
  SESSION_HOURS,
  ALLOWED_ORIGINS,
  assertSafeConfig,
  isLoopbackHost,
  isAuthenticated,
  checkPassword,
  createSessionValue,
  sessionCookie,
  corsHeaders,
  isAllowedOrigin,
  isSafeStateChange,
  securityHeaders,
  clientIp,
  rateLimit,
  resetLimit
};
