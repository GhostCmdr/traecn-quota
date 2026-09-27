const fs = require('fs');
const path = require('path');
const Module = require('module');

const COLOR_THEME_KIND = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

// out/extension.js 顶部 require('vscode')，预览脚本里没有 VSCode，用一个够用的桩替掉
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request !== 'vscode') {
    return origLoad.apply(this, arguments);
  }
  return {
    ColorThemeKind: COLOR_THEME_KIND,
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: {},
    StatusBarAlignment: { Right: 2 },
    MarkdownString: class {}
  };
};

const EXT = require(path.join(__dirname, '..', 'out', 'extension.js'));
const KIND = { light: COLOR_THEME_KIND.Light, dark: COLOR_THEME_KIND.Dark };

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const summary = {
  limit: 7000,
  used: 1348,
  remaining: 5652,
  unlimited: false,
  packs: [
    { name: '月度基础赠送包', limit: 3000, used: 1200, remaining: 1800, unlimited: false, expireTime: now + 9 * DAY },
    { name: '签到奖励包', limit: 500, used: 148, remaining: 352, unlimited: false, expireTime: now + 3 * DAY },
    { name: '新用户礼包', limit: 2000, used: 0, remaining: 2000, unlimited: false, expireTime: now + 30 * DAY },
    { name: '活动加赠', limit: 1500, used: 0, remaining: 1500, unlimited: false, expireTime: now + 60 * DAY },
    { name: '第五个包不会显示', limit: 800, used: 0, remaining: 800, unlimited: false, expireTime: now + 90 * DAY }
  ]
};

// 图标和 data URI 一律用出厂实现，本地副本历史上漂移过一次
const { svgDataUri, refreshIconUri, gearIconUri } = EXT;

/** 复刻 extension.ts render() 的两层结构：Markdown h3 标题行 + 透明 SVG 数据体 */
function buildCard(kindName) {
  const pal = EXT.paletteFor(KIND[kindName]);
  const packs = summary.packs
    .filter(p => p.unlimited || (p.remaining ?? 0) > 0)
    .sort((a, b) => (a.expireTime ?? Infinity) - (b.expireTime ?? Infinity));
  return {
    pal,
    bodySvg: EXT.buildTooltipBody(packs, summary, pal),
    titleColor: kindName === 'dark' ? '#cccccc' : '#1f2328',
    pageBg: kindName === 'dark' ? '#252526' : '#ffffff'
  };
}

if (require.main === module) {
  const CARD_CSS = `
  body{margin:0;padding:28px;background:#0e0e0e;font-family:"Segoe UI","Microsoft YaHei",sans-serif;display:flex;gap:40px;align-items:flex-start}
  .card{display:flex;flex-direction:column;gap:10px}
  .label{color:#8a8a8a;font-size:12px;letter-spacing:.5px;text-transform:uppercase}
  /* 尺寸对齐 VSCode：.workbench-hover font-size 13px / .hover-contents padding 4px 8px / 1px 边框 */
  .tt{border-radius:5px;padding:4px 8px;box-sizing:border-box;border:1px solid;font-size:13px;line-height:19px}
  .h3{display:flex;align-items:center;justify-content:space-between;font-size:15.21px;font-weight:700;line-height:1.1;margin:8px 0}
  .icons{display:flex;gap:6px}
  .body{display:block;margin-top:8px}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TraeCN Quota ${require(path.join(__dirname, '..', 'package.json')).version} theme check</title><style>${CARD_CSS}</style></head><body>${['light', 'dark']
    .map(k => {
      const c = buildCard(k);
      return `<div class="card"><div class="label">${k} theme · SVG ${c.bodySvg.match(/width="([\d.]+)"/)[1]}×${c.bodySvg.match(/height="([\d.]+)"/)[1]}</div>
      <div class="tt" style="background:${c.pageBg};color:${c.titleColor};border-color:${c.pal.divider}">
        <div class="h3"><span>TraeCN 积分余额</span><span class="icons"><img src="${refreshIconUri(c.pal.muted)}" width="14" alt="刷新"><img src="${gearIconUri(c.pal.muted)}" width="14" alt="设置"></span></div>
        <img class="body" src="${svgDataUri(c.bodySvg)}" alt="积分数据">
      </div></div>`;
    })
    .join('')}</body></html>`;

  const out = path.join(__dirname, 'theme-check.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(out);
} else {
  module.exports = { buildCard, summary, svgDataUri };
}
