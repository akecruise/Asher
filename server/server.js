'use strict';
/**
 * ASHER Local API + static server
 *
 *   node server/server.js            -> http://localhost:8000
 *   PORT=8080 node server/server.js
 *
 * ระบบนี้ไม่มี login — ตั้งใจให้รันบนเครื่องตัวเองเท่านั้น (ระบบ login อยู่ที่ ASHER Connect)
 * ถ้า bind นอก 127.0.0.1 server จะไม่ยอมบูต กันเผลอเปิดออกอินเทอร์เน็ต
 *
 * ไม่มี dependency ภายนอก ใช้ Node 18+ (ต้องมี global fetch)
 */
require('./env').loadEnv(); // ต้องมาก่อน module อื่นที่อ่าน process.env

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const store = require('./store');
const scraper = require('./scraper');
const weakness = require('./weakness');
const security = require('./security');

const actionStore = store.createBlobStore('weakness-actions.json', { version: 1, items: {} });

/** คู่แข่งตัวอย่างสำหรับปุ่ม "ใส่ข้อมูลตัวอย่าง" — ลบทิ้งได้ผ่าน /api/competitors/:id */
const SAMPLE_COMPETITORS = [
  {
    id: 'the-base-ratchada-19',
    name: 'The Base Ratchada 19',
    location: 'รัชดาภิเษก 19',
    developer: 'ตัวอย่างสำหรับทดลองระบบ',
    unitsTotal: 420,
    floors: 8,
    facilities: ['สระว่ายน้ำ', 'ฟิตเนส', 'ที่จอดรถ'],
    rooms: [
      { type: '1 Bedroom (S)', sizeSqm: 23, ceilingHeightM: 2.7, priceTHB: 3350000 },
      { type: '1 Bedroom (L)', sizeSqm: 31, ceilingHeightM: 2.5, priceTHB: 4450000 },
      { type: '2 Bedroom', sizeSqm: 44, ceilingHeightM: 2.5, priceTHB: 6600000 }
    ]
  }
];

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const MAX_BODY = 5 * 1024 * 1024; // เผื่อกรณีวาง HTML ทั้งหน้ามาให้แกะ

/* โควตาต่อ IP — กันสคริปต์หลุดยิงรัว ๆ จนไฟล์ข้อมูลพัง */
const LIMIT_READ = { limit: 240, windowMs: 60 * 1000 };
const LIMIT_WRITE = { limit: 60, windowMs: 60 * 1000 };
const LIMIT_SCRAPE = { limit: 12, windowMs: 60 * 1000 };

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** โฟลเดอร์เดียวที่ยอมเสิร์ฟเป็นไฟล์ static — data/ server/ .git/ ไม่อยู่ในนี้ */
const STATIC_PREFIXES = ['/modules/', '/shared/'];
const HOME_PATH = '/modules/asher-projects/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(body);
}

function readBody(req, maxBytes) {
  const cap = maxBytes || MAX_BODY;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > cap) {
        reject(scraper.httpError(413, 'ข้อมูลที่ส่งมาใหญ่เกินไป'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(scraper.httpError(400, 'body ไม่ใช่ JSON ที่ถูกต้อง'));
      }
    });
    req.on('error', reject);
  });
}

function enforceLimit(req, rule, suffix) {
  return enforceLimitKey(`${suffix}:${security.clientIp(req)}`, rule);
}

function enforceLimitKey(key, rule) {
  const result = security.rateLimit(key, rule.limit, rule.windowMs);
  if (!result.ok) {
    const err = scraper.httpError(429, 'ส่งคำขอถี่เกินไป ลองใหม่อีกครั้งในอีกสักครู่');
    err.retryAfter = result.retryAfter;
    throw err;
  }
  return key;
}

/* ------------------------------ API ------------------------------ */

