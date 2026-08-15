/* ---------------------------------------------------------------------------
   Aggregation — §7 of the build spec.

   This module is the single source of truth for the maths. The Worker imports
   it to recompute the aggregate on write; the board imports it as a plain ES
   module to redraw. Same file, same numbers, no drift.

   It is deliberately simple, and the board prints these constants on screen so
   the audience can audit the arithmetic while it happens.
--------------------------------------------------------------------------- */

/** Probabilities are clamped into this range before anything else happens. */
export const P_MIN = 0.01;
export const P_MAX = 0.99;

/**
 * Extremisation factor applied to the crowd's median log-odds. The standard
 * correction for the well-documented tendency of a crowd to hedge toward 50%.
 */
export const EXTREMISE_A = 1.5;

/**
 * Crowd / model weights in the ensemble, in log-odds. Fixed at 50/50 and
 * labelled as such on the board.
 *
 * The production system weights by resolved track record. The demo cannot,
 * because the demo has no history — nobody in the room has a track record yet,
 * and pretending otherwise would undercut the whole talk. Naming that gap is
 * more persuasive than hiding it, so it is a constant here and a caption there.
 */
export const ENSEMBLE_WEIGHTS = { crowd: 0.5, model: 0.5 };

/** Q1 histogram resolution: 20 bins of 5 percentage points. */
export const HISTOGRAM_BINS = 20;

/** How many approved reasoning lines the aggregate carries to the board. */
export const MAX_NOTES = 12;

/* --- primitives ---------------------------------------------------------- */

export function clampP(p) {
  if (!Number.isFinite(p)) return null;
  return Math.min(P_MAX, Math.max(P_MIN, p));
}

export function logit(p) {
  return Math.log(p / (1 - p));
}

export function invLogit(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Quantile of an already-sorted ascending array, linear interpolation between
 * the two straddling points. Returns null for an empty array.
 */
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return quantileSorted(sorted, 0.5);
}

/* --- the crowd ----------------------------------------------------------- */

/**
 * Steps 1–4 of §7, run over a list of raw probabilities.
 *
 * Clamp, convert to log-odds, take the median (robust to the joker who submits
 * 99%), extremise, convert back. The interquartile range is the band.
 *
 * The quartiles are extremised with the same factor as the median. Scaling
 * log-odds is monotonic, so this keeps the median inside its own band — apply
 * it to the centre only and a tight, confident crowd can produce a median that
 * sits outside its own interquartile range, which would be nonsense on screen.
 */
export function aggregateCrowd(probabilities) {
  const clamped = probabilities.map(clampP).filter((p) => p !== null);
  const n = clamped.length;

  if (n === 0) {
    return { n: 0, median: null, p25: null, p75: null, rawMedian: null, histogram: emptyHistogram() };
  }

  const logits = clamped.map(logit).sort((a, b) => a - b);
  const q25 = quantileSorted(logits, 0.25);
  const q50 = quantileSorted(logits, 0.5);
  const q75 = quantileSorted(logits, 0.75);

  return {
    n,
    median: invLogit(q50 * EXTREMISE_A),
    p25: invLogit(q25 * EXTREMISE_A),
    p75: invLogit(q75 * EXTREMISE_A),
    // The un-extremised median, so the board can show what the correction did.
    rawMedian: invLogit(q50),
    histogram: histogram(clamped)
  };
}

function emptyHistogram() {
  return new Array(HISTOGRAM_BINS).fill(0);
}

/** Counts of raw (un-extremised) probabilities per 5-point bin. */
export function histogram(probabilities) {
  const bins = emptyHistogram();
  for (const p of probabilities) {
    const idx = Math.min(HISTOGRAM_BINS - 1, Math.floor(p * HISTOGRAM_BINS));
    bins[idx] += 1;
  }
  return bins;
}

/* --- the ensemble -------------------------------------------------------- */

/** Step 5 of §7: weighted combination of two probabilities in log-odds. */
export function combine(crowdP, modelP, weights = ENSEMBLE_WEIGHTS) {
  if (crowdP === null || crowdP === undefined) return modelP ?? null;
  if (modelP === null || modelP === undefined) return crowdP;
  const total = weights.crowd + weights.model;
  const x = (weights.crowd * logit(clampP(crowdP)) + weights.model * logit(clampP(modelP))) / total;
  return invLogit(x);
}

/**
 * The ensemble as it appears on Panel C: a point estimate plus a band.
 *
 * The band carries the crowd's interquartile range through the same blend,
 * holding the model fixed — so the width on screen is the room's disagreement,
 * which is exactly what Panel C is there to talk about.
 */
export function ensemble(crowd, modelP, weights = ENSEMBLE_WEIGHTS) {
  if (crowd.n === 0 && (modelP === null || modelP === undefined)) {
    return { p: null, band: [null, null], weights };
  }
  return {
    p: combine(crowd.median, modelP, weights),
    band: [combine(crowd.p25, modelP, weights), combine(crowd.p75, modelP, weights)],
    weights
  };
}

