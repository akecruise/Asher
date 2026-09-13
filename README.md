# ASHER Marketing Intelligence — ระบบใส่ข้อมูลโครงการ

โมดูลสำหรับกรอกข้อมูลจริงของ **ASHER Naii** และ **ASHER Vibe** พร้อมช่องใส่ลิงก์เว็บไซต์
ให้ระบบดึงข้อมูล (scraping) มาเดาค่าให้ก่อน แล้วคนค่อยยืนยันทีละช่อง

ที่ต้องมีโมดูลนี้เพราะ weakness engine ใน Competitor Intelligence ล็อก `exploitability`
ไว้ที่ 2 ตลอด ตราบใดที่ยังไม่มีข้อมูลห้องของ ASHER ในระบบมายืนยันว่าเราชนะจริง

## เริ่มใช้งาน

```bash
node server/server.js          # หรือ npm start
# PORT=8080 node server/server.js
npm test                       # เช็คว่าพร้อม deploy (17 เคส ยิงใส่ server จริง)
```

เปิด <http://localhost:8000/modules/asher-projects/>

ไม่มี dependency ภายนอก ต้องการแค่ Node 18 ขึ้นไป (ใช้ global `fetch`)

## โครงสร้าง

| ไฟล์ | หน้าที่ |
| --- | --- |
| `server/server.js` | static server + JSON API (พอร์ต 8000) |
| `server/store.js` | อ่าน/เขียน `data/asher-projects.json` แบบ atomic + normalize ค่า |
| `server/scraper.js` | โหลดหน้าเว็บ แปลง HTML เป็นข้อความ แล้วแกะค่าออกมา |
| `shared/asher-theme.css` | โทนสีกลางที่ใช้ร่วมกับโมดูลอื่น |
| `shared/asher-api.js` | ตัวเชื่อม API + สำรองร่างลง `localStorage` เวลา API ล่ม |
| `server/weakness.js` | กติกาหาจุดอ่อน + คิด severity × exploitability |
| `modules/asher-projects/` | หน้าใส่ข้อมูล |
| `modules/weakness-engine/` | หน้าอ้างอิงของ weakness engine (ยกไปต่อในแท็บ `#weakness` เดิมได้) |
| `data/asher-projects.json` | ข้อมูลฝั่งเรา |
| `data/competitors.json` | ข้อมูลฝั่งคู่แข่ง (schema เดียวกัน) |
| `data/weakness-actions.json` | บันทึกว่าเซลส์ใช้มุมไหน ผลเป็นยังไง |
| `data/sample-competitors.json` | คู่แข่งตัวอย่างของปุ่ม "ใส่ข้อมูลตัวอย่าง" |
| `test/smoke.js` | เทสก่อน deploy — auth, CORS, CRUD, gzip, graceful shutdown |
| `Dockerfile` | image สำหรับ deploy (ไม่ต้อง build step เพราะไม่มี dependency) |
| `db/` | schema ของ Inbox module ที่จะมาทีหลัง ยังไม่ถูกใช้โดย server ตัวนี้ |

## API

| Method | Endpoint | ใช้ทำอะไร |
| --- | --- | --- |
| GET | `/api/health` | เช็คว่า Local API ขึ้นอยู่ (แบดจ์ LIVE บนหัวเว็บอ่านจากนี่) |
| GET | `/api/asher/projects` | ดึงทุกโครงการ |
| POST | `/api/asher/projects` | เพิ่มโครงการใหม่ |
| GET · PUT · PATCH · DELETE | `/api/asher/projects/:id` | อ่าน/แทนที่/แก้บางช่อง/ลบ |
| GET | `/api/asher/rooms` | ผังห้องทุกโครงการแบบแบน — weakness engine ใช้ตัวนี้ |
| GET · POST | `/api/competitors` | คู่แข่งทั้งหมด / เพิ่มคู่แข่ง |
| GET · PUT · PATCH · DELETE | `/api/competitors/:id` | จัดการคู่แข่งรายโครงการ |
| GET | `/api/weakness` | สแกนจุดอ่อน คืน findings + summary + blockers |
| POST | `/api/weakness/actions` | บันทึกการตัดสินใจ คืนผลสแกนชุดใหม่ |
| POST | `/api/weakness/sample` | ใส่คู่แข่งตัวอย่างไว้ลองระบบ |
| POST | `/api/scrape` | `{"url": "..."}` หรือ `{"html": "..."}` |

