'use strict';
// Converts an OpenDocument text file (.odt, .ott) to the same kind of HTML that mammoth
// writes for .docx, so it goes through the same allowlist sanitizer, outline, Markdown
// and text code. Reads content.xml and styles.xml with JSZip and @xmldom/xmldom, both
// already bundled with mammoth. Pure function, no vscode import.

const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink'
};
const ODT_MIME = /^application\/vnd\.oasis\.opendocument\.text(-template|-master)?$/;
const OTHER_MIME = /^application\/vnd\.oasis\.opendocument\.(spreadsheet|presentation|graphics|formula|chart)/;
const PictureKind = require('./picture-kind');
const IMAGE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
const MAX_DEPTH = 200;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const kind = PictureKind.sniff(buf); // EMF, WMF, TIFF: drawn in the webview (src/pictures.js)
  if (kind) return PictureKind.MIME[kind];
  return '';
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

// Returns the ODF kind of a zip package from its mimetype entry: 'text' | 'other' | null (not ODF).
async function odfKind(zip) {
  const f = zip.file('mimetype');
  if (!f) return null;
  const mime = (await f.async('string')).trim();
  if (ODT_MIME.test(mime)) return 'text';
  if (OTHER_MIME.test(mime)) return 'other';
  return null;
}

function parseXml(src, warnings) {
  const errors = [];
  const doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(String(msg)); } }).parseFromString(src, 'text/xml');
  if (errors.length) warnings.push('XML problem: ' + errors[0].slice(0, 200));
  return doc;
}

function kids(node) {
  const out = [];
  for (let c = node && node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function attr(el, ns, name) {
  return el.getAttributeNS(NS[ns], name) || el.getAttribute(ns + ':' + name) || '';
}

function isEl(n, ns, local) {
  return n.nodeType === 1 && n.namespaceURI === NS[ns] && n.localName === local;
}

// Collects text and paragraph styles (with parent chains) and list styles from styles.xml and content.xml.
function collectStyles(docs) {
  const styles = new Map(); // name -> { parent, bold, italic, underline, strike, sup, sub, display }
  const lists = new Map(); // name -> Map(level -> 'number'|'bullet')
  for (const doc of docs) {
    if (!doc) continue;
    const all = doc.getElementsByTagNameNS(NS.style, 'style');
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const name = attr(s, 'style', 'name');
      if (!name) continue;
      const info = { parent: attr(s, 'style', 'parent-style-name'), display: attr(s, 'style', 'display-name') || name };
      const tp = s.getElementsByTagNameNS(NS.style, 'text-properties')[0];
      if (tp) {
        const w = attr(tp, 'fo', 'font-weight');
        if (w) info.bold = w === 'bold' || Number(w) >= 600;
        const it = attr(tp, 'fo', 'font-style');
        if (it) info.italic = it === 'italic' || it === 'oblique';
        const u = attr(tp, 'style', 'text-underline-style');
        if (u) info.underline = u !== 'none';
        const st = attr(tp, 'style', 'text-line-through-style');
        if (st) info.strike = st !== 'none';
        const pos = attr(tp, 'style', 'text-position');
        if (pos) { info.sup = /^(super|[1-9])/.test(pos); info.sub = /^(sub|-)/.test(pos); }
      }
      styles.set(name, info);
    }
    const ls = doc.getElementsByTagNameNS(NS.text, 'list-style');
    for (let i = 0; i < ls.length; i++) {
      const levels = new Map();
      for (const c of kids(ls[i])) {
        if (c.nodeType !== 1) continue;
        const lvl = Number(attr(c, 'text', 'level')) || 1;
        if (c.localName === 'list-level-style-number') levels.set(lvl, attr(c, 'style', 'num-format') ? 'number' : 'bullet');
        else levels.set(lvl, 'bullet');
      }
      lists.set(attr(ls[i], 'style', 'name'), levels);
    }
  }
  return { styles, lists };
}

function resolve(styles, name) {
  const out = { names: [] };
  const seen = new Set();
  let cur = name;
  const chain = [];
  while (cur && !seen.has(cur) && styles.has(cur)) { seen.add(cur); chain.push(styles.get(cur)); cur = styles.get(cur).parent; }
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i];
    out.names.push(s.display);
    for (const k of ['bold', 'italic', 'underline', 'strike', 'sup', 'sub']) if (k in s) out[k] = s[k];
  }
  if (cur && !styles.has(cur)) out.names.push(cur); // a named parent style that is not defined in the file
  return out;
}

