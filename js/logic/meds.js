// Anti-duplication medication & supplement safety locks (shared across both parents' devices,
// because locks are derived from synced care_events — not local UI state).
import { HOUR, DAY, toMs, startOfDay, nextMidnight, round1 } from '../util.js';

export const MEDS = {
  vitamin_d3: { label: 'ויטמין D3', dose: '400 יחב"ל · 2 טיפות', kind: 'daily', fromDays: 0, toDays: 365 },
  iron_drops: { label: 'ברזל', dose: 'טיפות ברזל יומיות', kind: 'daily', fromDays: 122, toDays: 548 },
  paracetamol_novimol: {
    label: 'נובימול', generic: 'פרצטמול', kind: 'interval', intervalH: 4, max24: 5, mgPerKg: 15,
    defaultConc: 32, // mg/ml (160 מ"ג / 5 מ"ל). The user must verify against the bottle in Settings.
    cross: 'ibuprofen_nurofen', warnUnderDays: 91,
  },
  ibuprofen_nurofen: {
    label: 'נורופן', generic: 'איבופרופן', kind: 'interval', intervalH: 6, max24: 3, mgPerKg: 10,
    defaultConc: 20, // mg/ml (100 מ"ג / 5 מ"ל)
    cross: 'paracetamol_novimol', minAgeDays: 91,
  },
};
export const CROSS_GAP_H = 2;

const medEvents = (events, code) => events
  .filter((e) => e.event_type === 'medication' && e.medication_code === code && !e.is_deleted)
  .sort((a, b) => toMs(b.started_at) - toMs(a.started_at));

/** Dose calculator (mg/kg on the latest logged weight). */
export function doseFor(code, weightGrams, concMgPerMl) {
  const m = MEDS[code];
  if (!m?.mgPerKg || !weightGrams) return null;
  const mg = Math.round(m.mgPerKg * (weightGrams / 1000));
  const conc = concMgPerMl || m.defaultConc;
  return { mg, ml: round1(mg / conc), conc };
}

/**
 * Lock state for a medication.
 * { locked, reason, until, last, by, count24, warning, ageNote }
 */
export function lockState(code, events, { now = Date.now(), ageDays = 0 } = {}) {
  const m = MEDS[code];
  const list = medEvents(events, code);
  const last = list[0] || null;
  const res = { code, locked: false, reason: null, until: null, last, by: last?.logged_by_name, count24: 0, warning: null, ageNote: null };

  if (m.kind === 'daily') {
    if (ageDays < m.fromDays) res.ageNote = `מומלץ מגיל ${Math.round(m.fromDays / 30.4)} חודשים`;
    if (ageDays > m.toDays) res.ageNote = 'מעבר לטווח הגילאים המומלץ';
    if (last && toMs(last.started_at) >= startOfDay(now)) {
      Object.assign(res, { locked: true, reason: 'given_today', until: nextMidnight(now) });
    }
    return res;
  }

  if (m.minAgeDays && ageDays < m.minAgeDays) {
    return { ...res, locked: true, reason: 'age', ageNote: 'לא מאושר מתחת לגיל 3 חודשים — רק בהוראת רופא' };
  }
  if (m.warnUnderDays && ageDays < m.warnUnderDays) res.ageNote = 'מתחת לגיל 3 חודשים — רק בהנחיית רופא. חום ‎≥38°C מחייב פנייה מיידית.';

  const in24 = list.filter((e) => toMs(e.started_at) > now - DAY);
  res.count24 = in24.length;
  const candidates = [];
  if (last) {
    const next = toMs(last.started_at) + m.intervalH * HOUR;
    if (next > now) candidates.push({ until: next, reason: 'interval' });
  }
  if (in24.length >= m.max24) {
    const oldest = in24[in24.length - 1];
    candidates.push({ until: toMs(oldest.started_at) + DAY, reason: 'max24' });
  }
  const crossLast = medEvents(events, m.cross)[0];
  if (crossLast) {
    const until = toMs(crossLast.started_at) + CROSS_GAP_H * HOUR;
    if (until > now) {
      candidates.push({ until, reason: 'cross' });
      res.warning = `ניתן ${MEDS[m.cross].label} לאחרונה — יש להמתין שעתיים בין תרופות שונות`;
    }
  }
  if (candidates.length) {
    const c = candidates.reduce((a, b) => (b.until > a.until ? b : a));
    Object.assign(res, { locked: true, reason: c.reason, until: c.until });
  }
  return res;
}

/** Fever guidance (temperature in °C). */
export function feverFlag(tempC, ageDays) {
  if (tempC >= 38 && ageDays < 91) return { level: 'red', title: 'חום ‎≥38°C בתינוק מתחת לגיל 3 חודשים', body: 'יש לפנות מיד לרופא/ה או לחדר מיון. אין לתת תרופה להורדת חום לפני בדיקה רפואית, אלא בהנחיית רופא.' };
  if (tempC >= 39) return { level: 'red', title: `חום גבוה ${tempC.toFixed(1)}°C`, body: 'מומלץ להתייעץ עם רופא/ת הילדים היום.' };
  if (tempC >= 38) return { level: 'amber', title: `חום ${tempC.toFixed(1)}°C`, body: 'מעקב והשקיה. פנו לרופא אם מופיעים ישנוניות, סירוב לאכול או פריחה.' };
  if (tempC < 36) return { level: 'amber', title: `חום גוף נמוך ${tempC.toFixed(1)}°C`, body: 'יש לחמם את התינוק ולמדוד שוב. אם נמשך — פנו לרופא.' };
  return null;
}
