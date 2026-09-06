'use strict';
/**
 * ดึงข้อมูลจากเว็บไซต์โครงการ แล้วเดาค่าที่ใส่ในฟอร์มได้
 *
 * ทุกค่าที่เดาได้จะแนบ "หลักฐาน" (ข้อความรอบ ๆ ที่ match) และระดับความมั่นใจกลับไปด้วย
 * ฝั่ง UI ต้องให้คนกดยืนยันก่อนเสมอ — ไม่เขียนทับข้อมูลจริงเองอัตโนมัติ
 */
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const USER_AGENT =
  'Mozilla/5.0 (compatible; AsherIntelBot/1.0; +local marketing intelligence tool)';

/* ------------------------------------------------------------------ */
/* ป้องกัน SSRF: ห้ามยิงเข้า network ภายใน                              */
/* ------------------------------------------------------------------ */

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
  if (p[0] >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const addr = ip.toLowerCase().split('%')[0];
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
      addr.startsWith('fea') || addr.startsWith('feb')) return true;
  if (/^f[cd]/.test(addr)) return true;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

// ตั้ง ASHER_ALLOW_PRIVATE_HOSTS=1 ถ้าต้องดึงจากเว็บ staging ในวงแลนเอง (ปิดไว้เป็นค่าเริ่มต้น)
const ALLOW_PRIVATE = process.env.ASHER_ALLOW_PRIVATE_HOSTS === '1';

async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'ลิงก์ไม่ถูกต้อง — ใส่ URL เต็มเช่น https://example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'รองรับเฉพาะลิงก์ http:// และ https:// เท่านั้น');
  }
  if (ALLOW_PRIVATE) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw httpError(400, 'ไม่อนุญาตให้ดึงข้อมูลจาก network ภายใน');
    return url;
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw httpError(400, `หาโดเมนไม่เจอ: ${host}`);
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw httpError(400, 'ไม่อนุญาตให้ดึงข้อมูลจาก network ภายใน');
  }
  return url;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ------------------------------------------------------------------ */
/* โหลดหน้าเว็บ                                                        */
/* ------------------------------------------------------------------ */

