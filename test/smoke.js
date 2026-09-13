'use strict';
/**
 * ตรวจว่า server พร้อม deploy จริง — ยิงใส่ server ที่รันอยู่จริง ไม่ mock
 *   npm test
 * ใช้ ASHER_DATA_DIR ชั่วคราว ไม่แตะข้อมูลจริงใน data/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const TOKEN = 'test-token-1234567890';
const ORIGIN = 'https://workspace.example.com';
const ROOT = path.join(__dirname, '..');

let child;
let baseUrl;
let dataDir;

function startServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        ASHER_DATA_DIR: dataDir,
        ASHER_API_TOKEN: TOKEN,
        ASHER_ALLOWED_ORIGINS: `${ORIGIN},https://other.example.com`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // PORT=0 ให้ระบบเลือกพอร์ตว่างเอง อ่านเลขจริงจากบรรทัดแรกที่ server พิมพ์
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server ไม่ขึ้นใน 10 วิ: ${out}`)), 10000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        baseUrl = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code) => reject(new Error(`server ออกก่อน code=${code}: ${out}`)));
  });
}

function call(path, options) {
  const opts = options || {};
  const headers = { ...(opts.headers || {}) };
  if (opts.token !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(baseUrl + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual'
  });
}

test.before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'asher-smoke-'));
  await startServer();
});

test.after(() => {
  if (child && !child.killed) child.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------ auth ------------------------------- */

test('health ตอบได้โดยไม่มี token (platform ใช้เช็คว่า container ยังไหว)', async () => {
  const res = await call('/api/health', { token: false });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.authRequired, true);
  assert.equal(body.projects, undefined, 'จำนวนโครงการต้องไม่หลุดออกไปโดยไม่มี token');
});

test('health พร้อม token บอกตัวเลขจริง', async () => {
  const body = await (await call('/api/health')).json();
  assert.equal(typeof body.projects, 'number');
});

test('ไม่มี token = เข้าไม่ได้ทุก endpoint ที่มีข้อมูล', async () => {
  for (const [method, url] of [
    ['GET', '/api/asher/projects'],
    ['GET', '/api/weakness'],
    ['POST', '/api/scrape'],
    ['DELETE', '/api/asher/projects/anything']
  ]) {
    const res = await call(url, { method, token: false });
    assert.equal(res.status, 401, `${method} ${url} ต้องเป็น 401`);
  }
});

test('token ผิดก็ยังเข้าไม่ได้', async () => {
  const res = await call('/api/asher/projects', { headers: { authorization: 'Bearer wrong' }, token: false });
  assert.equal(res.status, 401);
});

/* ------------------------------ CRUD ------------------------------- */

test('สร้าง อ่าน แก้ ลบ โครงการได้ครบวง', async () => {
  const created = await call('/api/asher/projects', {
    method: 'POST',
    body: { name: 'ASHER Naii', location: 'อ่อนนุช', rooms: [{ type: '1 Bedroom', sizeSqm: 30, priceTHB: 3600000 }] }
  });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal(project.id, 'asher-naii');
  assert.equal(project.rooms[0].pricePerSqmTHB, 120000, 'ราคาต่อ ตร.ม. ต้องคำนวณให้เอง');

  const patched = await call(`/api/asher/projects/${project.id}`, { method: 'PATCH', body: { floors: 8 } });
  assert.equal((await patched.json()).project.floors, 8);

  const rooms = await (await call('/api/asher/rooms')).json();
  assert.equal(rooms.count, 1);
  assert.equal(rooms.rooms[0].projectName, 'ASHER Naii');

  assert.equal((await call(`/api/asher/projects/${project.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/asher/projects/${project.id}`)).status, 404);
});

test('สร้าง id ซ้ำต้องโดนปฏิเสธ ไม่ใช่เขียนทับ', async () => {
  await call('/api/asher/projects', { method: 'POST', body: { name: 'ASHER Vibe' } });
  const dup = await call('/api/asher/projects', { method: 'POST', body: { name: 'ASHER Vibe' } });
  assert.equal(dup.status, 409);
  await call('/api/asher/projects/asher-vibe', { method: 'DELETE' });
});

