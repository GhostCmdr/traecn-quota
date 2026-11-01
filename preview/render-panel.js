const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');
const {
  buildPanelData,
  buildTooltipSvg,
  paletteFor,
  svgDataUri,
  accountBadge,
  gearIconUri,
  refreshIconUri,
  usageIconUri
} = require('../out/tooltip.js');

/**
 * 出图三张（都是**合成示例数据**，不碰用户自己截的真机图）：
 *  - `preview/_panel-dark.png` / `_panel-light.png` —— 带 VSCode hover 外壳的明暗对照
 *  - `preview/_panel-shot.png` —— 不带外壳的面板本体，改版式后拿它和 `resources/screenshot.png` 比对
 *
 * `resources/screenshot.png`（README / 市场页那张）是**真机截图**，由用户提供，脚本不要覆盖它。
 */

const summary = {
  remain: 5652,
  total: 7000,
  unlimited: false,
  packs: [
    { name: 'Trae 会员 Pro 月度积分包', remain: 1800, limit: 3000, unlimited: false, plan: true, expireTime: '2026-12-31 18:38' },
    { name: '签到奖励包', remain: 352, limit: 500, unlimited: false, plan: false, expireTime: '2027-01-15 08:00' },
    { name: '新用户礼包', remain: 2000, limit: 2000, unlimited: false, plan: false, expireTime: '2027-01-20 09:15' },
    { name: '活动加赠', remain: 1500, limit: 1500, unlimited: false, plan: false, expireTime: '2027-02-28 10:00' }
  ]
};

/** 示例账号名：样例数据里带上，预览图才和真机（有昵称）一致 */
const ACCOUNT = '示例用户';

function title(kind, pal) {
  const badge = accountBadge(ACCOUNT, pal.muted);
  const gear = `<a href="command:x"><img src="${gearIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="设置"></a>`;
  const refresh = `<a href="command:x"><img src="${refreshIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="刷新"></a>`;
  const usage = `<a href="command:x"><img src="${usageIconUri(pal.muted)}" align="right" width="16" hspace="0" alt="用量明细"></a>`;
  return `TraeCN 积分面板 <img src="${badge.uri}" align="top" width="${badge.width.toFixed(1)}" height="18" alt="当前账号">${gear}${refresh}${usage}`;
}

function card(kind) {
  const pal = paletteFor(kind);
  const data = buildPanelData(summary, 'unclaimed', '14:39', ACCOUNT, true);
  const body = buildTooltipSvg(data, pal, 3, undefined);
  const titleColor = kind === 'dark' ? '#cccccc' : '#1f2328';
  const pageBg = kind === 'dark' ? '#252526' : '#ffffff';
  const border = kind === 'dark' ? '#454545' : '#d4d4d4';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${pageBg}}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.workbench-hover{position:relative;font-size:13px;line-height:19px;background:${pageBg};border:1px solid ${border};color:${titleColor};box-sizing:border-box;display:inline-block}
.monaco-hover{box-sizing:border-box;line-height:1.5em}
.monaco-hover .hover-contents{padding:4px 8px}
.monaco-hover p,.monaco-hover h3{margin:8px 0}
.monaco-hover h3{line-height:1.1;font-size:15.21px;font-weight:700;font-family:"Segoe WPC","Segoe UI","Microsoft YaHei",sans-serif}
.monaco-hover p:last-child{margin-bottom:0}
</style></head><body><div class="workbench-hover monaco-hover"><div class="markdown-hover"><div class="hover-contents">
<h3>${title(kind, pal)}</h3>
<p><img src="${svgDataUri(body)}" alt="积分数据"></p>
</div></div></div></body></html>`;
}

for (const kind of ['dark', 'light']) {
  const html = path.join(__dirname, '_panel.html');
  const png = path.join(__dirname, `_panel-${kind}.png`);
  fs.writeFileSync(html, card(kind), 'utf8');
  execFileSync(chromePath(),
    ['--headless=new', '--disable-gpu', ...chromeArgs(), '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=400,520', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  fs.unlinkSync(html);
  console.log(png);
}

// 面板本体（不带外壳）：改版式后拿它跟 resources/screenshot.png 那张真机图比对
{
  const PAD = 14;
  const body = buildTooltipSvg(buildPanelData(summary, 'unclaimed', '14:39', ACCOUNT, true), paletteFor('dark'), 3, undefined);
  const width = Number(body.match(/width="([\d.]+)"/)[1]);
  const height = Number(body.match(/height="([\d.]+)"/)[1]);
  const html = path.join(__dirname, '_shot.html');
  const png = path.join(__dirname, '_panel-shot.png');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#1f1f1f}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;padding:${PAD}px}
img{display:block}</style></head><body><img src="${svgDataUri(body)}"></body></html>`, 'utf8');
  execFileSync(chromePath(),
    ['--headless=new', '--disable-gpu', ...chromeArgs(), '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${Math.ceil(width) + PAD * 2},${Math.ceil(height) + PAD * 2}`, `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  fs.unlinkSync(html);
  console.log(png);
}
