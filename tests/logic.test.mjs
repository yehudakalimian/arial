// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/logic/timers.js';
import * as S from '../js/logic/stash.js';
import { predict, ageBand } from '../js/logic/sweetspot.js';
import { lockState, doseFor, feverFlag } from '../js/logic/meds.js';
import { zScore, percentile, crossingAlerts } from '../js/logic/who.js';
import { hydration, stoolFlag, splitSleep } from '../js/logic/clinical.js';
import { buildSeed } from '../js/seed.js';

const MIN = 60e3, HOUR = 36e5, DAY = 864e5;
const baby = { id: 'b1', household_id: 'h1', sex: 'male', birth_date: '2026-10-14T08:00:00+03:00', expected_due_date: '2026-10-18' };

test('nursing: atomic side switch accumulates the previous side', () => {
  const t0 = Date.parse('2026-11-17T03:00:00Z');
  let t = T.createTimer({ type: 'nursing', side: 'left', at: t0, baby, by: 'הדס' });
  assert.equal(T.nursingState(t), 'ACTIVE_LEFT');
  t = T.switchSide(t, 'right', t0 + 10 * MIN);
  assert.equal(t.accumulated_left_sec, 600);
  assert.equal(t.active_side, 'right');
  assert.equal(T.elapsed(t, t0 + 14 * MIN).right, 240);
  t = T.pause(t, t0 + 14 * MIN);
  assert.equal(T.nursingState(t), 'PAUSED');
  assert.equal(T.elapsed(t, t0 + 60 * MIN).total, 840); // paused: no growth
  t = T.resume(t, t0 + 20 * MIN);
  const done = T.complete(t, t0 + 22 * MIN);
  assert.equal(done.nursing_left_sec, 600);
  assert.equal(done.nursing_right_sec, 360);
  assert.equal(done.ending_side, 'right');
});

test('next side: dessert rule and alternation', () => {
  assert.equal(T.recommendNextSide({ nursing_left_sec: 900, nursing_right_sec: 200, ending_side: 'right', first_side: 'left' }).side, 'right');
  assert.equal(T.recommendNextSide({ nursing_left_sec: 900, nursing_right_sec: 720, ending_side: 'right', first_side: 'left' }).side, 'right');
  assert.equal(T.recommendNextSide({ nursing_left_sec: 600, nursing_right_sec: 540, ending_side: 'left', first_side: 'right' }).side, 'left');
  assert.equal(T.recommendNextSide({ nursing_left_sec: 0, nursing_right_sec: 900, ending_side: 'right', first_side: 'right' }).side, 'left');
});

test('zombie guard', () => {
  const t0 = Date.now() - 50 * MIN;
  const t = T.createTimer({ type: 'nursing', side: 'left', at: t0, baby, by: 'x' });
  assert.equal(T.anomaly(t)?.status, 'ANOMALOUS_OPEN');
  const nap = T.createTimer({ type: 'sleep', at: Date.parse('2026-11-17T10:00:00'), baby, by: 'x' });
  assert.equal(T.anomaly(nap, Date.parse('2026-11-17T13:40:00'))?.reason, 'nap>3.5h');
  assert.equal(T.anomaly(nap, Date.parse('2026-11-17T12:00:00')), null);
});

test('stash: expiry rules, thaw, FIFO priority', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const room = S.createBag({ baby, pumpedAt: now - 3.2 * HOUR, location: 'room_temp', volume: 60, id: 'r' });
  assert.equal(S.expiryState(room, now), 'warn');
  const fridgeOld = S.createBag({ baby, pumpedAt: now - 3 * DAY, location: 'fridge', volume: 80, id: 'f1' });
  const fridgeNew = S.createBag({ baby, pumpedAt: now - 1 * DAY, location: 'fridge', volume: 100, id: 'f2' });
  assert.equal(Date.parse(fridgeOld.expires_at) - Date.parse(fridgeOld.pumped_at), 96 * HOUR);
  const frozen = S.createBag({ baby, pumpedAt: now - 10 * DAY, location: 'freezer', volume: 120, id: 'z' });
  const thawed = S.moveBag(frozen, 'thawed_fridge', now);
  assert.equal(Date.parse(thawed.expires_at), now + 24 * HOUR);
  assert.equal(S.canMove(thawed, 'freezer'), false); // no refreeze
  const order = S.fifoOrder([fridgeNew, fridgeOld, thawed, room, frozen], now).map((b) => b.id);
  assert.deepEqual(order, ['r', 'z', 'f1', 'f2']);
  const plan = S.allocate([fridgeNew, fridgeOld, room], 100, now);
  assert.deepEqual(plan.allocations.map((a) => [a.bag.id, a.take]), [['r', 60], ['f1', 40]]);
  assert.equal(plan.allocations[0].after.status, 'CONSUMED');
  assert.equal(S.allocate([frozen], 50, now).shortfall, 50); // frozen bags must be thawed first
});

