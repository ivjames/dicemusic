// The broken-chord texture: the same chords and the same four voices, but each half of a
// chord is played as a rising and falling figure, bass–tenor–alto–soprano–alto–tenor, six
// quavers in 12/8, so a chord is one bar and the sixteen chords sixteen bars. The first
// figure takes the voices as the chord begins, the second as it ends, so an added note
// arrives at the top of the second figure the way it does in a keyboard prelude. The last
// chord is rolled and held.
import { renderNotes, INSTRUMENTS } from './synth.js?v=dev';
import { statesOf, UNITS } from './chorale-motion.js?v=dev';
import { toneFor, spell, interleave } from './chorale-notation.js?v=dev';

const FIGURE = [0, 1, 2, 3, 2, 1];                                // voice index per quaver: b t a s a t
const VEL = [1.2, 0.92, 0.98, 1.26];                              // bass, tenor, alto, soprano
const ROLL_SECONDS = 0.02;

/** Seconds per quaver at `tempo` dotted crotchets a minute. */
export const preludeEighth = (tempo) => 60 / tempo / 3;

/** One step per chord; `cells` are the voicings for the two figures. */
export function preludePlan(bars, { tempo = 72, instrument = 'piano' } = {}) {
  const bar = 12 * preludeEighth(tempo);
  return bars.map((b, i) => {
    const states = statesOf(b.lines);
    const cells = [states[0], states[UNITS - 1]];
    const last = i === bars.length - 1;
    return {
      bar: i, score: i, texture: 'prelude', instrument, tempo,
      key: `p${i}:${cells.map((c) => c.join('.')).join('/')}${last ? ':held' : ''}:${tempo}:${instrument}`,
      at: i * bar, dur: bar, cells, last,
    };
  });
}

export function renderPrelude(step, sampleRate) {
  const E = preludeEighth(step.tempo);
  const struck = INSTRUMENTS[step.instrument].family === 'struck';
  const events = [];
  if (step.last) {
    step.cells[0].forEach((midi, v) => events.push({ t: v * ROLL_SECONDS, d: step.dur - v * ROLL_SECONDS - 0.05, midi, vel: VEL[v] * 0.8 }));
  } else {
    step.cells.forEach((cell, half) => FIGURE.forEach((v, q) => events.push({ t: (half * 6 + q) * E, d: E * (struck ? 1.5 : 0.95), midi: cell[v], vel: VEL[v] })));
  }
  return renderNotes(events, step.dur, sampleRate, step.instrument);
}

/** The prelude as an ABC tune: a grand staff, four bars to a line, the figure written out. */
export function preludeToAbc(bars, keyName, tempo = 72) {
  const rh = [], lh = [];
  let rhLine = '[V:RH] ', lhLine = '[V:LH] ';
  bars.forEach((b, i) => {
    const state = new Map();
    const states = statesOf(b.lines);
    const cells = [states[0], states[UNITS - 1]];
    const name = (midi) => spell(midi, toneFor(midi, b.realized, keyName), keyName, state);
    if (i === bars.length - 1) {
      const [B, T, A, S] = cells[0].map(name);
      rhLine += `[${A}${S}]6-[${A}${S}]6 |]`;
      lhLine += `[${B}${T}]6-[${B}${T}]6 |]`;
    } else {
      for (const cell of cells) {
        const [B, T, A, S] = [name(cell[0]), name(cell[1]), name(cell[2]), name(cell[3])];
        rhLine += `z2 ${A} ${S}${A} z `;
        lhLine += `${B}${T} z z2 ${T} `;
      }
      rhLine += '| '; lhLine += '| ';
    }
    if (i % 4 === 3) { rh.push(rhLine.trimEnd()); lh.push(lhLine.trimEnd()); rhLine = '[V:RH] '; lhLine = '[V:LH] '; }
  });
  return [
    'X:1', 'T:', 'M:12/8', 'L:1/8', `Q:3/8=${tempo}`,
    '%%score {RH LH}',
    'V:RH clef=treble', 'V:LH clef=bass',
    `K:${keyName}`,
    ...interleave([rh, lh]),
  ].join('\n') + '\n';
}
