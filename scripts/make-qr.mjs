#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   QR code at slide scale — §10 item 8.

   Emits an SVG sized for the placeholder on slide 3, in the deck's own palette,
   plus a PNG for anything that will not take an SVG.

       node scripts/make-qr.mjs https://cyq.fi/f
       node scripts/make-qr.mjs https://cyq.fi/f --out slide-qr

   Test it from the back row before the talk, not on the day. Error correction
   is set to H (30% recoverable) because the thing will be photographed at an
   angle, in the dark, off a projector, by 150 phones at once.
--------------------------------------------------------------------------- */

import QRCode from 'qrcode';
import { writeFile } from 'node:fs/promises';

const url = process.argv[2];
if (!url || url.startsWith('--')) {
  console.error('Usage: node scripts/make-qr.mjs <url> [--out basename]');
  process.exit(1);
}

const outIdx = process.argv.indexOf('--out');
const base = outIdx === -1 ? 'qr' : process.argv[outIdx + 1];

// Slide 3 sizes its QR at 4397772 EMU ≈ 4.81in on a 21.99in-wide slide, which
// is 420px on a 1920px render. Emitted at 1200px so it stays crisp if it is
// dropped into a full-bleed slide instead.
const options = {
  errorCorrectionLevel: 'H',
  margin: 2,
  width: 1200,
  color: {
    // White on the deck's dark moment surface. Scanners want the light module
    // to be the background, so this stays light-on-dark rather than inverting.
    dark: '#05050AFF',
    light: '#FFFFFFFF'
  }
};

const svg = await QRCode.toString(url, { ...options, type: 'svg' });
await writeFile(`${base}.svg`, svg);
await QRCode.toFile(`${base}.png`, url, options);

console.log(`Wrote ${base}.svg and ${base}.png for ${url}`);
console.log('\nBefore the talk:');
console.log('  · print it at slide scale and scan it from the back row');
console.log('  · scan it once with the venue Wi-Fi off, to see what a phone on 4G gets');
console.log('  · put the short link on the slide as text too — some phones will not scan');
