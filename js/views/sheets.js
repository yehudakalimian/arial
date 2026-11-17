// Bottom sheets (thumb zone). Zero typing: steppers, segmented buttons, swatches.
import { esc, ageInfo, toMs, fmtHMS, fmtClock, fmtDate } from '../util.js';
import { elapsed, SIDE_HE } from '../logic/timers.js';
import { allocate, LOCATIONS } from '../logic/stash.js';
import { MEDS, lockState, doseFor } from '../logic/meds.js';
import { STOOL_COLORS } from '../logic/clinical.js';
import { I } from './icons.js';
import { tickEl, tickCd, segBtn, eventSummary, clock } from './common.js';
import { personalNursingAvgMin, personalNapAvgMin } from './track.js';
import { QUICK_LOG_URL } from '../config.js';
import { cloudConfig } from '../sync.js';

const head = (title, icon = '') => `<header class="sheet-head"><h2>${icon}${title}</h2><button class="icon-btn" data-act="close" aria-label="סגירה">${I.close}</button></header>`;
const stepper = (k, v, unit, deltas = [-10, 10], fmt = (x) => x) => `
  <div class="stepper">
    ${deltas.filter((d) => d < 0).map((d) => `<button class="step" dir="ltr" data-act="step" data-k="${k}" data-d="${d}" aria-label="הפחתה ${-d}">−${-d}</button>`).join('')}
    <output class="step-val mono">${fmt(v)}<small> ${unit}</small></output>
    ${deltas.filter((d) => d > 0).map((d) => `<button class="step" dir="ltr" data-act="step" data-k="${k}" data-d="${d}" aria-label="הוספה ${d}">+${d}</button>`).join('')}
  </div>`;

const latestWeight = (s) => [...s.growth].filter((g) => g.weight_grams).sort((a, b) => toMs(b.measured_at) - toMs(a.measured_at))[0];
const offsetHint = (s) => (s.ui.offsetMin ? `<p class="hint">⏱ יירשם לפני ${s.ui.offsetMin} דק' (לפי השבב שנבחר)</p>` : '');

function nursingSheet(s, now) {
  const t = s.timers.nursing;
  const rec = s.baby.recommended_next_side || 'right';
  if (!t) return `${head('הנקה', I.nursing)}
    <p class="hint">הנקה הבאה מומלצת: <b>צד ${SIDE_HE[rec]}</b></p>
    <div class="big-split">
      <button class="big ${rec === 'right' ? 'rec' : ''}" data-act="nurse" data-side="right" data-close="1"><b>ימין</b><small>התחלה</small></button>
      <button class="big ${rec === 'left' ? 'rec' : ''}" data-act="nurse" data-side="left" data-close="1"><b>שמאל</b><small>התחלה</small></button>
    </div>${offsetHint(s)}`;
  const e = elapsed(t, now), run = t.status === 'RUNNING';
  const side = (sd) => `<button class="big ${t.active_side === sd ? 'on' : ''}" data-act="nurse" data-side="${sd}">
      <b>${SIDE_HE[sd]}</b><span class="mono" ${tickEl({ since: toMs(t.started_at), acc: t[`accumulated_${sd}_sec`], run: run && t.active_side === sd })}>${fmtHMS(sd === 'left' ? e.left : e.right)}</span>
      <small>${t.active_side === sd ? (run ? 'הקישו להשהיה' : 'הקישו להמשך') : 'החלפת צד'}</small></button>`;
  return `${head('הנקה פעילה', I.nursing)}
    <div class="sheet-total mono" ${tickEl({ since: toMs(t.started_at), acc: t.accumulated_total_sec, run })}>${fmtHMS(e.total)}</div>
    <p class="hint center">התחלה ${clock(t.session_started_at)} · ע״י ${esc(t.updated_by || '')}</p>
    <div class="big-split">${side('right')}${side('left')}</div>
    <div class="row">
      <button class="btn grow" data-act="pause" data-type="nursing">${run ? I.pause + ' השהיה' : I.play + ' המשך'}</button>
      <button class="btn btn-primary grow2" data-act="finish" data-type="nursing" data-close="1">${I.stop} סיום ושמירה</button>
    </div>
    ${offsetHint(s)}
    <button class="btn btn-ghost full" data-act="discard" data-type="nursing" data-close="1">מחיקת טיימר בלי לשמור</button>`;
}

