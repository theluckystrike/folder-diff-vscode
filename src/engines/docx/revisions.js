'use strict';
// Tracked changes and comments, read-only. Final view is the untouched file (mammoth already shows
// a document as if every change were accepted). Markup and Original views rewrite the WordprocessingML
// before mammoth reads it:
//   Markup:   every run inside w:ins / w:moveTo gets a character style ZovoIns<author>_<change>, every
//             run inside w:del / w:moveFrom gets ZovoDel<author>_<change> with its w:delText turned
//             back into w:t. The style map turns them into <ins>/<del> with one class per author and
//             one per change, so the webview can show who made each change and when.
//   Original: w:ins / w:moveTo content is dropped and w:del / w:moveFrom content is restored.
// Paragraph-mark, formatting and table-row changes show as Final (see README, Limits).

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MODES = ['markup', 'final', 'original'];
const AUTHOR_CLASSES = 8;
const QUICK = /<w:(ins|del|moveFrom|moveTo)[\s>]/;
const CHANGE_TAGS = { ins: 'ins', moveTo: 'ins', del: 'del', moveFrom: 'del' };

// Cheap check on the raw XML string: is there anything for the Markup view to show?
function hasChanges(documentXml) {
  return QUICK.test(documentXml || '');
}

function parseXml(xml) {
  return new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} }, onError: () => {} }).parseFromString(xml, 'text/xml');
}

// Run-level change elements in document order. w:ins / w:del inside w:rPr mark a changed paragraph
// mark or run property, not changed text, so they are left alone.
function changeElements(doc) {
  const out = [];
  const walk = (node) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (c.namespaceURI === W && CHANGE_TAGS[c.localName] && !(c.parentNode && c.parentNode.localName === 'rPr')) out.push(c);
      walk(c);
    }
  };
  walk(doc);
  return out;
}

function descendants(el, localName) {
  return Array.from(el.getElementsByTagNameNS(W, localName));
}

function unwrap(el) {
  const parent = el.parentNode;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function rename(doc, el, localName) {
  const n = doc.createElementNS(W, 'w:' + localName);
  for (let i = 0; i < el.attributes.length; i++) n.setAttributeNode(el.attributes[i].cloneNode(true));
  while (el.firstChild) n.appendChild(el.firstChild);
  el.parentNode.replaceChild(n, el);
  return n;
}

// Turns deleted text back into normal text inside el.
function restoreDeleted(doc, el) {
  descendants(el, 'delText').forEach((t) => rename(doc, t, 't'));
  descendants(el, 'delInstrText').forEach((t) => rename(doc, t, 'instrText'));
}

function setRunStyle(doc, run, styleId) {
  let rPr = null;
  for (let c = run.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.localName === 'rPr') { rPr = c; break; }
  if (!rPr) { rPr = doc.createElementNS(W, 'w:rPr'); run.insertBefore(rPr, run.firstChild); }
  descendants(rPr, 'rStyle').forEach((s) => s.parentNode.removeChild(s));
  const rs = doc.createElementNS(W, 'w:rStyle');
  rs.setAttributeNS(W, 'w:val', styleId);
  rPr.insertBefore(rs, rPr.firstChild);
}

function attr(el, name) {
  return el.getAttributeNS(W, name) || el.getAttribute('w:' + name) || '';
}

// Authors in order of first appearance, numbered 1..8 (wrapping after 8).
function authorIndex(authors, name) {
  let i = authors.indexOf(name);
  if (i === -1) { authors.push(name); i = authors.length - 1; }
  return (i % AUTHOR_CLASSES) + 1;
}

// Summary for the bar: counts and people. comments: number of w:comment elements.
function summarize(documentXml, commentsXml) {
  const summary = { changes: 0, authors: [], comments: 0 };
  if (hasChanges(documentXml)) {
    const doc = parseXml(documentXml);
    for (const el of changeElements(doc)) {
      summary.changes++;
      authorIndex(summary.authors, attr(el, 'author') || 'Unknown author');
    }
  }
  if (commentsXml) summary.comments = (commentsXml.match(/<w:comment[\s>]/g) || []).length;
  return summary;
}

// Comment authors and dates by comment id, for the Comments section.
function commentInfo(commentsXml) {
  const info = {};
  if (!commentsXml) return info;
  const doc = parseXml(commentsXml);
  for (const c of descendants(doc, 'comment')) {
    info[attr(c, 'id')] = { author: attr(c, 'author') || 'Unknown author', date: (attr(c, 'date') || '').slice(0, 10) };
  }
  return info;
}

// Rewrites document.xml and styles.xml for Markup or Original. Returns
// { documentXml, stylesXml, styleMap, table } where table maps 'c<N>' to { author, date, kind }.
function rewrite(documentXml, stylesXml, mode) {
  const doc = parseXml(documentXml);
  const els = changeElements(doc);
  const authors = [];
  const table = {};
  const styles = [];
  const styleMap = [];
  els.forEach((el, i) => {
    const kind = el.localName;
    const deleted = CHANGE_TAGS[kind] === 'del';
    if (mode === 'original') {
      if (deleted) { restoreDeleted(doc, el); unwrap(el); } else if (el.parentNode) el.parentNode.removeChild(el);
      return;
    }
    const author = attr(el, 'author') || 'Unknown author';
    const n = authorIndex(authors, author);
    const id = 'c' + i;
    table[id] = { author, date: (attr(el, 'date') || '').slice(0, 10), kind };
    const styleId = (deleted ? 'ZovoDel' : 'ZovoIns') + n + '_' + i;
    styles.push(styleId);
    styleMap.push("r[style-name='" + styleId + "'] => " + CHANGE_TAGS[kind] + '.dv-' + CHANGE_TAGS[kind] + '.dv-a' + n + '.dv-' + id + ':fresh');
    if (deleted) restoreDeleted(doc, el);
    descendants(el, 'r').forEach((r) => setRunStyle(doc, r, styleId));
  });
  // Unwrap after styling, innermost first, so nested changes keep their own style.
  if (mode !== 'original') els.slice().reverse().forEach((el) => { if (el.parentNode) unwrap(el); });
  let outStyles = stylesXml;
  if (styles.length && stylesXml) {
    const defs = styles.map((s) => '<w:style w:type="character" w:customStyle="1" w:styleId="' + s + '"><w:name w:val="' + s + '"/></w:style>').join('');
    outStyles = stylesXml.replace(/<\/w:styles>\s*$/, defs + '</w:styles>');
  }
  return { documentXml: new XMLSerializer().serializeToString(doc), stylesXml: outStyles, styleMap, table, authors };
}

// Bar text, for example "2 changes by 2 people · 1 comment".
function label(summary) {
  const parts = [];
  if (summary.changes) {
    const people = summary.authors.length;
    parts.push(summary.changes + (summary.changes === 1 ? ' change' : ' changes') + ' by ' + people + (people === 1 ? ' person' : ' people'));
  }
  if (summary.comments) parts.push(summary.comments + (summary.comments === 1 ? ' comment' : ' comments'));
  return parts.join(' · ');
}

module.exports = { MODES, hasChanges, summarize, commentInfo, rewrite, label, AUTHOR_CLASSES };
