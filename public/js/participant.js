/* ---------------------------------------------------------------------------
   Participant app — §3.

   Six screens, no framework, no build step. The whole job is to get someone
   from a QR scan to a submitted forecast in under 45 seconds, on a three-year-
   old Android, on venue Wi-Fi that may be actively hostile.

   The forecast is written to localStorage before it is ever sent, and a retry
   loop pushes it until the server acknowledges. A dropped connection or an
   accidental refresh therefore cannot lose a submission — the worst case is
   that it lands late.
--------------------------------------------------------------------------- */

import { clampP, HISTOGRAM_BINS } from './aggregate.js';
import { formatAud } from './montecarlo.js';

const STORE_KEY = 'cyq.forecast.v1';
const SCREENS = ['question', 'reasoning', 'magnitude', 'role', 'done', 'live'];

const $ = (id) => document.getElementById(id);

const state = {
  questions: null,
  frequency: null,
  screen: 'question',
  /** The forecast being built. `id` is generated once and reused for edits. */
  forecast: { id: uuid(), q1: 0.5, q2: null, note: null, confidence: 'med', role: null },
  submitted: false,
  aggregate: null,
  pollTimer: null,
  flushTimer: null
};

boot();

async function boot() {
  restore();
  state.questions = await (await fetch('data/questions.json', { cache: 'no-store' })).json();
  state.frequency = state.questions.frequency[state.questions.activeFrequency];

  renderQuestion();
  renderConfidence();
  renderMagnitude();
  renderRoles();
  renderPrivacy();
  wire();

  show(state.submitted ? 'done' : 'question');
  flushPending();
}

/* --- persistence ---------------------------------------------------------- */

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && saved.forecast && typeof saved.forecast.id === 'string') {
      state.forecast = { ...state.forecast, ...saved.forecast };
      state.submitted = saved.submitted === true;
    }
  } catch {
    /* corrupt storage is not worth a broken app; start fresh */
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ forecast: state.forecast, submitted: state.submitted }));
  } catch {
    /* private browsing with storage disabled — the retry loop still works
       in-memory for the life of the page */
  }
}

/* --- screens -------------------------------------------------------------- */

function show(name) {
  state.screen = name;
  for (const s of SCREENS) {
    const el = $(`screen-${s}`);
    if (el) el.hidden = s !== name;
  }
  $('progressBar').style.width = `${((SCREENS.indexOf(name) + 1) / SCREENS.length) * 100}%`;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  if (name === 'done' || name === 'live') startPolling();
  else stopPolling();
}

function wire() {
  for (const btn of document.querySelectorAll('[data-go]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.skip) state.forecast.q2 = null;
      if (btn.dataset.go === 'live' || btn.dataset.go === 'done') persist();
      show(btn.dataset.go);
    });
  }

  const slider = $('q1Slider');
  slider.value = String(Math.round(state.forecast.q1 * 100));
  slider.addEventListener('input', () => {
    state.forecast.q1 = clampP(Number(slider.value) / 100);
    $('q1Value').textContent = `${slider.value}%`;
    persist();
  });
  $('q1Value').textContent = `${slider.value}%`;

  const note = $('note');
  note.value = state.forecast.note ?? '';
  $('noteCount').textContent = String(note.value.length);
  note.addEventListener('input', () => {
    state.forecast.note = note.value.trim() || null;
    $('noteCount').textContent = String(note.value.length);
    persist();
  });

  $('emailSubmit').addEventListener('click', submitEmail);

  // A connection that comes back is the most likely moment for a stuck
  // submission to succeed, so try immediately rather than waiting for the timer.
  window.addEventListener('online', flushPending);
}

/* --- screen 1: the question ------------------------------------------------ */

function renderQuestion() {
  const q = state.frequency;
  $('q1Eyebrow').textContent = q.eyebrow;
  // The headline is the short form; the full claim — the thing actually scored,
  // and the thing scripts/score.mjs quotes back a year later — sits one tap
  // away rather than being deleted to save space.
  $('q1Text').textContent = q.display ?? q.text;
  $('q1Claim').textContent = q.text;
  $('q1Date').textContent = formatDate(q.resolutionDate);
  $('q1Source').textContent = q.resolutionSource;
  $('q1No').textContent = q.resolvesNoIf;
  $('q1Scope').textContent = q.ambiguityRule;
  $('resolveDate').textContent = formatDate(q.resolutionDate);
  // Driven by the question set too. A hardcoded example about edge appliances
  // survived a question change once already; anything that names the subject
  // belongs next to the subject.
  if (q.notePlaceholder) $('note').placeholder = q.notePlaceholder;
}

/* --- screen 2: reasoning --------------------------------------------------- */

function renderConfidence() {
  const wrap = $('confidenceChips');
  wrap.replaceChildren(
    ...state.questions.confidence.map((c) =>
      chip(c.label, c.value === state.forecast.confidence, () => {
        state.forecast.confidence = c.value;
        persist();
        renderConfidence();
      })
    )
  );
}

