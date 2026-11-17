// "מלאי חלב ושינה" — FIFO milk stash + SweetSpot schedule.
import { esc, toMs, fmtDate, durHe, ageInfo } from '../util.js';
import { LOCATIONS, expiryState, fifoOrder, totals, canMove } from '../logic/stash.js';
import { dayPlan, ageBand } from '../logic/sweetspot.js';
import { summary } from '../logic/clinical.js';
import { I } from './icons.js';
import { clock, tickCd } from './common.js';

function bagCard(b, idx, now, fifoIds) {
  const st = expiryState(b, now);
  const loc = LOCATIONS[b.storage_location];
  const left = toMs(b.expires_at) - now;
  const fifoPos = fifoIds.indexOf(b.id);
  const actions = [];
  if (st !== 'expired') {
    if (canMove(b, 'thawed_fridge')) actions.push(`<button class="btn sm" data-act="bag-move" data-id="${b.id}" data-to="thawed_fridge">הפשרה במקרר</button>`);
    if (canMove(b, 'fridge')) actions.push(`<button class="btn sm" data-act="bag-move" data-id="${b.id}" data-to="fridge">למקרר</button>`);
    if (canMove(b, 'freezer')) actions.push(`<button class="btn sm" data-act="bag-move" data-id="${b.id}" data-to="freezer">${I.snow} להקפאה</button>`);
  }
  actions.push(`<button class="btn sm ${st === 'expired' ? 'btn-red' : 'btn-ghost'}" data-act="bag-discard" data-id="${b.id}">השלכה</button>`);
  return `<li class="bag bag-${st}">
    <div class="bag-main">
      <span class="bag-vol mono">${b.remaining_volume_ml}<small>/${b.initial_volume_ml} מ"ל</small></span>
      <span class="bag-loc">${loc.label}${b.thawed_at ? ' · אין להקפיא שוב' : ''}</span>
      ${fifoPos === 0 ? '<span class="pill">הבא בתור (FIFO)</span>' : fifoPos > 0 ? `<span class="pill dim">#${fifoPos + 1}</span>` : ''}
    </div>
    <div class="bag-meta">נשאב ${fmtDate(b.pumped_at)} ${clock(b.pumped_at)} · ${st === 'expired' ? '<b class="red">פג תוקף — יש להשליך</b>'
      : left < 48 * 3600e3 ? `תוקף בעוד <span ${tickCd(toMs(b.expires_at), 'dur')}></span>` : `בתוקף עד ${fmtDate(b.expires_at)}`}</div>
    <div class="bag-actions">${actions.join('')}</div>
  </li>`;
}

export function renderStash(s, now = Date.now()) {
  const t = totals(s.stash, now);
  const avail = s.stash.filter((b) => b.status === 'AVAILABLE');
  const fifoIds = fifoOrder(s.stash, now).map((b) => b.id);
  const order = ['room_temp', 'thawed_fridge', 'fridge', 'freezer'];
  const groups = order.map((loc) => {
    const bags = avail.filter((b) => b.storage_location === loc).sort((a, b) => toMs(a.expires_at) - toMs(b.expires_at));
    if (!bags.length) return '';
    return `<h3 class="grp">${LOCATIONS[loc].long} <span class="muted mono">${bags.reduce((a, b) => a + b.remaining_volume_ml, 0)} מ"ל</span></h3>
      <ul class="bags">${bags.map((b, i) => bagCard(b, i, now, fifoIds)).join('')}</ul>`;
  }).join('');

  const { p, items } = dayPlan({ events: s.events, baby: s.baby, sleepTimer: s.timers.sleep, now });
  const age = ageInfo(s.baby, now);
  const band = ageBand(age.weeks);
  const sum1 = summary(s.events, 1, now);
  const plan = p && !p.asleep ? `
    <ol class="plan">${items.map((it, i) => `<li class="${i === 0 ? 'next' : ''}"><span class="mono" dir="ltr">${clock(it.start)}${it.end ? `–${clock(it.end)}` : ''}</span><span>${it.kind === 'bedtime' ? 'שינת לילה (חלון ארוך ב-20%)' : `תנומה ${i + 1 + p.napsToday}`}</span></li>`).join('')}</ol>
    <dl class="model">
      <div><dt>חלון ערות לגיל (W_age)</dt><dd class="mono">${band.min}–${band.max} דק' · ${band.label}</dd></div>
      <div><dt>ממוצע אישי 10 ימים</dt><dd class="mono">${p.W_personal ? Math.round(p.W_personal) + " דק'" : '—'}</dd></div>
      <div><dt>משקל למידה (α)</dt><dd class="mono">${p.alpha.toFixed(2)}</dd></div>
      <div><dt>מקדם יומי</dt><dd class="mono">${p.factor === 0.85 ? '×0.85 (בוקר)' : p.factor === 1.2 ? '×1.2 (לפני לילה)' : '×1'}</dd></div>
      <div><dt>קנס תנומה קצרה</dt><dd class="mono">${p.penalty ? `−${p.penalty} דק' (תנומה ${Math.round(p.D_prev)} דק')` : '—'}</dd></div>
      <div><dt>W_eff</dt><dd class="mono"><b>${Math.round(p.W_eff)} דק'</b></dd></div>
    </dl>
    <p class="hint">התראות: ${clock(p.alerts.prepare)} "זמן להחשיך חדר ולהתחיל טקס שינה" · ${clock(p.alerts.open)} "חלון השינה האופטימלי נפתח כעת"${p.alt ? ` · מעבר תנומות: חלופה ${clock(p.alt.target)}` : ''}</p>`
    : p?.asleep ? `<p class="hint">${esc(s.baby.name)} ישן כעת. התחזית תתעדכן ביקיצה.</p>` : '<p class="hint">אין מספיק נתוני שינה.</p>';

  return `<div class="page">
    <h2 class="page-title">${I.milk} מלאי חלב אם</h2>
    <div class="kpis">
      <div class="kpi"><b class="mono">${t.usable}</b><span>מ"ל זמין לשימוש</span></div>
      <div class="kpi"><b class="mono">${t.freezer}</b><span>מ"ל במקפיא</span></div>
      <div class="kpi"><b class="mono">${Math.round(sum1.bottleMl)}</b><span>מ"ל בבקבוק היום (24ש׳)</span></div>
    </div>
    <button class="btn full" data-act="sheet" data-name="addbag">${I.plus} הוספת שקית ידנית</button>
    ${groups || '<p class="hint">המלאי ריק. שאיבה תוסיף שקית אוטומטית.</p>'}
    <p class="hint">כללי אחסון (CDC / משרד הבריאות): חדר עד 4 שעות · מקרר עד 4 ימים · מקפיא עד 6 חודשים · הופשר במקרר — 24 שעות, אין להקפיא שוב.</p>
    <h2 class="page-title">${I.sleep} לוח SweetSpot להיום</h2>
    ${plan}
    <div class="kpis">
      <div class="kpi"><b class="mono">${sum1.sleepH.toFixed(1)}</b><span>שעות שינה ב-24ש׳</span></div>
      <div class="kpi"><b class="mono">${sum1.sleepDayH.toFixed(1)}</b><span>שינת יום</span></div>
      <div class="kpi"><b class="mono">${sum1.sleepNightH.toFixed(1)}</b><span>שינת לילה</span></div>
    </div>
  </div>`;
}
