'use strict';
// Word equations (Office Math, OMML) to MathML for Reading view, plus a linear text form for
// Copy as Markdown, Open as Text and search. Builds MathML from an allowlist: every element name
// comes from this file and every text value is escaped, so nothing from the document becomes markup.

const { DOMParser } = require('@xmldom/xmldom');

const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WRAP_OPEN = '<dv xmlns:m="' + M_NS + '" xmlns:w="' + W_NS + '">';
const MAX_DEPTH = 60;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function kids(el) {
  const out = [];
  for (let c = el && el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) out.push(c);
  return out;
}
function local(el) { return el.localName || String(el.nodeName).replace(/^.*:/, ''); }
function child(el, name) { return kids(el).find((c) => local(c) === name) || null; }
function prop(el, prName, name) {
  const pr = child(el, prName);
  const p = pr && child(pr, name);
  if (!p) return null;
  return p.getAttributeNS(M_NS, 'val') || p.getAttribute('m:val') || '';
}
function textOf(el) {
  let s = '';
  for (const c of kids(el)) {
    const n = local(c);
    if (n === 't') s += c.textContent;
    else if (n === 'tab') s += ' ';
    else if (n === 'br') s += ' ';
  }
  return s;
}

const OPS = /^[+\-=<>±∓×÷·∙∘√∑∏∫∮∂∇≈≠≤≥≡∝∞→←↔⇒⇐⇔∈∉⊂⊃⊆⊇∪∩∧∨¬∀∃,;:!|/()[\]{}⟨⟩‖′″%*^~−…]$/;

// Splits run text into MathML tokens: numbers, operators, identifiers.
function tokens(text, normal, plain) {
  if (normal) return '<mtext>' + esc(text) + '</mtext>';
  let out = '';
  const re = /(\d+(?:[.,]\d+)*)|(\s+)|([A-Za-zͰ-Ͽ℀-⅏]+)|(.)/gu;
  let m;
  while ((m = re.exec(text))) {
    if (m[1]) out += '<mn>' + esc(m[1]) + '</mn>';
    else if (m[2]) out += '<mspace width="0.25em"></mspace>';
    else if (m[3]) {
      // Plain style (function names such as sin or max): one upright identifier. Otherwise one
      // italic identifier per letter, as Word draws variables.
      if (plain) out += '<mi mathvariant="normal">' + esc(m[3]) + '</mi>';
      else for (const ch of m[3]) out += '<mi>' + esc(ch) + '</mi>';
    } else out += OPS.test(m[4]) ? '<mo>' + esc(m[4]) + '</mo>' : '<mi>' + esc(m[4]) + '</mi>';
  }
  return out;
}

function group(parts) {
  const inner = parts.join('');
  return '<mrow>' + inner + '</mrow>';
}

// Returns { ml, lin } for a list of OMML elements.
function seq(els, depth) {
  const ml = [];
  const parts = [];
  for (const el of els) {
    const r = node(el, depth);
    if (r) { ml.push(r.ml); parts.push(r); }
  }
  // A fraction next to a letter, digit or bracket gets brackets in the linear form: f(L/D), not fL/D.
  const lin = parts.map((r, i) => {
    if (!r.frac) return r.lin;
    const prev = i > 0 ? parts[i - 1].lin : '';
    const next = i + 1 < parts.length ? parts[i + 1].lin : '';
    return /[\w)\]]$/u.test(prev) || /^[\w(\[]/u.test(next) ? '(' + r.lin + ')' : r.lin;
  });
  return { ml: group(ml), lin: lin.join('') };
}
function arg(el, name, depth) {
  const c = child(el, name);
  return c ? seq(kids(c), depth + 1) : { ml: '<mrow></mrow>', lin: '' };
}
// Wraps linear text in brackets when it has more than one token.
function paren(s) { return /^(\d+(\.\d+)?|[A-Za-z\u0370-\u03ff])$/u.test(s) || /^\([^()]*\)$/.test(s) ? s : '(' + s + ')'; }

