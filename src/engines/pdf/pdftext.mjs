// Extracts the text of a PDF, page by page, for the diff editor. Runs in the converter worker.
// pdf.js runs in the same thread (its "fake worker"), because the worker module is loaded up front.
import './dom-shim.mjs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

globalThis.pdfjsWorker = pdfWorker;

/** Joins the text items of one page into lines, using the y position to find line breaks. */
export function pageLines(items) {
  const lines = [];
  let cur = '';
  let lastY = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = Array.isArray(it.transform) ? Math.round(it.transform[5]) : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) { lines.push(cur.trimEnd()); cur = ''; }
    cur += it.str;
    if (it.hasEOL) { lines.push(cur.trimEnd()); cur = ''; lastY = null; continue; }
    if (y !== null) lastY = y;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.filter((l, i, a) => l || (i > 0 && a[i - 1]));
}

/**
 * @param {Uint8Array} bytes
 * @param {{maxPages?:number}} [opts]
 * @returns {Promise<{ok:true,text:string,pages:number,cut:boolean}|{ok:false,error:string}>}
 */
export async function pdfToText(bytes, opts = {}) {
  const maxPages = Math.max(1, opts.maxPages || 2000);
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
      stopAtErrors: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    }).promise;
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/password/i.test(m) || (e && e.name === 'PasswordException')) return { ok: false, error: 'The PDF is password protected.' };
    return { ok: false, error: 'This is not a readable PDF (' + m.slice(0, 200) + ').' };
  }
  const n = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(`=== Page ${p} ===`, ...pageLines(tc.items), '');
    page.cleanup();
  }
  const cut = doc.numPages > n;
  if (cut) out.push(`(cut at ${n} pages of ${doc.numPages})`);
  await doc.destroy();
  return { ok: true, text: out.join('\n'), pages: doc.numPages, cut };
}
