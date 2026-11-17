// Distributed timer model + bilateral nursing state machine.
// A timer row never streams ticks: devices only sync
// (status, started_at, paused_at, accumulated_*), and render
// elapsed = accumulated + floor((now - started_at)/1000) locally.
import { toMs, iso } from '../util.js';

export const NURSING_STATE = Object.freeze({
  IDLE: 'IDLE', ACTIVE_LEFT: 'ACTIVE_LEFT', ACTIVE_RIGHT: 'ACTIVE_RIGHT', PAUSED: 'PAUSED', COMPLETED: 'COMPLETED',
});

export const SIDE_HE = { left: 'שמאל', right: 'ימין' };
export const other = (side) => (side === 'left' ? 'right' : 'left');

export function nursingState(timer) {
  if (!timer) return NURSING_STATE.IDLE;
  if (timer.status === 'PAUSED') return NURSING_STATE.PAUSED;
  return timer.active_side === 'left' ? NURSING_STATE.ACTIVE_LEFT : NURSING_STATE.ACTIVE_RIGHT;
}

/** Seconds in the currently running segment (0 when paused). */
export function segmentSec(timer, now = Date.now()) {
  if (!timer || timer.status !== 'RUNNING') return 0;
  return Math.max(0, Math.floor((now - toMs(timer.started_at)) / 1000));
}

export function elapsed(timer, now = Date.now()) {
  if (!timer) return { left: 0, right: 0, total: 0 };
  const seg = segmentSec(timer, now);
  const left = (timer.accumulated_left_sec || 0) + (timer.active_side === 'left' ? seg : 0);
  const right = (timer.accumulated_right_sec || 0) + (timer.active_side === 'right' ? seg : 0);
  const total = (timer.accumulated_total_sec || 0) + seg;
  return { left, right, total };
}

export function createTimer({ type, side = null, at, baby, by }) {
  const t = iso(at);
  return {
    id: `${baby.id}:${type}`,
    baby_id: baby.id,
    household_id: baby.household_id,
    timer_type: type,
    status: 'RUNNING',
    active_side: side,
    first_side: side,
    session_started_at: t,
    started_at: t,
    paused_at: null,
    accumulated_left_sec: 0,
    accumulated_right_sec: 0,
    accumulated_total_sec: 0,
    updated_by: by,
    updated_at: iso(Date.now()),
  };
}

/** Fold the running segment (up to `at`) into the accumulators. Returns a new object. */
function fold(timer, at) {
  const t = { ...timer };
  if (t.status === 'RUNNING') {
    const seg = Math.max(0, Math.floor((at - toMs(t.started_at)) / 1000));
    if (t.active_side === 'left') t.accumulated_left_sec += seg;
    if (t.active_side === 'right') t.accumulated_right_sec += seg;
    t.accumulated_total_sec += seg;
  }
  return t;
}

const touch = (t, by) => ({ ...t, updated_by: by ?? t.updated_by, updated_at: iso(Date.now()) });

/** Atomic side switch: adds (now - started_at) to the old side, restarts the segment on the new side. */
export function switchSide(timer, side, now = Date.now(), by) {
  if (timer.active_side === side && timer.status === 'RUNNING') return timer;
  const t = fold(timer, now);
  t.active_side = side;
  t.status = 'RUNNING';
  t.started_at = iso(now);
  t.paused_at = null;
  return touch(t, by);
}

export function pause(timer, now = Date.now(), by) {
  if (timer.status !== 'RUNNING') return timer;
  const t = fold(timer, now);
  t.status = 'PAUSED';
  t.paused_at = iso(now);
  return touch(t, by);
}

export function resume(timer, now = Date.now(), by) {
  if (timer.status === 'RUNNING') return timer;
  return touch({ ...timer, status: 'RUNNING', started_at: iso(now), paused_at: null }, by);
}

/**
 * COMPLETED transition. `endAt` may be in the past (quick-offset chip).
 * Returns the care-event fields for the finished session.
 */
export function complete(timer, endAt = Date.now()) {
  const t = fold(timer, Math.max(toMs(timer.started_at), endAt));
  const ended = timer.status === 'PAUSED' ? Math.min(endAt, toMs(timer.paused_at) || endAt) : endAt;
  return {
    started_at: timer.session_started_at || timer.started_at,
    ended_at: iso(Math.max(ended, toMs(timer.session_started_at || timer.started_at))),
    duration_sec: t.accumulated_total_sec,
    nursing_left_sec: timer.timer_type === 'nursing' ? t.accumulated_left_sec : null,
    nursing_right_sec: timer.timer_type === 'nursing' ? t.accumulated_right_sec : null,
    ending_side: timer.timer_type === 'nursing' ? timer.active_side : null,
    first_side: timer.first_side,
  };
}

const USED_MIN_SEC = 30;
/**
 * Next-side algorithm.
 * Rule 1 ("Dessert Rule"): both sides used and the ending side lasted < 300s -> same side next.
 * Rule 2: otherwise the side with significantly less time, else the opposite of the starting side.
 */
export function recommendNextSide({ nursing_left_sec: L = 0, nursing_right_sec: R = 0, ending_side, first_side }) {
  const usedL = L >= USED_MIN_SEC, usedR = R >= USED_MIN_SEC;
  if (usedL && usedR) {
    const endSec = ending_side === 'left' ? L : R;
    if (endSec < 300) return { side: ending_side, rule: 'dessert' };
    const diff = Math.abs(L - R);
    if (diff > Math.max(180, 0.4 * Math.max(L, R))) return { side: L < R ? 'left' : 'right', rule: 'shorter' };
    return { side: other(first_side || ending_side), rule: 'alternate' };
  }
  if (usedL || usedR) return { side: usedL ? 'right' : 'left', rule: 'alternate' };
  return { side: other(first_side || ending_side || 'left'), rule: 'alternate' };
}

/** Zombie Timer Guard. Returns null or { reason } when a timer is ANOMALOUS_OPEN. */
export function anomaly(timer, now = Date.now()) {
  if (!timer) return null;
  const e = elapsed(timer, now);
  if (timer.timer_type === 'nursing') {
    const sideSec = timer.active_side === 'left' ? e.left : e.right;
    if (timer.status === 'RUNNING' && sideSec > 45 * 60) return { status: 'ANOMALOUS_OPEN', reason: 'side>45' };
    if (e.total > 75 * 60) return { status: 'ANOMALOUS_OPEN', reason: 'total>75' };
    if (timer.status === 'PAUSED' && now - toMs(timer.paused_at) > 60 * 60 * 1000) return { status: 'ANOMALOUS_OPEN', reason: 'paused>60' };
  }
  if (timer.timer_type === 'sleep') {
    const h = new Date(toMs(timer.session_started_at)).getHours();
    const dayNap = h >= 7 && h < 19;
    if (dayNap && e.total > 3.5 * 3600) return { status: 'ANOMALOUS_OPEN', reason: 'nap>3.5h' };
    if (!dayNap && e.total > 12 * 3600) return { status: 'ANOMALOUS_OPEN', reason: 'night>12h' };
  }
  if (timer.timer_type === 'pumping' && e.total > 60 * 60) return { status: 'ANOMALOUS_OPEN', reason: 'pump>60' };
  return null;
}
