const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath } = require('./chrome.js');
const { buildCard, summary } = require('./gen-theme-check.js');

/**
 * 横向实测：额度串变宽时名称列必须让位，两列字面间距不得跌破 20px；
 * 大数字行不得压到右上角百分比胶囊（胶囊左缘 207.7，留 20 间距 → 右缘上限 187.7）。
 * 四个量级都用 9 个汉字的超长套餐名压上限。
 */
const LONG_NAME = '限时活动赠送积分包';
const MIN_GAP = 20;
const BIG_RIGHT_LIMIT = 187.7;

const cases = [
  ['千分位（定稿数据）', 7100, 1298, [[2000, 798], [2000, 0], [150, 0]]],
  ['跨万位（不压缩要 69px）', 19999, 9999, [[10000, 1], [9999, 0], [150, 0]]],
  ['w 压缩', 1234567, 234567, [[1000000, 0], [234567, 0], [150, 0]]],
  ['极端（千万级）', 98765432, 87654321, [[98765432, 87654321], [150, 0], [100, 0]]]
];

function bodySvg(limit, used, packsSpec) {
  Object.assign(summary, { limit, used, remaining: limit - used, unlimited: false });
  summary.packs = packsSpec.map(([packLimit, packUsed], i) => ({
    name: LONG_NAME,
    limit: packLimit,
    used: packUsed,
    remaining: Math.max(packLimit - packUsed, 0),
    unlimited: false,
    expireTime: 1792579103 + i * 86400
  }));
  return buildCard('dark').bodySvg;
}

const page = svg => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="box"></div><script>
document.getElementById('box').innerHTML = new TextDecoder().decode(Uint8Array.from(atob('${Buffer.from(svg).toString('base64')}'), c => c.charCodeAt(0)));
const rows = [];
document.querySelectorAll('svg text').forEach(e => {
  const b = e.getBBox();
  const cell = { t: e.textContent, fs: e.getAttribute('font-size'), left: +b.x.toFixed(1), right: +(b.x + b.width).toFixed(1) };
  const r = rows.find(x => x.y === e.getAttribute('y'));
  if (r) r.cells.push(cell); else rows.push({ y: e.getAttribute('y'), cells: [cell] });
});
rows.forEach(r => r.cells.sort((a, b) => a.left - b.left));
const out = document.createElement('div'); out.id = 'out'; out.textContent = JSON.stringify(rows);
document.body.appendChild(out);
<\/script></body></html>`;

function measure(svg) {
  const f = path.join(__dirname, '_cols.html');
  fs.writeFileSync(f, page(svg), 'utf8');
  const dom = execFileSync(chromePath(),
    ['--headless=new', '--disable-gpu', '--window-size=400,420', '--virtual-time-budget=3000', '--dump-dom', 'file:///' + f.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  fs.unlinkSync(f);
  const rows = JSON.parse(dom.match(/<div id="out">([\s\S]*?)<\/div>/)[1].replace(/&quot;/g, '"'));
  const detail = rows
    .filter(r => r.cells.length === 3 && /\d/.test(r.cells[1].t))
    .map(r => ({
      name: r.cells[0].t,
      quota: r.cells[1].t,
      nameRight: r.cells[0].right,
      gap: +(r.cells[1].left - r.cells[0].right).toFixed(1)
    }));
  const big = rows.flatMap(r => r.cells).find(c => c.fs === '30');
  if (!detail.length || !big) {
    throw new Error('没检出明细行或大数字行：' + JSON.stringify(rows).slice(0, 300));
  }
  return { detail, bigRight: +big.right.toFixed(1), bigText: big.t };
}

let failures = 0;
for (const [label, limit, used, packsSpec] of cases) {
  const m = measure(bodySvg(limit, used, packsSpec));
  const minGap = Math.min(...m.detail.map(r => r.gap));
  const bad = [];
  if (minGap < MIN_GAP) {
    bad.push(`列间距 ${minGap}px < ${MIN_GAP}px`);
  }
  // 同一列的截断必须齐平：逐行按各自额度宽度算会让名称长短不一
  if (new Set(m.detail.map(r => r.nameRight)).size > 1) {
    bad.push(`名称列右缘不齐 ${m.detail.map(r => r.nameRight).join('/')}`);
  }
  if (m.bigRight > BIG_RIGHT_LIMIT) {
    bad.push(`大数字右缘 ${m.bigRight} > ${BIG_RIGHT_LIMIT}`);
  }
  if (bad.length) failures++;
  console.log((bad.length ? ' FAIL ' : '  OK  ') + label.padEnd(26) +
    '列间距最小 ' + String(minGap).padStart(5) + 'px   额度「' + m.detail[0].quota + '」   名称「' + m.detail[0].name +
    '」   大数字「' + m.bigText + '」右缘 ' + m.bigRight + (bad.length ? '   ' + bad.join('；') : ''));
}

console.log(failures ? failures + ' 组不达标' : '全部 ' + cases.length + ' 组列间距与宽度达标');
process.exit(failures ? 1 : 0);
