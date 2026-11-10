// pdf.js wants DOMMatrix (and probes ImageData and Path2D) at load time. Text extraction needs only the matrix math,
// so a small 2D DOMMatrix is enough; no native canvas package is loaded.
class DOMMatrixShim {
  constructor(init) {
    const m = Array.isArray(init) || ArrayBuffer.isView(init) ? Array.from(init) : null;
    [this.a, this.b, this.c, this.d, this.e, this.f] = m && m.length >= 6 ? m.slice(0, 6) : [1, 0, 0, 1, 0, 0];
  }
  multiplySelf(o) {
    const { a, b, c, d, e, f } = this;
    const x = o instanceof DOMMatrixShim ? o : new DOMMatrixShim([o.a ?? 1, o.b ?? 0, o.c ?? 0, o.d ?? 1, o.e ?? 0, o.f ?? 0]);
    this.a = a * x.a + c * x.b; this.b = b * x.a + d * x.b;
    this.c = a * x.c + c * x.d; this.d = b * x.c + d * x.d;
    this.e = a * x.e + c * x.f + e; this.f = b * x.e + d * x.f + f;
    return this;
  }
  preMultiplySelf(o) { const x = new DOMMatrixShim([o.a, o.b, o.c, o.d, o.e, o.f]); x.multiplySelf(this); Object.assign(this, { a: x.a, b: x.b, c: x.c, d: x.d, e: x.e, f: x.f }); return this; }
  translate(tx = 0, ty = 0) { return new DOMMatrixShim([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new DOMMatrixShim([1, 0, 0, 1, tx, ty])); }
  scale(sx = 1, sy = sx) { return new DOMMatrixShim([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(new DOMMatrixShim([sx, 0, 0, sy, 0, 0])); }
  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) { Object.assign(this, { a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN }); return this; }
    Object.assign(this, { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det });
    return this;
  }
}
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrixShim;
if (!globalThis.ImageData) globalThis.ImageData = class ImageData { constructor(w, h) { this.width = w; this.height = h; } };
if (!globalThis.Path2D) globalThis.Path2D = class Path2D { addPath() {} };
export default DOMMatrixShim;
// pdf.js always tries the optional native canvas package in Node and logs a warning when it is missing. Text
// extraction never needs it, so that one line is dropped (it showed as an error line in the extension host log).
const canvasNote = (args) => typeof args[0] === 'string' && args[0].startsWith('Warning: Cannot load "@napi-rs/canvas"');
for (const k of ['log', 'warn']) { const f = console[k]; console[k] = (...args) => { if (!canvasNote(args)) f(...args); }; }
