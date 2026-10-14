import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStaleForecast } from '../public/js/session-epoch.js';

/* ---------------------------------------------------------------------------
   Session-reset detection on the phone.

   These exist because of a real failure: the first /api/agg poll after a
   submit landed before the POST's own response, so a phone that had just
   submitted looked like one holding a forecast from a reset session. It wiped
   the forecast, sent the person back to the question, and the server — which
   had accepted the forecast — then took their second answer as a second vote.
--------------------------------------------------------------------------- */

const LIVE = 1_791_948_539_493;

test('a forecast still queued is never stale, even with no epoch yet', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: null, pending: 1 }, LIVE), false);
});

test('a queued forecast from an old session waits for its own response', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: LIVE - 1, pending: 1 }, LIVE), false);
});

test('an acknowledged forecast in the live session is kept', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: LIVE, pending: 0 }, LIVE), false);
});

test('an acknowledged forecast from a reset session is stale', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: LIVE - 1, pending: 0 }, LIVE), true);
});

test('an acknowledged forecast from before epochs existed is stale', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: null, pending: 0 }, LIVE), true);
});

test('nothing submitted means nothing to discard', () => {
  assert.equal(isStaleForecast({ submitted: false, epoch: null, pending: 0 }, LIVE), false);
});

test('an aggregate with no epoch (the KV fallback, an old deploy) discards nothing', () => {
  assert.equal(isStaleForecast({ submitted: true, epoch: LIVE, pending: 0 }, undefined), false);
});
