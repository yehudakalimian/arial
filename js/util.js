// Shared helpers — time formatting (Hebrew), ids, haptics, escaping.
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // RFC4122 v4 fallback for very old WebViews
  const b = new Uint8Array(16);
  (globalThis.crypto || { getRandomValues: (a) => a.map(() => Math.random() * 256) }).getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
export const toMs = (t) => (t == null ? null : typeof t === 'number' ? t : Date.parse(t));
export const iso = (ms) => new Date(ms).toISOString();

/** 3725 -> "1:02:05", 325 -> "05:25" */
export function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}
/** 3125 -> "00:52" (hh:mm) */
export function fmtHM(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad2(sec / 3600)}:${pad2((sec % 3600) / 60)}`;
}
/** Human duration: "1 שעה ו-20 דק'" */
export function durHe(sec) {
  const totalMin = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h === 0) return `${m} דק'`;
  const hs = h === 1 ? '1 שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  return m ? `${hs} ו-${m} דק'` : hs;
}
export function relHe(ts, now = Date.now()) {
  const diff = (now - toMs(ts)) / 1000;
  if (diff < 0) return `בעוד ${durHe(-diff)}`;
  if (diff < 60) return 'הרגע';
  return `לפני ${durHe(diff)}`;
}
export function fmtClock(ts) {
  const d = new Date(toMs(ts));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function fmtDate(ts, opts = { day: 'numeric', month: 'numeric' }) {
  return new Date(toMs(ts)).toLocaleDateString('he-IL', opts);
}
const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export function dayLabel(ts, now = Date.now()) {
  const k = dayKey(ts), today = dayKey(now), y = dayKey(now - DAY);
  if (k === today) return 'היום';
  if (k === y) return 'אתמול';
  const d = new Date(toMs(ts));
  return `יום ${WEEKDAYS[d.getDay()]} · ${fmtDate(ts)}`;
}
export function dayKey(ts) {
  const d = new Date(toMs(ts));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function startOfDay(ts) {
  const d = new Date(toMs(ts)); d.setHours(0, 0, 0, 0); return d.getTime();
}
/** Local midnight after ts (DST-safe). */
export function nextMidnight(ts) {
  const d = new Date(startOfDay(ts)); d.setDate(d.getDate() + 1); return d.getTime();
}

/** Age info. Corrected age is used when born before 37 weeks (birth more than 3 weeks before due date). */
export function ageInfo(baby, now = Date.now()) {
  const birth = toMs(baby.birth_date);
  const due = baby.expected_due_date ? toMs(baby.expected_due_date) : null;
  const preterm = due != null && due - birth > 21 * DAY;
  const days = Math.floor((now - birth) / DAY);
  const ref = preterm ? due : birth;
  const correctedDays = Math.floor((now - ref) / DAY);
  const weeks = correctedDays / 7;
  const months = Math.floor(days / 30.4375);
  const child = baby.sex === 'female' ? 'בת' : 'בן';
  let label;
  if (days < 0) label = 'טרם נולד';
  else if (days < 14) label = `${child} ${days === 1 ? 'יום' : days + ' ימים'}`;
  else if (months < 1) label = `${child} ${Math.floor(days / 7)} שבועות`;
  else if (months === 1) label = `${child} חודש`;
  else if (months === 2) label = `${child} חודשיים`;
  else if (months < 24) label = `${child} ${months} חודשים`;
  else label = `${child} ${Math.floor(months / 12)}`;
  return { days, correctedDays, weeks, months, preterm, label };
}

export function vibrate(p = 40) {
  try {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; // e.g. URL quick actions before any tap
    navigator.vibrate?.(p);
  } catch { /* iOS Safari: no-op */ }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const round1 = (v) => Math.round(v * 10) / 10;
export const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
export const avg = (a) => (a.length ? sum(a) / a.length : null);

/** Overlap in ms between [a1,a2] and [b1,b2]. */
export function overlap(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }
