#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   The LLM participant — §5, §10 item 6.

   Run this the morning of the talk. It calls the model once and writes a static
   artefact to public/data/model.json, which is the default path on stage: the
   board reads the artefact, and the live re-run behind the board's R key is
   optional theatre with a six-second timeout.

       ANTHROPIC_API_KEY=sk-... node scripts/model-participant.mjs

   The prompt lives at public/data/model-prompt.txt rather than here, so the
   Worker can serve the identical bytes to the live re-run path and there is one
   auditable copy of what was asked.

   Flags:
     --dry     print the artefact without writing it
     --check   verify the existing artefact parses and is recent
--------------------------------------------------------------------------- */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = join(root, 'public/data/model-prompt.txt');
const OUT_PATH = join(root, 'public/data/model.json');
const MODEL = process.env.MODEL_NAME || 'claude-opus-5';

const args = new Set(process.argv.slice(2));

if (args.has('--check')) {
  await check();
} else {
  await run();
}

async function run() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set. Export it and re-run.');
    process.exit(1);
  }

  const prompt = await readFile(PROMPT_PATH, 'utf8');
  console.log(`Asking ${MODEL} the active question…`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    console.error(`API returned ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  const text = (data.content ?? []).map((c) => c.text ?? '').join('');
  const parsed = parse(text);
  if (!parsed) {
    console.error('Could not parse a forecast out of the reply:\n', text);
    process.exit(1);
  }

  const artefact = {
    ...parsed,
    model: MODEL,
    ranAt: Date.now(),
    live: false,
    promptSha: await sha256(prompt)
  };

  console.log(JSON.stringify(artefact, null, 2));

  if (args.has('--dry')) {
    console.log('\n--dry: nothing written.');
    return;
  }

  await writeFile(OUT_PATH, `${JSON.stringify(artefact, null, 2)}\n`);
  console.log(`\nWrote ${OUT_PATH}`);
  console.log('Now re-run `npm run snapshot` so the offline board matches.');
}

function parse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!Number.isFinite(parsed.p)) return null;
    return {
      p: Math.min(0.99, Math.max(0.01, parsed.p)),
      baseRate: typeof parsed.baseRate === 'string' ? parsed.baseRate : null,
      reasons: (parsed.reasons ?? []).filter((r) => typeof r === 'string').slice(0, 2)
    };
  } catch {
    return null;
  }
}

async function check() {
  const artefact = JSON.parse(await readFile(OUT_PATH, 'utf8'));
  const ageHours = (Date.now() - artefact.ranAt) / 3_600_000;
  const promptSha = await sha256(await readFile(PROMPT_PATH, 'utf8'));

  console.log(`p          ${artefact.p}`);
  console.log(`model      ${artefact.model}`);
  console.log(`ran        ${new Date(artefact.ranAt).toISOString()} (${ageHours.toFixed(1)}h ago)`);
  console.log(`reasons    ${artefact.reasons.length}`);
  console.log(`prompt     ${promptSha === artefact.promptSha ? 'matches artefact' : 'CHANGED since the artefact was made'}`);

  if (promptSha !== artefact.promptSha) process.exitCode = 1;
  if (ageHours > 24) {
    console.log('\nOlder than a day. Re-run it on the morning of the talk.');
    process.exitCode = 1;
  }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
