// "יומן וגדילה" — full history, analytics and WHO growth curves.
import { esc, dayKey, dayLabel, toMs, fmtDate } from '../util.js';
import { dailySeries } from '../logic/clinical.js';
import { assess, crossingAlerts, INDICATORS } from '../logic/who.js';
import { I } from './icons.js';
import { barChart, growthChart } from './charts.js';
import { eventSummary, eventIcon, clock, isRedFlag, segBtn } from './common.js';

const FILTERS = [['all', 'הכול'], ['feed', 'האכלות'], ['sleep', 'שינה'], ['diaper', 'חיתולים'], ['medication', 'תרופות'], ['pumping', 'שאיבה']];
const match = (f, e) => f === 'all' || (f === 'feed' ? ['nursing', 'bottle'].includes(e.event_type) : f === 'medication' ? ['medication', 'temperature'].includes(e.event_type) : e.event_type === f);

export function renderJournal(s, now = Date.now()) {
  const f = s.ui.journalFilter;
  const list = s.events.filter((e) => !e.is_deleted && match(f, e)).slice(0, 400);
  const byDay = new Map();
  for (const e of list) { const k = dayKey(e.started_at); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const series = dailySeries(s.events, 7, now);
  const ind = s.ui.growthInd;
  const growth = [...s.growth].sort((a, b) => toMs(b.measured_at) - toMs(a.measured_at));
  const crossings = crossingAlerts(s.growth, s.baby);

  return `<div class="page">
    <h2 class="page-title">${I.ruler} גדילה (WHO)</h2>
    ${crossings.map((c) => `<div class="alert alert-red">${I.alert}<span>${c.label}: חציית 2 קווי אחוזון (${Math.round(c.from)} → ${Math.round(c.to)}) — מומלץ להציג לרופא/ה</span></div>`).join('')}
    <div class="segs">${Object.entries(INDICATORS).map(([k, d]) => segBtn('ui-set', 'growthInd', k, ind, d.label)).join('')}</div>
    ${growthChart(ind, s.baby, s.growth, now)}
    <table class="tbl"><thead><tr><th>תאריך</th><th>משקל</th><th>אורך</th><th>ראש</th></tr></thead><tbody>
      ${growth.map((m) => { const a = assess(m, s.baby); return `<tr><td>${fmtDate(m.measured_at)}<small>${esc(m.notes || '')}</small></td>
        <td class="mono">${m.weight_grams ? m.weight_grams.toLocaleString('he-IL') + 'g' : '—'}<small>${a.wfa ? 'P' + Math.round(a.wfa.p) : ''}</small></td>
        <td class="mono">${m.length_cm ?? '—'}<small>${a.lhfa ? 'P' + Math.round(a.lhfa.p) : ''}</small></td>
        <td class="mono">${m.head_circumference_cm ?? '—'}<small>${a.hcfa ? 'P' + Math.round(a.hcfa.p) : ''}</small></td></tr>`; }).join('')}
    </tbody></table>
    <button class="btn full" data-act="sheet" data-name="growth">${I.plus} מדידה חדשה</button>

    <h2 class="page-title">${I.chart} 7 ימים אחרונים</h2>
    <div class="charts">
      ${barChart(series, { key: 'feeds', label: 'האכלות ביום' })}
      ${barChart(series, { key: 'sleepH', label: 'שעות שינה', decimals: 1 })}
      ${barChart(series, { key: 'wet', label: 'חיתולים רטובים' })}
      ${barChart(series, { key: 'bottleMl', label: 'בקבוק', unit: 'מ"ל' })}
    </div>

    <h2 class="page-title">${I.list} יומן אירועים</h2>
    <div class="chips scroll">${FILTERS.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-act="ui-set" data-k="journalFilter" data-v="${k}">${l}</button>`).join('')}</div>
    ${[...byDay.entries()].map(([k, evs]) => `<h3 class="grp">${dayLabel(evs[0].started_at, now)} <span class="muted">${evs.length} רישומים</span></h3>
      <ul class="log">${evs.map((e) => `<li><button class="log-row ${isRedFlag(e) ? 'flag' : ''}" data-act="sheet" data-name="event" data-id="${e.client_mutation_id}">
        <span class="mono log-time">${clock(e.started_at)}</span><span class="tl-ic">${eventIcon(e)}</span>
        <span class="log-sum">${esc(eventSummary(e))}</span><span class="tl-who who-${e.logged_by_name === 'הדס' ? 'b' : 'a'}">${esc(e.logged_by_name || '')}</span></button></li>`).join('')}</ul>`).join('') || '<p class="hint">אין רישומים בסינון הזה.</p>'}
  </div>`;
}
