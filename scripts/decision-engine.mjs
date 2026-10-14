#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   The AI decision engine — the morning-of harness for Clef and Jev.

       npm run engine -- --check                 gates only: is the evidence enough?
       npm run engine -- --dry                   print the exact request, call nothing
       npm run engine -- --probe                 one call, print the raw response
       npm run engine                            forecast → public/data/engine.json
       npm run engine -- --decide-from-snapshot  decision → public/data/engine-decision.json

   Flags:
       --engine clef|clef-flash|jev   default: clef (or $ENGINE)
       --cross jev                    also ask a second engine, and show the gap

   Credentials, from the environment only:
       Clef   CF_ACCOUNT_ID, CF_AI_TOKEN  (an API token with Workers AI read)
       Jev    TYPESAFE_API_KEY, optionally TYPESAFE_API_URL

   The forecast makes 1 + N calls for N evidence items: one with everything,
   then one with each item withheld. The difference is the attribution the
   board shows in place of reasons — a decision model cannot argue, so the
   board shows what moved it.
--------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BAND_LABELS,
  DEFAULT_ENGINE,
  ENGINES,
  attribution,
  band,
  callEngine,
  checkEvidence,
  checkTreatments,
  decisionRequest,
  forecastFromAnswers,
  forecastRequest,
  provenance,
  readChoice,
  readNoul,
  sha256
} from '../public/js/decision-engine.js';
import { runFairChain, formatAud } from '../public/js/montecarlo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = (name) => join(root, 'public/data', name);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const flag = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

const engine = flag('--engine') || process.env.ENGINE || DEFAULT_ENGINE;
if (!ENGINES[engine]) {
  console.error(`Unknown engine "${engine}". One of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}
const cross = flag('--cross');

const questions = JSON.parse(await readFile(data('questions.json'), 'utf8'));
const question = questions.frequency[questions.activeFrequency];
const evidenceText = await readFile(data('evidence.json'), 'utf8');
const pack = JSON.parse(evidenceText);
const treatments = JSON.parse(await readFile(data('treatments.json'), 'utf8'));

if (has('--check')) await check();
else if (has('--dry')) await dry();
else if (has('--probe')) await probe();
else if (has('--decide-from-snapshot')) await decideFromSnapshot();
else await forecast();

/* --- modes ---------------------------------------------------------------- */

async function check() {
  let failed = false;
  console.log(`Active question  ${question.id}`);

  if (pack.question !== question.id) {
    console.log(`\nEVIDENCE  is for "${pack.question}", not the active question. Rebuild it.`);
    failed = true;
  }
  const ev = checkEvidence(pack);
  console.log(`\nEVIDENCE  ${ev.ok ? 'PASS' : 'FAIL'}  (${pack.items?.length ?? 0} items)`);
  for (const p of ev.problems) console.log(`  - ${p}`);
  failed ||= !ev.ok;

  const tr = checkTreatments(treatments);
  console.log(`\nTREATMENTS  ${tr.ok ? 'PASS' : 'FAIL'}`);
  for (const p of tr.problems) console.log(`  - ${p}`);
  failed ||= !tr.ok;

  const artefact = JSON.parse(await readFile(data('engine.json'), 'utf8'));
  const sha = await sha256(evidenceText);
  console.log('\nARTEFACT');
  if (artefact.placeholder) {
    console.log('  - engine.json is the placeholder. Run `npm run engine` once the evidence passes.');
    failed = true;
  } else if (artefact.source?.evidenceSha !== sha) {
    console.log('  - engine.json was made from different evidence. Re-run `npm run engine`.');
    failed = true;
  } else {
    console.log(`  ${pct(artefact.p)} from ${artefact.source.engineLabel}, ${new Date(artefact.source.ranAt).toISOString()}`);
  }

  if (failed) process.exitCode = 1;
}

async function dry() {
  const ev = checkEvidence(pack);
  if (!ev.ok) console.log(`(The evidence gate fails — ${ev.problems.length} problem(s). This is what WOULD be sent.)\n`);
  console.log(JSON.stringify(forecastRequest(engine, question, pack), null, 2));
}

async function probe() {
  requireEvidence();
  const res = await callEngine(engine, forecastRequest(engine, question, pack), { env: process.env });
  console.log(`${ENGINES[engine].label} answered in ${res.ms}ms. Raw answers:\n`);
  console.log(JSON.stringify(res.answers, null, 2));
  console.log('\nCheck the field names above against readNoul()/readChoice() in public/js/decision-engine.js.');
}

async function forecast() {
  requireEvidence();
  console.log(`Asking ${ENGINES[engine].label} the active question with ${pack.items.length} evidence items…`);

  const full = await callEngine(engine, forecastRequest(engine, question, pack), { env: process.env });
  const result = forecastFromAnswers(full.answers);
  if (!result) {
    console.error('No answer to the headline question. Run with --probe and check the field names.');
    process.exit(1);
  }

  console.log(`Leaving each item out in turn (${pack.items.length} calls)…`);
  const without = [];
  for (const item of pack.items) {
    const res = await callEngine(engine, forecastRequest(engine, question, pack, { omit: item.id }), { env: process.env });
    without.push({ id: item.id, claim: item.claim, part: item.part, p: readNoul(res.answers?.claim) });
  }

  let crossCheck = null;
  if (cross) {
    if (!ENGINES[cross]) throw new Error(`Unknown --cross engine "${cross}"`);
    const res = await callEngine(cross, forecastRequest(cross, question, pack), { env: process.env });
    const other = forecastFromAnswers(res.answers);
    if (other) crossCheck = { engine: cross, engineLabel: ENGINES[cross].label, p: other.p, gap: round3(result.p - other.p) };
  }

  const artefact = {
    ...result,
    attribution: attribution(result.p, without),
    crossCheck,
    evidence: { n: pack.items.length, asOf: pack.asOf ?? null },
    source: provenance(engine, { evidenceSha: await sha256(evidenceText), ranAt: Date.now(), live: false, ms: full.ms })
  };

  console.log(`\n  p             ${pct(artefact.p)}`);
  console.log(`  parts         A ${pct(artefact.parts.a)} × B|A ${pct(artefact.parts.bGivenA)} = ${pct(artefact.parts.product)}`);
  console.log(`  consistency   ${artefact.consistency.ok == null ? 'n/a' : artefact.consistency.ok ? 'ok' : `GAP ${pct(Math.abs(artefact.consistency.gap))} — the whole disagrees with its parts`}`);
  for (const a of artefact.attribution) console.log(`  moved by      ${a.delta > 0 ? '+' : ''}${(a.delta * 100).toFixed(1)} pts  ${a.id}`);
  if (crossCheck) console.log(`  ${crossCheck.engineLabel.padEnd(13)} ${pct(crossCheck.p)}  (gap ${(crossCheck.gap * 100).toFixed(1)} pts)`);

  await writeFile(data('engine.json'), `${JSON.stringify(artefact, null, 2)}\n`);
  console.log(`\nWrote public/data/engine.json. Now run \`npm run snapshot\` so the offline board matches.`);
}

