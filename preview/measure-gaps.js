const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath } = require('./chrome.js');
const { buildCard } = require('./gen-theme-check.js');

const svg = buildCard('dark').bodySvg;

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="box"></div><script>
document.getElementById('box').innerHTML = new TextDecoder().decode(Uint8Array.from(atob('${Buffer.from(svg).toString('base64')}'), c => c.charCodeAt(0)));
const s = document.querySelector('svg');
const rows = [];
s.querySelectorAll('text').forEach(e => {
  const y = e.getAttribute('y'), b = e.getBBox();
  const r = rows.find(x => x.y === y);
  const cell = { t: e.textContent, fs: e.getAttribute('font-size'), left: +(b.x).toFixed(1), right: +(b.x + b.width).toFixed(1) };
  if (r) r.cells.push(cell); else rows.push({ y, cells: [cell] });
});
rows.sort((a, b) => a.y - b.y);
const p = document.createElement('div'); p.id = 'out';
p.textContent = JSON.stringify(rows);
document.body.appendChild(p);
<\/script></body></html>`;

const f = path.join(__dirname, '_hgap.html');
fs.writeFileSync(f, page, 'utf8');
const dom = execFileSync(chromePath(),
  ['--headless=new', '--disable-gpu', '--window-size=400,400', '--virtual-time-budget=3000', '--dump-dom', 'file:///' + f.replace(/\\/g, '/')],
  { encoding: 'utf8', timeout: 90000 });
fs.unlinkSync(f);
const rows = JSON.parse(dom.match(/<div id="out">([\s\S]*?)<\/div>/)[1].replace(/&quot;/g, '"'));
rows.forEach(r => r.cells.sort((a, b) => a.left - b.left));
rows.forEach((r, i) => {
  const c = r.cells;
  if (c.length !== 3) return;
  console.log(
    ('y=' + r.y + '  ' + c.map(x => x.t).join(' | ')).padEnd(46),
    `名称[${c[0].left},${c[0].right}]`,
    `额度[${c[1].left},${c[1].right}]`,
    `到期[${c[2].left},${c[2].right}]`,
    `| 名称→额度 ${(c[1].left - c[0].right).toFixed(1)}px`,
    `额度→到期 ${(c[2].left - c[1].right).toFixed(1)}px`
  );
});
