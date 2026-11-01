const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');
const { readPng } = require('./png.js');
const {
  buildPanelData,
  buildTooltipSvg,
  paletteFor,
  accountBadge,
  gearIconUri,
  refreshIconUri,
  usageIconUri
} = require('../out/tooltip.js');

/**
 * 纵向门禁：截图上逐行扫描**真实墨迹**带，断言相邻墨迹之间的空白间距。
 * 这是纵向栅格的唯一回归门——measure-columns.js 只管横向列宽。
 *
 * 外壳 CSS 与标题行照 Trae / VSCode 的 .monaco-hover 复刻（与 render-panel.js 同一套）。
 * 标题行要带上三枚 16px 图标和可选的账号徽标，因为它们会撑高标题行，直接影响「标题→大数字」。
 * `npm run test:layout` 带 `--check` 跑它。
 */

const SUMMARY = {
  remain: 5652,
  total: 7000,
  unlimited: false,
  packs: [
    { name: '基础积分包', remain: 1202, limit: 2000, unlimited: false, plan: false, expireTime: '2026-12-31 18:38' },
    { name: '签到奖励包', remain: 352, limit: 500, unlimited: false, plan: false, expireTime: '2027-01-15 08:00' },
    { name: '新用户礼包', remain: 2000, limit: 2000, unlimited: false, plan: false, expireTime: '2027-01-20 09:15' }
  ]
};

/** 每行金额串里有没有逗号——有逗号才有下伸，这才决定「行→分隔线」是 10 还是 11 */
const ROW_HAS_DESCENDER = [true, false, true];
const ROWS = ROW_HAS_DESCENDER.length;
/** 每行两段：分隔线→行恒 10；行→分隔线在无下伸字符时是 11 */
const ROW_GAPS = ROW_HAS_DESCENDER.flatMap((d) => [10, d ? 10 : 11]);

/**
 * 期望的墨迹间距（自上而下，与 codebuddy 的版式同一套）。
 * 注意：16px 标题图标把标题带向上撑了 1px，所以「外框顶→标题」实测 13（旧 14px 图标时是 14）。
 *  13 外框顶→标题（图标顶比标题文字高 1px）
 *  15 标题→大数字（无徽标；TraeCN 积分面板没有下伸字母）
 *  10 大数字→进度条、10 进度条→表头、5 表头→表头分隔线
 *  每行两段：分隔线→行 10；行→分隔线 10，但该行无逗号等下伸字符时是 11
 *  末行分隔线→页脚 10、页脚→浮窗下边缘 10
 *
 * 徽标把标题行撑高 1px：标题→大数字 16、页脚→浮窗下边缘 11；两态分开锁。
 */
const EXPECTED_NO_BADGE = [13, 15, 10, 10, 5, ...ROW_GAPS, 10, 10];
const EXPECTED_WITH_BADGE = [13, 16, 10, 10, 5, ...ROW_GAPS, 10, 11];

const CHECK = process.argv.includes('--check');

function bodySvg(account) {
  const data = buildPanelData(SUMMARY, 'unclaimed', '14:39', account);
  return buildTooltipSvg(data, paletteFor('dark'), ROWS, undefined);
}

function titleRow(account) {
  const pal = paletteFor('dark');
  const badge = account
    ? (() => {
        const b = accountBadge(account, pal.muted);
        return `<img src="${b.uri}" align="top" width="${b.width.toFixed(1)}" height="18" alt="当前账号">`;
      })()
    : '';
  const gear = `<a href="command:x"><img src="${gearIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="设置"></a>`;
  const refresh = `<a href="command:x"><img src="${refreshIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="刷新"></a>`;
  const usage = `<a href="command:x"><img src="${usageIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="用量明细"></a>`;
  return `<h3>TraeCN 积分面板 ${badge}${gear}${refresh}${usage}</h3>`;
}

function page(svg, account) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#252526}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.workbench-hover{position:relative;font-size:13px;line-height:19px;background:#252526;border:1px solid #454545;color:#cccccc;box-sizing:border-box;display:inline-block}
.monaco-hover{box-sizing:border-box;line-height:1.5em}
.monaco-hover .hover-contents{padding:4px 8px}
.monaco-hover p,.monaco-hover h3{margin:8px 0}
.monaco-hover h3{line-height:1.1;font-size:15.21px;font-weight:700;font-family:"Segoe WPC","Segoe UI","Microsoft YaHei",sans-serif}
.monaco-hover p:last-child{margin-bottom:0}
</style></head><body><div class="workbench-hover monaco-hover"><div class="markdown-hover"><div class="hover-contents">
${titleRow(account)}
<p>${svg.replace('<svg ', '<svg id="body" ')}</p>
</div></div></div></body></html>`;
}

const BG = [0x25, 0x25, 0x26];

function measure(account) {
  const html = path.join(__dirname, '_pixels.html');
  const png = path.join(__dirname, '_pixels.png');
  fs.writeFileSync(html, page(bodySvg(account), account), 'utf8');
  execFileSync(chromePath(),
    ['--headless=new', '--disable-gpu', ...chromeArgs(), '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=320,420', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  const { w, h, bpp, px } = readPng(png);
  fs.unlinkSync(html);
  fs.unlinkSync(png);

  const bands = [];
  let cur = null;
  for (let y = 0; y < h; y++) {
    let hit = 0;
    // 跳过 1px 边框列，否则边框会让每一行都算「有内容」
    for (let x = 3; x < 266; x++) {
      const i = y * w * bpp + x * bpp;
      if (Math.abs(px[i] - BG[0]) + Math.abs(px[i + 1] - BG[1]) + Math.abs(px[i + 2] - BG[2]) > 12) {
        hit++;
        if (hit > 1) break;
      }
    }
    if (hit > 1) {
      if (!cur) cur = { top: y, bottom: y };
      else cur.bottom = y;
    } else if (cur) {
      bands.push(cur);
      cur = null;
    }
  }
  if (cur) bands.push(cur);

  const gaps = [];
  let prev = null;
  bands.forEach((b) => {
    if (prev) gaps.push(b.top - prev.bottom - 1);
    prev = b;
  });
  return { w, h, bands, gaps };
}

let failures = 0;
for (const [label, account, expected] of [
  ['无徽标', '', EXPECTED_NO_BADGE],
  ['有徽标', '示例用户', EXPECTED_WITH_BADGE]
]) {
  const m = measure(account);
  console.log(`\n### ${label}：截图 ${m.w}x${m.h}，检出 ${m.bands.length} 个墨迹带`);
  m.bands.forEach((b, i) => {
    console.log((i === 0 ? '     -' : String(m.gaps[i - 1]).padStart(6)) + ' | y ' + b.top + ' ~ ' + b.bottom + '  高 ' + (b.bottom - b.top + 1));
  });
  const bad = m.gaps
    .map((g, i) => (expected[i] === undefined || g === expected[i] ? null : `第${i + 1}处 期望 ${expected[i]} 实测 ${g}`))
    .filter(Boolean);
  if (m.gaps.length !== expected.length) {
    bad.push(`间距段数 期望 ${expected.length} 实测 ${m.gaps.length}`);
  }
  if (bad.length) {
    failures++;
    console.log('FAIL: ' + bad.join('；'));
  } else {
    console.log(`OK: ${expected.length} 处墨迹间距全部符合期望`);
  }
}

process.exit(CHECK && failures ? 1 : 0);
