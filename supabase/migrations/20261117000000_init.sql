-- =====================================================================
-- Ariel baby tracker — schema, RLS, RPCs, realtime
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables
create table public.households (
  id             uuid primary key default gen_random_uuid(),
  name           text not null default 'הבית שלנו',
  invite_code    text not null unique check (invite_code ~ '^[A-Z0-9]{6}$'),
  shortcut_token text,                       -- optional extra secret required by the quick-log Edge Function
  created_at     timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  role         text not null default 'parent_admin'
               check (role in ('parent_admin', 'caregiver_log_only', 'viewer_pediatrician')),
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_idx on public.household_members(user_id);

create table public.babies (
  id                    uuid primary key default gen_random_uuid(),
  household_id          uuid not null references public.households(id) on delete cascade,
  name                  text not null,
  sex                   text check (sex in ('male', 'female')),
  birth_date            date not null,
  expected_due_date     date,
  last_nursing_side     text check (last_nursing_side in ('left', 'right')),
  recommended_next_side text check (recommended_next_side in ('left', 'right')),
  created_at            timestamptz not null default now()
);
create index babies_household_idx on public.babies(household_id);

create table public.active_timers (
  id                    uuid primary key default gen_random_uuid(),
  baby_id               uuid not null references public.babies(id) on delete cascade,
  household_id          uuid not null references public.households(id) on delete cascade,
  timer_type            text not null check (timer_type in ('nursing', 'sleep', 'pumping')),
  status                text not null check (status in ('RUNNING', 'PAUSED')),
  active_side           text check (active_side in ('left', 'right')),
  first_side            text check (first_side in ('left', 'right')),
  session_started_at    timestamptz not null default now(),
  started_at            timestamptz not null,          -- start of the current running segment
  paused_at             timestamptz,
  accumulated_left_sec  integer not null default 0 check (accumulated_left_sec >= 0),
  accumulated_right_sec integer not null default 0 check (accumulated_right_sec >= 0),
  accumulated_total_sec integer not null default 0 check (accumulated_total_sec >= 0),
  updated_by            text,
  updated_at            timestamptz not null default now(),
  unique (baby_id, timer_type)
);
create index active_timers_household_idx on public.active_timers(household_id);

create table public.care_events (
  id                 uuid primary key default gen_random_uuid(),
  client_mutation_id uuid not null unique,               -- idempotency key from the offline outbox
  baby_id            uuid not null references public.babies(id) on delete cascade,
  household_id       uuid not null references public.households(id) on delete cascade,
  logged_by          uuid references auth.users(id) on delete set null,
  logged_by_name     text,
  event_type         text not null check (event_type in ('nursing', 'bottle', 'pumping', 'sleep', 'diaper', 'medication', 'temperature')),
  started_at         timestamptz not null,
  ended_at           timestamptz,
  duration_sec       integer check (duration_sec is null or duration_sec >= 0),
  nursing_left_sec   integer check (nursing_left_sec is null or nursing_left_sec >= 0),
  nursing_right_sec  integer check (nursing_right_sec is null or nursing_right_sec >= 0),
  ending_side        text check (ending_side in ('left', 'right')),
  volume_ml          integer check (volume_ml is null or volume_ml between 0 and 1000),
  diaper_type        text check (diaper_type in ('wet', 'dirty', 'mixed')),
  stool_color        text check (stool_color in ('yellow', 'green', 'brown', 'black', 'red', 'white_acholic')),
  medication_code    text check (medication_code in ('vitamin_d3', 'iron_drops', 'paracetamol_novimol', 'ibuprofen_nurofen')),
  dosage_ml          numeric(5, 2),
  metadata           jsonb not null default '{}'::jsonb,
  is_deleted         boolean not null default false,
  client_updated_at  timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index care_events_household_time_idx on public.care_events(household_id, started_at desc);
create index care_events_baby_type_time_idx on public.care_events(baby_id, event_type, started_at desc);

create table public.milk_stash (
  id                  uuid primary key default gen_random_uuid(),
  baby_id             uuid not null references public.babies(id) on delete cascade,
  household_id        uuid not null references public.households(id) on delete cascade,
  pumped_at           timestamptz not null,
  storage_location    text not null check (storage_location in ('room_temp', 'fridge', 'freezer', 'thawed_fridge')),
  initial_volume_ml   integer not null check (initial_volume_ml between 0 and 1000),
  remaining_volume_ml integer not null check (remaining_volume_ml >= 0),
  thawed_at           timestamptz,
  expires_at          timestamptz not null,
  status              text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'CONSUMED', 'EXPIRED_DISCARDED')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (remaining_volume_ml <= initial_volume_ml)
);
create index milk_stash_fifo_idx on public.milk_stash(household_id, status, expires_at);

create table public.growth_measurements (
  id                     uuid primary key default gen_random_uuid(),
  baby_id                uuid not null references public.babies(id) on delete cascade,
  household_id           uuid not null references public.households(id) on delete cascade,
  measured_at            timestamptz not null,
  weight_grams           integer check (weight_grams between 300 and 30000),
  length_cm              numeric(5, 1) check (length_cm between 25 and 130),
  head_circumference_cm  numeric(5, 1) check (head_circumference_cm between 20 and 60),
  who_weight_percentile  numeric(4, 1),
  who_length_percentile  numeric(4, 1),
  who_head_percentile    numeric(4, 1),
  notes                  text,
  updated_at             timestamptz not null default now()
);
create index growth_baby_idx on public.growth_measurements(baby_id, measured_at);

-- ---------------------------------------------------------------- helpers
create or replace function public.gen_invite_code() returns text
language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
    end loop;
    exit when not exists (select 1 from households where invite_code = code);
  end loop;
  return code;
end $$;

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid());
$$;
create or replace function private.can_log(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid()
                 and role in ('parent_admin', 'caregiver_log_only'));