function bottleSheet(s, now) {
  const st = s.ui.sheet;
  let fifo = '';
  if (st.source === 'pumped') {
    const plan = allocate(s.stash, st.volume, now);
    fifo = `<div class="fifo"><div class="muted">ניכוי FIFO אוטומטי מהשקית הוותיקה ביותר:</div>
      ${plan.allocations.map((a) => `<div class="fifo-row"><span>${LOCATIONS[a.bag.storage_location].label} · נשאב ${fmtDate(a.bag.pumped_at)} ${clock(a.bag.pumped_at)}</span><b class="mono">−${a.take} מ"ל</b></div>`).join('') || '<div class="fifo-row">אין חלב זמין במקרר/חדר</div>'}
      ${plan.shortfall ? `<div class="fifo-row warn">חסרים ${plan.shortfall} מ"ל זמינים — יש להפשיר שקית מהמקפיא</div>` : ''}</div>`;
  }
  return `${head('בקבוק', I.bottle)}
    <div class="segs">${segBtn('sheet-set', 'source', 'pumped', st.source, 'חלב שאוב (FIFO)')}${segBtn('sheet-set', 'source', 'formula', st.source, 'תמ״ל')}</div>
    ${stepper('volume', st.volume, 'מ"ל', [-30, -10, 10, 30])}
    ${fifo}${offsetHint(s)}
    <button class="btn btn-primary full xl" data-act="log-bottle" data-close="1">רישום ${st.volume} מ"ל</button>`;
}

function pumpSheet(s, now) {
  const st = s.ui.sheet, t = s.timers.pumping;
  return `${head('שאיבה', I.pump)}
    ${t ? `<div class="sheet-total mono" ${tickEl({ since: toMs(t.started_at), acc: t.accumulated_total_sec, run: t.status === 'RUNNING' })}>${fmtHMS(elapsed(t, now).total)}</div>`
    : `<button class="btn full" data-act="start-pump">${I.play} התחלת טיימר שאיבה</button>`}
    <div class="pump-grid">
      <div><div class="lbl">ימין</div>${stepper('right', st.right, 'מ"ל')}</div>
      <div><div class="lbl">שמאל</div>${stepper('left', st.left, 'מ"ל')}</div>
    </div>
    <div class="lbl">אחסון השקית</div>
    <div class="segs">${['fridge', 'freezer', 'room_temp'].map((l) => segBtn('sheet-set', 'location', l, st.location, LOCATIONS[l].label)).join('')}</div>
    <p class="hint">${LOCATIONS[st.location].long} · ${st.location === 'room_temp' ? 'תקף 4 שעות' : st.location === 'fridge' ? 'תקף 4 ימים' : 'אופטימלי עד 6 חודשים'}</p>
    ${offsetHint(s)}
    <button class="btn btn-primary full xl" data-act="log-pump" data-close="1">שמירה · ${st.right + st.left} מ"ל למלאי</button>
    ${t ? '<button class="btn btn-ghost full" data-act="discard" data-type="pumping" data-close="1">ביטול טיימר</button>' : ''}`;
}

function medRow(s, code, now, ageDays) {
  const m = MEDS[code];
  const lock = lockState(code, s.events, { now, ageDays });
  const w = latestWeight(s);
  const dose = doseFor(code, w?.weight_grams, s.settings.conc[code]);
  let status;
  if (lock.locked && lock.reason === 'given_today') status = `ניתן היום ע״י ${esc(lock.by)} ב-${clock(lock.last.started_at)}`;
  else if (lock.locked && lock.reason === 'age') status = esc(lock.ageNote);
  else if (lock.locked) status = `מנה הבאה של ${m.label} מותרת ב-${fmtClock(lock.until)} · <span class="mono" ${tickCd(lock.until, 'hms')}></span>${lock.reason === 'max24' ? ' (הגעתם למקסימום ליממה)' : ''}`;
  else status = m.kind === 'daily' ? m.dose : dose ? `מנה: <b class="mono">${dose.ml} מ"ל</b> (${dose.mg} מ"ג · ${m.mgPerKg} מ"ג/ק"ג · ${(w.weight_grams / 1000).toFixed(2)} ק"ג)` : 'אין משקל — הוסיפו מדידה';
  const sub = m.kind === 'interval' ? `<span class="muted">כל ${m.intervalH} שעות · עד ${m.max24} מנות ביממה · ${lock.count24}/${m.max24} ב-24ש׳</span>` : '';
  return `<button class="med ${lock.locked ? 'locked' : ''} ${lock.reason === 'age' ? 'blocked' : ''}" data-act="med" data-code="${code}" ${lock.locked ? 'aria-disabled="true"' : ''}>
    <span class="med-name">${lock.locked ? '🔒 ' : ''}${m.label}${m.generic ? ` <small>(${m.generic})</small>` : ''}</span>
    <span class="med-status">${status}</span>${sub}
    ${lock.warning && lock.reason !== 'cross' ? `<span class="med-warn">${esc(lock.warning)}</span>` : ''}
    ${lock.reason === 'cross' ? `<span class="med-warn">${esc(lock.warning)}</span>` : ''}
    ${lock.ageNote && lock.reason !== 'age' ? `<span class="med-warn">${esc(lock.ageNote)}</span>` : ''}
  </button>`;
}

function medsSheet(s, now) {
  const ageDays = ageInfo(s.baby, now).days;
  return `${head('תרופות וויטמינים', I.meds)}
    <div class="meds">${Object.keys(MEDS).map((c) => medRow(s, c, now, ageDays)).join('')}</div>
    <div class="lbl">${I.temp} חום גוף</div>
    ${stepper('temp', s.ui.sheet.temp, '°C', [-0.5, -0.1, 0.1, 0.5], (v) => v.toFixed(1))}
    <button class="btn full" data-act="log-temp" data-close="1">רישום חום ${s.ui.sheet.temp.toFixed(1)}°C</button>
    <p class="hint">הנעילות משותפות לשני ההורים בזמן אמת ומונעות מנה כפולה. מינון לפי משקל אחרון — אמתו מול העלון והריכוז שבהגדרות.</p>`;
}

function stoolSheet(s) {
  const st = s.ui.sheet;
  return `${head('צבע הצואה', I.diaper)}
    <p class="hint">החיתול כבר נרשם (${STOOL_COLORS[st.color].label}). הקישו על צבע לעדכון:</p>
    <div class="swatches">${Object.entries(STOOL_COLORS).map(([k, c]) => `
      <button class="sw ${st.color === k ? 'on' : ''}" data-act="stool" data-color="${k}" aria-pressed="${st.color === k}">
        <i style="background:${c.hex}"></i><b>${c.label}</b><small class="${c.note === 'דגל אדום' ? 'red' : ''}">${c.note}</small></button>`).join('')}</div>
    <button class="btn full" data-act="close">סיום</button>`;
}

function flagSheet(s) {
  const f = s.ui.sheet;
  return `<div class="flag-card" role="alertdialog" aria-labelledby="flag-title">
    <div class="flag-ic">${I.alert}</div>
    <h2 id="flag-title">${esc(f.title)}</h2>
    <p>${esc(f.body)}</p>
    <div class="row">
      <a class="btn btn-red grow" href="tel:*5400">מוקד משרד הבריאות *5400</a>
      <a class="btn grow" href="tel:101">מד״א 101</a>
    </div>
    <button class="btn btn-ghost full" data-act="close">הבנתי</button>
  </div>`;
}

function zombieSheet(s, now) {
  const type = s.ui.sheet.type, t = s.timers[type];
  if (!t) return `${head('הטיימר כבר נסגר')}<button class="btn full" data-act="close">סגירה</button>`;
  const avg = type === 'nursing' ? personalNursingAvgMin(s.events) : type === 'sleep' ? personalNapAvgMin(s.events) : 20;
  const opts = type === 'sleep' ? [30, 45, 60, 90, 120, avg] : [10, 15, 20, 25, 30, avg];
  const uniq = [...new Set(opts)].sort((a, b) => a - b);
  const start = toMs(t.session_started_at);
  return `${head('מתי הסתיים?', I.alert)}
    <p class="hint">התחלה ב-${clock(start)}. בחרו משך — זמן הסיום יחושב אוטומטית:</p>
    <div class="opt-grid">${uniq.map((m) => `<button class="btn ${m === avg ? 'btn-warn' : ''}" data-act="zombie-avg" data-type="${type}" data-min="${m}" data-close="1">
      <b class="mono">${m} דק'</b><small>סיום ${clock(start + m * 60000)}${m === avg ? ' · ממוצע' : ''}</small></button>`).join('')}</div>
    <button class="btn btn-ghost full" data-act="close">עדיין פעיל — להמשיך</button>`;
}

function growthSheet(s) {
  const st = s.ui.sheet;
  return `${head('מדידת גדילה', I.ruler)}
    <div class="lbl">משקל</div>${stepper('w', st.w, 'גרם', [-100, -10, 10, 100], (v) => v.toLocaleString('he-IL'))}
    <div class="lbl">אורך</div>${stepper('l', st.l, 'ס"מ', [-1, -0.5, 0.5, 1], (v) => v.toFixed(1))}
    <div class="lbl">היקף ראש</div>${stepper('h', st.h, 'ס"מ', [-0.5, -0.1, 0.1, 0.5], (v) => v.toFixed(1))}
    <button class="btn btn-primary full xl" data-act="log-growth" data-close="1">שמירת מדידה (היום)</button>`;
}

function addBagSheet(s) {
  const st = s.ui.sheet;
  return `${head('הוספת שקית למלאי', I.milk)}
    ${stepper('volume', st.volume, 'מ"ל', [-30, -10, 10, 30])}
    <div class="segs">${['fridge', 'freezer', 'room_temp'].map((l) => segBtn('sheet-set', 'location', l, st.location, LOCATIONS[l].label)).join('')}</div>
    ${offsetHint(s)}
    <button class="btn btn-primary full xl" data-act="add-bag" data-close="1">הוספה</button>`;
}

function eventSheet(s) {
  const ev = s.events.find((e) => e.client_mutation_id === s.ui.sheet.id);
  if (!ev) return `${head('האירוע לא נמצא')}`;
  return `${head(esc(eventSummary(ev)))}
    <p class="hint">${fmtDate(ev.started_at, { weekday: 'long', day: 'numeric', month: 'long' })} · <span dir="ltr">${clock(ev.started_at)}${ev.ended_at ? `–${clock(ev.ended_at)}` : ''}</span> · ע״י ${esc(ev.logged_by_name || '')}</p>
    <div class="lbl">הזזת זמן (בלי הקלדה)</div>
    <div class="row wrap">${[-30, -10, -5, 5, 10, 30].map((d) => `<button class="btn" data-act="shift" data-d="${d}"><span dir="ltr">${d > 0 ? '+' : '−'}${Math.abs(d)}</span> דק'</button>`).join('')}</div>
    ${ev.event_type === 'bottle' ? `<div class="lbl">כמות</div><div class="row">${[-10, 10].map((d) => `<button class="btn grow" data-act="ev-vol" data-d="${d}"><span dir="ltr">${d > 0 ? '+' : '−'}${Math.abs(d)}</span> מ"ל</button>`).join('')}</div>` : ''}
    <button class="btn btn-red full" data-act="delete-ev" data-close="1">${I.trash} מחיקה (ניתן לבטל)</button>`;
}

function settingsSheet(s) {
  const cfg = cloudConfig();
  const sy = s.sync;
  const role = { parent_admin: 'הורה (מנהל)', caregiver_log_only: 'מטפל/ת (רישום בלבד)', viewer_pediatrician: 'צפייה (רופא/ה)' };
  let account = '';
  if (!cfg) {
    account = `<p class="hint">האפליקציה פועלת במצב הדגמה מקומי: הכול נשמר במכשיר (IndexedDB) ומסתנכרן בין חלונות פתוחים. לסנכרון בין שני טלפונים — חברו פרויקט Supabase:</p>
      <label class="field">Supabase URL<input dir="ltr" inputmode="url" id="cfg-url" placeholder="https://xxxx.supabase.co" value="${esc(s.settings.supabaseUrl)}"></label>
      <label class="field">Anon key<input dir="ltr" id="cfg-key" placeholder="eyJhbGciOi..." value="${esc(s.settings.supabaseKey)}"></label>
      <button class="btn full" data-act="save-cloud">שמירה והתחברות</button>`;
  } else if (sy.status === 'signed_out' || !sy.user) {
    account = `<p class="hint">התחברות עם קוד חד-פעמי במייל (ללא סיסמה):</p>
      <label class="field">אימייל<input dir="ltr" type="email" id="auth-email" autocomplete="email" value="${esc(s.ui.authEmail || '')}"></label>
      <button class="btn full" data-act="auth-send">שליחת קוד</button>
      <label class="field">קוד מהמייל<input dir="ltr" inputmode="numeric" id="auth-code" autocomplete="one-time-code"></label>
      <button class="btn btn-primary full" data-act="auth-verify">כניסה</button>
      <button class="btn btn-ghost full" data-act="cloud-reset">ניתוק מהענן (חזרה למצב הדגמה)</button>`;
  } else if (sy.status === 'no_household') {
    account = `<p class="hint">מחובר/ת כ-${esc(sy.user.email)}. בחרו:</p>
      <label class="field">השם שלי<select id="hh-name">${['יהודה', 'הדס'].map((n) => `<option ${s.settings.meName === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <button class="btn btn-primary full" data-act="hh-create">יצירת משק בית חדש (נתוני ההדגמה יימחקו, המדידות יישמרו)</button>
      <div class="or">או</div>
      <label class="field">קוד הזמנה מבן/בת הזוג<input dir="ltr" id="hh-code" maxlength="6" autocapitalize="characters" placeholder="ABC123"></label>
      <button class="btn full" data-act="hh-join">הצטרפות (מחליף את נתוני ההדגמה במכשיר)</button>`;
  } else {
    const admin = sy.role === 'parent_admin';
    account = `<p class="hint">מחובר/ת כ-${esc(sy.user.email)} · ${role[sy.role]}</p>
      <div class="invite"><span>קוד הזמנה למשק הבית</span><b class="mono">${esc(s.household?.invite_code || '')}</b>
      <button class="btn" data-act="share-invite">${I.share} שיתוף</button></div>
      <div class="members">${s.members.map((m) => `<div class="member"><span>${esc(m.display_name)}</span>
        ${admin && m.user_id !== s.me.user_id ? `<select data-act-change="role" data-user="${m.user_id}">${Object.entries(role).map(([k, v]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<small>${role[m.role]}</small>`}</div>`).join('')}</div>
      <p class="hint">ממתינים לסנכרון: ${sy.pending}${sy.lastError ? ` · שגיאה אחרונה: ${esc(sy.lastError)}` : ''}</p>
      <button class="btn btn-ghost full" data-act="sign-out">התנתקות</button>`;
  }
  return `${head('הגדרות', I.gear)}
    <div class="lbl">מי משתמש/ת במכשיר הזה?</div>
    <div class="segs">${['יהודה', 'הדס'].map((n) => segBtn('set-me', 'meName', n, s.settings.meName, n, sy.mode === 'cloud' && sy.user ? 'disabled' : '')).join('')}</div>
    <div class="lbl">תצוגה</div>
    <div class="segs">${segBtn('set-theme', 'theme', 'night', s.settings.theme, 'לילה OLED')}${segBtn('set-theme', 'theme', 'day', s.settings.theme, 'יום')}</div>
    <div class="segs">${segBtn('set-hand', 'hand', 'right', s.settings.hand, 'יד ימין')}${segBtn('set-hand', 'hand', 'left', s.settings.hand, 'יד שמאל')}</div>
    <div class="lbl">התראות SweetSpot (20 ו-5 דק' לפני החלון)</div>
    <button class="btn full" data-act="notif">${s.settings.notifications ? '🔔 פעילות' : 'הפעלת התראות'}</button>
    <div class="lbl">ריכוז תרופות (בדקו על הבקבוק)</div>
    <div class="segs">${[[24, '120 מ"ג/5 מ"ל'], [32, '160 מ"ג/5 מ"ל'], [50, '250 מ"ג/5 מ"ל']].map(([v, l]) => segBtn('set-conc', 'paracetamol_novimol', v, s.settings.conc.paracetamol_novimol, 'נובימול ' + l)).join('')}</div>
    <div class="segs">${[[20, '100 מ"ג/5 מ"ל'], [40, '200 מ"ג/5 מ"ל']].map(([v, l]) => segBtn('set-conc', 'ibuprofen_nurofen', v, s.settings.conc.ibuprofen_nurofen, 'נורופן ' + l)).join('')}</div>
    <div class="lbl">חיבור לענן ושיתוף</div>
    ${account}
    <button class="btn full" data-act="sheet" data-name="shortcuts">${I.phone} חיבור ל-iOS Shortcuts ו-Action Button</button>
    <div class="lbl">נתונים</div>
    <div class="row"><button class="btn grow" data-act="export">ייצוא JSON</button><button class="btn btn-ghost grow" data-act="reset-demo">איפוס נתוני הדגמה</button></div>
    <p class="hint">גרסה 1.0 · Offline-First · הנתונים שלכם נשמרים אצלכם.</p>`;
}

function shortcutsSheet(s) {
  const cfg = cloudConfig();
  const url = QUICK_LOG_URL || (cfg ? `${cfg.url.replace(/\/$/, '')}/functions/v1/quick-log` : 'https://<project>.supabase.co/functions/v1/quick-log');
  const code = s.household?.invite_code || 'ABC123';
  const step = s.ui.sheet.step || 0;
  const actions = [
    ['nursing', 'הנקה (התחלה/החלפה/סיום)', '{"side":"right"}'], ['sleep', 'שינה התחלה/סיום', ''], ['wet_diaper', 'חיתול רטוב', ''],
    ['dirty_diaper', 'חיתול מלוכלך', ''], ['bottle', 'בקבוק', '{"volume_ml":90}'], ['vitamin_d', 'ויטמין D', ''], ['status', 'מצב נוכחי (Siri מקריאה)', ''],
  ];
  const body = (a, extra) => JSON.stringify({ invite_code: code, action_type: a, parent_name: s.me.display_name, offset_minutes: 0, ...(extra ? JSON.parse(extra) : {}) }, null, 0);
  const steps = [
    `<h3>1 · מה מקבלים</h3><p>רישום בהקשה אחת ממסך הנעילה, מכפתור הפעולה (Action Button) באייפון 15 Pro ומעלה, או בקול: <i>"היי סירי, חיתול רטוב"</i> — בלי לפתוח את האפליקציה. הרישום נכנס לענן ומופיע מיד אצל ${s.me.display_name === 'הדס' ? 'יהודה' : 'הדס'}.</p>
     <p class="hint">${cfg ? 'החיבור לענן מוגדר ✓' : '⚠︎ נדרש חיבור Supabase (הגדרות ← חיבור לענן) ופריסת פונקציית quick-log.'}</p>`,
    `<h3>2 · יצירת קיצור ב-Shortcuts</h3><ol>
      <li>פתחו את אפליקציית <b>קיצורים</b> ← <b>+</b> ← <b>הוספת פעולה</b>.</li>
      <li>חפשו <b>"קבלת תוכן של URL"</b> (Get Contents of URL).</li>
      <li>הדביקו את הכתובת: <code dir="ltr" class="copy" data-act="copy" data-text="${esc(url)}">${esc(url)}</code></li>
      <li>הרחיבו: <b>שיטה</b> = POST · <b>כותרות</b>: Content-Type = application/json · <b>גוף הבקשה</b> = JSON.</li>
      <li>הוסיפו פעולה <b>"הצגת תוצאה"</b> או <b>"הקראת טקסט"</b> על השדה <code dir="ltr">message</code>.</li></ol>`,
    `<h3>3 · גוף הבקשה לכל פעולה</h3><p class="hint">הקישו להעתקה. צרו קיצור נפרד לכל פעולה ותנו לו שם עברי קצר (זה מה שאומרים לסירי).</p>
      ${actions.map(([a, he, extra]) => `<div class="sc-row"><b>${he}</b><code dir="ltr" class="copy" data-act="copy" data-text="${esc(body(a, extra))}">${esc(body(a, extra))}</code></div>`).join('')}
      <p class="hint"><code dir="ltr">offset_minutes</code> = רישום רטרואקטיבי ("לפני 10 דק'"). <code dir="ltr">side</code>: right/left. ללא side — הצד המומלץ.</p>`,
    `<h3>4 · Action Button ומסך הנעילה</h3><ol>
      <li><b>הגדרות ← כפתור פעולה</b> ← גללו ל-<b>קיצור</b> ← בחרו "הנקה" או "חיתול רטוב".</li>
      <li>מסך נעילה: לחיצה ארוכה ← <b>התאמה אישית</b> ← <b>מסך נעילה</b> ← הוספת וידג׳ט <b>קיצורים</b>.</li>
      <li>Siri: אמרו את שם הקיצור, למשל <i>"היי סירי, שינה"</i>.</li>
      <li>טיפ: ב-Back Tap (הגדרות ← נגישות ← מגע ← הקשה בגב) הקשה כפולה = חיתול רטוב.</li></ol>
      <p class="hint">אבטחה: קוד ההזמנה משמש כמפתח. אם הקוד דלף — צרו קוד חדש (מנהל) והגדירו shortcut_token ב-Supabase כמתואר ב-README.</p>
      <p class="hint">בלי ענן? אפשר גם קיצור "פתיחת URL": <code dir="ltr" class="copy" data-act="copy" data-text="${esc(location.origin + location.pathname)}?quick_action=wet_diaper">${esc(location.origin + location.pathname)}?quick_action=wet_diaper</code></p>`,
  ];
  return `${head('iOS Shortcuts ו-Action Button', I.phone)}
    <div class="stepper-nav">${steps.map((_, i) => `<button class="dotbtn ${i === step ? 'on' : ''}" data-act="sheet-set" data-k="step" data-v="${i}" aria-label="שלב ${i + 1}"></button>`).join('')}</div>
    <div class="guide">${steps[step]}</div>
    <div class="row">${step > 0 ? `<button class="btn grow" data-act="sheet-set" data-k="step" data-v="${step - 1}">הקודם</button>` : ''}
    ${step < steps.length - 1 ? `<button class="btn btn-primary grow" data-act="sheet-set" data-k="step" data-v="${step + 1}">הבא</button>` : '<button class="btn btn-primary grow" data-act="close">סיום</button>'}</div>`;
}

const SHEETS = { nursing: nursingSheet, bottle: bottleSheet, pump: pumpSheet, meds: medsSheet, stool: stoolSheet, flag: flagSheet, zombie: zombieSheet, growth: growthSheet, addbag: addBagSheet, event: eventSheet, settings: settingsSheet, shortcuts: shortcutsSheet };

export function renderSheet(s, now = Date.now()) {
  const sh = s.ui.sheet;
  if (!sh) return '';
  const fn = SHEETS[sh.name];
  return `<div class="sheet-backdrop" data-act="close"></div>
    <div class="sheet ${sh.name === 'flag' ? 'sheet-flag' : ''} ${['settings', 'shortcuts'].includes(sh.name) ? 'sheet-tall' : ''}" role="dialog" aria-modal="true">
      <div class="grabber"></div>${fn ? fn(s, now) : ''}</div>`;
}
