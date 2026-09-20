import { BARS } from './table.js';
import { composeFrom, rollAll, rollUnlocked, rerollBar, isPair } from './dice.js';
import { encodeState, decodeState } from './share.js';
import { renderMeasure, playbackPlan, mixdown, bufferKey, barSamples, BAR_SECONDS } from './synth.js';
import { encodeWav } from './wav.js';
import { Player } from './player.js';

const $ = (sel) => document.querySelector(sel);
const grid = $('#bars');
const status = $('#status');
const player = new Player();

const state = {
  pairs: new Array(BARS).fill(null),
  locks: new Array(BARS).fill(false),
  repeats: false,
  bars: null,                 // composeFrom(pairs) or null before the first roll
  plan: [],
  rendered: new Map(),        // bufferKey -> Float32Array at the player's sample rate
  renderedRate: 0,
  busy: false,
  generation: 0,              // bumped on every change to the plan, so a render in flight can notice
};

// ---------- status / errors ----------
let statusTimer = 0;
function say(text, { sticky = false, error = false } = {}) {
  clearTimeout(statusTimer);
  status.textContent = text;
  status.classList.toggle('is-error', error);
  if (text && !sticky) statusTimer = setTimeout(() => { status.textContent = ''; }, 6000);
}

// ---------- rendering the 16 bars ----------
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function dieSvg(value) {
  const pips = PIPS[value].map((p) => {
    const cx = 5 + (p % 3) * 5, cy = 5 + Math.floor(p / 3) * 5;
    return `<circle cx="${cx}" cy="${cy}" r="1.6"/>`;
  }).join('');
  return `<svg class="die" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="0.75" y="0.75" width="18.5" height="18.5" rx="3.5"/>${pips}</svg>`;
}

function buildGrid() {
  grid.innerHTML = '';
  for (let i = 0; i < BARS; i++) {
    const li = document.createElement('li');
    li.className = 'bar';
    li.dataset.bar = String(i);
    li.innerHTML = `
      <div class="bar-head">
        <span class="bar-num">Bar ${i + 1}</span>
        <button type="button" class="lock" data-action="lock" aria-pressed="false" aria-label="Lock bar ${i + 1}" title="Lock this bar">
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="shackle" d="M6 9V6.5a4 4 0 0 1 8 0V9"/><rect x="4" y="9" width="12" height="8.5" rx="1.5"/></svg>
        </button>
      </div>
      <div class="dice" aria-hidden="true"></div>
      <p class="bar-text"></p>
      <button type="button" class="reroll" data-action="reroll" aria-label="Reroll bar ${i + 1}">Reroll</button>`;
    grid.appendChild(li);
  }
}

function renderBars() {
  const cards = grid.children;
  for (let i = 0; i < BARS; i++) {
    const li = cards[i];
    const b = state.bars ? state.bars[i] : null;
    const dice = li.querySelector('.dice');
    const text = li.querySelector('.bar-text');
    const lock = li.querySelector('.lock');
    const reroll = li.querySelector('.reroll');
    if (b) {
      dice.innerHTML = dieSvg(b.dice[0]) + dieSvg(b.dice[1]);
      text.innerHTML = `<span class="sum">${b.dice[0]} + ${b.dice[1]} = <b>${b.sum}</b></span><span class="measure">Measure <b>${b.measure}</b></span>`;
      li.setAttribute('aria-label', `Bar ${i + 1}: dice ${b.dice[0]} and ${b.dice[1]}, total ${b.sum}, measure ${b.measure}${state.locks[i] ? ', locked' : ''}`);
    } else {
      dice.innerHTML = '';
      text.innerHTML = '<span class="sum">Not rolled yet</span>';
      li.setAttribute('aria-label', `Bar ${i + 1}: not rolled yet`);
    }
    lock.setAttribute('aria-pressed', String(state.locks[i]));
    lock.setAttribute('aria-label', `${state.locks[i] ? 'Unlock' : 'Lock'} bar ${i + 1}`);
    lock.title = state.locks[i] ? 'Unlock this bar' : 'Lock this bar so Roll Unlocked keeps it';
    li.classList.toggle('is-locked', state.locks[i]);
    reroll.disabled = !state.bars;
  }
  const has = Boolean(state.bars);
  $('#play').disabled = !has;
  $('#download').disabled = !has;
  $('#play').setAttribute('aria-busy', String(state.busy));
  $('#download').setAttribute('aria-busy', String(state.busy));
  $('#share').disabled = !has;
  $('#roll-unlocked').disabled = !has;
  $('#summary').hidden = !has;
  if (has) {
    const total = state.plan.length * BAR_SECONDS;
    $('#summary').textContent = `${state.plan.length} bars · about ${Math.round(total)} seconds · measures ${state.bars.map((b) => b.measure).join(', ')}`;
  }
}

