// The chorale dice game as a game config for the shared page controller: dice choose a
// harmony at each of sixteen positions, the voice-leading engine writes the four parts, an
// elaboration pass adds movement between them, and the result is played and engraved in one
// of two textures (four voices on two staves, or broken chords in 12/8) with any of five
// instruments at a chosen tempo. A plan step carries everything its sound depends on.
import { BARS } from './table.js?v=dev';
import { barFromDice } from './dice.js?v=dev';
import { KEYS, KEY_NAMES, CHORDS, chordFor } from './chorale-harmony.js?v=dev';
import { voiceLead } from './chorale-voicing.js?v=dev';
import { elaborate, LEVELS, UNITS } from './chorale-motion.js?v=dev';
import { renderNotes, INSTRUMENTS, INSTRUMENT_NAMES } from './synth.js?v=dev';
import { toneFor, spell, interleave } from './chorale-notation.js?v=dev';
import { preludePlan, renderPrelude, preludeToAbc, preludeEighth } from './chorale-prelude.js?v=dev';

export const FERMATA_FACTOR = 1.6;                       // positions 8 and 16 are held
export const BREATH_SECONDS = 0.35;                      // a breath after the half cadence
const VOICE_VEL = [0.9, 0.78, 0.78, 0.95];               // bass, tenor, alto, soprano

export const TEXTURES = ['chorale', 'prelude'];
export const MOTIONS = LEVELS;                           // plain, passing, lively
export const TEMPO = { min: 48, max: 132, step: 4, default: 72 };
export const INSTRUMENT_CHOICES = ['auto', ...INSTRUMENT_NAMES];
const DEFAULTS = { key: 'C', texture: 'chorale', motion: 'passing', tempo: TEMPO.default, instrument: 'auto' };

/** Seconds per crotchet at `tempo` crotchets a minute; a chord is a minim. */
export const quarterSeconds = (tempo = TEMPO.default) => 60 / tempo;
export const chordSeconds = (tempo = TEMPO.default) => 2 * quarterSeconds(tempo);
/** The instrument a step plays: 'auto' means the choir for four voices and the piano for broken chords. */
export const resolveInstrument = (settings) => (settings.instrument && settings.instrument !== 'auto' ? settings.instrument : settings.texture === 'prelude' ? 'piano' : 'choir');

/**
 * Sixteen dice pairs → bars with their chord symbols, voicings and lines. The voicing is done
 * once for the whole set and depends only on the key; the lines depend on the motion level.
 */
export function compose(pairs, settings) {
  const key = settings.key;
  const bars = pairs.map((p, i) => {
    const b = barFromDice(i, p);
    const symbol = chordFor(i, b.sum);
    return { bar: i, dice: b.dice, sum: b.sum, symbol, chord: CHORDS[symbol] };
  });
  const { voicings, chords } = voiceLead(bars.map((b) => b.symbol), key);
  const { lines, kinds } = elaborate(voicings, chords, key, settings.motion || DEFAULTS.motion);
  bars.forEach((b, i) => { b.voicing = voicings[i]; b.realized = chords[i]; b.lines = lines[i]; b.kinds = kinds[i]; b.moving = kinds[i] !== null; });
  return bars;
}

/** Chorale texture: one step per chord, fermatas held longer, a breath after position 8. */
export function plan(bars, { tempo = TEMPO.default, instrument = 'choir' } = {}) {
  const steps = [];
  let at = 0;
  bars.forEach((b, i) => {
    const fermata = i === 7 || i === 15;
    const dur = chordSeconds(tempo) * (fermata ? FERMATA_FACTOR : 1);
    const lineKey = b.lines.map((l) => l.map(([m, u]) => `${m}x${u}`).join(',')).join('/');
    steps.push({ bar: i, score: Math.floor(i / 2), texture: 'chorale', instrument, tempo, key: `${i}:${lineKey}:${dur.toFixed(3)}:${instrument}`, at, dur, voicing: b.voicing, lines: b.lines, fermata });
    at += dur + (i === 7 ? BREATH_SECONDS : 0);
  });
  return steps;
}

