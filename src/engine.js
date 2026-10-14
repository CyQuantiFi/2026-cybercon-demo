/* ---------------------------------------------------------------------------
   The AI decision engine's two live routes. Off the hot path, like the model
   re-run: one board, one keypress each.

       POST /api/engine/rerun    re-ask the engine the room's question
       POST /api/engine/decide   ask it what to do about Panel D's dollar range

   Both follow the model re-run's rules: a hard 6-second timeout, and a failure
   is a quiet { ok: false } — the board keeps whatever it already shows. Neither
   will call an engine on evidence or treatments that fail their gate.

   Every response carries `x-cyq-source: ai-decision-engine`, so anything
   reading these routes can tell engine output from crowd or LLM output without
   parsing the body.
--------------------------------------------------------------------------- */

import {
  BAND_LABELS,
  DEFAULT_ENGINE,
  SOURCE_KIND,
  band,
  callEngine,
  checkEvidence,
  checkTreatments,
  decisionRequest,
  forecastFromAnswers,
  forecastRequest,
  provenance,
  readChoice,
  sha256
} from '../public/js/decision-engine.js';
import { runFairChain } from '../public/js/montecarlo.js';

const TIMEOUT_MS = 6000;

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-cyq-source': SOURCE_KIND
};

export async function engineRoute(request, env, path, stub) {
  if (path === '/api/engine/rerun') return rerunForecast(env, stub);
  if (path === '/api/engine/decide') return decide(env, stub);
  return reply({ error: 'not_found' }, 404);
}

async function rerunForecast(env, stub) {
  const engine = env.ENGINE || DEFAULT_ENGINE;
  const [questions, evidenceText] = await Promise.all([
    asset(env, 'questions.json').then((r) => r.json()),
    asset(env, 'evidence.json').then((r) => r.text())
  ]);
  const pack = JSON.parse(evidenceText);
  const question = questions.frequency[questions.activeFrequency];

  if (pack.question !== question.id) return reply({ ok: false, reason: 'evidence_for_another_question' });
  const gate = checkEvidence(pack);
  if (!gate.ok) return reply({ ok: false, reason: 'evidence_insufficient', problems: gate.problems });

  const result = await withTimeout((signal) => callEngine(engine, forecastRequest(engine, question, pack), { env, signal }));
  if (!result.ok) return reply({ ok: false, reason: result.reason });

  const forecast = forecastFromAnswers(result.value.answers);
  if (!forecast) return reply({ ok: false, reason: 'no_answer' });

  const evidenceSha = await sha256(evidenceText);
  const stored = await (await stub.fetch('https://session/aggregate')).json();
  const previous = stored.engine;

  const artefact = {
    ...forecast,
    // Attribution takes one engine call per evidence item, so it is made the
    // morning of the talk, not live. It still describes this evidence if the
    // pack has not changed since, and is dropped if it has.
    attribution: previous?.source?.evidenceSha === evidenceSha ? previous.attribution : [],
    crossCheck: null,
    evidence: { n: pack.items.length, asOf: pack.asOf ?? null },
    source: provenance(engine, { evidenceSha, ranAt: Date.now(), live: true, ms: result.value.ms })
  };

  const res = await stub.fetch('https://session/engine', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(artefact)
  });
  return reply(await res.json());
}

async function decide(env, stub) {
  const engine = env.ENGINE || DEFAULT_ENGINE;
  const treatments = await asset(env, 'treatments.json').then((r) => r.json());
  const gate = checkTreatments(treatments);
  if (!gate.ok) return reply({ ok: false, reason: 'treatments_unsourced', problems: gate.problems });

  const aggregate = await (await stub.fetch('https://session/aggregate')).json();
  const p = aggregate.ensemble?.p;
  if (p == null || !aggregate.magnitude || aggregate.magnitude.n === 0) return reply({ ok: false, reason: 'no_money_yet' });

  // The same chain, seed and iteration count the board runs, so the figures the
  // engine is shown are the figures on Panel D to the dollar.
  const run = runFairChain(p, aggregate.magnitude);
  if (!run) return reply({ ok: false, reason: 'no_money_yet' });

  const questions = await asset(env, 'questions.json').then((r) => r.json());
  const q = questions.frequency[questions.activeFrequency];
  const context = { question: q.display ?? q.text, ensembleP: p, run };
  const body = decisionRequest(engine, context, treatments);

  const result = await withTimeout((signal) => callEngine(engine, body, { env, signal }));
  if (!result.ok) return reply({ ok: false, reason: result.reason });

  const options = Object.keys(treatments.options);
  const { choice, probabilities, confidence } = readChoice(result.value.answers?.action, options);
  if (!choice) return reply({ ok: false, reason: 'no_answer' });

  const b = band(confidence);
  return reply({
    ok: true,
    decision: {
      choice,
      probabilities,
      confidence,
      band: b,
      bandLabel: BAND_LABELS[b],
      inputs: { ensembleP: p, mean: run.mean, p50: run.p50, p90: run.p90, n: aggregate.n },
      source: provenance(engine, { ranAt: Date.now(), live: true, ms: result.value.ms })
    }
  });
}

/* --- helpers -------------------------------------------------------------- */

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return { ok: true, value: await fn(controller.signal) };
  } catch (err) {
    console.error('decision engine call failed', err);
    const msg = String(err?.message ?? err);
    return { ok: false, reason: msg.startsWith('missing_credentials') ? 'no_key' : controller.signal.aborted ? 'timeout' : 'upstream' };
  } finally {
    clearTimeout(timer);
  }
}

function asset(env, name) {
  return env.ASSETS.fetch(`https://assets.local/data/${name}`);
}

function reply(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: HEADERS });
}
