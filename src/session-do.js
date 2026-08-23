/* ---------------------------------------------------------------------------
   SessionDO — the live counter and append log for one session.

   A Durable Object rather than KV because the entire demo happens inside a
   seven-minute window: KV's eventual consistency would show the board a stale
   count while people in the room are still submitting, which is precisely the
   moment the count needs to be right.

   Three tables, and the separation between them is the privacy design:

     forecasts  what the board is allowed to see. No email, no name, no company.
     emails     the optional contact detail, written on a different table that
                no board-reachable route reads (§6).
     notes      reasoning lines, held unapproved until a human taps approve.
--------------------------------------------------------------------------- */

import { DurableObject } from 'cloudflare:workers';
import { buildAggregate } from '../public/js/aggregate.js';

/**
 * Per-IP limit on *new* forecasts (§9, spam / ballot stuffing).
 *
 * Counted per distinct client id, not per request, and that distinction is the
 * whole point. Venue Wi-Fi NATs the entire room behind a handful of public
 * addresses, so every phone shares one counter. Counting requests would put a
 * roomful of people into one bucket alongside their own retries:
 *
 *   ~150 forecasts, plus a second write each for anyone who leaves an email,
 *   plus however many times the retry loop re-POSTs through bad venue Wi-Fi.
 *
 * That is comfortably over a few hundred requests in the minute after "scan
 * now", and the failure is silent — a 429 makes the client back off 1s, 2s, 4s,
 * 8s, so the forecast lands eventually but the counter on the board stalls
 * during exactly the window the presenter is pointing at it.
 *
 * Every write is INSERT OR REPLACE on a client-generated uuid, so repeated
 * writes with the same id cannot grow the table — they are updates. Only a
 * previously unseen id costs anything, which makes retries, edits and the
 * email step free, and leaves the ceiling protecting the one thing it should:
 * a script inventing fresh uuids. 150 people cannot hand-produce 600 distinct
 * forecasts in a minute; a script can, and Turnstile is the control for that.
 */
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

