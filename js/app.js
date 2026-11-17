// App shell: boot, render, event delegation, rAF ticker, undo toasts, wake lock, SweetSpot alerts, URL quick actions.
import * as idb from './idb.js';
import { state, load, emit, subscribe, saveSettings } from './store.js';
import { seedIfEmpty, buildSeed, writeSeed } from './seed.js';
import { startSync, transport } from './sync.js';
import * as A from './actions.js';
import { fmtHMS, fmtHM, relHe, durHe, vibrate, clamp, round1, toMs, esc } from './util.js';
import { anomaly } from './logic/timers.js';
import { predict } from './logic/sweetspot.js';
import { renderTrack } from './views/track.js';
import { renderStash } from './views/stash.js';
import { renderJournal } from './views/journal.js';
import { renderReport, reportText } from './views/report.js';
import { renderSheet } from './views/sheets.js';
import { I } from './views/icons.js';
import { SUPABASE_URL } from './config.js';

const $ = (s) => document.querySelector(s);
const VIEWS = { track: renderTrack, stash: renderStash, journal: renderJournal, report: renderReport };
const TABS = [
  ['track', 'תיעוד מהיר', I.bolt], ['stash', 'מלאי חלב ושינה', I.milk],
  ['journal', 'יומן וגדילה', I.chart], ['report', 'דוח טיפת חלב / רופא', I.doc],
];
const MUTATING = new Set(['nurse', 'sleep', 'diaper', 'log-bottle', 'log-pump', 'start-pump', 'pause', 'finish', 'discard', 'zombie-avg', 'med', 'log-temp', 'stool', 'log-growth', 'add-bag', 'bag-move', 'bag-discard', 'shift', 'ev-vol', 'delete-ev', 'undo']);

// ------------------------------------------------------------------ render
const last = { top: '', view: '', nav: '', sheet: '', toastId: null };
function render() {
  if (!state.baby) return;
  const now = Date.now();
  const root = document.documentElement;
  root.dataset.theme = state.settings.theme;
  root.dataset.hand = state.settings.hand;
  document.querySelector('meta[name="theme-color"]').content = state.settings.theme === 'day' ? '#FFF8EE' : '#000000';

  const top = topbar();
  if (top !== last.top) { $('#topbar').innerHTML = top; last.top = top; }
  const view = VIEWS[state.ui.tab](state, now);
  if (view !== last.view) { $('#view').innerHTML = view; $('#view').dataset.tab = state.ui.tab; last.view = view; }
  const nav = navBar();
  if (nav !== last.nav) { $('#nav').innerHTML = nav; last.nav = nav; }
  renderSheetPreserving(now);
  renderToast();
  tick(Date.now());
  manageWakeLock();
}

function topbar() {
  const night = state.settings.theme !== 'day';
  return `<button class="tb-btn" data-act="toggle-theme" aria-label="החלפת מצב תצוגה">${night ? I.moon : I.sun}<span>${night ? 'מצב לילה OLED' : 'מצב יום'}</span></button>
    <button class="tb-btn" data-act="toggle-hand" aria-label="החלפת יד">${I.hand}<span>${state.settings.hand === 'left' ? 'יד שמאל' : 'יד ימין'}</span></button>
    <span class="tb-me">${esc(state.me.display_name)}</span>
    <button class="tb-btn icon" data-act="sheet" data-name="settings" aria-label="הגדרות">${I.gear}</button>`;
}
function navBar() {
  return TABS.map(([k, l, ic]) => `<button class="nav-btn ${state.ui.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}" aria-current="${state.ui.tab === k ? 'page' : 'false'}">${ic}<span>${l}</span></button>`).join('');
}

