/* ---------------------------------------------------------------------------
   The AI decision engine — Clef and Jev.

   A decision model is not an LLM. It reads a state and a set of typed questions
   and returns a probability for every allowed answer: no prose, no reasoning
   tokens, nothing to parse. Cloudflare's Clef and TypeSafe's Jev share one
   request shape (the "System One" API), so one adapter drives both and the
   engine is a config choice rather than a code path.

   Two jobs on stage:

     1. A forecaster. The engine answers the room's question beside the crowd
        and the LLM — on Panel B, never blended into the ensemble.
     2. A decision. Given the room's dollar range from Panel D, the engine picks
        a treatment and says how sure it is. Below a fixed confidence it hands
        the call to a person — Panel E.

   Because a decision model gives no reasons, the only honest input is
   evidence: a cited, dated pack in public/data/evidence.json. checkEvidence()
   is the gate, and the engine is never called on a pack that fails it.

   Everything the engine produces is tagged `source.kind = "ai-decision-engine"`
   so no screen, export or score can mistake it for the crowd or the LLM.

   This module is shared by the Worker, the scripts and the board, so it holds
   no DOM, no Node and no Workers-runtime imports.
--------------------------------------------------------------------------- */

export const SOURCE_KIND = 'ai-decision-engine';
export const SOURCE_LABEL = 'AI decision engine';

/**
 * The engines. Clef runs on Workers AI and is called over its REST API rather
 * than an `env.AI` binding: a binding makes `wrangler dev` demand Cloudflare
 * credentials at startup, which would break local dev for everyone to add an
 * optional panel. Jev is TypeSafe's hosted endpoint.
 */
export const ENGINES = {
  clef: { label: 'Clef', vendor: 'Cloudflare', model: 'clef', route: '@cf/cloudflare/clef' },
  'clef-flash': { label: 'Clef-flash', vendor: 'Cloudflare', model: 'clef-flash', route: '@cf/cloudflare/clef-flash' },
  jev: { label: 'Jev', vendor: 'TypeSafe', model: 'jev-latest' }
};

export const DEFAULT_ENGINE = 'clef';
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';

/**
 * What counts as sufficient evidence. Printed on the board beside the engine,
 * the same way the ensemble weights are, so the audience can see the bar.
 */
export const SUFFICIENCY = {
  /** Cited items required for each part of the question. */
  minPerPart: 2,
  /** Anything older than this is not evidence about the next year. */
  maxAgeMonths: 24,
  /** Each part needs at least one item pointing each way — no one-sided packs. */
  bothDirections: true
};

/**
 * Confidence bands for the decision. TypeSafe's own guidance is three bands:
 * act automatically above one threshold, flag for review in the middle, route
 * to a person below the other. The thresholds are a policy choice, not a
 * property of the model, so they are constants here and captions on screen.
 */
export const BANDS = { act: 0.8, review: 0.5 };

export const BAND_LABELS = {
  act: 'Act — confident enough to proceed',
  review: 'Review — recommended, needs sign-off',
  human: 'Expert required — routed to a person'
};

/** Largest tolerated gap between the whole question and the product of its parts. */
export const CONSISTENCY_TOLERANCE = 0.1;

/* --- the evidence gate ---------------------------------------------------- */

/**
 * Check an evidence pack against SUFFICIENCY. Returns every problem, not just
 * the first, so whoever is curating it can fix the lot in one pass.
 */
