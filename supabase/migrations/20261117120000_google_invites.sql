-- Google-only sign-in + invite-by-email membership model.
-- Replaces invite codes / join_household. Everyone signs in with Google; a user only sees a household
-- after an admin has invited their (Google-verified) email address.

drop function if exists public.join_household(text, text);
drop function if exists public.rotate_invite_code(uuid);
drop function if exists public.gen_invite_code();
drop function if exists public.create_household(text, text, uuid, text, text, date, date);
drop policy if exists members_delete on public.household_members;
alter table public.households drop column invite_code, drop column shortcut_token;

-- ---------------------------------------------------------------- secrets (admin-only)
create table public.household_secrets (
  household_id   uuid primary key references public.households(id) on delete cascade,
  shortcut_token text not null default encode(extensions.gen_random_bytes(18), 'hex')
);
alter table public.household_secrets enable row level security;
create policy secrets_select on public.household_secrets for select to authenticated using (private.is_admin(household_id));

-- ---------------------------------------------------------------- invites
create table public.household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  email        text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  role         text not null default 'caregiver_log_only' check (role in ('parent_admin', 'caregiver_log_only', 'viewer_pediatrician')),
  invited_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  unique (household_id, email)
);
alter table public.household_invites enable row level security;
create policy invites_select on public.household_invites for select to authenticated using (private.is_admin(household_id));
create policy invites_insert on public.household_invites for insert to authenticated with check (private.is_admin(household_id) and invited_by = auth.uid());
create policy invites_delete on public.household_invites for delete to authenticated using (private.is_admin(household_id));

-- ---------------------------------------------------------------- RPCs
create or replace function public.create_household(
  p_household_name text, p_display_name text,
  p_baby_id uuid, p_baby_name text, p_sex text, p_birth_date date, p_due_date date default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); h households; b babies;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') <> 'google' then raise exception 'sign in with Google'; end if;
  if (select count(*) from household_members where user_id = uid and role = 'parent_admin') >= 3 then raise exception 'household limit reached'; end if;
  insert into households(name) values (coalesce(nullif(p_household_name, ''), 'הבית שלנו')) returning * into h;
  insert into household_members(household_id, user_id, display_name, role) values (h.id, uid, p_display_name, 'parent_admin');
  insert into babies(id, household_id, name, sex, birth_date, expected_due_date)
    values (coalesce(p_baby_id, gen_random_uuid()), h.id, p_baby_name, p_sex, p_birth_date, p_due_date) returning * into b;
  insert into household_secrets(household_id) values (h.id);
  return jsonb_build_object('household', to_jsonb(h), 'baby', to_jsonb(b));
end $$;

-- Called after every Google sign-in: turns pending invites for the caller's verified email into memberships.
create or replace function public.claim_invites(p_display_name text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); em text := lower(coalesce(auth.jwt() ->> 'email', '')); n integer := 0; r record;
begin
  if uid is null or em = '' or coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') <> 'google' then return 0; end if;
  for r in select * from household_invites where email = em and accepted_at is null loop
    insert into household_members(household_id, user_id, display_name, role)
      values (r.household_id, uid,
              left(coalesce(r.display_name, nullif(p_display_name, ''), auth.jwt() -> 'user_metadata' ->> 'full_name', split_part(em, '@', 1)), 40), r.role)
      on conflict (household_id, user_id) do nothing;
    update household_invites set accepted_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.remove_member(p_household_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not (is_admin(p_household_id) or p_user_id = auth.uid()) then raise exception 'admins only'; end if;
  if (select role from household_members where household_id = p_household_id and user_id = p_user_id) = 'parent_admin'
     and (select count(*) from household_members where household_id = p_household_id and role = 'parent_admin' and user_id <> p_user_id) = 0 then
    raise exception 'household must keep at least one admin';
  end if;
  delete from household_members where household_id = p_household_id and user_id = p_user_id;
end $$;

create or replace function public.rotate_shortcut_token(p_household_id uuid) returns text
language plpgsql security definer set search_path = public, private, extensions as $$
declare t text := encode(gen_random_bytes(18), 'hex');
begin
  if not is_admin(p_household_id) then raise exception 'admins only'; end if;
  update household_secrets set shortcut_token = t where household_id = p_household_id;
  return t;
end $$;

revoke all on function public.create_household, public.claim_invites, public.remove_member, public.rotate_shortcut_token from public, anon;
grant execute on function public.create_household, public.claim_invites, public.remove_member, public.rotate_shortcut_token to authenticated;

alter publication supabase_realtime add table public.household_members;
