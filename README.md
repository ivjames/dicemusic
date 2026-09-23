# dicemusic — Musical Dice Game

A static, client-side implementation of the *Musikalisches Würfelspiel* K. 516f, the
musical dice game commonly attributed to Mozart. One page, no build step, no server code:
`index.html` loads ES modules from `js/` and everything else happens in the browser.

Press **Roll & Compose**: two fair dice are rolled for each of the 16 bars, each total is
looked up in the published Simrock table, and the selected measures are synthesised and
played with the Web Audio API. Bars can be locked and rerolled, the result downloaded as
WAV, and the exact composition shared by URL.

## Files

- `index.html`, `style.css` — the page. One screen: controls, the sixteen bars, a short
  "How it works" and the source credits.
- `js/table.js` — the minuet lookup table (dice total 2–12 × bar 1–16 → measure 1–176),
  as printed by Simrock (1793) and reproduced on the Princeton COS 126 assignment page.
- `js/dice.js` — two independent fair dice per bar; totals and measure numbers are always
  derived from the stored faces, never stored themselves.
- `js/share.js` — the shareable URL: `?d=<32 faces>&l=<locks, hex>&r=1`. Validated on read;
  a malformed link shows a notice and loads nothing.
- `js/score.js` — the 176 measures as note events (generated, see below).
- `js/synth.js` — timing (♪ = 116, so a 3/8 bar is 1.552 s), a small additive struck-string
  voice, ornament realisation, the playback plan (with or without the printed repeats) and the
  `mixdown` that the WAV export writes. Pure Float32Array arithmetic, so it runs in Node too.
- `js/player.js` — Web Audio playback: every bar is scheduled on one clock at exactly
  `k × barSamples`, so there are no gaps; pause remembers a sample position and resume
  reschedules from it; a context suspended by the system is surfaced as a pause.
- `js/wav.js` — 16-bit PCM mono WAV encode/decode.
- `js/notation.js` — the composed minuet as ABC notation (two staves, the printed repeat with
  both endings of bar 8), engraved in the page by the vendored `js/vendor/abcjs-basic-min.js`
  (abcjs 6.7.1, MIT). The current measure is highlighted during playback and the score can be
  saved as SVG.
- `js/app.js` — UI wiring. Any edit to the composition during playback stops it and resets
  the playhead first. `window.__mozart` is a hook for the browser tests.

## Where the music comes from

Princeton's `mozart.zip` recordings were **not** reused: the archive and page state no
licence (the page carries only "Copyright © 2004"), and a pitch analysis of the files showed
they do not even follow the Simrock measure numbering that the table indexes (M1 is not
measure 1 of the print, and the set appears to be in another key). The notes here come from
the public-domain score instead, via three independent machine-readable transcriptions:

- Justine Leon A. Uro, `abcmdg-k516f-bymeas.abc` (CC BY 4.0) — <https://github.com/justineuro/mdginabc2svg>
- Craig Stuart Sapp, Daniel Shanahan, Mauricio Rodriguez, `mozart-kanhc30-01.krn` — <https://github.com/craigsapp/Musikalisches-Wuerfelspiel>
- Moisés Cachay, `score.ly` (Apache 2.0) — <https://github.com/Xpktro/wurfelspiel>

The three were parsed to a common event form and compared measure by measure. They agreed on
158 of 176 measures outright; the 18 that differed were settled by per-staff majority vote,
and each of those was also read against the Simrock print (IMSLP #20432, pp. 3–6). Bar 132,
where all three differed, was taken from the print: `[e c] | [d B] [B G] | G`. The eleven
bar-8 measures carry both printed endings; straight-through playback uses the second (the
one that leads on to bar 9). "Play with repeats" follows the print and the Humdrum edition's
expansion `[A,A1,A,A2,B]`: the first half twice with the first ending the first time round,
then the second half once. The
generator script and the comparison tooling are not in this repo; `js/score.js` is the output
and records its provenance in its header.

## Tests

```bash
node test/run.mjs          # table completeness, regression, dice distribution, URL codec, rendering, WAV
node test/browser.cjs [baseUrl]   # Playwright end-to-end, writes test/shots/
```

The browser suite needs Playwright's Chromium; it starts `http-server` on port 8123 when no
base URL is given. Screenshots land in `test/shots/` (gitignored). Set `NODE_PATH` to a global `node_modules` that holds Playwright if it is not installed locally.

## Known limits

- The trio (one die, measures T1–T96) is not implemented.
- The tone is a synthesised struck string, not a sampled fortepiano.
- Modules under `js/` are cached heuristically by browsers after a deploy; only `index.html`
  is served `no-cache`. See `DEPLOY.md` for the droplet side.