/**
 * Panel E's fallback. Made from the bundled snapshot so that an offline board
 * shows a decision about the numbers it is actually displaying — never about a
 * live room it cannot see.
 */
async function decideFromSnapshot() {
  const gate = checkTreatments(treatments);
  if (!gate.ok) {
    console.error('The treatments gate fails:');
    for (const p of gate.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const { aggregate } = JSON.parse(await readFile(data('snapshot.json'), 'utf8'));
  const p = aggregate.ensemble?.p;
  const run = p != null && aggregate.magnitude?.n ? runFairChain(p, aggregate.magnitude) : null;
  if (!run) {
    console.error('The snapshot has no money to decide about. Run `npm run snapshot` first.');
    process.exit(1);
  }

  const context = { question: question.display ?? question.text, ensembleP: p, run };
  const res = await callEngine(engine, decisionRequest(engine, context, treatments), { env: process.env });
  const { choice, probabilities, confidence } = readChoice(res.answers?.action, Object.keys(treatments.options));
  if (!choice) {
    console.error('No choice in the answer. Run with --probe and check the field names.');
    process.exit(1);
  }

  const b = band(confidence);
  const decision = {
    choice,
    probabilities,
    confidence,
    band: b,
    bandLabel: BAND_LABELS[b],
    inputs: { ensembleP: p, mean: run.mean, p50: run.p50, p90: run.p90, n: aggregate.n, fromSnapshot: true },
    source: provenance(engine, { ranAt: Date.now(), live: false, ms: res.ms })
  };

  console.log(`  decision      ${choice}  (confidence ${confidence ?? 'none given'})`);
  console.log(`  band          ${BAND_LABELS[b]}`);
  console.log(`  on            ${pct(p)} a year · mean ${formatAud(run.mean)} · p90 ${formatAud(run.p90)}`);

  await writeFile(data('engine-decision.json'), `${JSON.stringify(decision, null, 2)}\n`);
  console.log('\nWrote public/data/engine-decision.json.');
}

/* --- helpers -------------------------------------------------------------- */

function requireEvidence() {
  if (pack.question !== question.id) {
    console.error(`evidence.json is for "${pack.question}", but the active question is "${question.id}".`);
    process.exit(1);
  }
  const gate = checkEvidence(pack);
  if (gate.ok) return;
  console.error('The evidence gate fails, so no engine is called:');
  for (const p of gate.problems) console.error(`  - ${p}`);
  console.error('\nFix public/data/evidence.json, then `npm run engine -- --check`.');
  process.exit(1);
}

function pct(p) {
  return p == null ? '—' : `${Math.round(p * 100)}%`;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}
