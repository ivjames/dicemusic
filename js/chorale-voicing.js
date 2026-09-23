// Four-part voice leading by dynamic programming. For each chord every acceptable SATB
// voicing is enumerated (ranges, spacing, completeness, doubling), then the cheapest path
// through the sequence is found where the cost between two voicings encodes the classical
// rules: no parallel fifths or octaves, no hidden ones in the outer voices, the leading
// tone and chord sevenths resolve, chromatic tones resolve, voices stay close and do not
// overlap. Deterministic: the same chords in the same key always give the same voices.
import { CHORDS, KEYS, tonePc } from './chorale-harmony.js?v=dev';

export const RANGES = { S: [60, 79], A: [55, 74], T: [48, 67], B: [40, 60] };
const NAMES = ['B', 'T', 'A', 'S'];   // voicing arrays are ordered bass, tenor, alto, soprano

function notesInRange(pc, [lo, hi]) {
  const out = [];
  for (let m = lo; m <= hi; m++) if (m % 12 === pc) out.push(m);
  return out;
}

/** A chord's tones resolved to pitch classes, with root, seventh and bass identified. */
function realize(symbol, keyName) {
  const c = CHORDS[symbol];
  const tones = c.tones.map((t) => ({ deg: t[0], alt: t[1], pc: tonePc(keyName, t) }));
  return {
    symbol, tones,
    root: tones[0], seventh: tones.length === 4 ? tones[3] : null,
    bassPc: tonePc(keyName, [c.bass, c.tones.find((t) => t[0] === c.bass)?.[1] ?? 0]),
    cadential64: Boolean(c.cadential64),
    pcs: new Set(tones.map((t) => t.pc)),
    toneOf: (midi) => tones.find((t) => t.pc === midi % 12),
    inversion: c.bass === c.tones[0][0] ? 0 : c.bass === c.tones[1][0] ? 1 : c.bass === c.tones[2][0] ? 2 : 3,
  };
}

/** All acceptable voicings of a chord, each with a static cost. */
export function candidates(chord, keyName, { first = false, last = false } = {}) {
  const out = [];
  const leadingPc = (KEYS[keyName].tonic + 11) % 12;
  const tonicPc = KEYS[keyName].tonic % 12;
  const isSeventh = Boolean(chord.seventh);
  for (const b of notesInRange(chord.bassPc, RANGES.B)) {
    for (let t = Math.max(RANGES.T[0], b); t <= RANGES.T[1] && t - b <= 24; t++) {
      if (!chord.pcs.has(t % 12)) continue;
      for (let a = Math.max(RANGES.A[0], t); a <= RANGES.A[1] && a - t <= 12; a++) {
        if (!chord.pcs.has(a % 12)) continue;
        for (let s = Math.max(RANGES.S[0], a); s <= RANGES.S[1] && s - a <= 12; s++) {
          if (!chord.pcs.has(s % 12)) continue;
          const v = [b, t, a, s];
          const present = new Set(v.map((m) => m % 12));
          const counts = new Map();
          for (const m of v) counts.set(m % 12, (counts.get(m % 12) || 0) + 1);
          const rootPc = chord.root.pc, thirdPc = chord.tones[1].pc, fifthPc = chord.tones[2].pc;
          if (!present.has(rootPc) || !present.has(thirdPc)) continue;           // never omit root or third
          if (isSeventh && !present.has(chord.seventh.pc)) continue;              // a seventh chord keeps its seventh
          let cost = 0;
          if (!present.has(fifthPc)) {
            // fifth omitted: only in root position with the root doubled (tripled for triads)
            if (chord.inversion !== 0) continue;
            if ((counts.get(rootPc) || 0) < (isSeventh ? 2 : 3)) continue;
            cost += isSeventh ? 0.8 : (last ? 0.5 : 3);
          }
          // doublings
          for (const [pc, n] of counts) {
            if (n < 2) continue;
            if (pc === leadingPc) { cost = Infinity; break; }                    // never double the leading tone
            const tone = chord.toneOf(pc);
            if (tone.alt !== 0) { cost = Infinity; break; }                       // nor a chromatic tone
            if (isSeventh && pc === chord.seventh.pc) { cost = Infinity; break; } // nor the seventh
            if (chord.cadential64) cost += pc === chord.bassPc ? 0 : 4;          // 6/4: double the bass
            else if (pc === rootPc) cost += 0;
            else if (pc === fifthPc) cost += 1.5;
            else cost += chord.inversion === 1 ? 1.5 : 2.5;                       // third doubled
          }
          if (!Number.isFinite(cost)) continue;
          // spacing and tessitura: keep each voice where it sings comfortably
          if (s - t > 12) cost += 0.06 * (s - t - 12);
          cost += tessitura(s, 64, 76) + tessitura(a, 57, 71) + tessitura(t, 50, 64) + tessitura(b, 43, 57);
          if (t - b > 19) cost += 0.5;
          const sDeg = chord.toneOf(s % 12).deg;
          if (first) cost += sDeg === 1 ? 1 : 0;
          if (last && sDeg !== 1) continue;                                      // the tune ends on the tonic
          out.push({ v, cost });
        }
      }
    }
  }
  out.sort((x, y) => x.cost - y.cost || x.v.join() < y.v.join() ? -1 : 1);
  return out.slice(0, 220);
}

