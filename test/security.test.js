'use strict';
/**
 * ทดสอบชั้นความปลอดภัยแบบ end-to-end — รันด้วย `npm test`
 * ไม่ใช้ test framework เพราะโปรเจกต์นี้ตั้งใจไม่มี dependency ภายนอก
 *
 * ครอบ: fail-closed ตอนบูต, auth, CSRF, CORS, rate limit, ไฟล์ที่ห้ามเสิร์ฟ, SSRF
 */
const { spawn, spawnSync } = require('child_process');
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

  /* ---------- 4. โหมดหลายผู้ใช้ (users.json) ---------- */
  const USERS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'asher-users-'));
  const cliEnv = { ...process.env, ASHER_DATA_DIR: USERS_DIR };
  const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/asher-user.js'), ...args],
    { env: cliEnv, encoding: 'utf8' });

  const OWNER = 'owner@example.com';
  const MATE = 'teammate@example.com';
  const OWNER_PW = 'owner-password-1';
  const MATE_PW = 'teammate-password-1';

  const added = cli('add', OWNER, '--password', OWNER_PW);
  check('CLI เพิ่มผู้ใช้ได้', added.status === 0 && added.stdout.includes(OWNER), added.stdout + added.stderr);
  cli('add', MATE, '--password', MATE_PW);

  const dup = cli('add', OWNER, '--password', OWNER_PW);
  check('เพิ่มอีเมลซ้ำ -> error', dup.status === 1 && /อยู่แล้ว/.test(dup.stderr), dup.stderr);

  const short = cli('add', 'x@example.com', '--password', 'sh0rt');
  check('รหัสผ่านสั้น -> error', short.status === 1 && /อย่างน้อย/.test(short.stderr), short.stderr);

  const listed = cli('list');
  check('CLI list เห็นทั้งสองคน',
    listed.stdout.includes(OWNER) && listed.stdout.includes(MATE), listed.stdout);

  const usersFile = path.join(USERS_DIR, 'users.json');
  const raw = fs.readFileSync(usersFile, 'utf8');
  check('ไฟล์ผู้ใช้ไม่มีรหัสผ่านจริง เก็บเป็น scrypt hash',
    !raw.includes(OWNER_PW) && !raw.includes(MATE_PW) && raw.includes('scrypt$'), raw.slice(0, 120));
  check('ไฟล์ผู้ใช้เป็น 0600', (fs.statSync(usersFile).mode & 0o777) === 0o600,
    (fs.statSync(usersFile).mode & 0o777).toString(8));

  // มีผู้ใช้แล้ว bind สาธารณะได้โดยไม่ต้องตั้ง ASHER_PASSWORD
  const UPORT = 8915;
  const ubase = `http://127.0.0.1:${UPORT}`;
  const userServer = await startServer({
    PORT: String(UPORT), HOST: '0.0.0.0', ASHER_DATA_DIR: USERS_DIR
  });

  try {
    const mode = JSON.parse((await req(ubase, '/api/session')).body);
    check('มี users.json -> โหมด users และยอม bind 0.0.0.0',
      mode.mode === 'users' && mode.authRequired === true, JSON.stringify(mode));

    const noEmail = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: OWNER_PW })
    });
    check('โหมด users: ใส่แต่รหัสผ่านไม่พอ -> 401', noEmail.status === 401, `ได้ ${noEmail.status}`);

    const unknown = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: OWNER_PW })
    });
    check('อีเมลที่ไม่มีในระบบ -> 401', unknown.status === 401, `ได้ ${unknown.status}`);

    const crossed = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: MATE, password: OWNER_PW })
    });
    check('เอารหัสของอีกคนมาใช้ -> 401', crossed.status === 401, `ได้ ${crossed.status}`);

    const mateLogin = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: MATE.toUpperCase(), password: MATE_PW })
    });
    const mateCookie = (mateLogin.headers.get('set-cookie') || '').split(';')[0];
    check('login ด้วยอีเมล (พิมพ์ใหญ่ก็ได้) -> 200',
      mateLogin.status === 200 && JSON.parse(mateLogin.body).user === MATE, mateLogin.body);

    const who = await req(ubase, '/api/session', { headers: { cookie: mateCookie } });
    check('session บอกว่าใครกำลังใช้อยู่',
      JSON.parse(who.body).user === MATE, who.body);

    const created = await req(ubase, '/api/asher/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: mateCookie },
      body: JSON.stringify({ name: 'ทดสอบสองคน' })
    });
    check('บันทึกโครงการแล้วจดว่าใครแก้',
      created.status === 201 && JSON.parse(created.body).project.updatedBy === MATE, created.body);

    // เปลี่ยนรหัสผ่านของอีกคน -> session เดิมต้องตายทันที
    cli('passwd', MATE, '--password', 'teammate-password-2');
    const afterPasswd = await req(ubase, '/api/asher/projects', { headers: { cookie: mateCookie } });
    check('เปลี่ยนรหัสผ่าน -> session เดิมใช้ไม่ได้', afterPasswd.status === 401, `ได้ ${afterPasswd.status}`);

    const relogin = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: MATE, password: 'teammate-password-2' })
    });
    const newCookie = (relogin.headers.get('set-cookie') || '').split(';')[0];
    check('login ด้วยรหัสใหม่ได้', relogin.status === 200, `ได้ ${relogin.status}`);

    // ลบผู้ใช้ -> session ต้องตายทันทีเช่นกัน
    cli('remove', MATE);
    const afterRemove = await req(ubase, '/api/asher/projects', { headers: { cookie: newCookie } });
    check('ลบผู้ใช้ -> session ตายทันที', afterRemove.status === 401, `ได้ ${afterRemove.status}`);

    const ownerLogin = await req(ubase, '/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER, password: OWNER_PW })
    });
    check('เจ้าของยังเข้าได้ตามปกติ', ownerLogin.status === 200, `ได้ ${ownerLogin.status}`);
  } finally {
    userServer.kill();
    fs.rmSync(USERS_DIR, { recursive: true, force: true });
  }

  /* ---------- 5. อยู่หลัง proxy: bot ต้องหลบ rate limit ไม่ได้ ---------- */
  const PPORT = 8916;
  const pbase = `http://127.0.0.1:${PPORT}`;
  const proxied = await startServer({
    PORT: String(PPORT), HOST: '127.0.0.1',
    ASHER_PASSWORD: PASSWORD, ASHER_TRUST_PROXY: '1',
    ASHER_DATA_DIR: DATA_DIR
  });

  try {
    const robots = await req(pbase, '/robots.txt');
    check('มี robots.txt กัน search engine เก็บ index',
      robots.status === 200 && /Disallow: \/$/m.test(robots.body), robots.body);
    check('ทุกหน้าส่ง header noindex',
      String(robots.headers.get('x-robots-tag') || '').includes('noindex'),
      String(robots.headers.get('x-robots-tag')));

    /**
     * จำลอง bot ที่ปลอม X-Forwarded-For สุ่มไปเรื่อย ๆ
     * proxy จริงจะต่อ IP จริงไว้ท้ายสุดเสมอ — ตัวนับต้องยึดตัวท้าย ไม่ใช่ตัวที่ bot ใส่มา
     */
    let blocked = 0;
    for (let i = 0; i < 14; i += 1) {
      const attempt = await req(pbase, '/api/session', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.9.9.${i}, 203.0.113.9`
        },
        body: JSON.stringify({ password: `bot-guess-${i}` })
      });
      if (attempt.status === 429) blocked += 1;
    }
    check('ปลอม X-Forwarded-For หลบ rate limit ไม่ได้', blocked > 0, `429 ${blocked} ครั้ง`);

    // คนละ IP จริง ต้องมีโควตาของตัวเอง ไม่โดนลูกหลงจากคนอื่น
    const other = await req(pbase, '/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ' 8.8.8.8, 203.0.113.77' },
      body: JSON.stringify({ password: PASSWORD })
    });
    check('IP จริงคนละตัว ไม่โดนลูกหลง rate limit', other.status === 200, `ได้ ${other.status}`);
  } finally {
    proxied.kill();
  }

  /* ---------- 6. ตัวโหลด .env ---------- */
  const envFile = path.join(DATA_DIR, 'sample.env');
  fs.writeFileSync(envFile, [
    '# ความเห็น',
    '',
    'ASHER_TEST_PLAIN=hello',
    'ASHER_TEST_QUOTED="มีช่องว่าง ในนี้"',
    'ASHER_TEST_EXISTING=จาก-ไฟล์',
    'ไม่ใช่บรรทัดที่ถูกต้อง'
  ].join('\n'));
  process.env.ASHER_TEST_EXISTING = 'จาก-environment';
  const loaded = require(path.join(ROOT, 'server/env')).loadEnv(envFile);
  check('.env: อ่านค่าธรรมดาและค่าที่มีเครื่องหมายคำพูดได้',
    loaded === 2 && process.env.ASHER_TEST_PLAIN === 'hello' &&
    process.env.ASHER_TEST_QUOTED === 'มีช่องว่าง ในนี้',
    `loaded=${loaded} ${process.env.ASHER_TEST_QUOTED}`);
  check('.env: ค่าที่ตั้งไว้ใน environment จริงชนะค่าในไฟล์',
    process.env.ASHER_TEST_EXISTING === 'จาก-environment', process.env.ASHER_TEST_EXISTING);

  /* ---------- 7. โหมด localhost ไม่มีรหัสผ่าน ต้องใช้ได้เหมือนเดิม ---------- */
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
