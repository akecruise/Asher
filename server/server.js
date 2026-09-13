'use strict';
/**
 * ASHER Local API + static server
 *
 *   node server/server.js            -> http://localhost:8000
 *   PORT=8080 node server/server.js
 *
 * ไม่มี dependency ภายนอก ใช้ Node 18+ (ต้องมี global fetch)
 *
 * ตัวแปรที่ใช้ตอน deploy — ดูรายละเอียดใน README หัวข้อ "Deploy"
 *   PORT / HOST              พอร์ตและ interface ที่ฟัง (ค่าเริ่มต้น 8000 / 127.0.0.1)
 *   ASHER_DATA_DIR           ที่เก็บไฟล์ JSON ต้องเป็น volume ที่อยู่รอดการ deploy
 *   ASHER_API_TOKEN          บังคับ token ทุก /api — ไม่ตั้ง = ใครเข้าถึงพอร์ตได้ก็ลบข้อมูลได้
 *   ASHER_ALLOWED_ORIGINS    origin ที่เรียกข้ามโดเมนได้ คั่นด้วย , (ไม่ตั้ง = same-origin เท่านั้น)
 *   ASHER_ALLOW_PRIVATE_HOSTS  ให้ /api/scrape ยิงเข้า network ภายในได้ (ใช้เฉพาะตอน dev)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const store = require('./store');
const scraper = require('./scraper');
const weakness = require('./weakness');

/* ------------------------------ config ----------------------------- */

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const MAX_BODY = 5 * 1024 * 1024; // เผื่อกรณีวาง HTML ทั้งหน้ามาให้แกะ

const API_TOKEN = String(process.env.ASHER_API_TOKEN || '').trim();
const ALLOWED_ORIGINS = String(process.env.ASHER_ALLOWED_ORIGINS || '')
  .split(',').map((value) => value.trim().replace(/\/$/, '')).filter(Boolean);

// seed ที่ติดมากับโค้ด ไม่ได้ย้ายตาม ASHER_DATA_DIR
const SAMPLE_COMPETITORS_FILE = path.join(ROOT, 'data', 'sample-competitors.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// บีบอัดเฉพาะไฟล์ข้อความที่ใหญ่พอจะคุ้ม (app.js 32KB -> ~7KB)
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript)|image\/svg)/;
const COMPRESS_MIN_BYTES = 1024;

/* ------------------------------ helpers ---------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
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

/** เทียบ token แบบไม่หลุด timing — ยาวไม่เท่ากันก็ต้องใช้เวลาเท่ากัน */
function tokenMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(API_TOKEN);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  if (!API_TOKEN) return true;
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return tokenMatches(bearer || req.headers['x-asher-token']);
}

/* ------------------------------ API ------------------------------ */

/** CRUD ของคอลเลกชันโครงการ — ใช้ร่วมกันทั้งฝั่ง ASHER และฝั่งคู่แข่ง */
async function handleProjectCollection(req, res, projectStore, id) {
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
    const project = store.normalizeProject(body, db.projects.length);
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
    db.projects[index] = store.normalizeProject({ ...merged, id }, index);
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
    sendJson(res, 200, { ok: true, deleted: id, updatedAt: saved.updatedAt });
    return true;
  }

  return false;
}