/* --- screen 3: magnitude --------------------------------------------------- */

/**
 * Log-scale sliders. Money here spans four orders of magnitude, so a linear
 * track would put every plausible answer inside the first two per cent of it.
 */
function renderMagnitude() {
  const q2 = state.questions.magnitude;
  $('q2Text').textContent = q2.display ?? q2.text;
  if (q2.detail) $('q2Detail').textContent = q2.detail;

  const { min, max, defaults, fields, anchors } = q2.answer;
  const current = state.forecast.q2 ?? { ...defaults };

  const toSlider = (v) => Math.round((Math.log(v / min) / Math.log(max / min)) * 1000);
  const fromSlider = (t) => min * Math.pow(max / min, t / 1000);

  const wrap = $('q2Fields');
  wrap.replaceChildren();

  for (const field of fields) {
    const row = document.createElement('div');
    row.className = 'money';

    const head = document.createElement('div');
    head.className = 'money__head';
    const label = document.createElement('p');
    label.className = 'money__label';
    label.textContent = field.label;
    const val = document.createElement('output');
    val.className = 'money__val num';
    val.textContent = formatAud(current[field.key]);
    head.append(label, val);

    const hint = document.createElement('p');
    hint.className = 'money__hint';
    hint.textContent = field.hint;

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider';
    input.min = '0';
    input.max = '1000';
    input.step = '1';
    input.value = String(toSlider(current[field.key]));
    input.setAttribute('aria-label', `${field.label} — ${field.hint}`);

    input.addEventListener('input', () => {
      current[field.key] = roundMoney(fromSlider(Number(input.value)));
      val.textContent = formatAud(current[field.key]);
      // Kept as given rather than reordered here — the aggregate sorts the
      // three medians, so one person answering out of order costs nothing and
      // being corrected mid-drag would fight their thumb.
      state.forecast.q2 = { ...current };
      persist();
    });

    const scale = document.createElement('div');
    scale.className = 'money__anchors';
    scale.append(...anchors.map((a) => Object.assign(document.createElement('span'), { textContent: formatAud(a) })));

    row.append(head, hint, input, scale);
    wrap.append(row);
  }

  state.forecast.q2 ??= { ...defaults };
}

function roundMoney(v) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  return Math.round(v / magnitude) * magnitude;
}

/* --- screen 4: role, and the submit ---------------------------------------- */

function renderRoles() {
  const wrap = $('roleChips');
  wrap.replaceChildren(
    ...state.questions.roles.map((r) =>
      chip(r.label, r.value === state.forecast.role, () => {
        state.forecast.role = r.value;
        persist();
        submitForecast();
        show('done');
        renderDone();
      })
    )
  );
}

function chip(label, checked, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', String(checked));
  btn.textContent = label;
  btn.addEventListener('click', onPick);
  return btn;
}

/**
 * Queue the forecast and start pushing. Nothing here awaits the network: the
 * participant moves to the next screen immediately and the retry loop deals
 * with whatever the venue Wi-Fi is doing.
 */
function submitForecast() {
  state.submitted = true;
  persist();
  enqueue({ ...state.forecast });
  flushPending();
}

/* --- screen 5: submitted --------------------------------------------------- */

function renderDone() {
  $('yourP').textContent = `${Math.round(state.forecast.q1 * 100)}%`;
  renderCrowdComparison();
}

function renderPrivacy() {
  const p = state.questions.privacy;
  const notice = $('privacyNotice');
  notice.textContent = `${p.notice} `;
  const link = document.createElement('a');
  link.href = p.policyUrl;
  link.textContent = 'See our privacy policy.';
  notice.append(link);

  // Two separate boxes, both unticked. Bundled consent is not consent, so
  // marketing use requires its own tick and cannot ride on the outcome one.
  $('consentOutcomeLabel').textContent = p.consents[0].label;
  $('consentMarketingLabel').textContent = p.consents[1].label;
}

async function submitEmail() {
  const email = $('email').value.trim();
  const outcome = $('consentOutcome').checked;
  const marketing = $('consentMarketing').checked;
  const err = $('emailError');
  err.hidden = true;

  if (!email) return fail(err, 'Add an email first, or skip this entirely.');
  if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return fail(err, "That doesn't look like an email address.");
  if (!outcome && !marketing) return fail(err, 'Tick at least one box so we know what you want.');

  enqueue({
    ...state.forecast,
    email,
    consent: { outcome, marketing, text: state.questions.privacy.noticeVersion, ts: Date.now() }
  });
  await flushPending();

  $('emailSubmit').textContent = 'Saved — we will be in touch on the date';
  $('emailSubmit').disabled = true;
}

