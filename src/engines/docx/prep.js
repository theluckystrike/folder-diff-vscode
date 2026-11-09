'use strict';
// Rewrites WordprocessingML before mammoth reads it, for content mammoth leaves out:
//   - w:fldSimple (figure and table numbers, page numbers, dates): mammoth drops the element and
//     its stored result, so "Figure 3." became "Figure ." The element is unwrapped to its runs.
//   - Equations (m:oMathPara, m:oMath) and charts (w:drawing with a c:chart): each one becomes a
//     marker text run. After sanitizing, src/html.js swaps every marker for MathML or an SVG chart
//     built by src/omml.js and src/chart.js.
// Markers use private-use characters and a random tag per conversion, so document text cannot
// imitate them.

const { hex } = require('./rand');
const { ommlToMathml } = require('./omml');
const { renderChart } = require('./chart');

const MAX_ITEMS = 2000;
const FLD_SIMPLE = /<w:fldSimple\b/;
const MATH = /<m:oMath[\s>]/;
const CHART = /drawingml\/2006\/chart"/;

function needsPrep(xml) {
  return FLD_SIMPLE.test(xml) || MATH.test(xml) || CHART.test(xml);
}

function unwrapFldSimple(xml) {
  if (!FLD_SIMPLE.test(xml)) return xml;
  return xml.replace(/<w:fldSimple\b[^>]*\/>/g, '').replace(/<w:fldSimple\b[^>]*>/g, '').replace(/<\/w:fldSimple>/g, '');
}

// Relationship id -> target path inside the package, from word/_rels/document.xml.rels.
function parseRels(relsXml) {
  const out = {};
  const re = /<Relationship\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(relsXml || ''))) {
    const id = /\bId="([^"]+)"/.exec(m[1]);
    const target = /\bTarget="([^"]+)"/.exec(m[1]);
    const mode = /\bTargetMode="External"/.test(m[1]);
    if (id && target && !mode) out[id[1]] = target[1];
  }
  return out;
}
function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ('word/' + target).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

// documentXml: word/document.xml text. readPart(path) -> Promise<string|null>.
// Returns { xml, items: { [marker]: { kind, html, inlineHtml, markdown, text, block } }, tag, counts }.
async function prepare(documentXml, readPart, relsXml) {
  const tag = hex(4);
  const items = {};
  const counts = { equations: 0, charts: 0, fields: 0 };
  let n = 0;
  const marker = () => '' + tag + ':' + (n++) + '';
  const run = (mk) => '<w:r><w:t xml:space="preserve">' + mk + '</w:t></w:r>';

  let xml = documentXml;
  if (FLD_SIMPLE.test(xml)) {
    counts.fields = (xml.match(/<w:fldSimple\b/g) || []).length;
    xml = unwrapFldSimple(xml);
  }

  if (MATH.test(xml)) {
    const one = (frag) => {
      if (n >= MAX_ITEMS) return frag;
      const r = ommlToMathml(frag);
      if (!r) return frag;
      const mk = marker();
      counts.equations++;
      items[mk] = { kind: 'math', html: r.mathml, inlineHtml: r.mathml, markdown: r.linear, text: r.linear, block: r.display };
      return run(mk);
    };
    xml = xml.replace(/<m:oMathPara\b[^>]*>[\s\S]*?<\/m:oMathPara>/g, one);
    xml = xml.replace(/<m:oMath\b(?![A-Za-z])[^>]*>[\s\S]*?<\/m:oMath>/g, one);
  }

  if (CHART.test(xml)) {
    const rels = parseRels(relsXml);
    const jobs = [];
    xml = xml.replace(/<w:drawing\b[^>]*>[\s\S]*?<\/w:drawing>/g, (frag) => {
      if (!CHART.test(frag) || n >= MAX_ITEMS) return frag;
      const id = /<c:chart\b[^>]*\br:id="([^"]+)"/.exec(frag);
      const target = id && rels[id[1]];
      if (!target) return frag;
      const mk = marker();
      jobs.push({ mk, part: resolveTarget(target), frag });
      return '' + mk + '';
    });
    for (const job of jobs) {
      let r = null;
      try {
        const part = await readPart(job.part);
        r = part ? renderChart(part) : null;
      } catch (_) {
        r = null;
      }
      const slot = '' + job.mk + '';
      if (!r) { xml = xml.replace(slot, () => job.frag); continue; }
      counts.charts++;
      const inline = r.html.replace(/<figcaption>[\s\S]*?<\/figcaption>|<details[\s\S]*<\/details>/g, '').replace(/^<figure class="dv-chart">/, '<span class="dv-chart dv-chart-inline">').replace(/<\/figure>$/, '</span>');
      items[job.mk] = { kind: 'chart', html: r.html, inlineHtml: inline, markdown: r.markdown, text: r.text, block: true };
      xml = xml.replace(slot, () => '<w:t xml:space="preserve">' + job.mk + '</w:t>');
    }
  }
  return { xml, items, tag, counts };
}

module.exports = { prepare, needsPrep, unwrapFldSimple, parseRels, resolveTarget };
