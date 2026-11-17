// WHO Child Growth Standards — LMS z-scores, percentiles, curves and band-crossing alerts.
import { WHO_LMS, WHO_STEP_DAYS } from '../data/who-lms.js';

export const INDICATORS = {
  wfa: { label: 'משקל לגיל', unit: 'ק"ג', field: 'weight_grams', toValue: (m) => m.weight_grams / 1000 },
  lhfa: { label: 'אורך לגיל', unit: 'ס"מ', field: 'length_cm', toValue: (m) => m.length_cm },
  hcfa: { label: 'היקף ראש לגיל', unit: 'ס"מ', field: 'head_circumference_cm', toValue: (m) => m.head_circumference_cm },
};
export const PCT_LINES = [3, 15, 50, 85, 97];
const Z_LINES = { 3: -1.880794, 15: -1.036433, 50: 0, 85: 1.036433, 97: 1.880794 };

export function lmsAt(ind, sex, days) {
  const t = WHO_LMS[ind][sex === 'female' ? 'female' : 'male'];
  const x = Math.max(0, Math.min(days, (t.length - 1) * WHO_STEP_DAYS)) / WHO_STEP_DAYS;
  const i = Math.floor(x), f = x - i, a = t[i], b = t[Math.min(i + 1, t.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const xAt = (z, L, M, S) => (L === 0 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L));

export function zScore(ind, sex, days, x) {
  const [L, M, S] = lmsAt(ind, sex, days);
  let z = L === 0 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
  if (ind === 'wfa' && Math.abs(z) > 3) { // WHO restricted-tail adjustment
    const sd3 = xAt(3 * Math.sign(z), L, M, S), sd2 = xAt(2 * Math.sign(z), L, M, S);
    z = 3 * Math.sign(z) + (x - sd3) / Math.abs(sd3 - sd2);
  }
  return z;
}

// Abramowitz–Stegun 7.1.26 normal CDF
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export const percentile = (z) => Math.min(99.9, Math.max(0.1, normCdf(z) * 100));

/** Band index between WHO lines 3/15/50/85/97 → 0..5 */
export const band = (p) => PCT_LINES.filter((l) => p >= l).length;

export function curve(ind, sex, pct, maxDays, step = 7) {
  const pts = [];
  for (let d = 0; d <= maxDays; d += step) { const [L, M, S] = lmsAt(ind, sex, d); pts.push([d, xAt(Z_LINES[pct], L, M, S)]); }
  return pts;
}

export function assess(measurement, baby) {
  const days = (Date.parse(measurement.measured_at) - Date.parse(baby.birth_date)) / 864e5;
  const out = {};
  for (const [ind, def] of Object.entries(INDICATORS)) {
    const v = measurement[def.field];
    if (v == null) continue;
    const z = zScore(ind, baby.sex, days, def.toValue(measurement));
    out[ind] = { z, p: percentile(z) };
  }
  return out;
}

/** Alert when a metric crosses ≥2 percentile bands between the earliest (after day 14) and latest measurement. */
export function crossingAlerts(measurements, baby) {
  const sorted = [...measurements].sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  const alerts = [];
  for (const [ind, def] of Object.entries(INDICATORS)) {
    const withV = sorted.filter((m) => m[def.field] != null);
    if (withV.length < 2) continue;
    const latest = withV[withV.length - 1];
    const ref = withV.find((m) => (Date.parse(m.measured_at) - Date.parse(baby.birth_date)) / 864e5 >= 14 && m !== latest) || withV[0];
    const a = assess(ref, baby)[ind], b = assess(latest, baby)[ind];
    const diff = band(b.p) - band(a.p);
    if (Math.abs(diff) >= 2) alerts.push({ ind, label: def.label, from: a.p, to: b.p, dir: diff < 0 ? 'down' : 'up' });
  }
  return alerts;
}
