#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Seed a running session — §9, "Nobody scans".

   Posts the pre-conference panel round through the real /api/f route, so the
   board is never staring at n=1 and the histogram has a shape before the first
   phone in the room submits. The board labels these as pre-seeded.

       node scripts/seed.mjs                        # against localhost:8787
       node scripts/seed.mjs https://your.domain    # against the deploy
--------------------------------------------------------------------------- */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');

const { forecasts } = JSON.parse(await readFile(join(root, 'scripts/seed-forecasts.json'), 'utf8'));

console.log(`Seeding ${forecasts.length} forecasts into ${base}`);

let ok = 0;
for (const f of forecasts) {
  const res = await fetch(`${base}/api/f`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // seeded:true is what makes the board say so out loud. Never post the
    // panel round without it.
    body: JSON.stringify({ ...f, seeded: true })
  });

  if (res.ok) {
    ok++;
    process.stdout.write('.');
  } else {
    process.stdout.write('x');
    console.error(`\n  ${f.id}: ${res.status} ${await res.text()}`);
  }
}

console.log(`\n${ok}/${forecasts.length} accepted.`);

const agg = await (await fetch(`${base}/api/agg`)).json();
console.log(`n=${agg.n}, crowd ${(agg.crowd.median * 100).toFixed(0)}%, ensemble ${(agg.ensemble.p * 100).toFixed(0)}%`);
if (ok !== forecasts.length) process.exitCode = 1;
