// The chorale dice game as a game config for the shared page controller: dice choose a
// harmony at each of sixteen positions, the voice-leading engine writes the four parts, an
// elaboration pass adds passing notes between them, and the result is played and engraved
// in one of two textures: four sustained voices on two staves, or broken chords in 12/8.
import { BARS } from './table.js?v=dev';
import { barFromDice } from './dice.js?v=dev';
import { KEYS, KEY_NAMES, CHORDS, chordFor } from './chorale-harmony.js?v=dev';
import { voiceLead } from './chorale-voicing.js?v=dev';
import { elaborate } from './chorale-motion.js?v=dev';
import { renderSustainedNotes } from './synth.js?v=dev';
import { toneFor, spell, interleave } from './chorale-notation.js?v=dev';
import { preludePlan, renderPrelude, preludeToAbc, PRELUDE_BAR_SECONDS } from './chorale-prelude.js?v=dev';

export const QUARTER_SECONDS = 60 / 72;
export const CHORD_SECONDS = 2 * QUARTER_SECONDS;      // one chord per half note
export const FERMATA_FACTOR = 1.6;                       // positions 8 and 16 are held
export const BREATH_SECONDS = 0.35;                      // a breath after the half cadence
const VOICE_VEL = [0.9, 0.78, 0.78, 0.95];               // bass, tenor, alto, soprano

export const TEXTURES = ['chorale', 'prelude'];
export const MOTIONS = ['passing', 'plain'];
const DEFAULTS = { key: 'C', texture: 'chorale', motion: 'passing' };

/**
 * Sixteen dice pairs → bars with their chord symbols, voicings and cells. The voicing is
 * done once for the whole set and does not depend on texture or motion; with motion
 * 'passing' each bar may get a second voicing for its second half.
 */
export function compose(pairs, settings) {
  const key = settings.key;
  const bars = pairs.map((p, i) => {
    const b = barFromDice(i, p);
    const symbol = chordFor(i, b.sum);
    return { bar: i, dice: b.dice, sum: b.sum, symbol, chord: CHORDS[symbol] };
  });
  const { voicings, chords } = voiceLead(bars.map((b) => b.symbol), key);
  const motion = settings.motion === 'plain' ? { cells: voicings.map((v) => [v]), kinds: voicings.map(() => null) } : elaborate(voicings, chords, key);
  bars.forEach((b, i) => { b.voicing = voicings[i]; b.realized = chords[i]; b.cells = motion.cells[i]; b.kinds = motion.kinds[i]; });
  return bars;
}

/** Chorale texture: one step per chord, fermatas held longer, a breath after position 8. */
export function plan(bars) {
  const steps = [];
  let at = 0;
  bars.forEach((b, i) => {
    const fermata = i === 7 || i === 15;
    const dur = CHORD_SECONDS * (fermata ? FERMATA_FACTOR : 1);
    steps.push({ bar: i, score: Math.floor(i / 2), texture: 'chorale', key: `${i}:${b.cells.map((c) => c.join('.')).join('/')}:${dur.toFixed(3)}`, at, dur, voicing: b.voicing, cells: b.cells, fermata });
    at += dur + (i === 7 ? BREATH_SECONDS : 0);
  });
  return steps;
}

/** Each voice sings its note for the chord, or its two notes where the elaboration gave it a second. */
export function render(step, sampleRate) {
  const events = [];
  const [first, second] = step.cells;
  const end = Math.max(0.05, step.dur - 0.07);
  for (let v = 0; v < 4; v++) {
    if (second && second[v] !== first[v]) {
      events.push({ t: 0, d: step.dur / 2, midi: first[v], vel: VOICE_VEL[v] });
      events.push({ t: step.dur / 2, d: end - step.dur / 2, midi: second[v], vel: VOICE_VEL[v] * 0.96 });
    } else {
      events.push({ t: 0, d: end, midi: first[v], vel: VOICE_VEL[v] });
    }
  }
  return renderSustainedNotes(events, step.dur, sampleRate);
}

/** The chorale as an ABC tune: four voices on two staves, eight bars in two lines; added notes as crotchets. */
export function choraleToAbc(bars, keyName) {
  const voices = ['S', 'A', 'T', 'B'];
  const index = { S: 3, A: 2, T: 1, B: 0 };
  const perVoice = [];
  for (const v of voices) {
    const lines = [];
    let line = `[V:${v}] `;
    let state = new Map();
    bars.forEach((b, i) => {
      if (i % 2 === 0) state = new Map();                              // accidentals reset at the bar line
      const name = (midi) => spell(midi, toneFor(midi, b.realized, keyName), keyName, state);
      const [first, second] = b.cells;
      const fermata = i === 7 || i === 15 ? '!fermata!' : '';
      const a = first[index[v]];
      if (second && second[index[v]] !== a) line += `${name(a)} ${name(second[index[v]])}`;
      else line += fermata + name(a) + '2';
      line += i % 2 === 1 ? (i === 15 ? ' |]' : i === 7 ? ' ||' : ' | ') : ' ';
      if (i === 7) { lines.push(line); line = `[V:${v}] `; }
    });
    lines.push(line);
    perVoice.push(lines);
  }
  return [
    'X:1', 'T:', 'M:4/4', 'L:1/4', `Q:1/4=${Math.round(60 / QUARTER_SECONDS)}`,
    '%%score {(S A) (T B)}',
    'V:S clef=treble stem=up', 'V:A clef=treble stem=down', 'V:T clef=bass stem=up', 'V:B clef=bass stem=down',
    `K:${keyName}`,
    ...interleave(perVoice),
  ].join('\n') + '\n';
}

