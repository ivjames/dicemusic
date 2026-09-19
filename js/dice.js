import { BARS, measureFor } from './table.js';

/** One fair six-sided die. `rng` returns a float in [0, 1). */
export function rollDie(rng = Math.random) {
  const r = rng();
  if (!(r >= 0 && r < 1)) throw new RangeError('rng must return a number in [0, 1)');
  return 1 + Math.floor(r * 6);
}

/** Two independent dice: the total is not uniform on 2..12 (seven is six times as likely as two). */
export function rollPair(rng = Math.random) {
  return [rollDie(rng), rollDie(rng)];
}

export function isDie(v) {
  return Number.isInteger(v) && v >= 1 && v <= 6;
}

export function isPair(p) {
  return Array.isArray(p) && p.length === 2 && isDie(p[0]) && isDie(p[1]);
}

/** Derive the bar's total and measure number from its two dice. */
export function barFromDice(bar, pair) {
  if (!isPair(pair)) throw new RangeError(`bad dice for bar ${bar + 1}: ${JSON.stringify(pair)}`);
  const sum = pair[0] + pair[1];
  return { bar, dice: [pair[0], pair[1]], sum, measure: measureFor(bar, sum) };
}

/** Full composition (16 bars) from 16 dice pairs. */
export function composeFrom(pairs) {
  if (!Array.isArray(pairs) || pairs.length !== BARS) throw new RangeError('need exactly 16 dice pairs');
  return pairs.map((p, i) => barFromDice(i, p));
}

export function rollAll(rng = Math.random) {
  const pairs = [];
  for (let i = 0; i < BARS; i++) pairs.push(rollPair(rng));
  return pairs;
}

/** Re-roll every bar that is not locked. `pairs` may contain nulls for bars never rolled. */
export function rollUnlocked(pairs, locks, rng = Math.random) {
  const out = [];
  for (let i = 0; i < BARS; i++) {
    const keep = locks[i] && pairs && isPair(pairs[i]);
    out.push(keep ? [pairs[i][0], pairs[i][1]] : rollPair(rng));
  }
  return out;
}

/** Re-roll one bar only. */
export function rerollBar(pairs, bar, rng = Math.random) {
  const out = pairs.map((p) => (p ? [p[0], p[1]] : null));
  out[bar] = rollPair(rng);
  return out;
}