/** CRUD ของคอลเลกชันโครงการ — ใช้ร่วมกันทั้งฝั่ง ASHER และฝั่งคู่แข่ง */
async function handleProjectCollection(req, res, projectStore, id) {
  /** ประทับเวลาที่แก้ล่าสุดไว้ในตัวโครงการเอง */
  const stamp = (raw) => ({ ...raw, updatedAt: new Date().toISOString() });

  if (!id && req.method === 'GET') {
    const db = await projectStore.read();
    sendJson(res, 200, { ok: true, ...db });
    return true;
  }

  if (!id && req.method === 'POST') {
    const body = await readBody(req);
    if (!String(body.name || '').trim()) {
      throw scraper.httpError(400, 'ต้องมีชื่อโครงการ');
    }
    const db = await projectStore.read();
    const project = store.normalizeProject(stamp(body), db.projects.length);
    if (db.projects.some((p) => p.id === project.id)) {
      throw scraper.httpError(409, `มีโครงการ id "${project.id}" อยู่แล้ว`);
    }
    db.projects.push(project);
    const saved = await projectStore.write(db);
    sendJson(res, 201, {
      ok: true,
      project: saved.projects.find((p) => p.id === project.id),
      updatedAt: saved.updatedAt
    });
    return true;
  }

  if (id && req.method === 'GET') {
    const db = await projectStore.read();
    const project = db.projects.find((p) => p.id === id);
    if (!project) throw scraper.httpError(404, `ไม่พบโครงการ "${id}"`);
    sendJson(res, 200, { ok: true, project, updatedAt: db.updatedAt });
    return true;
  }

  if (id && (req.method === 'PUT' || req.method === 'PATCH')) {
    const body = await readBody(req);
    const db = await projectStore.read();
    const index = db.projects.findIndex((p) => p.id === id);
    if (index === -1) throw scraper.httpError(404, `ไม่พบโครงการ "${id}"`);
    const merged = req.method === 'PATCH' ? { ...db.projects[index], ...body } : body;
    db.projects[index] = store.normalizeProject(stamp({ ...merged, id }), index);
    const saved = await projectStore.write(db);
    sendJson(res, 200, {
      ok: true,
      project: saved.projects[index],
      updatedAt: saved.updatedAt
    });
    return true;
  }

  if (id && req.method === 'DELETE') {
    const db = await projectStore.read();
    const index = db.projects.findIndex((p) => p.id === id);
    if (index === -1) throw scraper.httpError(404, `ไม่พบโครงการ "${id}"`);
    db.projects.splice(index, 1);
    const saved = await projectStore.write(db);
    console.log(`[asher] ลบโครงการ ${id}`);
    sendJson(res, 200, { ok: true, deleted: id, updatedAt: saved.updatedAt });
    return true;
  }

  return false;
}

