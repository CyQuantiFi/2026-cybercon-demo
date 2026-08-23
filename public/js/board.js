/* ---------------------------------------------------------------------------
   Presenter board — §4.

   Four panels revealed by keypress so the reveal matches the narration, and a
   2-second poll against /api/agg. Polling rather than WebSockets, deliberately:
   it survives flaky venue Wi-Fi and needs no reconnect logic. A poll that fails
   is simply a poll that failed; the next one is two seconds away.

   Every failure path lands on the bundled snapshot rather than on an error, so
   a network collapse mid-talk degrades the numbers rather than the narration.
--------------------------------------------------------------------------- */

import { HISTOGRAM_BINS } from './aggregate.js';
import { runFairChain, formatAud } from './montecarlo.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/** ?offline=1 runs the entire narration off the snapshot, no network at all. */
const OFFLINE = params.get('offline') === '1';
const POLL_MS = Number(params.get('poll') || 2000);

const state = {
  questions: null,
  aggregate: null,
  snapshot: null,
  revealed: 0,
  etag: null,
  source: OFFLINE ? 'snapshot' : 'live',
  lastN: 0,
  lastChangeAt: 0,
  noteCursor: 0,
  notesKey: null
};

boot();

async function boot() {
  fitToViewport();
  window.addEventListener('resize', fitToViewport);

  const [questions, snapshot] = await Promise.all([
    fetch('data/questions.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('data/snapshot.json', { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => null)
  ]);

  state.questions = questions;
  state.snapshot = snapshot;
  const activeQ = questions.frequency[questions.activeFrequency];
  $('questionText').textContent = activeQ.display ?? activeQ.text;

  wireKeys();

  if (OFFLINE) {
    applySnapshot();
  } else {
    await poll();
    setInterval(poll, POLL_MS);
  }

  // Rotate the reasoning lines independently of the poll, so they move at a
  // readable pace rather than whenever a submission happens to land.
  setInterval(rotateNotes, 5000);

  // Reveal panel A immediately — the presenter is already talking about it.
  reveal(1);
}

/* --- fit the 1920×1080 stage to whatever the projector is ------------------- */

function fitToViewport() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const stage = $('stage');
  stage.style.transform = `scale(${scale})`;
  document.body.style.width = `${1920 * scale}px`;
  document.body.style.height = `${1080 * scale}px`;
  document.body.style.margin = '0 auto';
}

/* --- keyboard --------------------------------------------------------------- */

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
      e.preventDefault();
      reveal(state.revealed + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      reveal(state.revealed - 1);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      reveal(Number(e.key));
    } else if (e.key === '0') {
      reveal(0);
    } else if (e.key.toLowerCase() === 'r') {
      rerunModel();
    } else if (e.key.toLowerCase() === 's') {
      applySnapshot();
    }
  });
}

function reveal(n) {
  state.revealed = Math.max(0, Math.min(4, n));
  for (const id of ['panelA', 'panelB', 'panelC', 'panelD']) {
    const el = $(id);
    el.dataset.revealed = Number(el.dataset.panel) <= state.revealed ? '1' : '0';
  }
}

/* --- data ------------------------------------------------------------------- */

async function poll() {
  try {
    const headers = state.etag ? { 'if-none-match': state.etag } : {};
    const res = await fetch('/api/agg', { headers, cache: 'no-store' });

    if (res.status === 304) {
      setStatus('');
      return;
    }
    if (!res.ok) throw new Error(`http ${res.status}`);

    state.etag = res.headers.get('etag');
    apply(await res.json(), res.headers.get('etag') && 'live');
  } catch {
    // The board would rather draw the dry run than draw nothing. Only fall
    // back once, and say so quietly in the bottom bar rather than on the panels.
    if (state.source !== 'snapshot') {
      applySnapshot();
      setStatus('Network unavailable — showing the dry-run snapshot', 'offline');
    }
  }
}

function applySnapshot() {
  if (!state.snapshot) {
    setStatus('No snapshot bundled', 'offline');
    return;
  }
  state.source = 'snapshot';
  apply(state.snapshot.aggregate, 'snapshot');
  setStatus(OFFLINE ? 'Offline mode — dry-run snapshot' : 'Snapshot', 'offline');
}

function apply(aggregate, source) {
  if (!aggregate) return;
  if (source === 'live') {
    state.source = 'live';
    if (aggregate.stale) setStatus('Serving cached aggregate', 'stale');
    else setStatus('');
  }

  if (aggregate.n !== state.lastN) {
    state.lastN = aggregate.n;
    state.lastChangeAt = Date.now();
  }

  state.aggregate = aggregate;
  render();
}

/* --- render ----------------------------------------------------------------- */

function render() {
  const a = state.aggregate;

  renderTopBar(a);
  renderCrowd(a);
  renderModel(a);
  renderEnsemble(a);
  renderMoney(a);

  const m = a.method;
  $('method').textContent =
    `Method: clamp ${m.clamp[0]}–${m.clamp[1]} · median in log-odds · extremise ×${m.extremiseA} · ` +
    `ensemble ${m.weights.crowd * 100}/${m.weights.model * 100} in log-odds · lognormal magnitude · 10,000 iterations`;
}

