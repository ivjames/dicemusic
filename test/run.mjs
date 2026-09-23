// Unit and integration checks that run in Node: `node test/run.mjs`
import assert from 'node:assert/strict';
import { MINUET_TABLE, measureFor, optionsFor, BARS, MEASURE_COUNT } from '../js/table.js';
import { rollDie, rollPair, composeFrom, rollAll, rollUnlocked, rerollBar } from '../js/dice.js';
import { encodeState, decodeState } from '../js/share.js';
import { MEASURES, UNITS_PER_BAR } from '../js/score.js';
import { renderMeasure, hasEndings, playbackPlan, mixdown, bufferKey, barSamples, measureSamples, realize, notesOf, BAR_SECONDS } from '../js/synth.js';
import { encodeWav, decodeWav } from '../js/wav.js';
import { voiceToAbc, minuetToAbc, scoreMeasureIndex, pitchName } from '../js/notation.js';
import { CHORALE_TABLE, CHORDS, KEY_NAMES, chordFor, keyAccidental, degreeLetter } from '../js/chorale-harmony.js';
import { voiceLead, violations } from '../js/chorale-voicing.js';
import { compose as composeChorale, plan as choralePlan, render as renderChoraleStep, choraleToAbc, scoreIndex as choraleScoreIndex, CHORD_SECONDS, FERMATA_FACTOR, BREATH_SECONDS } from '../js/chorale.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- lookup table ----------
test('table has 11 rows of 16 and uses every measure 1..176 exactly once', () => {
  const seen = new Map();
  for (let s = 2; s <= 12; s++) {
    assert.equal(MINUET_TABLE[s].length, BARS, `row ${s}`);
    for (const m of MINUET_TABLE[s]) seen.set(m, (seen.get(m) || 0) + 1);
  }
  assert.equal(seen.size, MEASURE_COUNT);
  for (let m = 1; m <= MEASURE_COUNT; m++) assert.equal(seen.get(m), 1, `measure ${m}`);
  for (let b = 0; b < BARS; b++) assert.equal(new Set(optionsFor(b)).size, 11);
});

test('every table entry resolves to an available measure with both staves covering the bar', () => {
  for (let s = 2; s <= 12; s++) for (let b = 0; b < BARS; b++) {
    const id = measureFor(b, s);
    const m = MEASURES[id];
    assert.ok(m, `measure ${id} missing`);
    for (const variant of m.notes ? [m.notes] : [m.first, m.second]) {
      for (const staff of [0, 1]) {
        const evs = variant.filter((n) => n[3] === staff);
        assert.ok(evs.length, `measure ${id} staff ${staff} empty`);
        const end = Math.max(...evs.map((n) => n[0] + n[1]));
        assert.ok(end <= UNITS_PER_BAR && end >= 4, `measure ${id} staff ${staff} ends at ${end}`);
        for (const [o, d, midi] of evs) { assert.ok(o >= 0 && d > 0 && o + d <= UNITS_PER_BAR); assert.ok(midi >= 36 && midi <= 96); }
      }
    }
  }
});

test('the eleven bar-8 measures, and only those, carry two endings', () => {
  const eights = new Set(optionsFor(7));
  for (let id = 1; id <= MEASURE_COUNT; id++) assert.equal(hasEndings(id), eights.has(id), `measure ${id}`);
});

test('reference regression: sums 3,7,6,12,7,10,7,5,9,9,10,7,9,4,6,6 select the recorded measures', () => {
  const sums = [3, 7, 6, 12, 7, 10, 7, 5, 9, 9, 10, 7, 9, 4, 6, 6];
  const expected = [32, 157, 163, 103, 154, 129, 118, 100, 120, 88, 19, 29, 51, 58, 1, 93];
  assert.deepEqual(sums.map((s, b) => measureFor(b, s)), expected);
  // via dice pairs too, whichever faces make those totals
  const pairs = sums.map((s) => [Math.min(6, s - 1), s - Math.min(6, s - 1)]);
  assert.deepEqual(composeFrom(pairs).map((x) => x.measure), expected);
});

