// Supabase Edge Function: quick-log
// One-tap logging from iOS Shortcuts / Action Button / Siri / Back Tap, without opening the app.
//
// POST { invite_code, action_type, side?, volume_ml?, offset_minutes?, parent_name?, source?, token? }
// action_type: nursing | nursing_stop | sleep | wet_diaper | dirty_diaper | mixed_diaper | bottle | pumping | vitamin_d | status
// Response: { ok, message } — `message` is Hebrew text ready for "Show Result" / "Speak Text".
//
// Deploy:  supabase functions deploy quick-log --no-verify-jwt
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const TZ = 'Asia/Jerusalem';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const ACTIONS = ['nursing', 'nursing_stop', 'sleep', 'wet_diaper', 'dirty_diaper', 'mixed_diaper', 'bottle', 'pumping', 'vitamin_d', 'status'] as const;
type Action = typeof ACTIONS[number];
type Side = 'left' | 'right';
const SIDE_HE: Record<Side, string> = { left: 'שמאל', right: 'ימין' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const clock = (iso: string | number) =>
  new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const localDay = (iso: string | number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const mins = (sec: number) => Math.round(sec / 60);
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

// --- same algorithm as js/logic/timers.js -------------------------------------------------
function fold(t: any, at: number) {
  const r = { ...t };
  if (r.status === 'RUNNING') {
    const seg = Math.max(0, Math.floor((at - Date.parse(r.started_at)) / 1000));
    if (r.active_side === 'left') r.accumulated_left_sec += seg;
    if (r.active_side === 'right') r.accumulated_right_sec += seg;
    r.accumulated_total_sec += seg;
  }
  return r;
}
function recommendNextSide(L: number, R: number, ending: Side, first: Side): Side {
  const usedL = L >= 30, usedR = R >= 30;
  if (usedL && usedR) {
    if ((ending === 'left' ? L : R) < 300) return ending; // Dessert Rule
    if (Math.abs(L - R) > Math.max(180, 0.4 * Math.max(L, R))) return L < R ? 'left' : 'right';
    return other(first || ending);
  }
  if (usedL || usedR) return usedL ? 'right' : 'left';
  return other(first || ending || 'left');
}

interface Ctx { sb: SupabaseClient; baby: any; hh: any; who: string; at: number; }

async function insertEvent(c: Ctx, f: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { error } = await c.sb.from('care_events').insert({
    client_mutation_id: crypto.randomUUID(), baby_id: c.baby.id, household_id: c.hh.id,
    logged_by: null, logged_by_name: c.who, client_updated_at: now,
    ...f, metadata: { source: 'ios_shortcut', ...((f.metadata as object) || {}) },
  });
  if (error) throw error;
}
const getTimer = async (c: Ctx, type: string) =>
  (await c.sb.from('active_timers').select('*').eq('baby_id', c.baby.id).eq('timer_type', type).maybeSingle()).data;
const dropTimer = (c: Ctx, type: string) => c.sb.from('active_timers').delete().eq('baby_id', c.baby.id).eq('timer_type', type);

async function startTimer(c: Ctx, type: string, side: Side | null) {
  const t = new Date(c.at).toISOString();
  const { error } = await c.sb.from('active_timers').upsert({
    baby_id: c.baby.id, household_id: c.hh.id, timer_type: type, status: 'RUNNING', active_side: side, first_side: side,
    session_started_at: t, started_at: t, paused_at: null, accumulated_left_sec: 0, accumulated_right_sec: 0, accumulated_total_sec: 0,
    updated_by: c.who, updated_at: new Date().toISOString(),
  }, { onConflict: 'baby_id,timer_type' });
  if (error) throw error;
}

async function finishNursing(c: Ctx, t: any) {
  const end = Math.max(c.at, Date.parse(t.started_at));
  const f = fold(t, end);
  const ending: Side = t.active_side;
  const next = recommendNextSide(f.accumulated_left_sec, f.accumulated_right_sec, ending, t.first_side);
  await insertEvent(c, {
    event_type: 'nursing', started_at: t.session_started_at, ended_at: new Date(t.status === 'PAUSED' ? Date.parse(t.paused_at) : end).toISOString(),
    duration_sec: f.accumulated_total_sec, nursing_left_sec: f.accumulated_left_sec, nursing_right_sec: f.accumulated_right_sec, ending_side: ending,
    metadata: { first_side: t.first_side, recommended_next_side: next },
  });
  await dropTimer(c, 'nursing');
  await c.sb.from('babies').update({ last_nursing_side: ending, recommended_next_side: next }).eq('id', c.baby.id);
  return `נשמרה הנקה ${mins(f.accumulated_total_sec)} דק'. הנקה הבאה: צד ${SIDE_HE[next]}`;
}
async function finishSleep(c: Ctx, t: any) {
  const end = Math.max(c.at, Date.parse(t.started_at));
  const f = fold(t, end);
  await insertEvent(c, { event_type: 'sleep', started_at: t.session_started_at, ended_at: new Date(end).toISOString(), duration_sec: f.accumulated_total_sec });
  await dropTimer(c, 'sleep');
  return `נשמרה שינה ${mins(f.accumulated_total_sec)} דק'`;
}

async function handle(c: Ctx, action: Action, body: any): Promise<{ ok: boolean; message: string; [k: string]: unknown }> {
  switch (action) {
    case 'wet_diaper': case 'dirty_diaper': case 'mixed_diaper': {
      const type = action.split('_')[0];
      await insertEvent(c, { event_type: 'diaper', started_at: new Date(c.at).toISOString(), diaper_type: type, stool_color: type === 'wet' ? null : (body.stool_color ?? 'yellow') });
      return { ok: true, message: `נרשם חיתול ${{ wet: 'רטוב', dirty: 'מלוכלך', mixed: 'משולב' }[type]} ✓` };
    }
    case 'nursing': case 'nursing_stop': {
      const t = await getTimer(c, 'nursing');
      const side: Side | null = body.side === 'left' || body.side === 'right' ? body.side : null;
      if (t) {
        if (action === 'nursing' && side && side !== t.active_side) {
          const f = fold(t, Date.now());
          await c.sb.from('active_timers').update({ ...f, id: undefined, active_side: side, status: 'RUNNING', started_at: new Date().toISOString(), paused_at: null, updated_by: c.who, updated_at: new Date().toISOString() }).eq('id', t.id);
          return { ok: true, message: `הוחלף לצד ${SIDE_HE[side]}` };
        }
        return { ok: true, message: await finishNursing(c, t) };
      }
      if (action === 'nursing_stop') return { ok: false, message: 'אין הנקה פעילה' };
      const sleep = await getTimer(c, 'sleep');
      if (sleep) await finishSleep(c, sleep);
      const s = side ?? c.baby.recommended_next_side ?? 'right';
      await startTimer(c, 'nursing', s);
      return { ok: true, message: `התחילה הנקה בצד ${SIDE_HE[s as Side]}` };
    }
    case 'sleep': {
      const t = await getTimer(c, 'sleep');
      if (t) return { ok: true, message: await finishSleep(c, t) };
      const n = await getTimer(c, 'nursing');
      let pre = '';
      if (n) pre = (await finishNursing(c, n)) + '. ';
      await startTimer(c, 'sleep', null);
      return { ok: true, message: `${pre}התחילה שינה ב-${clock(c.at)}` };
    }
    case 'bottle': {
      let vol = Number(body.volume_ml);
      if (!vol) {
        const { data } = await c.sb.from('care_events').select('volume_ml').eq('baby_id', c.baby.id).eq('event_type', 'bottle').eq('is_deleted', false).order('started_at', { ascending: false }).limit(1).maybeSingle();
        vol = data?.volume_ml ?? 90;
      }
      const source = body.source === 'formula' ? 'formula' : 'pumped';
      const meta: Record<string, unknown> = { source };
      if (source === 'pumped') {
        const nowIso = new Date().toISOString();
        const { data: bags } = await c.sb.from('milk_stash').select('*').eq('household_id', c.hh.id).eq('status', 'AVAILABLE')
          .neq('storage_location', 'freezer').gt('expires_at', nowIso).gt('remaining_volume_ml', 0);
        const prio: Record<string, number> = { room_temp: 0, thawed_fridge: 1, fridge: 2 };
        const ordered = (bags ?? []).sort((a, b) => prio[a.storage_location] - prio[b.storage_location] || Date.parse(a.expires_at) - Date.parse(b.expires_at));
        let left = vol; const alloc = [];
        for (const b of ordered) {
          if (left <= 0) break;
          const take = Math.min(left, b.remaining_volume_ml), rem = b.remaining_volume_ml - take;
          await c.sb.from('milk_stash').update({ remaining_volume_ml: rem, status: rem <= 0 ? 'CONSUMED' : 'AVAILABLE', updated_at: nowIso }).eq('id', b.id);
          alloc.push({ bag_id: b.id, take }); left -= take;
        }
        meta.allocations = alloc; meta.shortfall_ml = Math.max(0, left);
      }
      await insertEvent(c, { event_type: 'bottle', started_at: new Date(c.at).toISOString(), volume_ml: vol, metadata: meta });
      return { ok: true, message: `נרשם בקבוק ${vol} מ"ל ${source === 'pumped' ? 'חלב שאוב' : 'תמ״ל'}${meta.shortfall_ml ? ` · חסרו ${meta.shortfall_ml} מ"ל במלאי` : ''}` };
    }
    case 'pumping': {
      const vol = Math.max(0, Math.min(1000, Number(body.volume_ml) || 0));
      const t = await getTimer(c, 'pumping');
      const startIso = t?.session_started_at ?? new Date(c.at).toISOString();
      await insertEvent(c, { event_type: 'pumping', started_at: startIso, ended_at: new Date(c.at).toISOString(), volume_ml: vol });
      if (t) await dropTimer(c, 'pumping');
      if (vol > 0) {
        await c.sb.from('milk_stash').insert({
          baby_id: c.baby.id, household_id: c.hh.id, pumped_at: new Date(c.at).toISOString(), storage_location: 'fridge',
          initial_volume_ml: vol, remaining_volume_ml: vol, expires_at: new Date(c.at + 96 * 3600e3).toISOString(),
        });
      }
      return { ok: true, message: `נרשמה שאיבה ${vol} מ"ל · נוספה שקית למקרר` };
    }
    case 'vitamin_d': {
      const { data } = await c.sb.from('care_events').select('started_at, logged_by_name').eq('baby_id', c.baby.id).eq('event_type', 'medication')
        .eq('medication_code', 'vitamin_d3').eq('is_deleted', false).gte('started_at', new Date(Date.now() - 30 * 3600e3).toISOString())
        .order('started_at', { ascending: false });
      const today = (data ?? []).find((e) => localDay(e.started_at) === localDay(Date.now()));
      if (today) return { ok: false, locked: true, message: `ויטמין D כבר ניתן היום ע״י ${today.logged_by_name ?? ''} ב-${clock(today.started_at)}` };
      await insertEvent(c, { event_type: 'medication', medication_code: 'vitamin_d3', started_at: new Date(c.at).toISOString(), metadata: { dose: '400 IU' } });
      return { ok: true, message: 'נרשם ויטמין D3 ✓' };
    }
    case 'status': {
      const [n, s, last] = await Promise.all([
        getTimer(c, 'nursing'), getTimer(c, 'sleep'),
        c.sb.from('care_events').select('*').eq('baby_id', c.baby.id).eq('is_deleted', false).in('event_type', ['nursing', 'bottle']).order('started_at', { ascending: false }).limit(1).maybeSingle(),
      ]);
      const parts: string[] = [];
      if (n) parts.push(`הנקה פעילה בצד ${SIDE_HE[n.active_side as Side]} מאז ${clock(n.session_started_at)}`);
      else if (s) parts.push(`${c.baby.name} ישן מאז ${clock(s.session_started_at)}`);
      else {
        const { data: lastSleep } = await c.sb.from('care_events').select('ended_at').eq('baby_id', c.baby.id).eq('event_type', 'sleep').eq('is_deleted', false).not('ended_at', 'is', null).order('ended_at', { ascending: false }).limit(1).maybeSingle();
        if (lastSleep) parts.push(`${c.baby.name} ער מאז ${clock(lastSleep.ended_at)}`);
      }
      if (last.data) parts.push(`האכלה אחרונה ב-${clock(last.data.started_at)}`);
      parts.push(`הנקה הבאה: צד ${SIDE_HE[(c.baby.recommended_next_side ?? 'right') as Side]}`);
      return { ok: true, message: parts.join('. ') };
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, message: 'POST only' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, message: 'גוף הבקשה אינו JSON תקין' }, 400); }

  const code = String(body.invite_code ?? '').trim().toUpperCase();
  const action = String(body.action_type ?? '') as Action;
  const offset = Math.max(0, Math.min(240, Number(body.offset_minutes) || 0));
  if (!/^[A-Z0-9]{6}$/.test(code)) return json({ ok: false, message: 'invite_code חסר או לא תקין' }, 400);
  if (!ACTIONS.includes(action)) return json({ ok: false, message: `action_type לא נתמך. אפשרויות: ${ACTIONS.join(', ')}` }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: hh } = await sb.from('households').select('id, name, shortcut_token').eq('invite_code', code).maybeSingle();
  if (!hh) return json({ ok: false, message: 'קוד הזמנה לא נמצא' }, 404);
  if (hh.shortcut_token && body.token !== hh.shortcut_token) return json({ ok: false, message: 'אסימון קיצור שגוי' }, 401);
  const { data: baby } = await sb.from('babies').select('*').eq('household_id', hh.id).order('created_at').limit(1).maybeSingle();
  if (!baby) return json({ ok: false, message: 'לא נמצא תינוק במשק הבית' }, 404);

  const who = String(body.parent_name ?? '').slice(0, 40) || 'קיצור iOS';
  try {
    const res = await handle({ sb, baby, hh, who, at: Date.now() - offset * 60000 }, action, body);
    return json(res, res.ok ? 200 : 409);
  } catch (e) {
    console.error(e);
    return json({ ok: false, message: 'שגיאה ברישום — נסו שוב' }, 500);
  }
});
