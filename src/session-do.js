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
 * Per-IP submission limit (§9, spam / ballot stuffing).
 *
 * Set high on purpose. Venue Wi-Fi NATs the entire room behind a handful of
 * public addresses, so a tight per-IP cap does not stop a ballot stuffer — it
 * locks out the audience, and it does so exactly when the board is on screen.
 * The controls that actually do the work are one-forecast-per-client-id with
 * edit-in-place, and Turnstile. This ceiling exists to stop a scripted flood
 * from filling the append log, and 240/minute is far above what ~150 people
 * behind one NAT can produce by hand.
 */
const RATE_LIMIT = 240;
const RATE_WINDOW_MS = 60_000;

export class SessionDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    /** @type {Map<string, number[]>} in-memory, single instance, no binding needed */
    this.hits = new Map();
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
   * The model participant is a static artefact by default (§5): run the morning
   * of the talk, cached, and served without a live call. It is copied into meta
   * on first boot so the aggregate does not need a fetch on every poll.
   */
  async loadModel() {
    const stored = this.sql.exec('SELECT v FROM meta WHERE k = ?', 'model').toArray();
    if (stored.length > 0) {
      try {
        this.model = JSON.parse(stored[0].v);
        return;
      } catch {
        /* fall through and re-read the artefact */
      }
    }
    try {
      const res = await this.env.ASSETS.fetch('https://assets.local/data/model.json');
      if (res.ok) this.setModel(await res.json());
    } catch (err) {
      // Not fatal. Panel B simply has nothing to show, and Panel C falls back
      // to the crowd alone.
      console.error('could not load cached model artefact', err);
    }
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

    return this.json({ error: 'not_found' }, 404);
  }

  /* --- writes ----------------------------------------------------------- */

  async submit(request) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (ip && this.rateLimited(ip)) {
      return this.json({ error: 'rate_limited' }, 429);
    }

    const f = await request.json();

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

  /* --- helpers ---------------------------------------------------------- */

  rateLimited(ip) {
    const now = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    this.hits.set(ip, recent);

    // Cheap sweep so a busy session does not grow this map without bound.
    if (this.hits.size > 5000) {
      for (const [key, times] of this.hits) {
        if (times.every((t) => now - t >= RATE_WINDOW_MS)) this.hits.delete(key);
      }
    }
    return recent.length > RATE_LIMIT;
  }

  json(value, status = 200) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }
}