$$;
create or replace function private.is_admin(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from household_members where household_id = hid and user_id = auth.uid() and role = 'parent_admin');
$$;

-- Every child row must belong to the same household as its baby.
create or replace function public.enforce_baby_household() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from babies where id = new.baby_id and household_id = new.household_id) then
    raise exception 'baby % does not belong to household %', new.baby_id, new.household_id;
  end if;
  return new;
end $$;

-- Last-write-wins: ignore updates carrying an older client timestamp (offline devices replaying their outbox).
create or replace function public.lww_client_updated_at() returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_updated_at < old.client_updated_at then return null; end if;
  return new;
end $$;
create or replace function public.lww_updated_at() returns trigger language plpgsql set search_path = public as $$
begin
  if new.updated_at < old.updated_at then return null; end if;
  return new;
end $$;

-- Thawed milk can never be refrozen.
create or replace function public.forbid_refreeze() returns trigger language plpgsql set search_path = public as $$
begin
  if new.storage_location = 'freezer' and (old.thawed_at is not null or old.storage_location = 'thawed_fridge') then
    raise exception 'thawed breast milk must not be refrozen';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['active_timers', 'care_events', 'milk_stash', 'growth_measurements'] loop
    execute format('create trigger %I_baby_household before insert or update on public.%I for each row execute function public.enforce_baby_household()', t, t);
  end loop;
end $$;
create trigger care_events_lww before update on public.care_events for each row execute function public.lww_client_updated_at();
create trigger active_timers_lww before update on public.active_timers for each row execute function public.lww_updated_at();
create trigger milk_stash_lww before update on public.milk_stash for each row execute function public.lww_updated_at();
create trigger growth_lww before update on public.growth_measurements for each row execute function public.lww_updated_at();
create trigger milk_stash_refreeze before update on public.milk_stash for each row execute function public.forbid_refreeze();

-- ---------------------------------------------------------------- RLS
alter table public.households          enable row level security;
alter table public.household_members   enable row level security;
alter table public.babies              enable row level security;
alter table public.active_timers       enable row level security;
alter table public.care_events         enable row level security;
alter table public.milk_stash          enable row level security;
alter table public.growth_measurements enable row level security;

create policy households_select on public.households for select to authenticated using (private.is_member(id));
create policy households_update on public.households for update to authenticated using (private.is_admin(id)) with check (private.is_admin(id));

create policy members_select on public.household_members for select to authenticated using (private.is_member(household_id));
create policy members_delete on public.household_members for delete to authenticated using (private.is_admin(household_id) or user_id = auth.uid());

create policy babies_select on public.babies for select to authenticated using (private.is_member(household_id));
create policy babies_insert on public.babies for insert to authenticated with check (private.is_admin(household_id));
create policy babies_update on public.babies for update to authenticated using (private.can_log(household_id)) with check (private.can_log(household_id));
create policy babies_delete on public.babies for delete to authenticated using (private.is_admin(household_id));

create policy timers_select on public.active_timers for select to authenticated using (private.is_member(household_id));
create policy timers_insert on public.active_timers for insert to authenticated with check (private.can_log(household_id));
create policy timers_update on public.active_timers for update to authenticated using (private.can_log(household_id)) with check (private.can_log(household_id));
create policy timers_delete on public.active_timers for delete to authenticated using (private.can_log(household_id));

