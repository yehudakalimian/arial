// FIFO breast-milk stash + CDC / Israeli MOH storage expiration engine.
import { HOUR, DAY, toMs, iso } from '../util.js';

export const LOCATIONS = {
  room_temp: { label: 'טמפ׳ חדר', long: 'טמפרטורת חדר (עד 25°C)', hours: 4, warnBeforeH: 1, priority: 0 },
  thawed_fridge: { label: 'מופשר', long: 'הפשרה במקרר (אין להקפיא שוב)', hours: 24, warnBeforeH: 4, priority: 1 },
  fridge: { label: 'מקרר', long: 'מקרר 4°C', hours: 96, warnBeforeH: 12, priority: 2 },
  freezer: { label: 'מקפיא', long: 'מקפיא ‎-18°C', months: 6, warnBeforeH: 14 * 24, priority: 9 },
};

export function computeExpiresAt(location, pumpedAt, thawedAt = null) {
  const p = toMs(pumpedAt);
  if (location === 'thawed_fridge') return iso(toMs(thawedAt ?? Date.now()) + 24 * HOUR);
  if (location === 'freezer') { const d = new Date(p); d.setMonth(d.getMonth() + 6); return iso(d.getTime()); }
  return iso(p + LOCATIONS[location].hours * HOUR);
}

export function createBag({ baby, pumpedAt, location, volume, id }) {
  return {
    id, baby_id: baby.id, household_id: baby.household_id,
    pumped_at: iso(pumpedAt), storage_location: location,
    initial_volume_ml: volume, remaining_volume_ml: volume,
    thawed_at: null, expires_at: computeExpiresAt(location, pumpedAt),
    status: 'AVAILABLE', created_at: iso(Date.now()), updated_at: iso(Date.now()),
  };
}

/** 'ok' | 'warn' | 'expired' (amber at 3h for room temp, 12h before fridge expiry, ...). */
export function expiryState(bag, now = Date.now()) {
  const exp = toMs(bag.expires_at);
  if (now >= exp) return 'expired';
  const warn = LOCATIONS[bag.storage_location]?.warnBeforeH ?? 12;
  return exp - now <= warn * HOUR ? 'warn' : 'ok';
}

export function canMove(bag, to) {
  if (bag.status !== 'AVAILABLE') return false;
  const from = bag.storage_location;
  if (from === to) return false;
  if (to === 'freezer') return from !== 'thawed_fridge' && !bag.thawed_at; // never refreeze thawed milk
  if (to === 'thawed_fridge') return from === 'freezer';
  if (to === 'fridge') return from === 'room_temp';
  return false;
}

/** Move a bag between locations, recomputing expiry. Thawing sets thawed_at=now and expires=now+24h. */
export function moveBag(bag, to, now = Date.now()) {
  if (!canMove(bag, to)) throw new Error(`illegal move ${bag.storage_location} -> ${to}`);
  const b = { ...bag, storage_location: to, updated_at: iso(now) };
  if (to === 'thawed_fridge') { b.thawed_at = iso(now); b.expires_at = iso(now + 24 * HOUR); }
  else b.expires_at = computeExpiresAt(to, bag.pumped_at);
  // Room-temp milk moved to fridge keeps the earlier deadline if that is stricter.
  if (to === 'fridge') b.expires_at = iso(Math.min(toMs(b.expires_at), toMs(bag.pumped_at) + 96 * HOUR));
  return b;
}

export const isUsable = (b, now = Date.now()) =>
  b.status === 'AVAILABLE' && b.remaining_volume_ml > 0 && toMs(b.expires_at) > now && b.storage_location !== 'freezer';

/** FIFO order: room_temp -> thawed_fridge -> oldest fridge; ties by earliest expiry. Frozen bags must be thawed first. */
export function fifoOrder(bags, now = Date.now()) {
  return bags.filter((b) => isUsable(b, now)).sort((a, b) =>
    LOCATIONS[a.storage_location].priority - LOCATIONS[b.storage_location].priority ||
    toMs(a.expires_at) - toMs(b.expires_at) || toMs(a.pumped_at) - toMs(b.pumped_at));
}

/** Plan a deduction of `volume` ml. Returns { allocations:[{bag, take, after}], shortfall }. */
export function allocate(bags, volume, now = Date.now()) {
  let left = volume;
  const allocations = [];
  for (const bag of fifoOrder(bags, now)) {
    if (left <= 0) break;
    const take = Math.min(left, bag.remaining_volume_ml);
    const remaining = bag.remaining_volume_ml - take;
    allocations.push({ bag, take, after: { ...bag, remaining_volume_ml: remaining, status: remaining <= 0 ? 'CONSUMED' : 'AVAILABLE', updated_at: iso(now) } });
    left -= take;
  }
  return { allocations, shortfall: Math.max(0, left) };
}

/** Bags that crossed their expiry while AVAILABLE. */
export function expiredBags(bags, now = Date.now()) {
  return bags.filter((b) => b.status === 'AVAILABLE' && toMs(b.expires_at) <= now);
}

export function totals(bags, now = Date.now()) {
  const t = { room_temp: 0, thawed_fridge: 0, fridge: 0, freezer: 0, usable: 0, all: 0 };
  for (const b of bags) {
    if (b.status !== 'AVAILABLE' || toMs(b.expires_at) <= now) continue;
    t[b.storage_location] += b.remaining_volume_ml; t.all += b.remaining_volume_ml;
    if (b.storage_location !== 'freezer') t.usable += b.remaining_volume_ml;
  }
  return t;
}

export const daysLeft = (bag, now = Date.now()) => (toMs(bag.expires_at) - now) / DAY;
