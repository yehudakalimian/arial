// Domain actions. Each returns { message, undo, flag? } so the UI can show the 8-second Undo toast.
import { state, write, baseRow, nowIso } from './store.js';
import { uuid, iso, toMs } from './util.js';
import * as T from './logic/timers.js';
import * as S from './logic/stash.js';
import { lockState, MEDS, doseFor, feverFlag } from './logic/meds.js';
import { stoolFlag, STOOL_COLORS } from './logic/clinical.js';
import { assess } from './logic/who.js';
import { ageInfo } from './util.js';

const me = () => state.me;

export function newEvent(fields) {
  const id = uuid(), now = nowIso();
  return {
    id, client_mutation_id: id, ...baseRow(),
    logged_by: me().user_id, logged_by_name: me().display_name,
    started_at: now, ended_at: null, duration_sec: null,
    nursing_left_sec: null, nursing_right_sec: null, ending_side: null,
    volume_ml: null, diaper_type: null, stool_color: null, medication_code: null, dosage_ml: null,
    metadata: {}, is_deleted: false, client_updated_at: now, created_at: now,
    ...fields,
  };
}

export const patchEvent = (ev, patch) => write('care_events', { ...ev, ...patch, client_updated_at: nowIso() });
export const softDelete = (ev) => patchEvent(ev, { is_deleted: true });
export const restore = (ev) => patchEvent(ev, { is_deleted: false });

function logEvent(fields) {
  const ev = write('care_events', newEvent(fields));
  return { ev, undo: () => softDelete(ev) };
}

const putTimer = (t) => write('active_timers', t);
const dropTimer = (type) => {
  const t = state.timers[type];
  if (t) write('active_timers', { id: t.id, timer_type: type, baby_id: t.baby_id, household_id: t.household_id }, 'delete');
};
const snapshotTimers = () => ({ ...state.timers });
function restoreTimers(snap) {
  for (const type of ['nursing', 'sleep', 'pumping']) {
    if (snap[type]) putTimer({ ...snap[type], updated_at: nowIso() });
    else if (state.timers[type]) dropTimer(type);
  }
}
const offsetNote = (at) => { const m = Math.round((Date.now() - at) / 60000); return m >= 1 ? ` (לפני ${m} דק')` : ''; };

// ---------- Timers ----------
function finishInternal(type, endAt) {
  const t = state.timers[type];
  if (!t) return null;
  const r = T.complete(t, endAt);
  const fields = { event_type: type, started_at: r.started_at, ended_at: r.ended_at, duration_sec: r.duration_sec };
  let babyPatch = null;
  if (type === 'nursing') {
    Object.assign(fields, { nursing_left_sec: r.nursing_left_sec, nursing_right_sec: r.nursing_right_sec, ending_side: r.ending_side, metadata: { first_side: r.first_side } });
    const rec = T.recommendNextSide(r);
    fields.metadata.recommended_next_side = rec.side;
    fields.metadata.rule = rec.rule;
    babyPatch = { id: state.baby.id, last_nursing_side: r.ending_side, recommended_next_side: rec.side, updated_at: nowIso() };
  }
  if (type === 'pumping') return { fields, timer: t };
  const ev = write('care_events', newEvent(fields));
  dropTimer(type);
  if (babyPatch) write('babies', babyPatch);
  return { ev, timer: t, babyPatch };
}

export function startTimer(type, { side = null, at = Date.now() } = {}) {
  const snap = snapshotTimers();
  const prevBaby = { id: state.baby.id, last_nursing_side: state.baby.last_nursing_side, recommended_next_side: state.baby.recommended_next_side };
  const sideEffects = [];
  if (type === 'nursing' && state.timers.sleep) sideEffects.push(finishInternal('sleep', at));
  if (type === 'sleep' && state.timers.nursing) sideEffects.push(finishInternal('nursing', at));
  putTimer(T.createTimer({ type, side, at, baby: state.baby, by: me().display_name }));
  const label = type === 'nursing' ? `הנקה צד ${T.SIDE_HE[side]}` : type === 'sleep' ? 'שינה' : 'שאיבה';
  return {
    message: `התחילה ${label}${offsetNote(at)}`,
    undo: () => { sideEffects.forEach((s) => s?.ev && softDelete(s.ev)); restoreTimers(snap); write('babies', { ...prevBaby, updated_at: nowIso() }); },
  };
}

export function nursingTap(side) {
  const t = state.timers.nursing;
  const snap = snapshotTimers();
  if (!t) return startTimer('nursing', { side, at: Date.now() });
  if (t.active_side !== side || t.status === 'PAUSED') {
    putTimer(T.switchSide(t, side, Date.now(), me().display_name));
    return { message: `הוחלף לצד ${T.SIDE_HE[side]}`, undo: () => restoreTimers(snap), quiet: true };
  }
  return null; // same running side → caller opens control sheet
}

