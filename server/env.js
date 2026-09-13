'use strict';
/**
 * โหลดไฟล์ .env แบบง่าย ๆ ไม่ใช้ dependency
 *
 * ต้อง require ไฟล์นี้เป็นอันแรกสุด ก่อน module อื่นจะอ่าน process.env
 * ค่าที่ตั้งไว้ใน environment จริง (เช่นหน้า Hostinger) ชนะค่าใน .env เสมอ
 */
const fs = require('fs');
const path = require('path');

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(eq + 1).trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) ||
                 (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) value = value.slice(1, -1);
  return { key, value };
}

function loadEnv(file) {
  const target = file || path.join(__dirname, '..', '.env');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0; // ไม่มี .env ก็ไม่เป็นไร ใช้ environment ที่ตั้งไว้ข้างนอก
  }
  // ไฟล์นี้มีรหัสผ่าน คนอื่นบนเครื่องเดียวกันไม่ควรอ่านได้
  if (stat.mode & 0o077) {
    console.warn(`[asher] .env เปิดให้คนอื่นอ่านได้ — สั่ง chmod 600 ${target}`);
  }

  let loaded = 0;
  for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
    const entry = parseLine(line);
    if (!entry || process.env[entry.key] !== undefined) continue;
    process.env[entry.key] = entry.value;
    loaded += 1;
  }
  return loaded;
}

module.exports = { loadEnv, parseLine };
