# Inbox — สัญญากลางระหว่าง Node ingestion กับ Next.js UI

```
webhook  ──►  Node ingestion  ──►  Postgres  ◄──  Next.js (Sales Workspace)
              verify + เรียก        logic อยู่ที่นี่      อ่าน/แก้ inbox_items
              function เท่านั้น
```

| ไฟล์ | ใช้ทำอะไร |
| --- | --- |
| `migrations/001_inbox.sql` | ตาราง + function + role ทั้งหมดของ Inbox |
| `smoke-test.sql` | ทดสอบสัญญา 12 เคส — ผ่านหมดบน Postgres 16 |

```bash
createdb asher_dev
psql -d asher_dev -v ON_ERROR_STOP=1 -f db/migrations/001_inbox.sql
psql -d asher_dev -v ON_ERROR_STOP=1 -f db/smoke-test.sql   # ต้องไม่มี f สักช่อง
```

## สองตาราง

- **`webhook_events`** — payload ดิบ append-only ไม่มีใครลบ ถ้า normalize ผิด (ซึ่งรอบแรก
  จะผิด) replay จากตรงนี้ได้ ถ้าไม่เก็บไว้ = lead หายถาวร
- **`inbox_items`** — แถวที่เซลส์เห็นบนหน้าจอ

`unique (provider, external_id)` อยู่บนทั้งสองตาราง — webhook ทุกเจ้าเป็น at-least-once
การ retry ของผู้ส่งจึงไม่ทำให้เกิดแถวซ้ำ

## ฝั่ง Node เรียกอะไรบ้าง

```js
// 1. ต้อง verify บน raw bytes — parse JSON ก่อนแล้วลายเซ็นจะพังไม่สม่ำเสมอ
const raw = await readRawBody(req);              // Buffer ห้าม JSON.parse ก่อน
if (!verifySignature(raw, req.headers['x-hub-signature-256'])) return res.writeHead(401).end();

// 2. เขียนลง DB ผ่าน function ตัวเดียว เรียกซ้ำได้ผลเท่าเดิม
const { rows: [r] } = await db.query(
  'select * from ingest_lead($1, $2, $3, $4, $5)',
  [provider, externalId, JSON.stringify(safeHeaders), raw.toString('utf8'), needsFetch]
);

// 3. ตอบ 200 เสมอเมื่อรับไว้ได้ รวมถึงตอนซ้ำ ไม่งั้นผู้ส่งจะ retry ไม่เลิก
res.writeHead(200).end();
```

Meta lead ads เป็นสองจังหวะ เพราะ webhook ส่งมาแค่ `leadgen_id` ไม่มีข้อมูลลูกค้า:

```js
ingest_lead(..., needsFetch = true)   // ค้างไว้ที่ status = 'pending_fetch'
// worker ยิง Graph API แล้วส่งกลับเข้ามา
complete_lead_fetch(eventId, fetchedPayload)   // สำเร็จ -> เกิด inbox_item
fail_lead_fetch(eventId, errorText)            // ล้มเหลว -> ครบ 5 ครั้งจึงเป็น 'failed'
```

## สิทธิ์: สองฝั่งไม่เท่ากัน

`inbox_ingest` เปิดรับ internet ตรง ๆ จึง **ไม่มีสิทธิ์ตารางเลย** เรียกได้เฉพาะ
`ingest_lead` / `complete_lead_fetch` / `fail_lead_fetch` (security definer)
อ่าน `inbox_items` ไม่ได้ INSERT ตรง ๆ ไม่ได้ — endpoint สาธารณะจะได้ไม่ถือสิทธิ์ระดับ admin

`inbox_ui` แก้ได้เฉพาะ `status` / `assigned_to` / `note` และมองไม่เห็น payload ดิบ

> Supabase: เปลี่ยน `inbox_items.assigned_to` เป็น `references auth.users (id)` แล้วเพิ่ม RLS
> ทับ grant ชุดนี้ ตัว grant ระดับคอลัมน์ยังเป็นชั้นล่างสุดที่ RLS พลาดแล้วยังกันได้อยู่

## logic อยู่ใน function ไม่ใช่ trigger

`normalize_payload(provider, payload)` แยกออกมาเป็น function ของตัวเอง เพื่อให้ replay
ของเก่าได้เมื่อกฎเปลี่ยน provider ที่ยังไม่มีกฎจะรับเข้าระบบไว้ก่อนโดยช่องว่าง — ไม่ทิ้ง lead

trigger ในระบบนี้มีตัวเดียวคือ `updated_at` ตั้งใจไม่เอา business logic ไปไว้ใน trigger
เพราะมันไม่โผล่ใน log ของฝั่งไหนเลยและพังเงียบ ๆ ตอน migration

## monitoring: ดูสามค่านี้พอ

```sql
select * from inbox_health;
```

| ค่า | หมายความว่า |
| --- | --- |
| `events_failed` | ดึงข้อมูลจาก Graph API ไม่สำเร็จจนหมด retry |
| `events_pending_fetch` | ค้างคิว ถ้าค้างนานคือ worker ตาย |
| `seconds_since_last_event` | **ตัวสำคัญที่สุด** — เงียบผิดปกติคือ pipeline ตายแบบไม่มี error ซึ่งไม่มี alert ตัวไหนจับได้เอง |

## ลำดับ deploy

1. รัน migration บน Postgres จริง
2. ขึ้น Node ingestion — ยิง webhook ทดสอบเข้าไป ดูว่าแถวเข้า `webhook_events`
3. ขึ้นหน้า Inbox ใน Next.js อ่าน `inbox_items` (polling ทุก 10 วิพอสำหรับรอบแรก
   ยังไม่ต้องลง realtime)
4. ค่อยเปิด provider ที่สอง

migration ควรอยู่รีโปเดียวและเป็นฝั่งที่ deploy ถี่กว่า ส่วน ingestion ให้ระบุชื่อคอลัมน์เสมอ
จะได้ deploy ไม่พร้อมกันโดยไม่พัง
