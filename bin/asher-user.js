#!/usr/bin/env node
'use strict';
/**
 * จัดการผู้ใช้ระบบ ASHER
 *
 *   npm run user -- list
 *   npm run user -- add aplusmkteam@gmail.com          (สุ่มรหัสผ่านให้ แสดงครั้งเดียว)
 *   npm run user -- add someone@example.com --password "รหัสที่อยากใช้"
 *   npm run user -- passwd aplusmkteam@gmail.com
 *   npm run user -- remove aplusmkteam@gmail.com
 *
 * ต้องรันบนเครื่อง/เซิร์ฟเวอร์เดียวกับที่เก็บข้อมูล และตั้ง ASHER_DATA_DIR ให้ตรงกับตอนรัน server
 */
const users = require('../server/users');

const USAGE = `
จัดการผู้ใช้ ASHER Marketing Intelligence

  npm run user -- list
  npm run user -- add <email> [--password "..."]
  npm run user -- passwd <email> [--password "..."]
  npm run user -- remove <email>

ไม่ใส่ --password ระบบจะสุ่มให้ และแสดงครั้งเดียวเท่านั้น
ไฟล์ผู้ใช้: ${users.FILE}
`;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--password') {
      options.password = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--password=')) {
      options.password = argv[i].slice('--password='.length);
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, options };
}

function showPassword(email, password, generated) {
  console.log('');
  console.log(`  อีเมล      ${email}`);
  console.log(`  รหัสผ่าน   ${password}`);
  console.log('');
  if (generated) {
    console.log('  รหัสนี้แสดงครั้งเดียว — ส่งให้เจ้าตัวทางช่องทางที่ปลอดภัย (ไม่ใช่แชทกลุ่ม)');
    console.log('  เปลี่ยนทีหลังได้ด้วย: npm run user -- passwd ' + email);
  }
  console.log('');
}

function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, email] = positional;

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  if (command === 'list') {
    const all = users.list();
    if (!all.length) {
      console.log('ยังไม่มีผู้ใช้ในระบบ — ตอนนี้ระบบใช้ ASHER_PASSWORD (ถ้าตั้งไว้) หรือเปิดโล่งบน localhost');
      console.log(`ไฟล์ผู้ใช้จะถูกสร้างที่ ${users.FILE}`);
      return;
    }
    console.log(`ผู้ใช้ทั้งหมด ${all.length} คน (${users.FILE})\n`);
    for (const user of all) {
      const last = user.lastLoginAt ? `เข้าล่าสุด ${user.lastLoginAt}` : 'ยังไม่เคยเข้าใช้งาน';
      console.log(`  ${user.email}\n    สร้างเมื่อ ${user.createdAt || '—'} · ${last}`);
    }
    return;
  }

  if (!email) throw new Error(`คำสั่ง ${command} ต้องระบุอีเมลด้วย`);

  if (command === 'add' || command === 'passwd') {
    const generated = !options.password;
    const password = options.password || users.generatePassword();
    if (command === 'add') {
      users.add(email, password);
      console.log(`เพิ่มผู้ใช้ ${users.normalizeEmail(email)} เรียบร้อย`);
    } else {
      users.setPassword(email, password);
      console.log(`เปลี่ยนรหัสผ่านของ ${users.normalizeEmail(email)} เรียบร้อย — session เดิมของคนนี้ถูกตัดทันที`);
    }
    showPassword(users.normalizeEmail(email), password, generated);
    if (users.count() === 1 && command === 'add') {
      console.log('ตอนนี้ระบบเปลี่ยนเป็นโหมด "เข้าด้วยอีเมล" แล้ว — restart server หนึ่งครั้งเพื่อความชัวร์\n');
    }
    return;
  }

  if (command === 'remove') {
    users.remove(email);
    console.log(`ลบผู้ใช้ ${users.normalizeEmail(email)} แล้ว — session ของคนนี้ใช้ไม่ได้อีกต่อไป`);
    if (users.count() === 0) {
      console.log('ไม่เหลือผู้ใช้แล้ว ระบบจะกลับไปใช้ ASHER_PASSWORD — ตรวจว่ายังตั้งไว้อยู่ก่อน restart');
    }
    return;
  }

  throw new Error(`ไม่รู้จักคำสั่ง "${command}"\n${USAGE}`);
}

try {
  main();
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exit(1);
}