## การดึงข้อมูลจากเว็บไซต์

ใส่ลิงก์ในช่อง **เว็บไซต์โครงการ** แล้วกด *ดึงข้อมูลจากเว็บไซต์* ระบบจะแกะ:

- ชื่อโครงการ · ทำเล · ราคาเริ่มต้น · ราคาต่อ ตร.ม. · จำนวนยูนิต · จำนวนชั้น · ปีที่แล้วเสร็จ
  (ปี พ.ศ. จะถูกแปลงเป็น ค.ศ. ให้)
- ความสูงฝ้า
- ผังห้อง (Studio / 1 Bedroom (S) / 1 Bedroom Plus / 2 Bedroom …) พร้อมขนาด ตร.ม. และราคา
- สิ่งอำนวยความสะดวก

ทุกค่าที่เดาได้จะมาพร้อม **ระดับความมั่นใจ** และ **หลักฐาน** ว่าเจอจากข้อความช่วงไหนของหน้าเว็บ

กติกาที่ระบบยึดไว้:

- **ไม่เขียนทับข้อมูลที่กรอกเองไว้แล้ว** — ช่องที่มีค่าอยู่จะไม่ถูกติ๊กให้ล่วงหน้า และขึ้นเตือน `⚠ จะทับค่าเดิม`
- ผังห้องที่ชื่อซ้ำกับของเดิมจะ *เติมเฉพาะช่องที่ยังว่าง* ไม่ทับของเดิม
- ทุกครั้งที่กดใส่ค่า จะบันทึกไว้ในหัวข้อ **ที่มาของข้อมูล** ว่าค่าไหนมาจากเว็บไหน ตอนไหน

### เว็บที่ render ด้วย JavaScript

Scraper อ่าน HTML ที่ server ส่งมาเท่านั้น ไม่รัน JavaScript ถ้าดึงแล้วได้ข้อความน้อยผิดปกติ
ระบบจะเตือนให้ใช้ปุ่ม **วาง HTML เอง** แทน (เปิดหน้าเว็บ → View Page Source หรือ Copy outerHTML → วาง)

### ความปลอดภัย

`/api/scrape` ยอมเฉพาะ `http://` / `https://` ที่ปลายทางเป็น IP สาธารณะ — ยิงเข้า `localhost`,
`10.x`, `192.168.x`, link-local ไม่ได้ (กัน SSRF) และเช็คซ้ำทุก redirect
ถ้าต้องดึงจาก staging ในวงแลนตัวเอง สั่ง `ASHER_ALLOW_PRIVATE_HOSTS=1 node server/server.js`

API ทั้งชุดแก้และลบข้อมูลได้โดยไม่ต้องยืนยันตัวตน **ตราบใดที่ยังไม่ตั้ง `ASHER_API_TOKEN`**
บนเครื่องตัวเองไม่เป็นไรเพราะฟังแค่ `127.0.0.1` แต่พอ deploy ออกไปต้องตั้งเสมอ — ดูหัวข้อถัดไป

## เวลา Local API ไม่ทำงาน

แบดจ์บนหัวเว็บจะเป็น `LOCAL API · OFFLINE` และการกดบันทึกจะเก็บร่างไว้ใน `localStorage` ของเบราว์เซอร์
พอเปิด server แล้วรีเฟรช จะมีแถบให้กด **ซิงก์ขึ้น Local API** เพื่อเก็บลงไฟล์จริง
(การดึงข้อมูลจากเว็บไซต์ต้องมี server เท่านั้น เพราะเบราว์เซอร์ยิงข้ามโดเมนเองไม่ได้)

## Weakness Engine

เปิด <http://localhost:8000/modules/weakness-engine/>

```
priority = severity × exploitability
```

| ตัวแปร | มาจากไหน |
| --- | --- |
| `severity` | ข้อมูลคู่แข่งเทียบมาตรฐานตลาด — รู้ได้โดยไม่ต้องมีข้อมูลเรา |
| `exploitability` | **ล็อกไว้ที่ 2** จนกว่าห้องของ ASHER ใน `/api/asher/rooms` จะยืนยันว่าเราชนะมิตินั้นจริง |

