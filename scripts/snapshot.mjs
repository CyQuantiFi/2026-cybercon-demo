#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Build the offline snapshot — §9, "Venue Wi-Fi collapses".

   The board ships with a bundled aggregate so that ?offline=1 runs the entire
   narration with no network at all, and so a mid-talk collapse degrades to the
   dry-run numbers rather than to an empty screen.

       node scripts/snapshot.mjs                 # from the seed file
       node scripts/snapshot.mjs --from-live http://localhost:8787 --token TOK

   Rehearse this path, not just the happy path.
--------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAggregate } from '../public/js/aggregate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public/data/snapshot.json');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const liveBase = flag('--from-live');
const model = JSON.parse(await readFile(join(root, 'public/data/model.json'), 'utf8'));

let forecasts;
let notes;

if (liveBase) {
  // The real dry run is the best snapshot there is: keep that data as the seed
  // and as the offline artefact (§10 item 9).
  const token = flag('--token') ?? process.env.MOD_TOKEN;
  if (!token) {
    console.error('--from-live needs --token or MOD_TOKEN — the export route is gated.');
    process.exit(1);
  }
  const res = await fetch(`${liveBase.replace(/\/$/, '')}/api/mod/export`, { headers: { 'x-mod-token': token } });
  if (!res.ok) {
    console.error(`Export failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const dump = await res.json();
  forecasts = dump.forecasts.map((r) => ({
    id: r.id,
    q1: r.q1,
    q2: r.q2_low != null ? { low: r.q2_low, mode: r.q2_mode, high: r.q2_high } : null,
    confidence: r.confidence,
    role: r.role,
    // Everything in a snapshot is by definition pre-seeded once it is replayed
    // on stage, and the board says so rather than passing it off as the room.
    seeded: true,
    ts: r.ts
  }));
  notes = dump.notes.filter((n) => n.approved).map((n) => ({ note: n.note, role: n.role, q1: n.q1, ts: n.ts }));
} else {
  const seed = JSON.parse(await readFile(join(root, 'scripts/seed-forecasts.json'), 'utf8'));
  forecasts = seed.forecasts.map((f) => ({ ...f, seeded: true, ts: Date.now() }));
  notes = seed.forecasts
    .filter((f) => f.note)
    .map((f) => ({ note: f.note, role: f.role, q1: f.q1, ts: Date.now() }));
}

const aggregate = buildAggregate(forecasts, model, notes);

await writeFile(
  OUT,
  `${JSON.stringify(
    {
      _comment: 'Bundled fallback for the presenter board. ?offline=1 runs the whole narration off this.',
      builtAt: Date.now(),
      source: liveBase ? 'dry run' : 'seed file',
      aggregate
    },
    null,
    2
  )}\n`
);

console.log(`Wrote ${OUT}`);
console.log(`  n           ${aggregate.n}`);
console.log(`  crowd       ${(aggregate.crowd.median * 100).toFixed(0)}%  (IQR ${(aggregate.crowd.p25 * 100).toFixed(0)}–${(aggregate.crowd.p75 * 100).toFixed(0)}%)`);
console.log(`  model       ${aggregate.model ? `${(aggregate.model.p * 100).toFixed(0)}%${aggregate.model.placeholder ? '  [PLACEHOLDER]' : ''}` : 'none'}`);
console.log(`  ensemble    ${(aggregate.ensemble.p * 100).toFixed(0)}%`);
console.log(`  notes       ${aggregate.notes.length} approved`);
