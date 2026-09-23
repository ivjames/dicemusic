// The broken-chord texture: the same chords and the same four voices, but each half of a
// chord is played as a rising and falling figure, bass–tenor–alto–soprano–alto–tenor, six
// quavers in 12/8, so a chord is one bar and the sixteen chords sixteen bars. Where the
// elaboration gave a chord a second voicing, the second figure plays it, so passing notes
// arrive at the top of the figure the way they do in a keyboard prelude. The last chord is
// rolled and held. Rendered with the struck-string voice of the minuet page.
import { renderStruckNotes } from './synth.js?v=dev';
import { toneFor, spell, interleave } from './chorale-notation.js?v=dev';

export const PRELUDE_EIGHTH_SECONDS = 0.25;                      // ♩. = 80
export const PRELUDE_BAR_SECONDS = 12 * PRELUDE_EIGHTH_SECONDS;  // one chord per 12/8 bar
const FIGURE = [0, 1, 2, 3, 2, 1];                                // voice index per quaver: b t a s a t
const VEL = [1.2, 0.92, 0.98, 1.26];                              // bass, tenor, alto, soprano (the struck voice is quieter than the sustained one)
const ROLL_SECONDS = 0.02;

/** One step per chord; `cells` are the chord's voicings for each half. */
export function preludePlan(bars) {
  return bars.map((b, i) => {
    const cells = b.cells.length === 2 ? b.cells : [b.cells[0], b.cells[0]];
    const last = i === bars.length - 1;
    return { bar: i, score: i, texture: 'prelude', key: `p${i}:${cells.map((c) => c.join('.')).join('/')}${last ? ':held' : ''}`, at: i * PRELUDE_BAR_SECONDS, dur: PRELUDE_BAR_SECONDS, cells, last };
  });
}

export function renderPrelude(step, sampleRate) {
  const E = PRELUDE_EIGHTH_SECONDS;
  const events = [];
  if (step.last) {
    step.cells[0].forEach((midi, v) => events.push({ t: v * ROLL_SECONDS, d: step.dur - v * ROLL_SECONDS - 0.05, midi, vel: VEL[v] * 0.8 }));
  } else {
    step.cells.forEach((cell, half) => FIGURE.forEach((v, q) => events.push({ t: (half * 6 + q) * E, d: E * 1.5, midi: cell[v], vel: VEL[v] })));
  }
  return renderStruckNotes(events, step.dur, sampleRate);
}

/** The prelude as an ABC tune: a grand staff, four bars to a line, the figure written out. */
export function preludeToAbc(bars, keyName, tempo = Math.round(60 / (3 * PRELUDE_EIGHTH_SECONDS))) {
  const rh = [], lh = [];
  let rhLine = '[V:RH] ', lhLine = '[V:LH] ';
  bars.forEach((b, i) => {
    const state = new Map();
    const cells = b.cells.length === 2 ? b.cells : [b.cells[0], b.cells[0]];
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