กติกาที่สแกน (`server/weakness.js`):

| กติกา | เจอเมื่อ | ปลดล็อกด้วย |
| --- | --- | --- |
| `room-size` | ห้องเล็กกว่ามาตรฐาน (Studio 26 · 1BR 30 · 2BR 50 · 3BR 75 ตร.ม.) | ห้อง ASHER คลาสเดียวกันที่ใหญ่กว่า |
| `ceiling-height` | ฝ้าต่ำกว่า 2.70 ม. | ห้อง ASHER ที่ฝ้าสูงกว่า |
| `price-per-sqm` | ราคาต่อ ตร.ม. สูงกว่าค่ากลางของคู่แข่ง (ต้องมีอย่างน้อย 3 ผัง) | ห้อง ASHER ที่ถูกกว่าต่อ ตร.ม. |
| `facility-gap` | ไม่มีส่วนกลางหลักที่ตลาดคาดหวัง | โครงการ ASHER ที่มีส่วนกลางนั้น |
| `unit-density` | ยูนิตต่อชั้นเกิน 20 | โครงการ ASHER ที่ยูนิตต่อชั้นน้อยกว่า |

`exploitability` หลังพิสูจน์ได้จะอยู่ที่ 3–5 ตามขนาดของส่วนต่าง (ยิ่งชนะขาดยิ่งสูง)
แต่ละ finding คืน `evidence` (หลักฐานฝั่งคู่แข่ง) · `proof` (หลักฐานฝั่งเรา) · `angle` (มุมโจมตี)
· `openQuestion` (คำถามเปิดที่ให้ลูกค้าคิดเอง) · `doNotSay` (สิ่งที่ห้ามพูด)

การตัดสินใจของเซลส์ (`ใช้มุมนี้` / `ตัดทิ้ง` / `คืนค่า` และผล `ชนะ` / `แพ้` / `ไม่มีผล`)
เก็บที่ `data/weakness-actions.json` ผูกกับ id ของ finding ที่คงที่ข้ามการสแกน

## ต่อเข้ากับโมดูลอื่น

เพิ่มลิงก์ในเมนูข้าง ใต้กลุ่ม **DATA & MEASUREMENT**:

```html
<a href="/modules/asher-projects/index.html">ใส่ข้อมูล ASHER</a>
```

ต่อแท็บ `#weakness` ในหน้า Competitor Intelligence เดิมเข้ากับ engine — เรียกที่เดียวได้ครบ
ทั้งการ์ด สถิติ และ blockers ไม่ต้องคำนวณเองในหน้า:

```html
<link rel="stylesheet" href="/shared/asher-theme.css">   <!-- คลาส .weak-card, .weak-row -->
<script src="/shared/asher-api.js"></script>
```

```js
const data = await AsherAPI.getWeakness();

data.summary;   // { ready, interesting, used, won, locked, dismissed } -> 4 ตัวเลขบนหัวแท็บ
data.blockers;  // ข้อความในกล่องเหลือง "ต้องแก้ก่อนถึงจะใช้ได้เต็มที่"
data.findings;  // เรียง priority มาก -> น้อย มาแล้ว

for (const f of data.findings) {
  f.priority;            // severity x exploitability
  f.locked;              // true = ยังไม่มีข้อมูลห้อง ASHER มาพิสูจน์
  f.potentialPriority;   // ตัวเลขที่จะได้ถ้าพิสูจน์ได้ (ใช้ในข้อความ "จะขึ้นเป็น 20")
  f.evidence; f.proof; f.angle; f.openQuestion; f.doNotSay;
}

// ปุ่มในการ์ด — ทุกตัวคืนผลสแกนชุดใหม่มาให้ render ต่อได้เลย
await AsherAPI.setWeaknessAction({ id: f.id, status: 'used' });
await AsherAPI.setWeaknessAction({ id: f.id, outcome: 'won' });
await AsherAPI.setWeaknessAction({ id: f.id, reset: true });
```

