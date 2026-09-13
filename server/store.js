'use strict';
/**
 * เก็บข้อมูลโครงการลงไฟล์ JSON — ใช้ทั้งฝั่ง ASHER และฝั่งคู่แข่ง (schema เดียวกัน)
 * เขียนแบบ atomic: เขียน .tmp แล้ว rename ทับ กันไฟล์พังตอนไฟดับ/ปิด server กลางคัน
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * เก็บไฟล์ข้อมูลไว้ที่ไหน — ตั้ง ASHER_DATA_DIR ชี้ออกไปนอกโฟลเดอร์เว็บเสมอเวลา deploy
 * (บน Hostinger การ deploy ทับจะล้างโฟลเดอร์โปรเจกต์ ข้อมูลที่อยู่ใน data/ จะหายไปด้วย)
 */
const DATA_DIR = process.env.ASHER_DATA_DIR
  ? path.resolve(process.env.ASHER_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const EMPTY = { version: 1, updatedAt: null, projects: [] };

const PROJECT_FIELDS = [
  'name', 'brand', 'location', 'website', 'developer', 'status',
  'priceStartTHB', 'pricePerSqmTHB', 'unitsTotal', 'floors',
  'completionYear', 'notes'
];

const ROOM_FIELDS = [
  'type', 'sizeSqm', 'ceilingHeightM', 'priceTHB', 'pricePerSqmTHB',
  'units', 'bedWidthFt', 'usableWidthM', 'notes'
];

const NUMERIC_PROJECT_FIELDS = new Set([
  'priceStartTHB', 'pricePerSqmTHB', 'unitsTotal', 'floors', 'completionYear'
]);

const NUMERIC_ROOM_FIELDS = new Set([
  'sizeSqm', 'ceilingHeightM', 'priceTHB', 'pricePerSqmTHB', 'units',
  'bedWidthFt', 'usableWidthM'
]);

function slugify(value, fallback) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9฀-๿]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeRoom(raw, index) {
  const room = { id: str(raw && raw.id) || `room-${Date.now()}-${index}` };
  for (const field of ROOM_FIELDS) {
    const value = raw ? raw[field] : null;
    room[field] = NUMERIC_ROOM_FIELDS.has(field) ? num(value) : str(value);
  }
  // ถ้ามีราคาและขนาด แต่ยังไม่มีราคาต่อ ตร.ม. ให้คำนวณให้
  if (room.pricePerSqmTHB === null && room.priceTHB && room.sizeSqm) {
    room.pricePerSqmTHB = Math.round(room.priceTHB / room.sizeSqm);
  }
  return room;
}

function normalizeProject(raw, index) {
  const project = {};
  project.id = slugify(raw && (raw.id || raw.name), `project-${index + 1}`);
  for (const field of PROJECT_FIELDS) {
    const value = raw ? raw[field] : null;
    project[field] = NUMERIC_PROJECT_FIELDS.has(field) ? num(value) : str(value);
  }
  if (!project.name) project.name = project.id;
  if (!project.status) project.status = 'selling';

  project.facilities = Array.isArray(raw && raw.facilities)
    ? raw.facilities.map(str).filter(Boolean)
    : [];
  project.promotions = Array.isArray(raw && raw.promotions)
    ? raw.promotions.map(str).filter(Boolean)
    : [];
  project.rooms = Array.isArray(raw && raw.rooms)
    ? raw.rooms.map(normalizeRoom).filter((room) => room.type || room.sizeSqm !== null)
    : [];
  project.sources = Array.isArray(raw && raw.sources)
    ? raw.sources.slice(-20).map((source) => ({
        url: str(source && source.url),
        scrapedAt: str(source && source.scrapedAt),
        appliedFields: Array.isArray(source && source.appliedFields)
          ? source.appliedFields.map(str).filter(Boolean)
          : []
      }))
    : [];
  return project;
}

function normalizeDb(raw) {
  const projects = Array.isArray(raw && raw.projects) ? raw.projects : [];
  const seen = new Set();
  const normalized = [];
  projects.forEach((project, index) => {
    const item = normalizeProject(project, index);
    let id = item.id;
    let suffix = 2;
    while (seen.has(id)) id = `${item.id}-${suffix++}`;
    item.id = id;
    seen.add(id);
    normalized.push(item);
  });
  return {
    version: 1,
    updatedAt: str(raw && raw.updatedAt) || null,
    projects: normalized
  };
}

function createStore(fileName) {
  const file = path.join(DATA_DIR, fileName);
  let writeChain = Promise.resolve();

  async function read() {
    try {
      const text = await fsp.readFile(file, 'utf8');
      return normalizeDb(JSON.parse(text));
    } catch (err) {
      if (err.code === 'ENOENT') return { version: 1, updatedAt: null, projects: [] };
      if (err instanceof SyntaxError) {
        // ไฟล์เสีย: สำรองไว้แล้วเริ่มใหม่ ดีกว่าปล่อยให้ทั้งระบบล่ม
        await fsp.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
        return { version: 1, updatedAt: null, projects: [] };
      }
      throw err;
    }
  }

  function write(db) {
    // ต่อคิวการเขียนไว้ กันสองรีเควสต์เขียนทับกัน
    writeChain = writeChain.then(async () => {
      const next = normalizeDb(db);
      next.updatedAt = new Date().toISOString();
      const tmp = `${file}.tmp-${process.pid}`;
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, file);
      return next;
    }, async () => {
      throw new Error('write queue broken');
    });
    return writeChain;
  }

  return { file, read, write };
}

/** เก็บค่าอะไรก็ได้เป็น JSON ก้อนเดียว (ใช้กับบันทึกการตัดสินใจของ weakness engine) */
function createBlobStore(fileName, fallback) {
  const file = path.join(DATA_DIR, fileName);
  let writeChain = Promise.resolve();

  async function read() {
    try {
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        return JSON.parse(JSON.stringify(fallback));
      }
      throw err;
    }
  }

  function write(value) {
    writeChain = writeChain.then(async () => {
      const tmp = `${file}.tmp-${process.pid}`;
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, file);
      return value;
    }, async () => {
      throw new Error('write queue broken');
    });
    return writeChain;
  }

  return { file, read, write };
}

const asherStore = createStore('asher-projects.json');
const competitorStore = createStore('competitors.json');

module.exports = {
  DATA_DIR,
  DATA_FILE: asherStore.file,
  PROJECT_FIELDS,
  ROOM_FIELDS,
  createStore,
  createBlobStore,
  asherStore,
  competitorStore,
  // ทางลัดของเดิม ให้ code ที่เรียก store.read()/store.write() ตรง ๆ ยังใช้ได้
  read: asherStore.read,
  write: asherStore.write,
  normalizeProject,
  normalizeRoom,
  slugify,
  num
};