export function checkEvidence(pack, now = Date.now()) {
  const problems = [];
  if (!pack || typeof pack !== 'object') return { ok: false, problems: ['No evidence pack.'] };
  if (pack.placeholder) problems.push('The pack is still the shipped placeholder.');

  const parts = pack.parts ?? {};
  const items = Array.isArray(pack.items) ? pack.items : [];
  if (!parts.A || !parts.B) problems.push('The pack must define parts A and B of the question.');

  const cutoff = now - SUFFICIENCY.maxAgeMonths * 30.44 * 86_400_000;

  for (const item of items) {
    const label = item.id ? `"${item.id}"` : 'An item';
    if (item.placeholder) problems.push(`${label} is a placeholder, not evidence.`);
    if (!['A', 'B'].includes(item.part)) problems.push(`${label} must belong to part A or B.`);
    if (!['+', '-'].includes(item.direction)) problems.push(`${label} needs a direction of "+" or "-".`);
    if (typeof item.claim !== 'string' || !item.claim.trim()) problems.push(`${label} has no claim.`);
    if (typeof item.source !== 'string' || !/^https:\/\//.test(item.source)) {
      problems.push(`${label} needs an https source.`);
    }
    const asOf = Date.parse(item.asOf ?? '');
    if (!Number.isFinite(asOf)) problems.push(`${label} needs an asOf date.`);
    else if (asOf < cutoff) problems.push(`${label} is older than ${SUFFICIENCY.maxAgeMonths} months.`);
  }

  for (const part of ['A', 'B']) {
    const usable = items.filter((i) => i.part === part && !i.placeholder);
    if (usable.length < SUFFICIENCY.minPerPart) {
      problems.push(`Part ${part} has ${usable.length} cited item(s); it needs ${SUFFICIENCY.minPerPart}.`);
    }
    if (SUFFICIENCY.bothDirections) {
      const dirs = new Set(usable.map((i) => i.direction));
      if (!dirs.has('+') || !dirs.has('-')) {
        problems.push(`Part ${part} needs at least one item for and one against.`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Treatments feed the decision, so they face the same rule: no unsourced numbers. */
export function checkTreatments(t) {
  const problems = [];
  if (!t || typeof t !== 'object') return { ok: false, problems: ['No treatments file.'] };
  if (t.placeholder) problems.push('The treatments file is still the shipped placeholder.');
  if (!Number.isFinite(t.appetite?.p90Max)) problems.push('Set a risk appetite (appetite.p90Max, AUD).');

  const options = t.options ?? {};
  for (const key of ['accept', 'mitigate', 'transfer', 'escalate']) {
    const o = options[key];
    if (!o) {
      problems.push(`Missing the "${key}" option.`);
      continue;
    }
    if (!Number.isFinite(o.annualCost) || o.annualCost < 0) problems.push(`"${key}" needs an annualCost (AUD).`);
    if (!Number.isFinite(o.lossReduction) || o.lossReduction < 0 || o.lossReduction > 1) {
      problems.push(`"${key}" needs a lossReduction between 0 and 1.`);
    }
    if (key !== 'accept' && key !== 'escalate' && !(typeof o.source === 'string' && /^https:\/\//.test(o.source))) {
      problems.push(`"${key}" needs an https source for its cost and effect.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* --- building requests ---------------------------------------------------- */

/**
 * The state for the forecast. Structured JSON rather than prose: the API takes
 * either, and JSON keeps every item addressable so one can be left out for
 * attribution without rewording anything around it.
 */
export function forecastState(question, pack, { omit = null } = {}) {
  return {
    asOf: pack.asOf ?? null,
    question: {
      claim: question.text,
      resolutionDate: question.resolutionDate,
      resolutionSource: question.resolutionSource,
      resolvesNoIf: question.resolvesNoIf,
      scope: question.ambiguityRule
    },
    decomposition: { A: pack.parts?.A ?? null, B: pack.parts?.B ?? null },
    evidence: (pack.items ?? [])
      .filter((i) => i.id !== omit)
      .map(({ id, part, direction, claim, source, asOf }) => ({ id, part, direction, claim, source, asOf }))
  };
}

/**
 * Three yes/no questions in one call. The question is conjunctive, and asking
 * for the parts separately is what lets the board show which part is doing
 * the work — and catch the engine if the whole disagrees with its parts.
 */
export function forecastRequest(engine, question, pack, opts = {}) {
  return {
    model: engineSpec(engine).model,
    state: forecastState(question, pack, opts),
    questions: {
      part_a: { type: 'noul', instructions: `By ${question.resolutionDate}, will this happen? ${pack.parts?.A}` },
      part_b_given_a: {
        type: 'noul',
        instructions: `Assume part A happens. Will it then be publicly documented to the standard in resolutionSource by ${question.resolutionDate}? ${pack.parts?.B}`
      },
      claim: { type: 'noul', instructions: `Will this question resolve YES? ${question.text}` }
    }
  };
}

/**
 * The money from Panel D plus the treatments, as a decision. The arithmetic is
 * done here, not by the engine — a decision model is for judgement, and asking
 * it to multiply would waste the one thing it is good at.
 */
export function decisionState(context, treatments) {
  const { ensembleP, run } = context;
  const appetite = treatments.appetite.p90Max;
  const options = Object.fromEntries(
    Object.entries(treatments.options).map(([key, o]) => {
      const avoided = run.mean * o.lossReduction;
      const residualP90 = run.p90 * (1 - o.lossReduction);
      return [
        key,
        {
          description: o.description,
          annualCost: o.annualCost,
          lossReduction: o.lossReduction,
          expectedLossAvoided: Math.round(avoided),
          returnOnSpend: o.annualCost > 0 ? round2((avoided - o.annualCost) / o.annualCost) : null,
          residualP90: Math.round(residualP90),
          withinAppetite: residualP90 <= appetite,
          source: o.source ?? null
        }
      ];
    })
  );

  return {
    organisation: treatments.organisation ?? 'Mid-size Australian organisation, 500–2,000 staff',
    risk: context.question,
    annualProbability: round2(ensembleP),
    expectedAnnualLoss: Math.round(run.mean),
    medianYear: Math.round(run.p50),
    p90AnnualLoss: Math.round(run.p90),
    riskAppetite: { p90Max: appetite, note: treatments.appetite.note ?? null },
    options,
    currency: 'AUD'
  };
}

export function decisionRequest(engine, context, treatments) {
  const criteria = Object.fromEntries(Object.entries(treatments.options).map(([k, o]) => [k, o.description]));
  return {
    model: engineSpec(engine).model,
    state: decisionState(context, treatments),
    questions: {
      action: {
        type: 'choice',
        instructions:
          'Which treatment should this organisation choose for this risk this year, given the probability, the loss range, the risk appetite and each option’s cost and effect?',
        criteria
      }
    }
  };
}

/* --- calling an engine ---------------------------------------------------- */

export function engineSpec(engine) {
  const spec = ENGINES[engine];
  if (!spec) throw new Error(`unknown_engine:${engine}`);
  return spec;
}

/**
 * One System One call. `env` carries the credentials — Worker secrets on the
 * server, process.env in the scripts — and nothing here reads them any other
 * way, so the browser can import this module without ever holding a key.
 *
 *   Clef:  CF_ACCOUNT_ID + CF_AI_TOKEN (a token with Workers AI read)
 *   Jev:   TYPESAFE_API_KEY, optionally TYPESAFE_API_URL
 */
export async function callEngine(engine, body, { env = {}, fetchFn = fetch, signal } = {}) {
  const spec = engineSpec(engine);
  let url;
  let token;
  if (engine === 'jev') {
    url = env.TYPESAFE_API_URL || JEV_URL;
    token = env.TYPESAFE_API_KEY;
    if (!token) throw new Error('missing_credentials:TYPESAFE_API_KEY');
  } else {
    if (!env.CF_ACCOUNT_ID || !env.CF_AI_TOKEN) throw new Error('missing_credentials:CF_ACCOUNT_ID,CF_AI_TOKEN');
    url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${spec.route}`;
    token = env.CF_AI_TOKEN;
  }

  const started = Date.now();
  const res = await fetchFn(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`upstream_${res.status}`);

  const data = await res.json();
  // Workers AI wraps every response in { result, success }; Jev does not.
  const out = data && typeof data === 'object' && 'result' in data ? data.result : data;
  if (!out || typeof out.answers !== 'object') throw new Error('no_answers');
  return { answers: out.answers, model: out.model ?? spec.model, ms: Date.now() - started };
}

/* --- reading answers ------------------------------------------------------ */

/**
 * A noul answer's probability. The documented field is `noul`; the others are
 * accepted because the API is days old and a renamed field should degrade to
 * "no answer", never to a wrong one.
 */
export function readNoul(answer) {
  const v = answer?.noul ?? answer?.probability ?? answer?.p;
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

/**
 * A choice answer. `confidence` is the vendor's own figure, from the shape of
 * the distribution. If it is missing we do not invent one: a decision with no
 * stated confidence goes to a person.
 */
export function readChoice(answer, allowed) {
  const probs = answer?.probabilities ?? answer?.probs ?? answer?.distribution ?? null;
  const probabilities = {};
  if (probs && typeof probs === 'object') {
    for (const key of allowed) if (Number.isFinite(probs[key])) probabilities[key] = probs[key];
  }
  let choice = allowed.includes(answer?.choice) ? answer.choice : null;
  if (!choice && Object.keys(probabilities).length) {
    choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  }
  const c = answer?.confidence;
  const confidence = Number.isFinite(c) && c >= 0 && c <= 1 ? c : null;
  return { choice, probabilities, confidence };
}

export function band(confidence) {
  if (confidence == null) return 'human';
  if (confidence >= BANDS.act) return 'act';
  if (confidence >= BANDS.review) return 'review';
  return 'human';
}

/* --- artefacts ------------------------------------------------------------ */

/** The provenance block every engine output carries. */
export function provenance(engine, extra = {}) {
  const spec = engineSpec(engine);
  return {
    kind: SOURCE_KIND,
    label: SOURCE_LABEL,
    engine,
    engineLabel: spec.label,
    vendor: spec.vendor,
    model: spec.route ?? spec.model,
    ...extra
  };
}

/**
 * Turn the three noul answers into the forecast the board shows.
 * Returns null if the engine did not answer the headline question.
 */
export function forecastFromAnswers(answers) {
  const p = readNoul(answers?.claim);
  if (p == null) return null;
  const a = readNoul(answers?.part_a);
  const b = readNoul(answers?.part_b_given_a);
  const product = a != null && b != null ? a * b : null;
  const gap = product != null ? p - product : null;
  return {
    p: clamp(p),
    parts: { a, bGivenA: b, product },
    consistency: { gap, ok: gap == null ? null : Math.abs(gap) <= CONSISTENCY_TOLERANCE }
  };
}

/**
 * Leave-one-out attribution: how far the headline probability moves when each
 * item is withheld. This is the decision engine's "reasons" — it cannot argue,
 * so the board shows which evidence moved it instead.
 *
 * @param {number} p  with everything
 * @param {Array<{id:string, claim:string, p:number|null}>} without  one run per omitted item
 */
export function attribution(p, without, top = 2) {
  return without
    .filter((w) => w.p != null)
    .map((w) => ({ id: w.id, claim: w.claim, part: w.part, delta: round3(p - w.p) }))
    // An item that moved nothing is not a reason, and "0 pts" on screen is noise.
    .filter((w) => Math.abs(w.delta) >= 0.005)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, top);
}

/**
 * What the aggregate carries to the board. Trimmed to what is drawn, and
 * passed through unchanged otherwise — the board is the place that decides how
 * loudly to flag a placeholder, not this.
 */
export function engineSummary(artefact) {
  if (!artefact || !Number.isFinite(artefact.p)) return null;
  return {
    p: clamp(artefact.p),
    parts: artefact.parts ?? null,
    consistency: artefact.consistency ?? null,
    // Without the evidence ids: the board draws the claim, and the deploy check
    // treats any "id" in the polled payload as a possible participant field.
    attribution: (artefact.attribution ?? []).slice(0, 2).map(({ claim, part, delta }) => ({ claim, part, delta })),
    crossCheck: artefact.crossCheck ?? null,
    evidence: artefact.evidence ?? null,
    source: artefact.source ?? null,
    placeholder: artefact.placeholder === true
  };
}

/* --- helpers -------------------------------------------------------------- */

function clamp(p) {
  return Math.min(0.99, Math.max(0.01, p));
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** SHA-256 hex of a string, for stamping which evidence an artefact came from. */
export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
