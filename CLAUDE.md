# Musical Dice Game — working notes

The Musikalisches Würfelspiel K. 516f in the browser: roll dice, hear the minuet, download it. One static page.

Served at **https://dicemusic.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

Fully **static**: the site is files served straight by nginx. No build step,
no app process, no local port, no pm2, no database. nginx serving the git
checkout *is* the deployment, so "what's on `main`" and "what's live" differ
only by a `git reset` on the droplet.

- Repo: `ivjames/dicemusic` · droplet checkout: `/var/www/dicemusic` (the web root)
- Operate CLI: `bin/dicemusic`, symlinked to `/usr/local/bin/dicemusic`
- vhost: generated from `deploy/nginx.conf.template` by `dicemusic setup`

## Deploying

On the droplet, as root:

```bash
dicemusic deploy      # git fetch + reset --hard origin/main (+ build stamp)
dicemusic status      # HEAD, live probe, cert days remaining
```

Full runbook, including first-time bring-up: `DEPLOY.md`.

Checking what is actually live, concretely for this site — `dicemusic status`
on the box, or from anywhere:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://dicemusic.lab980.com/
curl -s https://dicemusic.lab980.com/ | grep -o "const BUILD = '[^']*'" | head -1
```

(The second line reports nothing if the page carries no `BUILD` constant — see
the deploy stamp note in `DEPLOY.md`. `head -1` because a page that polls its
own build stamp carries a matching regex literal, which grep otherwise reports
as a phantom second build.)

## This site

- The app is a set of ES modules under `js/` loaded by `index.html`; the score
  data, the sources it was taken from, the tests and the known limits are in
  `README.md`. The one third-party file is `js/vendor/abcjs-basic-min.js`
  (MIT), loaded on demand to engrave the score; nothing is fetched from a CDN.
- Tests: `node test/run.mjs` (Node) and `node test/browser.cjs` (Playwright,
  headless Chromium). Run both before opening a PR.
- The vhost serves `index.html` as `no-cache` but the modules under `js/` with
  nginx's default (heuristic) caching. `index.html` therefore references every
  module through an import map with `?v=<build>` URLs, and `dicemusic deploy`
  stamps the commit into those and into the page's `BUILD` constant. A new
  module file needs an import-map entry in `index.html` (the test suite checks).

## Things worth knowing

- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). Don't commit secrets;
  there is no `.env` on a static site.
- There is no `.env` here and nothing to keep out of git beyond that — a
  static site has no secrets to hold.
