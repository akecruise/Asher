'use strict';
/**
 * ทดสอบชั้นความปลอดภัยแบบ end-to-end — รันด้วย `npm test`
 * ไม่ใช้ test framework เพราะโปรเจกต์นี้ตั้งใจไม่มี dependency ภายนอก
 *
 * ครอบ: fail-closed ตอนบูต, auth, CSRF, CORS, rate limit, ไฟล์ที่ห้ามเสิร์ฟ, SSRF
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'test-password-1234';
/** ข้อมูลทดสอบไปอยู่ tmp เสมอ จะได้ไม่ไปแตะ data/ ของจริง */
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'asher-test-'));
let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server/server.js')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const done = (err) => { if (err) reject(err); else resolve(child); };
    child.stdout.on('data', (d) => { out += d; if (out.includes('ASHER local API')) done(); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server ไม่ขึ้นใน 5 วิ: ${out}`)), 5000);
  });
}

async function req(base, path, options = {}) {
  const res = await fetch(base + path, { redirect: 'manual', ...options });
  let body = null;
  try { body = await res.text(); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  /* ---------- 1. bind สาธารณะโดยไม่มีรหัสผ่าน ต้องไม่ยอมบูต ---------- */
  const refused = await startServer({ PORT: '8911', HOST: '0.0.0.0' }).then(
    (child) => { child.kill(); return false; },
    (err) => /ปฏิเสธการเปิด server/.test(err.message)
  );
  check('bind 0.0.0.0 โดยไม่มีรหัสผ่าน -> ไม่ยอมบูต', refused);

  /* ---------- 2. รหัสผ่านสั้นเกินไป ต้องไม่ยอมบูต ---------- */
  const weak = await startServer({ PORT: '8912', HOST: '0.0.0.0', ASHER_PASSWORD: '1234' }).then(
    (child) => { child.kill(); return false; },
    (err) => /สั้นเกินไป/.test(err.message)
  );
  check('รหัสผ่านสั้น -> ไม่ยอมบูต', weak);

  /* ---------- 3. โหมดมี auth ---------- */
  const PORT = 8913;
  const base = `http://127.0.0.1:${PORT}`;
  const server = await startServer({
    PORT: String(PORT),
    HOST: '127.0.0.1',
    ASHER_PASSWORD: PASSWORD,
    ASHER_DATA_DIR: DATA_DIR
  });

  try {
    const projects = await req(base, '/api/asher/projects');
    check('GET /api/asher/projects โดยไม่ login -> 401', projects.status === 401, `ได้ ${projects.status}`);

    const del = await req(base, '/api/asher/projects/asher-naii', { method: 'DELETE' });
    check('DELETE โดยไม่ login -> 401', del.status === 401, `ได้ ${del.status}`);

    const data = await req(base, '/data/asher-projects.json');
    check('โหลด /data/*.json ตรง ๆ -> 404', data.status === 404, `ได้ ${data.status}`);

    const src = await req(base, '/server/server.js');
    check('โหลด /server/server.js -> 404', src.status === 404, `ได้ ${src.status}`);

    const pkg = await req(base, '/package.json');
    check('โหลด /package.json -> 404', pkg.status === 404, `ได้ ${pkg.status}`);

    const git = await req(base, '/.git/config');
    check('โหลด /.git/config -> 404', git.status === 404, `ได้ ${git.status}`);

    const traversal = await req(base, '/modules/..%2f..%2fetc%2fpasswd');
    check('path traversal -> ไม่ 200', traversal.status !== 200, `ได้ ${traversal.status}`);

    const page = await req(base, '/modules/asher-projects/');
    check('เปิดหน้าโมดูลโดยไม่ login -> เด้งไป login',
      page.status === 302 && String(page.headers.get('location')).startsWith('/modules/login/'),
      `ได้ ${page.status} ${page.headers.get('location')}`);

    const login = await req(base, '/modules/login/');
    check('หน้า login เปิดได้โดยไม่ต้อง login', login.status === 200, `ได้ ${login.status}`);

    check('มี security header ครบ',
      login.headers.get('x-content-type-options') === 'nosniff' &&
      login.headers.get('x-frame-options') === 'DENY' &&
      String(login.headers.get('content-security-policy')).includes("frame-ancestors 'none'"),
      JSON.stringify(Object.fromEntries(login.headers)));

    const health = await req(base, '/api/health');
    check('health ก่อน login ไม่บอกจำนวนโครงการ',
      health.status === 200 && !JSON.parse(health.body).projects, health.body);

    const badLogin = await req(base, '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password-here' })
    });
    check('login รหัสผิด -> 401', badLogin.status === 401, `ได้ ${badLogin.status}`);

    const good = await req(base, '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD })
    });
    const setCookie = good.headers.get('set-cookie') || '';
    check('login ถูก -> 200 + cookie HttpOnly SameSite',
      good.status === 200 && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie),
      `${good.status} ${setCookie}`);

    const cookie = setCookie.split(';')[0];
    const withCookie = await req(base, '/api/asher/projects', { headers: { cookie } });
    check('เรียก API พร้อม cookie -> 200', withCookie.status === 200, `ได้ ${withCookie.status}`);

    const pageIn = await req(base, '/modules/asher-projects/', { headers: { cookie } });
    check('login แล้วเปิดหน้าโมดูลได้ -> 200', pageIn.status === 200, `ได้ ${pageIn.status}`);

    const sessionState = await req(base, '/api/session', { headers: { cookie } });
    check('GET /api/session บอกสถานะได้',
      sessionState.status === 200 && JSON.parse(sessionState.body).authenticated === true,
      sessionState.body);

    const loggedOut = await req(base, '/api/session', { method: 'DELETE', headers: { cookie } });
    check('logout -> ล้าง cookie',
      loggedOut.status === 200 && /Max-Age=0/.test(loggedOut.headers.get('set-cookie') || ''),
      String(loggedOut.headers.get('set-cookie')));

    const forged = await req(base, '/api/asher/projects', {
      headers: { cookie: 'asher_session=abc.def' }
    });
    check('cookie ปลอม -> 401', forged.status === 401, `ได้ ${forged.status}`);

    const csrf = await req(base, '/api/asher/projects/asher-naii', {
      method: 'DELETE',
      headers: { cookie, origin: 'https://evil.example.com' }
    });
    check('DELETE ข้ามโดเมน (CSRF) -> 403', csrf.status === 403, `ได้ ${csrf.status}`);

    const cors = await req(base, '/api/health', { headers: { origin: 'https://evil.example.com' } });
    check('ไม่ส่ง access-control-allow-origin ให้ origin แปลกหน้า',
      !cors.headers.get('access-control-allow-origin'),
      String(cors.headers.get('access-control-allow-origin')));

    const bearer = await req(base, '/api/asher/projects', {
      headers: { authorization: `Bearer ${PASSWORD}` }
    });
    check('Bearer token -> 200', bearer.status === 200, `ได้ ${bearer.status}`);

    let limited = 0;
    for (let i = 0; i < 14; i += 1) {
      const attempt = await req(base, '/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: `wrong-${i}` })
      });
      if (attempt.status === 429) limited += 1;
    }
    check('login ผิดรัว ๆ -> โดน rate limit (429)', limited > 0, `429 ${limited} ครั้ง`);

    const scrapeSsrf = await req(base, '/api/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' })
    });
    check('scrape ไป metadata endpoint -> ถูกบล็อก', scrapeSsrf.status === 400, `ได้ ${scrapeSsrf.status}`);
  } finally {
    server.kill();
  }

  /* ---------- 4. โหมด localhost ไม่มีรหัสผ่าน ต้องใช้ได้เหมือนเดิม ---------- */
  const local = await startServer({
    PORT: '8914',
    HOST: '127.0.0.1',
    ASHER_DATA_DIR: DATA_DIR
  });
  try {
    const res = await req('http://127.0.0.1:8914', '/api/asher/projects');
    check('localhost ไม่มีรหัสผ่าน -> ใช้ได้เหมือนเดิม (200)', res.status === 200, `ได้ ${res.status}`);
    const page = await req('http://127.0.0.1:8914', '/modules/asher-projects/');
    check('localhost เปิดหน้าโมดูลได้เลย', page.status === 200, `ได้ ${page.status}`);
  } finally {
    local.kill();
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nผ่าน ${pass} / ล้มเหลว ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
