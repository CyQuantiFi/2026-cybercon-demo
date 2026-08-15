#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Resolution-day scoring — §10 item 10.

   This is the part that turns a demo into a track record. Everything else in
   this repo produces opinions; questions that resolve produce calibration.

       node scripts/score.mjs --export dump.json --outcome yes
       node scripts/score.mjs --export dump.json --outcome no --out results/

   Where dump.json comes from:
       curl -H "x-mod-token: $MOD_TOKEN" https://your.domain/api/mod/export > dump.json

   Emails are deliberately NOT wired to a provider. This script renders the
   outcome notice and writes the recipient list; choosing the provider is a
   decision with an APP 8 disclosure attached, so it is made once, named in the
   privacy notice, and only then plugged in here.
--------------------------------------------------------------------------- */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { aggregateCrowd, clampP } from '../public/js/aggregate.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const exportPath = flag('--export');
const outcomeRaw = flag('--outcome');
const outDir = flag('--out', 'results');

if (!exportPath || !['yes', 'no'].includes(outcomeRaw)) {
  console.error('Usage: node scripts/score.mjs --export dump.json --outcome yes|no [--out results/]');
  process.exit(1);
}

const outcome = outcomeRaw === 'yes' ? 1 : 0;
const dump = JSON.parse(await readFile(exportPath, 'utf8'));

const forecasts = dump.forecasts.map((r) => ({ ...r, q1: clampP(r.q1) }));
if (forecasts.length === 0) {
  console.error('No forecasts in that export.');
  process.exit(1);
}

/* --- scoring --------------------------------------------------------------
   Brier is the headline because it is the one people recognise. The log score
   is carried alongside because it is the one that actually punishes confident
   wrongness, which is the behaviour the weighting is meant to discourage.

   Both are proper scoring rules: the best score comes from saying what you
   actually believe, so there is no bluffing or hedging strategy to find.      */

const brier = (p) => (p - outcome) ** 2;
const logScore = (p) => -Math.log(outcome === 1 ? p : 1 - p);

const scored = forecasts
  .map((f) => ({
    id: f.id,
    q1: f.q1,
    role: f.role,
    confidence: f.confidence,
    seeded: f.seeded === 1,
    brier: brier(f.q1),
    log: logScore(f.q1)
  }))
  .sort((a, b) => a.brier - b.brier);

/* Benchmarks. A score is only meaningful next to what it beat. */
const crowd = aggregateCrowd(forecasts.map((f) => f.q1));
const modelP = dump.model && !dump.model.placeholder ? clampP(dump.model.p) : null;

const benchmarks = {
  'always 50%': brier(0.5),
  'crowd median (extremised)': brier(crowd.median),
  'crowd median (raw)': brier(crowd.rawMedian),
  ...(modelP !== null ? { 'model alone': brier(modelP) } : {}),
  'best individual': scored[0].brier,
  'mean individual': mean(scored.map((s) => s.brier))
};

const byRole = groupScores(scored, (s) => s.role);
const byConfidence = groupScores(scored, (s) => s.confidence);

/* --- report ---------------------------------------------------------------- */

const line = (k, v) => `${k.padEnd(30)} ${v}`;
const p4 = (v) => v.toFixed(4);

console.log(`\nOutcome: ${outcomeRaw.toUpperCase()}   ·   ${forecasts.length} forecasts\n`);
console.log('BRIER (lower is better)');
for (const [k, v] of Object.entries(benchmarks)) console.log('  ' + line(k, p4(v)));

console.log('\nBY ROLE');
for (const [role, s] of Object.entries(byRole)) console.log('  ' + line(`${role} (n=${s.n})`, p4(s.brier)));

console.log('\nBY SELF-RATED CONFIDENCE');
for (const [c, s] of Object.entries(byConfidence)) console.log('  ' + line(`${c} (n=${s.n})`, p4(s.brier)));

// The claim the talk makes is that an aggregate beats the individuals. It is
// worth printing whether it actually did, including when it did not.
const beat = mean(scored.map((s) => s.brier)) - benchmarks['crowd median (extremised)'];
console.log(
  `\nThe extremised crowd was ${Math.abs(beat).toFixed(4)} Brier ${beat > 0 ? 'BETTER' : 'WORSE'} than the mean individual.`
);
if (benchmarks['crowd median (extremised)'] > benchmarks['crowd median (raw)']) {
  console.log('Extremisation hurt on this question. Say so; it is a result either way.');
}

