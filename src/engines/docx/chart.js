'use strict';
// Word charts (DrawingML chart parts) for Reading view. Word keeps the last values of every series
// in the chart part (c:numCache / c:strCache), so the chart can be drawn without Excel. Bar, column,
// line, area, pie, doughnut and scatter charts become an inline SVG; every chart also gets its data
// as a table. The SVG is built here from numbers and escaped text only.

const { DOMParser } = require('@xmldom/xmldom');

const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const MAX_SERIES = 12;
const MAX_POINTS = 400;
const SERIES_CLASSES = 8;

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
function path(el, names) {
  let cur = el;
  for (const n of names) { cur = cur && child(cur, n); if (!cur) return null; }
  return cur;
}
function val(el) { return el ? (el.getAttribute('val') || '') : ''; }
function richText(el) {
  if (!el) return '';
  return Array.from(el.getElementsByTagNameNS(A_NS, 't')).map((t) => t.textContent).join('').replace(/\s+/g, ' ').trim();
}

// Points of a c:numCache / c:strCache / c:numLit / c:strLit / c:lvl element: array indexed by c:idx.
function cachePoints(src) {
  if (!src) return [];
  const count = Math.min(MAX_POINTS, Number(val(child(src, 'ptCount'))) || 0);
  const out = new Array(count).fill(null);
  for (const pt of kids(src)) {
    if (local(pt) !== 'pt') continue;
    const i = Number(pt.getAttribute('idx'));
    if (!Number.isInteger(i) || i < 0 || i >= MAX_POINTS) continue;
    const v = child(pt, 'v');
    out[i] = v ? v.textContent : null;
  }
  // Category axes with dates keep Excel serial numbers and a date format code.
  const code = child(src, 'formatCode');
  if (code && /[dmy]/i.test(code.textContent) && !/general/i.test(code.textContent)) {
    for (let i = 0; i < out.length; i++) out[i] = excelDate(out[i]);
  }
  return out;
}
function excelDate(v) {
  const n = Number(v);
  if (v === null || !Number.isFinite(n) || n < 1 || n > 2958465) return v;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  return d.toISOString().slice(0, 10);
}
function refPoints(el) {
  if (!el) return [];
  for (const k of kids(el)) {
    const n = local(k);
    if (n === 'numRef') return cachePoints(child(k, 'numCache'));
    if (n === 'strRef') return cachePoints(child(k, 'strCache'));
    if (n === 'numLit' || n === 'strLit') return cachePoints(k);
    if (n === 'multiLvlStrRef') { const lvl = path(k, ['multiLvlStrCache', 'lvl']); return lvl ? cachePoints(lvl) : []; }
  }
  return [];
}

const KINDS = {
  barChart: 'bar', bar3DChart: 'bar', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area',
  pieChart: 'pie', pie3DChart: 'pie', ofPieChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter', radarChart: 'line',
  stockChart: 'line', bubbleChart: 'scatter', surfaceChart: 'line', surface3DChart: 'line'
};

// Reads a chart part. Returns { title, kind, horizontal, stacked, categories, series: [{ name, values }] } or null.
function parseChart(xml) {
  let doc;
  try {
    doc = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} }, onError: () => {} }).parseFromString(xml, 'text/xml');
  } catch (_) {
    return null;
  }
  const chart = doc && doc.getElementsByTagNameNS(C_NS, 'chart')[0];
  if (!chart) return null;
  const plot = child(chart, 'plotArea');
  if (!plot) return null;
  let title = richText(child(chart, 'title'));
  const groups = kids(plot).filter((k) => KINDS[local(k)]);
  if (!groups.length) return null;
  const first = groups[0];
  const kind = KINDS[local(first)];
  const horizontal = val(child(first, 'barDir')) === 'bar';
  const grouping = val(child(first, 'grouping'));
  const series = [];
  let categories = [];
  for (const g of groups) {
    for (const ser of kids(g).filter((k) => local(k) === 'ser')) {
      if (series.length >= MAX_SERIES) break;
      const name = richText(child(ser, 'tx')) || (refPoints(child(ser, 'tx'))[0] || '') || 'Series ' + (series.length + 1);
      const cats = refPoints(child(ser, 'cat') || child(ser, 'xVal'));
      const vals = refPoints(child(ser, 'val') || child(ser, 'yVal')).map((v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)));
      if (cats.length > categories.length) categories = cats;
      series.push({ name: String(name), values: vals });
    }
  }
  if (!series.length) return null;
  const n = Math.max(categories.length, ...series.map((s) => s.values.length));
  categories = Array.from({ length: n }, (_, i) => (categories[i] === null || categories[i] === undefined ? String(i + 1) : String(categories[i])));
  if (!title && series.length === 1 && (kind === 'pie' || kind === 'doughnut') && child(chart, 'autoTitleDeleted') && val(child(chart, 'autoTitleDeleted')) !== '1') title = series[0].name;
  return { title, kind, horizontal, stacked: grouping === 'stacked' || grouping === 'percentStacked', categories, series };
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e9 || a < 1e-3)) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
}
function niceStep(range) {
  const raw = range / 5;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

const W = 640, H = 320;

function axisSvg(c, min, max, x0, y0, x1, y1) {
  let s = '';
  const step = niceStep(max - min);
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    const y = y1 - ((v - min) / (max - min)) * (y1 - y0);
    s += '<line class="dv-chart-grid" x1="' + x0 + '" x2="' + x1 + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line>';
    s += '<text class="dv-chart-label" x="' + (x0 - 6) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(fmt(Math.round(v / step) * step)) + '</text>';
  }
  return s;
}