function node(el, depth) {
  if (depth > MAX_DEPTH) return { ml: '<mtext>…</mtext>', lin: '…' };
  const n = local(el);
  switch (n) {
    case 'r': {
      const t = textOf(el);
      if (!t) return null;
      const normal = prop(el, 'rPr', 'nor') !== null;
      const plain = prop(el, 'rPr', 'sty') === 'p';
      return { ml: tokens(t, normal, plain), lin: t };
    }
    case 'f': {
      const num = arg(el, 'num', depth), den = arg(el, 'den', depth);
      const type = prop(el, 'fPr', 'type');
      if (type === 'lin') return { ml: group([num.ml, '<mo>/</mo>', den.ml]), lin: paren(num.lin) + '/' + paren(den.lin), frac: true };
      const attrs = type === 'noBar' ? ' linethickness="0"' : '';
      return { ml: '<mfrac' + attrs + '>' + num.ml + den.ml + '</mfrac>', lin: paren(num.lin) + '/' + paren(den.lin), frac: true };
    }
    case 'sSup': { const e = arg(el, 'e', depth), s = arg(el, 'sup', depth); return { ml: '<msup>' + e.ml + s.ml + '</msup>', lin: e.lin + '^' + paren(s.lin) }; }
    case 'sSub': { const e = arg(el, 'e', depth), s = arg(el, 'sub', depth); return { ml: '<msub>' + e.ml + s.ml + '</msub>', lin: e.lin + '_' + paren(s.lin) }; }
    case 'sSubSup': {
      const e = arg(el, 'e', depth), b = arg(el, 'sub', depth), s = arg(el, 'sup', depth);
      return { ml: '<msubsup>' + e.ml + b.ml + s.ml + '</msubsup>', lin: e.lin + '_' + paren(b.lin) + '^' + paren(s.lin) };
    }
    case 'sPre': {
      const e = arg(el, 'e', depth), b = arg(el, 'sub', depth), s = arg(el, 'sup', depth);
      return { ml: '<mmultiscripts>' + e.ml + '<mprescripts></mprescripts>' + b.ml + s.ml + '</mmultiscripts>', lin: '_' + paren(b.lin) + '^' + paren(s.lin) + e.lin };
    }
    case 'rad': {
      const e = arg(el, 'e', depth), d = arg(el, 'deg', depth);
      const hide = prop(el, 'radPr', 'degHide');
      if (!d.lin || hide === '1' || hide === 'on' || hide === 'true') return { ml: '<msqrt>' + e.ml + '</msqrt>', lin: '√' + paren(e.lin) };
      return { ml: '<mroot>' + e.ml + d.ml + '</mroot>', lin: '√[' + d.lin + ']' + paren(e.lin) };
    }
    case 'nary': {
      const chr = prop(el, 'naryPr', 'chr') || '∫';
      const loc = prop(el, 'naryPr', 'limLoc');
      const subHide = /^(1|on|true)$/.test(prop(el, 'naryPr', 'subHide') || '');
      const supHide = /^(1|on|true)$/.test(prop(el, 'naryPr', 'supHide') || '');
      const b = subHide ? null : arg(el, 'sub', depth), s = supHide ? null : arg(el, 'sup', depth), e = arg(el, 'e', depth);
      const op = '<mo largeop="true">' + esc(chr) + '</mo>';
      const under = loc === 'undOvr' || (!loc && chr !== '∫' && chr !== '∮');
      let ml;
      if (b && s) ml = (under ? '<munderover>' : '<msubsup>') + op + b.ml + s.ml + (under ? '</munderover>' : '</msubsup>');
      else if (b) ml = (under ? '<munder>' : '<msub>') + op + b.ml + (under ? '</munder>' : '</msub>');
      else if (s) ml = (under ? '<mover>' : '<msup>') + op + s.ml + (under ? '</mover>' : '</msup>');
      else ml = op;
      return { ml: group([ml, e.ml]), lin: chr + (b ? '_' + paren(b.lin) : '') + (s ? '^' + paren(s.lin) : '') + ' ' + e.lin };
    }
    case 'd': {
      const pr = child(el, 'dPr');
      const get = (k, d) => { const v = pr && child(pr, k); if (!v) return d; return v.getAttributeNS(M_NS, 'val') || v.getAttribute('m:val') || ''; };
      const beg = get('begChr', '('), end = get('endChr', ')'), sep = get('sepChr', '|');
      const es = kids(el).filter((c) => local(c) === 'e').map((c) => seq(kids(c), depth + 1));
      const ml = [];
      es.forEach((e, i) => { if (i) ml.push('<mo>' + esc(sep) + '</mo>'); ml.push(e.ml); });
      return {
        ml: group([beg ? '<mo fence="true" stretchy="true">' + esc(beg) + '</mo>' : '', ...ml, end ? '<mo fence="true" stretchy="true">' + esc(end) + '</mo>' : '']),
        lin: beg + es.map((e) => e.lin).join(sep) + end
      };
    }
    case 'func': { const f = arg(el, 'fName', depth), e = arg(el, 'e', depth); return { ml: group([f.ml, '<mo>&#x2061;</mo>', e.ml]), lin: f.lin + ' ' + paren(e.lin) }; }
    case 'limLow': { const e = arg(el, 'e', depth), l = arg(el, 'lim', depth); return { ml: '<munder>' + e.ml + l.ml + '</munder>', lin: e.lin + '_' + paren(l.lin) }; }
    case 'limUpp': { const e = arg(el, 'e', depth), l = arg(el, 'lim', depth); return { ml: '<mover>' + e.ml + l.ml + '</mover>', lin: e.lin + '^' + paren(l.lin) }; }
    case 'acc': {
      const chr = prop(el, 'accPr', 'chr') || '̂';
      const e = arg(el, 'e', depth);
      return { ml: '<mover accent="true">' + e.ml + '<mo>' + esc(chr) + '</mo></mover>', lin: e.lin + chr };
    }
    case 'bar': {
      const e = arg(el, 'e', depth);
      const bottom = prop(el, 'barPr', 'pos') === 'bot';
      return { ml: bottom ? '<munder>' + e.ml + '<mo>_</mo></munder>' : '<mover>' + e.ml + '<mo>¯</mo></mover>', lin: e.lin };
    }
    case 'groupChr': {
      const chr = prop(el, 'groupChrPr', 'chr') || '⏟';
      const top = prop(el, 'groupChrPr', 'pos') === 'top';
      const e = arg(el, 'e', depth);
      return { ml: top ? '<mover>' + e.ml + '<mo>' + esc(chr) + '</mo></mover>' : '<munder>' + e.ml + '<mo>' + esc(chr) + '</mo></munder>', lin: e.lin };
    }
    case 'box': case 'borderBox': case 'phant': case 'e': case 'oMath':
      return seq(kids(el).filter((c) => !/Pr$/.test(local(c))), depth + 1);
    case 'eqArr': {
      const rows = kids(el).filter((c) => local(c) === 'e').map((c) => seq(kids(c), depth + 1));
      return { ml: '<mtable>' + rows.map((r) => '<mtr><mtd>' + r.ml + '</mtd></mtr>').join('') + '</mtable>', lin: rows.map((r) => r.lin).join('; ') };
    }
    case 'm': {
      const rows = kids(el).filter((c) => local(c) === 'mr').map((mr) => kids(mr).filter((c) => local(c) === 'e').map((c) => seq(kids(c), depth + 1)));
      return {
        ml: '<mtable>' + rows.map((r) => '<mtr>' + r.map((c) => '<mtd>' + c.ml + '</mtd>').join('') + '</mtr>').join('') + '</mtable>',
        lin: '[' + rows.map((r) => r.map((c) => c.lin).join(', ')).join('; ') + ']'
      };
    }
    default: {
      // Word text runs inside an equation, and anything unknown: keep the text.
      if (el.namespaceURI === W_NS && n === 'r') {
        const t = Array.from(el.getElementsByTagNameNS(W_NS, 't')).map((x) => x.textContent).join('');
        return t ? { ml: '<mtext>' + esc(t) + '</mtext>', lin: t } : null;
      }
      if (/Pr$/.test(n)) return null;
      const r = seq(kids(el), depth + 1);
      return r.lin ? r : null;
    }
  }
}

