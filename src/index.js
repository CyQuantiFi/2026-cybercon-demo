/* ---------------------------------------------------------------------------
   Worker — the only server-side surface in the demo.

   The participant app and the presenter board are fully static; static assets
   are matched first and anything that is not a file on disk arrives here. The
   hot path that 150 phones and one board actually touch is two routes, per §5:

       POST /api/f     append (or edit in place) a forecast
       GET  /api/agg   read the aggregate

   Three more exist off the hot path and are not part of that budget: the
   moderation view's routes, which are token-gated and used by one phone in the
   presenter's pocket, and the optional live model re-run.

   The maths lives in public/js/aggregate.js and is imported by both this Worker
   and the board, so there is exactly one implementation of §7 in the repo.
--------------------------------------------------------------------------- */

import { SessionDO } from './session-do.js';
import { verifyTurnstile } from './turnstile.js';
import { secretEquals } from './auth.js';

export { SessionDO };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/f' && request.method === 'POST') return await submitForecast(request, env);
      if (path === '/api/agg' && request.method === 'GET') return await readAggregate(request, env);
      if (path.startsWith('/api/mod/')) return await moderation(request, env, path);
      if (path === '/api/model/rerun' && request.method === 'POST') return await rerunModel(request, env, ctx);
      if (path.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    } catch (err) {
      // Never let a stack trace reach a phone. The board's failure path is to
      // fall back to its bundled snapshot, so a 500 here is survivable.
      console.error('worker error', err);
      return json({ error: 'server_error' }, 500);
    }

    // Short path for the printed QR. Mapped to the canonical asset URL rather
    // than to /index.html, because the assets handler answers that with a 307 —
    // and a redirect on the one path 150 phones hit at once, on venue Wi-Fi, is
    // a round trip nobody needs.
    if (path === '/f') {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }

    return env.ASSETS.fetch(request);
  }
};

/* --- POST /api/f ---------------------------------------------------------- */

async function submitForecast(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const parsed = parseSubmission(body);
  if (parsed.error) return json({ error: parsed.error, field: parsed.field }, 400);

  // Turnstile runs only when a secret is configured, so `wrangler dev` and the
  // seed script work with no keys at all.
  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstile, clientIp(request));
    if (!ok) return json({ error: 'challenge_failed' }, 403);
  }

  const stub = sessionStub(env);
  const res = await stub.fetch('https://session/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': clientIp(request) ?? '' },
    body: JSON.stringify(parsed.value)
  });

  // Mirror the freshly computed aggregate into KV as the read-cheap fallback.
  if (res.ok) {
    const payload = await res.clone().json();
    if (payload.aggregate) {
      await env.AGG_KV.put(aggKey(env), JSON.stringify(payload.aggregate), { expirationTtl: 86400 }).catch(() => {});
    }
  }
  return new Response(res.body, { status: res.status, headers: JSON_HEADERS });
}

/**
 * Validate a submission and strip it to exactly the fields §6 allows.
 *
 * Anything not named here is dropped rather than passed through, so a client
 * cannot smuggle a field into storage and from there onto the board.
 */
