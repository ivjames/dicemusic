// The Musical Dice Game (K. 516f): the minuet as a game config on the shared page controller.
import { composeFrom } from './dice.js?v=dev';
import { renderMeasure, playbackPlan, BAR_SECONDS } from './synth.js?v=dev';
import { minuetToAbc, scoreMeasureIndex } from './notation.js?v=dev';
import { createApp } from './ui.js?v=dev';

const $ = (sel) => document.querySelector(sel);

createApp({
  noun: 'bar',
  pieceNoun: 'minuet',
  shareTitle: 'A minuet from the musical dice game',
  settingsNote: 'the repeat setting',
  defaultSettings: () => ({ repeats: false }),
  compose: (pairs) => composeFrom(pairs),
  cardHtml: (b) => `<b class="roman">${b.measure}</b><span class="fn">measure</span>`,
  cardText: (b) => `measure ${b.measure}`,
  summary: (state) => `${state.plan.length} bars · about ${Math.round(state.plan.length * BAR_SECONDS)} seconds · measures ${state.bars.map((b) => b.measure).join(', ')}`,
  plan: (state) => playbackPlan(state.bars.map((b) => b.measure), state.settings.repeats),
  render: (step, sr) => renderMeasure(step.measureId, sr, step.ending),
  // the print breaks its lines every eight bars; narrower, one card per engraved measure
  cardsPerRow: (state, perLine, wide) => (wide ? 8 : perLine),
  positionText: (step, index, state) => {
    const pass = state.settings.repeats && step.bar < 8 ? ` (${index < 8 ? 'first' : 'second'} time)` : '';
    return `Playing bar ${step.bar + 1}${pass}`;
  },
  abc: (state) => minuetToAbc(state.bars.map((b) => b.measure)),
  scoreIndex: scoreMeasureIndex,
  scoreLabel: (state) => `Score of the minuet, measures ${state.bars.map((b) => b.measure).join(', ')}`,
  fileStem: (state) => `mozart-dice-${state.pairs.map((p) => p.join('')).join('')}${state.settings.repeats ? '-repeats' : ''}`,
  encodeSettings: (s) => (s.repeats ? { r: '1' } : {}),
  decodeSettings: (params, s) => {
    const r = params.get('r');
    if (r !== null && r !== '1' && r !== '0') return 'The link holds an unknown repeat setting, so nothing was loaded.';
    s.repeats = r === '1';
    return null;
  },
  applySettings: (s) => { $('#repeats').checked = s.repeats; },
  bindSettings: (state, changed) => {
    $('#repeats').addEventListener('change', (e) => { state.settings.repeats = e.target.checked; changed(); });
  },
});