async function runWeakness() {
  const [asher, competitors, actions] = await Promise.all([
    store.asherStore.read(),
    store.competitorStore.read(),
    store.actionStore.read()
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

  // health ต้องเรียกได้โดยไม่มี token เพราะ platform ใช้เช็คว่า container ยังไหว
  // แต่จำนวนโครงการ/คู่แข่งเป็นข้อมูลธุรกิจ บอกเฉพาะคนที่ถือ token
  if (route[0] === 'health' && req.method === 'GET') {
    if (!isAuthorized(req)) {
      return sendJson(res, 200, { ok: true, service: 'asher-local-api', authRequired: true });
    }
    const [asher, competitors] = await Promise.all([
      store.asherStore.read(),
      store.competitorStore.read()
    ]);
    return sendJson(res, 200, {
      ok: true,
      service: 'asher-local-api',
      authRequired: Boolean(API_TOKEN),
      projects: asher.projects.length,
      rooms: asher.projects.reduce((sum, p) => sum + p.rooms.length, 0),
      competitors: competitors.projects.length,
      updatedAt: asher.updatedAt
    });
  }

  if (!isAuthorized(req)) {
    res.setHeader('www-authenticate', 'Bearer realm="asher"');
    throw scraper.httpError(401, 'ต้องใส่ token — ส่งมาที่ header Authorization: Bearer <token>');
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

    const actions = await store.actionStore.read();
    if (body.reset) {
      delete actions.items[id];
    } else {
      const previous = actions.items[id] || { status: 'new', outcome: null };
      actions.items[id] = {
        status: body.status !== undefined ? body.status : previous.status,
        outcome: body.outcome !== undefined ? body.outcome : previous.outcome,
        note: body.note !== undefined ? String(body.note) : (previous.note || ''),
        updatedAt: new Date().toISOString()
      };
    }
    await store.actionStore.write(actions);
    return sendJson(res, 200, await runWeakness());
  }

  // ปุ่ม "ใส่ข้อมูลตัวอย่าง" — ใส่คู่แข่งตัวอย่างไว้ลองระบบ ลบทิ้งได้ผ่าน /api/competitors/:id
  if (route[0] === 'weakness' && route[1] === 'sample' && req.method === 'POST') {
    let samples;
    try {
      samples = JSON.parse(await fsp.readFile(SAMPLE_COMPETITORS_FILE, 'utf8'));
    } catch {
      throw scraper.httpError(500, 'อ่านไฟล์คู่แข่งตัวอย่างไม่ได้');
    }
    const db = await store.competitorStore.read();
    let added = 0;
    for (const sample of samples) {
      if (db.projects.some((p) => p.id === sample.id)) continue;
      db.projects.push(store.normalizeProject(sample, db.projects.length));
      added += 1;
    }
    await store.competitorStore.write(db);
    return sendJson(res, 200, { ok: true, added, ...(await runWeakness()) });
  }

  if (route[0] === 'scrape' && req.method === 'POST') {
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

async function handleStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
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
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  if (stat.isDirectory()) {
    res.writeHead(302, { location: `${pathname.replace(/\/$/, '')}/` });
    return res.end();
  }

  // ไฟล์ไม่มี hash ในชื่อ จึงให้ revalidate ทุกครั้งแต่ตอบ 304 ตัวเปล่าเมื่อไม่มีอะไรเปลี่ยน
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  const accepts = String(req.headers['accept-encoding'] || '');
  const gzip = COMPRESSIBLE.test(type) &&
    stat.size >= COMPRESS_MIN_BYTES &&
    /\bgzip\b/.test(accepts);

  const headers = {
    'content-type': type,
    'cache-control': 'no-cache',
    etag,
    vary: 'accept-encoding'
  };
  if (gzip) headers['content-encoding'] = 'gzip';
  else headers['content-length'] = stat.size;

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const source = fs.createReadStream(target);
  source.on('error', () => res.destroy());
  if (gzip) source.pipe(zlib.createGzip()).pipe(res);
  else source.pipe(res);
}

/* ------------------------------ server ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // เรียกข้ามโดเมนได้เฉพาะ origin ที่อนุญาตไว้ — ปล่อย * ไม่ได้เพราะ API นี้ลบข้อมูลได้
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-asher-token');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-max-age', '86400');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
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
    sendJson(res, status, { ok: false, error: err.message || 'internal error' });
  }
});

// กัน connection ที่เปิดค้างไว้เฉย ๆ กินสล็อตของ container
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.keepAliveTimeout = 5000;

/** ปิดให้เรียบร้อยตอน orchestrator ส่ง SIGTERM: หยุดรับของใหม่ แล้วรอเขียนไฟล์ให้จบ */
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`[asher] ได้รับ ${signal} — กำลังปิด`);
  const force = setTimeout(() => {
    console.error('[asher] ปิดไม่ทันใน 10 วินาที บังคับออก');
    process.exit(1);
  }, 10000);
  force.unref();
  server.close(async () => {
    await store.flush();
    clearTimeout(force);
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, HOST, () => {
    // PORT=0 แปลว่าให้ระบบเลือกพอร์ตว่างให้ ต้องอ่านเลขจริงจาก socket
    const bound = server.address().port;
    console.log(`ASHER local API   http://${HOST}:${bound}/api/health`);
    console.log(`Data input        http://${HOST}:${bound}/modules/asher-projects/`);
    console.log(`Data dir          ${store.DATA_DIR}`);
    if (!API_TOKEN && HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.warn('[asher] คำเตือน: ฟังทุก interface โดยไม่มี ASHER_API_TOKEN — ' +
        'ใครต่อพอร์ตนี้ได้ก็แก้และลบข้อมูลได้');
    }
  });
}

module.exports = server;