function range(c) {
  let min = 0, max = 0;
  if (c.stacked) {
    for (let i = 0; i < c.categories.length; i++) {
      let pos = 0, neg = 0;
      for (const s of c.series) { const v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    }
  } else {
    for (const s of c.series) for (const v of s.values) if (v !== null) { max = Math.max(max, v); min = Math.min(min, v); }
  }
  if (max === min) max = min + 1;
  const step = niceStep(max - min);
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step };
}

function legend(c, y) {
  if (c.series.length < 2 && c.kind !== 'pie' && c.kind !== 'doughnut') return '';
  const names = c.kind === 'pie' || c.kind === 'doughnut' ? c.categories : c.series.map((s) => s.name);
  let s = '', x = 16;
  names.slice(0, 16).forEach((name, i) => {
    const label = clip(name, 24);
    s += '<rect class="dv-s' + ((i % SERIES_CLASSES) + 1) + '" x="' + x + '" y="' + (y - 9) + '" width="10" height="10"></rect>';
    s += '<text class="dv-chart-label" x="' + (x + 14) + '" y="' + y + '">' + esc(label) + '</text>';
    x += 24 + label.length * 6.5;
    if (x > W - 80) { x = 16; y += 16; }
  });
  return s;
}

function cartesianSvg(c) {
  const x0 = 56, x1 = W - 16, y0 = 16, y1 = H - 64;
  const r = range(c);
  const n = c.categories.length;
  let s = '';
  if (c.kind === 'bar' && c.horizontal) {
    // Horizontal bars: categories down the left, values along the bottom.
    const hx0 = 120;
    const band = (y1 - y0) / n;
    const zero = hx0 + ((0 - r.min) / (r.max - r.min)) * (x1 - hx0);
    const step = niceStep(r.max - r.min);
    for (let v = r.min; v <= r.max + step * 1e-9; v += step) {
      const x = hx0 + ((v - r.min) / (r.max - r.min)) * (x1 - hx0);
      s += '<line class="dv-chart-grid" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + y0 + '" y2="' + y1 + '"></line>';
      s += '<text class="dv-chart-label" x="' + x.toFixed(1) + '" y="' + (y1 + 14) + '" text-anchor="middle">' + esc(fmt(Math.round(v / step) * step)) + '</text>';
    }
    c.categories.forEach((cat, i) => {
      s += '<text class="dv-chart-label" x="' + (hx0 - 6) + '" y="' + (y0 + band * (i + 0.5) + 4).toFixed(1) + '" text-anchor="end">' + esc(clip(cat, 18)) + '</text>';
      let acc = 0;
      c.series.forEach((ser, k) => {
        const v = ser.values[i];
        if (v === null || v === undefined) return;
        const h = c.stacked ? band * 0.7 : (band * 0.8) / c.series.length;
        const y = c.stacked ? y0 + band * (i + 0.15) : y0 + band * (i + 0.1) + h * k;
        const a = hx0 + (((c.stacked ? acc : 0) - r.min) / (r.max - r.min)) * (x1 - hx0);
        const b = hx0 + (((c.stacked ? acc + v : v) - r.min) / (r.max - r.min)) * (x1 - hx0);
        if (c.stacked) acc += v;
        s += '<rect class="dv-s' + ((k % SERIES_CLASSES) + 1) + '" x="' + Math.min(a, b).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, Math.abs(b - a)).toFixed(1) + '" height="' + Math.max(1, h).toFixed(1) + '"><title>' + esc(ser.name + ', ' + cat + ': ' + fmt(v)) + '</title></rect>';
      });
    });
    s += '<line class="dv-chart-axis" x1="' + zero.toFixed(1) + '" x2="' + zero.toFixed(1) + '" y1="' + y0 + '" y2="' + y1 + '"></line>';
    return s + legend(c, H - 24);
  }
  s += axisSvg(c, r.min, r.max, x0, y0, x1, y1);
  const yOf = (v) => y1 - ((v - r.min) / (r.max - r.min)) * (y1 - y0);
  const band = (x1 - x0) / Math.max(1, n);
  const labelEvery = Math.max(1, Math.ceil(n / 12));
  c.categories.forEach((cat, i) => {
    if (i % labelEvery) return;
    s += '<text class="dv-chart-label" x="' + (x0 + band * (i + 0.5)).toFixed(1) + '" y="' + (y1 + 14) + '" text-anchor="middle">' + esc(clip(cat, Math.max(4, Math.floor((band * labelEvery) / 7)))) + '</text>';
  });
  if (c.kind === 'bar') {
    const acc = new Array(n).fill(0);
    const accNeg = new Array(n).fill(0);
    c.series.forEach((ser, k) => {
      for (let i = 0; i < n; i++) {
        const v = ser.values[i];
        if (v === null || v === undefined) continue;
        const w = c.stacked ? band * 0.7 : (band * 0.8) / c.series.length;
        const x = c.stacked ? x0 + band * (i + 0.15) : x0 + band * (i + 0.1) + w * k;
        const base = c.stacked ? (v >= 0 ? acc[i] : accNeg[i]) : 0;
        const top = base + v;
        if (c.stacked) { if (v >= 0) acc[i] = top; else accNeg[i] = top; }
        const ya = yOf(base), yb = yOf(top);
        s += '<rect class="dv-s' + ((k % SERIES_CLASSES) + 1) + '" x="' + x.toFixed(1) + '" y="' + Math.min(ya, yb).toFixed(1) + '" width="' + Math.max(1, w).toFixed(1) + '" height="' + Math.max(1, Math.abs(yb - ya)).toFixed(1) + '"><title>' + esc(ser.name + ', ' + c.categories[i] + ': ' + fmt(v)) + '</title></rect>';
      }
    });
  } else {
    const acc = new Array(n).fill(0);
    c.series.forEach((ser, k) => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        let v = ser.values[i];
        if (v === null || v === undefined) continue;
        if (c.stacked) { acc[i] += v; v = acc[i]; }
        pts.push([x0 + band * (i + 0.5), yOf(v), ser.values[i], i]);
      }
      if (!pts.length) return;
      const cls = 'dv-s' + ((k % SERIES_CLASSES) + 1);
      const line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      if (c.kind === 'area') {
        s += '<polygon class="' + cls + ' dv-chart-area" points="' + pts[0][0].toFixed(1) + ',' + yOf(Math.max(r.min, 0)).toFixed(1) + ' ' + line + ' ' + pts[pts.length - 1][0].toFixed(1) + ',' + yOf(Math.max(r.min, 0)).toFixed(1) + '"></polygon>';
      } else if (c.kind === 'line') {
        s += '<polyline class="' + cls + ' dv-chart-line" points="' + line + '"></polyline>';
      }
      for (const p of pts) s += '<circle class="' + cls + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="' + (c.kind === 'scatter' ? 4 : 3) + '"><title>' + esc(ser.name + ', ' + c.categories[p[3]] + ': ' + fmt(p[2])) + '</title></circle>';
    });
  }
  s += '<line class="dv-chart-axis" x1="' + x0 + '" x2="' + x1 + '" y1="' + yOf(Math.max(r.min, Math.min(0, r.max))).toFixed(1) + '" y2="' + yOf(Math.max(r.min, Math.min(0, r.max))).toFixed(1) + '"></line>';
  return s + legend(c, H - 24);
}