/** Each voice plays its line: the notes' lengths in quavers scaled to the chord's duration. */
export function render(step, sampleRate) {
  const struck = INSTRUMENTS[step.instrument].family === 'struck';
  const unit = step.dur / UNITS;
  const events = [];
  step.lines.forEach((line, v) => {
    let at = 0;
    line.forEach(([midi, units], n) => {
      const last = n === line.length - 1;
      const d = units * unit - (last && !struck ? 0.07 : 0);
      events.push({ t: at, d: Math.max(0.05, d), midi, vel: VOICE_VEL[v] * (n ? 0.96 : 1) });
      at += units * unit;
    });
  });
  return renderNotes(events, step.dur, sampleRate, step.instrument);
}

/** Any step of either texture, from the step alone. */
export const renderStep = (step, sampleRate) => (step.texture === 'prelude' ? renderPrelude(step, sampleRate) : render(step, sampleRate));

const LEN = { 4: '4', 2: '2', 1: '' };
/** The chorale as an ABC tune: four voices on two staves, eight bars in two lines; added notes as crotchets and quavers. */
export function choraleToAbc(bars, keyName, tempo = TEMPO.default) {
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
      const fermata = i === 7 || i === 15 ? '!fermata!' : '';
      const part = b.lines[index[v]];
      // a crotchet, then quavers beamed together: "C2 DE"; a minim: "C4"
      line += fermata + part.map(([m, u], n) => (n > 0 && u === 1 && part[n - 1][1] === 1 ? '' : n > 0 ? ' ' : '') + name(m) + LEN[u]).join('');
      line += i % 2 === 1 ? (i === 15 ? ' |]' : i === 7 ? ' ||' : ' | ') : ' ';
      if (i === 7) { lines.push(line); line = `[V:${v}] `; }
    });
    lines.push(line);
    perVoice.push(lines);
  }
  return [
    'X:1', 'T:', 'M:4/4', 'L:1/8', `Q:1/4=${tempo}`,
    '%%score {(S A) (T B)}',
    'V:S clef=treble stem=up', 'V:A clef=treble stem=down', 'V:T clef=bass stem=up', 'V:B clef=bass stem=down',
    `K:${keyName}`,
    ...interleave(perVoice),
  ].join('\n') + '\n';
}

export const scoreIndex = (step) => step.score;
export { preludePlan, preludeToAbc, renderPrelude, preludeEighth };

const $ = (sel) => document.querySelector(sel);
const romanText = (b) => `${b.chord.label}, ${b.chord.fn}`;
const isPrelude = (state) => state.settings.texture === 'prelude';
const chordList = (state) => state.bars.map((b) => b.chord.label).join(' ');
const MOTION_TEXT = { plain: 'plain', passing: 'passing notes', lively: 'lively' };

