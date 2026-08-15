import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED,
  ITERATIONS,
  exceedanceCurve,
  fitLognormal,
  formatAud,
  inverseNormalCdf,
  lognormalQuantile,
  mulberry32,
  runFairChain
} from '../public/js/montecarlo.js';

const near = (actual, expected, relative = 0.02) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * relative,
    `${actual} not within ${relative * 100}% of ${expected}`
  );

/* --- the fit ---------------------------------------------------------------- */

test('the lognormal fit recovers its own p10 and p90', () => {
  const fit = fitLognormal({ low: 250000, mode: 900000, high: 6000000 });
  near(lognormalQuantile(fit, 0.1), 250000, 1e-6);
  near(lognormalQuantile(fit, 0.9), 6000000, 1e-6);
});

test('the fit reports the mode it implies, against the one the room stated', () => {
  const fit = fitLognormal({ low: 250000, mode: 900000, high: 6000000 });
  assert.ok(fit.impliedMode > 0);
  assert.equal(fit.statedMode, 900000);
  near(fit.modeRatio, 900000 / fit.impliedMode, 1e-9);
});

test('a degenerate range is refused rather than fitted', () => {
  assert.equal(fitLognormal({ low: 0, mode: 1, high: 2 }), null);
  assert.equal(fitLognormal({ low: 5000, mode: 1000, high: 5000 }), null, 'high must exceed low');
  assert.equal(fitLognormal({}), null);
});

test('inverse normal CDF matches known z-scores across all three branches', () => {
  near(inverseNormalCdf(0.5), 0, 1e-9);
  near(inverseNormalCdf(0.9), 1.2815515655, 1e-4);
  near(inverseNormalCdf(0.1), -1.2815515655, 1e-4);
  near(inverseNormalCdf(0.975), 1.959963985, 1e-4);
  // Outside the central branch, where the rational approximation switches.
  near(inverseNormalCdf(0.999), 3.090232306, 1e-3);
  near(inverseNormalCdf(0.001), -3.090232306, 1e-3);
  assert.throws(() => inverseNormalCdf(0));
  assert.throws(() => inverseNormalCdf(1));
});

/* --- the RNG ---------------------------------------------------------------- */

test('the RNG is deterministic, so the same inputs draw the same curve twice', () => {
  const a = Array.from({ length: 5 }, mulberry32(DEFAULT_SEED));
  const b = Array.from({ length: 5 }, mulberry32(DEFAULT_SEED));
  assert.deepEqual(a, b);
  assert.ok(a.every((v) => v >= 0 && v < 1));
  assert.notDeepEqual(a, Array.from({ length: 5 }, mulberry32(DEFAULT_SEED + 1)));
});

/* --- the chain --------------------------------------------------------------- */

const magnitude = { low: 250000, mode: 900000, high: 6000000 };

test('a 10,000 iteration run completes in well under 50ms', () => {
  const started = performance.now();
  const run = runFairChain(0.8, magnitude);
  const elapsed = performance.now() - started;
  assert.ok(run);
  assert.ok(elapsed < 50, `took ${elapsed.toFixed(1)}ms`);
});

test('the event rate matches the ensemble probability', () => {
  const run = runFairChain(0.3, magnitude, { iterations: ITERATIONS });
  near(run.events / run.iterations, 0.3, 0.06);
});

test('the median year costs nothing when the event is unlikely', () => {
  // Not a bug, and the most useful thing on the panel: most years cost zero
  // and the tail is what the limits conversation is actually about.
  const run = runFairChain(0.2, magnitude);
  assert.equal(run.p50, 0);
  assert.ok(run.p90 > 0);
});

test('the mean annual loss approximates probability times mean severity', () => {
  const p = 0.5;
  const fit = fitLognormal(magnitude);
  const analyticMean = p * Math.exp(fit.mu + (fit.sigma * fit.sigma) / 2);
  const run = runFairChain(p, magnitude);
  near(run.mean, analyticMean, 0.15);
});

test('percentiles are ordered and the tail sits above the body', () => {
  const run = runFairChain(0.8, magnitude);
  assert.ok(run.p10 <= run.p50);
  assert.ok(run.p50 <= run.p90);
  assert.ok(run.p90 <= run.p95);
  assert.ok(run.p95 <= run.p99);
});

test('the conditional severity recovers the crowd range it was fitted from', () => {
  const run = runFairChain(0.9, magnitude, { iterations: 40000 });
  near(run.conditional.p10, magnitude.low, 0.1);
  near(run.conditional.p90, magnitude.high, 0.12);
});

test('a higher probability produces a heavier annualised loss', () => {
  const low = runFairChain(0.2, magnitude);
  const high = runFairChain(0.9, magnitude);
  assert.ok(high.mean > low.mean);
  assert.ok(high.p90 > low.p90);
});

test('the run refuses bad inputs rather than drawing something meaningless', () => {
  assert.equal(runFairChain(null, magnitude), null);
  assert.equal(runFairChain(0.5, null), null);
  assert.equal(runFairChain(0.5, { low: 1, mode: 1, high: 1 }), null);
});

/* --- presentation ------------------------------------------------------------- */

test('the exceedance curve runs from certain to never, monotonically', () => {
  const run = runFairChain(0.6, magnitude);
  const curve = run.exceedance;
  assert.equal(curve.length, 200);
  near(curve[0].exceedance, 1, 1e-9);
  near(curve[curve.length - 1].exceedance, 0, 1e-9);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i].loss >= curve[i - 1].loss, 'losses must be non-decreasing');
    assert.ok(curve[i].exceedance <= curve[i - 1].exceedance, 'exceedance must be non-increasing');
  }
});

test('an empty sample does not break the curve', () => {
  const curve = exceedanceCurve(new Float64Array(0), 5);
  assert.equal(curve.length, 5);
  assert.ok(curve.every((d) => d.loss === 0));
});

test('AUD formats readably from the back row', () => {
  assert.equal(formatAud(0), '$0');
  assert.equal(formatAud(480000), '$480k');
  assert.equal(formatAud(2400000), '$2.4M');
  assert.equal(formatAud(31000000), '$31M');
  assert.equal(formatAud(1.4e9), '$1.4B');
  assert.equal(formatAud(NaN), '—');
});
