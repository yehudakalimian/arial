// Sync transports.
//  • LocalTransport — demo mode with no backend: BroadcastChannel keeps several tabs/windows in real-time sync
//    (timers, events, presence) so the distributed-timer model can be tried immediately.
//  • CloudTransport — Supabase: IndexedDB outbox drained with idempotent UPSERT ON CONFLICT (client_mutation_id),
//    Realtime postgres_changes + low-latency broadcast, presence ("הדס צופה כעת").
import * as idb from './idb.js';
import { state, emit, applyRemote, setTransport, saveKv } from './store.js';
import { uuid, iso } from './util.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JS_URL } from './config.js';

const TAB_ID = uuid();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v) => (v && UUID_RE.test(v) ? v : null);

let active = null;
export const transport = () => active;

export function cloudConfig() {
  const url = state.settings.supabaseUrl || SUPABASE_URL;
  const key = state.settings.supabaseKey || SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export async function startSync() {
  const cfg = cloudConfig();
  active = cfg ? new CloudTransport(cfg) : new LocalTransport();
  setTransport(active);
  await active.start();
  window.addEventListener('online', () => { state.sync.online = true; active.onOnline?.(); emit(); });
  window.addEventListener('offline', () => { state.sync.online = false; if (state.sync.mode === 'cloud') state.sync.status = 'offline'; emit(); });
  document.addEventListener('visibilitychange', () => active.onVisibility?.(document.visibilityState === 'visible'));
}

// ------------------------------------------------------------------ Local (demo) transport
class LocalTransport {
  constructor() { this.peers = new Map(); this.bc = 'BroadcastChannel' in window ? new BroadcastChannel('ariel-sync') : null; }
  async start() {
    state.sync.mode = 'local'; state.sync.status = 'local';
    if (!this.bc) return;
    this.bc.onmessage = ({ data }) => {
      if (data.from === TAB_ID) return;
      if (data.type === 'change') applyRemote(data.table, data.op, data.row);
      if (data.type === 'presence') { this.peers.set(data.from, { ...data, seen: Date.now() }); this.publishPeers(); }
      if (data.type === 'bye') { this.peers.delete(data.from); this.publishPeers(); }
      if (data.type === 'hello') this.announce();
    };
    this.bc.postMessage({ type: 'hello', from: TAB_ID });
    this.announce();
    setInterval(() => { this.announce(); this.prune(); }, 10000);
    window.addEventListener('pagehide', () => this.bc.postMessage({ type: 'bye', from: TAB_ID }));
  }
  announce() { this.bc?.postMessage({ type: 'presence', from: TAB_ID, display_name: state.me.display_name, visible: document.visibilityState === 'visible' }); }
  prune() { const now = Date.now(); for (const [k, v] of this.peers) if (now - v.seen > 25000) this.peers.delete(k); this.publishPeers(); }
  publishPeers() { state.sync.peers = [...this.peers.values()].map((p) => ({ display_name: p.display_name, visible: p.visible })); emit(); }
  onVisibility() { this.announce(); }
  outbound(table, op, row) { this.bc?.postMessage({ type: 'change', from: TAB_ID, table, op, row }); }
}

// ------------------------------------------------------------------ Supabase transport
const CONFLICT = { care_events: 'client_mutation_id', active_timers: 'baby_id,timer_type', milk_stash: 'id', growth_measurements: 'id' };
const keyOf = (table, row) => (table === 'active_timers' ? `${row.baby_id}:${row.timer_type}` : table === 'care_events' ? row.client_mutation_id : row.id);

const COLS = {
  care_events: ['id', 'client_mutation_id', 'baby_id', 'household_id', 'logged_by', 'logged_by_name', 'event_type', 'started_at', 'ended_at', 'duration_sec', 'nursing_left_sec', 'nursing_right_sec', 'ending_side', 'volume_ml', 'diaper_type', 'stool_color', 'medication_code', 'dosage_ml', 'metadata', 'is_deleted', 'client_updated_at', 'created_at'],
  active_timers: ['baby_id', 'household_id', 'timer_type', 'status', 'active_side', 'first_side', 'session_started_at', 'started_at', 'paused_at', 'accumulated_left_sec', 'accumulated_right_sec', 'accumulated_total_sec', 'updated_by', 'updated_at'],
  milk_stash: ['id', 'baby_id', 'household_id', 'pumped_at', 'storage_location', 'initial_volume_ml', 'remaining_volume_ml', 'thawed_at', 'expires_at', 'status', 'created_at', 'updated_at'],
  growth_measurements: ['id', 'baby_id', 'household_id', 'measured_at', 'weight_grams', 'length_cm', 'head_circumference_cm', 'who_weight_percentile', 'who_length_percentile', 'who_head_percentile', 'notes', 'updated_at'],
};
function toServer(table, row) {
  const out = {};
  for (const c of COLS[table]) if (row[c] !== undefined) out[c] = row[c];
  if (table === 'care_events') { out.logged_by = asUuid(row.logged_by); out.id = row.client_mutation_id; }
  return out;
}
function fromServer(table, row) {
  if (table === 'active_timers') return { ...row, id: `${row.baby_id}:${row.timer_type}` };
  if (table === 'care_events') return { ...row, client_mutation_id: row.client_mutation_id || row.id, dosage_ml: row.dosage_ml == null ? null : Number(row.dosage_ml) };
  if (table === 'growth_measurements') return { ...row, length_cm: row.length_cm == null ? null : Number(row.length_cm), head_circumference_cm: row.head_circumference_cm == null ? null : Number(row.head_circumference_cm) };
  return row;
}

class CloudTransport {
  constructor(cfg) { this.cfg = cfg; this.sb = null; this.channel = null; this.draining = false; this.backoff = 1000; }

  async start() {
    state.sync.mode = 'cloud'; state.sync.status = 'connecting'; emit();
    try {
      const { createClient } = await import(SUPABASE_JS_URL);
      this.sb = createClient(this.cfg.url, this.cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, realtime: { params: { eventsPerSecond: 20 } } });
    } catch (e) {
      // Offline on first cloud boot: keep working locally, outbox drains later.
      state.sync.status = 'offline'; state.sync.lastError = 'ספריית Supabase לא נטענה (לא מקוון)'; emit();
      window.addEventListener('online', () => this.start(), { once: true });
      return;
    }
    this.sb.auth.onAuthStateChange((_evt, session) => { if (session?.user?.id !== state.sync.user?.id) this.onSession(session); });
    const { data } = await this.sb.auth.getSession();
    await this.onSession(data.session);
  }

  async onSession(session) {
    state.sync.user = session?.user ? { id: session.user.id, email: session.user.email } : null;
    if (!session) { state.sync.status = 'signed_out'; emit(); return; }
    const uid = session.user.id;
    const { data: mem, error } = await this.sb.from('household_members').select('household_id, display_name, role, households(id, name, invite_code, created_at)').eq('user_id', uid).limit(1).maybeSingle();
    if (error) { state.sync.status = navigator.onLine ? 'error' : 'offline'; state.sync.lastError = error.message; emit(); return; }
    if (!mem) { state.sync.status = 'no_household'; emit(); return; }
    state.sync.role = mem.role;
    await saveKv('me', { user_id: uid, display_name: mem.display_name });
    await saveKv('household', mem.households);
    await this.connect();
  }

  async connect() {
    const hid = state.household.id;
    const { data: babies } = await this.sb.from('babies').select('*').eq('household_id', hid).order('created_at').limit(1);
    if (babies?.[0]) await saveKv('baby', babies[0]);
    const { data: members } = await this.sb.from('household_members').select('household_id, user_id, display_name, role').eq('household_id', hid);
    if (members) await saveKv('members', members);
    await this.drain();
    await this.pull();
    this.subscribe();
    state.sync.status = navigator.onLine ? 'live' : 'offline'; emit();
  }

  async pull() {
    const hid = state.household.id;
    const since = iso(Date.now() - 60 * 864e5);
    const [ev, tm, st, gr] = await Promise.all([
      this.sb.from('care_events').select('*').eq('household_id', hid).gte('started_at', since).order('started_at', { ascending: false }).limit(5000),
      this.sb.from('active_timers').select('*').eq('household_id', hid),
      this.sb.from('milk_stash').select('*').eq('household_id', hid).order('pumped_at').limit(1000),
      this.sb.from('growth_measurements').select('*').eq('household_id', hid).order('measured_at'),
    ]);
    ev.data?.forEach((r) => applyRemote('care_events', 'upsert', fromServer('care_events', r), { silent: true }));
    st.data?.forEach((r) => applyRemote('milk_stash', 'upsert', r, { silent: true }));
    gr.data?.forEach((r) => applyRemote('growth_measurements', 'upsert', fromServer('growth_measurements', r), { silent: true }));
    if (tm.data) {
      const serverTypes = new Set(tm.data.map((r) => r.timer_type));
      const pendingKeys = new Set((await idb.getAll('sync_outbox_queue')).map((o) => o.key));
      for (const type of Object.keys(state.timers)) {
        const t = state.timers[type];
        if (!serverTypes.has(type) && !pendingKeys.has(`${t.baby_id}:${type}`)) applyRemote('active_timers', 'delete', t, { silent: true });
      }
      tm.data.forEach((r) => applyRemote('active_timers', 'upsert', fromServer('active_timers', r), { silent: true }));
    }
    emit();
  }

  subscribe() {
    if (this.channel) this.sb.removeChannel(this.channel);
    const hid = state.household.id;
    const ch = this.sb.channel(`household:${hid}`, { config: { broadcast: { self: false }, presence: { key: `${state.me.user_id}:${TAB_ID}` } } });
    for (const table of ['care_events', 'active_timers', 'milk_stash', 'growth_measurements']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `household_id=eq.${hid}` }, (p) => {
        if (p.eventType === 'DELETE') { if (table === 'active_timers' && p.old?.timer_type) applyRemote(table, 'delete', fromServer(table, p.old)); return; }
        applyRemote(table, 'upsert', fromServer(table, p.new));
      });
    }
    if (state.baby) ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'babies', filter: `id=eq.${state.baby.id}` }, (p) => applyRemote('babies', 'upsert', p.new));
    ch.on('broadcast', { event: 'change' }, ({ payload }) => applyRemote(payload.table, payload.op, payload.row));
    ch.on('presence', { event: 'sync' }, () => {
      const ps = ch.presenceState();
      state.sync.peers = Object.entries(ps).filter(([k]) => !k.endsWith(TAB_ID)).flatMap(([, v]) => v).map((p) => ({ display_name: p.display_name + (p.user_id === state.me.user_id ? ' (מכשיר נוסף)' : ''), visible: p.visible }));
      emit();
    });
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') { state.sync.status = 'live'; emit(); await this.track(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { state.sync.status = navigator.onLine ? 'error' : 'offline'; emit(); }
    });
    this.channel = ch;
  }

  track() { return this.channel?.track({ user_id: state.me.user_id, display_name: state.me.display_name, visible: document.visibilityState === 'visible', at: Date.now() }); }

  onVisibility(visible) { this.track(); if (visible) { this.drain(); if (state.household) this.pull().catch(() => {}); } }
  onOnline() { this.backoff = 1000; if (!this.sb) return; this.drain(); if (state.household) { this.pull().catch(() => {}); this.subscribe(); } }

  async outbound(table, op, row) {
    // Always queue first (works offline / before sign-in); drain() decides when it can flush.
    const entry = { client_mutation_id: uuid(), table, op, key: table === 'babies' ? `baby:${row.id}` : keyOf(table, row), row, queued_at: Date.now(), attempts: 0 };
    await idb.put('sync_outbox_queue', entry);
    state.sync.pending++;
    emit();
    // Low-latency fan-out to the partner's open app (DB write follows via the outbox).
    if (this.channel && state.sync.status === 'live') this.channel.send({ type: 'broadcast', event: 'change', payload: { table, op, row } }).catch(() => {});
    this.drain();
  }

  async drain() {
    if (this.draining || !this.sb || !navigator.onLine || !state.sync.user || !state.household) return;
    this.draining = true;
    try {
      const queue = (await idb.getAll('sync_outbox_queue')).sort((a, b) => a.queued_at - b.queued_at);
      // Coalesce: final state per key wins (keeps order of last occurrence).
      const latest = new Map();
      for (const e of queue) { latest.delete(`${e.table}|${e.key}`); latest.set(`${e.table}|${e.key}`, e); }
      const groups = [...latest.values()];
      const upserts = {};
      for (const e of groups) if (e.op === 'upsert' && e.table !== 'babies') (upserts[e.table] ||= []).push(e);
      for (const [table, entries] of Object.entries(upserts)) {
        const { error } = await this.sb.from(table).upsert(entries.map((e) => toServer(table, e.row)), { onConflict: CONFLICT[table] });
        if (error) throw Object.assign(new Error(error.message), { entries, table });
        await this.ack(queue, entries);
      }
      for (const e of groups.filter((g) => g.op === 'delete' || g.table === 'babies')) {
        const q = e.table === 'babies'
          ? this.sb.from('babies').update({ last_nursing_side: e.row.last_nursing_side, recommended_next_side: e.row.recommended_next_side }).eq('id', e.row.id)
          : this.sb.from(e.table).delete().match(e.table === 'active_timers' ? { baby_id: e.row.baby_id, timer_type: e.row.timer_type } : { id: e.row.id });
        const { error } = await q;
        if (error) throw Object.assign(new Error(error.message), { entries: [e], table: e.table });
        await this.ack(queue, [e]);
      }
      this.backoff = 1000;
      state.sync.lastError = null;
    } catch (err) {
      state.sync.lastError = err.message;
      // Poison-message handling: after 6 failed attempts move entries aside so the queue keeps flowing.
      for (const e of err.entries || []) {
        e.attempts = (e.attempts || 0) + 1;
        if (e.attempts >= 6) { await idb.del('sync_outbox_queue', e.client_mutation_id); await idb.put('kv', [...((await idb.get('kv', 'dead_letters')) || []), e], 'dead_letters'); }
        else await idb.put('sync_outbox_queue', e);
      }
      setTimeout(() => this.drain(), this.backoff);
      this.backoff = Math.min(60000, this.backoff * 2);
    } finally {
      this.draining = false;
      state.sync.pending = (await idb.getAll('sync_outbox_queue')).length;
      emit();
    }
  }

  async ack(queue, entries) {
    for (const e of entries) {
      // remove the coalesced entry and every older entry with the same key
      for (const q of queue) if (q.table === e.table && q.key === e.key && q.queued_at <= e.queued_at) await idb.del('sync_outbox_queue', q.client_mutation_id);
    }
  }

  // ---- account / household helpers used by Settings ----
  async signIn(email) {
    const { error } = await this.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
  }
  async verify(email, token) {
    const { error } = await this.sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
  }
  async signOut() { await this.sb.auth.signOut(); location.reload(); }

  /** Create a household and upload the local (seeded or real) data into it. */
  async createHousehold(displayName) {
    const b = state.baby;
    const { data, error } = await this.sb.rpc('create_household', {
      p_household_name: state.household?.name || 'הבית של ' + b.name, p_display_name: displayName,
      p_baby_id: b.id, p_baby_name: b.name, p_sex: b.sex, p_birth_date: b.birth_date.slice(0, 10), p_due_date: b.expected_due_date || null,
    });
    if (error) throw error;
    const hid = data.household.id;
    const rehome = (r) => ({ ...r, household_id: hid });
    await saveKv('household', data.household);
    await saveKv('baby', { ...b, household_id: hid });
    await idb.putMany('local_care_events', state.events.map(rehome));
    state.events = state.events.map(rehome); state.stash = state.stash.map(rehome); state.growth = state.growth.map(rehome);
    for (const t of Object.values(state.timers)) state.timers[t.timer_type] = rehome(t);
    const entries = [
      ...state.events.map((r) => ['care_events', r]), ...state.stash.map((r) => ['milk_stash', r]),
      ...state.growth.map((r) => ['growth_measurements', r]), ...Object.values(state.timers).map((r) => ['active_timers', r]),
    ].map(([table, row], i) => ({ client_mutation_id: uuid(), table, op: 'upsert', key: keyOf(table, row), row, queued_at: Date.now() + i * 1e-3, attempts: 0 }));
    await idb.putMany('sync_outbox_queue', entries);
    await idb.putMany('milk_stash', state.stash); await idb.putMany('growth_measurements', state.growth);
    await this.onSession((await this.sb.auth.getSession()).data.session);
  }

  /** Join the partner's household by its 6-char invite code (local demo data on this device is replaced). */
  async joinHousehold(code, displayName) {
    const { data, error } = await this.sb.rpc('join_household', { p_invite_code: code.trim().toUpperCase(), p_display_name: displayName });
    if (error) throw error;
    for (const s of ['local_care_events', 'active_timers', 'milk_stash', 'growth_measurements', 'sync_outbox_queue']) await idb.clear(s);
    state.events = []; state.timers = {}; state.stash = []; state.growth = [];
    await saveKv('household', data.household);
    await this.onSession((await this.sb.auth.getSession()).data.session);
  }

  async setRole(userId, role) {
    const { error } = await this.sb.rpc('set_member_role', { p_household_id: state.household.id, p_user_id: userId, p_role: role });
    if (error) throw error;
    const { data } = await this.sb.from('household_members').select('household_id, user_id, display_name, role').eq('household_id', state.household.id);
    if (data) await saveKv('members', data);
  }
}
