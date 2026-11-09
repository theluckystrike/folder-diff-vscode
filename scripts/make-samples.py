#!/usr/bin/env python3 -I
"""Writes samples/release-1.0 and samples/release-1.1: two versions of a small project with text, Word, Excel,
CSV, PDF and PNG files, used by "Try It on Sample Folders" and the tests.
usage: python3 -I scripts/make-samples.py <out dir> <seed .docx> <seed .xlsx>
The seeds are the Q3 report of the DOCX viewer and the sales workbook of the table viewer (both made by Zovo)."""
import os, sys, zipfile, zlib, struct, shutil, time

out, seed_docx, seed_xlsx = sys.argv[1], sys.argv[2], sys.argv[3]
A, B = os.path.join(out, 'release-1.0'), os.path.join(out, 'release-1.1')
for d in (A, B):
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)


def put(root, rel, data):
    p = os.path.join(root, *rel.split('/'))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode())


def zip_edit(src, dst, edits):
    """Copies a zip and applies (part, old, new) text replacements."""
    with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zo:
        for info in zi.infolist():
            data = zi.read(info.filename)
            for part, old, new in edits:
                if info.filename == part:
                    assert old.encode() in data, (part, old)
                    data = data.replace(old.encode(), new.encode())
            zi_info = zipfile.ZipInfo(info.filename, date_time=(2026, 1, 1, 0, 0, 0))
            zi_info.compress_type = zipfile.ZIP_DEFLATED
            zo.writestr(zi_info, data)


def pdf(lines):
    """A small real PDF: one page per list of lines, Helvetica, uncompressed text."""
    pages = lines
    objs = []
    objs.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    kids = ' '.join(f'{3 + 2 * i} 0 R' for i in range(len(pages)))
    objs.append(f'<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>'.encode())
    font_id = 3 + 2 * len(pages)
    for i, pg in enumerate(pages):
        content = 'BT /F1 12 Tf 72 740 Td 16 TL\n' + '\n'.join('(' + l.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ') Tj T*' for l in pg) + '\nET'
        objs.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>'.encode())
        cb = content.encode('latin-1')
        objs.append(b'<< /Length %d >>\nstream\n' % len(cb) + cb + b'\nendstream')
    objs.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    out = bytearray(b'%PDF-1.4\n')
    offs = []
    for n, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b'%d 0 obj\n' % n + o + b'\nendobj\n'
    x = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for o in offs:
        out += b'%010d 00000 n \n' % o
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)
    return bytes(out)


def png(w, h, px):
    raw = b''.join(b'\x00' + b''.join(bytes(px(x, y)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


readme = """# Solar Field Tools

Scripts and reports for the field team.

## Install

    npm install
    npm start

## Reports

The quarterly report is in docs/. Sales data is in data/.
"""
put(A, 'README.md', readme)
put(B, 'README.md', readme.replace('npm start', 'npm start -- --region north').replace('## Reports', '## Reports\n\nNew in 1.1: the North region has its own report.'))
app = """const { loadSales } = require('./util');

function main(args) {
  const rows = loadSales('data/sales.csv');
  const total = rows.reduce((s, r) => s + r.units * r.price, 0);
  console.log('Total revenue:', total.toFixed(2));
}

main(process.argv.slice(2));
"""
put(A, 'src/app.js', app)
put(B, 'src/app.js', app.replace("const rows = loadSales('data/sales.csv');", "const region = args[1] || 'all';\n  const rows = loadSales('data/sales.csv').filter(r => region === 'all' || r.region.toLowerCase() === region);").replace("console.log('Total revenue:', total.toFixed(2));", "console.log(`Total revenue (${region}):`, total.toFixed(2));"))
util = """const fs = require('fs');

exports.loadSales = (file) => fs.readFileSync(file, 'utf8').trim().split('\\n').slice(1).map((line) => {
  const [region, units, price] = line.split(',');
  return { region, units: Number(units), price: Number(price) };
});
"""
put(A, 'src/util.js', util)
put(B, 'src/util.js', util)
put(A, 'src/legacy-export.js', "// Old export, removed in 1.1.\nmodule.exports = () => 'csv';\n")
put(B, 'src/region-report.js', "// New in 1.1: one report per region.\nmodule.exports = (region) => `Report for ${region}`;\n")
cfg = '{\n  "currency": "USD",\n  "regions": ["North", "South", "East", "West"]\n}\n'
put(A, 'config.json', cfg)
put(B, 'config.json', cfg)
put(A, 'data/sales.csv', 'region,units,price\nNorth,10,2.50\nSouth,20,3.75\nEast,12,2.95\nWest,7,3.10\n')
put(B, 'data/sales.csv', 'region,units,price\nNorth,14,2.50\nSouth,20,3.75\nEast,12,2.95\nWest,7,3.10\nCentral,5,3.30\n')
os.makedirs(os.path.join(A, 'docs'), exist_ok=True)
os.makedirs(os.path.join(B, 'docs'), exist_ok=True)
shutil.copyfile(seed_docx, os.path.join(A, 'docs', 'Q3 Field Report.docx'))
zip_edit(seed_docx, os.path.join(B, 'docs', 'Q3 Field Report.docx'), [
    ('word/document.xml', '18.2 MW', '19.4 MW'),
    ('word/document.xml', '$41.6 million', '$43.0 million'),
    ('word/document.xml', 'Panel prices rose 6% in August and may rise again.', 'Panel prices rose 6% in August. A second supplier is signed for Q4.'),
])
shutil.copyfile(seed_xlsx, os.path.join(A, 'data', 'sales.xlsx'))
zip_edit(seed_xlsx, os.path.join(B, 'data', 'sales.xlsx'), [
    ('xl/worksheets/sheet1.xml', '<c r="B2"><v>10</v></c>', '<c r="B2"><v>14</v></c>'),
    ('xl/worksheets/sheet1.xml', '<c r="C3"><v>3.75</v></c>', '<c r="C3"><v>3.95</v></c>'),
])
manual = [['Solar Field Tools - User Manual', '', '1. Start', 'Run npm start in the project folder.', 'The total revenue is printed for all regions.'],
          ['2. Data', 'Sales data is read from data/sales.csv.', 'Each row has a region, units and a price.']]
put(A, 'docs/manual.pdf', pdf(manual))
manual2 = [p[:] for p in manual]
manual2[0][4] = 'Add --region north to print one region only.'
manual2[1].append('The Central region is new in version 1.1.')
put(B, 'docs/manual.pdf', pdf(manual2))
put(A, 'assets/logo.png', png(48, 48, lambda x, y: (240, 160 + x, 40 + y)))
put(B, 'assets/logo.png', png(48, 48, lambda x, y: (40, 120, 220) if 16 <= x < 32 and 16 <= y < 32 else (240, 160 + x, 40 + y)))
# Equal times for equal files, so Quick mode agrees with Content mode on the samples.
t = time.mktime((2026, 10, 1, 9, 0, 0, 0, 0, -1))
t2 = time.mktime((2026, 11, 1, 9, 0, 0, 0, 0, -1))
for root, ts in ((A, t), (B, t2)):
    for dp, dn, fn in os.walk(root):
        for f in fn:
            os.utime(os.path.join(dp, f), (ts, ts))
for rel in ('src/util.js', 'config.json'):
    os.utime(os.path.join(B, *rel.split('/')), (t, t))
print('samples written to', out)
