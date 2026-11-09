'use strict';
// Parses the HTML that mammoth writes, rebuilds it from an allowlist with every
// text and attribute value escaped again, and derives the outline, Markdown and
// plain text from the same tree. Pure functions, no vscode import.

const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr']);
const ALLOWED = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sup', 'sub',
  'a', 'img', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'span', 'div', 'colgroup', 'col', 'caption', 'small',
  'ins', 'dl', 'dt', 'dd'
]);
// Tags whose content is dropped together with the tag.
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'textarea', 'title', 'head']);
const ALLOWED_CLASSES = new Set(['dv-title', 'dv-subtitle', 'dv-caption', 'dv-ins', 'dv-del', 'dv-comments-title']);
// Tracked changes: one class per author (1-8) and one per change (see src/revisions.js).
const ALLOWED_CLASS_RE = /^dv-(a[1-8]|c[0-9]{1,6})$/;
const IMG_SRC = /^data:image\/(png|jpe?g|gif|bmp|webp);base64,[A-Za-z0-9+/=\s]+$/i;
// Images that travel next to the HTML as bytes (src/convert.js) and become blob: URLs in the webview.
const IMG_REF = /^dv-img:([0-9]{1,6})$/;
const EXTERNAL_HREF = /^(https?:\/\/|mailto:)/i;

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e === 'nbsp') return ' ';
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseAttrs(src) {
  const attrs = {};
  if (!src) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(name in attrs)) attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

// Builds a tree: { type: 'root'|'el'|'text', tag, attrs, children, text }.
// Unclosed tags close at the end; stray close tags are ignored.
function parse(html) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let dropDepth = 0;
  let dropTag = null;
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  const pushText = (raw) => {
    if (!raw || dropDepth) return;
    stack[stack.length - 1].children.push({ type: 'text', text: decodeEntities(raw) });
  };
  while ((m = TAG_RE.exec(html))) {
    pushText(html.slice(last, m.index));
    last = TAG_RE.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (dropDepth) {
      if (tag === dropTag) dropDepth += closing ? -1 : (m[4] ? 0 : 1);
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && !m[4]) { dropDepth = 1; dropTag = tag; }
      continue;
    }
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const node = { type: 'el', tag, attrs: parseAttrs(m[3]), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  pushText(html.slice(last));
  return root;
}

function textOf(node) {
  if (node.type === 'text') return node.text;
  if (node.type === 'raw') return node.text;
  let s = '';
  for (const c of node.children || []) s += textOf(c);
  return s;
}

function safeId(id) {
  const clean = String(id).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
  return clean ? 'd-' + clean : '';
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

// Returns { tree, outline, footnotes, images, skippedImages }.
function sanitize(rawTree) {
  const outline = [];
  let headingCount = 0;
  let images = 0;
  let skippedImages = 0;
  let footnotes = 0;

  function cleanChildren(children) {
    const out = [];
    for (const c of children) {
      const r = clean(c);
      if (Array.isArray(r)) out.push(...r);
      else if (r) out.push(r);
    }
    return out;
  }

  function clean(node) {
    if (node.type === 'text') return { type: 'text', text: node.text };
    if (!ALLOWED.has(node.tag)) return cleanChildren(node.children);
    const a = node.attrs || {};
    const attrs = {};
    if (a.id) { const id = safeId(a.id); if (id) attrs.id = id; }
    if (a.class) {
      const cls = a.class.split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c) || ALLOWED_CLASS_RE.test(c));
      if (cls.length) attrs.class = cls.join(' ');
    }
    if (node.tag === 'a') {
      const href = (a.href || '').trim();
      if (href.startsWith('#') && href.length > 1) attrs.href = '#' + safeId(href.slice(1));
      else if (EXTERNAL_HREF.test(href)) attrs.href = href;
    }
    if (node.tag === 'td' || node.tag === 'th') {
      for (const k of ['colspan', 'rowspan']) if (/^[1-9][0-9]{0,2}$/.test(a[k] || '')) attrs[k] = a[k];
    }
    if (node.tag === 'ol' && /^-?[0-9]{1,6}$/.test(a.start || '')) attrs.start = a.start;
    if (node.tag === 'img') {
      const src = a.src || '';
      const alt = (a.alt || '').slice(0, 500);
      const ref = IMG_REF.exec(src);
      if (ref && !a['data-dv-skipped']) {
        images++;
        return { type: 'el', tag: 'img', attrs: { 'data-dv-img': ref[1], alt }, children: [] };
      }
      if (a['data-dv-skipped'] || !IMG_SRC.test(src)) {
        skippedImages++;
        const why = a['data-dv-skipped'] || 'this image format cannot be shown';
        return { type: 'el', tag: 'span', attrs: { class: 'dv-img-skipped' }, children: [{ type: 'text', text: '[Image' + (alt ? ' "' + alt + '"' : '') + ' not shown: ' + why + ']' }] };
      }
      images++;
      return { type: 'el', tag: 'img', attrs: { src: src.replace(/\s+/g, ''), alt }, children: [] };
    }
    const out = { type: 'el', tag: node.tag, attrs, children: cleanChildren(node.children) };
    if (/^h[1-6]$/.test(node.tag)) {
      headingCount++;
      out.attrs.id = 'h-' + headingCount;
      const text = textOf(out).replace(/\s+/g, ' ').trim();
      if (text) outline.push({ level: Number(node.tag[1]), text: text.slice(0, 200), id: out.attrs.id });
    }
    if (node.tag === 'ol' && out.children.some((li) => li.tag === 'li' && /^d-(foot|end)note-/.test(li.attrs.id || ''))) {
      out.attrs.class = 'dv-footnotes';
      footnotes += out.children.filter((li) => li.tag === 'li').length;
    }
    return out;
  }

  const tree = { type: 'root', children: cleanChildren(rawTree.children) };
  return { tree, outline, footnotes, images, skippedImages };
}