function tessitura(m, lo, hi) { return m < lo ? (lo - m) * 0.5 : m > hi ? (m - hi) * 0.5 : 0; }

function isPerfect(iv) { const m = ((iv % 12) + 12) % 12; return m === 0 || m === 7; }

/** Cost of moving from one voicing to the next, or Infinity for a forbidden progression. */
export function transitionCost(prev, cur, prevChord, curChord, keyName) {
  let cost = 0;
  const tonicPc = KEYS[keyName].tonic % 12;
  const leadingPc = (tonicPc + 11) % 12;
  const dominantPc = (tonicPc + 7) % 12;
  // parallel perfect intervals between any two voices (compound and contrary included)
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const iv1 = prev[j] - prev[i], iv2 = cur[j] - cur[i];
      const moved = prev[i] !== cur[i] && prev[j] !== cur[j];
      if (moved && isPerfect(iv1) && isPerfect(iv2) && ((iv1 % 12) + 12) % 12 === ((iv2 % 12) + 12) % 12) return Infinity;
      if (moved && iv1 % 12 !== 0 && iv2 % 12 === 0 && i === 0 && j === 3) cost += 0; // (octave by contrary motion handled above)
    }
  }
  // hidden fifths/octaves in the outer voices: similar motion into a perfect interval with a soprano leap
  const dB = cur[0] - prev[0], dS = cur[3] - prev[3];
  if (dB !== 0 && dS !== 0 && Math.sign(dB) === Math.sign(dS) && Math.abs(dS) > 2 && isPerfect(cur[3] - cur[0]) && !isPerfect(prev[3] - prev[0])) cost += 4;
  // melodic motion
  const weights = [0.4, 1.3, 1.3, 1.0];
  for (let i = 0; i < 4; i++) {
    const d = Math.abs(cur[i] - prev[i]);
    cost += d * weights[i];
    if (i === 0) { if (d > 12) cost += 2; }
    else if (i === 3) { if (d > 7) cost += 3; else if (d > 4) cost += 1; if (d === 0) cost += 0.8; }
    else { if (d > 5) cost += 3; if (d === 0) cost -= 0.7; }
    if (d === 6) cost += 3;                                         // no melodic tritone
  }
  // voice overlap
  for (let i = 0; i < 3; i++) if (cur[i] > prev[i + 1] || cur[i + 1] < prev[i]) cost += 3;
  // tendency tones of the previous chord: hard rules wherever the next chord holds the
  // resolution (the harmony table guarantees that it does), so an advertised rule is never
  // merely paid for
  for (let i = 0; i < 4; i++) {
    const tone = prevChord.toneOf(prev[i] % 12);
    const d = cur[i] - prev[i];
    if (prev[i] % 12 === leadingPc && tone.alt === 0 && (i === 3 || i === 0) && curChord.pcs.has(tonicPc) && d !== 1) {
      // the leading tone in an outer voice rises: absolute in the soprano, and in the bass
      // whenever the next chord's bass is the tonic (V6 -> I); otherwise a penalty (V6 -> vi)
      if (i === 3 || curChord.bassPc === tonicPc) return Infinity;
      cost += 8;
    }
    if (prevChord.seventh && prev[i] % 12 === prevChord.seventh.pc) {
      const stepDown = curChord.pcs.has((prev[i] + 11) % 12) || curChord.pcs.has((prev[i] + 10) % 12);
      if (!(d === -1 || d === -2)) { if (stepDown) return Infinity; cost += 8; }   // sevenths fall by step
    }
    if (tone.alt === 1 && d !== 1) { if (curChord.pcs.has((prev[i] + 1) % 12)) return Infinity; cost += 6; }   // raised tone rises
    if (tone.alt === -1 && d !== -1) { if (curChord.pcs.has((prev[i] + 11) % 12)) return Infinity; cost += 6; } // lowered tone falls
    if (prevChord.cadential64 && curChord.root.pc === dominantPc && i > 0) {
      if (tone.deg === 1 && d !== -1) cost += 5;                     // 6/4: 1 -> 7
      if (tone.deg === 3 && d !== -2) cost += 5;                     //      3 -> 2
    }
  }
  return cost;
}