export function parseSubmission(body) {
  if (!body || typeof body !== 'object') return { error: 'bad_body' };

  const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null;
  if (!id) return { error: 'bad_id', field: 'id' };

  const q1 = Number(body.q1);
  if (!Number.isFinite(q1) || q1 < 0.01 || q1 > 0.99) return { error: 'bad_q1', field: 'q1' };

  let q2 = null;
  if (body.q2 && typeof body.q2 === 'object') {
    const low = Number(body.q2.low);
    const mode = Number(body.q2.mode);
    const high = Number(body.q2.high);
    const sane = [low, mode, high].every((v) => Number.isFinite(v) && v > 0 && v <= 2e8);
    // Q2 is skippable, and a malformed triple is treated as skipped rather than
    // as an error — a Q1-only submission still counts and the participant is
    // already past this screen.
    if (sane) q2 = { low, mode, high };
  }

  const confidence = ['low', 'med', 'high'].includes(body.confidence) ? body.confidence : 'med';
  const role = ['leadership', 'risk', 'engineering', 'vendor', 'other'].includes(body.role) ? body.role : 'other';

  let note = null;
  if (typeof body.note === 'string') {
    const trimmed = body.note.trim().replace(/\s+/g, ' ').slice(0, 240);
    if (trimmed.length > 0) note = trimmed;
  }

  // The email half is validated here but the Durable Object writes it to a
  // separate table that no board-reachable route reads. See §6.
  let contact = null;
  if (typeof body.email === 'string' && body.email.trim()) {
    const email = body.email.trim().slice(0, 254);
    if (!/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return { error: 'bad_email', field: 'email' };
    const consent = body.consent && typeof body.consent === 'object' ? body.consent : {};
    // Bundled consent is not consent: each box is recorded on its own, and the
    // exact notice version is stored alongside so we can prove what was agreed.
    contact = {
      email,
      consent: {
        outcome: consent.outcome === true,
        marketing: consent.marketing === true,
        // Never guess a version. The whole point of storing it is to prove what
        // someone was shown, and defaulting to a real version number would
        // attest to text a client that sent nothing may never have displayed.
        text: typeof consent.text === 'string' ? consent.text.slice(0, 16) : 'unknown',
        ts: Date.now()
      }
    };
    if (!contact.consent.outcome && !contact.consent.marketing) return { error: 'no_consent', field: 'consent' };
  }

  return {
    value: {
      id,
      q1,
      q2,
      confidence,
      role,
      note,
      contact,
      seeded: body.seeded === true,
      ts: Date.now()
    }
  };
}

/* --- GET /api/agg --------------------------------------------------------- */

async function readAggregate(request, env) {
  let aggregate;
  try {
    const res = await sessionStub(env).fetch('https://session/aggregate');
    aggregate = await res.json();
  } catch (err) {
    // Durable Object unreachable: serve the last aggregate we mirrored to KV.
    // Stale by one write at worst, and the board would rather draw something.
    console.error('DO unreachable, falling back to KV', err);
    const cached = await env.AGG_KV.get(aggKey(env), 'json');
    if (!cached) return json({ error: 'unavailable' }, 503);
    aggregate = { ...cached, stale: true };
  }

  // The board polls every 2 seconds for the length of the session. An ETag
  // turns most of those into 304s with no body.
  const etag = `W/"${aggregate.updated}-${aggregate.n}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-store' } });
  }
  return new Response(JSON.stringify(aggregate), { headers: { ...JSON_HEADERS, etag } });
}

/* --- moderation ----------------------------------------------------------- */

/**
 * Token-gated. Nothing reaches the board unapproved (§9), so this is the one
 * route that can change what 150 people see.
 */
async function moderation(request, env, path) {
  // Unauthenticated on purpose. "Is moderation set up on this deployment?" is
  // the first question anyone asks when /mod refuses a token, and answering it
  // needs to be possible from a phone at a podium with no laptop. It discloses
  // only whether an operator has set a secret — /mod is already served
  // publicly, so the existence of moderation was never hidden.
  if (path === '/api/mod/health' && request.method === 'GET') {
    return json({ configured: Boolean(env.MOD_TOKEN && env.MOD_TOKEN.trim()) });
  }

  const supplied = request.headers.get('x-mod-token') || new URL(request.url).searchParams.get('t');

  // Three distinct problems that used to collapse into one 401. They have
  // three different fixes, and the person hitting them is usually two minutes
  // from going on stage.
  if (!env.MOD_TOKEN || !env.MOD_TOKEN.trim()) {
    return json({ error: 'not_configured' }, 503);
  }
  if (!supplied) {
    return json({ error: 'no_token' }, 401);
  }
  if (!(await secretEquals(supplied, env.MOD_TOKEN))) {
    // Record the miss and lock the address out once it has burned through its
    // allowance. Without this the moderation routes take unlimited guesses, and
    // /api/mod/export?include=contacts hands back email addresses.
    const ip = clientIp(request);
    if (ip) {
      const res = await sessionStub(env).fetch('https://session/authfail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ip })
      });
      const { locked } = await res.json().catch(() => ({ locked: false }));
      if (locked) return json({ error: 'too_many_attempts' }, 429);
    }
    return json({ error: 'bad_token' }, 401);
  }

  const stub = sessionStub(env);
  if (path === '/api/mod/notes' && request.method === 'GET') {
    return proxy(await stub.fetch('https://session/notes'));
  }
  if (path === '/api/mod/approve' && request.method === 'POST') {
    return proxy(
      await stub.fetch('https://session/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await request.text()
      })
    );
  }
  if (path === '/api/mod/counts' && request.method === 'GET') {
    return proxy(await stub.fetch('https://session/counts'));
  }
  if (path === '/api/mod/reset' && request.method === 'POST') {
    const res = await stub.fetch('https://session/reset', { method: 'POST' });
    // Clear the KV mirror too. It is the fallback the board reads when the
    // Durable Object is briefly unreachable, so leaving the pre-reset
    // aggregate there would let a wiped session reappear on screen.
    if (res.ok) await env.AGG_KV.delete(aggKey(env)).catch(() => {});
    return proxy(res);
  }
  if (path === '/api/mod/export' && request.method === 'GET') {
    // Forward the query string: ?include=contacts is what asks the Durable
    // Object for the email table, and silently dropping it would hand the
    // resolution-day job an export with nobody to notify.
    const target = new URL('https://session/export');
    target.search = new URL(request.url).search;
    return proxy(await stub.fetch(target.toString()));
  }
  return json({ error: 'not_found' }, 404);
}

/* --- optional live model re-run -------------------------------------------- */

/**
 * Optional theatre, per §9. The cached artefact is the default path; this
 * re-calls the model with a hard 6-second timeout and falls back silently to
 * whatever is already stored. The board shows no error either way.
 */
async function rerunModel(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, reason: 'no_key' }, 200);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const prompt = await (await env.ASSETS.fetch('https://assets.local/data/model-prompt.txt')).text();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: env.MODEL_NAME || 'claude-opus-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!res.ok) return json({ ok: false, reason: 'upstream' }, 200);

    const data = await res.json();
    const text = (data.content ?? []).map((c) => c.text ?? '').join('');
    const model = extractModelJson(text);
    if (!model) return json({ ok: false, reason: 'unparseable' }, 200);

    model.ranAt = Date.now();
    model.live = true;
    const stored = await sessionStub(env).fetch('https://session/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model)
    });
    return proxy(stored);
  } catch (err) {
    console.error('model re-run failed, keeping cached artefact', err);
    return json({ ok: false, reason: 'timeout' }, 200);
  } finally {
    clearTimeout(timer);
  }
}

export function extractModelJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Number.isFinite(parsed.p)) return null;
    return {
      p: Math.min(0.99, Math.max(0.01, parsed.p)),
      baseRate: typeof parsed.baseRate === 'string' ? parsed.baseRate : null,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((r) => typeof r === 'string').slice(0, 2) : []
    };
  } catch {
    return null;
  }
}

/* --- helpers -------------------------------------------------------------- */

function sessionStub(env) {
  const id = env.SESSION.idFromName(env.SESSION_ID || 'cybercon-2026');
  return env.SESSION.get(id);
}

function aggKey(env) {
  return `agg:${env.SESSION_ID || 'cybercon-2026'}`;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || null;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function proxy(res) {
  return new Response(res.body, { status: res.status, headers: JSON_HEADERS });
}

