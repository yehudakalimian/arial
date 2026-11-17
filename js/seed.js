// Pre-seeded instant working state: baby "אריאל" (born Oct 2026) + parents "יהודה" & "הדס",
// 14 days of realistic history generated relative to "now", a FIFO milk stash and WHO growth points.
import * as idb from './idb.js';
import { uuid, iso, MIN, HOUR, DAY, startOfDay } from './util.js';
import { createBag } from './logic/stash.js';
import { recommendNextSide } from './logic/timers.js';
import { assess } from './logic/who.js';

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const inviteCode = () => Array.from({ length: 6 }, () => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)]).join('');

export const PARENTS = { yehuda: { id: 'local-יהודה', name: 'יהודה' }, hadas: { id: 'local-הדס', name: 'הדס' } };

export function buildSeed(now = Date.now()) {
  const rnd = mulberry32(20261014);
  const r = (a, b) => a + rnd() * (b - a);
  const ri = (a, b) => Math.round(r(a, b));
  const household = { id: uuid(), name: 'הבית של אריאל', invite_code: inviteCode(), created_at: iso(now) };
  const baby = {
    id: uuid(), household_id: household.id, name: 'אריאל', sex: 'male',
    birth_date: '2026-10-14T08:20:00+03:00', expected_due_date: '2026-10-18',
    last_nursing_side: 'left', recommended_next_side: 'right', created_at: iso(now),
  };
  const birth = Date.parse(baby.birth_date);
  const events = [];
  const ev = (f, who) => {
    const id = uuid();
    events.push({
      id, client_mutation_id: id, baby_id: baby.id, household_id: household.id,
      logged_by: who.id, logged_by_name: who.name, ended_at: null, duration_sec: null,
      nursing_left_sec: null, nursing_right_sec: null, ending_side: null, volume_ml: null,
      diaper_type: null, stool_color: null, medication_code: null, dosage_ml: null,
      metadata: {}, is_deleted: false, client_updated_at: f.started_at, created_at: f.started_at, ...f,
    });
  };
  const anyParent = () => (rnd() < 0.5 ? PARENTS.yehuda : PARENTS.hadas);
  let nextSide = 'left';

  function feed(t, night) {
    if (!night && rnd() < 0.18) {
      const pumped = rnd() < 0.7;
      ev({ event_type: 'bottle', started_at: iso(t), volume_ml: [60, 70, 80, 90][ri(0, 3)], metadata: { source: pumped ? 'pumped' : 'formula' } }, PARENTS.yehuda);
      return t + ri(10, 18) * MIN;
    }
    const first = nextSide, second = first === 'left' ? 'right' : 'left';
    const a = ri(9, 18) * 60, b = rnd() < 0.85 ? ri(3, 13) * 60 : 0;
    const L = first === 'left' ? a : b, R = first === 'right' ? a : b;
    const ending = b ? second : first;
    const rec = recommendNextSide({ nursing_left_sec: L, nursing_right_sec: R, ending_side: ending, first_side: first });
    nextSide = rec.side;
    const dur = a + b;
    ev({ event_type: 'nursing', started_at: iso(t), ended_at: iso(t + dur * 1000), duration_sec: dur, nursing_left_sec: L, nursing_right_sec: R, ending_side: ending, metadata: { first_side: first, recommended_next_side: rec.side, rule: rec.rule } }, PARENTS.hadas);
    return t + dur * 1000;
  }
  function diaper(t, night) {
    const dirty = rnd() < (night ? 0.18 : 0.42);
    const wet = rnd() < 0.93;
    const type = dirty && wet ? 'mixed' : dirty ? 'dirty' : 'wet';
    const c = rnd();
    ev({ event_type: 'diaper', started_at: iso(t), diaper_type: type, stool_color: type === 'wet' ? null : c < 0.82 ? 'yellow' : c < 0.95 ? 'green' : 'brown' }, anyParent());
  }

  const lastWake = now - 52 * MIN;
  let t = Math.max(birth + 2 * DAY, startOfDay(now - 14 * DAY) + 6.5 * HOUR);
  let guard = 0;
  while (t < lastWake && guard++ < 500) {
    const h = new Date(t).getHours();
    const night = h >= 21 || h < 6;
    const W = night ? r(25, 45) : h < 9 ? r(42, 58) : r(52, 74);
    const sStart = t + W * MIN;
    if (sStart >= lastWake - 15 * MIN) {
      // Stretch the previous sleep so the baby woke exactly at lastWake.
      const prev = events.filter((e) => e.event_type === 'sleep').pop();
      if (prev) { prev.ended_at = iso(lastWake); prev.duration_sec = Math.round((lastWake - Date.parse(prev.started_at)) / 1000); }
      break;
    }
    const fed = feed(t + 2 * MIN, night);
    diaper(fed + 3 * MIN, night);
    const sh = new Date(sStart).getHours();
    const nightSleep = sh >= 20 || sh < 5;
    const dur = nightSleep ? r(120, 205) : rnd() < 0.12 ? r(22, 33) : r(38, 110);
    let sEnd = sStart + dur * MIN;
    if (sEnd >= lastWake) sEnd = lastWake;
    ev({ event_type: 'sleep', started_at: iso(sStart), ended_at: iso(sEnd), duration_sec: Math.round((sEnd - sStart) / 1000) }, anyParent());
    t = sEnd;
  }
  // Current cycle: woke 52 min ago, nursed, wet diaper.
  const fedEnd = feed(lastWake + 3 * MIN, false);
  ev({ event_type: 'diaper', started_at: iso(Math.min(now - 2 * MIN, fedEnd + 4 * MIN)), diaper_type: 'wet' }, PARENTS.yehuda);
  baby.recommended_next_side = nextSide;
  baby.last_nursing_side = events.filter((e) => e.event_type === 'nursing').pop()?.ending_side || 'left';

  // Daily vitamin D (today by הדס at 09:15 if already past), pumping sessions.
  for (let d = 13; d >= 0; d--) {
    const day = startOfDay(now) - d * DAY;
    const vd = d === 0 ? day + 9 * HOUR + 15 * MIN : day + r(8.5, 10.5) * HOUR;
    if (vd < now && vd > birth) ev({ event_type: 'medication', started_at: iso(vd), medication_code: 'vitamin_d3', metadata: { dose: '400 יחב"ל · 2 טיפות' } }, d === 0 || d % 2 ? PARENTS.hadas : PARENTS.yehuda);
    const pt = day + r(10.5, 11.5) * HOUR;
    if (pt < now - HOUR && pt > birth + 3 * DAY) {
      const R = ri(4, 7) * 10, L = ri(3, 6) * 10;
      ev({ event_type: 'pumping', started_at: iso(pt), ended_at: iso(pt + 18 * MIN), duration_sec: 18 * 60, volume_ml: R + L, metadata: { right_ml: R, left_ml: L } }, PARENTS.hadas);
    }
  }

  const stash = [
    ...[[13, 120], [11, 100], [9, 110], [8, 90], [6, 120], [5, 100]].map(([d, v]) => createBag({ baby, pumpedAt: startOfDay(now) - d * DAY + 11 * HOUR, location: 'freezer', volume: v, id: uuid() })),
    createBag({ baby, pumpedAt: now - 2 * DAY - 3 * HOUR, location: 'fridge', volume: 80, id: uuid() }),
    createBag({ baby, pumpedAt: now - 1 * DAY - 2 * HOUR, location: 'fridge', volume: 100, id: uuid() }),
    createBag({ baby, pumpedAt: now - 80 * MIN, location: 'room_temp', volume: 60, id: uuid() }),
  ];

  const growth = [
    { at: birth, w: 3350, l: 50.0, h: 34.5, notes: 'לידה' },
    { at: Date.parse('2026-10-28T10:00:00+02:00'), w: 3780, l: 52.0, h: 35.9, notes: 'טיפת חלב · שבועיים' },
    { at: Date.parse('2026-11-12T10:30:00+02:00'), w: 4450, l: 54.5, h: 37.5, notes: 'טיפת חלב · חודש' },
  ].filter((g) => g.at <= now).map((g) => {
    const m = { id: uuid(), baby_id: baby.id, household_id: household.id, measured_at: iso(g.at), weight_grams: g.w, length_cm: g.l, head_circumference_cm: g.h, notes: g.notes, updated_at: iso(g.at) };
    const a = assess(m, baby);
    return { ...m, who_weight_percentile: +a.wfa.p.toFixed(1), who_length_percentile: +a.lhfa.p.toFixed(1), who_head_percentile: +a.hcfa.p.toFixed(1) };
  });

  const members = [
    { household_id: household.id, user_id: PARENTS.yehuda.id, display_name: 'יהודה', role: 'parent_admin' },
    { household_id: household.id, user_id: PARENTS.hadas.id, display_name: 'הדס', role: 'parent_admin' },
  ];
  return { household, baby, events, stash, growth, members };
}

export async function seedIfEmpty() {
  const existing = await idb.get('kv', 'baby');
  if (existing) return false;
  await writeSeed(buildSeed());
  return true;
}

export async function writeSeed(seed) {
  await idb.putMany('local_care_events', seed.events);
  await idb.putMany('milk_stash', seed.stash);
  await idb.putMany('growth_measurements', seed.growth);
  await idb.put('kv', seed.household, 'household');
  await idb.put('kv', seed.baby, 'baby');
  await idb.put('kv', seed.members, 'members');
}