function pieSvg(c) {
  const ser = c.series[0];
  const vals = ser.values.map((v) => (v && v > 0 ? v : 0));
  const total = vals.reduce((a, b) => a + b, 0);
  const cx = W / 2, cy = (H - 48) / 2 + 8, R = Math.min(cx, cy) - 16, r0 = c.kind === 'doughnut' ? R * 0.55 : 0;
  if (!total) return '';
  let s = '', a = -Math.PI / 2;
  vals.forEach((v, i) => {
    if (!v) return;
    const b = a + (v / total) * Math.PI * 2;
    const large = b - a > Math.PI ? 1 : 0;
    const p = (ang, rad) => (cx + rad * Math.cos(ang)).toFixed(1) + ',' + (cy + rad * Math.sin(ang)).toFixed(1);
    const title = '<title>' + esc(c.categories[i] + ': ' + fmt(v) + ' (' + Math.round((v / total) * 1000) / 10 + '%)') + '</title>';
    const cls = 'dv-s' + ((i % SERIES_CLASSES) + 1) + ' dv-chart-slice';
    if (v === total) {
      s += '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy.toFixed(1) + '" r="' + R.toFixed(1) + '">' + title + '</circle>';
    } else {
      const d = r0
        ? 'M' + p(a, R) + ' A' + R.toFixed(1) + ',' + R.toFixed(1) + ' 0 ' + large + ' 1 ' + p(b, R) + ' L' + p(b, r0) + ' A' + r0.toFixed(1) + ',' + r0.toFixed(1) + ' 0 ' + large + ' 0 ' + p(a, r0) + ' Z'
        : 'M' + cx + ',' + cy.toFixed(1) + ' L' + p(a, R) + ' A' + R.toFixed(1) + ',' + R.toFixed(1) + ' 0 ' + large + ' 1 ' + p(b, R) + ' Z';
      s += '<path class="' + cls + '" d="' + d + '">' + title + '</path>';
    }
    a = b;
  });
  if (r0 && vals.filter(Boolean).length === 1) s += '<circle class="dv-chart-hole" cx="' + cx + '" cy="' + cy.toFixed(1) + '" r="' + r0.toFixed(1) + '"></circle>';
  return s + legend(c, H - 24);
}