function renderSheetPreserving(now) {
  const root = $('#sheet-root');
  const html = renderSheet(state, now);
  if (html === last.sheet) return;
  const saved = {};
  root.querySelectorAll('input[id], select[id]').forEach((i) => { saved[i.id] = i.value; });
  const focused = document.activeElement?.id;
  root.innerHTML = html;
  last.sheet = html;
  for (const [id, v] of Object.entries(saved)) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focused) document.getElementById(focused)?.focus();
  document.body.classList.toggle('sheet-open', !!state.ui.sheet);
}

// ------------------------------------------------------------------ toast (8-second undo)
let toastTimer = null;
function showToast(message, undo = null, { ms = 8000, kind = '' } = {}) {
  clearTimeout(toastTimer);
  const id = Math.random().toString(36).slice(2);
  state.ui.toast = { id, message, undo, ms, kind };
  toastTimer = setTimeout(() => { if (state.ui.toast?.id === id) { state.ui.toast = null; emit(); } }, ms);
  emit();
}
function renderToast() {
  const t = state.ui.toast;
  if ((t?.id ?? null) === last.toastId) return;
  last.toastId = t?.id ?? null;
  $('#toast-root').innerHTML = t ? `<div class="toast ${t.kind}" role="status" aria-live="assertive">
    <span class="toast-msg">${esc(t.message)}</span>
    ${t.undo ? '<button class="toast-undo" data-act="undo">ביטול</button>' : ''}
    <i class="toast-bar" style="animation-duration:${t.ms}ms"></i></div>` : '';
}
function run(res, { openFlag = true } = {}) {
  if (!res) return res;
  if (res.blocked) { vibrate([30, 60, 30]); showToast(res.message, null, { ms: 3500, kind: 'error' }); return res; }
  vibrate(40);
  showToast(res.message, res.undo || null);
  if (openFlag && res.flag) openSheet('flag', { title: res.flag.title, body: res.flag.body });
  return res;
}

// ------------------------------------------------------------------ sheets
function latestGrowth() { return [...state.growth].sort((a, b) => toMs(b.measured_at) - toMs(a.measured_at))[0]; }
function openSheet(name, extra = {}) {
  const st = state.settings;
  const init = {
    bottle: () => ({ volume: st.lastBottle.volume, source: st.lastBottle.source }),
    pump: () => ({ ...st.lastPump }),
    meds: () => ({ temp: st.lastTemp }),
    growth: () => { const g = latestGrowth(); return { w: g?.weight_grams ?? 3500, l: g?.length_cm ?? 50, h: g?.head_circumference_cm ?? 35 }; },
    addbag: () => ({ volume: 100, location: 'freezer' }),
  }[name];
  state.ui.sheet = { name, ...(init ? init() : {}), ...extra };
  emit();
}
const closeSheet = () => { state.ui.sheet = null; emit(); };

const LIMITS = { volume: [10, 400, 1], right: [0, 400, 1], left: [0, 400, 1], temp: [34, 42.5, 0.1], w: [1000, 25000, 1], l: [40, 120, 0.1], h: [28, 60, 0.1] };

// ------------------------------------------------------------------ actions
function takeAt() { const m = state.ui.offsetMin; state.ui.offsetMin = 0; return Date.now() - m * 60000; }
const findEv = (id) => state.events.find((e) => e.client_mutation_id === id);
async function guard(fn) { try { await fn(); } catch (e) { console.error(e); showToast(e.message || 'שגיאה', null, { ms: 5000, kind: 'error' }); } }