// ---------- dice ----------
test('a die maps the unit interval onto 1..6 evenly and rejects bad generators', () => {
  for (let i = 0; i < 6; i++) { assert.equal(rollDie(() => i / 6), i + 1); assert.equal(rollDie(() => (i + 0.999) / 6), i + 1); }
  assert.throws(() => rollDie(() => 1), RangeError);
});

test('two dice: seven is about six times as common as two (not uniform on 2..12)', () => {
  const N = 200000; const counts = new Array(13).fill(0);
  for (let i = 0; i < N; i++) { const [a, b] = rollPair(); counts[a + b]++; }
  const p = (s) => counts[s] / N;
  assert.ok(Math.abs(p(7) - 6 / 36) < 0.01, `p(7)=${p(7)}`);
  assert.ok(Math.abs(p(2) - 1 / 36) < 0.005, `p(2)=${p(2)}`);
  assert.ok(Math.abs(p(12) - 1 / 36) < 0.005, `p(12)=${p(12)}`);
  assert.ok(p(7) > 4 * p(2));
});

test('rollAll gives 16 pairs; rollUnlocked keeps locked bars; rerollBar touches one bar', () => {
  let n = 0; const rng = () => ((n++ * 7919) % 6007) / 6007;
  const pairs = rollAll(rng);
  assert.equal(pairs.length, BARS);
  const locks = new Array(BARS).fill(false); locks[2] = true; locks[15] = true;
  const again = rollUnlocked(pairs, locks, rng);
  assert.deepEqual(again[2], pairs[2]); assert.deepEqual(again[15], pairs[15]);
  const one = rerollBar(pairs, 5, rng);
  for (let i = 0; i < BARS; i++) if (i !== 5) assert.deepEqual(one[i], pairs[i]);
  // a locked bar that was never rolled still gets dice
  const fresh = rollUnlocked(new Array(BARS).fill(null), locks, rng);
  assert.ok(fresh.every((p) => p[0] >= 1 && p[0] <= 6));
});

// ---------- share links ----------
test('share link round-trips dice, locks and a game setting', () => {
  const pairs = rollAll();
  const locks = pairs.map((_, i) => i % 3 === 0);
  const qs = encodeState({ pairs, locks, extra: { r: '1' } });
  const back = decodeState('?' + qs);
  assert.deepEqual(back.pairs, pairs); assert.deepEqual(back.locks, locks); assert.equal(back.params.get('r'), '1');
  const plain = decodeState('?' + encodeState({ pairs }));
  assert.deepEqual(plain.locks, new Array(BARS).fill(false)); assert.equal(plain.params.get('r'), null);
});

test('malformed links are rejected without throwing', () => {
  for (const bad of ['?d=123', '?d=' + '7'.repeat(32), '?d=' + '1'.repeat(31) + 'x', '?d=' + '3'.repeat(33), '?d=' + '2'.repeat(32) + '&l=zz', '?d=' + '2'.repeat(32) + '&l=12345', '?d=%E0%A4%A']) {
    const r = decodeState(bad);
    assert.ok(r.error, `expected error for ${bad}`);
  }
  assert.ok(decodeState('').empty); assert.ok(decodeState('?x=1').empty);
});

// ---------- audio ----------
const SR = 44100;
const buffers = new Map();
test('every measure renders deterministically at 44.1 kHz without clipping or NaN', () => {
  let peak = 0;
  for (let id = 1; id <= MEASURE_COUNT; id++) {
    for (const e of hasEndings(id) ? ['first', 'second'] : ['second']) {
      const b = renderMeasure(id, SR, e);
      assert.equal(b.length, measureSamples(SR));
      for (let i = 0; i < b.length; i++) { assert.ok(!Number.isNaN(b[i])); const a = Math.abs(b[i]); if (a > peak) peak = a; }
      buffers.set(bufferKey(id, e), b);
    }
  }
  assert.ok(peak < 0.95 && peak > 0.6, `peak ${peak}`);
  const again = renderMeasure(17, SR);
  assert.deepEqual(Array.from(again.subarray(0, 4000)), Array.from(buffers.get('17').subarray(0, 4000)));
  // rendering at 48 kHz works too and is the same length in time
  assert.equal(renderMeasure(17, 48000).length, measureSamples(48000));
});

