'use strict';
// File format sniffing and user-facing notices. No dependencies, so the
// extension host can load it without pulling in mammoth.

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const RTF_MAGIC = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf

function startsWith(buf, magic) {
  if (!buf || buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

// Word's "Save as Web Page" and many export tools write HTML or MHTML files with a .doc name.
const HTML_HEAD = /^(?:\ufeff)?\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html|mime-version\s*:)/i;

// Returns 'zip' | 'ole' | 'rtf' | 'html' | 'empty' | 'unknown'.
function detectFormat(buf) {
  if (!buf || buf.length === 0) return 'empty';
  if (startsWith(buf, ZIP_MAGIC)) return 'zip';
  if (startsWith(buf, OLE_MAGIC)) return 'ole';
  if (startsWith(buf, RTF_MAGIC)) return 'rtf';
  const head = new TextDecoder('utf-8').decode(buf.subarray(0, Math.min(buf.length, 1024)));
  if (HTML_HEAD.test(head)) return 'html';
  return 'unknown';
}

function isLegacyExt(ext) {
  return ext === '.doc' || ext === '.dot';
}

// What an OLE (Compound File) container holds, from the UTF-16 stream names in its directory:
// 'encrypted' (a password-protected .docx: EncryptedPackage + EncryptionInfo), 'doc' (a Word
// 97-2003 file: WordDocument stream) or 'other'.
// Plain Uint8Array code (no Node Buffer), so the same file runs in the VS Code for the Web worker.
function U16(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i] = c & 0xff; out[2 * i + 1] = c >> 8; }
  return out;
}
// Index of needle in hay (both Uint8Array), or -1. Node's Buffer.indexOf when there is one (fast,
// native); a byte loop in the browser.
function indexOfBytes(hay, needle) {
  const NodeBuffer = globalThis.Buffer; // undefined in the browser; not a free name, so no polyfill gets bundled
  if (NodeBuffer && NodeBuffer.isBuffer(hay)) return hay.indexOf(NodeBuffer.from(needle.buffer, needle.byteOffset, needle.byteLength));
  const first = needle[0];
  const last = hay.length - needle.length;
  outer: for (let i = hay.indexOf(first); i !== -1 && i <= last; i = hay.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
const ENCRYPTED_PACKAGE = U16('EncryptedPackage');
const WORD_DOCUMENT = U16('WordDocument');
function oleKind(buf) {
  if (!buf || !buf.length) return 'other';
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (indexOfBytes(b, ENCRYPTED_PACKAGE) !== -1) return 'encrypted';
  if (indexOfBytes(b, WORD_DOCUMENT) !== -1) return 'doc';
  return 'other';
}

// True when the converter (worker) can open these bytes: any ZIP package, a Word 97-2003 file under
// any Word name (an old .doc renamed to .docx is common), or RTF saved under a .doc name.
function canConvert(format, ext, bytes) {
  if (format === 'zip') return true;
  if (format === 'ole') return isLegacyExt(ext) || (bytes ? oleKind(bytes) === 'doc' : false);
  if (format === 'rtf') return isLegacyExt(ext);
  return false;
}

// A user-facing notice for files we will not render. ext is like ".doc".
function noticeFor(format, ext, bytes) {
  if (format === 'ole') {
    if (bytes && oleKind(bytes) === 'encrypted') return ENCRYPTED_DOCX;
    if (isLegacyExt(ext)) {
      return { kind: 'legacyDoc', title: 'This is an old Word file (' + ext + ')', detail: 'DOCX Viewer shows the text of Word 97-2003 files. Open it in Word, LibreOffice or Pages and save it as .docx to see the formatting too.' };
    }
    return { kind: 'encrypted', title: 'This file is password protected or is an old .doc file', detail: 'Word saves password-protected documents in an encrypted container that DOCX Viewer cannot read. A .doc file renamed to ' + (ext || '.docx') + ' looks the same. Open it in Word, remove the password or save as .docx, then open it here.' };
  }
  if (format === 'rtf' && isLegacyExt(ext)) return { kind: 'notDocx', title: 'This ' + ext + ' file is really an RTF file', detail: 'The file contains Rich Text Format under a Word name. DOCX Viewer does not read RTF. Open it in Word, Pages, LibreOffice or a text editor.' };
  if (format === 'html' && isLegacyExt(ext)) return { kind: 'notDocx', title: 'This ' + ext + ' file is really an HTML file', detail: 'The file is a web page saved under a Word name. DOCX Viewer does not open HTML. Open it in Word or a browser, or rename it to .html.' };
  if (format === 'rtf') return { kind: 'notDocx', title: 'This is an RTF file', detail: 'The file contains Rich Text Format, not a Word .docx package. Open it in Word or a text editor.' };
  if (format === 'empty') return { kind: 'empty', title: 'This file is empty', detail: 'The file has 0 bytes.' };
  if (format === 'html') format = 'unknown';
  if (format === 'unknown' && (ext === '.odt' || ext === '.ott')) return { kind: 'notDocx', title: 'This is not an OpenDocument text file', detail: 'An .odt file is a ZIP package. This file does not start with a ZIP header, so it may be damaged or have the wrong extension.' };
  if (format === 'unknown') return { kind: 'notDocx', title: 'This is not a Word .docx file', detail: 'A .docx file is a ZIP package. This file does not start with a ZIP header, so it may be damaged or have the wrong extension.' };
  return null;
}

// Notice for a password-protected .docx (Word stores it in an encrypted OLE container).
const ENCRYPTED_DOCX = { kind: 'encrypted', title: 'This document is password protected', detail: 'Word encrypted this file with a password, so DOCX Viewer cannot read it. Open it in Word, remove the password (File > Info > Protect Document) and save it again, then open it here.' };

// Notice for a password-protected .doc file (the FIB says the streams are encrypted).
const ENCRYPTED_DOC = { kind: 'encrypted', title: 'This .doc file is password protected', detail: 'Word encrypted the text of this file. DOCX Viewer cannot read it. Open it in Word, remove the password and save it again, then open it here.' };

module.exports = { indexOfBytes, detectFormat, noticeFor, canConvert, isLegacyExt, oleKind, ENCRYPTED_DOC, ENCRYPTED_DOCX };
