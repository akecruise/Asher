-- ทดสอบสัญญาของ 001_inbox.sql — รันบน DB เปล่าที่ apply migration แล้ว
--   createdb asher_test && psql -d asher_test -f db/migrations/001_inbox.sql
--   psql -d asher_test -v ON_ERROR_STOP=1 -f db/smoke-test.sql
\set ON_ERROR_STOP on

-- 1. รับ event ปกติ -> ได้ทั้ง event และ inbox item
select 'case 1: ingest' as case, event_id is not null as has_event, item_id is not null as has_item,
       is_duplicate
from ingest_lead('line', 'msg-001', '{}'::jsonb,
  '{"source":{"displayName":"คุณเอ"},"message":{"text":"สนใจ 1 นอนครับ"}}'::jsonb) \gset r1_
select :'r1_has_event' = 't' and :'r1_has_item' = 't' and :'r1_is_duplicate' = 'f'
       as "case 1 ผ่าน (ได้ทั้ง event และ item)";

-- 2. ผู้ส่ง retry ตัวเดิม -> ต้องไม่เกิดแถวใหม่ และต้องบอกว่าซ้ำ
select is_duplicate from ingest_lead('line', 'msg-001', '{}'::jsonb,
  '{"source":{"displayName":"คุณเอ"},"message":{"text":"สนใจ 1 นอนครับ"}}'::jsonb) \gset r2_
select :'r2_is_duplicate' = 't' as "case 2 ผ่าน (retry ถูกจับว่าซ้ำ)",
       (select count(*) = 1 from webhook_events where external_id = 'msg-001') as "ไม่มี event ซ้ำ",
       (select count(*) = 1 from inbox_items   where external_id = 'msg-001') as "ไม่มี item ซ้ำ";

-- 3. normalize ถูกช่อง
select display_name = 'คุณเอ' and message = 'สนใจ 1 นอนครับ' as "case 3 ผ่าน (normalize LINE ถูก)"
from inbox_items where external_id = 'msg-001';

-- 4. Meta lead ads สองจังหวะ: webhook มาแค่ id ยังไม่มี item
select event_id from ingest_lead('meta_lead', 'leadgen-777', '{}'::jsonb,
  '{"leadgen_id":"leadgen-777"}'::jsonb, true) \gset r4_
select (select status = 'pending_fetch' from webhook_events where id = :r4_event_id)
         as "case 4 ผ่าน (ค้างที่ pending_fetch)",
       (select count(*) = 0 from inbox_items where external_id = 'leadgen-777')
         as "ยังไม่สร้าง item";

-- 5. ดึงข้อมูลจริงจาก Graph API สำเร็จ -> เกิด item และเรียกซ้ำได้ไม่พัง
select complete_lead_fetch(:r4_event_id,
  '{"field_data":{"full_name":"คุณบี","phone_number":"0812345678"},"campaign_name":"Naii Q3"}'::jsonb) \gset r5a_
select complete_lead_fetch(:r4_event_id,
  '{"field_data":{"full_name":"คุณบี","phone_number":"0812345678"},"campaign_name":"Naii Q3"}'::jsonb) \gset r5b_
select :r5a_complete_lead_fetch = :r5b_complete_lead_fetch as "case 5 ผ่าน (เรียกซ้ำได้ item เดิม)",
       (select count(*) = 1 from inbox_items where external_id = 'leadgen-777') as "มี item เดียว",
       (select phone = '0812345678' and campaign = 'Naii Q3'
          from inbox_items where external_id = 'leadgen-777') as "normalize Meta ถูก";

-- 6. ดึงไม่สำเร็จ -> นับ attempt ไว้ ครบ 5 ครั้งค่อยยอมแพ้
select event_id from ingest_lead('meta_lead', 'leadgen-888', '{}'::jsonb,
  '{"leadgen_id":"leadgen-888"}'::jsonb, true) \gset r6_
select fail_lead_fetch(:r6_event_id, 'Graph API 500');
select status = 'pending_fetch' and fetch_attempts = 1 as "case 6 ผ่าน (ยัง retry ต่อ)"
from webhook_events where id = :r6_event_id;
select fail_lead_fetch(:r6_event_id, 'x') from generate_series(1, 4);
select status = 'failed' and fetch_attempts = 5 as "case 6b ผ่าน (ครบ 5 ครั้งแล้วหยุด)"
from webhook_events where id = :r6_event_id;

-- 7. provider ที่ยังไม่มีกฎ normalize -> ยังต้องรับเข้าระบบ ไม่ทิ้ง lead
select item_id is not null as "case 7 ผ่าน (provider ใหม่ยังรับได้)"
from ingest_lead('tiktok', 'tt-1', '{}'::jsonb, '{"whatever":1}'::jsonb);

-- 8. ปฏิเสธ input ที่ไม่มี external_id
do $$
begin
  begin
    perform ingest_lead('line', '', '{}'::jsonb, '{}'::jsonb);
    raise exception 'case 8 ตก: ควร error แต่ผ่านไปได้';
  exception when others then
    if sqlerrm like '%external_id%' then
      raise notice 'case 8 ผ่าน (ปฏิเสธ external_id ว่าง)';
    else
      raise;
    end if;
  end;
end
$$;

-- 9. สิทธิ์: ingestion ห้ามอ่าน inbox_items และห้าม INSERT ตารางตรง ๆ
select has_table_privilege('inbox_ingest', 'inbox_items', 'select') = false
         as "case 9 ผ่าน (ingest อ่าน inbox_items ไม่ได้)",
       has_table_privilege('inbox_ingest', 'webhook_events', 'insert') = false
         as "ingest INSERT ตรง ๆ ไม่ได้",
       has_function_privilege('inbox_ingest',
         'ingest_lead(text,text,jsonb,jsonb,boolean)', 'execute') as "แต่เรียก function ได้";

-- 10. สิทธิ์: UI แก้ได้เฉพาะช่องของเซลส์
select has_column_privilege('inbox_ui', 'inbox_items', 'status', 'update')
         as "case 10 ผ่าน (UI แก้ status ได้)",
       has_column_privilege('inbox_ui', 'inbox_items', 'phone', 'update') = false
         as "UI แก้ phone ไม่ได้",
       has_table_privilege('inbox_ui', 'webhook_events', 'select') = false
         as "UI อ่าน payload ดิบไม่ได้";

-- 11. updated_at ขยับเองตอน UI แก้สถานะ
select updated_at as before from inbox_items where external_id = 'msg-001' \gset u_
update inbox_items set status = 'assigned' where external_id = 'msg-001';
select updated_at > :'u_before' as "case 11 ผ่าน (updated_at ขยับเอง)"
from inbox_items where external_id = 'msg-001';

-- 12. health view
select events_total = 4 and events_failed = 1 and seconds_since_last_event is not null
       as "case 12 ผ่าน (health view นับถูก)"
from inbox_health;