export const scoreIndex = (step) => step.score;
export { preludePlan, preludeToAbc, renderPrelude, PRELUDE_BAR_SECONDS };

const $ = (sel) => document.querySelector(sel);
const romanText = (b) => `${b.chord.label}, ${b.chord.fn}`;
const isPrelude = (state) => state.settings.texture === 'prelude';
const chordList = (state) => state.bars.map((b) => b.chord.label).join(' ');

export const choraleGame = {
  noun: 'chord',
  pieceNoun: 'chorale',
  shareTitle: 'A four-part chorale from the dice',
  settingsNote: 'the key, texture and motion',
  wideWidth: (state) => (isPrelude(state) ? 1100 : 700),
  measuresPerLine: (width, state) => (isPrelude(state) ? (width >= 640 ? 4 : width >= 400 ? 2 : 1) : (width >= 520 ? 4 : 2)),
  defaultSettings: () => ({ ...DEFAULTS }),
  compose,
  cardHtml: (b) => `<span class="measure"><b class="roman">${b.chord.html}</b></span><span class="fn">${b.chord.fn}</span>`,
  cardText: romanText,
  summary: (state) => {
    const last = state.plan[state.plan.length - 1];
    const moving = state.bars.filter((b) => b.cells.length === 2).length;
    const motion = state.settings.motion === 'plain' ? 'plain' : `passing notes in ${moving} of 16 chords`;
    return `${isPrelude(state) ? '16 bars of broken chords' : '8 bars'} in ${state.settings.key} major · ${motion} · about ${Math.round(last.at + last.dur)} seconds · ${chordList(state)}`;
  },
  plan: (state) => (isPrelude(state) ? preludePlan(state.bars) : plan(state.bars)),
  // The renderer is chosen from the step, not from the live settings: the controller's render
  // queue can still hold steps of the previous texture when the selector changes, and a buffer
  // is cached under the step's key, so it must be the sound that key names.
  render: (step, sampleRate) => (step.texture === 'prelude' ? renderPrelude(step, sampleRate) : render(step, sampleRate)),
  positionText: (step, index, state) => (isPrelude(state) ? `Playing bar ${step.bar + 1}` : `Playing chord ${step.bar + 1} (bar ${Math.floor(step.bar / 2) + 1})`),
  abc: (state) => (isPrelude(state) ? preludeToAbc(state.bars, state.settings.key) : choraleToAbc(state.bars, state.settings.key)),
  scoreIndex,
  scoreLabel: (state) => `${isPrelude(state) ? 'Broken-chord prelude' : 'Four-part chorale'} in ${state.settings.key} major: ${chordList(state)}`,
  fileStem: (state) => `chorale-dice-${state.settings.key}-${isPrelude(state) ? 'prelude-' : ''}${state.settings.motion === 'plain' ? 'plain-' : ''}${state.pairs.map((p) => p.join('')).join('')}`,
  encodeSettings: (s) => ({
    k: s.key === DEFAULTS.key ? undefined : s.key,
    t: s.texture === DEFAULTS.texture ? undefined : s.texture,
    m: s.motion === DEFAULTS.motion ? undefined : s.motion,
  }),
  decodeSettings: (params, s) => {
    const k = params.get('k'), t = params.get('t'), m = params.get('m');
    if (k !== null && !KEY_NAMES.includes(k)) return 'The link names a key this page does not know, so nothing was loaded.';
    if (t !== null && !TEXTURES.includes(t)) return 'The link names a texture this page does not know, so nothing was loaded.';
    if (m !== null && !MOTIONS.includes(m)) return 'The link names a kind of motion this page does not know, so nothing was loaded.';
    s.key = k ?? DEFAULTS.key; s.texture = t ?? DEFAULTS.texture; s.motion = m ?? DEFAULTS.motion;
    return null;
  },
  applySettings: (s) => { $('#key').value = s.key; $('#texture').value = s.texture; $('#motion').value = s.motion; },
  bindSettings: (state, changed) => {
    $('#key').addEventListener('change', (e) => { state.settings.key = KEYS[e.target.value] ? e.target.value : DEFAULTS.key; changed(); });
    $('#texture').addEventListener('change', (e) => { state.settings.texture = TEXTURES.includes(e.target.value) ? e.target.value : DEFAULTS.texture; changed(); });
    $('#motion').addEventListener('change', (e) => { state.settings.motion = MOTIONS.includes(e.target.value) ? e.target.value : DEFAULTS.motion; changed(); });
  },
};

export { KEY_NAMES, BARS };