function renderTopBar(a) {
  $('count').textContent = String(a.n);
  // Live only while something actually landed in the last 15 seconds.
  $('liveFlag').dataset.live = Date.now() - state.lastChangeAt < 15000 ? '1' : '0';
  $('liveFlag').textContent = state.source === 'snapshot' ? 'Dry-run snapshot' : 'Live now';
  $('seedNote').textContent = a.seeded > 0 ? `includes ${a.seeded} pre-seeded from the dry run` : '';
}

function renderCrowd(a) {
  const c = a.crowd;
  $('crowdMedian').textContent = pct(c.median);
  $('crowdIqr').textContent = c.p25 == null ? '—' : `${pct(c.p25)} – ${pct(c.p75)}`;
  $('crowdRaw').textContent = pct(c.rawMedian);

  const peak = Math.max(1, ...c.histogram);
  const binOf = (p) => Math.min(HISTOGRAM_BINS - 1, Math.floor(p * HISTOGRAM_BINS));
  const lo = c.p25 == null ? -1 : binOf(c.p25);
  const hi = c.p75 == null ? -1 : binOf(c.p75);

  $('hist').replaceChildren(
    ...c.histogram.map((count, i) => {
      const bar = document.createElement('div');
      bar.className = 'hist__bar';
      bar.dataset.inIqr = i >= lo && i <= hi ? '1' : '0';
      bar.style.height = `${Math.max(3, (count / peak) * 100)}%`;
      return bar;
    })
  );

  renderNotes();
}

/**
 * Three reasoning lines at a time, rotating through the approved pool. This is
 * the thing that makes Panel A worth looking at for more than five seconds.
 *
 * Rebuilt only when the visible three actually change. Rebuilding on every poll
 * would restart the fade animation twice a second, and a block of text that
 * flickers on a projector reads as a fault rather than as motion.
 */
function renderNotes() {
  const notes = state.aggregate?.notes ?? [];
  const wrap = $('crowdNotes');

  const key = `${state.noteCursor}|${notes.map((n) => n.note).join('\n')}`;
  if (key === state.notesKey) return;
  state.notesKey = key;

  if (notes.length === 0) {
    const p = document.createElement('p');
    p.className = 'reasons__empty';
    p.textContent = 'Reasoning appears here once approved.';
    wrap.replaceChildren(p);
    return;
  }

  const window3 = [0, 1, 2].map((i) => notes[(state.noteCursor + i) % notes.length]);
  wrap.replaceChildren(
    ...window3.map((n) => {
      const div = document.createElement('div');
      div.className = 'reasons__item';

      // Text and attribution are separate boxes so the clamp trims the quote
      // and never the byline — an anonymous quote with no role attached is the
      // one thing Panel A must not show.
      const text = document.createElement('p');
      text.className = 'reasons__text';
      text.textContent = `“${n.note}”`;

      const meta = document.createElement('span');
      meta.className = 'reasons__meta';
      meta.textContent = `${roleLabel(n.role)} · forecast ${pct(n.q1)}`;

      div.append(text, meta);
      return div;
    })
  );
}

function rotateNotes() {
  const notes = state.aggregate?.notes ?? [];
  if (notes.length <= 3) return;
  state.noteCursor = (state.noteCursor + 3) % notes.length;
  renderNotes();
}

function renderModel(a) {
  const m = a.model;
  if (!m) {
    $('modelP').textContent = '—';
    $('modelBase').textContent = 'No model artefact loaded.';
    $('modelReasons').replaceChildren();
    $('modelStamp').textContent = '';
    return;
  }

  $('modelP').textContent = pct(m.p);
  $('modelBase').textContent = m.baseRate ?? '';
  $('modelReasons').replaceChildren(
    ...m.reasons.map((r) => {
      const li = document.createElement('li');
      li.className = 'reasons__item';
      li.textContent = r;
      return li;
    })
  );
  // Loud on purpose. The shipped artefact is a placeholder and this is the
  // only thing standing between forgetting `npm run model` and showing a made-
  // up number to a room.
  if (m.placeholder) {
    $('modelStamp').textContent = 'PLACEHOLDER — no model call has been made. Run `npm run model`.';
    $('modelStamp').style.color = 'var(--pink)';
    return;
  }
  $('modelStamp').style.color = '';
  $('modelStamp').textContent = m.ranAt
    ? `${m.live ? 'Re-run live' : 'Pre-computed'} ${new Date(m.ranAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })} · one participant among ${a.n}, not a tiebreaker`
    : 'One participant among many, not a tiebreaker';
}

