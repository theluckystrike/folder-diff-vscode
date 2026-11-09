'use strict';
// Which pictures the webviews draw themselves (EMF, WMF, TIFF), by bytes or by type.
// Shared by the converter (src/convert.js) and the webview decoders (src/pictures.js).

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

// 'emf' | 'wmf' | 'tiff' | null, from the first bytes.
function sniff(b) {
  if (!b || b.length < 8) return null;
  if (b.length >= 44 && u32(b, 0) === 1 && u32(b, 40) === 0x464d4520) return 'emf';
  if (u32(b, 0) === 0x9ac6cdd7) return 'wmf';
  if ((u16(b, 0) === 1 || u16(b, 0) === 2) && u16(b, 2) === 9 && (u16(b, 4) === 0x100 || u16(b, 4) === 0x300)) return 'wmf';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42)) return 'tiff';
  return null;
}

// 'emf' | 'wmf' | 'tiff' | null, from a MIME type or a file extension.
function kindOfType(t) {
  const s = String(t || '').toLowerCase().replace(/^image\//, '').replace(/^x-/, '').replace(/^\./, '');
  if (s === 'emf' || s === 'wmf') return s;
  if (s === 'tif' || s === 'tiff') return 'tiff';
  return null;
}

// The MIME type the webview gets for each kind (see media/protocol.js IMAGE_TYPES).
const MIME = { emf: 'image/x-emf', wmf: 'image/x-wmf', tiff: 'image/tiff' };

module.exports = { sniff, kindOfType, MIME };
