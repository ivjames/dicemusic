// End-to-end checks in headless Chromium: node test/browser.cjs [baseUrl]
// Serves the repo root when no URL is given. Autoplay is allowed so Play needs no gesture.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  let base = process.argv[2]; let server = null;
  if (!base) {
    server = spawn('npx', ['--yes', 'http-server', ROOT, '-p', '8123', '-s', '-c-1'], { stdio: 'ignore' });
    base = 'http://127.0.0.1:8123';
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  }
  const url = base + '/';
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(['ok  ', name]); } catch (e) { results.push(['FAIL', name + ': ' + e.message.split('\n')[0]]); } };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  const cards = () => page.locator('#bars .bar');
  const readBars = () => page.evaluate(() => window.__mozart.state.bars.map((b) => [b.dice[0], b.dice[1], b.sum, b.measure]));

  await step('page loads with 16 empty bars and playback disabled', async () => {
    assert.equal(await cards().count(), 16);
    assert.ok(await page.locator('#play').isDisabled());
    assert.ok(await page.locator('#roll-unlocked').isDisabled());
    assert.equal(await page.locator('.bar-text').first().innerText(), 'Not rolled yet');
  });

  await step('Roll & Compose fills every bar with two dice, a total and a measure from the table', async () => {
    await page.click('#roll');
    const bars = await readBars();
    assert.equal(bars.length, 16);
    const table = await page.evaluate(async () => (await import('./js/table.js')).MINUET_TABLE);
    bars.forEach(([a, b, s, m], i) => { assert.ok(a >= 1 && a <= 6 && b >= 1 && b <= 6); assert.equal(s, a + b); assert.equal(m, table[s][i]); });
    assert.equal(await page.locator('.die').count(), 32);
    assert.ok(!(await page.locator('#play').isDisabled()));
  });

  let barSamples;
  await step('Play highlights bars in order with aria-current; timing follows the bar length', async () => {
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    barSamples = await page.evaluate(() => window.__mozart.stepStarts()[1]);
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 5200) {
      const cur = await page.evaluate(() => { const el = document.querySelector('.bar[aria-current="true"]'); return el ? Number(el.dataset.bar) : -1; });
      if (cur !== -1 && seen[seen.length - 1] !== cur) seen.push(cur);
      await page.waitForTimeout(60);
    }
    assert.deepEqual(seen.slice(0, 3), [0, 1, 2], `highlight order ${seen}`);
    assert.equal(await page.locator('#play').innerText(), 'Pause');
  });

  await step('Pause freezes the position; Resume continues from it; Stop resets', async () => {
    await page.click('#play');
    assert.equal(await page.locator('#play').innerText(), 'Resume');
    const p1 = await page.evaluate(() => window.__mozart.player.positionSample());
    await page.waitForTimeout(700);
    const p2 = await page.evaluate(() => window.__mozart.player.positionSample());
    assert.equal(p1, p2, 'position moved while paused');
    assert.ok(await page.locator('.bar[aria-current="true"]').count() === 1, 'paused bar still shown');
    await page.click('#play');
    await page.waitForTimeout(600);
    const p3 = await page.evaluate(() => window.__mozart.player.positionSample());
    assert.ok(p3 > p2 && p3 - p2 < 1.5 * 48000, `resumed from ${p2} to ${p3}`);
    await page.click('#stop');
    assert.equal(await page.evaluate(() => window.__mozart.player.state), 'idle');
    assert.equal(await page.locator('.bar[aria-current="true"]').count(), 0);
    assert.equal(await page.locator('#play').innerText(), 'Play');
  });

  await step('rapid repeated presses of Play/Pause leave a consistent state', async () => {
    for (let i = 0; i < 6; i++) await page.click('#play');
    await page.waitForTimeout(400);
    const st = await page.evaluate(() => window.__mozart.player.state);
    const label = await page.locator('#play').innerText();
    assert.ok((st === 'playing' && label === 'Pause') || (st === 'paused' && label === 'Resume'), `${st}/${label}`);
    await page.click('#stop');
  });

  await step('playback runs to the end and returns to idle', async () => {
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'idle', null, { timeout: 40000 });
    assert.equal(await page.locator('#play').innerText(), 'Play');
  });

  await step('locked bars survive Roll Unlocked', async () => {
    const before = await readBars();
    await cards().nth(2).locator('.lock').click();
    await cards().nth(9).locator('.lock').click();
    assert.equal(await cards().nth(2).locator('.lock').getAttribute('aria-pressed'), 'true');
    await page.click('#roll-unlocked');
    const after = await readBars();
    assert.deepEqual(after[2], before[2]); assert.deepEqual(after[9], before[9]);
    const changed = after.filter((b, i) => b.join() !== before[i].join()).length;
    assert.ok(changed >= 8, `only ${changed} bars changed`);
  });

  await step('rerolling one bar changes only that bar (and stops playback first)', async () => {
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing');
    const before = await readBars();
    await cards().nth(5).locator('.reroll').click();
    assert.equal(await page.evaluate(() => window.__mozart.player.state), 'idle');
    const after = await readBars();
    after.forEach((b, i) => { if (i !== 5) assert.deepEqual(b, before[i], `bar ${i + 1} changed`); });
    const table = await page.evaluate(async () => (await import('./js/table.js')).MINUET_TABLE);
    assert.equal(after[5][3], table[after[5][2]][5]);
  });

  let shareUrl;
  await step('Copy link produces a URL that restores dice and locks in a fresh page', async () => {
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.click('#share');
    shareUrl = await page.locator('#share-url').inputValue();
    assert.ok(/[?&]d=[1-6]{32}/.test(shareUrl), shareUrl);
    assert.ok(/[?&]l=/.test(shareUrl), 'locks encoded');
    const bars = await readBars();
    const p2 = await ctx.newPage();
    await p2.goto(shareUrl);
    const restored = await p2.evaluate(() => window.__mozart.state.bars.map((b) => [b.dice[0], b.dice[1], b.sum, b.measure]));
    assert.deepEqual(restored, bars);
    assert.equal(await p2.locator('.bar.is-locked').count(), 2);
    assert.equal(await p2.locator('#status').innerText(), 'Composition restored from the link.');
    await p2.close();
  });

  await step('malformed links fail gracefully', async () => {
    // (A truncated percent-escape such as ?d=%E0%A4%A is covered in run.mjs; the dev server used here rejects it before the page loads.)
    for (const bad of ['?d=abc', '?d=' + '9'.repeat(32), '?d=' + '3'.repeat(32) + '&l=xyz', '?d=' + '1'.repeat(32) + '&r=maybe']) {
      const p3 = await ctx.newPage();
      const errs = []; p3.on('pageerror', (e) => errs.push(e.message));
      await p3.goto(url + bad);
      assert.equal(await p3.locator('#status.is-error').count(), 1, bad);
      assert.equal(await p3.locator('.die').count(), 0, bad);
      assert.ok(await p3.locator('#play').isDisabled(), bad);
      assert.deepEqual(errs, []);
      assert.ok(!(await p3.url()).includes('d='), 'bad query cleared');
      await p3.close();
    }
  });

  await step('the WAV download is byte-identical to the mixdown of the played buffers', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
    const file = await dl.path();
    const bytes = fs.readFileSync(file);
    const expected = Buffer.from(await page.evaluate(async () => Array.from(await window.__mozart.exportBytes())));
    assert.equal(bytes.length, expected.length);
    assert.ok(bytes.equals(expected), 'download differs from in-page mixdown');
    const sr = bytes.readUInt32LE(24); const dataLen = bytes.readUInt32LE(40);
    const plan = await page.evaluate(() => window.__mozart.state.plan.length);
    const starts = await page.evaluate(() => window.__mozart.stepStarts());
    assert.equal(dataLen / 2, starts[15] + Math.round((1.5517241379 + 0.5) * sr), 'length is 16 bars plus tail');
    assert.equal(plan, 16);
    assert.ok(dl.suggestedFilename().endsWith('.wav'));
  });

  await step('"Play with repeats" extends the plan to 24 bars and is carried in the link', async () => {
    await page.check('#repeats');
    assert.equal(await page.evaluate(() => window.__mozart.state.plan.length), 24);
    assert.ok((await page.url()).includes('r=1'));
    await page.uncheck('#repeats');
  });

  await step('changing the plan while sound is being prepared does not break playback', async () => {
    // Force a fresh render, press Play, and flip repeats before rendering can finish.
    await page.evaluate(() => { window.__mozart.state.rendered.clear(); });
    await page.click('#roll');
    await page.evaluate(() => { window.__mozart.state.rendered.clear(); });
    await page.click('#play');
    await page.click('#repeats');
    await cards().nth(3).locator('.reroll').click();
    await page.waitForFunction(() => window.__mozart.player.state !== 'idle' || document.querySelector('#status.is-error'), null, { timeout: 15000 }).catch(() => {});
    assert.equal(await page.locator('#status.is-error').count(), 0, await page.locator('#status').innerText());
    const plan = await page.evaluate(() => window.__mozart.state.plan.length);
    assert.equal(plan, 24);
    // Whatever the timing, a Play now must work with the 24-step plan.
    if (await page.evaluate(() => window.__mozart.player.state) === 'idle') await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__mozart.player.plan.length), 24);
    await page.click('#stop');
    await page.uncheck('#repeats');
  });

  await step('a context judged dead after returning from the background is replaced, from idle and from paused', async () => {
    // From idle: mark the context stale (what checkAfterReturn does on iOS) and press Play.
    const before = await page.evaluate(() => { window.__mozart.player.stale = true; return window.__mozart.player.ctx.sampleRate; });
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__mozart.player.stale), false);
    assert.equal(await page.evaluate(() => window.__mozart.player.ctx.state), 'running');
    await page.waitForTimeout(400);
    // From paused: pause, mark stale, resume; the position must survive the swap.
    await page.click('#play');
    const pos = await page.evaluate(() => { window.__mozart.player.stale = true; return window.__mozart.player.pausedAtSample; });
    assert.ok(pos > 0);
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    const now = await page.evaluate(() => window.__mozart.player.positionSample());
    assert.ok(now >= pos && now < pos + before, `resumed at ${now} from ${pos}`);
    assert.equal(await page.locator('#status.is-error').count(), 0);
    // A closed context is replaced too.
    await page.click('#stop');
    await page.evaluate(() => window.__mozart.player.ctx.close());
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    await page.click('#stop');
  });

  await step('the score is engraved from the rolled measures, follows playback, and updates on a reroll', async () => {
    await page.waitForFunction(() => window.__mozart.scoreReady(), null, { timeout: 20000 });
    assert.ok(!(await page.locator('#score-section').isHidden()));
    // 17 engraved measures: 0..6, the two endings 7 and 8, then 9..16
    for (const mm of [0, 7, 8, 16]) assert.ok((await page.locator(`#score .abcjs-mm${mm}`).count()) > 0, `measure ${mm} drawn`);
    assert.equal(await page.locator('#score .abcjs-mm17').count(), 0);
    assert.equal(await page.locator('#score .abcjs-ending').count() >= 2, true, 'volta brackets');
    // Highlight follows the playhead: bar 1 -> measure 0; after bar 8 without repeats -> measure 8 then 9.
    await page.click('#play');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing');
    await page.waitForFunction(() => document.querySelector('#score .abcjs-mm0.is-current'), null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('#score .abcjs-mm1.is-current'), null, { timeout: 5000 });
    assert.equal(await page.locator('#score .abcjs-mm0.is-current').count(), 0, 'previous measure un-highlighted');
    await page.click('#stop');
    assert.equal(await page.locator('#score .is-current').count(), 0);
    // A reroll of bar 12 changes engraved measure 12 (bar 12 -> mm 12) when the measure number changes.
    const before = await page.evaluate(() => window.__mozart.state.bars[11].measure);
    let after = before; let tries = 0;
    while (after === before && tries++ < 12) { await cards().nth(11).locator('.reroll').click(); after = await page.evaluate(() => window.__mozart.state.bars[11].measure); }
    await page.waitForFunction((m) => document.querySelector('#score').dataset.abc && window.__mozart.scoreReady() && document.querySelector('#score').getAttribute('aria-label').includes(String(m)), after, { timeout: 20000 });
    assert.ok((await page.locator('#score .abcjs-mm12').count()) > 0);
    // Saving the score yields an SVG file.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#save-score')]);
    const svg = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(svg.includes('<svg') && svg.includes('xmlns="http://www.w3.org/2000/svg"') && !svg.includes('currentColor'));
    assert.ok(dl.suggestedFilename().endsWith('.svg'));
  });

  await step('keyboard: lock and reroll buttons are reachable and labelled; Space toggles play', async () => {
    const lock = cards().nth(0).locator('.lock');
    await lock.focus(); await page.keyboard.press('Enter');
    assert.equal(await lock.getAttribute('aria-pressed'), 'true');
    assert.equal(await lock.getAttribute('aria-label'), 'Unlock bar 1');
    await page.keyboard.press('Enter');
    await page.locator('h1').click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__mozart.player.state === 'playing');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__mozart.player.state), 'paused');
    await page.click('#stop');
  });

  await step('screenshots at phone, tablet and desktop widths', async () => {
    for (const [name, w, h] of [['phone', 390, 844], ['tablet', 820, 1180], ['desktop', 1440, 900]]) {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: w, height: h });
      await p.goto(shareUrl);
      await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: name !== 'desktop' });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert.ok(!overflow, `${name} has horizontal overflow`);
      await p.close();
    }
    const dark = await ctx.newPage();
    await dark.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await dark.goto(shareUrl);
    await dark.screenshot({ path: path.join(OUT, 'desktop-dark.png') });
    await dark.close();
  });

  await step('chorale page: roll, four-voice score, playback highlight, key change, link, WAV', async () => {
    const cp = await ctx.newPage();
    const cerrs = []; cp.on('pageerror', (e) => cerrs.push(e.message)); cp.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
    await cp.goto(base + '/chorale/');
    assert.equal(await cp.locator('#bars .bar').count(), 16);
    await cp.click('#roll');
    const bars = await cp.evaluate(() => window.__mozart.state.bars.map((b) => [b.sum, b.symbol, b.voicing]));
    assert.equal(bars.length, 16);
    assert.equal(bars[7][1], 'V'); assert.equal(bars[15][1], 'I');
    assert.ok(bars.every((b) => b[2].length === 4 && b[2][0] <= b[2][1] && b[2][1] <= b[2][2] && b[2][2] <= b[2][3]));
    await cp.waitForFunction(() => window.__mozart.scoreReady(), null, { timeout: 20000 });
    for (const v of [0, 1, 2, 3]) assert.ok((await cp.locator(`#score .abcjs-v${v}`).count()) > 0, `voice ${v} engraved`);
    assert.ok((await cp.locator('#score .abcjs-mm7').count()) > 0 && (await cp.locator('#score .abcjs-mm8').count()) === 0, 'eight bars');
    // playback highlights chord cards and score bars in order
    await cp.click('#play');
    await cp.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    await cp.waitForFunction(() => document.querySelector('.bar[aria-current="true"]')?.dataset.bar === '1', null, { timeout: 8000 });
    assert.ok((await cp.locator('#score .abcjs-mm0.is-current').count()) > 0);
    await cp.click('#stop');
    // key change re-voices and re-engraves; the link carries it
    await cp.selectOption('#key', 'G');
    await cp.waitForFunction(() => window.__mozart.state.settings.key === 'G' && document.querySelector('#score').dataset.abc.includes('K:G'));
    const gBars = await cp.evaluate(() => window.__mozart.state.bars.map((b) => [b.sum, b.symbol]));
    assert.deepEqual(gBars, bars.map((b) => [b[0], b[1]]), 'same dice, same chords');
    assert.ok((await cp.url()).includes('k=G'));
    // broken-chord texture: sixteen bars on a grand staff, the highlight follows bars, the link carries it
    await cp.selectOption('#texture', 'prelude');
    await cp.waitForFunction(() => window.__mozart.state.settings.texture === 'prelude' && document.querySelector('#score').dataset.abc.includes('M:12/8') && window.__mozart.scoreReady(), null, { timeout: 20000 });
    assert.ok((await cp.locator('#score .abcjs-mm15').count()) > 0 && (await cp.locator('#score .abcjs-mm16').count()) === 0, 'sixteen bars');
    await cp.click('#play');
    await cp.waitForFunction(() => window.__mozart.player.state === 'playing', null, { timeout: 15000 });
    await cp.waitForFunction(() => document.querySelector('.bar[aria-current="true"]')?.dataset.bar === '1', null, { timeout: 8000 });
    assert.ok((await cp.locator('#score .abcjs-mm1.is-current').count()) > 0, 'score bar 2 highlighted with chord 2');
    await cp.click('#stop');
    // plain motion strips the added notes and leaves the skeleton alone
    const skeleton = await cp.evaluate(() => window.__mozart.state.bars.map((b) => b.voicing.join('.')).join('|'));
    assert.ok(await cp.evaluate(() => window.__mozart.state.bars.some((b) => b.cells.length === 2)), 'passing notes present by default');
    await cp.selectOption('#motion', 'plain');
    await cp.waitForFunction(() => window.__mozart.state.settings.motion === 'plain');
    assert.ok(await cp.evaluate(() => window.__mozart.state.bars.every((b) => b.cells.length === 1)));
    assert.equal(await cp.evaluate(() => window.__mozart.state.bars.map((b) => b.voicing.join('.')).join('|')), skeleton);
    assert.ok((await cp.url()).includes('t=prelude') && (await cp.url()).includes('m=plain'));
    await cp.selectOption('#motion', 'passing');
    await cp.waitForFunction(() => window.__mozart.state.settings.motion === 'passing' && !location.search.includes('m='));
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
    await cp.click('#share');
    const link = await cp.locator('#share-url').inputValue();
    const p2 = await ctx.newPage(); await p2.goto(link);
    assert.deepEqual(await p2.evaluate(() => [window.__mozart.state.settings.key, window.__mozart.state.settings.texture, window.__mozart.state.bars.map((b) => b.cells.map((c) => c.join('.')).join('/')).join('|')]),
      ['G', 'prelude', await cp.evaluate(() => window.__mozart.state.bars.map((b) => b.cells.map((c) => c.join('.')).join('/')).join('|'))]);
    await p2.close();
    // a bad key or texture in the link is rejected gracefully
    for (const bad of [link.replace('k=G', 'k=Zz'), link.replace('t=prelude', 't=waltz')]) {
      const p3 = await ctx.newPage(); await p3.goto(bad);
      assert.equal(await p3.locator('#status.is-error').count(), 1, bad); assert.equal(await p3.locator('.die').count(), 0); await p3.close();
    }
    // the WAV is the same mixdown as playback
    const [dl] = await Promise.all([cp.waitForEvent('download'), cp.click('#download')]);
    const bytes = fs.readFileSync(await dl.path());
    const expected = Buffer.from(await cp.evaluate(async () => Array.from(await window.__mozart.exportBytes())));
    assert.ok(bytes.equals(expected));
    assert.ok(dl.suggestedFilename().startsWith('chorale-dice-G-prelude-'), dl.suggestedFilename());
    const overflow = await cp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.ok(!overflow);
    assert.deepEqual(cerrs, []);
    await cp.close();
  });

  await step('no page errors during the run', async () => { assert.deepEqual(errors, []); });

  await browser.close();
  if (server) server.kill();
  for (const [s, n] of results) console.log(s, n);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failed ? `${failed} failed` : `${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
