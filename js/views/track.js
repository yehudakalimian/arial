// Main "תיעוד מהיר" screen — strict 3-zone thumb layout, 100dvh, no vertical scroll.
import { esc, ageInfo, toMs, fmtHMS, relHe } from '../util.js';
import { elapsed, anomaly, SIDE_HE } from '../logic/timers.js';
import { predict, progress } from '../logic/sweetspot.js';
import { hydration, STOOL_COLORS } from '../logic/clinical.js';
import { lockState } from '../logic/meds.js';
import { totals } from '../logic/stash.js';
import { I } from './icons.js';
import { eventSummary, eventIcon, eventRefTime, tickEl, tickRel, tickCd, syncText, clock, isRedFlag } from './common.js';

export const OFFSETS = [0, 5, 10, 15, 30];

export function personalNursingAvgMin(events) {
  const n = events.filter((e) => e.event_type === 'nursing' && !e.is_deleted && e.duration_sec).slice(0, 10);
  return n.length ? Math.round(n.reduce((a, e) => a + e.duration_sec, 0) / n.length / 60) : 18;
}
export function personalNapAvgMin(events) {
  const n = events.filter((e) => e.event_type === 'sleep' && !e.is_deleted && e.duration_sec && e.duration_sec < 4 * 3600).slice(0, 10);
  return n.length ? Math.round(n.reduce((a, e) => a + e.duration_sec, 0) / n.length / 60) : 60;
}

function statusBanner(s, now) {
  const name = esc(s.baby.name);
  const { nursing: tN, sleep: tS, pumping: tP } = s.timers;
  const male = s.baby.sex !== 'female';
  if (tN) {
    const e = elapsed(tN, now), run = tN.status === 'RUNNING';
    return `<div class="banner banner-live">
      <div class="banner-label">הנקה · צד ${SIDE_HE[tN.active_side]} ${run ? '<i class="dot live"></i>' : '<span class="paused">מושהה</span>'}</div>
      <div class="banner-time mono" ${tickEl({ since: toMs(tN.started_at), acc: tN.accumulated_total_sec, run })}>${fmtHMS(e.total)}</div>
      <div class="banner-sub mono">ימין <span ${tickEl({ since: toMs(tN.started_at), acc: tN.accumulated_right_sec, run: run && tN.active_side === 'right' })}>${fmtHMS(e.right)}</span> · שמאל <span ${tickEl({ since: toMs(tN.started_at), acc: tN.accumulated_left_sec, run: run && tN.active_side === 'left' })}>${fmtHMS(e.left)}</span> · ע״י ${esc(tN.updated_by || '')}</div>
    </div>`;
  }
  if (tP) {
    const run = tP.status === 'RUNNING';
    return `<div class="banner banner-live">
      <div class="banner-label">שאיבה פעילה <i class="dot live"></i></div>
      <div class="banner-time mono" ${tickEl({ since: toMs(tP.started_at), acc: tP.accumulated_total_sec, run })}>${fmtHMS(elapsed(tP, now).total)}</div>
      ${tS ? `<div class="banner-sub">${name} ${male ? 'ישן' : 'ישנה'} מזה <span class="mono" ${tickEl({ since: toMs(tS.session_started_at), fmt: 'hm' })}></span></div>` : ''}
    </div>`;
  }
  if (tS) {
    return `<div class="banner banner-sleep">
      <div class="banner-label">${name} ${male ? 'ישן' : 'ישנה'} מזה <i class="dot live"></i></div>
      <div class="banner-time mono" ${tickEl({ since: toMs(tS.started_at), acc: tS.accumulated_total_sec, fmt: 'hm' })}>--:--</div>
      <div class="banner-sub">נרדם ב-${clock(tS.session_started_at)} · ע״י ${esc(tS.updated_by || '')}</div>
    </div>`;
  }
  const lastSleep = s.events.find((e) => e.event_type === 'sleep' && !e.is_deleted && e.ended_at);
  return `<div class="banner">
    <div class="banner-label">${name} ${male ? 'ער' : 'ערה'} מזה</div>
    <div class="banner-time mono" ${lastSleep ? tickEl({ since: toMs(lastSleep.ended_at), fmt: 'hm' }) : ''}>${lastSleep ? '--:--' : '—'}</div>
    <div class="banner-sub">${lastSleep ? `התעורר ב-${clock(lastSleep.ended_at)}` : 'אין עדיין נתוני שינה'}</div>
  </div>`;
}