test('ornaments are realised from the written note (trill on the upper neighbour, turn around the note)', () => {
  const ev4 = realize(notesOf(4)).filter((e) => e.t >= 0.5 * BAR_SECONDS / 1.5 - 1e-9);
  const trill = realize(notesOf(4)).filter((e) => e.midi === 76 || e.midi === 74);
  assert.ok(trill.length >= 8, 'trill split into alternating notes');
  const turn = realize(notesOf(80)).filter((e) => [71, 69, 67].includes(e.midi));
  assert.deepEqual(turn.map((e) => e.midi), [71, 69, 67, 69]);
  assert.ok(ev4.length);
});

test('playback plan: 16 bars straight through with the second ending; 24 bars with the printed repeat', () => {
  const ids = optionsFor(0).concat(optionsFor(1)).slice(0, 16);
  ids[7] = optionsFor(7)[0];
  const p = playbackPlan(ids, false);
  assert.deepEqual(p.map((s) => s.bar), [...Array(16).keys()]);
  assert.ok(p.every((s) => s.ending === 'second'));
  assert.ok(p.every((s, k) => s.key === bufferKey(s.measureId, s.ending) && Math.abs(s.at - k * BAR_SECONDS) < 1e-9 && s.dur === BAR_SECONDS));
  const r = playbackPlan(ids, true);
  assert.equal(r.length, 24);
  assert.deepEqual(r.map((s) => s.bar), [...Array(8).keys(), ...Array(8).keys(), ...[...Array(8).keys()].map((b) => b + 8)]);
  assert.equal(r[7].ending, 'first'); assert.equal(r[15].ending, 'second');
});

test('mixdown lays the buffers exactly one bar apart, tails overlapping; WAV round-trips the samples', () => {
  const ids = [32, 157, 163, 103, 154, 129, 118, 100, 120, 88, 19, 29, 51, 58, 1, 93];
  const plan = playbackPlan(ids, false);
  const mix = mixdown(plan, buffers, SR);
  const start = (k) => Math.round(k * BAR_SECONDS * SR);
  assert.equal(mix.length, start(15) + measureSamples(SR));
  // sample inside bar 5 equals the sum of bar 5's buffer and bar 4's tail
  const k = 4, i = 100;
  const expected = buffers.get('154')[i] + buffers.get('103')[start(4) - start(3) + i];
  assert.ok(Math.abs(mix[start(k) + i] - expected) < 1e-6);
  const dec = decodeWav(encodeWav(mix, SR));
  assert.equal(dec.sampleRate, SR); assert.equal(dec.channels, 1); assert.equal(dec.bits, 16); assert.equal(dec.samples.length, mix.length);
  assert.ok(Math.abs(dec.samples[start(k) + i] / 32767 - mix[start(k) + i]) < 1e-4);
  const seconds = mix.length / SR;
  assert.ok(seconds > 24 && seconds < 26, `length ${seconds}s`);
});