test('เขียนไฟล์ลง ASHER_DATA_DIR ที่กำหนด ไม่ใช่โฟลเดอร์ repo', async () => {
  await call('/api/asher/projects', { method: 'POST', body: { name: 'Persist Check' } });
  const saved = JSON.parse(await fsp.readFile(path.join(dataDir, 'asher-projects.json'), 'utf8'));
  assert.ok(saved.projects.some((p) => p.id === 'persist-check'));
  await call('/api/asher/projects/persist-check', { method: 'DELETE' });
});

/* ------------------------------- CORS ------------------------------ */

test('origin ที่ไม่ได้อนุญาต ไม่ได้ CORS header', async () => {
  const res = await call('/api/health', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('origin ที่อนุญาตได้ header เป็นชื่อ origin นั้น ไม่ใช่ *', async () => {
  const res = await call('/api/health', { headers: { origin: ORIGIN } });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('vary'), 'origin');
});

/* ------------------------------ static ----------------------------- */

test('เสิร์ฟไฟล์ static พร้อม etag แล้วตอบ 304 รอบสอง', async () => {
  const first = await fetch(`${baseUrl}/modules/asher-projects/`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ต้องมี etag');

  const second = await fetch(`${baseUrl}/modules/asher-projects/`, { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal((await second.text()).length, 0, '304 ต้องไม่มี body');
});

/** fetch() แตก gzip ให้เองจนวัดขนาดจริงไม่ได้ — ต้องยิงด้วย http ดิบ */
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + pathname);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('บีบอัด gzip ให้ไฟล์ข้อความก้อนใหญ่', async () => {
  const res = await rawGet('/modules/asher-projects/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], 'gzip');
  const plain = zlib.gunzipSync(res.body).toString('utf8');
  assert.ok(plain.includes('AsherAPI'), 'แตก gzip แล้วต้องได้ไฟล์เดิม');
  assert.ok(res.body.length < plain.length / 2,
    `ควรเล็กลงอย่างน้อยครึ่งหนึ่ง (${res.body.length} จาก ${plain.length} ไบต์)`);
});

test('client ที่ไม่รับ gzip ยังได้ไฟล์ปกติ', async () => {
  const res = await fetch(`${baseUrl}/shared/asher-theme.css`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(res.headers.get('content-encoding'), null);
  assert.ok((await res.text()).includes('--'));
});

test('HEAD ต้องไม่ส่ง body', async () => {
  const res = await fetch(`${baseUrl}/modules/asher-projects/index.html`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, 0);
});

test('ปีนออกนอกโฟลเดอร์โปรเจกต์ไม่ได้', async () => {
  const res = await fetch(`${baseUrl}/../../etc/passwd`, { redirect: 'manual' });
  assert.ok([403, 404].includes(res.status), `ต้องไม่เสิร์ฟไฟล์นอกโปรเจกต์ (ได้ ${res.status})`);
});

/* ------------------------------ scrape ----------------------------- */

test('scrape ยิงเข้า network ภายในไม่ได้', async () => {
  const res = await call('/api/scrape', { method: 'POST', body: { url: 'http://127.0.0.1:1/' } });
  assert.ok(res.status >= 400, 'ต้องปฏิเสธ localhost');
});

test('scrape จาก HTML ที่วางมาเองทำงานโดยไม่ต้องออก network', async () => {
  const html = '<html><head><title>ทดสอบ</title></head><body>' +
    '<p>1 Bedroom 32.5 ตร.ม. ราคา 4,200,000 บาท</p><p>ฝ้าสูง 2.9 เมตร</p></body></html>';
  const body = await (await call('/api/scrape', { method: 'POST', body: { html } })).json();
  assert.equal(body.rooms.length, 1, 'ต้องแกะผังห้องได้');
  assert.equal(body.rooms[0].sizeSqm, 32.5);
  assert.equal(body.rooms[0].priceTHB, 4200000);
  assert.equal(body.ceilingHeightM.value, 2.9);
});

/* ---------------------------- shutdown ----------------------------- */

test('SIGTERM ปิดแบบไม่ทิ้งงานเขียนค้าง', async () => {
  await call('/api/asher/projects', { method: 'POST', body: { name: 'Shutdown Check' } });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000))
  ]);
  assert.equal(code, 0, 'ต้องออกด้วย code 0 ไม่ใช่โดนบังคับฆ่า');

  const saved = JSON.parse(await fsp.readFile(path.join(dataDir, 'asher-projects.json'), 'utf8'));
  assert.ok(saved.projects.some((p) => p.id === 'shutdown-check'), 'ข้อมูลก่อนปิดต้องอยู่ครบ');
});