function renderNode(node) {
  if (node.type === 'text') return escapeText(node.text);
  if (node.type === 'raw') return node.html;
  if (node.type === 'root') return node.children.map(renderNode).join('');
  let s = '<' + node.tag;
  for (const k of Object.keys(node.attrs)) s += ' ' + k + '="' + escapeAttr(node.attrs[k]) + '"';
  if (VOID.has(node.tag)) return s + '>';
  return s + '>' + node.children.map(renderNode).join('') + '</' + node.tag + '>';
}

// Groups top-level blocks into HTML strings of about maxChars each, so the
// webview can paint the first screen before the rest arrives.
function chunkBlocks(tree, maxChars) {
  const limit = Math.max(1000, maxChars || 200000);
  const chunks = [];
  let cur = '';
  for (const block of tree.children) {
    const html = renderNode(block);
    if (cur && cur.length + html.length > limit) { chunks.push(cur); cur = ''; }
    cur += html;
  }
  if (cur || chunks.length === 0) chunks.push(cur);
  return chunks;
}

// ---------- Markdown ----------

function mdEscape(s) {
  return s.replace(/([\\`*_\[\]<>])/g, '\\$1');
}

function isFootnoteRef(node) {
  return node.tag === 'a' && /^#d-(foot|end)note-/.test(node.attrs.href || '') && /^d-(foot|end)note-ref-/.test(node.attrs.id || '');
}

function footnoteLabel(href) {
  const m = /^#d-(foot|end)note-(.+)$/.exec(href || '');
  return m ? (m[1] === 'end' ? 'e' : '') + m[2].replace(/[^A-Za-z0-9_-]/g, '') : '';
}

function inlineMd(nodes, ctx) {
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text') { s += mdEscape(n.text.replace(/\s+/g, ' ')); continue; }
    if (n.type === 'raw') { s += n.kind === 'math' ? mdEscape(n.markdown) : ' ' + mdEscape(n.text.split('\n')[0]) + ' '; continue; }
    const inner = () => inlineMd(n.children, ctx);
    switch (n.tag) {
      case 'strong': case 'b': { const t = inner(); s += t.trim() ? '**' + t + '**' : t; break; }
      case 'em': case 'i': { const t = inner(); s += t.trim() ? '*' + t + '*' : t; break; }
      case 's': case 'del': { const t = inner(); s += t.trim() ? '~~' + t + '~~' : t; break; }
      case 'code': s += '`' + textOf(n).replace(/`/g, "'") + '`'; break;
      case 'br': s += ctx.inTable ? '<br>' : '  \n'; break;
      case 'img': ctx.imageCount++; s += '![' + mdEscape(n.attrs.alt || '') + '](#image-' + ctx.imageCount + ')'; break;
      case 'a': {
        if (isFootnoteRef(n)) { s += '[^' + footnoteLabel(n.attrs.href) + ']'; break; }
        const href = n.attrs.href || '';
        if (/^#d-(foot|end)note-ref-/.test(href)) break; // back link inside a footnote
        const t = inner();
        s += EXTERNAL_HREF.test(href) ? '[' + t + '](' + href.replace(/[()\s]/g, encodeURIComponent) + ')' : t;
        break;
      }
      case 'sup': {
        const only = n.children.length === 1 && n.children[0].type === 'el' ? n.children[0] : null;
        if (only && (only.tag === 'sup' || isFootnoteRef(only))) { s += inner(); break; }
        s += inner();
        break;
      }
      default:
        if (BLOCK_TAGS.has(n.tag)) s += ' ' + inner() + ' ';
        else s += inner();
    }
  }
  return s;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'blockquote', 'pre', 'div', 'hr', 'thead', 'tbody', 'tfoot', 'caption']);

function tidy(s) {
  return s.replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n')).replace(/ {2,}(?!\n)/g, ' ').trim();
}

function tableRows(table) {
  const rows = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.type !== 'el') continue;
      if (c.tag === 'tr') rows.push(c);
      else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') walk(c);
    }
  };
  walk(table);
  return rows;
}