/* --- artefacts --------------------------------------------------------------- */

await mkdir(outDir, { recursive: true });

const csv = [
  'id,q1,role,confidence,seeded,brier,log',
  ...scored.map((s) => [s.id, s.q1, s.role, s.confidence, s.seeded, s.brier.toFixed(6), s.log.toFixed(6)].join(','))
].join('\n');
await writeFile(join(outDir, 'scores.csv'), `${csv}\n`);

await writeFile(
  join(outDir, 'summary.json'),
  `${JSON.stringify({ outcome: outcomeRaw, n: forecasts.length, benchmarks, byRole, byConfidence, crowd, modelP }, null, 2)}\n`
);

/* --- the outcome notice -------------------------------------------------------
   Rendered, not sent. Wiring a provider means naming it in the APP 8 overseas-
   disclosure statement in public/privacy.html first — the notice below carries
   a placeholder so it cannot be sent without that decision being made.        */

const contacts = (dump.contacts ?? []).map((c) => ({ ...c, consent: JSON.parse(c.consent) }));

// One row per address, keeping the most recent consent. The same person can
// submit more than once — a second device, a re-scan, an edited forecast — and
// each of those is a separate row keyed on a different client id. Sending them
// five copies of the outcome notice would be the single most avoidable way to
// turn a track record into a complaint.
const byEmail = new Map();
for (const c of [...contacts].sort((a, b) => a.ts - b.ts)) {
  byEmail.set(c.email.toLowerCase(), c);
}
const wantOutcome = [...byEmail.values()].filter((c) => c.consent.outcome);
const duplicates = contacts.length - byEmail.size;

const notice = `Subject: The CyberCon forecast resolved ${outcomeRaw.toUpperCase()}

You forecast this at CyberCon 2026:

  "${dump.questionText ?? '[question text — paste from public/data/questions.json]'}"

It resolved ${outcomeRaw.toUpperCase()}.

  The room's aggregate      ${(crowd.median * 100).toFixed(0)}%   (Brier ${p4(benchmarks['crowd median (extremised)'])})
  Always saying 50%                Brier ${p4(benchmarks['always 50%'])}
  The best single forecaster       Brier ${p4(benchmarks['best individual'])}
${modelP !== null ? `  The model participant     ${(modelP * 100).toFixed(0)}%   (Brier ${p4(benchmarks['model alone'])})\n` : ''}
That is the whole point of the exercise: the estimate is now checkable, and the
next one starts from evidence instead of assertion.

You asked to be told how this resolved. We are not adding you to anything else
unless you separately asked for that.

Unsubscribe: [UNSUBSCRIBE URL]
Access, correction or deletion: privacy@cyquantifi.com
Sent by CyQuantiFi via [MAIL PROVIDER — name this in public/privacy.html before sending].
`;

await writeFile(join(outDir, 'outcome-notice.txt'), notice);
await writeFile(join(outDir, 'recipients.csv'), `email,outcome,marketing\n${wantOutcome.map((c) => `${c.email},${c.consent.outcome},${c.consent.marketing}`).join('\n')}\n`);

console.log(`\nWrote ${outDir}/scores.csv, summary.json, outcome-notice.txt, recipients.csv`);
console.log(`${wantOutcome.length} people asked to be told. Nothing has been sent — the send path is deliberately unwired.`);
if (duplicates > 0) console.log(`${duplicates} duplicate address rows collapsed; each address appears once.`);
if (contacts.length > 0 && wantOutcome.length === 0) {
  console.log('Addresses exist but nobody ticked the outcome box. Do not email them.');
}

/* --- helpers -------------------------------------------------------------------- */

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function groupScores(scored, keyOf) {
  const groups = {};
  for (const s of scored) (groups[keyOf(s) ?? 'other'] ??= []).push(s);
  return Object.fromEntries(
    Object.entries(groups)
      .map(([k, list]) => [k, { n: list.length, brier: mean(list.map((s) => s.brier)), log: mean(list.map((s) => s.log)) }])
      .sort((a, b) => a[1].brier - b[1].brier)
  );
}
