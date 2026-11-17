// "דוח טיפת חלב / רופא" — clinical summary, printable & shareable.
import { esc, ageInfo, fmtDate, toMs, DAY } from '../util.js';
import { summary, hydration, STOOL_COLORS } from '../logic/clinical.js';
import { assess, crossingAlerts } from '../logic/who.js';
import { MEDS } from '../logic/meds.js';
import { I } from './icons.js';
import { growthChart } from './charts.js';
import { eventSummary, clock } from './common.js';

const f1 = (v) => (v == null ? '—' : v.toFixed(1).replace(/^-0\.0$/, '0.0'));
const f0 = (v) => (v == null ? '—' : Math.round(v).toString());

export function reportData(s, now = Date.now()) {
  const age = ageInfo(s.baby, now);
  const s7 = summary(s.events, 7, now), s14 = summary(s.events, 14, now);
  const latest = [...s.growth].sort((a, b) => toMs(b.measured_at) - toMs(a.measured_at))[0];
  const a = latest ? assess(latest, s.baby) : {};
  const flags = s.events.filter((e) => !e.is_deleted && (e.metadata?.red_flag || e.metadata?.flag === 'red' || (e.event_type === 'temperature' && e.metadata?.temp_c >= 38)) && toMs(e.started_at) > now - 14 * DAY);
  const meds = s.events.filter((e) => !e.is_deleted && e.event_type === 'medication' && !['vitamin_d3', 'iron_drops'].includes(e.medication_code) && toMs(e.started_at) > now - 14 * DAY);
  return { age, s7, s14, latest, a, flags, meds, hyd: hydration(s.events, age.days, now), crossings: crossingAlerts(s.growth, s.baby) };
}

export function reportText(s, now = Date.now()) {
  const d = reportData(s, now);
  const L = [
    `סיכום עבור טיפת חלב / רופא — ${s.baby.name}, ${d.age.label} (נולד ${fmtDate(s.baby.birth_date)})`,
    d.latest ? `מדידה אחרונה ${fmtDate(d.latest.measured_at)}: משקל ${d.latest.weight_grams} גרם (P${f0(d.a.wfa?.p)}), אורך ${d.latest.length_cm} ס"מ (P${f0(d.a.lhfa?.p)}), היקף ראש ${d.latest.head_circumference_cm} ס"מ (P${f0(d.a.hcfa?.p)})` : '',
    `ממוצע 7 ימים: ${f1(d.s7.feeds)} האכלות/יום (הנקה ${f1(d.s7.nursingSessions)}, ~${f0(d.s7.nursingMinAvg)} דק'), בקבוק ${f0(d.s7.bottleMl)} מ"ל/יום, רטובים ${f1(d.s7.wet)}/יום, צואה ${f1(d.s7.dirty)}/יום, שינה ${f1(d.s7.sleepH)} ש׳ (יום ${f1(d.s7.sleepDayH)}, לילה ${f1(d.s7.sleepNightH)})`,
    `ויטמין D: ${d.s7.vitD.given}/${d.s7.vitD.of} ימים בשבוע האחרון`,
    d.flags.length ? `דגלים: ${d.flags.map((e) => `${fmtDate(e.started_at)} ${eventSummary(e)}`).join('; ')}` : 'ללא דגלים אדומים ב-14 הימים האחרונים',
  ];
  return L.filter(Boolean).join('\n');
}

