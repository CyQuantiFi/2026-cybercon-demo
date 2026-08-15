# CyberCon 2026 — live crowd-forecasting demo

The seven-minute demo for the CyQuantiFi "Experts as a Service" session. The
audience scans a QR code, forecasts one real dated question, and a presenter
board resolves the room, an LLM participant and the FAIR chain into a dollar
range while they watch.

It is a demonstration instrument, not the product. It has no accounts, no
track-record weighting, no tenancy, and it is not meant to grow any.

## What it has to do

| | |
|---|---|
| QR scan to submitted forecast | under 45 seconds, no account, no app |
| Board updates | live, no refresh, ~150 phones on venue Wi-Fi |
| If the network dies entirely | the same board runs the whole narration off a bundled snapshot |

## Run it locally

```bash
npm install
npm run dev          # http://localhost:8787
npm run seed         # 20 forecasts from the pre-conference panel round
```

Then open:

| Path | What it is |
|---|---|
| `/` or `/f` | participant app — the QR target |
| `/board` | presenter board, authored at 1920×1080 and scaled to fit |
| `/board?offline=1` | the same board running entirely off the bundled snapshot |
| `/mod` | moderation view — paste the token, one tap to approve |
| `/privacy` | privacy policy |

`npm test` runs 43 unit tests over the aggregation and the Monte Carlo.

## Architecture

One Cloudflare Worker with static assets. Assets are matched first; anything
that is not a file on disk falls through to `src/index.js`.

```
POST /api/f      append or edit a forecast          ← the two routes 150 phones hit
GET  /api/agg    read the aggregate (ETag, 2s poll)
POST /api/mod/*  moderation, token-gated            ← one phone, off the hot path
POST /api/model/rerun   optional live model call
```

**Storage** is a Durable Object (`src/session-do.js`) with SQLite, not KV: the
whole demo happens inside a seven-minute window, and KV's eventual consistency
would show the board a stale count while people are still submitting. A KV key
mirrors the last aggregate as a read-cheap fallback if the DO is unreachable.

**The maths** lives in `public/js/aggregate.js` and `public/js/montecarlo.js`.
The Worker imports `aggregate.js` directly, and the board loads it as a plain ES
module — one implementation, no drift between what the server computes and what
the board draws. Every constant is exported and printed on the board so the
audience can audit the arithmetic while it happens.

**No build step.** No framework, no bundler for the site, no third-party
scripts. Funnel Display is self-hosted (17KB), because the venue Wi-Fi is
expected to be hostile and a font that fails to load is a board that renders in
Arial.

### Deviations from the spec, and why

- **Workers with static assets, not Pages + Functions.** Cloudflare does not
  permit defining a Durable Object inside a Pages project, so §5 as written
  needs two deploys and a cross-script binding. This is one deploy with the same
  static files, the same two routes and the same DO.
- **Per-IP rate limit is 240/minute, not tight.** Venue Wi-Fi NATs the entire
  room behind a handful of addresses. A tight per-IP cap does not stop a ballot
  stuffer; it locks out the audience, at exactly the moment the board is on
  screen. The real controls are one-forecast-per-client-id with edit-in-place,
  and Turnstile. See the comment in `src/session-do.js`.
- **The moderation and model-rerun routes exist** beyond §5's "two routes,
  nothing else". That budget is about the hot path; these are used by one phone
  in your pocket and one keypress.

## Secrets

None are required to run locally. Set them for the deploy:

```bash
npx wrangler secret put ANTHROPIC_API_KEY   # the LLM participant, server side only
npx wrangler secret put MOD_TOKEN           # unlocks the moderation view
npx wrangler secret put TURNSTILE_SECRET    # optional; unset = no challenge
```

For local dev, put them in `.dev.vars` (gitignored):

```
MOD_TOKEN=local-dev-token
```

Turnstile also needs its public half in `wrangler.jsonc` under
`vars.TURNSTILE_SITE_KEY`.

## Deploy

```bash
npx wrangler kv namespace create AGG_KV     # paste the id into wrangler.jsonc
npm run deploy
```

Point a custom domain at it and make the QR target a short path — `/f` is
already wired and answers without a redirect.

## Stage-day runbook

**A week out**

1. Check both questions. If Q1 has already resolved, set `activeFrequency` to
   `"q1b"` in `public/data/questions.json`. Nothing else changes.
2. Dry run with 20+ real people. Keep that data:
   `node scripts/snapshot.mjs --from-live https://your.domain --token $MOD_TOKEN`
   — it becomes both the seed and the offline snapshot.
