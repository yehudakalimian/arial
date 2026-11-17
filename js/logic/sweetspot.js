// Adaptive wake-window ("SweetSpot") nap predictor.
// W_eff = ((1-alpha)*W_age + alpha*W_personal_10d) * dayFactor - short_nap_penalty
import { MIN, DAY, toMs, ageInfo, avg } from '../util.js';

export const WAKE_TABLE = [
  { maxWeeks: 4, min: 35, max: 60, naps: [4, 6], label: '0–4 שבועות' },
  { maxWeeks: 8, min: 45, max: 75, naps: [4, 5], label: '4–8 שבועות' },
  { maxWeeks: 17.4, min: 60, max: 100, naps: [4, 4], label: '2–4 חודשים' },
  { maxWeeks: 26, min: 90, max: 150, naps: [3, 4], label: '4–6 חודשים', transition: true },
  { maxWeeks: 39, min: 120, max: 180, naps: [2, 3], label: '6–9 חודשים' },
  { maxWeeks: Infinity, min: 165, max: 240, naps: [2, 2], label: '9–12+ חודשים' },
];

export const ageBand = (weeks) => WAKE_TABLE.find((r) => weeks < r.maxWeeks);

const hourOf = (ts) => new Date(toMs(ts)).getHours();
/** Night sleep: starts 19:00–05:59 or lasts 5h+. */
export const isNightSleep = (ev) => {
  const h = hourOf(ev.started_at);
  return h >= 19 || h < 6 || (toMs(ev.ended_at) - toMs(ev.started_at)) >= 5 * 3600e3;
};

function sleepsOf(events) {
  return events.filter((e) => e.event_type === 'sleep' && !e.is_deleted && e.ended_at)
    .sort((a, b) => toMs(a.started_at) - toMs(b.started_at));
}

/** Personal day-time wake windows over the last 10 days (minutes). */
export function personalStats(events, band, now = Date.now()) {
  const sleeps = sleepsOf(events).filter((e) => toMs(e.started_at) >= now - 10 * DAY);
  const windows = [], napDur = [];
  for (let i = 1; i < sleeps.length; i++) {
    const wake = toMs(sleeps[i - 1].ended_at), next = toMs(sleeps[i].started_at);
    const w = (next - wake) / MIN;
    const h = new Date(wake).getHours();
    if (h >= 6 && h < 20 && w >= 15 && w <= band.max * 2 && !isNightSleep(sleeps[i])) windows.push(w);
  }
  const naps = sleeps.filter((e) => !isNightSleep(e));
  for (const n of naps) napDur.push((toMs(n.ended_at) - toMs(n.started_at)) / MIN);
  return { windows, napCount: naps.length, wPersonal: avg(windows), napAvg: avg(napDur) };
}

/**
 * Predict the next sleep window.
 * @returns null when baby is asleep / no data, else prediction object.
 */
export function predict({ events, baby, sleepTimer = null, now = Date.now() }) {
  const age = ageInfo(baby, now);
  const band = ageBand(age.weeks);
  const W_age = (band.min + band.max) / 2;
  const stats = personalStats(events, band, now);
  if (sleepTimer) return { asleep: true, band, W_age, stats, napAvg: stats.napAvg ?? 60 };

  const sleeps = sleepsOf(events);
  const prev = sleeps[sleeps.length - 1];
  if (!prev) return null;
  const wakeAt = toMs(prev.ended_at);

  const alpha = stats.wPersonal == null ? 0 : 0.65 * Math.min(1, stats.napCount / 30);
  const W_blend = (1 - alpha) * W_age + alpha * (stats.wPersonal ?? W_age);

  // Daily progression
  const wakeHour = new Date(wakeAt).getHours();
  const prevNight = isNightSleep(prev);
  const isFirst = prevNight && wakeHour >= 4 && wakeHour < 11;
  const morningWake = (() => {
    for (let i = sleeps.length - 1; i >= 0; i--) if (isNightSleep(sleeps[i]) && toMs(sleeps[i].ended_at) <= wakeAt) return toMs(sleeps[i].ended_at);
    return null;
  })();
  const napsToday = morningWake == null ? 0 : sleeps.filter((s) => toMs(s.started_at) >= morningWake && !isNightSleep(s)).length;
  const provisional = wakeAt + W_blend * MIN;
  const pd = new Date(provisional);
  const pdMin = pd.getHours() * 60 + pd.getMinutes();
  const isBedtime = !isFirst && wakeHour >= 15 && (pdMin >= 18 * 60 + 30 || (napsToday >= band.naps[1] && pdMin >= 17 * 60));
  const nightFeedWake = prevNight && !isFirst && (wakeHour >= 20 || wakeHour < 4);
  const factor = isFirst ? 0.85 : isBedtime ? 1.2 : 1;

  // Short-nap penalty
  const D_prev = (toMs(prev.ended_at) - toMs(prev.started_at)) / MIN;
  const penalty = !prevNight && D_prev < 35 ? Math.max(0, Math.round((40 - D_prev) * 0.6)) : 0;

  const W_eff = Math.max(band.min * 0.7, W_blend * factor - penalty);
  const target = wakeAt + W_eff * MIN;
  const res = {
    asleep: false, band, age, wakeAt, W_age, W_personal: stats.wPersonal, W_blend, alpha, factor, penalty, D_prev,
    W_eff, target, windowStart: target - 10 * MIN, windowEnd: target + 10 * MIN,
    kind: isBedtime ? 'bedtime' : nightFeedWake ? 'night' : 'nap', isFirst, napsToday, stats,
    alerts: { prepare: target - 20 * MIN, open: target - 5 * MIN },
  };
  if (band.transition) {
    // 4–5 month nap transition: dual prediction (stay on 4 naps vs. move to 3 longer windows)
    const W_alt = Math.min(band.max, W_eff * 1.25);
    res.alt = { W_eff: W_alt, target: wakeAt + W_alt * MIN };
  }
  return res;
}

export const progress = (p, now = Date.now()) =>
  !p || p.asleep ? 0 : Math.min(1, Math.max(0, (now - p.wakeAt) / (p.target - p.wakeAt)));

/** Projected rest-of-day schedule (naps + bedtime) from current prediction. */
export function dayPlan({ events, baby, sleepTimer, now = Date.now() }) {
  const p = predict({ events, baby, sleepTimer, now });
  if (!p || p.asleep) return { p, items: [] };
  const napLen = Math.round(p.stats.napAvg ?? 60);
  const band = p.band;
  const items = [];
  let wake = p.wakeAt, W = p.W_eff, napsDone = p.napsToday;
  let start = p.target;
  for (let i = 0; i < 8; i++) {
    const s = new Date(start);
    const mins = s.getHours() * 60 + s.getMinutes();
    const bedtime = napsDone >= band.naps[1] || mins >= 18 * 60 + 30;
    if (bedtime || mins < 6 * 60 && i > 0) { items.push({ kind: 'bedtime', start, end: null }); break; }
    items.push({ kind: 'nap', start, end: start + napLen * MIN });
    napsDone++;
    wake = start + napLen * MIN;
    W = p.W_blend * (napsDone >= band.naps[1] - 1 ? 1.2 : 1);
    start = wake + W * MIN;
  }
  return { p, items };
}
