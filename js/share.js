// Shareable-URL codec. The URL stores the raw dice, never the derived totals or measures,
// so a link always reproduces the exact music: ?d=<32 digits 1-6>&l=<locks as 16 bits, hex>&r=1
import { BARS } from './table.js';
import { isPair } from './dice.js';

export function encodeState({ pairs, locks = [], repeats = false }) {
  if (!Array.isArray(pairs) || pairs.length !== BARS || !pairs.every(isPair)) {
    throw new RangeError('encodeState needs 16 complete dice pairs');
  }
  const d = pairs.map((p) => `${p[0]}${p[1]}`).join('');
  let bits = 0;
  for (let i = 0; i < BARS; i++) if (locks[i]) bits |= 1 << i;
  const params = new URLSearchParams();
  params.set('d', d);
  if (bits) params.set('l', bits.toString(16));
  if (repeats) params.set('r', '1');
  return params.toString();
}

/**
 * Parse a query string. Returns { pairs, locks, repeats } for a valid link,
 * { empty: true } when the link carries no composition, or { error } when it is malformed.
 */
export function decodeState(search) {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch {
    return { error: 'The link could not be read.' };
  }
  const d = params.get('d');
  if (d === null) return { empty: true };
  if (!/^[1-6]{32}$/.test(d)) {
    return { error: 'The link does not hold a valid set of dice, so nothing was loaded.' };
  }
  const pairs = [];
  for (let i = 0; i < BARS; i++) pairs.push([Number(d[2 * i]), Number(d[2 * i + 1])]);
  const locks = new Array(BARS).fill(false);
  const l = params.get('l');
  if (l !== null) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(l)) {
      return { error: 'The link holds dice but its lock marks are malformed, so nothing was loaded.' };
    }
    const bits = parseInt(l, 16);
    for (let i = 0; i < BARS; i++) locks[i] = Boolean(bits & (1 << i));
  }
  const r = params.get('r');
  if (r !== null && r !== '1' && r !== '0') {
    return { error: 'The link holds an unknown repeat setting, so nothing was loaded.' };
  }
  return { pairs, locks, repeats: r === '1' };
}