// ---------- notation ----------
function abcUnits(voice) {
  // total length in 32nds of one ABC voice line (L:1/16), ignoring ornaments
  let total = 0;
  const re = /(\[[^\]]*\]|[\^=]?[A-Ga-gz][,']*)(\d+(?:\/\d+)?|\/)?/g;
  const body = voice.replace(/![a-z]+!/g, '');
  let m;
  while ((m = re.exec(body))) {
    const l = m[2];
    total += l === undefined ? 2 : l === '/' ? 1 : l.includes('/') ? 2 * Number(l.split('/')[0]) / Number(l.split('/')[1]) : 2 * Number(l);
  }
  return total;
}
test('notation: every measure and both endings fill exactly one 3/8 bar in each voice', () => {
  for (let id = 1; id <= MEASURE_COUNT; id++) {
    const m = MEASURES[id];
    for (const variant of m.notes ? [m.notes] : [m.first, m.second]) {
      for (const staff of [0, 1]) assert.equal(abcUnits(voiceToAbc(variant, staff)), UNITS_PER_BAR, `measure ${id} staff ${staff}: ${voiceToAbc(variant, staff)}`);
    }
  }
});
test('notation: known measures spell as expected, accidentals per ABC bar rules', () => {
  assert.equal(voiceToAbc(MEASURES[1].notes, 1), 'f2d2g2'); assert.equal(voiceToAbc(MEASURES[1].notes, 0), 'F,2D,2G,2');
  assert.equal(voiceToAbc(MEASURES[2].notes, 1), 'A2^FGBg');
  assert.equal(voiceToAbc(MEASURES[138].notes, 0), 'D,,D,^C,D,=C,D,');     // C natural, as printed
  assert.equal(voiceToAbc(MEASURES[4].notes, 1), 'g2!trill!d4');
  assert.equal(voiceToAbc(MEASURES[5].first, 0), 'G,,2G,F,E,D,'); assert.equal(voiceToAbc(MEASURES[5].second, 0), 'G,,2B,G,^F,E,');
  assert.equal(voiceToAbc(MEASURES[2].notes, 0), '[G,B,,]4z2');
  assert.deepEqual(pitchName(60), { name: 'C', letter: 'C4', sharp: false });
  assert.deepEqual(pitchName(84).name, "c'"); assert.deepEqual(pitchName(36).name, 'C,,');
});
test('notation: the tune has two staves, the volta over bar 8, and maps plan steps to engraved measures', () => {
  const ids = [32, 157, 163, 103, 154, 129, 118, 100, 120, 88, 19, 29, 51, 58, 1, 93];
  const abc = minuetToAbc(ids);
  assert.ok(abc.includes('%%score {1 2}') && abc.includes('V:1 clef=treble') && abc.includes('V:2 clef=bass'));
  assert.equal((abc.match(/\[V:1\]/g) || []).length, 2); assert.equal((abc.match(/\[V:2\]/g) || []).length, 2);
  assert.equal((abc.match(/\[1 /g) || []).length, 2); assert.equal((abc.match(/:\|\[2 /g) || []).length, 2);
  const plan = playbackPlan(ids, true);
  assert.deepEqual(plan.map(scoreMeasureIndex), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(playbackPlan(ids, false).map(scoreMeasureIndex), [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.throws(() => minuetToAbc([1, 2, 3]), RangeError);
});

// ---------- cache busting ----------
test('every module import and asset URL carries the ?v= stamp the deploy rewrites', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('importmap'), 'no import map: the scheme must not depend on one');
  assert.ok(/src="js\/app\.js\?v=dev"/.test(html) && /href="style\.css\?v=dev"/.test(html) && /abcjs-basic-min\.js\?v=dev/.test(html));
  assert.ok(/^  const BUILD = 'dev';$/m.test(html), 'BUILD constant at the indentation the deploy stamp expects');
  const chorale = fs.readFileSync(new URL('../chorale/index.html', import.meta.url), 'utf8');
  assert.ok(/src="\.\.\/js\/chorale-app\.js\?v=dev"/.test(chorale) && /href="\.\.\/style\.css\?v=dev"/.test(chorale) && /abcjs-basic-min\.js\?v=dev/.test(chorale));
  assert.ok(/^  const BUILD = 'dev';$/m.test(chorale));
  const deploy = fs.readFileSync(new URL('../bin/dicemusic', import.meta.url), 'utf8');
  assert.ok(deploy.includes('index.html chorale/index.html js/*.js'), 'deploy stamps the chorale page too');
  assert.ok(deploy.includes('ensure_chorale_vhost') && deploy.includes('location = /chorale/index.html'), 'deploy brings the installed vhost up to date');
  const vhost = fs.readFileSync(new URL('../deploy/nginx.conf.template', import.meta.url), 'utf8');
  assert.ok(/location = \/chorale\/index\.html \{[^}]*no-cache/.test(vhost), 'template serves the chorale entry page no-cache');
  const dir = new URL('../js/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) assert.ok(m[1].endsWith('.js?v=dev'), `${f}: ${m[1]}`);
  }
});

// ---------- chorale ----------
const seeded = (seed) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const rollPairsWith = (rng) => Array.from({ length: BARS }, () => [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)]);

test('chorale table: 16 columns of 11 known chords; cadences fixed; each column one function', () => {
  const fnOf = (sym) => CHORDS[sym].fn;
  for (let p = 1; p <= 16; p++) {
    const col = CHORALE_TABLE[p];
    assert.equal(col.length, 11, `column ${p}`);
    for (const sym of col) assert.ok(CHORDS[sym], `${p}: ${sym}`);
  }
  assert.ok(CHORALE_TABLE[8].every((s) => s === 'V'));
  assert.ok(CHORALE_TABLE[16].every((s) => s === 'I'));
  assert.ok(CHORALE_TABLE[15].every((s) => s === 'V' || s === 'V7'));
  for (const p of [1, 3, 5, 9, 11, 13]) assert.ok(CHORALE_TABLE[p].every((s) => ['tonic', 'tonic substitute'].includes(fnOf(s))), `column ${p} is tonic-function`);
  for (const p of [6, 14]) assert.ok(CHORALE_TABLE[p].every((s) => fnOf(s).includes('predominant')), `column ${p} is predominant`);
  assert.equal(chordFor(0, 7), 'I'); assert.equal(chordFor(14, 7), 'V7'); assert.equal(chordFor(6, 2), 'V7ofV');
  // chords with a tendency tone sit only where the next column is certain to hold its resolution
  const hasDeg = (sym, deg) => CHORDS[sym].tones.some((t) => t[0] === deg && t[1] === 0);
  for (let p = 1; p <= 15; p++) for (const sym of CHORALE_TABLE[p]) {
    const c = CHORDS[sym];
    const next = CHORALE_TABLE[p + 1];
    if (c.tones.length === 4) { const sev = c.tones[3][0]; const down = sev === 1 ? 7 : sev - 1; assert.ok(next.every((n) => hasDeg(n, down)), `${p}: ${sym} seventh must be able to fall`); }
    for (const [deg, alt] of c.tones) if (alt !== 0) assert.ok(next.every((n) => hasDeg(n, 5)), `${p}: ${sym} chromatic tone must resolve to 5`);
    if (['V', 'V6', 'V7', 'V65', 'V43', 'viio6'].includes(sym)) assert.ok(next.every((n) => hasDeg(n, 1)), `${p}: ${sym} leading tone must be able to rise`);
    if (['V6', 'V65'].includes(sym)) assert.ok(next.every((n) => CHORDS[n].bass === 1 || n === 'vi'), `${p}: ${sym} bass leading tone needs a root-position tonic (or vi) next`);
  }
  assert.throws(() => chordFor(16, 7), RangeError); assert.throws(() => chordFor(0, 13), RangeError);
});

test('chorale voicing: 700 random rolls in seven keys break no rule and are deterministic', () => {
  const rng = seeded(4242);
  let worstCost = 0;
  for (const key of KEY_NAMES) {
    for (let n = 0; n < 100; n++) {
      const syms = Array.from({ length: 16 }, (_, p) => chordFor(p, 2 + Math.floor(rng() * 6) + Math.floor(rng() * 6)));
      const a = voiceLead(syms, key);
      const v = violations(a.voicings, a.chords, key);
      assert.deepEqual(v, [], `${key} ${syms.join(' ')}`);
      const b = voiceLead(syms, key);
      assert.deepEqual(b.voicings, a.voicings, 'deterministic');
      worstCost = Math.max(worstCost, a.cost);
      // the leading tone in the soprano at the final cadence rises to the tonic
      const s15 = a.voicings[14][3], s16 = a.voicings[15][3];
      if ((s15 - (a.chords[15].root.pc)) % 12 === 11) assert.equal(s16 - s15, 1);
      // every seventh falls by step (the checker above enforces it too; this is the direct statement)
      a.chords.forEach((c, k) => { if (c.seventh && k < 15) for (let i = 0; i < 4; i++) if (a.voicings[k][i] % 12 === c.seventh.pc) assert.ok([-1, -2].includes(a.voicings[k + 1][i] - a.voicings[k][i]), `${key} ${syms.join(' ')} seventh at ${k}`); });
    }
  }
  assert.ok(worstCost < 400, `worst path cost ${worstCost}`);
});

test('chorale: compose, plan timing with fermatas and breath, sustained render level', () => {
  const rng = seeded(7);
  let peak = 0;
  for (let n = 0; n < 12; n++) {
    const key = KEY_NAMES[n % KEY_NAMES.length];
    const bars = composeChorale(rollPairsWith(rng), { key });
    assert.equal(bars.length, 16);
    const steps = choralePlan(bars);
    assert.equal(steps.length, 16);
    assert.equal(steps[0].at, 0);
    assert.ok(Math.abs(steps[7].dur - CHORD_SECONDS * FERMATA_FACTOR) < 1e-9 && Math.abs(steps[15].dur - CHORD_SECONDS * FERMATA_FACTOR) < 1e-9);
    assert.ok(Math.abs(steps[8].at - (steps[7].at + steps[7].dur + BREATH_SECONDS)) < 1e-9, 'a breath after the half cadence');
    for (let k = 1; k < 16; k++) if (k !== 8) assert.ok(Math.abs(steps[k].at - (steps[k - 1].at + steps[k - 1].dur)) < 1e-9);
    assert.equal(new Set(steps.map((s) => s.key)).size, 16);
    for (const k of [0, 7, 15]) {
      const buf = renderChoraleStep(steps[k], 44100);
      assert.equal(buf.length, Math.round((steps[k].dur + 0.3) * 44100));
      for (let i = 0; i < buf.length; i++) { assert.ok(!Number.isNaN(buf[i])); peak = Math.max(peak, Math.abs(buf[i])); }
    }
  }
  assert.ok(peak < 0.95 && peak > 0.3, `peak ${peak}`);
});

test('chorale notation: four voices, key signatures, correct spelling of chromatic tones', () => {
  const rng = seeded(99);
  for (const key of KEY_NAMES) {
    const bars = composeChorale(rollPairsWith(rng), { key });
    const abc = choraleToAbc(bars, key);
    assert.ok(abc.includes(`K:${key}\n`) && abc.includes('%%score {(S A) (T B)}'));
    for (const v of ['S', 'A', 'T', 'B']) {
      const lines = abc.split('\n').filter((l) => l.startsWith(`[V:${v}]`));
      assert.equal(lines.length, 2, `${key} voice ${v} has two lines`);
      const notes = lines.join(' ').match(/[\^_=]*[A-Ga-g][,']*2/g) || [];
      assert.equal(notes.length, 16, `${key} voice ${v}: ${lines.join(' ')}`);
    }
    assert.equal((abc.match(/!fermata!/g) || []).length, 8);
  }
  // spelling: in F major the raised fourth of V/V is B natural, in D major the lowered sixth of iv is B flat
  assert.equal(keyAccidental('F', 'B'), -1); assert.equal(degreeLetter('F', 4), 'B');
  const f = composeChorale(Array.from({ length: 16 }, (_, i) => (i === 6 ? [1, 1] : [3, 4])), { key: 'F' });   // position 7, total 2 -> V7/V
  assert.equal(f[6].symbol, 'V7ofV');
  const abcF = choraleToAbc(f, 'F');
  assert.ok(/=[Bb]/.test(abcF), `B natural written in F major: ${abcF}`);
  const d = composeChorale(Array.from({ length: 16 }, (_, i) => (i === 6 ? [1, 2] : [3, 4])), { key: 'D' });   // position 7, total 3 -> iv
  assert.equal(d[5].symbol, 'iv');
  assert.ok(/_[Bb]/.test(choraleToAbc(d, 'D')), 'B flat written in D major');
  assert.deepEqual(choralePlan(f).map(choraleScoreIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
});

// ---------- run ----------
let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log('ok   ', t.name); }
  catch (e) { failed++; console.log('FAIL ', t.name, '\n      ', e.message.split('\n')[0]); }
}
console.log(failed ? `${failed} failed` : `${tests.length} passed`);
process.exit(failed ? 1 : 0);
