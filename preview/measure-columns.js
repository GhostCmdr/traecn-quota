const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');
const { buildPanelData, buildTooltipSvg, paletteFor } = require('../out/tooltip.js');

/**
 * 横向实测（出厂 buildTooltipSvg 渲染后用 getBBox 量）：
 *  - 明细行：名称↔remain、limit↔到期 两侧间距都不低于 11
 *  - 所有行的 `/` 必须落在同一条中线（125.85），且表头「额度」与它对齐
 *  - 表头三段等距：明细↔额度 与 额度↔到期 相等
 *  - 大数字不得压到右上角胶囊（胶囊左缘 207.7，留 20 → 右缘上限 187.7）
 * 九个汉字的超长套餐名压上限，四个量级 + 亿进位 + 不限量混排 + 套餐行带「套餐内」标签。
 */
const LONG_NAME = '限时活动赠送积分包';
const MIN_GAP = 11.0; // 标称 13 是字面框，墨迹量出来会少 1~1.5px 的字形留白
const SLASH_X = 125.85;
const REMAIN_RIGHT = 120.005;
const BIG_RIGHT_LIMIT = 187.7;
const CHIP_RIGHT_LIMIT = REMAIN_RIGHT - 13; // 套餐标签不得侵入名称↔额度之间的 13px 间距

const cases = [
  ['千分位（定稿数据）', 7100, 5802, [[2000, 1202], [2000, 2000], [150, 150]]],
  ['长英文名压满名称列', 1234567, 234567, [[1000000, 1000000], [234567, 234567], [150, 150]], 'EnterpriseSubscription2026'],
  ['跨万位', 19999, 9999, [[10000, 9999], [9999, 9999], [150, 150]]],
  ['w 压缩', 1234567, 234567, [[1000000, 1000000], [234567, 234567], [150, 150]]],
  ['极端（千万级）', 98765432, 87654321, [[98765432, 87654321], [150, 150], [100, 100]]],
  ['亿进位', 99999999, 67543210, [[99999999, 67543210], [150, 150], [100, 100]]],
  ['不限量混排', 17640, 1672, [[0, 0, true], [9999000, 9900000], [150, 150]]],
  ['套餐标签不压额度列', 600, 100, [[500, 0, false, true], [100, 100], [150, 150]], LONG_NAME, true]
];

function bodySvg(total, remain, packsSpec, name = LONG_NAME, pinPlan = false) {
  const summary = {
    remain,
    total,
    unlimited: false,
    packs: packsSpec.map(([packLimit, packRemain, unlimited, plan]) => ({
      name,
      remain: packRemain,
      limit: packLimit,
      unlimited: !!unlimited,
      plan: !!plan,
      expireTime: '2026-12-31 18:38'
    }))
  };
  const data = buildPanelData(summary, 'unclaimed', '14:39', '', pinPlan);
  return buildTooltipSvg(data, paletteFor('dark'), 3, undefined);
}

