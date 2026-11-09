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

async function toText(job) {
  const ext = job.ext;
  if (job.kind === 'docx') {
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

parentPort.once('message', async (job) => {
  try {
    const result = job.kind === 'binary' ? await binary(job) : await toText(job);
    parentPort.postMessage({ result });
  } catch (err) {
    parentPort.postMessage({ result: { ok: false, error: String((err && err.message) || err).slice(0, 400) } });
  }
});