/**
 * Voice a chord sequence. `symbols` are chord names from CHORALE_TABLE; returns
 * { voicings: [[b,t,a,s] midi], chords, cost } or throws if no legal path exists.
 */
export function voiceLead(symbols, keyName) {
  if (!KEYS[keyName]) throw new RangeError(`unknown key ${keyName}`);
  const chords = symbols.map((s) => realize(s, keyName));
  const n = chords.length;
  const cands = chords.map((c, k) => candidates(c, keyName, { first: k === 0, last: k === n - 1 }));
  let dp = cands[0].map((c) => c.cost);
  const back = [];
  for (let k = 1; k < n; k++) {
    const next = new Array(cands[k].length).fill(Infinity);
    const bp = new Array(cands[k].length).fill(-1);
    for (let j = 0; j < cands[k].length; j++) {
      const cur = cands[k][j];
      let best = Infinity, bi = -1;
      for (let i = 0; i < cands[k - 1].length; i++) {
        if (!Number.isFinite(dp[i])) continue;
        const c = dp[i] + transitionCost(cands[k - 1][i].v, cur.v, chords[k - 1], chords[k], keyName);
        if (c < best) { best = c; bi = i; }
      }
      next[j] = best + cur.cost; bp[j] = bi;
    }
    dp = next; back.push(bp);
  }
  let end = -1, bestCost = Infinity;
  dp.forEach((c, i) => { if (c < bestCost) { bestCost = c; end = i; } });
  if (end < 0) throw new Error('no legal voicing path');
  const idx = [end];
  for (let k = n - 1; k >= 1; k--) idx.unshift(back[k - 1][idx[0]]);
  const voicings = idx.map((i, k) => cands[k][i].v);
  return { voicings, chords, cost: bestCost };
}

/** Rule checker used by the tests: returns a list of violations for a voiced sequence. */
export function violations(voicings, chords, keyName) {
  const out = [];
  const tonicPc = KEYS[keyName].tonic % 12;
  voicings.forEach((v, k) => {
    NAMES.forEach((name, i) => { const [lo, hi] = RANGES[name]; if (v[i] < lo || v[i] > hi) out.push(`${k}: ${name} out of range`); });
    for (let i = 0; i < 3; i++) if (v[i] > v[i + 1]) out.push(`${k}: voices cross`);
    if (v[2] - v[1] > 12 || v[3] - v[2] > 12) out.push(`${k}: spacing`);
    for (const m of v) if (!chords[k].pcs.has(m % 12)) out.push(`${k}: non-chord tone`);
    if (v[0] % 12 !== chords[k].bassPc) out.push(`${k}: wrong bass`);
    const present = new Set(v.map((m) => m % 12));
    if (!present.has(chords[k].root.pc) || !present.has(chords[k].tones[1].pc)) out.push(`${k}: incomplete`);
    if (k > 0) {
      const p = voicings[k - 1];
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
        const iv1 = p[j] - p[i], iv2 = v[j] - v[i];
        if (p[i] !== v[i] && p[j] !== v[j] && isPerfect(iv1) && isPerfect(iv2) && ((iv1 % 12) + 12) % 12 === ((iv2 % 12) + 12) % 12) out.push(`${k}: parallel ${((iv1 % 12) + 12) % 12 === 0 ? 'octaves' : 'fifths'} ${NAMES[i]}-${NAMES[j]}`);
      }
      // tendency tones
      const pc = chords[k - 1];
      const leadingPc = (tonicPc + 11) % 12;
      for (let i = 0; i < 4; i++) {
        const tone = pc.toneOf(p[i] % 12);
        const d = v[i] - p[i];
        if (p[i] % 12 === leadingPc && tone.alt === 0 && (i === 3 || (i === 0 && chords[k].bassPc === tonicPc)) && chords[k].pcs.has(tonicPc) && d !== 1) out.push(`${k}: leading tone in ${NAMES[i]} does not rise`);
        if (pc.seventh && p[i] % 12 === pc.seventh.pc && !(d === -1 || d === -2)) out.push(`${k}: seventh in ${NAMES[i]} does not fall by step`);
        if (tone.alt === 1 && d !== 1) out.push(`${k}: raised tone in ${NAMES[i]} does not rise`);
        if (tone.alt === -1 && d !== -1) out.push(`${k}: lowered tone in ${NAMES[i]} does not fall`);
      }
    }
  });
  const last = voicings[voicings.length - 1];
  if (last[3] % 12 !== tonicPc) out.push('final soprano not on the tonic');
  return out;
}