3. `npm run qr -- https://your.domain/f`, print it at slide scale, scan it from
   the back row. Put the short link on the slide as text too.

**The morning of**

4. `npm run model` — calls the model, writes `public/data/model.json`. Then
   `npm run snapshot` so the offline board matches, then `npm run deploy`.
   `node scripts/model-participant.mjs --check` confirms the artefact is fresh
   and that the prompt has not changed since it was made.
   **The artefact in the repo is a placeholder and the board says so in pink on
   Panel B until you replace it.**
5. `npm run seed -- https://your.domain` so the histogram is never empty.
6. Open `/board` in the same browser as the deck. Open `/mod` on your phone.

**Rehearse the failure path, not just the happy one**

7. Open `/board?offline=1` and run the whole narration with the network off.
   That is the path §9 says to rehearse, and it is the one you will be glad of.

**On stage**

| Key | |
|---|---|
| `→` / `space` | reveal the next panel |
| `1`–`4` | jump to a panel, `0` hides all |
| `R` | re-run the model live — optional theatre, 6s timeout, silent fallback |
| `S` | force the snapshot |

**Resolution day**

```bash
curl -H "x-mod-token: $MOD_TOKEN" https://your.domain/api/mod/export?include=contacts > dump.json
node scripts/score.mjs --export dump.json --outcome yes
```

Writes Brier and log scores per forecaster, the benchmark table, a recipient
list deduplicated by address, and a rendered outcome notice. **The send path is
deliberately unwired** — choosing a mail provider means naming it in the APP 8
disclosure in `public/privacy.html` first. This step is what turns a demo into a
track record; it is the only part of this repo that matters in a year.

## Privacy

The email address is the only personal information collected, so it carries the
obligations. Built to the Australian Privacy Principles rather than to a policy
written afterwards:

- Optional, and the forecast is already saved before the field is shown. It
  gates nothing.
- Written to a separate table (`emails`) that no board-reachable route reads.
  The aggregate the board polls has no field that could hold personal
  information — there is a test that asserts this and it should stay passing.
- Two separate unticked boxes. Marketing needs its own tick; bundled consent is
  not consent. The exact notice version is stored with the consent.
- The collection notice is inline above the field, with the policy linked from
  the notice itself.
- `?include=contacts` is required to export addresses at all, so the routine
  export carries none.

**Not legal advice.** The wording in `public/privacy.html` and the inline notice
ship as specified and need review before the conference — particularly the APP 8
overseas-disclosure statement, which also needs the mail provider named once one
is chosen.

## Layout

```
wrangler.jsonc              assets, Durable Object, KV, vars
src/index.js                router; everything else falls through to assets
src/session-do.js           forecasts / emails / notes, rate limit, aggregate cache
src/turnstile.js            fails open on a network error, on purpose
public/index.html           participant app, six screens
public/board.html           presenter board, four panels
public/mod.html             moderation view
public/privacy.html         the light document surface
public/css/tokens.css       design tokens, extracted from the deck
public/js/aggregate.js      §7 — shared with the Worker
public/js/montecarlo.js     §8 — FAIR chain, 10,000 iterations
public/data/questions.json  Q1, Q2, the backup question, resolution criteria
public/data/model-prompt.txt  the prompt, in the repo for audit
public/data/model.json      cached model artefact (placeholder until you run it)
public/data/snapshot.json   the offline board
scripts/                    model, seed, snapshot, qr, score
test/                       43 tests over the maths
```

## Design

Tokens are lifted from `__S_Keogh__Presentation__1.0.pptx`, not invented, so the
app and the deck read as the same object when they are projected one after the
other. The deck runs two surfaces: dark `#05050A` for moment slides, white for
content slides. The app lives on the dark one, continuing slide 3 — the slide
people are looking at when they scan.

```
--ink #101014   --ink-deep #05050A   --surface #2A2A33
--paper #FFFFFF --paper-tint #FAFAFB --paper-pink #FFF5FA
--rule #E4E4EA
--muted #4A4A55 … --dim-2 #B6B6C0
--pink #FF2FA0 / #C2166F      crowd, live, money
--cyan #29C8FF / #0E7FA8      model, inputs
```

Eyebrows are uppercase, weight 700, tracked at `.18em`, pink. Headlines are
weight 700 at `-.02em`. Structure is hairline rules and pink numerals — the deck
uses no boxes and no shadows, and neither does this.

The board's type scale is derived from the deck's own: at 21.99in wide, one
slide point is ≈1.21 board pixels, so the deck's 70.9pt headline and this
board's largest figures are the same size to the back row.
