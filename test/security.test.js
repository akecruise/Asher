'use strict';
/**
 * ทดสอบการกันพลาดของ ASHER Marketing Intelligence — รันด้วย `npm test`
 * ไม่ใช้ test framework เพราะโปรเจกต์นี้ตั้งใจไม่มี dependency ภายนอก
 *
 * ระบบนี้ไม่มี login (ระบบ login อยู่ที่ ASHER Connect) สิ่งที่เทสต์คือ:
 * ไม่เผลอเปิดออกอินเทอร์เน็ต, ไม่เสิร์ฟไฟล์ที่ไม่ควรเสิร์ฟ, ไม่ให้เว็บอื่นยิง API,
 * rate limit, กัน SSRF และตัวโหลด .env
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
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
    child.stdout.on('data', (d) => { out += d; if (out.includes('ASHER local API')) resolve(child); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server ไม่ขึ้นใน 5 วิ: ${out}`)), 5000);
  });
}

async function req(base, target, options = {}) {
  const res = await fetch(base + target, { redirect: 'manual', ...options });
  let body = null;
  try { body = await res.text(); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  /* ---------- 1. กันเผลอเปิดออกอินเทอร์เน็ต ---------- */
  const refused = await startServer({ PORT: '8911', HOST: '0.0.0.0', ASHER_DATA_DIR: DATA_DIR }).then(
    (child) => { child.kill(); return false; },
    (err) => /ปฏิเสธการเปิด server/.test(err.message)
  );
  check('bind 0.0.0.0 -> ไม่ยอมบูต (ระบบไม่มี login)', refused);

  const forced = await startServer({
    PORT: '8912', HOST: '0.0.0.0', ASHER_ALLOW_INSECURE: '1', ASHER_DATA_DIR: DATA_DIR
  }).then((child) => { child.kill(); return true; }, () => false);
  check('ยืนยันด้วย ASHER_ALLOW_INSECURE=1 ถึงจะเปิดออกได้', forced);

  /* ---------- 2. ไฟล์ที่ห้ามเสิร์ฟ + header ---------- */
  const PORT = 8913;
  const base = `http://127.0.0.1:${PORT}`;
  const server = await startServer({
    PORT: String(PORT), HOST: '127.0.0.1', ASHER_DATA_DIR: DATA_DIR
  });

  try {
    for (const [target, label] of [
      ['/data/asher-projects.json', 'ข้อมูลโครงการ'],
      ['/server/server.js', 'ซอร์สฝั่ง server'],
      ['/package.json', 'package.json'],
      ['/.git/config', '.git/config'],
      ['/.env', '.env']
    ]) {
      const res = await req(base, target);
      check(`โหลด ${label} ตรง ๆ -> 404`, res.status === 404, `ได้ ${res.status}`);
    }

    const traversal = await req(base, '/modules/..%2f..%2fetc%2fpasswd');
    check('path traversal -> ไม่ 200', traversal.status !== 200, `ได้ ${traversal.status}`);

    const home = await req(base, '/');
    check('เปิด / -> เด้งเข้าหน้าหลักเลย ไม่มี login',
      home.status === 302 && home.headers.get('location') === '/modules/asher-projects/',
      `${home.status} ${home.headers.get('location')}`);

    const page = await req(base, '/modules/asher-projects/');
    check('หน้าหลักเปิดได้ทันที -> 200', page.status === 200, `ได้ ${page.status}`);

    const weakness = await req(base, '/modules/weakness-engine/');
    check('หน้า weakness engine เปิดได้ -> 200', weakness.status === 200, `ได้ ${weakness.status}`);

    check('มี security header ครบ',
      page.headers.get('x-content-type-options') === 'nosniff' &&
      page.headers.get('x-frame-options') === 'DENY' &&
      String(page.headers.get('content-security-policy')).includes("frame-ancestors 'none'"),
      JSON.stringify(Object.fromEntries(page.headers)));

    const robots = await req(base, '/robots.txt');
    check('มี robots.txt + header noindex',
      robots.status === 200 && /Disallow: \/$/m.test(robots.body) &&
      String(robots.headers.get('x-robots-tag')).includes('noindex'), robots.body);

    /* ---------- 3. API ใช้ได้เลยโดยไม่ต้อง login ---------- */
    const projects = await req(base, '/api/asher/projects');
    check('เรียก API ได้เลยไม่ต้อง login -> 200', projects.status === 200, `ได้ ${projects.status}`);

    const created = await req(base, '/api/asher/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ทดสอบ' })
    });
    check('บันทึกโครงการได้ และประทับเวลาไว้',
      created.status === 201 && Boolean(JSON.parse(created.body).project.updatedAt), created.body);

    const health = await req(base, '/api/health');
    check('health บอกจำนวนโครงการได้เลย',
      health.status === 200 && JSON.parse(health.body).projects >= 1, health.body);

    /* ---------- 4. เว็บอื่นสั่ง API เราไม่ได้ ---------- */
    const csrf = await req(base, '/api/asher/projects/ทดสอบ', {
      method: 'DELETE', headers: { origin: 'https://evil.example.com' }
    });
    check('เว็บอื่นสั่งลบข้อมูล (CSRF) -> 403', csrf.status === 403, `ได้ ${csrf.status}`);

    const cors = await req(base, '/api/health', { headers: { origin: 'https://evil.example.com' } });
    check('ไม่ส่ง access-control-allow-origin ให้ origin แปลกหน้า',
      !cors.headers.get('access-control-allow-origin'),
      String(cors.headers.get('access-control-allow-origin')));

    /* ---------- 5. SSRF ---------- */
    const ssrf = await req(base, '/api/scrape', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' })
    });
    check('scrape ไป metadata endpoint -> ถูกบล็อก', ssrf.status === 400, `ได้ ${ssrf.status}`);
  } finally {
    server.kill();
  }

  /* ---------- 6. rate limit และการปลอม X-Forwarded-For ---------- */
  const PPORT = 8916;
  const pbase = `http://127.0.0.1:${PPORT}`;
  const proxied = await startServer({
    PORT: String(PPORT), HOST: '127.0.0.1', ASHER_TRUST_PROXY: '1', ASHER_DATA_DIR: DATA_DIR
  });

  try {
    // proxy จริงจะต่อ IP จริงไว้ท้ายสุดเสมอ — ตัวนับต้องยึดตัวท้าย ไม่ใช่ตัวที่ผู้ยิงใส่มา
    let blocked = 0;
    for (let i = 0; i < 16; i += 1) {
      const attempt = await req(pbase, '/api/scrape', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}, 203.0.113.9` },
        body: JSON.stringify({ html: '<p>ทดสอบ</p>' })
      });
      if (attempt.status === 429) blocked += 1;
    }
    check('ปลอม X-Forwarded-For หลบ rate limit ไม่ได้', blocked > 0, `429 ${blocked} ครั้ง`);

    const other = await req(pbase, '/api/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '8.8.8.8, 203.0.113.77' },
      body: JSON.stringify({ html: '<p>ทดสอบ</p>' })
    });
    check('IP จริงคนละตัว ไม่โดนลูกหลง rate limit', other.status === 200, `ได้ ${other.status}`);
  } finally {
    proxied.kill();
  }

  /* ---------- 7. ตัวโหลด .env ---------- */
  const envFile = path.join(DATA_DIR, 'sample.env');
  fs.writeFileSync(envFile, [
    '# ความเห็น',
    '',
    'ASHER_TEST_PLAIN=hello',
    'ASHER_TEST_QUOTED="มีช่องว่าง ในนี้"',
    'ASHER_TEST_EXISTING=จาก-ไฟล์',
    'ไม่ใช่บรรทัดที่ถูกต้อง'
  ].join('\n'), { mode: 0o600 });
  process.env.ASHER_TEST_EXISTING = 'จาก-environment';
  const loaded = require(path.join(ROOT, 'server/env')).loadEnv(envFile);
  check('.env: อ่านค่าธรรมดาและค่าที่มีเครื่องหมายคำพูดได้',
    loaded === 2 && process.env.ASHER_TEST_PLAIN === 'hello' &&
    process.env.ASHER_TEST_QUOTED === 'มีช่องว่าง ในนี้',
    `loaded=${loaded} ${process.env.ASHER_TEST_QUOTED}`);
  check('.env: ค่าที่ตั้งไว้ใน environment จริงชนะค่าในไฟล์',
    process.env.ASHER_TEST_EXISTING === 'จาก-environment', process.env.ASHER_TEST_EXISTING);

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\nผ่าน ${pass} / ล้มเหลว ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
