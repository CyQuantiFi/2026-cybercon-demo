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
| `/mod` | moderation view — paste the token, one tap to approve, reset at the bottom |
| `/privacy` | privacy policy |

`npm test` runs 43 unit tests over the aggregation and the Monte Carlo.

## Architecture

One Cloudflare Worker with static assets. Assets are matched first; anything
that is not a file on disk falls through to `src/index.js`.

```
POST /api/f            append or edit a forecast     ← the two routes 150 phones hit
GET  /api/agg          read the aggregate (ETag, 2s poll)
GET  /api/mod/health   is MOD_TOKEN set? no token needed
GET/POST /api/mod/*    moderation, token-gated       ← one phone, off the hot path
POST /api/model/rerun  optional live model call
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
- **The rate limit counts distinct client ids, not requests.** Venue Wi-Fi NATs
  the whole room behind a handful of addresses, so every phone shares one
  counter. Counting requests would put ~150 forecasts, the second write from
  anyone who leaves an email, and every retry through bad Wi-Fi into the same
  bucket — comfortably over a few hundred in the minute after "scan now", and
  the 429s would be silent while the board's counter stalled. Since every write
  is `INSERT OR REPLACE` on a client uuid, only a previously unseen id can add a
  row, so only that is charged: retries, edits and the email step are free, and
  the 600/minute ceiling protects the one thing it should, a script inventing
  fresh uuids. A rejected id is remembered so its retries are re-evaluated but
  never re-charged — otherwise the room's own retry loop would hold the bucket
  full and extend its own lockout. See `src/session-do.js`.
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
npm run deploy
```

The KV namespace already exists (`cybercon-2026-demo-AGG_KV`,
`8d32bd288aa54ee29866461d9b17b56a`) and its id is in `wrangler.jsonc`. The
Durable Object and its migration are created by the first deploy.

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
5. `npm run check -- https://your.domain --token $MOD_TOKEN` — verifies the
   served bytes still match the repo, the aggregate leaks nothing, the snapshot
   is populated, and your moderation token actually works. Run it *before* you
   need any of that to be true on stage.
6. `npm run seed -- https://your.domain` so the histogram is never empty.
7. Open `/board` in the same browser as the deck. Open `/mod` on your phone.

**Rehearse the failure path, not just the happy one**

8. Open `/board?offline=1` and run the whole narration with the network off.
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
list deduplicated by address, and a rendered outcome notice quoting the question
and its resolution source verbatim.

**Send it by hand from Gmail** — paste the notice as a mail merge against
`recipients.csv`. There is no automated send, on purpose: at ~150 recipients it
is one mail merge, and a script holding Gmail credentials pointed at an address
list is a much larger thing to secure than this demo warrants. Check the
account's daily recipient cap first (2,000/day on Workspace, 500/day consumer).

This step is what turns a demo into a track record; it is the only part of this
repo that matters in a year.

## Resetting the session

`/mod` has a **Reset the session** panel at the bottom, collapsed and behind a
typed confirmation. It drops every forecast, every line of reasoning and every
email address, so the room starts at a real zero — for clearing rehearsal and
test data before the talk. The confirmation names the exact counts first, and
there is no undo. The model artefact survives, so you do not have to re-run it.

It also clears the KV mirror, which is the fallback the board reads when the
Durable Object is briefly unreachable — otherwise a wiped session could
reappear on screen.

## When /mod says the token is wrong

Ask the deployment which of the three things it is — the endpoint distinguishes
them, and needs no token to answer:

```bash
curl https://your.domain/api/mod/health      # {"configured":true|false}
```

| What you see | What it means |
|---|---|
| `{"configured":false}`, or `503 not_configured` | The secret was never set on this deployment. `npx wrangler secret put MOD_TOKEN`, then redeploy. |
| `401 bad_token` | The token does not match the stored secret. |
| `401 no_token` | Nothing was supplied. |

Leading and trailing whitespace is trimmed on both sides, so a secret that
picked up a stray newline from the `wrangler secret put` prompt — which is easy
to do by pasting or piping, and was the original cause of this — no longer
breaks anything. If it still refuses, the stored value genuinely differs: set it
again, typing rather than pasting.

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
  not consent. The exact notice version is stored with the consent — currently
  `v2`. **Bump it in `public/data/questions.json` whenever the notice wording
  changes**, or the field stops proving what anyone actually agreed to. A
  submission that arrives without a version is recorded as `unknown` rather
  than being assigned one.
- The collection notice is inline above the field, with the policy linked from
  the notice itself.
- `?include=contacts` is required to export addresses at all, so the routine
  export carries none.

**APP 8 — overseas disclosure.** Two processors are named, in both the inline
notice and the policy: Cloudflare, which runs the app, and **Gmail (Google LLC)**,
which sends the outcome notice. Both sit outside Australia. If the mail provider
ever changes, both places need updating and the notice version needs bumping.

**Unsubscribe** is by reply rather than by one-click link, because these notices
come from a mailbox rather than a bulk mailing platform. The policy says so
plainly rather than promising a mechanism that does not exist.

**Not legal advice.** The wording in `public/privacy.html` and the inline notice
still needs review before the conference.

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
