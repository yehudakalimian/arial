// Database test: runs the migration in PGlite (WASM Postgres) with Supabase auth stubs and checks RLS/RPC/trigger behaviour.
// Setup once: npm i -D @electric-sql/pglite@0.2.17   ·   Run: npm run test:db
// (Supabase ships pgcrypto; PGlite does not, so gen_random_bytes is stubbed here only.)
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create publication supabase_realtime;
  create function public.gen_random_bytes(n int) returns bytea language sql volatile as $$ select decode(substr(md5(random()::text) || md5(random()::text), 1, n * 2), 'hex') $$;
  grant usage on schema public, auth to authenticated;`);
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261117000000_init.sql', import.meta.url), 'utf8').replace('create extension if not exists pgcrypto;', ''));
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';
const BABY = 'aaaaaaaa-0000-4000-8000-000000000001';
await db.exec(`insert into auth.users values ('${A}'),('${B}'),('${C}')`);
async function as(uid, sql) {
  try {
    const r = await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${uid}', true); ${sql}; commit;`);
    return { ok: true, rows: r[r.length - 2]?.rows };
  } catch (e) { await db.exec('rollback').catch(() => {}); return { ok: false, err: e.message }; }
}
const r1 = await as(A, `select create_household('הבית של אריאל','יהודה','${BABY}','אריאל','male','2026-10-14','2026-10-18') as j`);
const hh = r1.rows[0].j.household;
await as(B, `select join_household('${hh.invite_code}','הדס')`);
const exp = (label, res, shouldOk) => console.log(res.ok === shouldOk ? '✓' : '✗', label, res.ok ? '' : '(' + res.err.slice(0, 70) + ')');
exp('member B inserts event', await as(B, `insert into care_events(client_mutation_id, baby_id, household_id, logged_by, event_type, started_at) values (gen_random_uuid(),'${BABY}','${hh.id}','${B}','diaper',now())`), true);
exp('outsider C insert blocked', await as(C, `insert into care_events(client_mutation_id, baby_id, household_id, event_type, started_at) values (gen_random_uuid(),'${BABY}','${hh.id}','diaper',now())`), false);
exp('spoofed logged_by blocked', await as(B, `insert into care_events(client_mutation_id, baby_id, household_id, logged_by, event_type, started_at) values (gen_random_uuid(),'${BABY}','${hh.id}','${A}','diaper',now())`), false);
exp('timer upsert on (baby_id,timer_type)', await as(B, `insert into active_timers(baby_id, household_id, timer_type, status, started_at, updated_at) values ('${BABY}','${hh.id}','nursing','RUNNING',now(), now()) on conflict (baby_id, timer_type) do update set status = excluded.status, updated_at = excluded.updated_at`), true);
exp('timer second upsert (switch side)', await as(A, `insert into active_timers(baby_id, household_id, timer_type, status, active_side, started_at, updated_at) values ('${BABY}','${hh.id}','nursing','RUNNING','left',now(), now()+interval '1 s') on conflict (baby_id, timer_type) do update set active_side = excluded.active_side, updated_at = excluded.updated_at`), true);
const t = await as(A, `select count(*)::int n, max(active_side) s from active_timers`); console.log("  timers:", JSON.stringify(t.rows?.[0] ?? t));
exp('A demotes B to viewer', await as(A, `select set_member_role('${hh.id}','${B}','viewer_pediatrician')`), true);
exp('viewer write blocked', await as(B, `insert into active_timers(baby_id, household_id, timer_type, status, started_at) values ('${BABY}','${hh.id}','sleep','RUNNING',now())`), false);
exp('viewer can read', await as(B, `select count(*) from care_events`), true);
exp('last-admin guard', await as(A, `select set_member_role('${hh.id}','${A}','caregiver_log_only')`), false);
exp('freezer bag insert', await as(A, `insert into milk_stash(id, baby_id, household_id, pumped_at, storage_location, initial_volume_ml, remaining_volume_ml, expires_at) values ('cccccccc-0000-4000-8000-000000000001','${BABY}','${hh.id}', now(),'freezer',100,100, now()+interval '6 months')`), true);
exp('thaw', await as(A, `update milk_stash set storage_location='thawed_fridge', thawed_at=now(), expires_at=now()+interval '24 hours', updated_at=now()+interval '1 s'`), true);
exp('refreeze blocked', await as(A, `update milk_stash set storage_location='freezer', updated_at=now()+interval '2 s'`), false);
const other = (await as(C, `select create_household('x','c',null,'b','female','2026-01-01') as j`)).rows[0].j;
exp('cross-household baby blocked', await as(A, `insert into care_events(client_mutation_id, baby_id, household_id, event_type, started_at) values (gen_random_uuid(),'${other.baby.id}','${hh.id}','diaper',now())`), false);
exp('C cannot see A household', { ok: (await as(C, `select count(*)::int n from households where id='${hh.id}'`)).rows[0].n === 0 }, true);
exp('invalid invite code rejected', await as(C, `select join_household('ZZZZZZ','c')`), false);
exp('anon RPC denied', await (async () => { try { await db.exec(`begin; set local role anon; select create_household('x','y',null,'b','male','2026-01-01'); commit;`); return { ok: true }; } catch (e) { await db.exec('rollback'); return { ok: false, err: e.message }; } })(), false);
