'use strict';
// Legacy Word 97-2003 (.doc, .dot) as text. Uses only the OLE part of word-extractor (MIT):
// the package entry point also loads saxes (ISC) and yauzl, which we do not ship.
// Runs inside the worker thread like the .docx converter.

const WordOleExtractor = require('word-extractor/lib/word-ole-extractor');
const BufferReader = require('word-extractor/lib/buffer-reader');

const BANNER = 'Old Word 97-2003 file. Text only: formatting, images and layout are not shown.';

class GuardedExtractor extends WordOleExtractor {
  // The FIB flag fEncrypted (0x0100 at offset 0x0A) marks a password-protected file. Its text
  // streams are ciphertext, so stop here instead of showing noise.
  extractWordDocument(document, buffer) {
    if (buffer.length > 0x0c && buffer.readUInt16LE(0) === 0xa5ec && (buffer.readUInt16LE(0x0a) & 0x0100)) {
      const err = new Error('The document is encrypted');
      err.code = 'DV_ENCRYPTED';
      return Promise.reject(err);
    }
    return super.extractWordDocument(document, buffer);
  }
}

async function extractDoc(buffer) {
  const reader = new BufferReader(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  await reader.open();
  try {
    return await new GuardedExtractor().extract(reader);
  } finally {
    await reader.close();
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Word marks the end of each table cell and row with a tab in the extracted text, so a
// line that ends in a tab is a table row. Consecutive rows form one table.
function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let rows = null;
  const flush = () => {
    if (!rows) return;
    const width = Math.max(...rows.map((r) => r.length));
    out.push('<table><tbody>' + rows.map((r) => {
      const cells = r.concat(Array(width - r.length).fill(''));
      return '<tr>' + cells.map((c) => '<td>' + esc(c.trim()) + '</td>').join('') + '</tr>';
    }).join('') + '</tbody></table>');
    rows = null;
  };
  for (const line of lines) {
    if (/\t$/.test(line) && line.trim()) {
      const cells = line.split('\t');
      cells.pop(); // the empty cell after the last tab
      (rows || (rows = [])).push(cells);
      continue;
    }
    flush();
    const t = line.trim();
    if (t) out.push('<p>' + esc(t) + '</p>');
  }
  flush();
  return out.join('\n');
}

// Keep curly quotes and dashes as written (the library default turns them into ASCII).
const RAW = { filterUnicode: false };

// Returns { html, sections } where html is unsanitized but fully escaped converter output.
function docToHtml(d) {
  const parts = [textToHtml(d.getBody(RAW))];
  const sections = [];
  const add = (title, text) => {
    if (!text || !String(text).trim()) return;
    sections.push(title);
    parts.push('<h2>' + esc(title) + '</h2>');
    parts.push(textToHtml(text));
  };
  add('Headers and footers', d.getHeaders({ includeFooters: true, filterUnicode: false }));
  add('Footnotes', d.getFootnotes(RAW));
  add('Endnotes', d.getEndnotes(RAW));
  add('Comments', d.getAnnotations(RAW));
  add('Text boxes', d.getTextboxes({ includeHeadersAndFooters: false, includeBody: true, filterUnicode: false }));
  return { html: parts.join('\n'), sections };
}

module.exports = { extractDoc, docToHtml, textToHtml, BANNER };
