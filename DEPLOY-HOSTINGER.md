# เอา ASHER Marketing Intelligence ขึ้น Hostinger

> อ่านหัวข้อ **ความเสี่ยง** ให้จบก่อน deploy — ระบบนี้เก็บราคาห้อง ข้อมูลคู่แข่ง
> และบันทึกกลยุทธ์การขาย ถ้าหลุดออกไปคือหลุดให้คู่แข่งดูฟรี ๆ

## ความเสี่ยงของเดิม และสิ่งที่แก้ไปแล้ว

ระบบเวอร์ชันแรกออกแบบมาให้รันบนเครื่องตัวเอง (`127.0.0.1`) เท่านั้น
เอาขึ้น host ตรง ๆ จะเจอ 8 เรื่องนี้:

| # | ความเสี่ยงเดิม | ผลถ้าไม่แก้ | แก้แล้วอย่างไร |
|---|---|---|---|
| 1 | ไม่มีระบบ login เลย | ใครเปิด URL เจอ ก็ **อ่าน/แก้/ลบ** ข้อมูลโครงการและคู่แข่งได้หมด | ต้อง login ด้วย `ASHER_PASSWORD` ทุก endpoint (ยกเว้นหน้า login) |
| 2 | `access-control-allow-origin: *` | เว็บไหนก็ได้สั่ง API แทนคนที่เปิดหน้าเราอยู่ | ตัด `*` ทิ้ง เหลือ same-origin + allowlist ผ่าน `ASHER_ALLOWED_ORIGINS` |
| 3 | ไม่มีการกัน CSRF | ลิงก์จากเว็บอื่นสั่งลบข้อมูลได้ | cookie เป็น `SameSite=Lax` + เช็ค `Origin` ทุกคำขอที่เปลี่ยนข้อมูล |
| 4 | เสิร์ฟไฟล์ทั้ง repo | โหลด `/data/asher-projects.json`, `/server/*.js`, `/.git/` ได้ตรง ๆ | เสิร์ฟเฉพาะ `/modules/` กับ `/shared/` และบล็อกทุก path ที่ขึ้นต้นด้วยจุด |
| 5 | ไม่มี rate limit | ยิงรัว ๆ จนไฟล์ข้อมูลพัง / เดารหัสผ่าน / host โดนระงับ | จำกัดต่อ IP: อ่าน 240, เขียน 60, scrape 12 ต่อนาที, login 10 ครั้ง/15 นาที |
| 6 | `/api/scrape` เปิดให้ทุกคน | คนอื่นเอา server เราไปเป็น proxy ยิงเว็บชาวบ้าน = โดน Hostinger ระงับบัญชี | ต้อง login ก่อน + rate limit + ปิดได้ด้วย `ASHER_ENABLE_SCRAPE=0` |
| 7 | ข้อมูลอยู่ใน `data/` ในโฟลเดอร์เว็บ | deploy ทับครั้งเดียว **ข้อมูลหายหมด** | ตั้ง `ASHER_DATA_DIR` ให้ชี้ออกนอกโฟลเดอร์เว็บ |
| 8 | ไม่มี security header / error พ่นรายละเอียดข้างใน | โดน clickjacking, XSS ง่ายขึ้น, เห็น path ภายใน server | เพิ่ม CSP, `X-Frame-Options`, `nosniff`, HSTS และ 500 ตอบแค่ `internal error` |

นอกจากนี้ **server จะไม่ยอมบูตเลย** ถ้าสั่งให้ bind นอก `127.0.0.1` โดยไม่ตั้งรหัสผ่าน
(fail closed — กันเผลอ deploy แบบเปิดโล่ง)

## Hostinger แบบไหนใช้ได้

| แพ็กเกจ | ใช้ได้ไหม | หมายเหตุ |
|---|---|---|
| Shared / Premium / Business Hosting | ได้ ถ้ามีเมนู **Node.js** ใน hPanel | รันได้แต่ process ถูก restart บ่อย ต้องตั้ง `ASHER_DATA_DIR` ให้ดี |
| Cloud Hosting | ได้ | เหมือนข้างบนแต่ทรัพยากรมากกว่า |
| VPS | ได้ และแนะนำที่สุด | คุม Node เวอร์ชัน, systemd/PM2, ไฟร์วอลล์ได้เอง |
| Website Builder / WordPress อย่างเดียว | **ไม่ได้** | รัน Node.js ไม่ได้ ระบบนี้ไม่ใช่เว็บ static ล้วน |

ต้องการ **Node.js 18 ขึ้นไป** (ใช้ global `fetch`)

## ขั้นตอน deploy

### 1. สุ่มรหัสผ่าน

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 2. เตรียมโฟลเดอร์ข้อมูลนอก webroot

```bash
mkdir -p ~/asher-data
cp data/*.json ~/asher-data/     # ย้ายข้อมูลเดิมไปด้วย ถ้ามี
chmod 700 ~/asher-data
```

ทำไมต้องอยู่นอกโฟลเดอร์เว็บ: การ deploy ของ Hostinger คือการเขียนทับโฟลเดอร์โปรเจกต์
ถ้าข้อมูลอยู่ใน `data/` ข้างใน ข้อมูลจะหายทุกครั้งที่ deploy

### 3. สร้างผู้ใช้