async function runWeakness() {
  const [asher, competitors, actions] = await Promise.all([
    store.asherStore.read(),
    store.competitorStore.read(),
    actionStore.read()
  ]);
  return weakness.analyze({
    asherProjects: asher.projects,
    competitors: competitors.projects,
    actions
  });
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = segments.slice(1);

  if (route[0] === 'health' && req.method === 'GET') {
    const [asher, competitors] = await Promise.all([
      store.asherStore.read(),
      store.competitorStore.read()
    ]);
    return sendJson(res, 200, {
      ok: true,
      service: 'asher-local-api',
      projects: asher.projects.length,
      rooms: asher.projects.reduce((sum, p) => sum + p.rooms.length, 0),
      competitors: competitors.projects.length,
      updatedAt: asher.updatedAt
    });
  }

  if (WRITE_METHODS.has(req.method)) {
    if (!security.isSafeStateChange(req)) {
      throw scraper.httpError(403, 'คำขอข้ามโดเมนที่ไม่อนุญาต');
    }
    enforceLimit(req, LIMIT_WRITE, 'write');
  }

  if (route[0] === 'asher' && route[1] === 'projects') {
    if (await handleProjectCollection(req, res, store.asherStore, route[2])) return;
  }

  if (route[0] === 'competitors') {
    if (await handleProjectCollection(req, res, store.competitorStore, route[1])) return;
  }

  // ให้โมดูลอื่น (เช่น weakness engine) ดึงห้องทั้งหมดแบบแบน ๆ ไปใช้พิสูจน์ว่าเราชนะ
  if (route[0] === 'asher' && route[1] === 'rooms' && req.method === 'GET') {
    const db = await store.asherStore.read();
    const rooms = [];
    for (const project of db.projects) {
      for (const room of project.rooms) {
        rooms.push({
          projectId: project.id,
          projectName: project.name,
          location: project.location,
          ...room
        });
      }
    }
    return sendJson(res, 200, { ok: true, count: rooms.length, rooms, updatedAt: db.updatedAt });
  }

  if (route[0] === 'weakness' && !route[1] && req.method === 'GET') {
    return sendJson(res, 200, await runWeakness());
  }

  // บันทึกการตัดสินใจของเซลส์: ใช้มุมนี้ / ตัดทิ้ง / คืนค่า / ผลลัพธ์ที่ได้จริง
  if (route[0] === 'weakness' && route[1] === 'actions' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id) throw scraper.httpError(400, 'ต้องระบุ id ของจุดอ่อน');

    const VALID_STATUS = ['new', 'used', 'dismissed'];
    const VALID_OUTCOME = ['won', 'lost', 'noeffect'];
    if (body.status !== undefined && VALID_STATUS.indexOf(body.status) === -1) {
      throw scraper.httpError(400, `status ต้องเป็น ${VALID_STATUS.join(' / ')}`);
    }
    if (body.outcome !== undefined && body.outcome !== null &&
        VALID_OUTCOME.indexOf(body.outcome) === -1) {
      throw scraper.httpError(400, `outcome ต้องเป็น ${VALID_OUTCOME.join(' / ')} หรือ null`);
    }

    const actions = await actionStore.read();
    if (body.reset) {
      delete actions.items[id];
    } else {
      const previous = actions.items[id] || { status: 'new', outcome: null };
      actions.items[id] = {
        status: body.status !== undefined ? body.status : previous.status,
        outcome: body.outcome !== undefined ? body.outcome : previous.outcome,
        note: body.note !== undefined ? String(body.note).slice(0, 2000) : (previous.note || ''),
        updatedAt: new Date().toISOString()
      };
    }
    await actionStore.write(actions);
    return sendJson(res, 200, await runWeakness());
  }

  // ปุ่ม "ใส่ข้อมูลตัวอย่าง" — ใส่คู่แข่งตัวอย่างไว้ลองระบบ
  if (route[0] === 'weakness' && route[1] === 'sample' && req.method === 'POST') {
    const db = await store.competitorStore.read();
    let added = 0;
    for (const sample of SAMPLE_COMPETITORS) {
      if (db.projects.some((p) => p.id === sample.id)) continue;
      db.projects.push(store.normalizeProject(sample, db.projects.length));
      added += 1;
    }
    await store.competitorStore.write(db);
    return sendJson(res, 200, { ok: true, added, ...(await runWeakness()) });
  }

  if (route[0] === 'scrape' && req.method === 'POST') {
    if (!security.SCRAPE_ENABLED) {
      throw scraper.httpError(403, 'ปิดการดึงข้อมูลจากเว็บไซต์ไว้ (ASHER_ENABLE_SCRAPE=0)');
    }
    enforceLimit(req, LIMIT_SCRAPE, 'scrape');
    const body = await readBody(req);
    if (body.html) {
      return sendJson(res, 200, scraper.scrapeHtml(String(body.html), body.url));
    }
    if (!body.url) throw scraper.httpError(400, 'ต้องส่ง url หรือ html มาอย่างน้อยหนึ่งอย่าง');
    const result = await scraper.scrapeUrl(String(body.url).trim());
    return sendJson(res, 200, result);
  }

  throw scraper.httpError(404, `ไม่รู้จัก endpoint ${req.method} ${url.pathname}`);
}

