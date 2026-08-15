import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateCrowd,
  aggregateMagnitude,
  buildAggregate,
  clampP,
  combine,
  divergence,
  ensemble,
  histogram,
  invLogit,
  logit,
  EXTREMISE_A,
  HISTOGRAM_BINS
} from '../public/js/aggregate.js';

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} not within ${tolerance} of ${expected}`);

/* --- step 1: clamping ------------------------------------------------------ */

test('clamps into [0.01, 0.99] so log-odds never blows up', () => {
  assert.equal(clampP(0), 0.01);
  assert.equal(clampP(1), 0.99);
  assert.equal(clampP(1.5), 0.99);
  assert.equal(clampP(-3), 0.01);
  assert.equal(clampP(0.42), 0.42);
  assert.equal(clampP(NaN), null);
  assert.equal(clampP(undefined), null);
});

test('logit and invLogit round-trip', () => {
  for (const p of [0.01, 0.2, 0.5, 0.73, 0.99]) near(invLogit(logit(p)), p, 1e-12);
  near(logit(0.5), 0);
});

/* --- steps 2-4: median, extremisation, band -------------------------------- */

test('the median resists the joker who submits 99%', () => {
  const honest = [0.3, 0.32, 0.35, 0.33, 0.31];
  const withJoker = [...honest, 0.99];

  const a = aggregateCrowd(honest).median;
  const b = aggregateCrowd(withJoker).median;

  // One extreme submission out of six moves the answer by a few points, not
  // by twenty — which is the entire reason §7 specifies a median.
  assert.ok(Math.abs(b - a) < 0.05, `joker moved the median from ${a} to ${b}`);
});

test('extremisation pushes a hedged crowd away from 50%, in both directions', () => {
  const above = aggregateCrowd([0.6, 0.62, 0.58, 0.61]);
  assert.ok(above.median > above.rawMedian, 'a crowd above 50% should be pushed up');

  const below = aggregateCrowd([0.4, 0.38, 0.42, 0.39]);
  assert.ok(below.median < below.rawMedian, 'a crowd below 50% should be pushed down');
});

test('extremisation leaves a crowd sitting exactly on 50% alone', () => {
  // Scaling log-odds by any factor fixes zero, so a genuinely undecided room
  // stays undecided rather than being nudged somewhere by the correction.
  near(aggregateCrowd([0.5, 0.5, 0.5]).median, 0.5, 1e-12);
});

test('extremisation applies the documented factor exactly', () => {
  const probs = [0.7, 0.7, 0.7];
  near(aggregateCrowd(probs).median, invLogit(logit(0.7) * EXTREMISE_A), 1e-12);
});

test('the median stays inside its own interquartile range', () => {
  // The regression this guards: extremising only the centre lets a tight,
  // confident crowd produce a median outside its own band.
  const tightAndConfident = [0.9, 0.905, 0.91, 0.915, 0.92];
  const agg = aggregateCrowd(tightAndConfident);
  assert.ok(agg.p25 <= agg.median && agg.median <= agg.p75, `${agg.p25} <= ${agg.median} <= ${agg.p75}`);
});

test('a wider spread produces a wider band', () => {
  const tight = aggregateCrowd([0.5, 0.52, 0.48, 0.51]);
  const wide = aggregateCrowd([0.1, 0.35, 0.65, 0.9]);
  assert.ok(wide.p75 - wide.p25 > tight.p75 - tight.p25, 'disagreement must show up as width');
});

test('an empty crowd degrades rather than throwing', () => {
  const agg = aggregateCrowd([]);
  assert.equal(agg.n, 0);
  assert.equal(agg.median, null);
  assert.deepEqual(agg.histogram, new Array(HISTOGRAM_BINS).fill(0));
});

test('histogram bins by 5 points and never overflows at the edges', () => {
  const bins = histogram([0.01, 0.99, 0.5]);
  assert.equal(bins.length, HISTOGRAM_BINS);
  assert.equal(bins[0], 1);
  assert.equal(bins[HISTOGRAM_BINS - 1], 1);
  assert.equal(
    bins.reduce((a, b) => a + b, 0),
    3
  );
});

/* --- step 5: the ensemble -------------------------------------------------- */

test('50/50 log-odds blending is symmetric in its arguments', () => {
  near(combine(0.2, 0.8), combine(0.8, 0.2), 1e-12);
});

test('50/50 blending of complements lands on 50%', () => {
  near(combine(0.25, 0.75), 0.5, 1e-12);
});

test('the ensemble sits between crowd and model', () => {
  const p = combine(0.3, 0.9);
  assert.ok(p > 0.3 && p < 0.9);
});

test('blending in log-odds is not the arithmetic mean — that is the point', () => {
  // 2% and 20% average to 11% arithmetically; in log-odds they land near 6%.
  // A gap down in the tail matters more than the same gap near the middle.
  const p = combine(0.02, 0.2);
  assert.ok(p < 0.11, `expected below the arithmetic mean, got ${p}`);
  near(p, invLogit((logit(0.02) + logit(0.2)) / 2), 1e-12);
});

test('a missing model leaves the crowd untouched, and vice versa', () => {
  near(combine(0.4, null), 0.4);
  near(combine(null, 0.4), 0.4);
});

test('the ensemble band carries the crowd IQR through the blend', () => {
  const crowd = aggregateCrowd([0.2, 0.4, 0.6, 0.8]);
  const e = ensemble(crowd, 0.5);
  near(e.band[0], combine(crowd.p25, 0.5), 1e-12);
  near(e.band[1], combine(crowd.p75, 0.5), 1e-12);
  assert.ok(e.band[0] <= e.p && e.p <= e.band[1]);
});

test('divergence is measured in log-odds, so tail gaps outrank middle gaps', () => {
  const tail = divergence(0.02, 0.08);
  const middle = divergence(0.45, 0.51);
  assert.ok(Math.abs(tail.gap) > Math.abs(middle.gap));
  assert.equal(tail.direction, 'model-higher');
  assert.equal(divergence(0.8, 0.4).direction, 'model-lower');
  assert.equal(divergence(0.5, null).direction, 'none');
});

/* --- magnitude -------------------------------------------------------------- */

test('magnitude aggregates by geometric median, not arithmetic mean', () => {
  const triples = [
    { low: 100000, mode: 500000, high: 2000000 },
    { low: 100000, mode: 500000, high: 2000000 },
    // One person types a number three orders of magnitude out.
    { low: 100000, mode: 500000, high: 2000000000 }
  ];
  const agg = aggregateMagnitude(triples);
  assert.equal(agg.n, 3);
  near(agg.high, 2000000, 1);
});

test('an aggregate can never come back with low above high', () => {
  // Individually inconsistent submissions — someone dragged the sliders past
  // each other — must not produce a nonsense aggregate.
  const agg = aggregateMagnitude([
    { low: 5000000, mode: 900000, high: 100000 },
    { low: 4000000, mode: 800000, high: 200000 }
  ]);
  assert.ok(agg.low <= agg.mode && agg.mode <= agg.high);
});

test('magnitude ignores zero, negative and missing triples', () => {
  assert.equal(aggregateMagnitude([null, undefined, { low: 0, mode: 1, high: 2 }, { low: -5, mode: 1, high: 2 }]).n, 0);
});

/* --- the whole payload -------------------------------------------------------- */

const sample = [
  { id: 'a', q1: 0.8, q2: { low: 200000, mode: 800000, high: 5000000 }, confidence: 'high', role: 'risk', seeded: true, ts: 1 },
  { id: 'b', q1: 0.6, q2: null, confidence: 'med', role: 'engineering', seeded: false, ts: 2 },
  { id: 'c', q1: 0.7, q2: { low: 300000, mode: 900000, high: 6000000 }, confidence: 'low', role: 'risk', seeded: false, ts: 3 }
];

test('the payload served to boards carries no participant fields at all', () => {
  const agg = buildAggregate(sample, { p: 0.5, baseRate: 'x', reasons: ['a', 'b'] }, [
    { note: 'a line', role: 'risk', q1: 0.8, ts: 1 }
  ]);

  const serialised = JSON.stringify(agg);
  // The board is a screen in front of 150 people. Nothing that could identify
  // a participant may exist in the payload it polls — not even a field name.
  for (const forbidden of ['email', 'consent', '"id"', 'marketing']) {
    assert.ok(!serialised.includes(forbidden), `aggregate leaked ${forbidden}`);
  }
});

test('the aggregate reports its own method so the board can print it', () => {
  const agg = buildAggregate(sample, null, []);
  assert.equal(agg.method.extremiseA, EXTREMISE_A);
  assert.deepEqual(agg.method.weights, { crowd: 0.5, model: 0.5 });
  assert.deepEqual(agg.method.clamp, [0.01, 0.99]);
});

test('seeded forecasts are counted separately so the board can say so', () => {
  const agg = buildAggregate(sample, null, []);
  assert.equal(agg.n, 3);
  assert.equal(agg.seeded, 1);
});

test('byRole groups and keeps counts', () => {
  const agg = buildAggregate(sample, null, []);
  assert.equal(agg.byRole.risk.n, 2);
  assert.equal(agg.byRole.engineering.n, 1);
});

test('a placeholder model artefact is flagged through to the board', () => {
  const agg = buildAggregate(sample, { p: 0.72, placeholder: true, reasons: [] }, []);
  assert.equal(agg.model.placeholder, true);
});

test('notes are capped at twelve', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ note: `n${i}`, role: 'risk', q1: 0.5, ts: i }));
  assert.equal(buildAggregate(sample, null, many).notes.length, 12);
});

test('n=1 still produces a drawable board', () => {
  const agg = buildAggregate([sample[0]], null, []);
  assert.equal(agg.n, 1);
  assert.ok(agg.crowd.median > 0);
  assert.equal(agg.crowd.p25, agg.crowd.p75);
});