export const choraleGame = {
  noun: 'chord',
  pieceNoun: 'chorale',
  shareTitle: 'A four-part chorale from the dice',
  settingsNote: 'the key, texture, motion, tempo and instrument',
  wideWidth: (state) => (isPrelude(state) ? 1100 : 700),
  measuresPerLine: (width, state) => (isPrelude(state) ? (width >= 640 ? 4 : width >= 400 ? 2 : 1) : (width >= 520 ? 4 : 2)),
  defaultSettings: () => ({ ...DEFAULTS }),
  compose,
  cardHtml: (b) => `<b class="roman">${b.chord.html}</b><span class="fn">${b.chord.fn}</span>`,
  cardText: romanText,
  summary: (state) => {
    const last = state.plan[state.plan.length - 1];
    const moving = state.bars.filter((b) => b.moving).length;
    const motion = state.settings.motion === 'plain' ? 'plain' : `${MOTION_TEXT[state.settings.motion]} in ${moving} of 16 chords`;
    return `${isPrelude(state) ? '16 bars of broken chords' : '8 bars'} in ${state.settings.key} major · ${motion} · ${INSTRUMENTS[resolveInstrument(state.settings)].label.toLowerCase()} at ${state.settings.tempo} · about ${Math.round(last.at + last.dur)} seconds · ${chordList(state)}`;
  },
  plan: (state) => {
    const opts = { tempo: state.settings.tempo, instrument: resolveInstrument(state.settings) };
    return isPrelude(state) ? preludePlan(state.bars, opts) : plan(state.bars, opts);
  },
  // The renderer is chosen from the step, not from the live settings: the controller's render
  // queue can still hold steps of a previous texture or instrument when a control changes, and
  // a buffer is cached under the step's key, so it must be the sound that key names.
  render: (step, sampleRate) => renderStep(step, sampleRate),
  positionText: (step, index, state) => (isPrelude(state) ? `Playing bar ${step.bar + 1}` : `Playing chord ${step.bar + 1} (bar ${Math.floor(step.bar / 2) + 1})`),
  abc: (state) => (isPrelude(state) ? preludeToAbc(state.bars, state.settings.key, state.settings.tempo) : choraleToAbc(state.bars, state.settings.key, state.settings.tempo)),
  scoreIndex,
  scoreLabel: (state) => `${isPrelude(state) ? 'Broken-chord prelude' : 'Four-part chorale'} in ${state.settings.key} major: ${chordList(state)}`,
  fileStem: (state) => `chorale-dice-${state.settings.key}-${isPrelude(state) ? 'prelude-' : ''}${state.settings.motion === 'passing' ? '' : state.settings.motion + '-'}${state.pairs.map((p) => p.join('')).join('')}`,
  encodeSettings: (s) => ({
    k: s.key === DEFAULTS.key ? undefined : s.key,
    t: s.texture === DEFAULTS.texture ? undefined : s.texture,
    m: s.motion === DEFAULTS.motion ? undefined : s.motion,
    q: s.tempo === DEFAULTS.tempo ? undefined : s.tempo,
    i: s.instrument === DEFAULTS.instrument ? undefined : s.instrument,
  }),
  decodeSettings: (params, s) => {
    const k = params.get('k'), t = params.get('t'), m = params.get('m'), q = params.get('q'), i = params.get('i');
    if (k !== null && !KEY_NAMES.includes(k)) return 'The link names a key this page does not know, so nothing was loaded.';
    if (t !== null && !TEXTURES.includes(t)) return 'The link names a texture this page does not know, so nothing was loaded.';
    if (m !== null && !MOTIONS.includes(m)) return 'The link names a kind of motion this page does not know, so nothing was loaded.';
    if (q !== null && !(/^\d{2,3}$/.test(q) && Number(q) >= TEMPO.min && Number(q) <= TEMPO.max)) return `The link asks for a tempo outside ${TEMPO.min} to ${TEMPO.max}, so nothing was loaded.`;
    if (i !== null && !INSTRUMENT_CHOICES.includes(i)) return 'The link names an instrument this page does not have, so nothing was loaded.';
    s.key = k ?? DEFAULTS.key; s.texture = t ?? DEFAULTS.texture; s.motion = m ?? DEFAULTS.motion;
    s.tempo = q === null ? DEFAULTS.tempo : Number(q); s.instrument = i ?? DEFAULTS.instrument;
    return null;
  },
  applySettings: (s) => {
    $('#key').value = s.key; $('#texture').value = s.texture; $('#motion').value = s.motion; $('#instrument').value = s.instrument;
    $('#tempo').value = String(s.tempo); $('#tempo-out').textContent = String(s.tempo);
  },
  bindSettings: (state, changed) => {
    const pick = (id, list, key) => $(id).addEventListener('change', (e) => { state.settings[key] = list.includes(e.target.value) ? e.target.value : DEFAULTS[key]; changed(); });
    pick('#key', KEY_NAMES, 'key'); pick('#texture', TEXTURES, 'texture'); pick('#motion', MOTIONS, 'motion'); pick('#instrument', INSTRUMENT_CHOICES, 'instrument');
    const tempo = $('#tempo');
    tempo.addEventListener('input', () => { $('#tempo-out').textContent = tempo.value; });
    tempo.addEventListener('change', () => {
      const v = Number(tempo.value);
      state.settings.tempo = Number.isFinite(v) ? Math.min(TEMPO.max, Math.max(TEMPO.min, Math.round(v))) : DEFAULTS.tempo;
      $('#tempo-out').textContent = String(state.settings.tempo);
      changed();
    });
  },
};

export { KEY_NAMES, BARS, KEYS };
