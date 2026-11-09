'use strict';
// Random tags and CSP nonces from Web Crypto (globalThis.crypto): the same code runs in the desktop
// extension host (Node 20+), in the converter worker and in VS Code for the Web, which has no
// Node 'crypto' module.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

function hex(n) {
  let s = '';
  for (const b of randomBytes(n)) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

// 22 letters and digits, about 130 bits. 248 is the largest multiple of 62 under 256, so values
// from 248 up are dropped to keep every character equally likely.
function nonce() {
  let s = '';
  while (s.length < 22) for (const b of randomBytes(32)) if (b < 248 && s.length < 22) s += ALNUM[b % 62];
  return s;
}

module.exports = { randomBytes, hex, nonce };
