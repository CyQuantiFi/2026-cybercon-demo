#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   Pre-flight check against a deployed instance.

       node scripts/check-deploy.mjs https://cybercon2026.cyquantifi.com
       node scripts/check-deploy.mjs https://... --token "$MOD_TOKEN"

   Run it the morning of the talk, after deploying and before seeding.

   The asset comparison is here because it has already caught two real
   problems: a Windows checkout serving every file CRLF-converted, so what was
   deployed no longer matched what was in the repo, and a stray NUL byte that
   made git treat a source file as binary. Neither was visible on screen.

   Nothing here writes to the session, so it is safe to run against production
   at any point, including during the talk.
--------------------------------------------------------------------------- */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const base = (argv.find((a) => !a.startsWith('--')) || 'http://localhost:8787').replace(/\/$/, '');
const tokenIdx = argv.indexOf('--token');
const token = tokenIdx === -1 ? null : argv[tokenIdx + 1];

let failures = 0;
const ok = (pass, msg, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${msg}${detail ? `\n        ${detail}` : ''}`);
};
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);

console.log(`\nChecking ${base}\n`);

/* --- 1. what is served is what is in the repo ----------------------------- */

console.log('ASSETS');
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    statSync(f).isDirectory() ? walk(f, out) : out.push(f);
  }
  return out;
}
// Assets are served at canonical URLs: .html is dropped, index.html is /.
const urlFor = (rel) =>
  rel === 'index.html' ? '/' : rel.endsWith('.html') ? '/' + rel.replace(/\.html$/, '') : '/' + rel;

const mismatched = [];
let checked = 0;
for (const file of walk(join(root, 'public'))) {
  const rel = relative(join(root, 'public'), file).split('\\').join('/');
  const local = await readFile(file);
  const res = await fetch(base + urlFor(rel));
  const remote = Buffer.from(await res.arrayBuffer());
  checked++;
  if (sha(local) !== sha(remote)) {
    const crlf = remote.length - local.length === local.toString('utf8').split('\n').length - 1;
    mismatched.push(`${rel} (${local.length}B local vs ${remote.length}B served${crlf ? ', looks like CRLF conversion' : ''})`);
  }
}
ok(mismatched.length === 0, `${checked} assets served byte-identical to the repo`);
mismatched.forEach((m) => console.log(`        ${m}`));
if (mismatched.length) {
  console.log('        Fix: check .gitattributes is in effect (git add --renormalize .), then redeploy.');
}

/* --- 2. the board's data feed ---------------------------------------------- */

console.log('\nAGGREGATE');
const aggRes = await fetch(`${base}/api/agg`);
ok(aggRes.ok, `/api/agg responds ${aggRes.status}`);
const raw = await aggRes.text();
let agg = {};
try {
  agg = JSON.parse(raw);
} catch {
  ok(false, '/api/agg returns valid JSON');
}
const expected = 'byConfidence,byRole,crowd,divergence,ensemble,magnitude,method,model,n,notes,seeded,updated';
ok(Object.keys(agg).sort().join() === expected, 'aggregate carries exactly the documented keys');

// The board is a screen in front of 150 people. Nothing in the payload it polls
// may be able to hold personal information — not even a field name.
const leaks = ['email', 'consent', 'marketing', '"id"'].filter((t) => raw.includes(t));
ok(leaks.length === 0, 'aggregate contains no participant fields', leaks.length ? `found: ${leaks.join(', ')}` : '');

ok(!!aggRes.headers.get('etag'), 'aggregate sends an ETag so the 2s poll is cheap');
if (agg.model?.placeholder) {
  console.log('  WARN  model artefact is still the PLACEHOLDER — run `npm run model`, then `npm run snapshot`');
}
console.log(`        n=${agg.n} seeded=${agg.seeded} notes=${agg.notes?.length ?? 0}`);

/* --- 3. the offline path --------------------------------------------------- */

console.log('\nSNAPSHOT');
const snapRes = await fetch(`${base}/data/snapshot.json`);
ok(snapRes.ok, 'bundled snapshot is served');
const snap = snapRes.ok ? await snapRes.json() : {};
ok((snap.aggregate?.n ?? 0) > 0, `snapshot has forecasts in it (n=${snap.aggregate?.n ?? 0})`, 'This is what ?offline=1 runs the whole narration from.');

/* --- 4. moderation --------------------------------------------------------- */

console.log('\nMODERATION');
const health = await fetch(`${base}/api/mod/health`).then((r) => r.json()).catch(() => ({}));
ok(health.configured === true, 'MOD_TOKEN is set on this deployment',
   health.configured === false ? 'Fix: npx wrangler secret put MOD_TOKEN, then redeploy.' : '');

const noToken = await fetch(`${base}/api/mod/notes`);
ok(noToken.status === 401 || noToken.status === 503, `notes without a token refused (${noToken.status})`);

if (token) {
  const res = await fetch(`${base}/api/mod/notes`, { headers: { 'x-mod-token': token } });
  if (res.ok) {
    const { notes = [] } = await res.json();
    ok(true, `token accepted — ${notes.filter((n) => !n.approved).length} pending, ${notes.filter((n) => n.approved).length} on the board`);
  } else {
    const body = await res.json().catch(() => ({}));
    ok(false, `token refused (${res.status} ${body.error ?? ''})`,
       body.error === 'bad_token' ? 'The token does not match the stored secret. Re-set it: npx wrangler secret put MOD_TOKEN' : '');
  }
} else {
  console.log('  ....  pass --token "$MOD_TOKEN" to check the token end to end');
}

/* --- 5. the QR target ------------------------------------------------------ */

console.log('\nPARTICIPANT PATH');
const f = await fetch(`${base}/f`, { redirect: 'manual' });
ok(f.status === 200, `/f serves the app directly (${f.status})`,
   f.status >= 300 && f.status < 400 ? 'A redirect here costs every phone in the room an extra round trip.' : '');

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
