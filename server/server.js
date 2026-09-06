'use strict';
/**
 * ASHER Local API + static server
 *
 *   node server/server.js            -> http://localhost:8000
 *   PORT=8080 node server/server.js
 *
 * ไม่มี dependency ภายนอก ใช้ Node 18+ (ต้องมี global fetch)
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const store = require('./store');
const scraper = require('./scraper');
const weakness = require('./weakness');

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
        note: body.note !== undefined ? String(body.note) : (previous.note || ''),
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

  res.writeHead(200, {
    'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache'
  });
  fs.createReadStream(target).pipe(res);
}

/* ------------------------------ server ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // เรียกข้ามพอร์ตจากหน้า module ที่เปิดด้วย live-server ได้
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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

server.listen(PORT, HOST, () => {
  console.log(`ASHER local API   http://${HOST}:${PORT}/api/health`);
  console.log(`Data input        http://${HOST}:${PORT}/modules/asher-projects/`);
  console.log(`Data file         ${store.DATA_FILE}`);
});

module.exports = server;