function fail(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function renderCrowdComparison() {
  const agg = state.aggregate;
  const yours = state.forecast.q1;

  if (!agg || agg.n === 0) {
    $('crowdP').textContent = '—';
    $('crowdN').textContent = '';
    $('yourPosition').textContent = 'You are early. The room is still arriving.';
    return;
  }

  $('crowdP').textContent = `${Math.round(agg.crowd.median * 100)}%`;
  $('crowdN').textContent = `(${agg.n})`;

  const bins = agg.crowd.histogram;
  const total = bins.reduce((a, b) => a + b, 0) || 1;
  const yourBin = Math.min(HISTOGRAM_BINS - 1, Math.floor(yours * HISTOGRAM_BINS));
  const below = bins.slice(0, yourBin).reduce((a, b) => a + b, 0);
  const pct = Math.round((below / total) * 100);

  $('yourPosition').textContent =
    pct >= 60
      ? `You are more pessimistic than about ${pct}% of the room.`
      : pct <= 40
        ? `You are more optimistic than about ${100 - pct}% of the room.`
        : 'You are sitting close to the middle of the room.';

  drawHistogram($('miniHist'), bins, yourBin);
}

function drawHistogram(el, bins, highlight = -1) {
  const peak = Math.max(1, ...bins);
  el.replaceChildren(
    ...bins.map((count, i) => {
      const bar = document.createElement('div');
      bar.className = 'minihist__bar' + (i === highlight ? ' minihist__bar--you' : '');
      bar.style.height = `${Math.max(2, (count / peak) * 100)}%`;
      return bar;
    })
  );
}

/* --- screen 6: live mirror -------------------------------------------------- */

function renderLive() {
  const agg = state.aggregate;
  if (!agg) return;

  $('liveN').textContent = String(agg.n);
  $('liveCrowd').textContent = pct(agg.crowd.median);
  $('liveModel').textContent = pct(agg.model?.p);
  $('liveEnsemble').textContent = pct(agg.ensemble.p);
  drawHistogram($('liveHist'), agg.crowd.histogram);

  const list = $('liveNotes');
  if (!agg.notes.length) {
    const li = document.createElement('li');
    li.className = 'notes__empty';
    li.textContent = 'Nothing approved yet. Reasoning appears here once the presenter waves it through.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...agg.notes.slice(0, 6).map((n) => {
      const li = document.createElement('li');
      li.textContent = n.note;
      const meta = document.createElement('span');
      meta.className = 'notes__meta';
      meta.textContent = `${roleLabel(n.role)} · ${Math.round(n.q1 * 100)}%`;
      li.append(meta);
      return li;
    })
  );
}

function roleLabel(value) {
  return state.questions.roles.find((r) => r.value === value)?.label ?? 'Other';
}

function pct(p) {
  return p == null ? '—' : `${Math.round(p * 100)}%`;
}

/* --- polling --------------------------------------------------------------- */

function startPolling() {
  if (state.pollTimer) return;
  poll();
  state.pollTimer = setInterval(poll, 2500);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function poll() {
  try {
    const res = await fetch('/api/agg', { cache: 'no-store' });
    if (!res.ok) return;
    state.aggregate = await res.json();
    if (state.screen === 'done') renderCrowdComparison();
    if (state.screen === 'live') renderLive();
  } catch {
    // Silent. The phone is a mirror of the board, not the record — the record
    // is already queued locally and will push when the network returns.
  }
}

/* --- the retry queue -------------------------------------------------------- */

const QUEUE_KEY = 'cyq.pending.v1';

function enqueue(payload) {
  const queue = readQueue().filter((p) => !(p.id === payload.id && !!p.email === !!payload.email));
  queue.push(payload);
  writeQueue(queue);
  setStatus('Saving your forecast…', 'pending');
}

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    /* storage unavailable */
  }
}

let flushing = false;
let backoff = 1000;

/**
 * Push everything queued, oldest first. Because every payload is keyed on the
 * same client-generated uuid and the server does INSERT OR REPLACE, sending the
 * same thing twice is harmless — which is what makes it safe to retry blindly.
 */
async function flushPending() {
  if (flushing) return;
  flushing = true;
  clearTimeout(state.flushTimer);

  try {
    let queue = readQueue();
    while (queue.length > 0) {
      const payload = queue[0];
      const res = await fetch('/api/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // The server will never accept this payload. Drop it rather than retry
        // for the rest of the session.
        console.error('submission rejected', await res.text());
        queue.shift();
        writeQueue(queue);
        continue;
      }
      if (!res.ok) throw new Error(`http ${res.status}`);

      const data = await res.json();
      if (data.aggregate) {
        state.aggregate = data.aggregate;
        if (state.screen === 'done') renderCrowdComparison();
        if (state.screen === 'live') renderLive();
      }
      queue.shift();
      writeQueue(queue);
      backoff = 1000;
    }
    setStatus(state.submitted ? 'Forecast recorded.' : '');
  } catch {
    setStatus('No connection — your forecast is saved and will send itself.', 'pending');
    backoff = Math.min(backoff * 2, 15000);
    state.flushTimer = setTimeout(flushPending, backoff);
  } finally {
    flushing = false;
  }
}

/* --- misc ------------------------------------------------------------------- */

function setStatus(text, stateName = '') {
  const el = $('status');
  el.textContent = text;
  el.dataset.state = stateName;
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Older Android WebViews predate randomUUID but all have getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
