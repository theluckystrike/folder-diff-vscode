'use strict';
// Converts .docx/.dotx/.docm and OpenDocument .odt/.ott bytes to sanitized HTML chunks, outline, Markdown and text.
// Runs inside a worker thread (see worker.js) so a big file never blocks the extension host.

const mammoth = require('mammoth');
const JSZip = require('jszip');
const { convertOdt, odfKind } = require('./odt');
const H = require('./html');
const { detectFormat, noticeFor, isLegacyExt, oleKind, ENCRYPTED_DOC } = require('./detect');
const LegacyDoc = require('./doc');
const Rev = require('./revisions');
const Prep = require('./prep');
const { rtfToText, tabBlocksToRows } = require('./rtf');

const DEFAULTS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxTotalImageBytes: 300 * 1024 * 1024,
  maxChunkChars: 200000
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/webp']);
const PictureKind = require('./picture-kind');

// Mammoth ignores Word's Title, Subtitle, Quote and Caption styles by default.
const STYLE_MAP = [
  "p[style-name='Title'] => h1.dv-title:fresh",
  "p[style-name='Subtitle'] => p.dv-subtitle:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Caption'] => p.dv-caption:fresh",
  "r[style-name='Strong'] => strong",
  "p[style-name='Code'] => pre:separator('\\n')",
  'u => u',
  'strike => s'
];

function makeImageConverter(opts, stats) {
  return mammoth.images.imgElement(async (image) => {
    let type = (image.contentType || '').toLowerCase();
    let buf = null;
    if (!IMAGE_TYPES.has(type)) {
      // EMF, WMF and TIFF go to the webview as bytes; media/pictures.js draws them there. The bytes
      // decide, not the declared type: Word files often call a WMF "image/x-emf" or "application/octet-stream".
      buf = await image.read();
      const kind = PictureKind.sniff(buf);
      if (!kind) {
        stats.skipped++;
        const fmt = (PictureKind.kindOfType(type) || (type.split('/')[1] || 'unknown').replace(/^x-/, '')).toUpperCase();
        return { src: '', 'data-dv-skipped': fmt + ' images are not supported' };
      }
      type = PictureKind.MIME[kind];
    }
    if (!buf) buf = await image.read();
    if (buf.length > opts.maxImageBytes) {
      stats.skipped++;
      return { src: '', 'data-dv-skipped': H.formatBytes(buf.length) + ' is over the ' + H.formatBytes(opts.maxImageBytes) + ' image limit' };
    }
    if (stats.totalBytes + buf.length > opts.maxTotalImageBytes) {
      stats.skipped++;
      return { src: '', 'data-dv-skipped': 'the document is over the ' + H.formatBytes(opts.maxTotalImageBytes) + ' total image limit' };
    }
    stats.totalBytes += buf.length;
    // The bytes travel next to the HTML and become a blob: URL in the webview. Base64 inside the
    // HTML made big reports slow: 40 MB of pictures meant a 55 MB string to sanitize and post.
    const copy = new Uint8Array(buf.length);
    copy.set(buf);
    stats.list.push({ type: type === 'image/jpg' ? 'image/jpeg' : type, data: copy });
    return { src: 'dv-img:' + (stats.list.length - 1) };
  });
}

// Mammoth warnings that only mean "a Word style has no special HTML": every real file has dozens.
const NOISE = /^(Unrecognised (paragraph|run|table|numbering) style|An unrecognised element was ignored|Image of type image\/x-(emf|wmf) is unlikely|(Paragraph|Run|Table|Numbering) style with ID .* was referenced but not defined)/;

// XML parts that declare a DOCTYPE or custom entities (Word never writes them; some generators do)
// make mammoth's XML reader fail. Remove the DOCTYPE and unknown entity references, then retry.
const DOCTYPE = /<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?\s*>/g;
async function stripDoctypes(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/i.test(name) || zip.files[name].dir) continue;
    const xml = await zip.file(name).async('string');
    if (xml.indexOf('<!DOCTYPE') === -1) continue;
    const clean = xml.replace(DOCTYPE, '').replace(/&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)[A-Za-z_][\w.-]*;/g, '');
    zip.file(name, clean);
    changed = true;
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) : null;
}

// Mammoth's Node build reads options.buffer, its browser build (VS Code for the Web) options.arrayBuffer.
// Both hand the bytes to JSZip, which takes a Buffer or Uint8Array.
function zipInput(bytes) { return { buffer: bytes, arrayBuffer: bytes }; }

