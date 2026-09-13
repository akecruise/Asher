-- 001_inbox.sql — สัญญากลางของ Inbox module
--
-- ใช้ร่วมกันสองฝั่ง:
--   Node ingestion  : verify ลายเซ็น -> select ingest_lead(...) -> ตอบ 200
--   Next.js UI      : select/update inbox_items ผ่าน role ของตัวเอง
--
-- หลักที่ยึด
--   1. เก็บ payload ดิบไว้เสมอ (webhook_events) normalize ผิดเมื่อไหร่ replay ได้
--   2. ทุกอย่าง idempotent — webhook ทุกเจ้าเป็น at-least-once
--   3. logic อยู่ใน function ที่ถูกเรียกชัด ๆ ไม่ใช่ trigger (trigger มีแค่ updated_at)
--   4. ingestion ไม่มีสิทธิ์แตะตารางตรง ๆ เรียกได้แค่ function

begin;

/* ------------------------------- tables ------------------------------- */

-- append-only: ไม่มีใครแก้ ไม่มีใครลบ
create table if not exists webhook_events (
  id             bigserial primary key,
  provider       text        not null,   -- 'line' | 'meta_lead' | 'telegram'
  external_id    text        not null,   -- id ที่ผู้ส่งให้มา ใช้กันซ้ำ
  received_at    timestamptz not null default now(),
  headers        jsonb       not null default '{}'::jsonb,
  payload        jsonb       not null,
  -- pending_fetch: รู้แค่ id ต้องยิงกลับไปดึงข้อมูลจริง (เคสของ Meta lead ads)
  status         text        not null default 'received'
                 check (status in ('received', 'pending_fetch', 'processed', 'failed')),
  fetch_attempts int         not null default 0,
  last_error     text,
  processed_at   timestamptz,
  constraint webhook_events_provider_external_id_key unique (provider, external_id)
);

comment on table webhook_events is 'payload ดิบจาก webhook — append-only ห้าม UPDATE นอกจากคอลัมน์สถานะ';

-- คิวงานที่ยังค้าง: index เฉพาะแถวที่ยังไม่จบ ไม่บวมตามจำนวน event ทั้งหมด
create index if not exists webhook_events_open_idx
  on webhook_events (status, received_at)
  where status <> 'processed';

create table if not exists inbox_items (
  id           bigserial   primary key,
  event_id     bigint      not null references webhook_events (id),
  provider     text        not null,
  external_id  text        not null,
  received_at  timestamptz not null,
  display_name text,
  phone        text,
  email        text,
  message      text,
  campaign     text,
  project_id   text,                     -- ต่อกับ data/asher-projects.json ทีหลัง
  status       text        not null default 'new'
               check (status in ('new', 'assigned', 'contacted', 'won', 'lost')),
  assigned_to  uuid,                     -- Supabase: เปลี่ยนเป็น references auth.users (id)
  note         text        not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint inbox_items_provider_external_id_key unique (provider, external_id)
);

-- หน้า Inbox เรียงตามเวลาที่เข้ามา กรองด้วยสถานะ
create index if not exists inbox_items_status_received_idx
  on inbox_items (status, received_at desc);

/* ------------------------------ trigger -------------------------------- */
-- trigger มีตัวเดียวเท่านั้น และไม่มี business logic อยู่ในนี้

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists inbox_items_set_updated_at on inbox_items;
create trigger inbox_items_set_updated_at
  before update on inbox_items
  for each row execute function set_updated_at();

/* ----------------------------- normalize ------------------------------- */
-- payload ของแต่ละเจ้า -> คอลัมน์ของเรา
-- แยกออกมาเป็น function ของตัวเองเพื่อให้ replay ของเก่าได้:
--   select normalize_payload(provider, payload) from webhook_events where ...

