// Shared view helpers: event summaries, live-tick attributes, sync status text.
import { esc, durHe, toMs, fmtClock } from '../util.js';
import { SIDE_HE } from '../logic/timers.js';
import { STOOL_COLORS } from '../logic/clinical.js';
import { MEDS } from '../logic/meds.js';
import { EVENT_ICON } from './icons.js';

const m = (sec) => Math.round((sec || 0) / 60);

export function eventSummary(ev) {
  switch (ev.event_type) {
    case 'nursing': {
      const parts = [];
      if (ev.nursing_right_sec) parts.push(`ימין ${m(ev.nursing_right_sec)}`);
      if (ev.nursing_left_sec) parts.push(`שמאל ${m(ev.nursing_left_sec)}`);
      return `הנקה ${m(ev.duration_sec)} דק'${parts.length ? ' · ' + parts.join(' · ') : ''}`;
    }
    case 'bottle': return `בקבוק ${ev.volume_ml} מ"ל · ${ev.metadata?.source === 'formula' ? 'תמ״ל' : 'חלב שאוב'}`;
    case 'sleep': return `שינה ${durHe(ev.duration_sec || (toMs(ev.ended_at) - toMs(ev.started_at)) / 1000)}`;
    case 'diaper': {
      const t = { wet: 'רטוב', dirty: 'מלוכלך', mixed: 'משולב' }[ev.diaper_type];
      const c = ev.stool_color ? ` · ${STOOL_COLORS[ev.stool_color]?.label}` : '';
      return `חיתול ${t}${c}`;
    }
    case 'medication': return `${MEDS[ev.medication_code]?.label || ev.medication_code}${ev.dosage_ml ? ` ${ev.dosage_ml} מ"ל` : ''}`;
    case 'temperature': return `חום גוף ${Number(ev.metadata?.temp_c).toFixed(1)}°C`;
    case 'pumping': return `שאיבה ${ev.volume_ml ?? 0} מ"ל${ev.metadata?.right_ml != null ? ` (ימין ${ev.metadata.right_ml} · שמאל ${ev.metadata.left_ml})` : ''}`;
    default: return ev.event_type;
  }
}
export const eventIcon = (ev) => EVENT_ICON[ev.event_type] || '';
export const eventRefTime = (ev) => toMs(ev.ended_at || ev.started_at);
export const isRedFlag = (ev) => !!ev.metadata?.red_flag || ev.metadata?.flag === 'red';
export const sideHe = (s) => SIDE_HE[s] || '';

/** Live elapsed counter: elapsed = acc + floor((now - since)/1000) when running. */
export const tickEl = ({ since, acc = 0, run = true, fmt = 'hms' }) =>
  `data-tick="el" data-since="${since ?? ''}" data-acc="${acc}" data-run="${run ? 1 : 0}" data-fmt="${fmt}"`;
export const tickRel = (ts) => `data-tick="rel" data-ts="${toMs(ts)}"`;
export const tickCd = (until, fmt = 'hm', done = '') => `data-tick="cd" data-until="${until}" data-fmt="${fmt}" data-done="${esc(done)}"`;

export function syncText(s) {
  const peer = s.sync.peers.find((p) => p.visible) || s.sync.peers[0];
  const peerTxt = peer ? ` · ${esc(peer.display_name)} ${peer.visible ? 'צופה כעת' : 'מחובר/ת'}` : '';
  switch (s.sync.status) {
    case 'live': return { cls: 'ok', text: `מסונכרן חי${peerTxt}` };
    case 'offline': return { cls: 'warn', text: `מצב לא מקוון — יסונכרן אוטומטית${s.sync.pending ? ` (${s.sync.pending})` : ''}` };
    case 'connecting': return { cls: 'warn', text: 'מתחבר…' };
    case 'error': return { cls: 'bad', text: `שגיאת סנכרון — ננסה שוב${s.sync.pending ? ` (${s.sync.pending})` : ''}` };
    case 'signed_out': return { cls: 'warn', text: 'לא מחובר לחשבון · נשמר במכשיר' };
    case 'no_household': return { cls: 'warn', text: 'מחובר · יש ליצור/להצטרף למשק בית' };
    default: return { cls: peer ? 'ok' : 'local', text: peer ? `סנכרון חי בין חלונות${peerTxt}` : 'מצב הדגמה · נשמר במכשיר' };
  }
}

export const clock = fmtClock;
export const segBtn = (act, k, v, cur, label, extra = '') =>
  `<button class="seg ${String(cur) === String(v) ? 'on' : ''}" data-act="${act}" data-k="${k}" data-v="${esc(v)}" aria-pressed="${String(cur) === String(v)}" ${extra}>${label}</button>`;