test('sweetspot: short-nap penalty and morning factor', () => {
  const now = Date.parse('2026-11-17T11:00:00+02:00');
  const ev = (s, e) => ({ event_type: 'sleep', started_at: new Date(s).toISOString(), ended_at: new Date(e).toISOString() });
  const night = ev(Date.parse('2026-11-17T01:00:00+02:00'), Date.parse('2026-11-17T06:30:00+02:00'));
  const p1 = predict({ events: [night], baby, now: Date.parse('2026-11-17T06:40:00+02:00') });
  assert.equal(p1.isFirst, true);
  assert.equal(p1.factor, 0.85);
  const nap = ev(Date.parse('2026-11-17T09:30:00+02:00'), Date.parse('2026-11-17T09:55:00+02:00')); // 25 min
  const p2 = predict({ events: [night, nap], baby, now });
  assert.equal(p2.penalty, Math.round((40 - 25) * 0.6));
  assert.ok(p2.target > Date.parse('2026-11-17T09:55:00+02:00'));
  assert.equal(ageBand(4.9).min, 45);
});

test('meds: daily lock, interval lock, cross-medication gap, dose calc', () => {
  const now = Date.parse('2026-11-17T12:00:00');
  const ev = (code, t, who = 'הדס') => ({ event_type: 'medication', medication_code: code, started_at: new Date(t).toISOString(), logged_by_name: who });
  const d = lockState('vitamin_d3', [ev('vitamin_d3', Date.parse('2026-11-17T09:15:00'))], { now, ageDays: 34 });
  assert.equal(d.locked, true); assert.equal(d.by, 'הדס');
  const n = lockState('paracetamol_novimol', [ev('paracetamol_novimol', now - 2 * HOUR)], { now, ageDays: 120 });
  assert.equal(n.locked, true); assert.equal(n.until, now + 2 * HOUR);
  const c = lockState('paracetamol_novimol', [ev('ibuprofen_nurofen', now - 1 * HOUR)], { now, ageDays: 120 });
  assert.equal(c.reason, 'cross');
  assert.equal(lockState('ibuprofen_nurofen', [], { now, ageDays: 34 }).reason, 'age');
  assert.deepEqual(doseFor('paracetamol_novimol', 4450, 32), { mg: 67, ml: 2.1, conc: 32 });
  assert.equal(feverFlag(38.2, 34).level, 'red');
});

test('WHO z-scores match reference medians', () => {
  assert.ok(Math.abs(zScore('wfa', 'male', 0, 3.3464)) < 1e-6);
  assert.ok(Math.abs(percentile(zScore('lhfa', 'female', 365, 74.0049)) - 50) < 0.5);
  const p = percentile(zScore('wfa', 'male', 29, 4.45));
  assert.ok(p > 40 && p < 65, `got ${p}`);
  const ms = [
    { measured_at: '2026-10-28T10:00:00Z', weight_grams: 3800 },
    { measured_at: '2026-12-28T10:00:00Z', weight_grams: 4300 },
  ];
  assert.equal(crossingAlerts(ms, baby)[0]?.dir, 'down');
});

test('clinical: hydration, stool flags, day/night sleep split', () => {
  const now = Date.parse('2026-11-17T12:00:00');
  const wet = (h) => ({ event_type: 'diaper', diaper_type: 'wet', started_at: new Date(now - h * HOUR).toISOString() });
  const evs = [wet(1), wet(5), wet(9), wet(30)];
  assert.equal(hydration(evs, 34, now).alert, true);
  assert.equal(hydration(evs, 3, now).alert, false);
  assert.ok(stoolFlag('white_acholic', 30));
  assert.equal(stoolFlag('black', 3), null);
  assert.ok(stoolFlag('black', 10));
  const s = Date.parse('2026-11-17T18:00:00'), e = Date.parse('2026-11-17T21:00:00');
  const sp = splitSleep(s, e);
  assert.equal(sp.night, 2 * HOUR); assert.equal(sp.day, HOUR);
});

test('seed builds a coherent state', () => {
  const seed = buildSeed(Date.parse('2026-11-17T15:00:00+02:00'));
  assert.equal(seed.baby.name, 'אריאל');
  assert.ok(seed.events.length > 150);
  const p = predict({ events: seed.events, baby: seed.baby, now: Date.parse('2026-11-17T15:00:00+02:00') });
  assert.ok(p && p.target > p.wakeAt);
  assert.equal(seed.growth.at(-1).weight_grams, 4450);
});