function sweetSpot(s, now) {
  const p = predict({ events: s.events, baby: s.baby, sleepTimer: s.timers.sleep, now });
  if (!p) return `<div class="sweet"><div class="sweet-row"><span>SweetSpot ילמד אחרי השינה הראשונה</span></div><div class="bar"><i style="width:0"></i></div></div>`;
  if (p.asleep) {
    const t = s.timers.sleep, napAvg = Math.round(p.napAvg);
    const startMs = toMs(t.session_started_at);
    return `<div class="sweet"><div class="sweet-row"><span>בשינה · תנומה ממוצעת ${napAvg} דק'</span><span class="mono">יקיצה צפויה ~${clock(startMs + napAvg * 60000)}</span></div>
      <div class="bar"><i data-tick="prog" data-from="${startMs}" data-to="${startMs + napAvg * 60000}" style="width:${Math.min(100, (now - startMs) / (napAvg * 600))}%"></i></div></div>`;
  }
  const lbl = p.kind === 'bedtime' ? 'שינת לילה' : p.kind === 'night' ? 'חזרה לשינה' : 'חלון שינה הבא';
  const alt = p.alt ? `<span class="muted"> · חלופה (3 תנומות) ${clock(p.alt.target)}</span>` : '';
  return `<div class="sweet" title="W_eff ${Math.round(p.W_eff)} דק'">
    <div class="sweet-row"><span>${lbl}: <b class="mono" dir="ltr">${clock(p.windowStart)}–${clock(p.windowEnd)}</b>${alt}</span>
    <span class="mono sweet-cd" data-tick="sweet" data-ws="${p.windowStart}" data-we="${p.windowEnd}"></span></div>
    <div class="bar"><i data-tick="prog" data-from="${p.wakeAt}" data-to="${p.target}" style="width:${progress(p, now) * 100}%"></i></div>
  </div>`;
}

function nextSideBadge(s) {
  const tN = s.timers.nursing;
  if (tN) return `<div class="badge badge-side">צד פעיל: <b>${SIDE_HE[tN.active_side]}</b></div>`;
  const side = s.baby.recommended_next_side || 'right';
  const last = s.events.find((e) => e.event_type === 'nursing' && !e.is_deleted);
  const why = last?.metadata?.rule === 'dessert' ? ' <span class="muted">(השלמת צד קצר)</span>' : '';
  return `<div class="badge badge-side">הנקה הבאה: <b>צד ${SIDE_HE[side]}</b>${why}</div>`;
}

function contextAlert(s, now) {
  for (const type of ['nursing', 'sleep', 'pumping']) {
    const t = s.timers[type];
    const a = anomaly(t, now);
    if (!a) continue;
    const avg = type === 'nursing' ? personalNursingAvgMin(s.events) : type === 'sleep' ? personalNapAvgMin(s.events) : 20;
    return `<div class="alert alert-zombie" role="alert">
      <div class="alert-text">${I.alert}<span>נראה שהטיימר נשכח פועל — לעצור לפי ממוצע אישי (${avg} דק') או לבחור זמן סיום?</span></div>
      <div class="alert-actions">
        <button class="btn btn-warn" data-act="zombie-avg" data-type="${type}" data-min="${avg}">עצירה לפי ממוצע (${avg} דק')</button>
        <button class="btn" data-act="sheet" data-name="zombie" data-type="${type}">בחירת זמן סיום</button>
      </div></div>`;
  }
  const age = ageInfo(s.baby, now);
  const flag = s.events.find((e) => !e.is_deleted && isRedFlag(e) && toMs(e.started_at) > now - 24 * 3600e3);
  if (flag) return `<button class="alert alert-red" data-act="tab" data-tab="report">${I.alert}<span>דגל אדום: ${esc(eventSummary(flag))} ${relHe(flag.started_at, now)} — מומלץ בירור רפואי</span></button>`;
  const h = hydration(s.events, age.days, now);
  if (h.alert) return `<button class="alert alert-red" data-act="tab" data-tab="report">${I.alert}<span>רק ${h.wet24} חיתולים רטובים ב-24 שעות (מינימום ${h.threshold}) — בדקו הנקה/שתייה</span></button>`;
  return '';
}

