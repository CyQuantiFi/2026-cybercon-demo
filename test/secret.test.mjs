import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretEquals } from '../src/auth.js';

/* ---------------------------------------------------------------------------
   The moderation token comparison.

   These exist because of a real failure: MOD_TOKEN was set on the deployment,
   the correct token was typed on the phone, and /mod said "Token rejected" for
   the whole session. The stored secret had picked up trailing whitespace from
   the `wrangler secret put` prompt, so the two differed by a byte nobody could
   see, in a comparison that reported nothing.
--------------------------------------------------------------------------- */

test('an exact match is accepted', async () => {
  assert.equal(await secretEquals('s3cret-token', 's3cret-token'), true);
});

test('a wrong token is refused', async () => {
  assert.equal(await secretEquals('wrong', 's3cret-token'), false);
});

test('trailing whitespace on the stored secret does not break it', async () => {
  // The actual bug: `wrangler secret put` captured a trailing newline.
  assert.equal(await secretEquals('s3cret-token', 's3cret-token\n'), true);
  assert.equal(await secretEquals('s3cret-token', 's3cret-token\r\n'), true);
  assert.equal(await secretEquals('s3cret-token', 's3cret-token '), true);
});

test('whitespace around the supplied token does not break it either', async () => {
  // Pasting into a phone field, or a bookmarked /mod?t=… with a stray space.
  assert.equal(await secretEquals('  s3cret-token  ', 's3cret-token'), true);
  assert.equal(await secretEquals('s3cret-token\n', 's3cret-token'), true);
});

test('trimming does not make different tokens equal', async () => {
  assert.equal(await secretEquals('s3cret token', 's3cret-token'), false);
  assert.equal(await secretEquals('s3cret', 's3cret-token'), false);
  assert.equal(await secretEquals('', 's3cret-token'), false);
});

test('case still matters', async () => {
  assert.equal(await secretEquals('S3CRET-TOKEN', 's3cret-token'), false);
});

test('a token differing only in length is refused', async () => {
  // The old byte loop early-returned on a length mismatch, leaking length
  // through timing. The digest compare runs over two fixed 32-byte values.
  assert.equal(await secretEquals('s3cret-tokenX', 's3cret-token'), false);
  assert.equal(await secretEquals('s3cret-toke', 's3cret-token'), false);
});

test('non-string input does not throw', async () => {
  assert.equal(await secretEquals(undefined, 's3cret-token'), false);
  assert.equal(await secretEquals(null, 's3cret-token'), false);
});
