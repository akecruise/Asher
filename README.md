# ASHER Marketing Intelligence — ระบบใส่ข้อมูลโครงการ

โมดูลสำหรับกรอกข้อมูลจริงของ **ASHER Naii** และ **ASHER Vibe** พร้อมช่องใส่ลิงก์เว็บไซต์
ให้ระบบดึงข้อมูล (scraping) มาเดาค่าให้ก่อน แล้วคนค่อยยืนยันทีละช่อง

ที่ต้องมีโมดูลนี้เพราะ weakness engine ใน Competitor Intelligence ล็อก `exploitability`
ไว้ที่ 2 ตลอด ตราบใดที่ยังไม่มีข้อมูลห้องของ ASHER ในระบบมายืนยันว่าเราชนะจริง

## เริ่มใช้งาน

```bash
node server/server.js          # หรือ npm start
# PORT=8080 node server/server.js
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
| `modules/asher-projects/` | หน้าใส่ข้อมูล |
| `data/asher-projects.json` | ข้อมูลจริง (commit ได้ ถ้าอยากให้ทีมเห็นเหมือนกัน) |

## API

| Method | Endpoint | ใช้ทำอะไร |
| --- | --- | --- |
| GET | `/api/health` | เช็คว่า Local API ขึ้นอยู่ (แบดจ์ LIVE บนหัวเว็บอ่านจากนี่) |
| GET | `/api/asher/projects` | ดึงทุกโครงการ |
| POST | `/api/asher/projects` | เพิ่มโครงการใหม่ |
| GET · PUT · PATCH · DELETE | `/api/asher/projects/:id` | อ่าน/แทนที่/แก้บางช่อง/ลบ |
| GET | `/api/asher/rooms` | ผังห้องทุกโครงการแบบแบน — ให้โมดูลอื่นเรียกไปใช้ |
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

## เวลา Local API ไม่ทำงาน

แบดจ์บนหัวเว็บจะเป็น `LOCAL API · OFFLINE` และการกดบันทึกจะเก็บร่างไว้ใน `localStorage` ของเบราว์เซอร์
พอเปิด server แล้วรีเฟรช จะมีแถบให้กด **ซิงก์ขึ้น Local API** เพื่อเก็บลงไฟล์จริง
(การดึงข้อมูลจากเว็บไซต์ต้องมี server เท่านั้น เพราะเบราว์เซอร์ยิงข้ามโดเมนเองไม่ได้)

## ต่อเข้ากับโมดูลอื่น

เพิ่มลิงก์ในเมนูข้าง ใต้กลุ่ม **DATA & MEASUREMENT**:

```html
<a href="/modules/asher-projects/index.html">ใส่ข้อมูล ASHER</a>
```

ให้ weakness engine อ่านห้องของเราไปใช้ปลดล็อก exploitability:

```js
const { rooms } = await fetch('/api/asher/rooms').then((r) => r.json());
const ourRooms = rooms.filter((room) => room.sizeSqm);
// ถ้ามีห้องเราที่ขนาดชนะห้องคู่แข่งในหลักฐาน -> ปลด exploitability ออกจากเพดาน 2
```

ถ้าหน้าโมดูลถูกเสิร์ฟคนละพอร์ตกับ API ให้ระบุ base ได้ทาง `?api=http://localhost:8000`
(ค่าจะถูกจำไว้ใน `localStorage`)