async function fetchHtml(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'th,en;q=0.8'
        }
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw httpError(504, 'เว็บไซต์ตอบช้าเกิน 15 วินาที');
      throw httpError(502, `ต่อเว็บไซต์ไม่ได้: ${err.message}`);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      clearTimeout(timer);
      response.body?.cancel?.().catch(() => {});
      current = new URL(response.headers.get('location'), url).toString();
      continue;
    }

    try {
      if (!response.ok) throw httpError(502, `เว็บไซต์ตอบกลับ HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
        throw httpError(415, `ลิงก์นี้ไม่ใช่หน้าเว็บ (${type.split(';')[0]})`);
      }
      const buffer = await readCapped(response);
      return { html: buffer, finalUrl: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  }
  throw httpError(502, 'redirect วนเกินกำหนด');
}

async function readCapped(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* HTML -> ข้อความ                                                     */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = /<\/?(?:p|div|section|article|li|tr|td|th|h[1-6]|br|table|ul|ol|header|footer|nav|figcaption)\b[^>]*>/gi;

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '-', mdash: '-', hellip: '...', middot: '·', times: '×'
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() : '';
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      /* JSON-LD พังก็ข้ามไป ไม่ใช่เรื่องคอขาดบาดตาย */
    }
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* ตัวดึงค่า                                                           */
/* ------------------------------------------------------------------ */

const SIZE_UNIT = '(?:ตร\\.?\\s?ม\\.?|ตารางเมตร|sq\\.?\\s?m\\.?|sqm|ตร\\.ม)';
const ROOM_TYPE =
  '(?:studio|สตูดิโอ|duplex|ดูเพล็กซ์|penthouse|เพนท์เฮาส์|(?:[1-4])\\s*(?:bed\\s?rooms?|bedrooms?|bed|br|ห้องนอน))' +
  '(?:\\s*(?:plus|xl)\\b|\\s*\\([A-Za-z0-9]{1,3}\\))?';

const FACILITY_KEYWORDS = [
  ['สระว่ายน้ำ', /สระว่ายน้ำ|swimming\s?pool|lap\s?pool/i],
  ['ฟิตเนส', /ฟิตเนส|fitness|gym\b/i],
  ['Co-Working Space', /co[-\s]?working/i],
  ['Sky Lounge', /sky\s?lounge|rooftop\s?lounge/i],
  ['Rooftop Garden', /rooftop\s?garden|สวนดาดฟ้า/i],
  ['ซาวน่า', /sauna|ซาวน่า|steam\s?room/i],
  ['ที่จอดรถ', /ที่จอดรถ|parking/i],
  ['EV Charger', /ev\s?charg|ที่ชาร์จรถไฟฟ้า/i],
  ['ระบบรักษาความปลอดภัย 24 ชม.', /24\s?(?:ชม|ชั่วโมง|hours?|hrs)|cctv|key\s?card|access\s?control/i],
  ['ล็อบบี้', /lobby|ล็อบบี้/i],
  ['สวนส่วนกลาง', /สวนส่วนกลาง|garden\b|green\s?area/i],
  ['ห้องสมุด / Reading Room', /library|reading\s?room|ห้องสมุด/i],
  ['Pet Friendly', /pet\s?friendly|เลี้ยงสัตว์ได้/i],
  ['Laundry', /laundry|ห้องซักรีด/i]
];

function evidenceAround(text, index, length) {
  const start = Math.max(0, index - 70);
  const end = Math.min(text.length, index + length + 70);
  return `…${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
}

function toNumber(raw) {
  const n = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function found(value, confidence, evidence) {
  return { value, confidence, evidence };
}

function findSize(text) {
  const re = new RegExp(`(\\d{1,3}(?:\\.\\d{1,2})?)\\s*${SIZE_UNIT}`, 'gi');
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const value = toNumber(m[1]);
    // ขนาดห้องคอนโดที่สมเหตุสมผล
    if (value !== null && value >= 15 && value <= 500) {
      hits.push({ value, index: m.index, raw: m[0] });
    }
  }
  return hits;
}

function findPrices(text) {
  const hits = [];
  const million = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:ล้าน|ลบ\.|million|mb\b)/gi;
  let m;
  while ((m = million.exec(text)) !== null) {
    const value = toNumber(m[1]);
    if (value !== null && value >= 0.5 && value <= 500) {
      hits.push({ value: Math.round(value * 1e6), index: m.index, raw: m[0] });
    }
  }
  const baht = /(\d{1,3}(?:,\d{3}){2,})\s*(?:บาท|thb|baht)?/gi;
  while ((m = baht.exec(text)) !== null) {
    const value = toNumber(m[1]);
    if (value !== null && value >= 500000 && value <= 500000000) {
      hits.push({ value, index: m.index, raw: m[0] });
    }
  }
  return hits;
}

function firstInRange(hits, from, to) {
  let best = null;
  for (const hit of hits) {
    if (hit.index < from || hit.index >= to) continue;
    if (!best || hit.index < best.index) best = hit;
  }
  return best;
}

function lastInRange(hits, from, to) {
  let best = null;
  for (const hit of hits) {
    if (hit.index < from || hit.index >= to) continue;
    if (!best || hit.index > best.index) best = hit;
  }
  return best;
}

function normalizeRoomLabel(raw) {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  const suffix = cleaned.match(/\(([A-Za-z0-9]{1,3})\)\s*$/) || cleaned.match(/\b(plus|xl)\s*$/i);
  const base = suffix ? cleaned.slice(0, cleaned.length - suffix[0].length).trim() : cleaned;
  const value = base.toLowerCase();
  let label;
  if (/studio|สตูดิโอ/.test(value)) label = 'Studio';
  else if (/duplex|ดูเพล็กซ์/.test(value)) label = 'Duplex';
  else if (/penthouse|เพนท์เฮาส์/.test(value)) label = 'Penthouse';
  else {
    const bedrooms = value.match(/([1-4])/);
    label = bedrooms ? `${bedrooms[1]} Bedroom` : base;
  }
  if (suffix) {
    const tag = suffix[1].toUpperCase();
    label = tag === 'PLUS' ? `${label} Plus` : `${label} (${tag})`;
  }
  return label;
}

/**
 * จับคู่ผังห้องกับขนาด/ราคา โดยอ่านเฉพาะช่วงข้อความ "ระหว่างชื่อผังห้องนี้กับผังห้องถัดไป"
 * เพราะหน้าโครงการมักเรียงเป็น ชื่อห้อง -> ขนาด -> ราคา ถ้าปล่อยให้มองข้ามผังห้องถัดไป
 * ราคาของ 2 Bedroom จะถูกหยิบไปใส่ Studio
 */
function extractRooms(text) {
  const sizes = findSize(text);
  const prices = findPrices(text);
  const re = new RegExp(ROOM_TYPE, 'gi');
  const anchors = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    anchors.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }

  const byType = new Map();
  anchors.forEach((anchor, i) => {
    const prevEnd = i > 0 ? anchors[i - 1].end : 0;
    const nextStart = i + 1 < anchors.length ? anchors[i + 1].start : text.length;
    const forwardTo = Math.min(nextStart, anchor.end + 220);
    const backFrom = Math.max(prevEnd, anchor.start - 80);

    // ค่าที่อยู่ "หลัง" ชื่อผังห้องน่าเชื่อถือกว่า ถ้าไม่มีค่อยมองย้อนกลับ
    const size = firstInRange(sizes, anchor.end, forwardTo) || lastInRange(sizes, backFrom, anchor.start);
    const price = firstInRange(prices, anchor.end, forwardTo) || lastInRange(prices, backFrom, anchor.start);

    const type = normalizeRoomLabel(anchor.raw);
    const candidate = {
      type,
      sizeSqm: size ? size.value : null,
      priceTHB: price ? price.value : null,
      ceilingHeightM: null,
      confidence: size ? (price ? 'high' : 'medium') : 'low',
      evidence: evidenceAround(text, anchor.start, anchor.raw.length)
    };
    const existing = byType.get(type);
    if (!existing || score(candidate) > score(existing)) byType.set(type, candidate);
  });

  return [...byType.values()].sort((a, b) => (a.sizeSqm || 0) - (b.sizeSqm || 0));
}