function timeline(s, now) {
  const items = s.events.filter((e) => !e.is_deleted).sort((a, b) => eventRefTime(b) - eventRefTime(a)).slice(0, 3);
  if (!items.length) return '<ol class="timeline"><li class="empty">עוד אין רישומים</li></ol>';
  return `<ol class="timeline">${items.map((e) => `
    <li class="${isRedFlag(e) ? 'flag' : ''}">
      <span class="tl-ic">${eventIcon(e)}</span>
      <span class="tl-sum">${esc(eventSummary(e))}</span>
      <span class="tl-who who-${e.logged_by_name === 'הדס' ? 'b' : 'a'}">${esc(e.logged_by_name || '')}</span>
      <span class="tl-rel" ${tickRel(eventRefTime(e))}>${relHe(eventRefTime(e), now)}</span>
    </li>`).join('')}</ol>`;
}

function chips(s) {
  return `<div class="chips" role="radiogroup" aria-label="זמן לפעולה הבאה">${OFFSETS.map((m) => `
    <button class="chip ${s.ui.offsetMin === m ? 'on' : ''}" role="radio" aria-checked="${s.ui.offsetMin === m}" data-act="offset" data-min="${m}">${m === 0 ? 'עכשיו' : `לפני ${m} דק'`}</button>`).join('')}</div>`;
}