const H = {
  tab: (d) => { state.ui.tab = d.tab; state.ui.sheet = null; emit(); $('#view').scrollTop = 0; },
  offset: (d) => { state.ui.offsetMin = state.ui.offsetMin === +d.min ? 0 : +d.min; vibrate(15); emit(); },
  nurse: (d) => {
    const t = state.timers.nursing;
    if (!t) return run(A.startTimer('nursing', { side: d.side, at: takeAt() }));
    const r = A.nursingTap(d.side);
    if (r) { vibrate(40); showToast(r.message, r.undo); return; }
    const p = A.pauseResume('nursing'); vibrate(25); showToast(p.message, p.undo, { ms: 4000 });
  },
  sleep: () => run(state.timers.sleep ? A.finishTimer('sleep', takeAt()) : A.startTimer('sleep', { at: takeAt() })),
  diaper: (d) => {
    const res = run(A.logDiaper({ type: d.type, color: d.type === 'wet' ? null : state.settings.lastStoolColor, at: takeAt() }));
    if (d.type !== 'wet' && res && !res.flag) openSheet('stool', { evId: res.ev.client_mutation_id, color: state.settings.lastStoolColor });
  },
  sheet: (d) => openSheet(d.name, { type: d.type, id: d.id, step: 0 }),
  close: closeSheet,
  step: (d) => {
    const sh = state.ui.sheet, [lo, hi, q] = LIMITS[d.k];
    const v = clamp(sh[d.k] + Number(d.d), lo, hi);
    sh[d.k] = q < 1 ? round1(v) : Math.round(v);
    vibrate(10); emit();
  },
  'sheet-set': (d) => { state.ui.sheet[d.k] = /^-?\d+(\.\d+)?$/.test(d.v) ? Number(d.v) : d.v; emit(); },
  'ui-set': (d) => { state.ui[d.k] = d.v; emit(); },
  'log-bottle': () => { const { volume, source } = state.ui.sheet; run(A.logBottle({ volume, source, at: takeAt() })); saveSettings({ lastBottle: { volume, source } }); },
  'start-pump': () => run(A.startTimer('pumping', { at: takeAt() })),
  'log-pump': () => { const { right, left, location } = state.ui.sheet; run(A.logPump({ right, left, location, at: takeAt() })); saveSettings({ lastPump: { right, left, location } }); },
  pause: (d) => { const r = A.pauseResume(d.type); if (r) { vibrate(25); showToast(r.message, r.undo, { ms: 4000 }); } },
  finish: (d) => run(A.finishTimer(d.type, takeAt())),
  discard: (d) => run(A.discardTimer(d.type)),
  'zombie-avg': (d) => run(A.stopAtDuration(d.type, +d.min)),
  med: (d, el) => {
    if (el.getAttribute('aria-disabled') === 'true') { vibrate([30, 60, 30]); showToast('נעול — מניעת מנה כפולה. ראו שעה מותרת בכרטיס.', null, { ms: 3500, kind: 'error' }); return; }
    run(A.logMed(d.code, { at: takeAt() }));
    closeSheet();
  },
  'log-temp': () => {
    const temp = state.ui.sheet.temp; saveSettings({ lastTemp: temp });
    const r = A.logTemp(temp, { at: takeAt() });
    state.ui.sheet = null;
    run(r);
    if (!r.flag && r.feverFlag) showToast(`${r.message} · ${r.feverFlag.title}`, r.undo);
  },
  stool: (d) => {
    const ev = findEv(state.ui.sheet.evId);
    if (!ev) return closeSheet();
    const flag = A.setStoolColor(ev, d.color);
    saveSettings({ lastStoolColor: d.color === 'yellow' || d.color === 'green' || d.color === 'brown' ? d.color : state.settings.lastStoolColor });
    vibrate(20);
    if (flag) openSheet('flag', { title: flag.title, body: flag.body }); else { state.ui.sheet.color = d.color; emit(); }
  },
  'log-growth': () => { const { w, l, h } = state.ui.sheet; run(A.addGrowth({ weight_grams: w, length_cm: l, head_circumference_cm: h })); },
  'add-bag': () => { const { volume, location } = state.ui.sheet; run(A.addBag({ volume, location, at: takeAt() })); },
  'bag-move': (d) => guard(() => run(A.moveBag(state.stash.find((b) => b.id === d.id), d.to))),
  'bag-discard': (d) => run(A.discardBag(state.stash.find((b) => b.id === d.id))),
  shift: (d) => { const ev = findEv(state.ui.sheet.id); const before = { ...ev }; A.shiftEvent(ev, +d.d); vibrate(15); showToast(`הזמן הוזז ${d.d} דק'`, () => A.patchEvent(findEv(before.client_mutation_id), { started_at: before.started_at, ended_at: before.ended_at })); },
  'ev-vol': (d) => { const ev = findEv(state.ui.sheet.id); A.patchEvent(ev, { volume_ml: Math.max(0, (ev.volume_ml || 0) + +d.d) }); vibrate(10); },
  'delete-ev': () => { const ev = findEv(state.ui.sheet.id); A.softDelete(ev); vibrate(40); showToast('הרישום נמחק', () => A.restore(findEv(ev.client_mutation_id))); },
  undo: () => { const t = state.ui.toast; if (!t?.undo) return; t.undo(); vibrate([20, 40, 20]); showToast('הפעולה בוטלה', null, { ms: 2500 }); },
  'toggle-theme': () => saveSettings({ theme: state.settings.theme === 'day' ? 'night' : 'day' }),
  'toggle-hand': () => saveSettings({ hand: state.settings.hand === 'left' ? 'right' : 'left' }),
  'set-theme': (d) => saveSettings({ theme: d.v }),
  'set-hand': (d) => saveSettings({ hand: d.v }),
  'set-me': (d) => saveSettings({ meName: d.v }).then(() => transport()?.announce?.()),
  'set-conc': (d) => saveSettings({ conc: { ...state.settings.conc, [d.k]: +d.v } }),
  notif: () => guard(async () => {
    if (!('Notification' in window)) throw new Error('הדפדפן לא תומך בהתראות (באייפון: הוסיפו למסך הבית תחילה)');
    const p = await Notification.requestPermission();
    await saveSettings({ notifications: p === 'granted' });
  }),
  'save-cloud': () => guard(async () => {
    const url = $('#cfg-url').value.trim(), key = $('#cfg-key').value.trim();
    if (!/^https:\/\/.+/.test(url) || key.length < 20) throw new Error('כתובת או מפתח לא תקינים');
    await saveSettings({ supabaseUrl: url, supabaseKey: key }); location.reload();
  }),
  'cloud-reset': () => guard(async () => { await saveSettings({ supabaseUrl: '', supabaseKey: '' }); location.reload(); }),
  'auth-send': () => guard(async () => { const email = $('#auth-email').value.trim(); state.ui.authEmail = email; await transport().signIn(email); showToast('נשלח קוד/קישור למייל', null, { ms: 4000 }); }),
  'auth-link': () => guard(async () => {
    const raw = $('#auth-link').value.trim(), base = (state.settings.supabaseUrl || SUPABASE_URL).replace(/\/$/, '');
    if (!raw.startsWith(base + '/auth/v1/verify')) throw new Error('זה לא קישור הכניסה מהמייל — העתיקו את הקישור המלא');
    location.href = raw;
  }),
  'auth-verify': () => guard(async () => { await transport().verify($('#auth-email').value.trim(), $('#auth-code').value.trim()); showToast('מחובר/ת ✓', null, { ms: 3000 }); }),
  'hh-create': () => guard(async () => { const n = $('#hh-name').value; await saveSettings({ meName: n }); await transport().createHousehold(n); showToast('משק הבית נוצר והנתונים הועלו', null, { ms: 4000 }); }),
  'hh-join': () => guard(async () => { const n = $('#hh-name').value; await saveSettings({ meName: n }); await transport().joinHousehold($('#hh-code').value, n); showToast('הצטרפת למשק הבית ✓', null, { ms: 4000 }); }),
  'sign-out': () => guard(() => transport().signOut()),
  'share-invite': () => share('הצטרפות למעקב של ' + state.baby.name, `קוד הזמנה: ${state.household.invite_code}\n${location.origin + location.pathname}`),
  copy: (d) => guard(async () => { await navigator.clipboard.writeText(d.text); vibrate(15); showToast('הועתק ללוח', null, { ms: 2000 }); }),
  export: () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), household: state.household, baby: state.baby, events: state.events, stash: state.stash, growth: state.growth }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `ariel-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
  'reset-demo': (d, el) => guard(async () => {
    if (state.sync.mode === 'cloud' && state.sync.user) throw new Error('במצב ענן אין איפוס הדגמה — התנתקו קודם');
    if (!el.dataset.armed) { el.dataset.armed = '1'; el.textContent = 'הקישו שוב לאישור איפוס'; setTimeout(() => { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'איפוס נתוני הדגמה'; } }, 4000); return; }
    const settings = state.settings; await idb.clearAll(); await idb.put('kv', settings, 'settings'); await writeSeed(buildSeed()); location.reload();
  }),
  print: () => window.print(),
  'share-report': () => share(`דוח ${state.baby.name}`, reportText(state)),
};

async function share(title, text) {
  try {
    if (navigator.share) await navigator.share({ title, text });
    else { await navigator.clipboard.writeText(text); showToast('הועתק ללוח — הדביקו בוואטסאפ/מייל', null, { ms: 3000 }); }
  } catch { /* user cancelled */ }
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, h = H[act];
  if (!h) return;
  if (el.tagName !== 'A') e.preventDefault();
  if (MUTATING.has(act) && state.sync.role === 'viewer_pediatrician') { showToast('הרשאת צפייה בלבד', null, { ms: 2500, kind: 'error' }); return; }
  h(el.dataset, el, e);
  if (el.dataset.close && state.ui.sheet?.name !== 'flag' && state.ui.sheet?.name !== 'stool') closeSheet();
  bumpIdle();
}
function onChange(e) {
  const el = e.target.closest('[data-act-change="role"]');
  if (el) guard(async () => { await transport().setRole(el.dataset.user, el.value); showToast('ההרשאה עודכנה', null, { ms: 2500 }); });
}

// ------------------------------------------------------------------ ticker (rAF; pauses automatically when hidden)
let lastTickAt = 0, lastSec = 0, lastFullRender = 0, anomalySig = '';
function frame(ts) {
  if (ts - lastTickAt > 250) { lastTickAt = ts; tick(Date.now()); }
  requestAnimationFrame(frame);
}
function tick(now) {
  for (const el of document.querySelectorAll('[data-tick]')) {
    const d = el.dataset;
    let text = null;
    switch (d.tick) {
      case 'el': {
        if (!d.since && !+d.acc) break;
        const sec = +d.acc + (d.run === '1' && d.since ? Math.floor((now - +d.since) / 1000) : 0);
        text = d.fmt === 'hm' ? fmtHM(sec) : fmtHMS(sec);
        break;
      }
      case 'rel': text = relHe(+d.ts, now); break;
      case 'cd': {
        const left = +d.until - now;
        text = left <= 0 ? d.done || '' : d.fmt === 'hms' ? fmtHMS(left / 1000) : d.fmt === 'dur' ? durHe(left / 1000) : fmtHM(Math.ceil(left / 60000) * 60);
        break;
      }
      case 'sweet': {
        const ws = +d.ws, we = +d.we;
        el.classList.toggle('open', now >= ws && now <= we);
        el.classList.toggle('late', now > we);
        text = now < ws ? `בעוד ${fmtHM((ws - now) / 1000)}` : now <= we ? 'החלון פתוח כעת' : `באיחור ${fmtHM((now - we) / 1000)}`;
        break;
      }
      case 'prog': {
        const p = clamp((now - +d.from) / (+d.to - +d.from), 0, 1);
        el.style.width = `${(p * 100).toFixed(1)}%`;
        el.classList.toggle('hot', p > 0.85);
        break;
      }
    }
    if (text != null && el.textContent !== text) el.textContent = text;
  }
  const sec = Math.floor(now / 1000);
  if (sec !== lastSec) { lastSec = sec; perSecond(now); }
}
function perSecond(now) {
  const sig = ['nursing', 'sleep', 'pumping'].map((t) => (anomaly(state.timers[t], now) ? t : '')).join('|');
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (sig !== anomalySig || (now - lastFullRender > 30000 && !typing)) { anomalySig = sig; lastFullRender = now; render(); }
  sweetAlerts(now);
  dimCheck(now);
}

// ------------------------------------------------------------------ SweetSpot alerts (T-20 / T-5)
const fired = new Set(JSON.parse(sessionStorage.getItem('fired') || '[]'));
function sweetAlerts(now) {
  if (!state.baby || state.timers.sleep) return;
  const p = predict({ events: state.events, baby: state.baby, sleepTimer: null, now });
  if (!p || p.asleep) return;
  const list = [
    [p.alerts.prepare, 'prepare', 'זמן להחשיך חדר ולהתחיל טקס שינה'],
    [p.alerts.open, 'open', 'חלון השינה האופטימלי נפתח כעת'],
  ];
  for (const [at, kind, msg] of list) {
    const key = `${Math.round(p.target / 60000)}:${kind}`;
    if (now >= at && now < at + 3 * 60000 && !fired.has(key)) {
      fired.add(key); sessionStorage.setItem('fired', JSON.stringify([...fired].slice(-20)));
      vibrate([60, 80, 60]);
      showToast(`🌙 ${msg}`, null, { ms: 8000, kind: 'info' });
      notify(`${state.baby.name} · SweetSpot`, msg, key);
    }
  }
}
async function notify(title, body, tag) {
  if (!state.settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const reg = await navigator.serviceWorker?.ready; reg ? reg.showNotification(title, { body, tag, lang: 'he', dir: 'rtl', icon: './icons/icon-192.png', badge: './icons/icon-192.png' }) : new Notification(title, { body, tag }); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ Screen Wake Lock + dim while nursing
let wakeLock = null, idleAt = Date.now();
async function manageWakeLock() {
  const want = state.timers.nursing?.status === 'RUNNING' && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* battery saver etc. */ }
  } else if (!want && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
function bumpIdle() { idleAt = Date.now(); document.body.classList.remove('dimmed'); }
function dimCheck(now) {
  const dim = state.timers.nursing?.status === 'RUNNING' && state.settings.theme !== 'day' && now - idleAt > 45000 && !state.ui.sheet;
  document.body.classList.toggle('dimmed', dim);
}

// ------------------------------------------------------------------ URL quick actions (?quick_action=…)
function quickAction() {
  const params = new URLSearchParams(location.search);
  const qa = params.get('quick_action');
  if (!qa) return;
  history.replaceState(null, '', location.pathname);
  const side = params.get('side');
  const map = {
    nursing: () => (state.timers.nursing ? openSheet('nursing') : run(A.startTimer('nursing', { side: side || state.baby.recommended_next_side || 'right', at: Date.now() }))),
    sleep: () => H.sleep(),
    wet_diaper: () => H.diaper({ type: 'wet' }),
    dirty_diaper: () => H.diaper({ type: 'dirty' }),
    bottle: () => openSheet('bottle'),
    vitamin_d: () => run(A.logMed('vitamin_d3')),
    pump: () => openSheet('pump'),
  };
  map[qa]?.();
}

// ------------------------------------------------------------------ boot
async function boot() {
  await idb.open();
  await seedIfEmpty();
  await load();
  state.ready = true;
  subscribe(render);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('pointerdown', bumpIdle, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.ui.sheet) closeSheet(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { last.view = ''; render(); } manageWakeLock(); });
  render();
  $('#splash')?.remove();
  quickAction();
  requestAnimationFrame(frame);
  startSync().catch((e) => { console.error(e); state.sync.status = 'error'; state.sync.lastError = e.message; emit(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW', e));
  }
}
boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div class="fatal">שגיאה בטעינה: ${esc(e.message)}</div>`;
});