function score(room) {
  return (room.sizeSqm ? 2 : 0) + (room.priceTHB ? 1 : 0);
}

function extractCeilingHeight(text) {
  const re = /(?:ฝ้า(?:เพดาน)?|เพดาน|ความสูง(?:ฝ้า)?|ceiling(?:\s?height)?)[^0-9]{0,25}(\d(?:\.\d{1,2})?)\s*(?:ม\.|เมตร|m\b|meters?)/i;
  const m = text.match(re);
  if (!m) return null;
  const value = toNumber(m[1]);
  if (value === null || value < 2 || value > 8) return null;
  return found(value, 'high', evidenceAround(text, m.index, m[0].length));
}

function extractPricePerSqm(text) {
  const re = new RegExp(`(\\d{2,3}(?:,\\d{3})+|\\d{4,6})\\s*(?:บาท|thb)?\\s*(?:\\/|ต่อ|per)\\s*${SIZE_UNIT}`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const value = toNumber(m[1]);
  if (value === null || value < 20000 || value > 1000000) return null;
  return found(value, 'high', evidenceAround(text, m.index, m[0].length));
}

function extractStartPrice(text) {
  const re = /(?:เริ่ม(?:ต้น)?(?:เพียง)?|starting(?:\s?(?:from|at))?|start\s?from|ราคาเริ่มต้น)[^0-9]{0,30}(\d{1,3}(?:\.\d{1,2})?)\s*(?:ล้าน|ลบ\.|mb\b|million)/i;
  const m = text.match(re);
  if (m) {
    const value = toNumber(m[1]);
    if (value !== null && value >= 0.5 && value <= 500) {
      return found(Math.round(value * 1e6), 'high', evidenceAround(text, m.index, m[0].length));
    }
  }
  const prices = findPrices(text);
  if (!prices.length) return null;
  const min = prices.reduce((a, b) => (a.value <= b.value ? a : b));
  return found(min.value, 'low', evidenceAround(text, min.index, min.raw.length));
}

function extractUnits(text) {
  const re = /(\d{2,4})\s*(?:ยูนิต|units?|ห้องชุด)/i;
  const m = text.match(re);
  if (!m) return null;
  const value = toNumber(m[1]);
  if (value === null || value < 10 || value > 20000) return null;
  return found(value, 'medium', evidenceAround(text, m.index, m[0].length));
}

function extractFloors(text) {
  const re = /(?:สูง|อาคาร|ตึก|tower|building)[^0-9]{0,20}(\d{1,2})\s*(?:ชั้น|floors?|storey)/i;
  const m = text.match(re);
  if (!m) return null;
  const value = toNumber(m[1]);
  if (value === null || value < 2 || value > 99) return null;
  return found(value, 'medium', evidenceAround(text, m.index, m[0].length));
}

function extractCompletionYear(text) {
  const re = /(?:แล้วเสร็จ|เสร็จ|พร้อมอยู่|โอน|completion|completed|ready(?:\s?to\s?move)?)[^0-9]{0,25}((?:19|20)\d{2}|25\d{2})/i;
  const m = text.match(re);
  if (!m) return null;
  let value = toNumber(m[1]);
  if (value === null) return null;
  if (value > 2400) value -= 543; // พ.ศ. -> ค.ศ.
  if (value < 1990 || value > 2100) return null;
  return found(value, 'medium', evidenceAround(text, m.index, m[0].length));
}

function extractLocation(text) {
  const re = /(?:สุขุมวิท|อินทามระ|รัชดา(?:ภิเษก)?|ลาดพร้าว|พหลโยธิน|พระราม\s?\d|เอกมัย|ทองหล่อ|อโศก|สาทร|สีลม|จรัญสนิทวงศ์|BTS|MRT)[^\n,|]{0,45}/i;
  const m = text.match(re);
  if (!m) return null;
  return found(m[0].replace(/\s+/g, ' ').trim(), 'low', evidenceAround(text, m.index, m[0].length));
}

function extractFacilities(text) {
  const hits = [];
  for (const [label, re] of FACILITY_KEYWORDS) {
    const m = text.match(re);
    if (m) hits.push({ value: label, evidence: evidenceAround(text, m.index, m[0].length) });
  }
  return hits;
}

function fromJsonLd(blocks) {
  const out = {};
  for (const block of blocks) {
    const name = block && (block.name || (block.mainEntity && block.mainEntity.name));
    if (name && !out.name) out.name = found(String(name).trim(), 'high', 'JSON-LD: name');
    const offers = block && (block.offers || (block.mainEntity && block.mainEntity.offers));
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const price = offer && (offer.price || offer.lowPrice);
    if (price && !out.priceStartTHB) {
      const value = toNumber(price);
      if (value && value >= 100000) {
        out.priceStartTHB = found(value, 'high', 'JSON-LD: offers.price');
      }
    }
    const address = block && block.address;
    if (address && !out.location) {
      const parts = [address.streetAddress, address.addressLocality, address.addressRegion]
        .filter(Boolean).join(' ');
      if (parts) out.location = found(parts.trim(), 'high', 'JSON-LD: address');
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */

function analyze(html, sourceUrl) {
  const text = htmlToText(html);
  const title = extractTitle(html);
  const jsonLd = fromJsonLd(extractJsonLd(html));

  const fields = {
    name: jsonLd.name || (title ? found(title.split(/[|\-–—:]/)[0].trim(), 'low', `<title>: ${title}`) : null),
    location: jsonLd.location || extractLocation(text),
    priceStartTHB: jsonLd.priceStartTHB || extractStartPrice(text),
    pricePerSqmTHB: extractPricePerSqm(text),
    unitsTotal: extractUnits(text),
    floors: extractFloors(text),
    completionYear: extractCompletionYear(text)
  };

  const ceiling = extractCeilingHeight(text);
  const rooms = extractRooms(text);
  if (ceiling) {
    // ความสูงฝ้ามักประกาศเป็นค่ากลางของโครงการ ใส่ให้ทุกห้องเป็นค่าตั้งต้น
    for (const room of rooms) room.ceilingHeightM = ceiling.value;
  }

  const cleanFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.value !== null && value.value !== '') cleanFields[key] = value;
  }

  return {
    ok: true,
    url: sourceUrl,
    scrapedAt: new Date().toISOString(),
    title,
    textLength: text.length,
    fields: cleanFields,
    ceilingHeightM: ceiling,
    rooms,
    facilities: extractFacilities(text),
    warnings: buildWarnings(text, cleanFields, rooms)
  };
}

function buildWarnings(text, fields, rooms) {
  const warnings = [];
  if (text.length < 400) {
    warnings.push('หน้านี้แทบไม่มีข้อความ — น่าจะเป็นเว็บที่ render ด้วย JavaScript ลองเปิดหน้าเว็บแล้ว copy HTML มาวางในช่อง "วาง HTML เอง" แทน');
  }
  if (!rooms.length) {
    warnings.push('ไม่เจอผังห้อง (Studio / 1 Bedroom / 2 Bedroom) ในหน้านี้ — ลองใส่ลิงก์หน้า "ห้องพัก" หรือ "Room Type" โดยตรง');
  }
  if (!Object.keys(fields).length && !rooms.length) {
    warnings.push('ดึงข้อมูลไม่ได้เลย ตรวจสอบว่าลิงก์ถูกต้องและเปิดดูได้จริง');
  }
  const lowSize = rooms.filter((room) => !room.sizeSqm).length;
  if (lowSize) {
    warnings.push(`${lowSize} ผังห้องยังไม่มีขนาด ตร.ม. — ต้องกรอกเองก่อน weakness engine จะใช้พิสูจน์ได้`);
  }
  return warnings;
}

async function scrapeUrl(rawUrl) {
  const { html, finalUrl } = await fetchHtml(rawUrl);
  return analyze(html, finalUrl);
}

function scrapeHtml(html, sourceUrl) {
  return analyze(html, sourceUrl || 'วาง HTML เอง');
}

module.exports = { scrapeUrl, scrapeHtml, analyze, htmlToText, httpError };
