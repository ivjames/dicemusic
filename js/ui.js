// The page controller shared by both dice games. A game supplies what differs: how dice
// become bars, how bars become a playback plan and a score, how a step is rendered, and
// which extra settings ride in the link. Everything else (cards, transport, share, WAV,
// engraving, highlight, the Web Audio lifecycle) lives here once.
import { BARS } from './table.js?v=dev';
import { rollAll, rollUnlocked, rerollBar, isPair } from './dice.js?v=dev';
import { encodeState, decodeState } from './share.js?v=dev';
import { mixdown } from './synth.js?v=dev';
import { encodeWav } from './wav.js?v=dev';
import { Player } from './player.js?v=dev';

const $ = (sel) => document.querySelector(sel);

export function createApp(game) {
  const grid = $('#bars');
  const status = $('#status');
  const scoreEl = $('#score');
  const player = new Player();
  const noun = game.noun || 'bar';

  const state = {
    pairs: new Array(BARS).fill(null),
    locks: new Array(BARS).fill(false),
    settings: game.defaultSettings ? game.defaultSettings() : {},
    bars: null,                 // game.compose(pairs, settings) or null before the first roll
    plan: [],
    rendered: new Map(),        // step.key -> Float32Array at the player's sample rate
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

  // ---------- the 16 cards ----------
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function dieSvg(value) {
    const pips = PIPS[value].map((p) => {
      const cx = 5 + (p % 3) * 5, cy = 5 + Math.floor(p / 3) * 5;
      return `<circle cx="${cx}" cy="${cy}" r="1.6"/>`;
    }).join('');
    return `<svg class="die" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><rect x="0.75" y="0.75" width="18.5" height="18.5" rx="3.5"/>${pips}</svg>`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function buildGrid() {
    grid.innerHTML = '';
    for (let i = 0; i < BARS; i++) {
      const li = document.createElement('li');
      li.className = 'bar';
      li.dataset.bar = String(i);
      // One compact card, eight to a row at full width: the position, the two faces and their
      // total, then what the throw chose, with reroll and lock stacked as icon buttons on the
      // right. Full wording is in the labels.
      li.innerHTML = `
        <div class="bar-head">
          <span class="bar-num" aria-hidden="true">${i + 1}</span>
          <span class="dice" aria-hidden="true"></span>
        </div>
        <p class="bar-text"></p>
        <div class="bar-side">
          <button type="button" class="reroll" data-action="reroll" aria-label="Reroll ${noun} ${i + 1}" title="Reroll this ${noun}">
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M15.5 8.5A6 6 0 1 0 16 11.5"/><path d="M16 4v4.5h-4.5"/></svg>
          </button>
          <button type="button" class="lock" data-action="lock" aria-pressed="false" aria-label="Lock ${noun} ${i + 1}" title="Lock this ${noun}">
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="shackle" d="M6 9V6.5a4 4 0 0 1 8 0V9"/><rect x="4" y="9" width="12" height="8.5" rx="1.5"/></svg>
          </button>
        </div>`;
      grid.appendChild(li);
    }
  }

  function renderBars() {
    layoutGrid();
    const cards = grid.children;
    for (let i = 0; i < BARS; i++) {
      const li = cards[i];
      const b = state.bars ? state.bars[i] : null;
      const dice = li.querySelector('.dice');
      const text = li.querySelector('.bar-text');
      const lock = li.querySelector('.lock');
      const reroll = li.querySelector('.reroll');
      if (b) {
        // the faces, then their total: "3 + 4 = 7" is what the dice already show
        dice.innerHTML = `${dieSvg(b.dice[0])}${dieSvg(b.dice[1])}<b class="sum">${b.sum}</b>`;
        text.innerHTML = game.cardHtml(b, state);
        li.setAttribute('aria-label', `${cap(noun)} ${i + 1}: dice ${b.dice[0]} and ${b.dice[1]}, total ${b.sum}, ${game.cardText(b, state)}${state.locks[i] ? ', locked' : ''}`);
      } else {
        dice.innerHTML = '';
        text.innerHTML = '<span class="sum">Not rolled yet</span>';
        li.setAttribute('aria-label', `${cap(noun)} ${i + 1}: not rolled yet`);
      }
      lock.setAttribute('aria-pressed', String(state.locks[i]));
      lock.setAttribute('aria-label', `${state.locks[i] ? 'Unlock' : 'Lock'} ${noun} ${i + 1}`);
      lock.title = state.locks[i] ? `Unlock this ${noun}` : `Lock this ${noun} so Roll Unlocked keeps it`;
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
    if (has) $('#summary').textContent = game.summary(state);
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
    if (step) pos.textContent = game.positionText(step, index, state);
    else pos.textContent = player.state === 'paused' ? 'Paused' : '';
    highlightScore(step ? game.scoreIndex(step) : -1);
  }

  // ---------- the score ----------
  let abcjsLoading = null;
  let scoreMm = -1;
  function loadAbcjs() {
    if (window.ABCJS) return Promise.resolve(window.ABCJS);
    if (!abcjsLoading) {
      abcjsLoading = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = scoreEl.dataset.engraver || 'js/vendor/abcjs-basic-min.js';
        sc.onload = () => resolve(window.ABCJS);
        sc.onerror = () => { abcjsLoading = null; reject(new Error('The notation library could not be loaded.')); };
        document.head.appendChild(sc);
      });
    }
    return abcjsLoading;
  }
  async function renderScore() {
    const section = $('#score-section');
    if (!state.bars) { section.hidden = true; scoreEl.innerHTML = ''; delete scoreEl.dataset.abc; layoutGrid(); return; }
    section.hidden = false;
    const gen = state.generation;
    try {
      const ABCJS = await loadAbcjs();
      if (state.generation !== gen || !state.bars) return;       // a newer roll or setting won
      engrave(ABCJS);
      scoreEl.setAttribute('aria-label', game.scoreLabel(state));
      $('#save-score').disabled = false;
      scoreMm = -1;
      highlightScore(player.state === 'idle' ? -1 : game.scoreIndex(state.plan[Math.max(0, player.currentIndex())]));
    } catch (err) {
      scoreEl.innerHTML = `<p class="score-fallback">${err.message} The music still plays; the notation is only a picture of it.</p>`;
      $('#save-score').disabled = true;
    }
  }
  // The score is cut into lines and the card grid into rows from one number, the bars to a
  // line at the page's width, so a row of cards is a line of the score, or a clean half of
  // one where the cards would be too narrow. Measure the page column, not the score box: a
  // previous render must not feed back into the next.
  function layoutWidth() { return Math.max(300, document.querySelector('main').clientWidth - 26); }
  function barsPerLineFor(width) { return game.barsPerLine ? game.barsPerLine(width, state) : (width >= 860 ? 8 : width >= 620 ? 6 : width >= 440 ? 4 : 2); }
  const CARD_MIN_WIDTH = 112;   // below this the head row of a card no longer fits
  function layoutGrid(width = layoutWidth()) {
    const bpl = barsPerLineFor(width);
    let n = game.cardsPerRow ? game.cardsPerRow(state, bpl) : bpl;
    n = Math.max(1, Math.min(16, Math.round(n)));
    while (n > 2 && n % 2 === 0 && n * CARD_MIN_WIDTH > grid.clientWidth) n /= 2;   // halve, never split a line unevenly
    grid.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
    return n;
  }
  /** Engrave the score for the width we have, its lines cut where the game's ABC cuts them. */
  function engrave(ABCJS) {
    const width = layoutWidth();
    const abc = game.abc(state, barsPerLineFor(width));
    ABCJS.renderAbc(scoreEl, abc, {
      add_classes: true, foregroundColor: 'currentColor', responsive: 'resize', staffwidth: width,
      paddingtop: 0, paddingbottom: 0, paddingleft: 0, paddingright: 0,
    });
    scoreEl.dataset.abc = abc;
    scoreEl.dataset.width = String(width);
    layoutGrid(width);
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const width = layoutWidth();
      layoutGrid(width);
      if (!state.bars || !window.ABCJS || String(width) === scoreEl.dataset.width) return;
      engrave(window.ABCJS);
      scoreMm = -1; highlightScore(player.state === 'idle' ? -1 : game.scoreIndex(state.plan[Math.max(0, player.currentIndex())]));
    }, 150);
  });
  function highlightScore(mm) {
    if (mm === scoreMm) return;
    if (scoreMm >= 0) for (const el of scoreEl.querySelectorAll(`.abcjs-mm${scoreMm}`)) el.classList.remove('is-current');
    if (mm >= 0) for (const el of scoreEl.querySelectorAll(`.abcjs-mm${mm}`)) el.classList.add('is-current');
    scoreMm = mm;
  }
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }
  function onSaveScore() {
    const svg = scoreEl.querySelector('svg');
    if (!svg) return;
    const copy = svg.cloneNode(true);
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.removeAttribute('style');
    for (const el of copy.querySelectorAll('.is-current')) el.classList.remove('is-current');
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${game.scoreLabel(state)} -->\n` + copy.outerHTML.replace(/currentColor/g, '#000');
    download(new Blob([text], { type: 'image/svg+xml' }), `${game.fileStem(state)}.svg`);
    say('Score saved as SVG.');
  }

  // ---------- composition changes ----------
  function recompose() {
    state.bars = state.pairs.every(isPair) ? game.compose(state.pairs, state.settings) : null;
    state.plan = state.bars ? game.plan(state) : [];
    state.generation++;
  }
  function setPairs(pairs, { fromLink = false } = {}) {
    // Any edit during playback stops it and resets the playhead first.
    if (player.state !== 'idle') { player.stop(); syncControls(); }
    state.pairs = pairs;
    recompose();
    renderBars();
    highlight(-1);
    renderScore();
    if (!fromLink) updateUrl();
  }
  /** Called by the game when one of its own settings controls changes. */
  function settingsChanged() {
    if (player.state !== 'idle') { player.stop(); syncControls(); }
    if (state.bars) { recompose(); renderScore(); }
    renderBars(); highlight(-1); updateUrl();
  }
  function query() {
    return encodeState({ pairs: state.pairs, locks: state.locks, extra: game.encodeSettings ? game.encodeSettings(state.settings) : {} });
  }
  function updateUrl() {
    if (!state.bars) return;
    history.replaceState(null, '', `${location.pathname}?${query()}`);
  }
  function shareUrl() { return `${location.origin}${location.pathname}?${query()}`; }

  // ---------- audio ----------
  async function ensureRendered() {
    // The plan can change while this yields (a reroll, a setting). Keep going until a pass
    // finds nothing missing for the plan as it stands now.
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
      if (!state.rendered.has(step.key) && !missing.some((m) => m.key === step.key)) missing.push(step);
    }
    if (!missing.length) return;
    state.busy = true; renderBars();
    say(`Preparing sound (${missing.length} ${missing.length === 1 ? noun : noun + 's'})…`, { sticky: true });
    try {
      for (let i = 0; i < missing.length; i++) {
        state.rendered.set(missing[i].key, game.render(missing[i], sr, state));
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
    play.setAttribute('aria-label', playing ? 'Pause playback' : paused ? 'Resume playback' : `Play the ${game.pieceNoun || 'piece'}`);
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
          player.load(state.plan, state.rendered);
          player.pausedAtSample = Math.round(from * player.sampleRate / oldRate); player.state = 'paused';
        }
        player.play(); return;
      }
      await player.ensureContext();
      await ensureRendered();
      if (player.state !== 'idle') return;   // something changed while rendering
      player.load(state.plan, state.rendered);
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
      // The export is the same steps, the same buffers and the same spacing as playback.
      const sr = player.ctx ? player.sampleRate : 44100;
      if (state.renderedRate !== sr) { state.rendered.clear(); state.renderedRate = sr; }
      await ensureRendered();
      const mix = mixdown(state.plan, state.rendered, sr);
      download(new Blob([encodeWav(mix, sr)], { type: 'audio/wav' }), `${game.fileStem(state)}.wav`);
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
        await navigator.share({ title: game.shareTitle, url });
        say('Shared.');
      } else {
        await navigator.clipboard.writeText(url);
        say(`Link copied to the clipboard. It restores these dice, locks${game.settingsNote ? ' and ' + game.settingsNote : ''}.`);
      }
    } catch {
      out.focus(); out.select();
      say('Copy the link from the box below.', { sticky: true });
    }
  }

  // ---------- wiring ----------
  buildGrid();
  $('#roll').addEventListener('click', () => { setPairs(rollAll()); say(`Rolled two dice for each of the 16 ${noun}s.`); });
  $('#roll-unlocked').addEventListener('click', () => {
    const n = state.locks.filter(Boolean).length;
    setPairs(rollUnlocked(state.pairs, state.locks));
    say(n ? `Rerolled ${BARS - n} ${noun}s; ${n} locked ${noun}${n === 1 ? '' : 's'} kept.` : `Rerolled all 16 ${noun}s (none were locked).`);
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
      say(`${cap(noun)} ${bar + 1} rerolled: ${b.dice[0]} + ${b.dice[1]} = ${b.sum}, ${game.cardText(b, state)}.`);
      btn.focus();
    }
  });
  $('#play').addEventListener('click', onPlay);
  $('#stop').addEventListener('click', () => { player.stop(); syncControls(); });
  $('#download').addEventListener('click', onDownload);
  $('#share').addEventListener('click', onShare);
  $('#save-score').addEventListener('click', onSaveScore);
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
  if (game.bindSettings) game.bindSettings(state, settingsChanged);

  if (!player.supported) say('This browser has no Web Audio support, so nothing can be played here.', { error: true, sticky: true });

  const link = decodeState(location.search);
  let settingsError = null;
  if (!link.error && link.params && game.decodeSettings) settingsError = game.decodeSettings(link.params, state.settings);
  if (link.error || settingsError) {
    say(link.error || settingsError, { error: true, sticky: true });
    history.replaceState(null, '', location.pathname);
  } else if (!link.empty) {
    state.locks = link.locks;
    if (game.applySettings) game.applySettings(state.settings);
    setPairs(link.pairs, { fromLink: true });
    say('Composition restored from the link.');
  } else if (game.applySettings) {
    game.applySettings(state.settings);
  }
  renderBars();
  syncControls();

  // A hook for the automated tests: the same bytes the Download button writes.
  window.__mozart = {
    state, player,
    exportBytes: async () => { const sr = player.ctx ? player.sampleRate : 44100; if (state.renderedRate !== sr) { state.rendered.clear(); state.renderedRate = sr; } await ensureRendered(); return new Uint8Array(encodeWav(mixdown(state.plan, state.rendered, sr), sr)); },
    stepStarts: () => state.plan.map((s) => Math.round(s.at * player.sampleRate)),
    scoreReady: () => Boolean(scoreEl.querySelector('svg')),
    cardsPerRow: () => layoutGrid(),
    barsPerLine: () => barsPerLineFor(layoutWidth()),
    scoreIndexOf: (step) => game.scoreIndex(step),
  };
  return { state, player, say };
}
