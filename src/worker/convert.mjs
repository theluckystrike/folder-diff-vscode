// Worker thread for one file pair: turns Word, OpenDocument, Excel, CSV, Parquet and PDF files into text for
// VS Code's diff editor, or lists the byte ranges that differ in two binary files. One job per thread; the
// host sets a memory cap and a time limit, so a hostile file cannot hang or crash the editor.
import { parentPort } from 'worker_threads';
import docxMod from '../engines/docx/convert.js';
import tableMod from '../engines/table/totext.js';
import bytesMod from '../core/bytes.js';

const { convertDocx } = docxMod;
const { tableToText } = tableMod;
const { diffRanges, hexDump } = bytesMod;

const TABLE_FORMAT = { '.csv': 'csv', '.tsv': 'tsv', '.tab': 'tsv', '.psv': 'csv', '.parquet': 'parquet', '.pq': 'parquet',
  '.xlsx': 'excel', '.xlsm': 'excel', '.xlsb': 'excel', '.xls': 'excel', '.ods': 'excel' };

// Zip bomb guard for Word and OpenDocument files: read the declared sizes in the ZIP central directory before
// anything is inflated. A real document is far below these limits.
const MAX_ENTRY_BYTES = 128 * 1048576, MAX_TOTAL_BYTES = 256 * 1048576, MAX_ENTRIES = 20000;
export function zipInflateCheck(buf) {
  const b = Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) return null; // not a ZIP (old .doc): nothing to check here
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return 'The file looks like a ZIP package without its directory (cut or damaged).';
  const count = b.readUInt16LE(eocd + 10), cdOff = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) return 'The package uses ZIP64 sizes, which a Word document never needs. It was not unpacked.';
  if (count > MAX_ENTRIES) return `The package has ${count} parts, over the limit of ${MAX_ENTRIES}. It was not unpacked.`;
  let p = cdOff, total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return 'The ZIP directory of the package is damaged.';
    const size = b.readUInt32LE(p + 24);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    if (size === 0xffffffff) return 'The package uses ZIP64 sizes, which a Word document never needs. It was not unpacked.';
    if (size > MAX_ENTRY_BYTES) return `One part of the package would unpack to ${Math.round(size / 1048576)} MB, over the limit of ${MAX_ENTRY_BYTES / 1048576} MB (a zip bomb or a damaged file). It was not unpacked.`;
    total += size;
    if (total > MAX_TOTAL_BYTES) return `The package would unpack to more than ${MAX_TOTAL_BYTES / 1048576} MB (a zip bomb or a damaged file). It was not unpacked.`;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function toText(job) {
  const ext = job.ext;
  if (job.kind === 'docx') {
    const bomb = zipInflateCheck(Buffer.from(job.bytes));
    if (bomb) return { ok: false, error: bomb };
    const r = await convertDocx(Buffer.from(job.bytes), { ext, maxImageBytes: 1, maxTotalImageBytes: 1 });
    if (!r.ok) return { ok: false, error: r.notice ? r.notice.title + (r.notice.detail ? '. ' + r.notice.detail : '') : 'The document did not open.' };
    // Pictures are left out of the text diff; keep a short marker with the size where each one was.
    const text = r.markdown.replace(/\\\[Image not shown: ([^\]]*?) is over the [^\]]*? image limit\\\]/g, '[picture, $1]');
    return { ok: true, text, info: `${(r.stats && r.stats.words) || 0} words` };
  }
  if (job.kind === 'table') {
    const format = TABLE_FORMAT[ext];
    const source = job.path ? { path: job.path } : { bytes: new Uint8Array(job.bytes) };
    const r = await tableToText(source, format, {}, job.maxRows || 100000);
    return { ok: true, text: r.text, info: `${r.rows} rows${r.sheets > 1 ? `, ${r.sheets} sheets` : ''}${r.cut ? ' (cut)' : ''}` };
  }
  if (job.kind === 'pdf') {
    // pdf.js is loaded only for PDF jobs.
    const { pdfToText } = await import('../engines/pdf/pdftext.mjs');
    const r = await pdfToText(new Uint8Array(job.bytes), { maxPages: job.maxPages || 2000 });
    if (!r.ok) return r;
    return { ok: true, text: r.text, info: `${r.pages} pages${r.cut ? ' (cut)' : ''}` };
  }
  throw new Error('Unknown kind ' + job.kind);
}

async function binary(job) {
  const d = await diffRanges(job.left, job.right, { maxRanges: job.maxRanges || 200 });
  const width = Math.max(d.sizeA, d.sizeB);
  const opts = { context: 1, maxLines: job.maxLines || 3000, width };
  const [la, lb] = await Promise.all([hexDump(job.left, d.ranges, opts), hexDump(job.right, d.ranges, opts)]);
  return { ok: true, ranges: d.ranges.length, more: d.more, diffBytes: d.diffBytes, sizeA: d.sizeA, sizeB: d.sizeB, leftLines: la, rightLines: lb };
}

if (parentPort) parentPort.once('message', async (job) => {
  try {
    const result = job.kind === 'binary' ? await binary(job) : await toText(job);
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ result: { ok: false, error: String((err && err.message) || err).slice(0, 400) } });
  }
});