create policy events_select on public.care_events for select to authenticated using (private.is_member(household_id));
create policy events_insert on public.care_events for insert to authenticated
  with check (private.can_log(household_id) and (logged_by is null or logged_by = auth.uid()));
create policy events_update on public.care_events for update to authenticated using (private.can_log(household_id)) with check (private.can_log(household_id));
create policy events_delete on public.care_events for delete to authenticated using (private.is_admin(household_id));

create policy stash_select on public.milk_stash for select to authenticated using (private.is_member(household_id));
create policy stash_insert on public.milk_stash for insert to authenticated with check (private.can_log(household_id));
create policy stash_update on public.milk_stash for update to authenticated using (private.can_log(household_id)) with check (private.can_log(household_id));
create policy stash_delete on public.milk_stash for delete to authenticated using (private.is_admin(household_id));

create policy growth_select on public.growth_measurements for select to authenticated using (private.is_member(household_id));
create policy growth_insert on public.growth_measurements for insert to authenticated with check (private.can_log(household_id));
create policy growth_update on public.growth_measurements for update to authenticated using (private.can_log(household_id)) with check (private.can_log(household_id));
create policy growth_delete on public.growth_measurements for delete to authenticated using (private.can_log(household_id));

-- ---------------------------------------------------------------- RPCs
create or replace function public.create_household(
  p_household_name text, p_display_name text,
  p_baby_id uuid, p_baby_name text, p_sex text, p_birth_date date, p_due_date date default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); h households; b babies;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  insert into households(name, invite_code) values (coalesce(nullif(p_household_name, ''), 'הבית שלנו'), gen_invite_code()) returning * into h;
  insert into household_members(household_id, user_id, display_name, role) values (h.id, uid, p_display_name, 'parent_admin');
  insert into babies(id, household_id, name, sex, birth_date, expected_due_date)
    values (coalesce(p_baby_id, gen_random_uuid()), h.id, p_baby_name, p_sex, p_birth_date, p_due_date) returning * into b;
  return jsonb_build_object('household', to_jsonb(h) - 'shortcut_token', 'baby', to_jsonb(b));
end $$;

create or replace function public.join_household(p_invite_code text, p_display_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); h households; b babies; admins int; r text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  select * into h from households where invite_code = upper(trim(p_invite_code));
  if h.id is null then raise exception 'קוד הזמנה לא נמצא'; end if;
  select count(*) into admins from household_members where household_id = h.id and role = 'parent_admin';
  r := case when admins < 2 then 'parent_admin' else 'caregiver_log_only' end;
  insert into household_members(household_id, user_id, display_name, role) values (h.id, uid, p_display_name, r)
    on conflict (household_id, user_id) do update set display_name = excluded.display_name;
  select * into b from babies where household_id = h.id order by created_at limit 1;
  return jsonb_build_object('household', to_jsonb(h) - 'shortcut_token', 'baby', to_jsonb(b));
end $$;

create or replace function public.set_member_role(p_household_id uuid, p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not is_admin(p_household_id) then raise exception 'admins only'; end if;
  if p_role not in ('parent_admin', 'caregiver_log_only', 'viewer_pediatrician') then raise exception 'bad role'; end if;
  if p_role <> 'parent_admin' and (select count(*) from household_members where household_id = p_household_id and role = 'parent_admin' and user_id <> p_user_id) = 0 then
    raise exception 'household must keep at least one admin';
  end if;
  update household_members set role = p_role where household_id = p_household_id and user_id = p_user_id;
end $$;

create or replace function public.rotate_invite_code(p_household_id uuid) returns text
language plpgsql security definer set search_path = public, private as $$
declare code text;
begin
  if not is_admin(p_household_id) then raise exception 'admins only'; end if;
  code := gen_invite_code();
  update households set invite_code = code where id = p_household_id;
  return code;
end $$;

revoke all on function public.create_household, public.join_household, public.set_member_role, public.rotate_invite_code, public.gen_invite_code from public, anon;
grant execute on function public.create_household, public.join_household, public.set_member_role, public.rotate_invite_code to authenticated;
revoke execute on function private.is_member, private.can_log, private.is_admin from public, anon;
grant execute on function private.is_member, private.can_log, private.is_admin to authenticated;

-- ---------------------------------------------------------------- realtime
alter table public.active_timers replica identity full;   -- DELETE payloads carry baby_id/timer_type
alter publication supabase_realtime add table public.care_events, public.active_timers, public.milk_stash, public.growth_measurements, public.babies;