function renderEnsemble(a) {
  const e = a.ensemble;
  $('ensembleP').textContent = pct(e.p);
  $('divergence').textContent = a.divergence.label;

  const w = e.weights;
  $('weights').textContent =
    `Weights fixed at ${w.crowd * 100}/${w.model * 100}. Nobody here has a track record yet — ` +
    'the production system weights by resolved accuracy, and this one cannot, because it has no history.';

  const place = (id, p) => {
    const el = $(id);
    if (p == null) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = `${p * 100}%`;
  };

  if (e.band[0] != null && e.band[1] != null) {
    $('bandRange').style.left = `${e.band[0] * 100}%`;
    $('bandRange').style.width = `${(e.band[1] - e.band[0]) * 100}%`;
  }
  place('tickCrowd', a.crowd.median);
  place('tickModel', a.model?.p);
  place('tickEns', e.p);
}

function renderMoney(a) {
  const p = a.ensemble.p;
  const magnitude = a.magnitude;

  if (p == null || !magnitude || magnitude.n === 0) {
    for (const id of ['lossP50', 'lossMean', 'lossP90']) $(id).textContent = '—';
    $('conditional').textContent = 'Waiting on magnitude estimates from the room.';
    return;
  }

  // The whole Monte Carlo runs here, in the board's browser, in roughly 30ms.
  // No server compute to fail on stage.
  const run = runFairChain(p, magnitude);
  if (!run) return;

  $('lossP50').textContent = formatAud(run.p50);
  $('lossMean').textContent = formatAud(run.mean);
  $('lossP90').textContent = formatAud(run.p90);

  $('conditional').textContent =
    `Most years cost nothing. If it happens, the room's own range puts it between ` +
    `${formatAud(run.conditional.p10)} and ${formatAud(run.conditional.p90)}, ` +
    `centred on ${formatAud(run.conditional.p50)}.`;

  drawCurve(run);
}

/**
 * Loss exceedance curve on a log-x scale: the probability that a single year
 * costs more than a given amount. Log-x because the interesting part spans
 * three orders of magnitude and a linear axis would bunch it all at the left.
 */
function drawCurve(run) {
  const svg = $('curve');
  const W = 640;
  const H = 220;

  const points = run.exceedance.filter((d) => d.loss > 0);
  if (points.length < 2) {
    svg.replaceChildren();
    return;
  }

  const minLoss = Math.max(1000, points[0].loss);
  const maxLoss = Math.max(points[points.length - 1].loss, minLoss * 10);
  const x = (loss) => (Math.log(Math.max(loss, minLoss) / minLoss) / Math.log(maxLoss / minLoss)) * W;
  const y = (ex) => H - ex * H;

  const path = points.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(d.loss).toFixed(1)},${y(d.exceedance).toFixed(1)}`).join('');

  const ns = 'http://www.w3.org/2000/svg';
  const fill = document.createElementNS(ns, 'path');
  fill.setAttribute('class', 'curve__fill');
  fill.setAttribute('d', `${path}L${W},${H}L0,${H}Z`);

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('class', 'curve__line');
  line.setAttribute('d', path);

  const grid = [0.25, 0.5, 0.75].map((g) => {
    const el = document.createElementNS(ns, 'line');
    el.setAttribute('class', 'curve__grid');
    el.setAttribute('x1', '0');
    el.setAttribute('x2', String(W));
    el.setAttribute('y1', String(y(g)));
    el.setAttribute('y2', String(y(g)));
    return el;
  });

  svg.replaceChildren(...grid, fill, line);

  // Vertical axis, overlaid in HTML so it is not stretched with the SVG.
  $('curveY').replaceChildren(
    ...[0.75, 0.5, 0.25].map((g) => {
      const span = document.createElement('span');
      span.textContent = `${g * 100}%`;
      span.style.top = `${(1 - g) * 100}%`;
      return span;
    })
  );

  // Axis labels at four decades across the drawn range.
  $('curveAxis').replaceChildren(
    ...[0, 0.33, 0.66, 1].map((t) => {
      const span = document.createElement('span');
      span.textContent = formatAud(minLoss * Math.pow(maxLoss / minLoss, t));
      return span;
    })
  );
}

/* --- optional live re-run of the model -------------------------------------- */

async function rerunModel() {
  if (state.source === 'snapshot' || OFFLINE) return;
  setStatus('Re-running the model…');
  try {
    const res = await fetch('/api/model/rerun', { method: 'POST' });
    const data = await res.json();
    // Never surfaced as an error: the cached artefact is still on screen and
    // the narration does not depend on this working.
    setStatus(data.ok ? 'Model re-run complete' : '');
    state.etag = null;
    await poll();
  } catch {
    setStatus('');
  }
}

/* --- helpers ------------------------------------------------------------------ */

function roleLabel(value) {
  return state.questions?.roles.find((r) => r.value === value)?.label ?? 'Other';
}

function pct(p) {
  return p == null ? '—' : `${Math.round(p * 100)}%`;
}

function setStatus(text, kind = '') {
  const el = $('boardStatus');
  el.textContent = text;
  el.dataset.state = kind;
}