function grid(s, now) {
  const { nursing: tN, sleep: tS, pumping: tP } = s.timers;
  const rec = s.baby.recommended_next_side || 'right';
  const half = (side) => {
    const on = tN && tN.active_side === side;
    const run = on && tN.status === 'RUNNING';
    const acc = tN ? tN[`accumulated_${side}_sec`] : 0;
    const label = !tN ? (side === rec ? 'מומלץ' : 'התחלה') : on ? (run ? 'השהיה' : 'המשך') : 'החלפה';
    return `<button class="half ${on ? 'on' : ''} ${!tN && side === rec ? 'rec' : ''} ${on && !run ? 'paused' : ''}" data-act="nurse" data-side="${side}" aria-label="הנקה צד ${SIDE_HE[side]}">
      <b>${SIDE_HE[side]}</b>${tN ? `<span class="mono" ${tickEl({ since: toMs(tN.started_at), acc, run })}>${fmtHMS(acc)}</span>` : ''}<small>${label}</small></button>`;
  };
  const d3 = lockState('vitamin_d3', s.events, { now, ageDays: ageInfo(s.baby, now).days });
  const nov = lockState('paracetamol_novimol', s.events, { now, ageDays: ageInfo(s.baby, now).days });
  const stashT = totals(s.stash, now);
  const bottle = s.settings.lastBottle;
  const stoolHex = STOOL_COLORS[s.settings.lastStoolColor]?.hex;
  const viewer = s.sync.role === 'viewer_pediatrician';

  return `<div class="grid ${viewer ? 'disabled' : ''}" ${viewer ? 'aria-disabled="true"' : ''}>
    <button class="tile" data-act="sheet" data-name="pump">
      <span class="tile-head">${I.pump}שאיבה</span>
      ${tP ? `<span class="tile-big mono" ${tickEl({ since: toMs(tP.started_at), acc: tP.accumulated_total_sec, run: tP.status === 'RUNNING' })}></span>` : `<span class="tile-big mono">${stashT.usable}<small> מ"ל זמין</small></span>`}
      <span class="tile-sub">${tP ? 'טיימר פעיל · הקישו לסיום' : `מקפיא ${stashT.freezer} מ"ל`}</span>
    </button>
    <button class="tile ${d3.locked ? 'done' : 'attn'}" data-act="sheet" data-name="meds">
      <span class="tile-head">${I.meds}תרופות וויטמין D</span>
      <span class="tile-big">${d3.locked ? `D3 ✓ <small class="mono">${clock(d3.last.started_at)}</small>` : 'D3 טרם ניתן'}</span>
      <span class="tile-sub">${nov.locked && nov.reason !== 'age' ? `נובימול <span class="mono" ${tickCd(nov.until)}></span>` : d3.locked ? `ע״י ${esc(d3.by || '')}` : 'נובימול · נורופן · חום'}</span>
    </button>
    <button class="tile" data-act="sheet" data-name="bottle">
      <span class="tile-head">${I.bottle}בקבוק / תמ״ל</span>
      <span class="tile-big mono">${bottle.volume}<small> מ"ל</small></span>
      <span class="tile-sub">${bottle.source === 'pumped' ? 'חלב שאוב · FIFO' : 'תמ״ל'}</span>
    </button>
    <button class="tile ${tS ? 'live' : ''}" data-act="sleep">
      <span class="tile-head">${I.sleep}שינה / תנומה</span>
      ${tS ? `<span class="tile-big mono" ${tickEl({ since: toMs(tS.started_at), acc: tS.accumulated_total_sec, fmt: 'hm' })}></span><span class="tile-sub">הקישו לסיום (התעורר)</span>`
    : `<span class="tile-big">התחלה</span><span class="tile-sub">הקשה אחת${s.ui.offsetMin ? ` · לפני ${s.ui.offsetMin} דק'` : ''}</span>`}
    </button>
    <div class="tile tile-nurse ${tN ? 'live' : ''}">
      <button class="tile-head as-btn" data-act="sheet" data-name="nursing">${I.nursing}הנקה ${tN ? '<span class="more">שליטה ‹</span>' : ''}</button>
      <div class="split">${half('right')}${half('left')}</div>
    </div>
    <div class="tile tile-diaper">
      <span class="tile-head">${I.diaper}חיתול <i class="swatch" style="background:${stoolHex}" title="צבע ברירת מחדל"></i></span>
      <div class="split three">
        <button class="half" data-act="diaper" data-type="wet"><b>רטוב</b><small>פיפי</small></button>
        <button class="half" data-act="diaper" data-type="dirty"><b>מלוכלך</b><small>קקי</small></button>
        <button class="half" data-act="diaper" data-type="mixed"><b>משולב</b><small>שניהם</small></button>
      </div>
    </div>
  </div>`;
}

export function renderTrack(s, now = Date.now()) {
  const age = ageInfo(s.baby, now);
  const sync = syncText(s);
  return `<div class="track">
    <section class="zone zone-status" aria-label="מצב נוכחי" aria-live="polite">
      <div class="baby-row"><h1 class="baby-name">${esc(s.baby.name)} · ${age.label}</h1>
        <span class="sync sync-${sync.cls}"><i class="dot"></i>${sync.text}</span></div>
      ${statusBanner(s, now)}
      ${sweetSpot(s, now)}
      ${nextSideBadge(s)}
    </section>
    <section class="zone zone-context" aria-label="הקשר ותזמון">
      ${contextAlert(s, now) || timeline(s, now)}
      ${chips(s)}
    </section>
    <section class="zone zone-actions" aria-label="פעולות">${grid(s, now)}</section>
  </div>`;
}