/* --------------------------- static files -------------------------- */

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('404 Not Found');
}

/**
 * เสิร์ฟเฉพาะ /modules/ กับ /shared/ เท่านั้น (allowlist)
 * ของเดิมเสิร์ฟทั้ง repo — เท่ากับเปิดให้โหลด data/*.json, server/*.js และ .git/ ได้ตรง ๆ
 */
async function handleStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound(res);
  }

  // บอก search engine ไม่ให้เก็บ index ทั้งเว็บ — ระบบนี้ไม่ได้มีไว้ให้คนทั่วไปเจอ
  if (pathname === '/robots.txt') {
    const body = 'User-agent: *\nDisallow: /\n';
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'public, max-age=86400'
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (pathname === '/' || pathname === '/index.html') return redirect(res, HOME_PATH);

  if (pathname.includes('\0')) return notFound(res);
  // ห้ามแตะไฟล์/โฟลเดอร์ที่ขึ้นต้นด้วยจุด (.git, .env ฯลฯ)
  if (pathname.split('/').some((segment) => segment.startsWith('.'))) return notFound(res);
  if (!STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return notFound(res);

  if (pathname.endsWith('/')) pathname += 'index.html';

  const target = path.join(ROOT, pathname);
  const relative = path.relative(ROOT, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return notFound(res);
  }
  if (stat.isDirectory()) return redirect(res, `${pathname.replace(/\/$/, '')}/`);
  if (!stat.isFile()) return notFound(res);

  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store'
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------ server ----------------------------- */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  for (const [name, value] of Object.entries(security.securityHeaders(req))) {
    res.setHeader(name, value);
  }
  // CORS: default = same-origin เท่านั้น จะเปิดข้ามโดเมนต้องระบุใน ASHER_ALLOWED_ORIGINS
  for (const [name, value] of Object.entries(security.corsHeaders(req))) {
    res.setHeader(name, value);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(security.isAllowedOrigin(req, req.headers.origin) ? 204 : 403);
    return res.end();
  }

  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      enforceLimit(req, LIMIT_READ, 'api');
      await handleApi(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await handleStatic(req, res, url);
    } else {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }
  } catch (err) {
    if (res.headersSent) return;
    const status = err.status || 500;
    if (status >= 500) console.error(`[asher] ${req.method} ${url.pathname}`, err);
    // 500 ไม่บอกรายละเอียดข้างในออกไปข้างนอก
    const message = status >= 500 ? 'internal error' : (err.message || 'error');
    sendJson(res, status, { ok: false, error: message },
      err.retryAfter ? { 'retry-after': String(err.retryAfter) } : undefined);
  }
});

// อยู่หลัง reverse proxy: ให้ keep-alive ของเรานานกว่าของ proxy กัน 502 เป็นช่วง ๆ
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 70 * 1000;
server.requestTimeout = 60 * 1000;

function start() {
  let warnings;
  try {
    warnings = security.assertSafeConfig({ host: HOST });
  } catch (err) {
    console.error(`\n[asher] เริ่ม server ไม่ได้:\n${err.message}\n`);
    process.exit(1);
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[asher] พอร์ต ${PORT} ถูกใช้อยู่แล้ว — ลอง PORT=8080 node server/server.js`);
    } else {
      console.error('[asher] server error', err);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`ASHER local API   http://${HOST}:${PORT}/api/health`);
    console.log(`Data input        http://${HOST}:${PORT}${HOME_PATH}`);
    console.log(`Data dir          ${store.DATA_DIR}`);
    console.log(`Login             ไม่มี — ระบบนี้ใช้บนเครื่องตัวเองเท่านั้น`);
    for (const warning of warnings) console.warn(`[asher] ${warning}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

if (require.main === module) start();

module.exports = server;
module.exports.start = start;