/**
 * Failed moderation auth attempts per IP.
 *
 * The forecast ceiling above only ever guards submit(), so until now every
 * /api/mod/* request bypassed rate limiting entirely — unlimited guesses at
 * MOD_TOKEN, on routes where /api/mod/export?include=contacts returns email
 * addresses and consent records.
 *
 * Only failures are counted. A correct token always gets through, because
 * locking out on volume alone would let anyone knock the presenter off their
 * own board mid-talk by spraying the endpoint.
 */
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    /** @type {Map<string, number[]>} in-memory, single instance, no binding needed */
    this.hits = new Map();
    /** Ids already charged against an address, so a retry is never charged twice. */
    this.charged = new Set();
    /** @type {Map<string, number[]>} failed moderation auth attempts per address */
    this.authFails = new Map();
    this.aggregate = null;
    this.model = null;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.loadModel();
      this.recompute();
    });
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS forecasts (
        id          TEXT PRIMARY KEY,
        q1          REAL    NOT NULL,
        q2_low      REAL,
        q2_mode     REAL,
        q2_high     REAL,
        confidence  TEXT    NOT NULL,
        role        TEXT    NOT NULL,
        seeded      INTEGER NOT NULL DEFAULT 0,
        ts          INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id        TEXT PRIMARY KEY,
        note      TEXT    NOT NULL,
        role      TEXT,
        q1        REAL,
        approved  INTEGER NOT NULL DEFAULT 0,
        ts        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS emails (
        id              TEXT PRIMARY KEY,
        email           TEXT NOT NULL,
        consent         TEXT NOT NULL,
        notice_version  TEXT NOT NULL,
        ts              INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  /**
   * Load the model participant (§5): an artefact produced by `npm run model`
   * the morning of the talk, deployed as a static asset, and served without a
   * live call.
   *
   * The deployed asset is authoritative and is re-read on every boot. It used
   * to be copied into `meta` once and never looked at again, which meant
   * running the model and redeploying left Panel B serving the previous
   * forecast forever — including, after a question change, a forecast of a
   * different question to the one the room answered, presented beside the crowd
   * as though the two were comparable.
   *
   * A live re-run via the board's R key writes to `meta` and stands for the
   * life of this instance. If the Durable Object is evicted and reboots, the
   * deployed artefact wins again — which matches §5 making the cached artefact
   * the default path and the live re-run optional theatre.
   */
  async loadModel() {
    let cached = null;
    const stored = this.sql.exec('SELECT v FROM meta WHERE k = ?', 'model').toArray();
    if (stored.length > 0) {
      try {
        cached = JSON.parse(stored[0].v);
      } catch {
        /* corrupt cache; the asset below replaces it */
      }
    }

    let asset = null;
    try {
      const res = await this.env.ASSETS.fetch('https://assets.local/data/model.json');
      if (res.ok) asset = await res.json();
    } catch (err) {
      // Not fatal. Panel B shows nothing and Panel C falls back to the crowd.
      console.error('could not load cached model artefact', err);
    }

    if (asset && (!cached || asset.ranAt !== cached.ranAt || asset.p !== cached.p)) {
      this.setModel(asset);
      return;
    }
    this.model = cached ?? asset;
  }

  setModel(model) {
    this.model = model;
    this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'model', JSON.stringify(model));
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/submit') return this.submit(request);
    if (path === '/aggregate') return this.json(this.aggregate);
    if (path === '/notes') return this.json({ notes: this.allNotes() });
    if (path === '/approve') return this.approve(request);
    if (path === '/export') return this.export(request);
    if (path === '/model') return this.storeModel(request);
    if (path === '/counts') return this.json(this.counts());
    if (path === '/authfail') return this.authFail(request);
    if (path === '/reset') return this.reset();

    return this.json({ error: 'not_found' }, 404);
  }

  /* --- writes ----------------------------------------------------------- */

  async submit(request) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    const f = await request.json();

    // Only a previously unseen id counts against the ceiling. A resubmit, a
    // retry, or the separate email write all carry an id we already hold, and
    // none of them can add a row — so charging them would only penalise the
    // room for its own bad Wi-Fi.
    const isNew = this.sql.exec('SELECT 1 FROM forecasts WHERE id = ?', f.id).toArray().length === 0;
    if (ip && isNew) {
      if (this.overLimit(ip)) {
        // Remember that this id was already charged for. A rejected forecast
        // never reaches the table, so it stays "new" on every retry — and
        // charging it again would let the room's own retry loop hold the
        // bucket full, which is the lockout feeding itself. Retries are
        // re-evaluated but never re-charged, so they land the moment the
        // window drains.
        this.charged.add(f.id);
        return this.json({ error: 'rate_limited' }, 429);
      }
      if (!this.charged.delete(f.id)) this.charge(ip);
    }

    // INSERT OR REPLACE keyed on the client-generated uuid: a retry after a
    // dropped connection is a no-op, and going back to change an answer is an
    // edit in place rather than a second vote.
    this.sql.exec(
      `INSERT OR REPLACE INTO forecasts (id, q1, q2_low, q2_mode, q2_high, confidence, role, seeded, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.id,
      f.q1,
      f.q2?.low ?? null,
      f.q2?.mode ?? null,
      f.q2?.high ?? null,
      f.confidence,
      f.role,
      f.seeded ? 1 : 0,
      f.ts
    );

    if (f.note) {
      // Approved defaults to 0. Seeded forecasts come from the pre-conference
      // panel round and are already vetted, so they arrive approved.
      this.sql.exec(
        `INSERT OR REPLACE INTO notes (id, note, role, q1, approved, ts)
         VALUES (?, ?, ?, ?, COALESCE((SELECT approved FROM notes WHERE id = ?), ?), ?)`,
        f.id,
        f.note,
        f.role,
        f.q1,
        f.id,
        f.seeded ? 1 : 0,
        f.ts
      );
    }

    // The email, if given, goes to its own table and is never joined back.
    if (f.contact) {
      this.sql.exec(
        'INSERT OR REPLACE INTO emails (id, email, consent, notice_version, ts) VALUES (?, ?, ?, ?, ?)',
        f.id,
        f.contact.email,
        JSON.stringify(f.contact.consent),
        f.contact.consent.text ?? 'unknown',
        f.contact.consent.ts ?? f.ts
      );
    }

    this.recompute();
    return this.json({ ok: true, id: f.id, aggregate: this.aggregate });
  }

  async approve(request) {
    const { id, approved } = await request.json();
    if (typeof id !== 'string') return this.json({ error: 'bad_id' }, 400);
    this.sql.exec('UPDATE notes SET approved = ? WHERE id = ?', approved === false ? 0 : 1, id);
    this.recompute();
    return this.json({ ok: true, notes: this.allNotes() });
  }

  async storeModel(request) {
    this.setModel(await request.json());
    this.recompute();
    return this.json({ ok: true, model: this.aggregate.model });
  }

  /* --- reads ------------------------------------------------------------ */

  recompute() {
    const rows = this.sql.exec('SELECT * FROM forecasts ORDER BY ts ASC').toArray();
    const forecasts = rows.map((r) => ({
      id: r.id,
      q1: r.q1,
      q2: r.q2_low != null ? { low: r.q2_low, mode: r.q2_mode, high: r.q2_high } : null,
      confidence: r.confidence,
      role: r.role,
      seeded: r.seeded === 1,
      ts: r.ts
    }));

    const notes = this.sql
      .exec('SELECT note, role, q1, ts FROM notes WHERE approved = 1 ORDER BY ts DESC LIMIT 12')
      .toArray()
      .map((r) => ({ note: r.note, role: r.role, q1: r.q1, ts: r.ts }));

    this.aggregate = buildAggregate(forecasts, this.model, notes);
    return this.aggregate;
  }

  allNotes() {
    return this.sql.exec('SELECT id, note, role, q1, approved, ts FROM notes ORDER BY ts DESC LIMIT 200').toArray();
  }

  /**
   * Resolution-day export. Behind MOD_TOKEN at the Worker.
   *
   * Contacts are withheld unless explicitly asked for, so the routine export
   * used to eyeball the session carries no personal information at all.
   */
  async export(request) {
    const includeContacts = new URL(request.url).searchParams.get('include') === 'contacts';
    const payload = {
      session: this.env.SESSION_ID || 'cybercon-2026',
      exportedAt: Date.now(),
      forecasts: this.sql.exec('SELECT * FROM forecasts ORDER BY ts ASC').toArray(),
      notes: this.allNotes(),
      model: this.model
    };
    if (includeContacts) {
      payload.contacts = this.sql.exec('SELECT * FROM emails ORDER BY ts ASC').toArray();
    }
    return this.json(payload);
  }

  /**
   * What is in the session right now. Read by the moderation view so the reset
   * confirmation can name exactly what is about to be destroyed rather than
   * asking for a blind yes.
   */
  counts() {
    const one = (table) => this.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n;
    return {
      forecasts: one('forecasts'),
      notes: one('notes'),
      contacts: one('emails'),
      seeded: this.sql.exec('SELECT COUNT(*) AS n FROM forecasts WHERE seeded = 1').toArray()[0].n
    };
  }

  /**
   * Empty the session.
   *
   * For clearing rehearsal and test data before the talk, so the room starts at
   * a real zero. It drops forecasts, reasoning and contacts together: leaving
   * contacts behind would keep consent records for forecasts that no longer
   * exist, and the resolution-day job would then email people about a question
   * whose answers were deleted.
   *
   * The model artefact survives, because it is not session data — it is the
   * output of the run you did that morning, and losing it would mean running
   * the model again for no reason.
   */
  async reset() {
    const before = this.counts();
    this.sql.exec('DELETE FROM forecasts');
    this.sql.exec('DELETE FROM notes');
    this.sql.exec('DELETE FROM emails');
    this.hits.clear();
    this.charged.clear();
    this.authFails.clear();

    // Re-read the deployed artefact as well, so a reset genuinely returns the
    // session to what the deployment says rather than keeping a live re-run
    // from an earlier rehearsal.
    this.sql.exec('DELETE FROM meta WHERE k = ?', 'model');
    await this.loadModel();

    this.recompute();
    return this.json({ ok: true, deleted: before, aggregate: this.aggregate });
  }

  /* --- helpers ---------------------------------------------------------- */

  /**
   * Record a failed moderation auth from this address and report whether it is
   * now locked out. Same sliding-window shape as the forecast ceiling rather
   * than a second mechanism to reason about.
   */
  async authFail(request) {
    const { ip } = await request.json();
    if (!ip) return this.json({ locked: false });

    const now = Date.now();
    const recent = (this.authFails.get(ip) ?? []).filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
    recent.push(now);
    this.authFails.set(ip, recent);

    if (this.authFails.size > 5000) {
      for (const [key, times] of this.authFails) {
        if (times.every((t) => now - t >= AUTH_FAIL_WINDOW_MS)) this.authFails.delete(key);
      }
    }
    return this.json({ locked: recent.length >= AUTH_FAIL_LIMIT });
  }

  /** Read-only: is this address already at its ceiling for the window? */
  overLimit(ip) {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    this.hits.set(ip, recent);
    return recent.length >= RATE_LIMIT;
  }

  /** Record one new forecast against an address. */
  charge(ip) {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    this.hits.set(ip, recent);

    // Cheap sweeps so a busy session does not grow either structure without
    // bound. Both are in-memory only and are rebuilt from zero if the Durable
    // Object restarts, which is fine — the ceiling is a flood guard, not an
    // accounting record.
    if (this.hits.size > 5000) {
      for (const [key, times] of this.hits) {
        if (times.every((t) => now - t >= RATE_WINDOW_MS)) this.hits.delete(key);
      }
    }
    if (this.charged.size > 20000) this.charged.clear();
  }

  json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