create or replace function normalize_payload(p_provider text, p_payload jsonb)
returns table (display_name text, phone text, email text, message text, campaign text)
language plpgsql immutable as $$
begin
  if p_provider = 'line' then
    return query select
      p_payload #>> '{source,displayName}',
      null::text,
      null::text,
      p_payload #>> '{message,text}',
      null::text;

  elsif p_provider = 'meta_lead' then
    -- payload ที่ complete_lead_fetch เติมเข้ามาแล้ว (field_data ของ Graph API)
    return query select
      p_payload #>> '{field_data,full_name}',
      p_payload #>> '{field_data,phone_number}',
      p_payload #>> '{field_data,email}',
      null::text,
      p_payload #>> '{campaign_name}';

  elsif p_provider = 'telegram' then
    return query select
      trim(concat_ws(' ',
        p_payload #>> '{message,from,first_name}',
        p_payload #>> '{message,from,last_name}')),
      null::text,
      null::text,
      p_payload #>> '{message,text}',
      null::text;

  else
    -- provider ใหม่ที่ยังไม่ได้เขียนกฎ: ยังรับเข้าระบบ แล้วค่อย replay ทีหลัง
    return query select null::text, null::text, null::text, null::text, null::text;
  end if;
end;
$$;

/* ------------------------------- ingest -------------------------------- */
-- Node เรียกตัวนี้ตัวเดียว ต้องเรียกซ้ำได้ผลเท่าเดิมเสมอ
-- คืน is_duplicate = true เมื่อเจอ event เดิม (retry ของผู้ส่ง) — ฝั่ง Node ตอบ 200 เหมือนกัน

create or replace function ingest_lead(
  p_provider      text,
  p_external_id   text,
  p_headers       jsonb,
  p_payload       jsonb,
  p_needs_fetch   boolean default false
)
returns table (event_id bigint, item_id bigint, is_duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_event_id bigint;
  v_item_id  bigint;
  v_dup      boolean := false;
  v_norm     record;
begin
  if coalesce(trim(p_provider), '') = '' or coalesce(trim(p_external_id), '') = '' then
    raise exception 'ต้องมี provider และ external_id';
  end if;

  insert into webhook_events (provider, external_id, headers, payload, status)
  values (p_provider, p_external_id, coalesce(p_headers, '{}'::jsonb), p_payload,
          case when p_needs_fetch then 'pending_fetch' else 'received' end)
  on conflict (provider, external_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    v_dup := true;
    select id into v_event_id
      from webhook_events
     where provider = p_provider and external_id = p_external_id;
    select id into v_item_id
      from inbox_items
     where provider = p_provider and external_id = p_external_id;
    return query select v_event_id, v_item_id, v_dup;
    return;
  end if;

  -- ยังไม่มีข้อมูลจริง รอ complete_lead_fetch มาสร้าง item ให้
  if p_needs_fetch then
    return query select v_event_id, null::bigint, v_dup;
    return;
  end if;

  select * into v_norm from normalize_payload(p_provider, p_payload);

  insert into inbox_items (event_id, provider, external_id, received_at,
                           display_name, phone, email, message, campaign)
  values (v_event_id, p_provider, p_external_id, now(),
          v_norm.display_name, v_norm.phone, v_norm.email, v_norm.message, v_norm.campaign)
  on conflict (provider, external_id) do nothing
  returning id into v_item_id;

  update webhook_events
     set status = 'processed', processed_at = now()
   where id = v_event_id;

  return query select v_event_id, v_item_id, v_dup;
end;
$$;

-- ขั้นที่สองของ Meta lead ads: webhook ส่งมาแค่ leadgen_id
-- ingestion ยิง Graph API ดึงข้อมูลจริงแล้วส่งกลับเข้ามาที่นี่ เรียกซ้ำได้

create or replace function complete_lead_fetch(
  p_event_id bigint,
  p_payload  jsonb
)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_event record;
  v_item_id bigint;
  v_norm record;
begin
  select * into v_event from webhook_events where id = p_event_id;
  if v_event is null then
    raise exception 'ไม่พบ event %', p_event_id;
  end if;

  update webhook_events
     set payload = p_payload, status = 'processed', processed_at = now(), last_error = null
   where id = p_event_id;

  select * into v_norm from normalize_payload(v_event.provider, p_payload);

  insert into inbox_items (event_id, provider, external_id, received_at,
                           display_name, phone, email, message, campaign)
  values (p_event_id, v_event.provider, v_event.external_id, v_event.received_at,
          v_norm.display_name, v_norm.phone, v_norm.email, v_norm.message, v_norm.campaign)
  on conflict (provider, external_id) do nothing
  returning id into v_item_id;

  if v_item_id is null then
    select id into v_item_id
      from inbox_items
     where provider = v_event.provider and external_id = v_event.external_id;
  end if;

  return v_item_id;
end;
$$;

create or replace function fail_lead_fetch(p_event_id bigint, p_error text)
returns void
language sql security definer set search_path = public as $$
  update webhook_events
     set fetch_attempts = fetch_attempts + 1,
         last_error = p_error,
         status = case when fetch_attempts + 1 >= 5 then 'failed' else 'pending_fetch' end
   where id = p_event_id;
$$;

/* ------------------------------- health -------------------------------- */
-- ตัวชี้วัดที่ต้องดูตั้งแต่วันแรก — โดยเฉพาะ seconds_since_last_event
-- เงียบผิดปกติ = pipeline ตายแบบไม่มี error ซึ่งไม่มี alert ตัวไหนจับได้เอง

create or replace view inbox_health as
select
  count(*)                                                as events_total,
  count(*) filter (where status = 'failed')               as events_failed,
  count(*) filter (where status = 'pending_fetch')        as events_pending_fetch,
  max(received_at)                                        as last_event_at,
  extract(epoch from now() - max(received_at))::bigint    as seconds_since_last_event
from webhook_events;

/* -------------------------------- roles -------------------------------- */
-- ingestion เปิดรับ internet ตรง ๆ จึงไม่ให้สิทธิ์ตารางเลยสักตาราง
-- เรียกได้เฉพาะ function ข้างบน (security definer)

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'inbox_ingest') then
    create role inbox_ingest nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'inbox_ui') then
    create role inbox_ui nologin;
  end if;
end
$$;

revoke all on function ingest_lead(text, text, jsonb, jsonb, boolean) from public;
revoke all on function complete_lead_fetch(bigint, jsonb) from public;
revoke all on function fail_lead_fetch(bigint, text) from public;

grant usage on schema public to inbox_ingest, inbox_ui;
grant execute on function ingest_lead(text, text, jsonb, jsonb, boolean) to inbox_ingest;
grant execute on function complete_lead_fetch(bigint, jsonb) to inbox_ingest;
grant execute on function fail_lead_fetch(bigint, text) to inbox_ingest;
grant select on webhook_events to inbox_ingest;   -- อ่านคิว pending_fetch ของตัวเอง

-- UI แตะได้เฉพาะช่องที่เซลส์แก้จริง ห้ามยุ่งกับ payload ดิบ
grant select, update (status, assigned_to, note) on inbox_items to inbox_ui;
grant select on inbox_health to inbox_ui, inbox_ingest;

commit;