// xml: one <m:oMathPara> or <m:oMath> element as text (namespace prefixes m: and w:).
// Returns { mathml, linear, display } or null when the equation cannot be read.
function ommlToMathml(xml) {
  let doc;
  try {
    const errors = [];
    // xmldom 0.8 takes errorHandler; newer versions take onError.
    const fail = () => errors.push(1);
    doc = new DOMParser({ errorHandler: { warning() {}, error: fail, fatalError: fail }, onError: (level) => { if (level !== 'warning') fail(); } }).parseFromString(WRAP_OPEN + xml + '</dv>', 'text/xml');
    if (errors.length) return null;
  } catch (_) {
    return null;
  }
  const top = kids(doc.documentElement)[0];
  if (!top) return null;
  const display = local(top) === 'oMathPara';
  const maths = display ? kids(top).filter((c) => local(c) === 'oMath') : [top];
  const parts = maths.map((m) => seq(kids(m), 0));
  if (!parts.length) return null;
  const linear = parts.map((p) => p.lin).join('  ').replace(/\s+/g, ' ').trim();
  const body = parts.length > 1 ? '<mtable>' + parts.map((p) => '<mtr><mtd>' + p.ml + '</mtd></mtr>').join('') + '</mtable>' : parts[0].ml;
  const mathml = '<math xmlns="http://www.w3.org/1998/Math/MathML" class="dv-math"' + (display ? ' display="block"' : '') + ' aria-label="' + esc(linear.slice(0, 500)) + '">' + body + '</math>';
  return { mathml, linear, display };
}

module.exports = { ommlToMathml };