function highlight(index) {
  const step = index >= 0 ? state.plan[index] : null;
  const bar = step ? step.bar : -1;
  for (let i = 0; i < BARS; i++) {
    const li = grid.children[i];
    const on = i === bar;
    li.classList.toggle('is-playing', on);
    if (on) li.setAttribute('aria-current', 'true'); else li.removeAttribute('aria-current');
  }
  const pos = $('#position');
  if (step) {
    const pass = state.repeats ? ` (${index < 8 || (index >= 16 && index < 24) ? 'first' : 'second'} time)` : '';
    pos.textContent = `Playing bar ${bar + 1}${pass}`;
  } else {
    pos.textContent = player.state === 'paused' ? 'Paused' : '';
  }
}

// ---------- composition changes ----------
function setPairs(pairs, { fromLink = false } = {}) {
  // Any edit during playback stops it and resets the playhead first.
  if (player.state !== 'idle') { player.stop(); syncControls(); }
  state.pairs = pairs;
  state.bars = pairs.every(isPair) ? composeFrom(pairs) : null;
  state.plan = state.bars ? playbackPlan(state.bars.map((b) => b.measure), state.repeats) : [];
  state.generation++;
  renderBars();
  highlight(-1);
  if (!fromLink) updateUrl();
}

function updateUrl() {
  if (!state.bars) return;
  const qs = encodeState({ pairs: state.pairs, locks: state.locks, repeats: state.repeats });
  history.replaceState(null, '', `${location.pathname}?${qs}`);
}

function shareUrl() {
  return `${location.origin}${location.pathname}?${encodeState({ pairs: state.pairs, locks: state.locks, repeats: state.repeats })}`;
}

// ---------- audio ----------
async function ensureRendered() {
  // The plan can change while this yields (a reroll, the repeats toggle). Keep going until a
  // pass finds nothing missing for the plan as it stands now.
  for (;;) {
    const gen = state.generation;
    await renderMissing();
    if (gen === state.generation) return;
  }
}

async function renderMissing() {
  const sr = player.sampleRate;
  if (state.renderedRate !== sr) { state.rendered.clear(); state.renderedRate = sr; }
  const missing = [];
  for (const step of state.plan) {
    const key = bufferKey(step.measureId, step.ending);
    if (!state.rendered.has(key) && !missing.some((m) => m.key === key)) missing.push({ key, ...step });
  }
  if (!missing.length) return;
  state.busy = true; renderBars();
  say(`Preparing sound (${missing.length} measure${missing.length === 1 ? '' : 's'})…`, { sticky: true });
  try {
    for (let i = 0; i < missing.length; i++) {
      const m = missing[i];
      state.rendered.set(m.key, renderMeasure(m.measureId, sr, m.ending));
      if (i % 2 === 1) await new Promise((r) => setTimeout(r, 0));   // keep the page responsive
    }
    say('');
  } finally {
    state.busy = false; renderBars();
  }
}

let raf = 0;
function tick() {
  raf = 0;
  if (player.state !== 'playing') return;
  if (player.finished) { player.finish(); return; }
  highlight(player.currentIndex());
  raf = requestAnimationFrame(tick);
}

function syncControls() {
  const playing = player.state === 'playing';
  const paused = player.state === 'paused';
  const play = $('#play');
  play.textContent = playing ? 'Pause' : paused ? 'Resume' : 'Play';
  play.setAttribute('aria-label', playing ? 'Pause playback' : paused ? 'Resume playback' : 'Play the minuet');
  play.classList.toggle('is-playing', playing);
  $('#stop').disabled = player.state === 'idle';
  if (!playing && raf) { cancelAnimationFrame(raf); raf = 0; }
  if (playing && !raf) raf = requestAnimationFrame(tick);
  if (!playing) highlight(paused ? player.currentIndex() : -1);
}

let playLock = false;
async function onPlay() {
  if (playLock || !state.bars) return;
  playLock = true;
  try {
    if (player.state === 'playing') { player.pause(); return; }
    if (player.state === 'paused') {
      await player.ensureContext();
      if (player.state !== 'paused') return;   // Stop or an edit landed while the context woke
      if (player.needsReload) {       // the context was swapped for one at another sample rate
        const from = player.pausedAtSample; const oldRate = player.floatRate;
        await ensureRendered();
        if (player.state !== 'paused') return;
        player.load(state.plan, state.rendered, (s) => bufferKey(s.measureId, s.ending));
        player.pausedAtSample = Math.round(from * player.sampleRate / oldRate); player.state = 'paused';
      }
      player.play(); return;
    }
    await player.ensureContext();
    await ensureRendered();
    if (player.state !== 'idle') return;   // something changed while rendering
    player.load(state.plan, state.rendered, (s) => bufferKey(s.measureId, s.ending));
    player.play();
  } catch (err) {
    say(err.message || 'Audio could not be started.', { error: true, sticky: true });
  } finally {
    playLock = false;
    syncControls();
  }
}

