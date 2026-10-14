import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BANDS,
  SOURCE_KIND,
  attribution,
  band,
  callEngine,
  checkEvidence,
  checkTreatments,
  decisionRequest,
  decisionState,
  engineSummary,
  forecastFromAnswers,
  forecastRequest,
  provenance,
  readChoice,
  readNoul
} from '../public/js/decision-engine.js';

/* ---------------------------------------------------------------------------
   The AI decision engine harness — Clef and Jev.

   No engine is called here. What is tested is everything the harness owns:
   the evidence gate, the shape of what is sent, how answers are read, the
   confidence bands, and the provenance tag on everything that comes back.
--------------------------------------------------------------------------- */

const NOW = Date.parse('2026-10-14T00:00:00Z');

const question = {
  id: 'q1ai',
  text: 'Before 31 December 2027, will X happen?',
  resolutionDate: '2027-12-31',
  resolutionSource: 'OAIC or two news reports',
  resolvesNoIf: 'Nothing documented',
  ambiguityRule: 'Scope rule'
};

const item = (id, part, direction, extra = {}) => ({
  id,
  part,
  direction,
  claim: `Claim ${id}`,
  source: `https://example.org/${id}`,
  asOf: '2026-09-01',
  ...extra
});

const goodPack = () => ({
  question: 'q1ai',
  asOf: '2026-10-01',
  parts: { A: 'An incident happens.', B: 'It is publicly attributed.' },
  items: [item('a1', 'A', '+'), item('a2', 'A', '-'), item('b1', 'B', '+'), item('b2', 'B', '-')]
});

const goodTreatments = () => ({
  appetite: { p90Max: 2_000_000 },
  options: {
    accept: { description: 'Accept', annualCost: 0, lossReduction: 0 },
    mitigate: { description: 'Mitigate', annualCost: 150_000, lossReduction: 0.6, source: 'https://example.org/m' },
    transfer: { description: 'Transfer', annualCost: 90_000, lossReduction: 0.4, source: 'https://example.org/t' },
    escalate: { description: 'Escalate', annualCost: 0, lossReduction: 0 }
  }
});

/* --- the evidence gate ---------------------------------------------------- */

test('a cited, dated, two-sided pack passes the gate', () => {
  assert.deepEqual(checkEvidence(goodPack(), NOW), { ok: true, problems: [] });
});

test('the shipped placeholder pack fails the gate', async () => {
  const shipped = JSON.parse(await readFile(new URL('../public/data/evidence.json', import.meta.url), 'utf8'));
  const result = checkEvidence(shipped, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('placeholder')));
});

test('a one-sided part fails — no packs that only argue one way', () => {
  const pack = goodPack();
  pack.items[1].direction = '+';
  const result = checkEvidence(pack, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('Part A needs at least one item for and one against')));
});

test('an uncited item fails the gate', () => {
  const pack = goodPack();
  pack.items[0].source = 'http://not-https.example';
  assert.equal(checkEvidence(pack, NOW).ok, false);
});

test('stale evidence fails the gate', () => {
  const pack = goodPack();
  pack.items[2].asOf = '2023-01-01';
  const result = checkEvidence(pack, NOW);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes('older than')));
});

test('too few items for a part fails the gate', () => {
  const pack = goodPack();
  pack.items = pack.items.filter((i) => i.id !== 'b2');
  assert.equal(checkEvidence(pack, NOW).ok, false);
});

test('treatments need sourced costs and an appetite; the shipped file has neither', async () => {
  assert.equal(checkTreatments(goodTreatments()).ok, true);
  const shipped = JSON.parse(await readFile(new URL('../public/data/treatments.json', import.meta.url), 'utf8'));
  assert.equal(checkTreatments(shipped).ok, false);
  const noSource = goodTreatments();
  delete noSource.options.mitigate.source;
  assert.equal(checkTreatments(noSource).ok, false);
});

/* --- what is sent --------------------------------------------------------- */

test('the forecast asks three noul questions: both parts and the whole', () => {
  const req = forecastRequest('clef', question, goodPack());
  assert.equal(req.model, 'clef');
  assert.deepEqual(Object.keys(req.questions).sort(), ['claim', 'part_a', 'part_b_given_a']);
  for (const q of Object.values(req.questions)) assert.equal(q.type, 'noul');
  assert.equal(req.state.question.claim, question.text);
  assert.equal(req.state.evidence.length, 4);
});

test('Clef and Jev get the same request apart from the model name', () => {
  const clef = forecastRequest('clef', question, goodPack());
  const jev = forecastRequest('jev', question, goodPack());
  assert.equal(jev.model, 'jev-latest');
  assert.deepEqual({ ...clef, model: null }, { ...jev, model: null });
});

test('omitting an item removes exactly that item, for attribution', () => {
  const req = forecastRequest('clef', question, goodPack(), { omit: 'a2' });
  assert.deepEqual(
    req.state.evidence.map((e) => e.id),
    ['a1', 'b1', 'b2']
  );
});

test('the decision state does the arithmetic so the engine only has to judge', () => {
  const run = { mean: 1_000_000, p50: 0, p90: 3_000_000 };
  const state = decisionState({ question: 'Q', ensembleP: 0.4, run }, goodTreatments());
  assert.equal(state.options.mitigate.expectedLossAvoided, 600_000);
  assert.equal(state.options.mitigate.returnOnSpend, 3);
  assert.equal(state.options.mitigate.residualP90, 1_200_000);
  assert.equal(state.options.mitigate.withinAppetite, true);
  assert.equal(state.options.accept.withinAppetite, false);
  assert.equal(state.options.accept.returnOnSpend, null);
});

