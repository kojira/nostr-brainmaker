# 🧠 Nostr 脳内メーカー (nostr-brainmaker)

A fully static, client-side web app that takes a **Nostr** identity
(`npub` / hex pubkey / `nprofile`), fetches that author's posts from the last
N days directly from Nostr relays in the browser, analyzes the text, and renders
a **脳内メーカー (brain-maker)** style image you can download as PNG.

No backend. No server. Everything runs in the browser and deploys to GitHub Pages.

**Live demo:** https://kojira.github.io/nostr-brainmaker/

![screenshot](docs/screenshot.png)

## Features

- Accepts **npub**, **hex pubkey**, or **nprofile** (relay hints in an nprofile are used).
- Fetches `kind:1` notes from the last 3 / 7 / 14 / 30 days via `nostr-tools` `SimplePool`.
- Heuristic tokenization (Latin words + Japanese runs & bigrams) with a stopword list and frequency analysis.
- Words placed inside a hand-drawn brain, sized by frequency and colored by category
  (愛情 / 仕事 / 欲望 / 遊び / 悩み / その他).
- Shows exactly **what was fetched and from which relays**.
- One-click **PNG export**.
- Deep links: `?npub=npub1...` auto-runs on load.

## Stack

- **Vite** (vanilla JS, no framework) — builds to a static bundle.
- **nostr-tools** — `nip19` decoding + relay querying.
- **Canvas 2D** — rendering and PNG export.
- **Vitest** — unit tests for the text-analysis helpers.

## Architecture

```
index.html          # markup + mount points
src/
  main.js           # UI wiring: input → fetch → analyze → render
  nostr.js          # resolveInput() + fetchRecentNotes() + fetchProfile()  (network)
  analyze.js        # cleanText / tokenize / countFrequencies / topTerms /
                    # categorize / buildBrainModel  (pure, fully tested)
  brain.js          # renderBrain() canvas drawing + exportCanvas()
  style.css
tests/
  analyze.test.js   # unit tests for the pure helpers
.github/workflows/
  deploy.yml        # CI: test + build + deploy to GitHub Pages
vite.config.js      # base path = /<repo>/ for Pages
```

Data flow: `resolveInput` decodes the identity → `fetchRecentNotes` queries
relays for the author's recent `kind:1` events → their `content` is concatenated
and passed to `buildBrainModel` → `renderBrain` draws the result to a canvas.

The analysis layer (`analyze.js`) is intentionally free of DOM and network code
so it can be unit-tested in Node.

## Setup

```bash
npm install
```

## Develop

```bash
npm run dev      # local dev server (http://localhost:5173)
```

## Test

```bash
npm test         # vitest run
```

## Build

```bash
npm run build    # outputs static site to ./dist
npm run preview  # preview the production build
```

For a custom base path (e.g. custom domain at root):

```bash
BASE_PATH=/ npm run build
```

## Deploy (GitHub Pages)

Deployment is automated via GitHub Actions (`.github/workflows/deploy.yml`):

1. Push to `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The workflow runs tests, builds with `BASE_PATH=/<repo-name>/`, and publishes `dist/`.

The published URL is `https://<user>.github.io/<repo-name>/`.

## Notes & limitations

- Japanese tokenization is heuristic (no morphological analyzer in the browser),
  so "words" are whitespace/punctuation chunks plus Japanese character runs and bigrams.
  It's tuned to be *fun and usable*, not linguistically precise.
- Relay availability varies; if no notes are found, try a different period or an
  identity with public relay activity. Default relays:
  `yabu.me`, `r.kojira.io`, `x.kojira.io`.
- All processing is local; nothing is sent to any server other than the public
  Nostr relays you query.

## License

MIT