function tableMd(table, ctx) {
  const rows = tableRows(table).map((tr) => {
    const cells = [];
    for (const td of tr.children) {
      if (td.type !== 'el' || (td.tag !== 'td' && td.tag !== 'th')) continue;
      const parts = td.children.map((c) => (c.type === 'el' && BLOCK_TAGS.has(c.tag) ? tidy(inlineMd(c.children, { ...ctx, inTable: true })) : tidy(inlineMd([c], { ...ctx, inTable: true }))));
      cells.push(parts.filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\n/g, ' '));
      const span = Number(td.attrs.colspan || 1);
      for (let k = 1; k < span; k++) cells.push('');
    }
    return cells;
  });
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (r) => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
  const out = [line(rows[0]), '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |'];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join('\n');
}

function listMd(list, ctx, depth) {
  const lines = [];
  let n = Number(list.attrs.start || 1);
  for (const li of list.children) {
    if (li.type !== 'el' || li.tag !== 'li') continue;
    const marker = list.tag === 'ol' ? n++ + '. ' : '- ';
    const pad = '  '.repeat(depth);
    const inline = [];
    const nested = [];
    for (const c of li.children) {
      if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) nested.push(listMd(c, ctx, depth + 1));
      else if (c.type === 'el' && c.tag === 'p') inline.push(tidy(inlineMd(c.children, ctx)));
      else inline.push(tidy(inlineMd([c], ctx)));
    }
    lines.push(pad + marker + inline.filter(Boolean).join(' '));
    lines.push(...nested.filter(Boolean));
  }
  return lines.join('\n');
}