let downloadLock = false;
async function onDownload() {
  if (!state.bars || downloadLock) return;
  downloadLock = true;
  try {
    // The export is the same measures, the same buffers and the same bar spacing as playback.
    const sr = player.ctx ? player.sampleRate : 44100;
    if (state.renderedRate !== sr) { state.rendered.clear(); state.renderedRate = sr; }
    await ensureRendered();
    const mix = mixdown(state.plan, state.rendered, sr);
    const blob = new Blob([encodeWav(mix, sr)], { type: 'audio/wav' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mozart-dice-${state.pairs.map((p) => p.join('')).join('')}${state.repeats ? '-repeats' : ''}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    say(`WAV saved: ${(mix.length / sr).toFixed(1)} seconds, ${sr} Hz, 16-bit mono.`);
  } catch (err) {
    say(`Export failed: ${err.message}`, { error: true, sticky: true });
  } finally {
    downloadLock = false;
  }
}

async function onShare() {
  if (!state.bars) return;
  const url = shareUrl();
  updateUrl();
  const out = $('#share-url');
  out.value = url; out.hidden = false;
  try {
    if (navigator.share && /Mobi|Android|iPhone|iPad/.test(navigator.userAgent)) {
      await navigator.share({ title: 'A minuet from the musical dice game', url });
      say('Shared.');
    } else {
      await navigator.clipboard.writeText(url);
      say('Link copied to the clipboard. It restores these dice, locks and the repeat setting.');
    }
  } catch {
    out.focus(); out.select();
    say('Copy the link from the box below.', { sticky: true });
  }
}

// ---------- wiring ----------
function init() {
  buildGrid();
  $('#roll').addEventListener('click', () => { setPairs(rollAll()); say('Rolled two dice for each of the 16 bars.'); });
  $('#roll-unlocked').addEventListener('click', () => {
    const n = state.locks.filter(Boolean).length;
    setPairs(rollUnlocked(state.pairs, state.locks));
    say(n ? `Rerolled ${BARS - n} bars; ${n} locked bar${n === 1 ? '' : 's'} kept.` : 'Rerolled all 16 bars (none were locked).');
  });
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const bar = Number(btn.closest('.bar').dataset.bar);
    if (btn.dataset.action === 'lock') {
      state.locks[bar] = !state.locks[bar];
      renderBars(); updateUrl();
      btn.focus();
    } else if (btn.dataset.action === 'reroll' && state.bars) {
      setPairs(rerollBar(state.pairs, bar));
      const b = state.bars[bar];
      say(`Bar ${bar + 1} rerolled: ${b.dice[0]} + ${b.dice[1]} = ${b.sum}, measure ${b.measure}.`);
      btn.focus();
    }
  });
  $('#play').addEventListener('click', onPlay);
  $('#stop').addEventListener('click', () => { player.stop(); syncControls(); });
  $('#download').addEventListener('click', onDownload);
  $('#share').addEventListener('click', onShare);
  $('#repeats').addEventListener('change', (e) => {
    state.repeats = e.target.checked;
    if (player.state !== 'idle') { player.stop(); syncControls(); }
    if (state.bars) state.plan = playbackPlan(state.bars.map((b) => b.measure), state.repeats);
    state.generation++;
    renderBars(); updateUrl();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !e.target.closest('button, input, textarea, a, select')) { e.preventDefault(); onPlay(); }
  });
  player.onChange((_s, reason) => {
    syncControls();
    if (reason === 'interrupted') say('Playback was interrupted by the system. Press Resume to continue.', { sticky: true });
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    // Coming back from another app: iOS may hand us a context that says "running" but never ticks.
    await player.checkAfterReturn();
    syncControls();
    if (player.state === 'playing' && !raf) raf = requestAnimationFrame(tick);
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { player.stale = true; if (player.state !== 'idle') { player.stop(); syncControls(); } } });

  if (!player.supported) say('This browser has no Web Audio support, so nothing can be played here.', { error: true, sticky: true });

  const link = decodeState(location.search);
  if (link.error) {
    say(link.error, { error: true, sticky: true });
    history.replaceState(null, '', location.pathname);
  } else if (!link.empty) {
    state.locks = link.locks;
    state.repeats = link.repeats;
    $('#repeats').checked = link.repeats;
    setPairs(link.pairs, { fromLink: true });
    say('Composition restored from the link.');
  }
  renderBars();
  syncControls();

  // A hook for the automated tests: the same bytes the Download button writes.
  window.__mozart = {
    state, player,
    exportBytes: async () => { const sr = player.ctx ? player.sampleRate : 44100; if (state.renderedRate !== sr) { state.rendered.clear(); state.renderedRate = sr; } await ensureRendered(); return new Uint8Array(encodeWav(mixdown(state.plan, state.rendered, sr), sr)); },
    barSamples: () => barSamples(player.sampleRate),
  };
}

init();
