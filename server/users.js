'use strict';
/**
 * ผู้ใช้ระบบ — เก็บใน users.json ที่ ASHER_DATA_DIR (นอกโฟลเดอร์เว็บ)
 *
 * รหัสผ่านเก็บเป็น scrypt hash พร้อม salt ต่อคน ไม่เก็บรหัสจริงที่ไหนเลย
 * เพิ่ม/ลบ/เปลี่ยนรหัสผ่านผ่าน CLI: npm run user -- add someone@example.com
 *
 * ใช้ crypto ของ Node ล้วน ไม่มี dependency ภายนอกตามสไตล์โปรเจกต์นี้
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('./store');

const FILE = path.join(store.DATA_DIR, 'users.json');
const EMPTY = { version: 1, users: [] };

/* scrypt: N=16384 r=8 p=1 -> ~100ms ต่อครั้งบนเครื่องทั่วไป ช้าพอจะกวนคนเดารหัส */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MIN_PASSWORD = 10;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/* ------------------------------ hashing ------------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), hash.toString('base64')
  ].join('$');
}

function verifyPassword(stored, password) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const options = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (!Number.isInteger(options.N) || !Number.isInteger(options.r) || !Number.isInteger(options.p)) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, options);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * ลายเซ็นย่อของรหัสผ่านปัจจุบัน ใส่ไว้ใน session cookie
 * เปลี่ยนรหัสผ่านหรือลบผู้ใช้เมื่อไหร่ session เก่าของคนนั้นตายทันที
 */
function passwordVersion(user) {
  return crypto.createHash('sha256').update(String(user.password)).digest('hex').slice(0, 12);
}

/* ------------------------------ อ่าน/เขียน ------------------------------ */

let cache = { mtimeMs: -1, data: EMPTY };

function readSync() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch {
    cache = { mtimeMs: -1, data: EMPTY };
    return EMPTY;
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.data;

  let data = EMPTY;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    data = {
      version: 1,
      users: Array.isArray(parsed && parsed.users) ? parsed.users.filter((u) => u && u.email) : []
    };
  } catch (err) {
    console.error(`[asher] อ่าน ${FILE} ไม่ได้ — ถือว่ายังไม่มีผู้ใช้`, err.message);
  }
  cache = { mtimeMs: stat.mtimeMs, data };
  return data;
}

function writeSync(data) {
  fs.mkdirSync(store.DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  // 0600: ไฟล์นี้มี hash รหัสผ่าน คนอื่นบนเครื่องเดียวกันไม่ควรอ่านได้
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
  cache = { mtimeMs: -1, data: EMPTY };
}

/* -------------------------------- API -------------------------------- */

function list() {
  return readSync().users.map((user) => ({
    email: user.email,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null
  }));
}

function count() {
  return readSync().users.length;
}

function find(email) {
  const wanted = normalizeEmail(email);
  return readSync().users.find((user) => normalizeEmail(user.email) === wanted) || null;
}

/** ตรวจ email + รหัสผ่าน คืน user ถ้าถูก ไม่ถูกคืน null */
function authenticate(email, password) {
  const user = find(email);
  if (!user) {
    // เผาเวลาทิ้งพอ ๆ กับตอนเจอ user จริง จะได้ไม่รู้ว่า email นี้มีในระบบไหม
    crypto.scryptSync(String(password || ''), 'asher-dummy-salt', SCRYPT.keylen, SCRYPT);
    return null;
  }
  return verifyPassword(user.password, password) ? user : null;
}

function assertPasswordStrength(password) {
  if (String(password || '').length < MIN_PASSWORD) {
    throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
  }
}

function add(email, password) {
  const value = normalizeEmail(email);
  if (!isEmail(value)) throw new Error(`อีเมลไม่ถูกต้อง: ${email}`);
  if (find(value)) throw new Error(`มีผู้ใช้ ${value} อยู่แล้ว — ใช้ passwd ถ้าต้องการเปลี่ยนรหัสผ่าน`);
  assertPasswordStrength(password);

  const data = readSync();
  const users = data.users.concat([{
    email: value,
    password: hashPassword(password),
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  }]);
  writeSync({ version: 1, users });
  return value;
}

function setPassword(email, password) {
  const value = normalizeEmail(email);
  if (!find(value)) throw new Error(`ไม่พบผู้ใช้ ${value}`);
  assertPasswordStrength(password);

  const data = readSync();
  const users = data.users.map((user) => (
    normalizeEmail(user.email) === value
      ? { ...user, password: hashPassword(password), passwordChangedAt: new Date().toISOString() }
      : user
  ));
  writeSync({ version: 1, users });
  return value;
}

function remove(email) {
  const value = normalizeEmail(email);
  if (!find(value)) throw new Error(`ไม่พบผู้ใช้ ${value}`);
  const data = readSync();
  writeSync({ version: 1, users: data.users.filter((u) => normalizeEmail(u.email) !== value) });
  return value;
}

/** จดเวลาเข้าใช้งานล่าสุด — พลาดก็ไม่เป็นไร ไม่ให้ล้ม login */
function touchLogin(email) {
  try {
    const value = normalizeEmail(email);
    const data = readSync();
    if (!data.users.some((u) => normalizeEmail(u.email) === value)) return;
    writeSync({
      version: 1,
      users: data.users.map((user) => (
        normalizeEmail(user.email) === value
          ? { ...user, lastLoginAt: new Date().toISOString() }
          : user
      ))
    });
  } catch (err) {
    console.error('[asher] จด lastLoginAt ไม่สำเร็จ', err.message);
  }
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url');
}

module.exports = {
  FILE,
  MIN_PASSWORD,
  normalizeEmail,
  isEmail,
  hashPassword,
  verifyPassword,
  passwordVersion,
  list,
  count,
  find,
  authenticate,
  add,
  setPassword,
  remove,
  touchLogin,
  generatePassword
};