/**
 * Plain-language note on where crowd and model diverge, for Panel C.
 *
 * Divergence is measured in log-odds rather than percentage points, because a
 * gap between 2% and 8% matters far more than the same gap between 45% and 51%.
 */
export function divergence(crowdP, modelP) {
  if (crowdP == null || modelP == null) {
    return { gap: null, direction: 'none', label: 'No model estimate yet.' };
  }
  const gap = logit(clampP(modelP)) - logit(clampP(crowdP));
  const magnitude = Math.abs(gap);
  const direction = gap > 0 ? 'model-higher' : gap < 0 ? 'model-lower' : 'none';

  let label;
  if (magnitude < 0.25) {
    label = 'The room and the model agree. That is a weaker signal than it looks — agreement is only informative once both have a track record.';
  } else if (magnitude < 0.75) {
    label =
      direction === 'model-higher'
        ? 'The model sits a little above the room. Mild disagreement, worth a sentence but not an argument.'
        : 'The model sits a little below the room. Mild disagreement, worth a sentence but not an argument.';
  } else {
    label =
      direction === 'model-higher'
        ? 'The model is materially more pessimistic than the room. That gap is the most useful thing on this screen — it marks the assumption worth arguing about.'
        : 'The room is materially more pessimistic than the model. That gap is the most useful thing on this screen — it marks the assumption worth arguing about.';
  }
  return { gap, direction, label };
}

/* --- magnitude ----------------------------------------------------------- */

/**
 * Aggregate the crowd's three-point magnitude estimates.
 *
 * Each of low / mode / high is aggregated independently by median-of-logs —
 * the geometric median — because these are money figures spanning three orders
 * of magnitude and an arithmetic mean would be dominated by whoever typed the
 * largest number.
 *
 * The three medians are then sorted, so an aggregate can never come back with
 * a low above its own high even if individual submissions were inconsistent.
 */
export function aggregateMagnitude(triples) {
  const valid = triples.filter(
    (t) =>
      t &&
      Number.isFinite(t.low) &&
      Number.isFinite(t.mode) &&
      Number.isFinite(t.high) &&
      t.low > 0 &&
      t.mode > 0 &&
      t.high > 0
  );
  if (valid.length === 0) return { n: 0, low: null, mode: null, high: null };

  const geoMedian = (key) => Math.exp(median(valid.map((t) => Math.log(t[key]))));
  const [low, mode, high] = [geoMedian('low'), geoMedian('mode'), geoMedian('high')].sort((a, b) => a - b);

  return { n: valid.length, low, mode, high };
}

/* --- the whole aggregate ------------------------------------------------- */

/**
 * Build the object served to boards, per §6.
 *
 * Nothing participant-identifying goes in here. No names, no company names, no
 * email — not even a redacted one. The board is a screen in front of 150
 * people, so the safest design is that the payload it polls simply has no
 * field that could hold personal information.
 *
 * @param {Array} forecasts  rows from the append log (already email-free)
 * @param {Object|null} model  the LLM participant's cached artefact
 * @param {Array} notes  approved reasoning lines, newest first
 */
export function buildAggregate(forecasts, model, notes = [], now = Date.now()) {
  const crowd = aggregateCrowd(forecasts.map((f) => f.q1));
  const magnitude = aggregateMagnitude(forecasts.map((f) => f.q2));
  const modelP = model && Number.isFinite(model.p) ? clampP(model.p) : null;
  const ens = ensemble(crowd, modelP);

  return {
    n: forecasts.length,
    seeded: forecasts.filter((f) => f.seeded).length,
    crowd,
    magnitude,
    model: model
      ? {
          p: modelP,
          baseRate: model.baseRate ?? null,
          reasons: (model.reasons ?? []).slice(0, 2),
          ranAt: model.ranAt ?? null,
          live: model.live === true,
          // Carried through so the board can shout about it: the artefact
          // shipped in the repo is a placeholder until `npm run model` replaces it.
          placeholder: model.placeholder === true
        }
      : null,
    ensemble: ens,
    divergence: divergence(crowd.median, modelP),
    byRole: byRole(forecasts),
    byConfidence: byConfidence(forecasts),
    notes: notes.slice(0, MAX_NOTES),
    method: { extremiseA: EXTREMISE_A, weights: ENSEMBLE_WEIGHTS, clamp: [P_MIN, P_MAX] },
    updated: now
  };
}

/** Same pipeline per role, for the diversity view on Panel A. */
export function byRole(forecasts) {
  const out = {};
  for (const f of forecasts) {
    const role = f.role || 'other';
    (out[role] ??= []).push(f.q1);
  }
  return Object.fromEntries(
    Object.entries(out).map(([role, probs]) => {
      const agg = aggregateCrowd(probs);
      return [role, { n: agg.n, median: agg.median }];
    })
  );
}

export function byConfidence(forecasts) {
  const out = {};
  for (const f of forecasts) {
    const c = f.confidence || 'med';
    (out[c] ??= []).push(f.q1);
  }
  return Object.fromEntries(
    Object.entries(out).map(([c, probs]) => {
      const agg = aggregateCrowd(probs);
      return [c, { n: agg.n, median: agg.median }];
    })
  );
}