function paragraphKind(names) {
  const n = names.map((x) => x.replace(/_20_/g, ' ').toLowerCase());
  if (n.includes('title')) return 'title';
  if (n.includes('subtitle')) return 'subtitle';
  if (n.some((x) => x === 'quotations' || x === 'quote' || x === 'block text')) return 'quote';
  if (n.some((x) => x === 'preformatted text' || x === 'source text' || x === 'code')) return 'pre';
  if (n.includes('caption') || n.includes('illustration') || n.includes('table')) return n.includes('caption') ? 'caption' : '';
  return '';
}

// buf: Buffer of a .odt package. Returns { ok, html, warnings, stats } or { ok: false, notice }.
async function convertOdt(buf, opts, zipIn) {
  const warnings = [];
  const zip = zipIn || await JSZip.loadAsync(buf);
  const contentFile = zip.file('content.xml');
  if (!contentFile) return { ok: false, notice: { kind: 'notDocx', title: 'This file is not a readable OpenDocument text', detail: 'The ZIP package has no content.xml part or is damaged.' } };
  const content = parseXml(await contentFile.async('string'), warnings);
  const stylesFile = zip.file('styles.xml');
  const stylesDoc = stylesFile ? parseXml(await stylesFile.async('string'), warnings) : null;
  const { styles, lists } = collectStyles([stylesDoc, content]);
  const body = content.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!body) return { ok: false, notice: { kind: 'notDocx', title: 'This file is not a readable OpenDocument text', detail: 'content.xml has no text body.' } };

  const imgStats = { totalBytes: 0, skipped: 0 };
  const notes = [];
  let noteCount = 0;
  let tables = 0;

  async function image(el) {
    const href = attr(el, 'xlink', 'href');
    const fr = el.parentNode;
    const titleEl = fr && kids(fr).find((k) => k.nodeType === 1 && (k.localName === 'title' || k.localName === 'desc'));
    const alt = titleEl ? String(titleEl.textContent || '').trim().slice(0, 300) : '';
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) { imgStats.skipped++; return '<img src="" data-dv-skipped="linked images are not shown">'; }
    const file = zip.file(href.replace(/^\.\//, ''));
    if (!file) { imgStats.skipped++; return '<img src="" data-dv-skipped="the image is missing from the file">'; }
    const data = Buffer.from(await file.async('uint8array'));
    const type = sniffImage(data) || IMAGE_BY_EXT[(href.split('.').pop() || '').toLowerCase()] || '';
    if (!type || !sniffImage(data)) {
      imgStats.skipped++;
      const fmt = (href.split('.').pop() || 'unknown').toUpperCase().slice(0, 10);
      return '<img src="" data-dv-skipped="' + esc(fmt) + ' images are not supported">';
    }
    if (data.length > opts.maxImageBytes) { imgStats.skipped++; return '<img src="" data-dv-skipped="' + esc(formatBytes(data.length) + ' is over the ' + formatBytes(opts.maxImageBytes) + ' image limit') + '">'; }
    if (imgStats.totalBytes + data.length > opts.maxTotalImageBytes) { imgStats.skipped++; return '<img src="" data-dv-skipped="' + esc('the document is over the ' + formatBytes(opts.maxTotalImageBytes) + ' total image limit') + '">'; }
    imgStats.totalBytes += data.length;
    return '<img src="data:' + type + ';base64,' + data.toString('base64') + '" alt="' + esc(alt) + '">';
  }

  // Inline content of a paragraph or heading.
  async function inline(node, depth) {
    if (depth > MAX_DEPTH) return '';
    let s = '';
    for (const c of kids(node)) {
      if (c.nodeType === 3) { s += esc(c.nodeValue.replace(/[ \t\r\n]+/g, ' ')); continue; }
      if (c.nodeType === 4) { s += esc(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      const ns = c.namespaceURI;
      const ln = c.localName;
      if (ns === NS.text) {
        if (ln === 's') { s += ' '.repeat(Math.min(Number(attr(c, 'text', 'c')) || 1, 100)); continue; }
        if (ln === 'tab') { s += '\t'; continue; }
        if (ln === 'line-break') { s += '<br>'; continue; }
        if (ln === 'soft-page-break' || ln === 'bookmark' || ln === 'bookmark-start' || ln === 'bookmark-end' || ln === 'change' || ln === 'change-start' || ln === 'change-end') continue;
        if (ln === 'span') { s += wrap(resolve(styles, attr(c, 'text', 'style-name')), await inline(c, depth + 1)); continue; }
        if (ln === 'a') {
          const href = attr(c, 'xlink', 'href');
          const inner = await inline(c, depth + 1);
          s += /^(https?:\/\/|mailto:)/i.test(href) ? '<a href="' + esc(href) + '">' + inner + '</a>' : inner;
          continue;
        }
        if (ln === 'note') {
          const kind = attr(c, 'text', 'note-class') === 'endnote' ? 'endnote' : 'footnote';
          noteCount++;
          const id = kind + '-' + noteCount;
          const bodyEl = kids(c).find((k) => isEl(k, 'text', 'note-body'));
          notes.push({ id, kind, html: bodyEl ? await blocks(bodyEl, depth + 1) : '' });
          s += '<sup><a href="#' + id + '" id="' + kind + '-ref-' + noteCount + '">[' + noteCount + ']</a></sup>';
          continue;
        }
        s += await inline(c, depth + 1); // text:sequence, text:date, fields: keep their text
        continue;
      }
      if (ns === NS.office && ln === 'annotation') continue; // comments are left out, as for .docx
      if (ns === NS.office && ln === 'annotation-end') continue;
      if (ns === NS.draw && ln === 'frame') { s += await frame(c, depth + 1, true); continue; }
      if (ns === NS.draw && (ln === 'a' || ln === 'g')) { s += await inline(c, depth + 1); continue; }
    }
    return s;
  }

  function wrap(st, html) {
    if (!html) return html;
    if (st.sup) html = '<sup>' + html + '</sup>';
    else if (st.sub) html = '<sub>' + html + '</sub>';
    if (st.strike) html = '<s>' + html + '</s>';
    if (st.underline) html = '<u>' + html + '</u>';
    if (st.italic) html = '<em>' + html + '</em>';
    if (st.bold) html = '<strong>' + html + '</strong>';
    return html;
  }

  async function frame(el, depth, isInline) {
    let s = '';
    for (const c of kids(el)) {
      if (isEl(c, 'draw', 'image')) { s += await image(c); break; } // first image only; later ones are fallbacks
      if (isEl(c, 'draw', 'text-box')) s += await blocks(c, depth + 1);
    }
    return s;
  }

  async function paragraph(el, depth) {
    const st = resolve(styles, attr(el, 'text', 'style-name'));
    const inner = wrap({ bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike }, await inline(el, depth + 1));
    const kind = paragraphKind(st.names);
    if (!inner.replace(/<br>/g, '').trim() && !/<img/.test(inner)) return '';
    if (kind === 'title') return '<h1 class="dv-title">' + inner + '</h1>';
    if (kind === 'subtitle') return '<p class="dv-subtitle">' + inner + '</p>';
    if (kind === 'quote') return '<blockquote><p>' + inner + '</p></blockquote>';
    if (kind === 'pre') return '<pre>' + inner.replace(/<br>/g, '\n') + '</pre>';
    if (kind === 'caption') return '<p class="dv-caption">' + inner + '</p>';
    return '<p>' + inner + '</p>';
  }

  async function list(el, depth, level, styleName) {
    const name = attr(el, 'text', 'style-name') || styleName;
    const levels = lists.get(name);
    const kind = (levels && levels.get(level)) || 'bullet';
    const tag = kind === 'number' ? 'ol' : 'ul';
    let s = '<' + tag + '>';
    for (const item of kids(el)) {
      if (!(isEl(item, 'text', 'list-item') || isEl(item, 'text', 'list-header'))) continue;
      let li = '';
      for (const c of kids(item)) {
        if (isEl(c, 'text', 'list')) li += await list(c, depth + 1, level + 1, name);
        else if (c.nodeType === 1) li += await block(c, depth + 1);
      }
      s += '<li>' + li + '</li>';
    }
    return s + '</' + tag + '>';
  }

  async function tableHtml(el, depth) {
    tables++;
    const rows = [];
    const walk = (n) => {
      for (const c of kids(n)) {
        if (isEl(c, 'table', 'table-row')) rows.push(c);
        else if (c.nodeType === 1 && c.namespaceURI === NS.table && /^table-(header-rows|rows|row-group)$/.test(c.localName)) walk(c);
      }
    };
    walk(el);
    let s = '<table>';
    for (const r of rows) {
      s += '<tr>';
      for (const cell of kids(r)) {
        if (!isEl(cell, 'table', 'table-cell')) continue; // covered cells are part of a merged cell
        let a = '';
        const cs = Number(attr(cell, 'table', 'number-columns-spanned')) || 1;
        const rs = Number(attr(cell, 'table', 'number-rows-spanned')) || 1;
        if (cs > 1) a += ' colspan="' + Math.min(cs, 999) + '"';
        if (rs > 1) a += ' rowspan="' + Math.min(rs, 999) + '"';
        const repeat = Math.min(Number(attr(cell, 'table', 'number-columns-repeated')) || 1, 50);
        const inner = await blocks(cell, depth + 1);
        for (let i = 0; i < repeat; i++) s += '<td' + a + '>' + inner + '</td>';
      }
      s += '</tr>';
    }
    return s + '</table>';
  }

  async function block(c, depth) {
    if (depth > MAX_DEPTH) return '';
    if (c.nodeType !== 1) return '';
    const ns = c.namespaceURI;
    const ln = c.localName;
    if (ns === NS.text) {
      if (ln === 'h') {
        const lvl = Math.min(Math.max(Number(attr(c, 'text', 'outline-level')) || 1, 1), 6);
        const inner = await inline(c, depth + 1);
        return inner.trim() ? '<h' + lvl + '>' + inner + '</h' + lvl + '>' : '';
      }
      if (ln === 'p') return paragraph(c, depth);
      if (ln === 'list') return list(c, depth, 1, '');
      if (ln === 'section' || ln === 'index-body' || ln === 'table-of-content' || ln === 'illustration-index' || ln === 'alphabetical-index' || ln === 'bibliography' || ln === 'user-index' || ln === 'object-index' || ln === 'table-index') {
        return blocks(c, depth + 1);
      }
      if (ln === 'tracked-changes' || ln === 'index-title-template' || ln === 'table-of-content-source' || ln === 'sequence-decls' || ln === 'variable-decls' || ln === 'user-field-decls') return '';
      if (ln === 'index-title') return blocks(c, depth + 1);
      return '';
    }
    if (ns === NS.table && ln === 'table') return tableHtml(c, depth);
    if (ns === NS.draw && ln === 'frame') { const f = await frame(c, depth, false); return f && !/^<(p|h|ul|ol|table|blockquote|pre)/.test(f) ? '<p>' + f + '</p>' : f; }
    return '';
  }

  async function blocks(node, depth) {
    let s = '';
    for (const c of kids(node)) s += await block(c, depth);
    return s;
  }

  let html = await blocks(body, 0);
  for (const kind of ['footnote', 'endnote']) {
    const list = notes.filter((n) => n.kind === kind);
    if (!list.length) continue;
    html += '<ol>' + list.map((n) => {
      const num = n.id.split('-').pop();
      const back = ' <a href="#' + kind + '-ref-' + num + '">↑</a>';
      const inner = /<\/p>$/.test(n.html) ? n.html.replace(/<\/p>$/, back + '</p>') : n.html + '<p>' + back + '</p>';
      return '<li id="' + n.id + '">' + inner + '</li>';
    }).join('') + '</ol>';
  }
  return { ok: true, html, warnings, tables, skippedImages: imgStats.skipped };
}

module.exports = { convertOdt, odfKind, NS };
