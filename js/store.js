// Central app state. Every write lands in memory first (0 ms UI), then IndexedDB,
// then the sync transport (Supabase outbox + realtime broadcast, or BroadcastChannel in local mode).
import * as idb from './idb.js';
import { iso, toMs } from './util.js';

export const DEFAULT_SETTINGS = {
  theme: 'night', hand: 'right', meName: 'יהודה',
  conc: { paracetamol_novimol: 32, ibuprofen_nurofen: 20 },
  lastBottle: { volume: 90, source: 'pumped' },
  lastPump: { right: 50, left: 50, location: 'fridge' },
  lastStoolColor: 'yellow', lastTemp: 37.0,
  notifications: false, supabaseUrl: '', supabaseKey: '',
};

export const state = {
  ready: false,
  household: null, members: [], baby: null,
  events: [], timers: {}, stash: [], growth: [],
  settings: { ...DEFAULT_SETTINGS },
  me: { user_id: null, display_name: 'יהודה' },
  sync: { mode: 'local', status: 'local', online: navigator.onLine, pending: 0, peers: [], user: null, role: 'parent_admin', lastError: null },
  ui: { tab: 'track', offsetMin: 0, sheet: null, toast: null, journalFilter: 'all', growthInd: 'wfa' },
};

const listeners = new Set();
let scheduled = false;
export function emit() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; listeners.forEach((f) => f(state)); });
}
export const subscribe = (f) => (listeners.add(f), () => listeners.delete(f));

let transport = null;
export const setTransport = (t) => { transport = t; };

const TABLE_STORE = { care_events: 'local_care_events', active_timers: 'active_timers', milk_stash: 'milk_stash', growth_measurements: 'growth_measurements' };
const stamp = (table, row) => (table === 'care_events' ? row.client_updated_at : row.updated_at);

export async function load() {
  const [events, timers, stash, growth, settings, household, baby, members, me] = await Promise.all([
    idb.getAll('local_care_events'), idb.getAll('active_timers'), idb.getAll('milk_stash'), idb.getAll('growth_measurements'),
    idb.get('kv', 'settings'), idb.get('kv', 'household'), idb.get('kv', 'baby'), idb.get('kv', 'members'), idb.get('kv', 'me'),
  ]);
  state.events = events.sort(byStartDesc);
  state.timers = Object.fromEntries(timers.map((t) => [t.timer_type, t]));
  state.stash = stash; state.growth = growth;
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}), conc: { ...DEFAULT_SETTINGS.conc, ...(settings?.conc || {}) } };
  state.household = household || null; state.baby = baby || null; state.members = members || [];
  state.me = me || { user_id: `local-${state.settings.meName}`, display_name: state.settings.meName };
  state.sync.pending = (await idb.getAll('sync_outbox_queue')).length;
}

const byStartDesc = (a, b) => toMs(b.started_at) - toMs(a.started_at);

function applyLocal(table, op, row) {
  if (table === 'care_events') {
    const i = state.events.findIndex((e) => e.client_mutation_id === row.client_mutation_id);
    if (i >= 0) state.events[i] = row; else state.events.push(row);
    state.events.sort(byStartDesc);
  } else if (table === 'active_timers') {
    if (op === 'delete') { if (state.timers[row.timer_type]?.id === row.id || !row.id) delete state.timers[row.timer_type]; }
    else state.timers[row.timer_type] = row;
  } else if (table === 'milk_stash' || table === 'growth_measurements') {
    const list = table === 'milk_stash' ? state.stash : state.growth;
    const i = list.findIndex((x) => x.id === row.id);
    if (op === 'delete') { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = row; else list.push(row);
  } else if (table === 'babies') {
    state.baby = { ...state.baby, ...row };
  }
}

async function persist(table, op, row) {
  if (table === 'babies') return idb.put('kv', state.baby, 'baby');
  const store = TABLE_STORE[table];
  if (op === 'delete') return idb.del(store, row.id);
  return idb.put(store, row);
}

/** Local write: memory → emit → IndexedDB → transport (outbox/broadcast). */
export function write(table, row, op = 'upsert') {
  applyLocal(table, op, row);
  emit();
  persist(table, op, row).catch((e) => console.error('persist failed', e));
  transport?.outbound(table, op, row);
  return row;
}

/** Remote change (Supabase realtime / pull / other tab). Last-write-wins on client timestamps. */
export function applyRemote(table, op, row, { silent = false } = {}) {
  if (table === 'babies') { state.baby = { ...state.baby, ...row }; persist(table, op, row); if (!silent) emit(); return; }
  if (op !== 'delete') {
    const cur = table === 'care_events' ? state.events.find((e) => e.client_mutation_id === row.client_mutation_id)
      : table === 'active_timers' ? state.timers[row.timer_type]
        : (table === 'milk_stash' ? state.stash : state.growth).find((x) => x.id === row.id);
    if (cur && stamp(table, cur) && stamp(table, row) && toMs(stamp(table, cur)) > toMs(stamp(table, row))) return;
    if (table === 'care_events') row = { ...row, client_mutation_id: row.client_mutation_id || row.id };
  }
  applyLocal(table, op, row);
  persist(table, op, row).catch(() => {});
  if (!silent) emit();
}

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  if (patch.meName && state.sync.mode === 'local') state.me = { user_id: `local-${patch.meName}`, display_name: patch.meName };
  emit();
  await idb.put('kv', state.settings, 'settings');
  if (patch.meName) await idb.put('kv', state.me, 'me');
}
export async function saveKv(key, value) { state[key] = value; emit(); await idb.put('kv', value, key); }

export function baseRow() {
  return { baby_id: state.baby.id, household_id: state.baby.household_id };
}
export const nowIso = () => iso(Date.now());