function blocksMd(nodes, ctx) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') { const t = tidy(mdEscape(n.text)); if (t) out.push(t); continue; }
    if (n.type === 'raw') { out.push(n.kind === 'math' ? mdEscape(n.markdown) : n.markdown); continue; }
    if (/^h[1-6]$/.test(n.tag)) { const t = tidy(inlineMd(n.children, ctx)); if (t) out.push('#'.repeat(Number(n.tag[1])) + ' ' + t); continue; }
    switch (n.tag) {
      case 'p': case 'caption': { const t = tidy(inlineMd(n.children, ctx)); if (t) out.push(/^(#|>|-|\+|\d+\.)\s/.test(t) ? '\\' + t : t); break; }
      case 'ul': case 'ol':
        if (n.attrs.class === 'dv-footnotes') out.push(footnotesMd(n, ctx));
        else out.push(listMd(n, ctx, 0));
        break;
      case 'table': out.push(tableMd(n, ctx)); break;
      case 'blockquote': { const t = blocksMd(n.children, ctx); if (t) out.push(t.split('\n').map((l) => '> ' + l).join('\n')); break; }
      case 'pre': out.push('```\n' + textOf(n).replace(/```/g, "'''") + '\n```'); break;
      case 'hr': out.push('---'); break;
      case 'div': { const t = blocksMd(n.children, ctx); if (t) out.push(t); break; }
      default: { const t = tidy(inlineMd([n], ctx)); if (t) out.push(t); }
    }
  }
  return out.filter(Boolean).join('\n\n');
}

function footnotesMd(list, ctx) {
  const lines = [];
  for (const li of list.children) {
    if (li.type !== 'el' || li.tag !== 'li') continue;
    const label = footnoteLabel('#' + (li.attrs.id || ''));
    const body = li.children.map((c) => (c.type === 'el' && c.tag === 'p' ? tidy(inlineMd(c.children, ctx)) : tidy(inlineMd([c], ctx)))).filter(Boolean).join(' ');
    lines.push('[^' + label + ']: ' + body);
  }
  return lines.join('\n');
}

function toMarkdown(tree) {
  const ctx = { imageCount: 0, inTable: false };
  const md = blocksMd(tree.children, ctx);
  return md ? md + '\n' : '';
}

// ---------- Plain text ----------

function inlineText(nodes, ctx) {
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text') { s += n.text.replace(/\s+/g, ' '); continue; }
    if (n.type === 'raw') { s += n.kind === 'math' ? n.text : ' ' + n.text.split('\n')[0] + ' '; continue; }
    if (n.tag === 'br') { s += '\n'; continue; }
    if (n.tag === 'img') { s += '[image' + (n.attrs.alt ? ': ' + n.attrs.alt : '') + ']'; continue; }
    if (n.tag === 'a' && /^#d-(foot|end)note-ref-/.test(n.attrs.href || '')) continue;
    if (n.tag === 'a' && isFootnoteRef(n)) { s += '[' + footnoteLabel(n.attrs.href) + ']'; continue; }
    const t = inlineText(n.children, ctx);
    s += BLOCK_TAGS.has(n.tag) ? ' ' + t + ' ' : t;
  }
  return s;
}

function cleanLine(s) {
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
}

function blocksText(nodes, ctx, depth) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') { const t = cleanLine(n.text); if (t) out.push(t); continue; }
    if (n.type === 'raw') { out.push(n.text); continue; }
    if (n.tag === 'ul' || n.tag === 'ol') {
      const fn = n.attrs.class === 'dv-footnotes';
      if (fn) out.push('Notes');
      let k = Number(n.attrs.start || 1);
      const lines = [];
      for (const li of n.children) {
        if (li.type !== 'el' || li.tag !== 'li') continue;
        const marker = fn ? '[' + footnoteLabel('#' + (li.attrs.id || '')) + '] ' : n.tag === 'ol' ? k++ + '. ' : '- ';
        const inline = [];
        const nested = [];
        for (const c of li.children) {
          if (c.type === 'el' && (c.tag === 'ul' || c.tag === 'ol')) nested.push(blocksText([c], ctx, depth + 1));
          else inline.push(cleanLine(inlineText([c], ctx)));
        }
        lines.push('  '.repeat(depth) + marker + inline.filter(Boolean).join(' '));
        lines.push(...nested.filter(Boolean));
      }
      out.push(lines.join('\n'));
      continue;
    }
    if (n.tag === 'table') {
      out.push(tableRows(n).map((tr) => tr.children.filter((c) => c.type === 'el').map((td) => cleanLine(inlineText(td.children, ctx)).replace(/\s*\n\s*/g, ' ')).join('\t')).join('\n'));
      continue;
    }
    if (n.tag === 'div' || n.tag === 'blockquote') { const t = blocksText(n.children, ctx, depth); if (t) out.push(t); continue; }
    const t = cleanLine(inlineText(n.children || [], ctx));
    if (t) out.push(t);
  }
  return out.filter(Boolean).join('\n\n');
}

function toPlainText(tree) {
  const t = blocksText(tree.children, {}, 0);
  return t ? t + '\n' : '';
}

// ---------- equations and charts ----------

// Swaps the marker runs from src/prep.js for prebuilt MathML or chart markup (raw nodes). A paragraph
// that holds nothing but block items (a display equation, a chart) is replaced by them, so a chart's
// <figure> never sits inside a <p>. Markers with no item (or forged ones) are removed.
function injectItems(tree, items, tag) {
  if (!tag) return { equations: 0, charts: 0 };
  const re = new RegExp('\uE000' + tag + ':[0-9]+\uE001', 'g');
  const counts = { equations: 0, charts: 0 };
  function walk(node) {
    if (!node.children) return;
    const out = [];
    for (const c of node.children) {
      if (c.type === 'text' && c.text.indexOf('\uE000') !== -1) {
        let last = 0;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(c.text))) {
          if (m.index > last) out.push({ type: 'text', text: c.text.slice(last, m.index) });
          const it = items[m[0]];
          if (it) {
            out.push({ type: 'raw', kind: it.kind, html: it.inlineHtml, blockHtml: it.html, markdown: it.markdown, text: it.text, block: it.block });
            if (it.kind === 'math') counts.equations++; else counts.charts++;
          }
          last = re.lastIndex;
        }
        if (last < c.text.length) out.push({ type: 'text', text: c.text.slice(last) });
        continue;
      }
      walk(c);
      out.push(c);
    }
    node.children = out;
    // Hoist: <p> (or a run wrapper) with only block items and spaces.
    const hoisted = [];
    for (const c of node.children) {
      const only = c.type === 'el' && c.tag === 'p' && c.children.length && c.children.every((k) => (k.type === 'raw' && k.block) || (k.type === 'text' && !k.text.trim()));
      if (only) {
        for (const k of c.children) if (k.type === 'raw') hoisted.push(Object.assign({}, k, { html: k.kind === 'chart' ? k.blockHtml : '<p class="dv-eq">' + k.blockHtml + '</p>' }));
      } else hoisted.push(c);
    }
    node.children = hoisted;
  }
  walk(tree);
  return counts;
}

module.exports = {
  injectItems,
  parse, sanitize, renderNode, chunkBlocks, toMarkdown, toPlainText,
  decodeEntities, escapeText, escapeAttr, textOf, formatBytes, safeId
};