function tableHtml(c) {
  const head = '<tr><th></th>' + c.series.map((s) => '<th>' + esc(s.name) + '</th>').join('') + '</tr>';
  const rows = c.categories.map((cat, i) => '<tr><th>' + esc(cat) + '</th>' + c.series.map((s) => '<td>' + esc(fmt(s.values[i])) + '</td>').join('') + '</tr>').join('');
  return '<table class="dv-chart-data"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>';
}

function md(c) {
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const lines = ['**Chart' + (c.title ? ': ' + cell(c.title) : '') + '**', '', '| | ' + c.series.map((s) => cell(s.name)).join(' | ') + ' |', '| --- | ' + c.series.map(() => '---').join(' | ') + ' |'];
  c.categories.forEach((cat, i) => lines.push('| ' + cell(cat) + ' | ' + c.series.map((s) => fmt(s.values[i])).join(' | ') + ' |'));
  return lines.join('\n');
}
function text(c) {
  return ['Chart' + (c.title ? ': ' + c.title : ''), '\t' + c.series.map((s) => s.name).join('\t')]
    .concat(c.categories.map((cat, i) => cat + '\t' + c.series.map((s) => fmt(s.values[i])).join('\t'))).join('\n');
}

// Returns { html, markdown, text, title } or null when the chart part has no usable data.
function renderChart(xml) {
  const c = parseChart(xml);
  if (!c) return null;
  const body = c.kind === 'pie' || c.kind === 'doughnut' ? pieSvg(c) : cartesianSvg(c);
  const label = 'Chart' + (c.title ? ': ' + c.title : '') + ' (' + c.kind + ', ' + c.series.length + ' series, ' + c.categories.length + ' points)';
  const svg = body ? '<svg class="dv-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label) + '" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>' : '';
  const html = '<figure class="dv-chart">' + (c.title ? '<figcaption>' + esc(c.title) + '</figcaption>' : '') + svg
    + '<details class="dv-chart-details"><summary>Chart data</summary>' + tableHtml(c) + '</details></figure>';
  return { html, markdown: md(c), text: text(c), title: c.title };
}

module.exports = { parseChart, renderChart };