```bash
ASHER_DATA_DIR=~/asher-data npm run user -- add akecruise@gmail.com
ASHER_DATA_DIR=~/asher-data npm run user -- add aplusmkteam@gmail.com
```

ไม่ใส่ `--password` ระบบจะสุ่มรหัสให้และ **แสดงครั้งเดียว** — ส่งให้เจ้าตัวทางช่องทางส่วนตัว
เปลี่ยนทีหลังด้วย `npm run user -- passwd <email>` (session เดิมของคนนั้นถูกตัดทันที)
ผู้ใช้ถูกเก็บที่ `$ASHER_DATA_DIR/users.json` เป็น scrypt hash สิทธิ์ไฟล์ 0600

### 4. ตั้งค่า environment variables

ใน hPanel → **Advanced → Node.js → Environment variables** (หรือไฟล์ `.env` บน VPS)

```
ASHER_DATA_DIR=/home/USERNAME/asher-data
ASHER_TRUST_PROXY=1
ASHER_COOKIE_SECURE=1
ASHER_PASSWORD=<รหัสฉุกเฉิน ตั้งไว้ก็ดี ไว้กู้ตอนถูกล็อกออก>
```

### 5. ชี้ startup file และเปิด HTTPS

- Application startup file: `server/server.js`
- เปิด **SSL / Let's Encrypt** และ **Force HTTPS** ใน hPanel ก่อนใช้งานจริงเสมอ
  (ไม่มี HTTPS = รหัสผ่านกับ session cookie วิ่งเป็น plaintext)

### 6. ตรวจว่าปิดสนิทจริง

หลัง deploy เปิด URL พวกนี้ในหน้าต่าง incognito — ต้อง **ไม่เห็นข้อมูล** ทุกอัน:

```
https://โดเมนของคุณ/data/asher-projects.json   -> 404
https://โดเมนของคุณ/api/asher/projects          -> 401
https://โดเมนของคุณ/modules/asher-projects/     -> เด้งไปหน้า login
https://โดเมนของคุณ/.git/config                 -> 404
```

หรือรันชุดทดสอบบนเครื่องตัวเอง:

```bash
npm test
```

## บน VPS: รันเป็น service

```ini
# /etc/systemd/system/asher.service
[Unit]
Description=ASHER Marketing Intelligence
After=network.target

[Service]
Type=simple
User=asher
WorkingDirectory=/var/www/asher
Environment=HOST=127.0.0.1
Environment=PORT=8000
Environment=ASHER_TRUST_PROXY=1
Environment=ASHER_COOKIE_SECURE=1
EnvironmentFile=/etc/asher.env
ExecStart=/usr/bin/node server/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

ให้ Node ฟังที่ `127.0.0.1` แล้วให้ Nginx ทำ TLS + proxy เข้ามา จะปลอดภัยกว่า
เปิด Node ออกอินเทอร์เน็ตตรง ๆ:

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## สำรองข้อมูล

ไฟล์ JSON ไม่มีระบบ backup ในตัว ตั้ง cron ไว้:

```bash
0 2 * * * tar czf ~/backup/asher-$(date +\%F).tar.gz -C ~/asher-data . && find ~/backup -name 'asher-*.tar.gz' -mtime +30 -delete
```

## ความเสี่ยงที่ยังเหลืออยู่ (รู้ไว้ ไม่ได้แก้ในโค้ด)

1. **ทุกคนที่ login ได้ มีสิทธิ์เท่ากันหมด** — ยังไม่มีการแบ่ง role (อ่านอย่างเดียว / แก้ได้ / แอดมิน)
   ใครก็ลบโครงการได้ ระบบจดแค่ `updatedBy` กับ log ตอนลบ ไม่ได้เก็บประวัติการแก้แบบย้อนดูได้
2. **เปลี่ยนรหัสผ่านเองไม่ได้** — ต้องให้คนที่เข้า server ได้รัน `npm run user -- passwd <email>` ให้
   (ทีมเล็กพอไหว ถ้าคนเยอะขึ้นค่อยทำหน้าเปลี่ยนรหัสผ่านเพิ่ม)
3. **DNS rebinding ที่ `/api/scrape`** — เราเช็ค IP ตอน resolve แต่โดเมนอาจเปลี่ยน IP
   ระหว่างที่ `fetch` ต่อจริง ความเสี่ยงต่ำเพราะต้อง login ก่อน แต่ถ้าไม่ได้ใช้ฟีเจอร์นี้
   ปิดไปเลยด้วย `ASHER_ENABLE_SCRAPE=0`
4. **rate limit เก็บใน memory ของ process เดียว** — ถ้ารันหลาย instance ต้องกันที่ proxy อีกชั้น
   และตัวนับจะรีเซ็ตทุกครั้งที่ Hostinger restart process
5. **ข้อมูลเป็นไฟล์ JSON ไม่ใช่ฐานข้อมูล** — โหลดหนัก ๆ พร้อมกันหลายคนจะช้า
   ถ้าทีมโตกว่า 5-10 คน ควรย้ายไปใช้ฐานข้อมูลจริง
6. **การ scrape เว็บคู่แข่ง** — ตรวจ robots.txt และเงื่อนไขการใช้งานของเว็บปลายทางเองด้วย
   ยิงถี่เกินไปอาจโดนบล็อก IP ของ host หรือเข้าข่ายผิดเงื่อนไขบริการของ Hostinger
