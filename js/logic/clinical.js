// Diaper hydration, stool red flags and Tipat Halav / pediatrician aggregates.
import { HOUR, DAY, toMs, overlap, startOfDay, avg, sum } from '../util.js';

export const STOOL_COLORS = {
  yellow: { label: 'צהוב-חרדל', note: 'תקין', hex: '#D9A520' },
  green: { label: 'ירוק', note: 'לרוב תקין', hex: '#6B8E23' },
  brown: { label: 'חום', note: 'תקין', hex: '#8B5A2B' },
  black: { label: 'שחור', note: 'תקין רק בימים 1–4 (מקוניום)', hex: '#141414' },
  red: { label: 'אדום/דמי', note: 'דגל אדום', hex: '#B91C1C' },
  white_acholic: { label: 'לבן/אפור חיוור', note: 'דגל אדום', hex: '#E7E3D4' },
};

export function stoolFlag(color, ageDays) {
  if (color === 'white_acholic') return {
    title: 'צואה לבנה/אפורה חיוורת (אכולית)',
    body: 'צבע זה עלול להעיד על חסימה בדרכי המרה (Biliary Atresia). יש לפנות לרופא/ת הילדים עוד היום ולהביא תמונה של החיתול. אבחון מוקדם (לפני גיל 60 יום) משפר משמעותית את הטיפול.',
  };
  if (color === 'red') return {
    title: 'דם או צבע אדום בצואה',
    body: 'יש לפנות לבדיקה רפואית בהקדם. שמרו את החיתול או צלמו אותו לרופא/ה.',
  };
  if (color === 'black' && ageDays > 5) return {
    title: 'צואה שחורה אחרי היום החמישי',
    body: 'אחרי שלב המקוניום, צואה שחורה עלולה להעיד על דם מעוכל. יש לפנות לרופא/ה. (בתוספת ברזל צבע כהה יכול להיות תקין — ציינו זאת לרופא/ה.)',
  };
  return null;
}

const alive = (events) => events.filter((e) => !e.is_deleted);
const isWet = (e) => e.event_type === 'diaper' && (e.diaper_type === 'wet' || e.diaper_type === 'mixed');
const isDirty = (e) => e.event_type === 'diaper' && (e.diaper_type === 'dirty' || e.diaper_type === 'mixed');

/** AAP/MOH: ≥6 wet diapers per 24h after day 5. Only alerts once tracking covers a full 24h. */
export function hydration(events, ageDays, now = Date.now()) {
  const ev = alive(events);
  const wet24 = ev.filter((e) => isWet(e) && toMs(e.started_at) > now - DAY && toMs(e.started_at) <= now).length;
  const earliest = ev.reduce((m, e) => Math.min(m, toMs(e.started_at)), Infinity);
  const covered = earliest <= now - DAY;
  const threshold = 6;
  return { wet24, threshold, alert: ageDays > 5 && covered && wet24 < threshold };
}

const NIGHT_START = 19, NIGHT_END = 7;
/** Split sleep [s,e] into day/night ms (night = 19:00–07:00). */
export function splitSleep(s, e) {
  let night = 0;
  for (let d = startOfDay(s) - DAY; d < e; d += DAY) {
    const ns = d + NIGHT_START * HOUR, ne = d + DAY + NIGHT_END * HOUR;
    night += overlap(s, e, ns, ne);
  }
  return { night, day: e - s - night };
}

/** Averages over the last `days` full-ish days ending now. */
export function summary(events, days, now = Date.now()) {
  const from = now - days * DAY;
  const ev = alive(events).filter((e) => toMs(e.started_at) >= from && toMs(e.started_at) <= now);
  const per = (n) => n / days;
  const nursing = ev.filter((e) => e.event_type === 'nursing');
  const bottles = ev.filter((e) => e.event_type === 'bottle');
  let sleepDay = 0, sleepNight = 0;
  for (const s of alive(events).filter((e) => e.event_type === 'sleep' && e.ended_at)) {
    const a = Math.max(toMs(s.started_at), from), b = Math.min(toMs(s.ended_at), now);
    if (b <= a) continue;
    const sp = splitSleep(a, b); sleepDay += sp.day; sleepNight += sp.night;
  }
  const dayKeys = new Set();
  for (let t = startOfDay(from) + DAY; t <= now; t += DAY) dayKeys.add(startOfDay(t));
  const medDays = (code) => {
    const given = new Set(ev.filter((e) => e.event_type === 'medication' && e.medication_code === code).map((e) => startOfDay(toMs(e.started_at))));
    const ks = [...dayKeys]; return { given: ks.filter((k) => given.has(k)).length, of: ks.length };
  };
  return {
    days,
    feeds: per(nursing.length + bottles.length),
    nursingSessions: per(nursing.length),
    nursingMinAvg: avg(nursing.map((e) => (e.duration_sec || 0) / 60)),
    bottleMl: per(sum(bottles.map((e) => e.volume_ml))),
    bottleCount: per(bottles.length),
    wet: per(ev.filter(isWet).length),
    dirty: per(ev.filter(isDirty).length),
    sleepH: (sleepDay + sleepNight) / HOUR / days,
    sleepDayH: sleepDay / HOUR / days,
    sleepNightH: sleepNight / HOUR / days,
    pumpedMl: per(sum(ev.filter((e) => e.event_type === 'pumping').map((e) => e.volume_ml))),
    vitD: medDays('vitamin_d3'),
    iron: medDays('iron_drops'),
    redFlags: ev.filter((e) => e.event_type === 'diaper' && e.metadata?.red_flag).length,
    fevers: ev.filter((e) => e.event_type === 'temperature' && e.metadata?.temp_c >= 38).length,
  };
}

/** Per-day series for charts (last n days, oldest first). */
export function dailySeries(events, n, now = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const s = startOfDay(now) - i * DAY, e = s + DAY;
    const ev = alive(events).filter((x) => toMs(x.started_at) >= s && toMs(x.started_at) < e);
    let sleep = 0;
    for (const x of alive(events).filter((x) => x.event_type === 'sleep' && x.ended_at)) sleep += overlap(toMs(x.started_at), toMs(x.ended_at), s, Math.min(e, now));
    out.push({
      day: s,
      feeds: ev.filter((x) => x.event_type === 'nursing' || x.event_type === 'bottle').length,
      wet: ev.filter(isWet).length,
      dirty: ev.filter(isDirty).length,
      sleepH: sleep / HOUR,
      bottleMl: sum(ev.filter((x) => x.event_type === 'bottle').map((x) => x.volume_ml)),
    });
  }
  return out;
}