export function renderReport(s, now = Date.now()) {
  const d = reportData(s, now);
  const row = (label, a, b, unit = '') => `<tr><th>${label}</th><td class="mono">${a}${unit}</td><td class="mono">${b}${unit}</td></tr>`;
  const ironRelevant = d.age.days >= MEDS.iron_drops.fromDays;
  return `<div class="page report">
    <div class="report-head">
      <div><h2 class="page-title">${I.doc} דוח טיפת חלב / רופא</h2>
      <p class="report-id"><b>${esc(s.baby.name)}</b> · ${s.baby.sex === 'female' ? 'בת' : 'בן'} · נולד ${fmtDate(s.baby.birth_date)} · ${d.age.label} (${d.age.days} ימים${d.age.preterm ? `, גיל מתוקן ${d.age.correctedDays} ימים` : ''})</p>
      <p class="muted">הופק ${fmtDate(now, { day: 'numeric', month: 'long', year: 'numeric' })} ${clock(now)} · הורים: ${s.members.map((m) => esc(m.display_name)).join(', ')}</p></div>
      <div class="row no-print"><button class="btn" data-act="print">${I.print} הדפסה / PDF</button><button class="btn" data-act="share-report">${I.share} שיתוף</button></div>
    </div>

    ${d.crossings.map((c) => `<div class="alert alert-red">${I.alert}<span>${c.label}: חציית 2 קווי אחוזון (P${Math.round(c.from)} → P${Math.round(c.to)})</span></div>`).join('')}
    ${d.hyd.alert ? `<div class="alert alert-red">${I.alert}<span>הידרציה: ${d.hyd.wet24} חיתולים רטובים ב-24 שעות (סף ${d.hyd.threshold})</span></div>` : ''}

    <h3 class="grp">גדילה (תקני WHO)</h3>
    ${d.latest ? `<div class="kpis">
      <div class="kpi"><b class="mono">${(d.latest.weight_grams / 1000).toFixed(2)}</b><span>ק"ג · אחוזון ${f0(d.a.wfa?.p)}</span></div>
      <div class="kpi"><b class="mono">${d.latest.length_cm}</b><span>ס"מ אורך · אחוזון ${f0(d.a.lhfa?.p)}</span></div>
      <div class="kpi"><b class="mono">${d.latest.head_circumference_cm}</b><span>ס"מ ראש · אחוזון ${f0(d.a.hcfa?.p)}</span></div>
    </div><p class="muted">מדידה אחרונה ${fmtDate(d.latest.measured_at)} · Z משקל ${f1(d.a.wfa?.z)} · Z אורך ${f1(d.a.lhfa?.z)} · Z ראש ${f1(d.a.hcfa?.z)}</p>` : '<p class="hint">אין מדידות.</p>'}
    <div class="charts print-charts">${growthChart('wfa', s.baby, s.growth, now)}${growthChart('lhfa', s.baby, s.growth, now)}${growthChart('hcfa', s.baby, s.growth, now)}</div>

    <h3 class="grp">ממוצעים יומיים</h3>
    <table class="tbl clinical"><thead><tr><th></th><th>7 ימים</th><th>14 ימים</th></tr></thead><tbody>
      ${row('האכלות ליום (סה״כ)', f1(d.s7.feeds), f1(d.s14.feeds))}
      ${row('הנקות ליום', f1(d.s7.nursingSessions), f1(d.s14.nursingSessions))}
      ${row('משך הנקה ממוצע', f0(d.s7.nursingMinAvg), f0(d.s14.nursingMinAvg), " דק'")}
      ${row('בקבוק (מ"ל ליום)', f0(d.s7.bottleMl), f0(d.s14.bottleMl))}
      ${row('חיתולים רטובים / 24ש׳', f1(d.s7.wet), f1(d.s14.wet))}
      ${row('צואה / 24ש׳', f1(d.s7.dirty), f1(d.s14.dirty))}
      ${row('שינה כוללת (ש׳)', f1(d.s7.sleepH), f1(d.s14.sleepH))}
      ${row('· שינת יום 07–19', f1(d.s7.sleepDayH), f1(d.s14.sleepDayH))}
      ${row('· שינת לילה 19–07', f1(d.s7.sleepNightH), f1(d.s14.sleepNightH))}
      ${row('שאיבה (מ"ל ליום)', f0(d.s7.pumpedMl), f0(d.s14.pumpedMl))}
      ${row('ויטמין D3 — היענות', `${d.s7.vitD.given}/${d.s7.vitD.of}`, `${d.s14.vitD.given}/${d.s14.vitD.of}`, ' ימים')}
      ${row('ברזל — היענות', ironRelevant ? `${d.s7.iron.given}/${d.s7.iron.of}` : 'מגיל 4 ח׳', ironRelevant ? `${d.s14.iron.given}/${d.s14.iron.of}` : '—')}
    </tbody></table>

    <h3 class="grp">דגלים קליניים ותרופות (14 יום)</h3>
    <ul class="log">${d.flags.map((e) => `<li class="log-row flag"><span class="mono log-time">${fmtDate(e.started_at)} ${clock(e.started_at)}</span><span class="log-sum">${esc(eventSummary(e))}</span></li>`).join('') || '<li class="log-row"><span class="log-sum">ללא דגלים אדומים (צבע צואה, חום)</span></li>'}
    ${d.meds.map((e) => `<li class="log-row"><span class="mono log-time">${fmtDate(e.started_at)} ${clock(e.started_at)}</span><span class="log-sum">${esc(eventSummary(e))} · ${esc(e.logged_by_name || '')}</span></li>`).join('')}</ul>
    <p class="hint">צבעי צואה תקינים: ${['yellow', 'green', 'brown'].map((k) => STOOL_COLORS[k].label).join(', ')}. הדוח אינו מהווה תחליף לייעוץ רפואי.</p>
  </div>`;
}
