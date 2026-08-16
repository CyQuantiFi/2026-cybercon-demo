/* ---------------------------------------------------------------------------
   Moderation token comparison.

   Its own module, with no Workers-runtime imports, so it can be unit tested
   under plain Node — `src/index.js` reaches the Durable Object runtime through
   `cloudflare:workers`, which Node cannot resolve.
--------------------------------------------------------------------------- */

/**
 * Compare a supplied token against the configured secret.
 *
 * Both sides are trimmed. Whitespace is never meaningful in an opaque shared
 * secret, and it is very easy to capture by accident: `wrangler secret put`
 * reads from a prompt, so a pasted value or a piped `echo` carries a trailing
 * \r or \n into the stored copy. The token typed on the phone then differs
 * from the stored one by a byte nobody can see, and moderation is dead for the
 * whole talk with no clue anywhere. That exact failure is what prompted this.
 *
 * The comparison runs over SHA-256 digests rather than the raw strings. Fixed
 * 32-byte inputs mean there is no length-dependent early exit, so unlike a
 * plain byte loop this does not leak the secret's length through timing.
 */
export async function secretEquals(supplied, secret) {
  if (typeof supplied !== 'string' || typeof secret !== 'string') return false;

  const a = new Uint8Array(await sha256(supplied.trim()));
  const b = new Uint8Array(await sha256(secret.trim()));

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}