test('the decision is one choice question over the treatment keys', () => {
  const run = { mean: 1_000_000, p50: 0, p90: 3_000_000 };
  const req = decisionRequest('clef-flash', { question: 'Q', ensembleP: 0.4, run }, goodTreatments());
  assert.equal(req.model, 'clef-flash');
  assert.equal(req.questions.action.type, 'choice');
  assert.deepEqual(Object.keys(req.questions.action.criteria), ['accept', 'mitigate', 'transfer', 'escalate']);
});

/* --- calling --------------------------------------------------------------- */

test('Clef goes to the Workers AI REST route and its { result } wrapper is unwrapped', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, result: { model: 'clef', answers: { claim: { noul: 0.3 } } } }));
  };
  const env = { CF_ACCOUNT_ID: 'acct', CF_AI_TOKEN: 'tok' };
  const out = await callEngine('clef', { model: 'clef' }, { env, fetchFn });
  assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(out.answers.claim.noul, 0.3);
});

test('Jev goes to the System One endpoint with its own key', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ model: 'jev-latest', answers: { claim: { noul: 0.2 } } }));
  };
  const out = await callEngine('jev', {}, { env: { TYPESAFE_API_KEY: 'k' }, fetchFn });
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.equal(out.answers.claim.noul, 0.2);
});

test('no credentials, no call', async () => {
  const fetchFn = async () => assert.fail('should not have called out');
  await assert.rejects(callEngine('clef', {}, { env: {}, fetchFn }), /missing_credentials/);
  await assert.rejects(callEngine('jev', {}, { env: {}, fetchFn }), /missing_credentials/);
});

test('an upstream error is an error, not an answer', async () => {
  const fetchFn = async () => new Response('nope', { status: 503 });
  await assert.rejects(callEngine('jev', {}, { env: { TYPESAFE_API_KEY: 'k' }, fetchFn }), /upstream_503/);
});

/* --- reading answers ------------------------------------------------------- */

test('a noul outside 0–1 or missing reads as no answer, never a wrong one', () => {
  assert.equal(readNoul({ noul: 0.42 }), 0.42);
  assert.equal(readNoul({ noul: 1.4 }), null);
  assert.equal(readNoul({}), null);
  assert.equal(readNoul(undefined), null);
});

test('the forecast reports both parts and flags a whole that disagrees with them', () => {
  const ok = forecastFromAnswers({ claim: { noul: 0.3 }, part_a: { noul: 0.6 }, part_b_given_a: { noul: 0.5 } });
  assert.equal(ok.p, 0.3);
  assert.equal(ok.consistency.ok, true);
  const off = forecastFromAnswers({ claim: { noul: 0.7 }, part_a: { noul: 0.6 }, part_b_given_a: { noul: 0.5 } });
  assert.equal(off.consistency.ok, false);
  assert.equal(forecastFromAnswers({ part_a: { noul: 0.6 } }), null);
});

test('a choice keeps only allowed options and falls back to the most probable', () => {
  const allowed = ['accept', 'mitigate', 'transfer', 'escalate'];
  const r = readChoice({ probabilities: { accept: 0.1, mitigate: 0.7, rogue: 0.9 }, confidence: 0.66 }, allowed);
  assert.equal(r.choice, 'mitigate');
  assert.deepEqual(Object.keys(r.probabilities), ['accept', 'mitigate']);
  assert.equal(r.confidence, 0.66);
});

test('a choice with no stated confidence goes to a person', () => {
  const r = readChoice({ choice: 'accept' }, ['accept']);
  assert.equal(r.confidence, null);
  assert.equal(band(r.confidence), 'human');
});

test('the bands are act / review / human at the printed thresholds', () => {
  assert.equal(band(BANDS.act), 'act');
  assert.equal(band(BANDS.act - 0.01), 'review');
  assert.equal(band(BANDS.review), 'review');
  assert.equal(band(BANDS.review - 0.01), 'human');
});

/* --- attribution and provenance ------------------------------------------- */

test('attribution ranks the items whose removal moves the forecast most', () => {
  const top = attribution(0.3, [
    { id: 'a', claim: 'A', p: 0.29 },
    { id: 'b', claim: 'B', p: 0.4 },
    { id: 'c', claim: 'C', p: 0.25 },
    { id: 'd', claim: 'D', p: null },
    { id: 'e', claim: 'E', p: 0.3 }
  ]);
  assert.deepEqual(
    top.map((t) => [t.id, t.delta]),
    [
      ['b', -0.1],
      ['c', 0.05]
    ]
  );
});

test('everything the engine produces is tagged as an AI decision engine', () => {
  const p = provenance('jev', { ranAt: 1 });
  assert.equal(p.kind, SOURCE_KIND);
  assert.equal(p.kind, 'ai-decision-engine');
  assert.equal(p.label, 'AI decision engine');
  assert.equal(p.engineLabel, 'Jev');
  assert.equal(p.vendor, 'TypeSafe');
});

test('the aggregate summary keeps the tag and the placeholder flag', async () => {
  const shipped = JSON.parse(await readFile(new URL('../public/data/engine.json', import.meta.url), 'utf8'));
  const s = engineSummary(shipped);
  assert.equal(s.placeholder, true);
  assert.equal(s.source.kind, 'ai-decision-engine');
  assert.equal(engineSummary(null), null);
});

test('the aggregate summary carries no "id" field, which the deploy check treats as a leak', () => {
  const s = engineSummary({ p: 0.3, attribution: [{ id: 'a-1', claim: 'C', part: 'A', delta: 0.05 }] });
  assert.equal(JSON.stringify(s).includes('"id"'), false);
  assert.deepEqual(s.attribution, [{ claim: 'C', part: 'A', delta: 0.05 }]);
});