const page = (svg) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="box"></div><script>
document.getElementById('box').innerHTML = new TextDecoder().decode(Uint8Array.from(atob('${Buffer.from(svg).toString('base64')}'), c => c.charCodeAt(0)));
const rows = [];
document.querySelectorAll('svg text').forEach(e => {
  const b = e.getBBox();
  const cell = { t: e.textContent, fs: e.getAttribute('font-size'), left: +b.x.toFixed(1), right: +(b.x + b.width).toFixed(1) };
  const y = e.getAttribute('y');
  const r = rows.find(x => x.y === y);
  if (r) r.cells.push(cell); else rows.push({ y, cells: [cell] });
});
rows.forEach(r => r.cells.sort((a, b) => a.left - b.left));
const out = document.createElement('div'); out.id = 'out'; out.textContent = JSON.stringify(rows);
document.body.appendChild(out);
<\/script></body></html>`;

function measure(svg) {
  const f = path.join(__dirname, '_cols.html');
  fs.writeFileSync(f, page(svg), 'utf8');
  const dom = execFileSync(chromePath(),
    ['--headless=new', '--disable-gpu', ...chromeArgs(), '--window-size=400,420', '--virtual-time-budget=3000', '--dump-dom', 'file:///' + f.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  fs.unlinkSync(f);
  const rows = JSON.parse(dom.match(/<div id="out">([\s\S]*?)<\/div>/)[1].replace(/&quot;/g, '"'));

  const detail = rows
    .filter((r) => r.cells.length === 5 && /\d/.test(r.cells[1].t))
    .map((r) => {
      const [name, remain, slash, limit, expiry] = r.cells;
      return {
        name: name.t,
        remain: remain.t,
        limit: limit.t,
        gapLeft: +(remain.left - name.right).toFixed(1),
        gapRight: +(expiry.left - limit.right).toFixed(1),
        slashLeft: +(slash.left - remain.right).toFixed(1),
        slashRight: +(limit.left - slash.right).toFixed(1),
        slashCenter: +((slash.left + slash.right) / 2).toFixed(1)
      };
    });
  const header = rows.find((r) => r.cells.length === 3);
  const big = rows.flatMap((r) => r.cells).find((c) => c.fs === '30');
  if (!detail.length || !header || !big) {
    throw new Error('没检出明细行/表头/大数字行：' + JSON.stringify(rows).slice(0, 300));
  }
  const [hName, hQuota, hExpiry] = header.cells;
  return {
    detail,
    bigRight: +big.right.toFixed(1),
    bigText: big.t,
    headerGapA: +(hQuota.left - hName.right).toFixed(1),
    headerGapB: +(hExpiry.left - hQuota.right).toFixed(1),
    headerCenter: +((hQuota.left + hQuota.right) / 2).toFixed(1)
  };
}

let failures = 0;
for (const [label, total, remain, packsSpec, name, pinPlan] of cases) {
  const svg = bodySvg(total, remain, packsSpec, name, pinPlan);
  const m = measure(svg);
  const minLeft = Math.min(...m.detail.map((r) => r.gapLeft));
  const minRight = Math.min(...m.detail.map((r) => r.gapRight));
  const slashSpread = Math.max(...m.detail.map((r) => r.slashCenter)) - Math.min(...m.detail.map((r) => r.slashCenter));
  const slashSkew = Math.max(...m.detail.map((r) => Math.abs(r.slashLeft - r.slashRight)));
  const bad = [];
  if (minLeft < MIN_GAP) bad.push(`左间距 ${minLeft} < ${MIN_GAP}`);
  if (minRight < MIN_GAP) bad.push(`右间距 ${minRight} < ${MIN_GAP}`);
  if (slashSpread > 0.6) bad.push(`斜杠不齐 波动 ${slashSpread.toFixed(1)}px`);
  if (slashSkew > 1.2) bad.push(`斜杠两侧墨迹不等 ${m.detail[0].slashLeft}/${m.detail[0].slashRight}`);
  if (Math.abs(m.headerCenter - SLASH_X) > 0.6) bad.push(`表头额度中心 ${m.headerCenter} ≠ ${SLASH_X}`);
  if (Math.abs(m.headerGapA - m.headerGapB) > 1.5) bad.push(`表头不等距 ${m.headerGapA}/${m.headerGapB}`);
  if (m.bigRight > BIG_RIGHT_LIMIT) bad.push(`大数字右缘 ${m.bigRight} > ${BIG_RIGHT_LIMIT}`);
  const chip = /<rect x="([\d.]+)" y="[\d.]+" width="34" height="14" rx="7"/.exec(svg);
  if (chip) {
    const chipRight = Number(chip[1]) + 34;
    if (chipRight > CHIP_RIGHT_LIMIT) bad.push(`套餐标签右缘 ${chipRight} 超过 ${CHIP_RIGHT_LIMIT}`);
  }
  if (bad.length) failures++;
  console.log((bad.length ? ' FAIL ' : '  OK  ') + label.padEnd(22) +
    '左距 ' + String(minLeft).padStart(5) + '   右距 ' + String(minRight).padStart(5) +
    '   `/` ' + String(m.detail[0].slashCenter).padStart(6) + '（' + m.detail[0].slashLeft + '/' + m.detail[0].slashRight + '）' +
    '   表头 ' + m.headerGapA + '/' + m.headerGapB +
    '   大数字「' + m.bigText + '」右缘 ' + m.bigRight +
    (bad.length ? '   ' + bad.join('；') : ''));
}

console.log(failures ? failures + ' 组不达标' : '全部 ' + cases.length + ' 组列位、间距与斜杠对齐达标');
process.exit(failures ? 1 : 0);
