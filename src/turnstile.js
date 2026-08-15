/* ---------------------------------------------------------------------------
   Turnstile verification (§9, spam / ballot stuffing).

   Deliberately fail-open on a network error. On stage, a Cloudflare siteverify
   call that times out on venue Wi-Fi must not cost a real participant their
   forecast — the rate limit and one-forecast-per-client-id are the defences
   that always apply, and this is the extra layer on top.
--------------------------------------------------------------------------- */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(secret, token, ip) {
  if (!token || typeof token !== 'string') return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) return true;
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('turnstile unreachable, allowing submission', err);
    return true;
  } finally {
    clearTimeout(timer);
  }
}
