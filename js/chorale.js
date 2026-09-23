// The chorale dice game as a game config for the shared page controller: dice choose a
// harmony at each of sixteen positions, the voice-leading engine writes the four parts,
// the same notes are played (sustained voices) and engraved (two staves, four voices).
import { BARS } from './table.js?v=dev';
import { barFromDice } from './dice.js?v=dev';
import { KEYS, KEY_NAMES, CHORDS, chordFor, keyAccidental, degreeLetter } from './chorale-harmony.js?v=dev';
import { voiceLead } from './chorale-voicing.js?v=dev';
import { renderChord } from './synth.js?v=dev';

export const QUARTER_SECONDS = 60 / 72;
export const CHORD_SECONDS = 2 * QUARTER_SECONDS;      // one chord per half note
export const FERMATA_FACTOR = 1.6;                       // positions 8 and 16 are held
export const BREATH_SECONDS = 0.35;                      // a breath after the half cadence
const VOICE_VEL = [0.9, 0.78, 0.78, 0.95];               // bass, tenor, alto, soprano

/** Sixteen dice pairs → bars with their chord symbols; the voicing is done once for the whole set. */
export function compose(pairs, settings) {
  const key = settings.key;
  const bars = pairs.map((p, i) => {
    const b = barFromDice(i, p);
    const symbol = chordFor(i, b.sum);
    return { bar: i, dice: b.dice, sum: b.sum, symbol, chord: CHORDS[symbol] };
  });
  const { voicings, chords } = voiceLead(bars.map((b) => b.symbol), key);
  bars.forEach((b, i) => { b.voicing = voicings[i]; b.realized = chords[i]; });
  return bars;
}

/** Playback plan: one step per chord, fermatas held longer, a breath after position 8. */
export function plan(bars) {
  const steps = [];
  let at = 0;
  bars.forEach((b, i) => {
    const fermata = i === 7 || i === 15;
    const dur = CHORD_SECONDS * (fermata ? FERMATA_FACTOR : 1);
    steps.push({ bar: i, key: `${i}:${b.voicing.join('.')}:${dur.toFixed(3)}`, at, dur, voicing: b.voicing, fermata });
    at += dur + (i === 7 ? BREATH_SECONDS : 0);
  });
  return steps;
}

export function render(step, sampleRate) {
  return renderChord(step.voicing.map((midi, i) => ({ midi, vel: VOICE_VEL[i] })), step.dur, sampleRate);
}

// ---------- notation ----------
const ACC = { '-2': '__', '-1': '_', 0: '=', 1: '^', 2: '^^' };

/** Spell one voice's note as ABC given its chord tone (degree, alteration) and the key. */
function spell(midi, tone, keyName, state) {
  const letter = degreeLetter(keyName, tone.deg);
  const total = keyAccidental(keyName, letter) + tone.alt;           // the note's actual accidental
  const natural = midi - total;                                       // the unaltered letter's pitch
  const octave = Math.floor(natural / 12) - 1;
  let name = octave >= 5 ? letter.toLowerCase() : letter;
  if (octave >= 6) name += "'".repeat(octave - 5);
  if (octave <= 3) name += ','.repeat(4 - octave);
  const slot = `${letter}${octave}`;
  const current = state.has(slot) ? state.get(slot) : keyAccidental(keyName, letter);
  let acc = '';
  if (total !== current) { acc = ACC[total]; state.set(slot, total); }
  return acc + name;
}

/** The chorale as an ABC tune: four voices on two staves, eight bars in two lines. */
export function choraleToAbc(bars, keyName) {
  const voices = ['S', 'A', 'T', 'B'];
  const index = { S: 3, A: 2, T: 1, B: 0 };
  const lines = [];
  for (const v of voices) {
    let line = `[V:${v}] `;
    let state = new Map();
    bars.forEach((b, i) => {
      if (i % 2 === 0) state = new Map();                              // accidentals reset at the bar line
      const midi = b.voicing[index[v]];
      const tone = b.realized.toneOf(midi % 12);
      const fermata = i === 7 || i === 15 ? '!fermata!' : '';
      line += fermata + spell(midi, tone, keyName, state) + '2';
      line += i % 2 === 1 ? (i === 15 ? ' |]' : i === 7 ? ' ||' : ' | ') : ' ';
      if (i === 7) line += `\n[V:${v}] `;
    });
    lines.push(line);
  }
  // interleave: first line of every voice, then second line of every voice
  const firsts = lines.map((l) => l.split('\n')[0]);
  const seconds = lines.map((l) => l.split('\n')[1]);
  return [
    'X:1', 'T:', 'M:4/4', 'L:1/4', `Q:1/4=${Math.round(60 / QUARTER_SECONDS)}`,
    '%%score {(S A) (T B)}',
    'V:S clef=treble stem=up', 'V:A clef=treble stem=down', 'V:T clef=bass stem=up', 'V:B clef=bass stem=down',
    `K:${keyName}`,
    ...firsts, ...seconds,
  ].join('\n') + '\n';
}

export const scoreIndex = (step) => Math.floor(step.bar / 2);

const $ = (sel) => document.querySelector(sel);
const romanText = (b) => `${b.chord.label}, ${b.chord.fn}`;

export const choraleGame = {
  noun: 'chord',
  pieceNoun: 'chorale',
  shareTitle: 'A four-part chorale from the dice',
  settingsNote: 'the key',
  wideWidth: 700,
  measuresPerLine: (width) => (width >= 520 ? 4 : 2),
  defaultSettings: () => ({ key: 'C' }),
  compose,
  cardHtml: (b) => `<span class="measure"><b class="roman">${b.chord.html}</b></span><span class="fn">${b.chord.fn}</span>`,
  cardText: romanText,
  summary: (state) => {
    const last = state.plan[state.plan.length - 1];
    return `8 bars in ${state.settings.key} major · about ${Math.round(last.at + last.dur)} seconds · ${state.bars.map((b) => b.chord.label).join(' ')}`;
  },
  plan: (state) => plan(state.bars),
  render,
  positionText: (step) => `Playing chord ${step.bar + 1} (bar ${Math.floor(step.bar / 2) + 1})`,
  abc: (state) => choraleToAbc(state.bars, state.settings.key),
  scoreIndex,
  scoreLabel: (state) => `Four-part chorale in ${state.settings.key} major: ${state.bars.map((b) => b.chord.label).join(' ')}`,
  fileStem: (state) => `chorale-dice-${state.settings.key}-${state.pairs.map((p) => p.join('')).join('')}`,
  encodeSettings: (s) => (s.key === 'C' ? {} : { k: s.key }),
  decodeSettings: (params, s) => {
    const k = params.get('k');
    if (k === null) { s.key = 'C'; return null; }
    if (!KEY_NAMES.includes(k)) return 'The link names a key this page does not know, so nothing was loaded.';
    s.key = k; return null;
  },
  applySettings: (s) => { $('#key').value = s.key; },
  bindSettings: (state, changed) => {
    $('#key').addEventListener('change', (e) => { state.settings.key = KEYS[e.target.value] ? e.target.value : 'C'; changed(); });
  },
};

export { KEY_NAMES, BARS };