export function pauseResume(type) {
  const t = state.timers[type]; if (!t) return null;
  const snap = snapshotTimers();
  putTimer(t.status === 'RUNNING' ? T.pause(t, Date.now(), me().display_name) : T.resume(t, Date.now(), me().display_name));
  return { message: t.status === 'RUNNING' ? 'הטיימר הושהה' : 'הטיימר חודש', undo: () => restoreTimers(snap), quiet: true };
}

export function finishTimer(type, endAt = Date.now()) {
  const snap = snapshotTimers();
  const prevBaby = { id: state.baby.id, last_nursing_side: state.baby.last_nursing_side, recommended_next_side: state.baby.recommended_next_side };
  const res = finishInternal(type, endAt);
  if (!res) return null;
  const msg = type === 'nursing'
    ? `נשמרה הנקה ${Math.round(res.ev.duration_sec / 60)} דק' · הבאה: צד ${T.SIDE_HE[res.babyPatch.recommended_next_side]}`
    : `נשמרה שינה ${Math.round(res.ev.duration_sec / 60)} דק'`;
  return {
    message: msg + offsetNote(endAt),
    undo: () => { softDelete(res.ev); restoreTimers(snap); if (type === 'nursing') write('babies', { ...prevBaby, updated_at: nowIso() }); },
  };
}

export function discardTimer(type) {
  const snap = snapshotTimers();
  dropTimer(type);
  return { message: 'הטיימר בוטל', undo: () => restoreTimers(snap) };
}

/** Zombie guard recovery: stop at personal average or explicit duration (minutes from session start). */
export function stopAtDuration(type, minutes) {
  const t = state.timers[type];
  const start = toMs(t.session_started_at);
  if (type === 'nursing') {
    // Re-base so the stored total equals `minutes`, split proportionally between sides.
    const e = T.elapsed(t);
    const total = Math.max(60, minutes * 60);
    const ratioL = e.total ? e.left / e.total : (t.active_side === 'left' ? 1 : 0);
    const fixed = { ...t, status: 'PAUSED', paused_at: iso(start + total * 1000), accumulated_total_sec: total, accumulated_left_sec: Math.round(total * ratioL), accumulated_right_sec: total - Math.round(total * ratioL) };
    const snap = snapshotTimers();
    state.timers.nursing = fixed;
    const res = finishTimer('nursing', start + total * 1000);
    return { ...res, undo: () => { res.undo(); restoreTimers(snap); } };
  }
  return finishTimer(type, start + minutes * 60000);
}

// ---------- One-tap logs ----------
export function logBottle({ volume, source, at = Date.now() }) {
  const meta = { source };
  const bagSnaps = [];
  let shortfall = 0;
  if (source === 'pumped') {
    const plan = S.allocate(state.stash, volume, at > Date.now() - 3600e3 ? Date.now() : at);
    shortfall = plan.shortfall;
    meta.allocations = plan.allocations.map((a) => ({ bag_id: a.bag.id, take: a.take }));
    meta.shortfall_ml = shortfall;
    for (const a of plan.allocations) { bagSnaps.push(a.bag); write('milk_stash', a.after); }
  }
  const { ev } = logEvent({ event_type: 'bottle', started_at: iso(at), volume_ml: volume, metadata: meta });
  const srcHe = source === 'pumped' ? 'חלב שאוב' : 'תמ״ל';
  return {
    message: `נרשם בקבוק ${volume} מ"ל ${srcHe}${offsetNote(at)}${shortfall ? ` · חסרו ${shortfall} מ"ל במלאי הזמין` : ''}`,
    undo: () => { softDelete(ev); bagSnaps.forEach((b) => write('milk_stash', { ...b, updated_at: nowIso() })); },
  };
}

export function logDiaper({ type, color = null, at = Date.now() }) {
  const days = ageInfo(state.baby).days;
  const flag = color ? stoolFlag(color, days) : null;
  const { ev, undo } = logEvent({ event_type: 'diaper', started_at: iso(at), diaper_type: type, stool_color: type === 'wet' ? null : color, metadata: flag ? { red_flag: true } : {} });
  const he = { wet: 'חיתול רטוב', dirty: 'חיתול מלוכלך', mixed: 'חיתול משולב' }[type];
  return { ev, message: `נרשם ${he}${color && type !== 'wet' ? ` · ${STOOL_COLORS[color].label}` : ''}${offsetNote(at)}`, undo, flag };
}

export function setStoolColor(ev, color) {
  const cur = state.events.find((e) => e.client_mutation_id === ev.client_mutation_id) || ev;
  const flag = stoolFlag(color, ageInfo(state.baby).days);
  patchEvent(cur, { stool_color: color, metadata: { ...cur.metadata, red_flag: !!flag } });
  return flag;
}