ถ้าอยากคิดเองในหน้าเดิม ดึงห้องของเราตรง ๆ ได้ที่:

```js
const { rooms } = await fetch('/api/asher/rooms').then((r) => r.json());
const proven = rooms.filter((room) => room.sizeSqm);
```

ถ้าหน้าโมดูลถูกเสิร์ฟคนละพอร์ตกับ API ให้ระบุ base ได้ทาง `?api=http://localhost:8000`
(ค่าจะถูกจำไว้ใน `localStorage`)

## Deploy

```bash
npm test                                     # ต้องผ่านครบก่อน
docker build -t asher .
docker run -d --name asher -p 8000:8000 \
  -v asher-data:/data \
  -e ASHER_API_TOKEN="$(openssl rand -hex 24)" \
  -e ASHER_ALLOWED_ORIGINS=https://workspace.example.com \
  asher
```

ไม่ใช้ Docker ก็ได้ — `node server/server.js` พร้อมตัวแปรชุดเดียวกัน

| ตัวแปร | ค่าเริ่มต้น | ต้องตั้งตอน deploy ไหม |
| --- | --- | --- |
| `PORT` | `8000` | ตามที่ platform กำหนด |
| `HOST` | `127.0.0.1` | **ต้อง** เป็น `0.0.0.0` ไม่งั้นข้างนอก container เข้าไม่ถึง (Dockerfile ตั้งให้แล้ว) |
| `ASHER_DATA_DIR` | `./data` | **ต้อง** ชี้ไป volume ที่อยู่รอด ไม่งั้นข้อมูลหายทุกครั้งที่ deploy |
| `ASHER_API_TOKEN` | ไม่ตั้ง = ไม่ต้องยืนยันตัวตน | **ต้อง** ตั้ง |
| `ASHER_ALLOWED_ORIGINS` | ไม่ตั้ง = same-origin เท่านั้น | ตั้งเมื่อมีหน้าเว็บคนละโดเมนเรียกเข้ามา |
| `ASHER_ALLOW_PRIVATE_HOSTS` | ปิด | **อย่าเปิด** บน production |

### สามข้อที่พลาดแล้วเจ็บ

1. **ไม่ตั้ง `ASHER_API_TOKEN`** — ทุก endpoint รวมถึง `DELETE` เปิดให้ทุกคน และ `/api/scrape`
   จะกลายเป็น proxy ให้คนอื่นใช้ยิงเว็บอื่นในนามเรา server จะเตือนใน log ตอนบูตถ้าฟังทุก
   interface โดยไม่มี token
2. **ไม่ mount volume ที่ `ASHER_DATA_DIR`** — ข้อมูลอยู่ในไฟล์ JSON ไม่ใช่ฐานข้อมูล
   filesystem ของ container หายทุกครั้งที่ deploy ใหม่
3. **ครอบ shell ทับ `CMD`** — ทำให้ `SIGTERM` ไปไม่ถึง node แล้ว graceful shutdown ไม่ทำงาน
   งานเขียนที่ค้างอยู่จะหาย Dockerfile จึงใช้ `CMD ["node", ...]` แบบไม่มี shell

### token ฝั่งหน้าเว็บ

หน้าโมดูลจะถาม token ครั้งแรกที่โดน 401 แล้วจำไว้ใน `localStorage` ส่งลิงก์พร้อม token
ให้ทีมได้ด้วย `?token=...` (ระบบจะลบออกจากแถบที่อยู่ให้เองหลังเก็บแล้ว)

### ที่ platform ต้องรู้

| | |
| --- | --- |
| health check | `GET /api/health` — ตอบ 200 โดยไม่ต้องมี token (ตัวเลขธุรกิจโผล่เฉพาะเมื่อมี token) |
| สัญญาณปิด | `SIGTERM` → หยุดรับ request ใหม่ รอเขียนไฟล์ให้จบ แล้วออกด้วย code 0 (บังคับออกที่ 10 วินาที) |
| ไฟล์ static | มี ETag + gzip ให้แล้ว (`app.js` 32KB → 7.9KB) ไม่ต้องมี CDN ก็ได้ |
| ขนาด body สูงสุด | 5MB (เผื่อวาง HTML ทั้งหน้ามาให้แกะ) |
