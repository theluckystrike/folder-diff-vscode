'use strict';
// Rich Text Format as text, for .doc files that are really RTF (many sites and older tools save RTF
// under a .doc name). Paragraphs stay paragraphs and table rows become tables (src/doc.js textToHtml).
// Pictures, objects, fonts, styles and other side groups are skipped. No dependencies.

const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable', 'revtbl', 'rsidtbl',
  'generator', 'xmlnstbl', 'datastore', 'themedata', 'colorschememapping', 'latentstyles', 'pgdsctbl', 'fldinst',
  'bkmkstart', 'bkmkend', 'nonesttables', 'nonshppict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl',
  'footerr', 'footerf', 'footnote', 'annotation', 'atnid', 'atnauthor', 'xe', 'tc', 'filetbl', 'mmathPr', 'listtext',
  'pntext', 'pntxta', 'pntxtb', 'userprops', 'docvar', 'wgrffmtfilter', 'fchars', 'lchars', 'operator', 'company',
  'title', 'subject', 'author', 'keywords', 'comment', 'doccomm', 'falt', 'panose', 'blipuid', 'sp', 'sn', 'sv', 'template'
]);
const SYMBOLS = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ', qmspace: ' ' };
const MAX_CHARS = 20 * 1024 * 1024;

function decoderFor(cpg) {
  try { return new TextDecoder(cpg === 65001 ? 'utf-8' : 'windows-' + cpg); } catch (_) { /* fall through */ }
  try { return new TextDecoder('windows-1252'); } catch (_) { return null; }
}

// Returns plain text: '\n' between paragraphs, table rows as "cell\tcell\t\n".
function rtfToText(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const s = src.toString('latin1');
  if (!/^\s*\{\\rtf/.test(s.slice(0, 64))) throw new Error('not an RTF file');
  const cpgMatch = /\\ansicpg(\d+)/.exec(s.slice(0, 4096));
  let decoder = decoderFor(cpgMatch ? Number(cpgMatch[1]) : 1252);
  let out = '';
  let bytes = []; // \'hh bytes waiting for the code page decoder
  const flushBytes = () => {
    if (!bytes.length) return;
    out += decoder ? decoder.decode(Uint8Array.from(bytes)) : String.fromCharCode.apply(null, bytes);
    bytes = [];
  };
  const emit = (t) => { flushBytes(); out += t; };
  const stack = [];
  let st = { skip: false, uc: 1, intbl: false };
  let skipChars = 0; // fallback characters after \uN
  let i = 0;
  const n = s.length;
  while (i < n && out.length < MAX_CHARS) {
    const ch = s[i];
    if (ch === '{') {
      stack.push(st);
      st = Object.assign({}, st);
      i++;
      // A group that starts with \* is an optional destination we do not know: skip it.
      if (s.startsWith('\\*', i)) st.skip = true;
      continue;
    }
    if (ch === '}') {
      st = stack.pop() || st;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) break;
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(s[j])) j++;
        const word = s.slice(i + 1, j);
        let numStr = '';
        if (s[j] === '-' || /[0-9]/.test(s[j] || '')) {
          let k = j + (s[j] === '-' ? 1 : 0);
          while (k < n && /[0-9]/.test(s[k])) k++;
          numStr = s.slice(j, k);
          j = k;
        }
        if (s[j] === ' ') j++;
        i = j;
        const num = numStr ? Number(numStr) : null;
        if (word === 'bin' && num > 0) { i += num; continue; }
        if (SKIP.has(word)) { st.skip = true; continue; }
        if (st.skip) continue;
        if (skipChars > 0 && word !== 'u') { skipChars--; continue; }
        switch (word) {
          case 'ansicpg': decoder = decoderFor(num); break;
          case 'uc': st.uc = num === null ? 1 : num; break;
          case 'u': {
            let code = num || 0;
            if (code < 0) code += 65536;
            emit(String.fromCharCode(code));
            skipChars = st.uc;
            break;
          }
          case 'par': case 'sect': case 'page': case 'line':
            emit(st.intbl && word === 'par' ? ' ' : '\n');
            break;
          case 'intbl': st.intbl = true; break;
          case 'pard': st.intbl = false; break;
          case 'tab': emit('\t'); break;
          case 'cell': case 'nestcell': emit('\t'); break;
          case 'row': case 'nestrow': emit('\n'); st.intbl = false; break;
          default:
            if (SYMBOLS[word]) emit(SYMBOLS[word]);
        }
        continue;
      }
      // Control symbols.
      i += 2;
      if (next === "'") {
        const hex = s.slice(i, i + 2);
        i += 2;
        if (st.skip) continue;
        if (skipChars > 0) { skipChars--; continue; }
        const b = parseInt(hex, 16);
        if (Number.isFinite(b)) bytes.push(b);
        continue;
      }
      if (st.skip) continue;
      if (next === '*') { st.skip = true; continue; }
      if (skipChars > 0) { skipChars--; continue; }
      if (next === '~') emit(' ');
      else if (next === '_') emit('‑');
      else if (next === '\\' || next === '{' || next === '}') emit(next);
      else if (next === '\n' || next === '\r') emit('\n');
      continue;
    }
    i++;
    if (ch === '\r' || ch === '\n') continue;
    if (st.skip) continue;
    if (skipChars > 0) { skipChars--; continue; }
    emit(ch);
  }
  flushBytes();
  return out;
}

// Many RTF exports line up columns with tabs instead of a real table. Two or more lines in a row
// with at least two tabs each become table rows (textToHtml reads a line that ends in a tab as a row).
function tabBlocksToRows(text) {
  const lines = String(text).split('\n');
  const tabby = lines.map((l) => (l.match(/\t/g) || []).length >= 2 && !/\t$/.test(l) && l.trim() !== '');
  return lines.map((l, i) => (tabby[i] && (tabby[i - 1] || tabby[i + 1]) ? l + '\t' : l)).join('\n');
}

module.exports = { rtfToText, tabBlocksToRows };