export function logMed(code, { at = Date.now() } = {}) {
  const age = ageInfo(state.baby);
  const lock = lockState(code, state.events, { now: Date.now(), ageDays: age.days });
  if (lock.locked) return { blocked: true, message: 'התרופה נעולה כרגע — מניעת מנה כפולה' };
  const latestW = [...state.growth].filter((g) => g.weight_grams).sort((a, b) => toMs(b.measured_at) - toMs(a.measured_at))[0];
  const dose = doseFor(code, latestW?.weight_grams, state.settings.conc[code]);
  const { undo } = logEvent({
    event_type: 'medication', started_at: iso(at), medication_code: code, dosage_ml: dose?.ml ?? null,
    metadata: dose ? { mg: dose.mg, conc_mg_ml: dose.conc, weight_grams: latestW.weight_grams } : { dose: MEDS[code].dose },
  });
  return { message: `נרשם ${MEDS[code].label}${dose ? ` ${dose.ml} מ"ל` : ''}${offsetNote(at)}`, undo };
}

export function logTemp(tempC, { at = Date.now() } = {}) {
  const flag = feverFlag(tempC, ageInfo(state.baby).days);
  const { undo } = logEvent({ event_type: 'temperature', started_at: iso(at), metadata: { temp_c: tempC, flag: flag?.level ?? null } });
  return { message: `נרשם חום גוף ${tempC.toFixed(1)}°C`, undo, flag: flag?.level === 'red' ? flag : null, feverFlag: flag };
}

/** Pumping: logs ml (R+L), closes the pump timer if running, and adds a bag to the FIFO stash. */
export function logPump({ right, left, location, at = Date.now() }) {
  const snap = snapshotTimers();
  const fin = state.timers.pumping ? finishInternal('pumping', at) : null;
  const total = (right || 0) + (left || 0);
  const fields = fin?.fields || { event_type: 'pumping', started_at: iso(at) };
  const { ev } = logEvent({ ...fields, volume_ml: total, metadata: { right_ml: right, left_ml: left, location } });
  if (fin) dropTimer('pumping');
  let bag = null;
  if (total > 0) {
    bag = S.createBag({ baby: state.baby, pumpedAt: toMs(fields.ended_at || fields.started_at), location, volume: total, id: uuid() });
    write('milk_stash', bag);
  }
  return {
    message: `נרשמה שאיבה ${total} מ"ל · נוספה שקית ל${S.LOCATIONS[location].label}`,
    undo: () => { softDelete(ev); if (bag) write('milk_stash', { ...bag, status: 'CONSUMED', remaining_volume_ml: 0, updated_at: nowIso(), metadata: { undone: true } }); restoreTimers(snap); },
  };
}

// ---------- Stash ----------
export function moveBag(bag, to) {
  const before = { ...bag };
  write('milk_stash', S.moveBag(bag, to));
  const he = to === 'thawed_fridge' ? 'השקית הופשרה · בתוקף 24 שעות' : `הועבר ל${S.LOCATIONS[to].label}`;
  return { message: he, undo: () => write('milk_stash', { ...before, updated_at: nowIso() }) };
}
export function discardBag(bag) {
  const before = { ...bag };
  write('milk_stash', { ...bag, status: 'EXPIRED_DISCARDED', updated_at: nowIso() });
  return { message: `שקית ${bag.remaining_volume_ml} מ"ל הושלכה`, undo: () => write('milk_stash', { ...before, updated_at: nowIso() }) };
}
export function addBag({ volume, location, at = Date.now() }) {
  const bag = write('milk_stash', S.createBag({ baby: state.baby, pumpedAt: at, location, volume, id: uuid() }));
  return { message: `נוספה שקית ${volume} מ"ל ל${S.LOCATIONS[location].label}`, undo: () => write('milk_stash', { ...bag, status: 'CONSUMED', remaining_volume_ml: 0, updated_at: nowIso() }) };
}

// ---------- Growth ----------
export function addGrowth({ weight_grams, length_cm, head_circumference_cm, at = Date.now(), notes = '' }) {
  const m = { id: uuid(), ...baseRow(), measured_at: iso(at), weight_grams, length_cm, head_circumference_cm, notes, updated_at: nowIso() };
  const a = assess(m, state.baby);
  m.who_weight_percentile = a.wfa ? +a.wfa.p.toFixed(1) : null;
  m.who_length_percentile = a.lhfa ? +a.lhfa.p.toFixed(1) : null;
  m.who_head_percentile = a.hcfa ? +a.hcfa.p.toFixed(1) : null;
  write('growth_measurements', m);
  return { message: `נשמרה מדידה · משקל אחוזון ${Math.round(m.who_weight_percentile)}`, undo: () => write('growth_measurements', m, 'delete') };
}

/** Shift an event's time by `deltaMin` (zero-typing editing in the journal). */
export function shiftEvent(ev, deltaMin) {
  const d = deltaMin * 60000;
  const patch = { started_at: iso(toMs(ev.started_at) + d) };
  if (ev.ended_at) patch.ended_at = iso(toMs(ev.ended_at) + d);
  return patchEvent(ev, patch);
}