// buf: Buffer/Uint8Array of a .docx. Returns a plain, structured-clone-safe object.
async function convertDocx(buf, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const t0 = Date.now();
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  const format = detectFormat(buffer);
  if (format === 'ole' && (isLegacyExt(opts.ext || '') || oleKind(buffer) === 'doc')) return convertLegacyDoc(buffer, opts, t0);
  if (format === 'rtf' && isLegacyExt(opts.ext || '')) return convertRtf(buffer, opts, t0);
  if (format !== 'zip') return { ok: false, notice: noticeFor(format, opts.ext || '', buffer) };
  // OpenDocument packages are ZIP files too. Their first entry is an uncompressed "mimetype" file,
  // so a .docx skips the extra ZIP read. .odt/.ott files are always checked in full.
  const odfHint = buffer.length > 38 && buffer.toString('latin1', 30, 38) === 'mimetype';
  let zip = null;
  if (odfHint || /^\.ot[td]$/.test(opts.ext || '')) {
    try { zip = await JSZip.loadAsync(buffer); } catch (_) { zip = null; }
  }
  const kind = zip ? await odfKind(zip) : null;
  if (kind === 'other') {
    return { ok: false, notice: { kind: 'notDocx', title: 'This is an OpenDocument spreadsheet, presentation or drawing', detail: 'DOCX Viewer reads Word files (.docx, .dotx, .docm) and OpenDocument text (.odt, .ott). Open this file in LibreOffice or another office app.' } };
  }
  if (kind === 'text') {
    let r;
    try {
      r = await convertOdt(buffer, opts, zip);
    } catch (err) {
      return { ok: false, notice: { kind: 'error', title: 'DOCX Viewer could not read this OpenDocument file', detail: String((err && err.message) || err).slice(0, 500) } };
    }
    if (!r.ok) return r;
    return finish(r.html, r.warnings, opts, t0, 'odt');
  }
  // Tracked changes and comments: a cheap look at the raw XML first. Files without them take the
  // plain path. Final (the default for Copy, Open as Text and Compare) is always the untouched file.
  const mode = Rev.MODES.includes(opts.revisionMode) ? opts.revisionMode : 'final';
  let input = buffer;
  let styleMap = STYLE_MAP;
  let summary = null;
  let changeTable = null;
  let comments = null;
  let docZip = null;
  let prep = null;
  try { docZip = await JSZip.loadAsync(buffer); } catch (_) { docZip = null; } // mammoth reports the error below
  const docPart = docZip && docZip.file('word/document.xml');
  const commentsPart = docZip && docZip.file('word/comments.xml');
  if (docPart) {
    const documentXml = await docPart.async('string');
    const commentsXml = commentsPart ? await commentsPart.async('string') : '';
    if (Rev.hasChanges(documentXml) || commentsXml) {
      summary = Rev.summarize(documentXml, commentsXml);
      if (!summary.changes && !summary.comments) summary = null;
    }
    if (summary && mode !== 'final') {
      if (summary.changes) {
        const stylesPart = docZip.file('word/styles.xml');
        const stylesXml = stylesPart ? await stylesPart.async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>';
        const rw = Rev.rewrite(documentXml, stylesXml, mode);
        docZip.file('word/document.xml', rw.documentXml);
        if (stylesPart) docZip.file('word/styles.xml', rw.stylesXml);
        input = await docZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        styleMap = rw.styleMap.concat(STYLE_MAP);
        changeTable = rw.table;
      }
      if (mode === 'markup' && summary.comments) {
        styleMap = styleMap.concat(['comment-reference => sup']);
        comments = { info: Rev.commentInfo(commentsXml), count: summary.comments };
      }
    }
    // Equations, charts and simple fields (see src/prep.js). Works on the XML after the
    // tracked-changes rewrite, so Markup and Original views get them too.
    const currentXml = input === buffer ? documentXml : await docZip.file('word/document.xml').async('string');
    let rewritten = false;
    if (Prep.needsPrep(currentXml)) {
      const relsPart = docZip.file('word/_rels/document.xml.rels');
      const relsXml = relsPart ? await relsPart.async('string') : '';
      const readPart = async (name) => { const f = docZip.file(name); return f ? f.async('string') : null; };
      prep = await Prep.prepare(currentXml, readPart, relsXml);
      if (prep.xml !== currentXml) { docZip.file('word/document.xml', prep.xml); rewritten = true; }
    }
    for (const part of ['word/footnotes.xml', 'word/endnotes.xml']) {
      const f = docZip.file(part);
      if (!f) continue;
      const xml = await f.async('string');
      const clean = Prep.unwrapFldSimple(xml);
      if (clean !== xml) { docZip.file(part, clean); rewritten = true; }
    }
    if (rewritten) input = await docZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  }
  docZip = null;
  const imgStats = { totalBytes: 0, skipped: 0, list: [] };
  const mammothOptions = {
    styleMap,
    convertImage: makeImageConverter(opts, imgStats),
    includeDefaultStyleMap: true,
    ignoreEmptyParagraphs: true
  };
  let result;
  try {
    try {
      result = await mammoth.convertToHtml(zipInput(input), mammothOptions);
    } catch (err) {
      if (!/entity|DOCTYPE/i.test(String((err && err.message) || err))) throw err;
      const clean = await stripDoctypes(input);
      if (!clean) throw err;
      imgStats.list.length = 0;
      imgStats.totalBytes = 0;
      result = await mammoth.convertToHtml(zipInput(clean), mammothOptions);
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    const corrupt = /end of central directory|corrupted zip|Can't find end|Could not find file in options|word\/document\.xml|is this a zip/i.test(msg);
    return {
      ok: false,
      notice: corrupt
        ? { kind: 'notDocx', title: 'This file is not a readable Word document', detail: 'The ZIP package has no Word document part or is damaged. Details: ' + msg.slice(0, 300) }
        : { kind: 'error', title: 'DOCX Viewer could not read this file', detail: msg.slice(0, 500) }
    };
  }
  const warnings = [];
  const seen = new Set();
  for (const m of result.messages || []) {
    const text = String(m.message || '').slice(0, 300);
    if (!seen.has(text) && warnings.length < 50) { seen.add(text); warnings.push(text); }
  }
  const html = comments ? labelComments(result.value, comments) : result.value;
  const r = finish(html, warnings.filter((w) => !/Zovo(Ins|Del)\d/.test(w) && !NOISE.test(w)), opts, t0, 'docx', prep);
  if (imgStats.list.length) r.images = imgStats.list;
  if (summary) r.revisions = { changes: summary.changes, comments: summary.comments, authors: summary.authors.slice(0, 20), label: Rev.label(summary), mode };
  if (changeTable && Object.keys(changeTable).length) r.changeTable = changeTable;
  return r;
}

// Mammoth lists comments at the end as <dl><dt id="comment-N">Comment [AB1]</dt>... Give the list a
// heading for the outline and put the author and date in each entry.
function labelComments(html, comments) {
  const at = html.indexOf('<dl><dt id="comment-');
  if (at === -1) return html;
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tail = html.slice(at).replace(/<dt id="comment-(\d+)">([^<]*)<\/dt>/g, (m, id, old) => {
    const c = comments.info[id];
    return '<dt id="comment-' + id + '">' + (c ? esc(c.author) + (c.date ? ' · ' + esc(c.date) : '') + ' ' : '') + old.replace(/^Comment\s*/, '') + '</dt>';
  });
  return html.slice(0, at) + '<h2 class="dv-comments-title">Comments (' + comments.count + ')</h2>' + tail;
}

// Word 97-2003 .doc/.dot: text, simple tables and the side parts (headers, notes, comments, text boxes).
// Every failure becomes a notice with "Open in default app", never an empty page.
async function convertLegacyDoc(buffer, opts, t0) {
  let d;
  try {
    d = await LegacyDoc.extractDoc(buffer);
  } catch (err) {
    if (err && err.code === 'DV_ENCRYPTED') return { ok: false, notice: ENCRYPTED_DOC };
    return { ok: false, notice: { kind: 'error', title: 'DOCX Viewer could not read this ' + (opts.ext || '.doc') + ' file', detail: 'The Word 97-2003 file may be damaged or saved by a tool DOCX Viewer does not know. Details: ' + String((err && err.message) || err).slice(0, 300) } };
  }
  const { html } = LegacyDoc.docToHtml(d);
  const r = finish(html, [], opts, t0, 'doc');
  r.banner = isLegacyExt(opts.ext || '.doc') ? LegacyDoc.BANNER : 'This is an old Word 97-2003 file with a ' + opts.ext + ' name. Text only: formatting, images and layout are not shown.';
  r.bannerActions = ['openInDefaultApp'];
  return r;
}

// RTF saved under a .doc name: text, paragraphs and tables.
const RTF_BANNER = 'This file is Rich Text Format (RTF) under a Word name. Text only: formatting, images and layout are not shown.';
async function convertRtf(buffer, opts, t0) {
  let text;
  try {
    text = rtfToText(buffer);
  } catch (err) {
    return { ok: false, notice: noticeFor('rtf', opts.ext || '.doc') };
  }
  const r = finish(LegacyDoc.textToHtml(tabBlocksToRows(text)), [], opts, t0, 'rtf');
  r.banner = RTF_BANNER;
  r.bannerActions = ['openInDefaultApp'];
  return r;
}

// Shared by .docx, .odt and .doc: sanitize the converter HTML and derive chunks, outline, Markdown and text.
function finish(rawHtml, warnings, opts, t0, format, prep) {
  const clean = H.sanitize(H.parse(rawHtml));
  const items = prep ? H.injectItems(clean.tree, prep.items, prep.tag) : { equations: 0, charts: 0 };
  const chunks = H.chunkBlocks(clean.tree, opts.maxChunkChars);
  const text = H.toPlainText(clean.tree);
  return {
    ok: true,
    format,
    chunks,
    outline: clean.outline,
    warnings: warnings.slice(0, 50),
    markdown: H.toMarkdown(clean.tree),
    text,
    stats: {
      words: (text.match(/\S+/g) || []).length,
      headings: clean.outline.length,
      images: clean.images,
      skippedImages: clean.skippedImages,
      footnotes: clean.footnotes,
      tables: (rawHtml.match(/<table/g) || []).length,
      equations: items.equations,
      charts: items.charts,
      htmlChars: chunks.reduce((n, c) => n + c.length, 0),
      ms: Date.now() - t0
    }
  };
}

module.exports = { convertDocx, detectFormat, noticeFor, DEFAULTS, STYLE_MAP };
