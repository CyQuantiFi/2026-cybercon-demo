/* ---------------------------------------------------------------------------
   Session-reset detection for the participant app.

   Its own module, with no DOM, so the rule can be unit tested under plain Node
   — participant.js boots the page the moment it is imported.
--------------------------------------------------------------------------- */

/**
 * Has the session this phone answered been reset out from under it?
 *
 * Only a forecast the server has acknowledged can be stale. While anything is
 * still queued, the phone has not yet heard which session accepted it, and the
 * first poll after a submit routinely lands before the POST's own response
 * does. Treating that as a reset is what used to wipe a freshly submitted
 * forecast off the phone while the server kept it — and the person, sent back
 * to the question, then voted a second time under a new id.
 *
 * Anything still queued will land in whichever session is live when it gets
 * through, and its response carries that session's epoch, so waiting is always
 * safe.
 *
 * An acknowledged forecast with no epoch at all was sent before epochs existed,
 * and is stale for the same reason any mismatch is: we cannot show it is still
 * in the session.
 *
 * @param {{ submitted: boolean, epoch: number|null, pending: number }} phone
 * @param {number|null|undefined} liveEpoch  the epoch carried by the aggregate
 */
export function isStaleForecast(phone, liveEpoch) {
  if (!phone.submitted || !liveEpoch) return false;
  if (phone.pending > 0) return false;
  return phone.epoch !== liveEpoch;
}
