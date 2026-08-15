/* ---------------------------------------------------------------------------
   Frequency and magnitude to dollars — §8 of the build spec.

   Panel D runs this in the board's browser. No server compute to fail on stage,
   and a 10,000-iteration run lands in roughly 30ms on a laptop.

   The FAIR arithmetic here is settled and uncontroversial. The hard part was
   always sourcing defensible inputs for events you have no data on — which is
   the part the room upstairs just supplied.
--------------------------------------------------------------------------- */

export const ITERATIONS = 10000;

/** z-score at the 90th percentile, used to fit a lognormal from p10/p90. */
const Z90 = 1.2815515655446004;

/** Fixed seed so the same inputs give the same curve twice on stage. */
export const DEFAULT_SEED = 0x5eed1e;

/* --- deterministic RNG ---------------------------------------------------
   A seeded generator rather than Math.random, so a re-run mid-talk does not
   quietly redraw the curve while the presenter is pointing at it.          */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller, drawing one value per call. */
function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* --- magnitude ------------------------------------------------------------ */

/**
 * Fit a lognormal to the crowd's aggregated three-point estimate.
 *
 * low and high are the participants' own 10th and 90th percentiles, so they
 * pin the distribution directly:
 *     mu    = (ln low + ln high) / 2
 *     sigma = (ln high - ln low) / (2 * z90)
 *
 * The stated mode is not used to fit — three points overdetermine a two-
 * parameter family, and picking low/high keeps the tail, which is the part
 * Panel D exists to show, anchored to what people actually said. Instead the
 * implied mode is returned so the board can display the discrepancy rather
 * than bury it.
 */
export function fitLognormal({ low, mode, high }) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0 || high <= low) {
    return null;
  }
  const lnLow = Math.log(low);
  const lnHigh = Math.log(high);
  const mu = (lnLow + lnHigh) / 2;
  const sigma = (lnHigh - lnLow) / (2 * Z90);

  const impliedMode = Math.exp(mu - sigma * sigma);
  const statedMode = Number.isFinite(mode) && mode > 0 ? mode : null;

  return {
    mu,
    sigma,
    impliedMode,
    statedMode,
    // >1 means the room's single best guess sits above the shape its own
    // 10th/90th imply — i.e. the crowd is left-skewed relative to its range.
    modeRatio: statedMode ? statedMode / impliedMode : null
  };
}

export function lognormalQuantile(fit, q) {
  return Math.exp(fit.mu + fit.sigma * inverseNormalCdf(q));
}

/** Acklam's rational approximation to the inverse normal CDF. */
export function inverseNormalCdf(p) {
  if (p <= 0 || p >= 1) throw new RangeError('p must be in (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* --- the run -------------------------------------------------------------- */

/**
 * Run the FAIR chain.
 *
 * Frequency — the ensemble probability is treated as the annualised likelihood
 * that the reference organisation sees the event at all, drawn as a Bernoulli.
 * Magnitude — drawn from the fitted lognormal when the event occurs.
 *
 * Most years the loss is zero, so the unconditional p10 and often the p50 come
 * back at $0. That is not a bug and it is the most useful thing on the panel:
 * the median year costs nothing and the tail is what the limits conversation is
 * actually about. `conditional` carries the severity distribution given the
 * event, for the "if it happens" half of the sentence.
 *
 * @param {number} p  ensemble probability, annualised
 * @param {{low:number, mode:number, high:number}} magnitude aggregated triple
 */
export function runFairChain(p, magnitude, { iterations = ITERATIONS, seed = DEFAULT_SEED } = {}) {
  const fit = fitLognormal(magnitude ?? {});
  if (!Number.isFinite(p) || !fit) return null;

  const rand = mulberry32(seed);
  const losses = new Float64Array(iterations);
  const severities = [];
  let total = 0;
  let events = 0;

  for (let i = 0; i < iterations; i++) {
    if (rand() < p) {
      const loss = Math.exp(fit.mu + fit.sigma * normal(rand));
      losses[i] = loss;
      severities.push(loss);
      total += loss;
      events++;
    } else {
      losses[i] = 0;
    }
  }

  const sorted = Float64Array.from(losses).sort();
  const severitySorted = severities.sort((a, b) => a - b);

  return {
    iterations,
    p,
    fit,
    events,
    // Annualised loss distribution, including the years nothing happens.
    p10: percentile(sorted, 0.1),
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: total / iterations,
    // Severity given the event occurs.
    conditional: {
      n: severities.length,
      p10: percentile(severitySorted, 0.1),
      p50: percentile(severitySorted, 0.5),
      p90: percentile(severitySorted, 0.9)
    },
    exceedance: exceedanceCurve(sorted)
  };
}

function percentile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Loss exceedance curve: for each point, the probability that a single year
 * costs more than that amount. Sampled at 200 points so it draws smoothly
 * without shipping 10,000 coordinates into the DOM.
 */
export function exceedanceCurve(sorted, points = 200) {
  const n = sorted.length;
  const curve = [];
  for (let i = 0; i < points; i++) {
    const q = i / (points - 1);
    const loss = percentile(sorted, q);
    curve.push({ loss, exceedance: 1 - q });
  }
  return curve;
}

/* --- presentation --------------------------------------------------------- */

/** Compact AUD for a board seen from the back row: $0, $480k, $2.4M, $31M. */
export function formatAud(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1) return '$0';
  if (value < 1000) return `$${Math.round(value)}`;
  if (value < 1e6) return `$${trim(value / 1e3)}k`;
  if (value < 1e9) return `$${trim(value / 1e6)}M`;
  return `$${trim(value / 1e9)}B`;
}

function trim(n) {
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/\.?0+$/, '');
}
