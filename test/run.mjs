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
import { compose as composeChorale, plan as choralePlan, render as renderChoraleStep, renderStep, choraleToAbc, scoreIndex as choraleScoreIndex, chordSeconds, FERMATA_FACTOR, BREATH_SECONDS, preludePlan, renderPrelude, preludeToAbc, preludeEighth, choraleGame, TEXTURES, MOTIONS, TEMPO, INSTRUMENT_CHOICES, resolveInstrument } from '../js/chorale.js';
import { diatonic, KINDS, MAX_MOVING, UNITS, statesOf } from '../js/chorale-motion.js';
import { RANGES } from '../js/chorale-voicing.js';
import { INSTRUMENTS, INSTRUMENT_NAMES, tailSeconds } from '../js/synth.js';
const CHORD_SECONDS = chordSeconds(72);

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
    assert.deepEqual(steps.map(choraleScoreIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
    assert.ok(steps.every((s) => s.texture === 'chorale' && s.instrument === 'choir' && s.tempo === 72));
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
    const plainAbc = choraleToAbc(composeChorale(bars.map((b) => b.dice), { key, motion: 'plain' }), key);
    for (const v of ['S', 'A', 'T', 'B']) {
      const lines = abc.split('\n').filter((l) => l.startsWith(`[V:${v}]`));
      assert.equal(lines.length, 2, `${key} voice ${v} has two lines`);
      const tokens = lines.map((l) => l.replace(/^\[V:[A-Z]\]\s*/, '').replace(/!fermata!/g, '')).join(' ').match(/[\^_=]*[A-Ga-g][,']*[24]?/g) || [];
      assert.equal(tokens.reduce((n, t) => n + (t.endsWith('4') ? 4 : t.endsWith('2') ? 2 : 1), 0), 64, `${key} voice ${v} fills sixteen minims: ${lines.join(' ')}`);
      const plainNotes = plainAbc.split('\n').filter((l) => l.startsWith(`[V:${v}]`)).join(' ').match(/[\^_=]*[A-Ga-g][,']*4/g) || [];
      assert.equal(plainNotes.length, 16, `${key} voice ${v} plain: sixteen minims`);
    }
    assert.ok(abc.includes('L:1/8') && abc.includes('Q:1/4=72'));
    assert.equal((abc.match(/!fermata!/g) || []).length, 8);
    assert.ok(/[A-Ga-g][,']*2 [\^_=]*[A-Ga-g][,']*2[ |]/.test(abc.replace(/^\[V:[A-Z]\] /gm, '')), `${key}: some voice moves in crotchets`);
    const lively = choraleToAbc(composeChorale(bars.map((b) => b.dice), { key, motion: 'lively' }), key, 96);
    assert.ok(lively.includes('Q:1/4=96'));
    assert.ok(/[A-Ga-g][,']*2 [\^_=]*[A-Ga-g][,']*[\^_=]*[A-Ga-g][,']*[ |]/.test(lively.replace(/^\[V:[A-Z]\] /gm, '')), `${key}: lively writes beamed quavers`);
  }
  // spelling: in F major the raised fourth of V/V is B natural, in D major the lowered sixth of iv is B flat
  assert.equal(keyAccidental('F', 'B'), -1); assert.equal(degreeLetter('F', 4), 'B');
  const f = composeChorale(Array.from({ length: 16 }, (_, i) => (i === 6 ? [1, 1] : [3, 4])), { key: 'F' });   // position 7, total 2 -> V7/V
  assert.equal(f[6].symbol, 'V7ofV');
  const abcF = choraleToAbc(f, 'F');
  assert.ok(/=[Bb]/.test(abcF), `B natural written in F major: ${abcF}`);
  const d = composeChorale(Array.from({ length: 16 }, (_, i) => (i === 6 ? [1, 2] : [3, 4])), { key: 'D' });   // position 7, total 3 -> iv
  assert.equal(d[6].symbol, 'iv');
  assert.ok(/_[Bb]/.test(choraleToAbc(d, 'D')), 'B flat written in D major');
  assert.deepEqual(choralePlan(f).map(choraleScoreIndex), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7]);
});

const isPerfectIv = (iv) => { const m = ((iv % 12) + 12) % 12; return m === 0 || m === 7; };
const parallels = (p, c) => {
  const out = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    if (p[i] === c[i] || p[j] === c[j]) continue;
    const iv1 = p[j] - p[i], iv2 = c[j] - c[i];
    if (isPerfectIv(iv1) && isPerfectIv(iv2) && ((iv1 % 12) + 12) % 12 === ((iv2 % 12) + 12) % 12) out.push(`${i}-${j}`);
  }
  return out;
};

test('chorale motion: over 700 rolls at each level every added note is a lawful passing, skipped, neighbour, run or turn note', () => {
  const NAMES = ['B', 'T', 'A', 'S'];
  const inside = (m, a, b) => (m - a) * (b - a) > 0 && (b - m) * (b - a) > 0;
  for (const level of ['passing', 'lively']) {
    const rng = seeded(31337);
    let elaborated = 0, total = 0, quavers = 0, consecutive = 0;
    const seen = {};
    for (const key of KEY_NAMES) {
      for (let n = 0; n < 100; n++) {
        const pairs = rollPairsWith(rng);
        const plain = composeChorale(pairs, { key, motion: 'plain' });
        const bars = composeChorale(pairs, { key, motion: level });
        assert.deepEqual(bars.map((b) => b.voicing), plain.map((b) => b.voicing), 'the skeleton is untouched');
        assert.ok(plain.every((b) => !b.moving && b.kinds === null && b.lines.every((l, v) => l.length === 1 && l[0][0] === b.voicing[v] && l[0][1] === UNITS)));
        assert.deepEqual(composeChorale(pairs, { key, motion: level }).map((b) => b.lines), bars.map((b) => b.lines), 'deterministic');
        const tag = `${level} ${key} ${bars.map((b) => b.symbol).join(' ')}`;
        bars.forEach((b, k) => {
          total++;
          assert.ok(b.lines.every((l) => l.reduce((s, [, u]) => s + u, 0) === UNITS), `${tag}: ${k} a line does not fill the chord`);
          assert.ok(b.lines.every((l, v) => l[0][0] === b.voicing[v] && l[0][1] >= 2), `${tag}: ${k} the skeleton note is not on the first half`);
          if (!b.moving) { assert.equal(b.kinds, null); assert.ok(b.lines.every((l) => l.length === 1)); return; }
          elaborated++;
          assert.ok(k !== 7 && k !== 15, `${tag}: held chord ${k} elaborated`);
          const cur = b.voicing, nxt = bars[k + 1].voicing;
          const chromatic = b.realized.tones.some((t) => t.alt !== 0);
          let moved = 0;
          b.lines.forEach((line, v) => {
            const kind = b.kinds[v];
            if (line.length === 1) { assert.equal(kind, null); return; }
            moved++;
            seen[kind] = (seen[kind] || 0) + 1;
            assert.ok(KINDS.includes(kind), `${tag}: ${k} ${NAMES[v]} kind ${kind}`);
            const added = line.slice(1).map(([m]) => m);
            for (const m of added) assert.ok(m >= RANGES[NAMES[v]][0] && m <= RANGES[NAMES[v]][1], `${tag}: ${k} ${NAMES[v]} out of range`);
            if (line.slice(1).some(([, u]) => u === 1)) quavers++;
            if (kind === 'passing') {
              assert.ok(!chromatic && line.length === 2 && line[1][1] === 2);
              assert.ok([3, 4].includes(Math.abs(nxt[v] - cur[v])) && Math.abs(added[0] - cur[v]) <= 2 && Math.abs(nxt[v] - added[0]) <= 2 && diatonic(added[0], key), `${tag}: ${k} ${NAMES[v]} passing ${cur[v]}-${added[0]}-${nxt[v]}`);
            } else if (kind === 'skip') {
              assert.ok(line.length === 2 && Math.abs(nxt[v] - cur[v]) >= 5 && inside(added[0], cur[v], nxt[v]), `${tag}: ${k} ${NAMES[v]} skip ${cur[v]}-${added[0]}-${nxt[v]}`);
              const tone = b.realized.toneOf(added[0] % 12);
              assert.ok(tone && tone.alt === 0, `${tag}: ${k} ${NAMES[v]} skip to a non-chord or chromatic tone`);
              if (b.realized.seventh) assert.notEqual(added[0] % 12, b.realized.seventh.pc, `${tag}: ${k} skip onto the seventh`);
            } else if (kind === 'run') {
              assert.equal(level, 'lively');
              assert.ok(!chromatic && line.length === 3 && line[1][1] === 1 && line[2][1] === 1);
              assert.ok([5, 7].includes(Math.abs(nxt[v] - cur[v])) && inside(added[0], cur[v], nxt[v]) && inside(added[1], cur[v], nxt[v]), `${tag}: ${k} ${NAMES[v]} run ${cur[v]}-${added.join('-')}-${nxt[v]}`);
              assert.ok(diatonic(added[0], key) && diatonic(added[1], key) && Math.abs(added[1] - added[0]) <= 2 && Math.abs(nxt[v] - added[1]) <= 2, `${tag}: ${k} ${NAMES[v]} run is not stepwise into the goal`);
              const tone = b.realized.toneOf(added[0] % 12);
              assert.ok(Math.abs(added[0] - cur[v]) <= 2 || (tone && tone.alt === 0), `${tag}: ${k} ${NAMES[v]} run starts with a leap to a non-chord tone`);
            } else if (kind === 'turn') {
              assert.equal(level, 'lively'); assert.equal(v, 3);
              assert.ok(!chromatic && nxt[v] === cur[v] && line.length === 3 && added.every((m) => Math.abs(m - cur[v]) <= 2 && diatonic(m, key)) && Math.sign(added[0] - cur[v]) === -Math.sign(added[1] - cur[v]), `${tag}: ${k} turn ${cur[v]}-${added.join('-')}`);
            } else {
              assert.ok(!chromatic && nxt[v] === cur[v] && Math.abs(added[0] - cur[v]) <= 2 && diatonic(added[0], key), `${tag}: ${k} ${NAMES[v]} neighbour ${cur[v]}-${added.join('-')}`);
              if (v === 3) assert.ok(line.length === 2, 'a soprano neighbour is a crotchet');
              else { assert.equal(level, 'lively'); assert.ok(line.length === 3 && added[1] === cur[v] && line[1][1] === 1, 'an inner neighbour dips and returns in quavers'); }
              if (k > 0 && bars[k - 1].kinds && ['neighbour', 'turn'].includes(bars[k - 1].kinds[v])) consecutive++;
            }
          });
          assert.ok(moved >= 1 && moved <= MAX_MOVING[level], `${tag}: ${k} moves ${moved} voices`);
          // the texture's successive states: no crossing, no unison with an added note, no parallels, through to the next chord
          const states = statesOf(b.lines);
          for (const st of states) for (let i = 0; i < 3; i++) {
            assert.ok(st[i] <= st[i + 1], `${tag}: ${k} voices cross`);
            if (st[i] !== cur[i] || st[i + 1] !== cur[i + 1]) assert.ok(st[i] < st[i + 1], `${tag}: ${k} added note in unison with its neighbour`);
          }
          const chain = [...states, nxt];
          for (let u = 1; u < chain.length; u++) assert.deepEqual(parallels(chain[u - 1], chain[u]), [], `${tag}: ${k} parallels at quaver ${u}`);
        });
      }
    }
    const share = elaborated / total;
    assert.ok(share > 0.2 && share < 0.7, `${level}: elaborated share ${share.toFixed(2)}`);
    assert.equal(consecutive, 0, `${level}: ${consecutive} neighbours on consecutive chords in one voice`);
    if (level === 'passing') { assert.equal(quavers, 0, 'passing level writes no quavers'); assert.ok(seen.passing && seen.skip && seen.neighbour && !seen.run && !seen.turn, JSON.stringify(seen)); }
    else { assert.ok(quavers > 200 && seen.run > 50 && seen.turn > 50 && seen.neighbour > 50, `${level}: ${JSON.stringify(seen)} quavers ${quavers}`); }
  }
  assert.throws(() => composeChorale(Array.from({ length: 16 }, () => [3, 4]), { key: 'C', motion: 'frantic' }), RangeError);
});

test('chorale render with passing notes: a moving voice sings two notes, level stays under 0.95', () => {
  const rng = seeded(8);
  let peak = 0, moving = 0;
  for (let n = 0; n < 6; n++) {
    const key = KEY_NAMES[n % KEY_NAMES.length];
    const bars = composeChorale(rollPairsWith(rng), { key });
    const steps = choralePlan(bars);
    for (const step of steps.filter((s) => s.lines.some((l) => l.length > 1)).slice(0, 2)) {
      moving++;
      const buf = renderChoraleStep(step, 44100);
      assert.equal(buf.length, Math.round((step.dur + 0.3) * 44100));
      for (let i = 0; i < buf.length; i++) { assert.ok(!Number.isNaN(buf[i])); peak = Math.max(peak, Math.abs(buf[i])); }
    }
  }
  assert.ok(moving > 0 && peak < 0.95 && peak > 0.3, `peak ${peak} over ${moving} steps`);
});

test('prelude texture: one 12/8 bar per chord at the tempo, sixteen bars, struck level, grand-staff notation', () => {
  const rng = seeded(21);
  let peak = 0;
  for (let n = 0; n < 8; n++) {
    const key = KEY_NAMES[n % KEY_NAMES.length];
    const pairs = rollPairsWith(rng);
    const bars = composeChorale(pairs, { key, texture: 'prelude', motion: n % 2 ? 'lively' : 'passing' });
    const tempo = n % 2 ? 96 : 72;
    const barSeconds = 12 * preludeEighth(tempo);
    const steps = preludePlan(bars, { tempo, instrument: 'piano' });
    assert.equal(steps.length, 16);
    steps.forEach((s, i) => {
      assert.ok(Math.abs(s.at - i * barSeconds) < 1e-9 && Math.abs(s.dur - barSeconds) < 1e-9);
      assert.equal(choraleScoreIndex(s), i);
      assert.equal(s.cells.length, 2);
      assert.deepEqual(s.cells, [statesOf(bars[i].lines)[0], statesOf(bars[i].lines)[UNITS - 1]], 'the figures take the voices as the chord begins and as it ends');
      assert.equal(Boolean(s.last), i === 15);
      assert.ok(s.texture === 'prelude' && s.instrument === 'piano' && s.tempo === tempo && s.key.endsWith(`:${tempo}:piano`));
    });
    assert.equal(new Set(steps.map((s) => s.key)).size, 16);
    for (const k of [0, 5, 15]) {
      const buf = renderPrelude(steps[k], 44100);
      assert.equal(buf.length, Math.round((steps[k].dur + 0.5) * 44100));
      for (let i = 0; i < buf.length; i++) { assert.ok(!Number.isNaN(buf[i])); peak = Math.max(peak, Math.abs(buf[i])); }
    }
    const plainSteps = preludePlan(composeChorale(pairs, { key, texture: 'prelude', motion: 'plain' }));
    assert.ok(plainSteps.every((s) => s.cells[0].join() === s.cells[1].join()), 'plain: both figures of a bar alike');
    assert.ok(Math.abs(plainSteps[0].dur - 12 * preludeEighth(72)) < 1e-9, 'default tempo 72');
    const abc = preludeToAbc(bars, key, tempo);
    assert.ok(abc.includes('M:12/8') && abc.includes('L:1/8') && abc.includes(`Q:3/8=${tempo}`) && abc.includes('%%score {RH LH}') && abc.includes(`K:${key}\n`));
    for (const v of ['RH', 'LH']) {
      const lines = abc.split('\n').filter((l) => l.startsWith(`[V:${v}]`));
      assert.equal(lines.length, 4, `${key} ${v}: four lines`);
      const body = lines.map((l) => l.replace(/^\[V:[A-Z]+\]\s*/, '')).join(' ');
      assert.equal((body.match(/\|/g) || []).length, 16, `${key} ${v}: sixteen bars`);
      assert.equal((body.match(/[\^_=]*[A-Ga-g][,']*/g) || []).length, 15 * 6 + 4, `${key} ${v}: six notes a bar and a final chord`);
    }
    assert.ok(/\[[^\]]+\]6-\[[^\]]+\]6 \|\]/.test(abc), 'the last chord is held across the bar');
  }
  assert.ok(peak < 0.95 && peak > 0.3, `peak ${peak}`);
});

test('instruments: five voices, every one renders both textures with a peak between 0.3 and 0.95', () => {
  assert.deepEqual(INSTRUMENT_NAMES, ['piano', 'harp', 'choir', 'organ', 'strings']);
  assert.deepEqual(INSTRUMENT_CHOICES, ['auto', ...INSTRUMENT_NAMES]);
  assert.equal(resolveInstrument({ texture: 'chorale', instrument: 'auto' }), 'choir');
  assert.equal(resolveInstrument({ texture: 'prelude', instrument: 'auto' }), 'piano');
  assert.equal(resolveInstrument({ texture: 'prelude', instrument: 'organ' }), 'organ');
  const rng = seeded(5);
  const sets = Array.from({ length: 3 }, (_, n) => composeChorale(rollPairsWith(rng), { key: KEY_NAMES[n], motion: 'lively' }));
  for (const instrument of INSTRUMENT_NAMES) {
    for (const texture of ['chorale', 'prelude']) {
      let peak = 0;
      for (const set of sets) {
        const steps = texture === 'prelude' ? preludePlan(set, { tempo: 72, instrument }) : choralePlan(set, { tempo: 72, instrument });
        for (const step of [steps[0], steps[6], steps[14], steps[15]]) {
          const buf = renderStep(step, 22050);
          assert.equal(buf.length, Math.round((step.dur + tailSeconds(instrument)) * 22050));
          for (let i = 0; i < buf.length; i++) { assert.ok(!Number.isNaN(buf[i])); peak = Math.max(peak, Math.abs(buf[i])); }
        }
      }
      assert.ok(peak < 0.95 && peak > 0.3, `${instrument} ${texture}: peak ${peak.toFixed(3)}`);
    }
  }
  assert.ok(INSTRUMENTS.piano.gain === 0.41, 'the minuet keeps its level');
});

test('chorale settings: the link carries key, texture, motion, tempo and instrument and rejects unknown values', () => {
  const dflt = choraleGame.defaultSettings();
  assert.deepEqual(dflt, { key: 'C', texture: 'chorale', motion: 'passing', tempo: 72, instrument: 'auto' });
  assert.deepEqual(TEMPO, { min: 48, max: 132, step: 4, default: 72 });
  assert.ok(Object.values(choraleGame.encodeSettings(dflt)).every((v) => v === undefined), 'defaults add nothing to the link');
  const s1 = { key: 'G', texture: 'prelude', motion: 'lively', tempo: 100, instrument: 'harp' };
  assert.deepEqual(choraleGame.encodeSettings(s1), { k: 'G', t: 'prelude', m: 'lively', q: 100, i: 'harp' });
  const pairs = Array.from({ length: 16 }, () => [3, 4]);
  const q = encodeState({ pairs, locks: [], extra: choraleGame.encodeSettings(s1) });
  assert.ok(q.includes('k=G') && q.includes('t=prelude') && q.includes('m=lively') && q.includes('q=100') && q.includes('i=harp'));
  const back = {};
  assert.equal(choraleGame.decodeSettings(new URLSearchParams(q), back), null);
  assert.deepEqual(back, s1);
  const empty = {};
  assert.equal(choraleGame.decodeSettings(new URLSearchParams(''), empty), null);
  assert.deepEqual(empty, dflt);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('t=waltz'), {}), /texture/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('m=fast'), {}), /motion/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('k=H'), {}), /key/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('q=300'), {}), /tempo/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('q=7'), {}), /tempo/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('q=abc'), {}), /tempo/);
  assert.match(choraleGame.decodeSettings(new URLSearchParams('q=49'), {}), /tempo/, 'a tempo off the slider step is refused');
  assert.match(choraleGame.decodeSettings(new URLSearchParams('q=130'), {}), /tempo/);
  for (const ok of [48, 52, 100, 132]) { const t = {}; assert.equal(choraleGame.decodeSettings(new URLSearchParams(`q=${ok}`), t), null); assert.equal(t.tempo, ok); }
  assert.match(choraleGame.decodeSettings(new URLSearchParams('i=kazoo'), {}), /instrument/);
  assert.deepEqual([TEXTURES, MOTIONS], [['chorale', 'prelude'], ['plain', 'passing', 'lively']]);
  // the renderer follows the step, not the settings at render time: a queued step of another
  // texture or instrument must still produce its own sound under its own key
  const bars = composeChorale(pairs, { key: 'C' });
  const choraleStep = choralePlan(bars, { tempo: 72, instrument: 'choir' })[0], preludeStep = preludePlan(bars, { tempo: 72, instrument: 'piano' })[0];
  const organStep = choralePlan(bars, { tempo: 60, instrument: 'organ' })[0];
  assert.equal(choraleStep.texture, 'chorale'); assert.equal(preludeStep.texture, 'prelude');
  assert.equal(choraleGame.render(choraleStep, 8000).length, Math.round((choraleStep.dur + 0.3) * 8000));
  assert.equal(choraleGame.render(preludeStep, 8000).length, Math.round((preludeStep.dur + 0.5) * 8000));
  assert.ok(Math.abs(organStep.dur - 2) < 1e-9 && organStep.key !== choraleStep.key, 'tempo and instrument are in the key');
  assert.equal(new Set([choraleStep.key, preludeStep.key, organStep.key]).size, 3);
  // the game's own plan hook threads tempo and instrument through
  const state = { bars, settings: { ...dflt, tempo: 120, instrument: 'strings' }, pairs, plan: [] };
  state.plan = choraleGame.plan(state);
  assert.ok(state.plan.every((s) => s.instrument === 'strings' && s.tempo === 120) && Math.abs(state.plan[0].dur - 1) < 1e-9);
  assert.match(choraleGame.summary(state), /strings at 120/);
  assert.ok(choraleGame.fileStem(state).startsWith('chorale-dice-C-3434'));
});

// ---------- run ----------
let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log('ok   ', t.name); }
  catch (e) { failed++; console.log('FAIL ', t.name, '\n      ', e.message.split('\n')[0]); }
}
console.log(failed ? `${failed} failed` : `${tests.length} passed`);
process.exit(failed ? 1 : 0);
