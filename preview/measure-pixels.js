const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');
const { buildCard, summary } = require('./gen-theme-check.js');

const REAL = {
  limit: 7100, used: 1298, remaining: 5802, unlimited: false,
  packs: [
    { name: '老用户福利', limit: 2000, used: 798, remaining: 1202, unlimited: false, expireTime: 1792579103 },
    { name: '老用户福利', limit: 2000, used: 0, remaining: 2000, unlimited: false, expireTime: 1792579103 },
    { name: '签到奖励', limit: 150, used: 0, remaining: 150, unlimited: false, expireTime: 1792589264 },
    { name: '签到奖励', limit: 150, used: 0, remaining: 150, unlimited: false, expireTime: 1792654947 }
  ]
};

function oldSvg(pal) {
  const W = 251.7, RIGHT = W, XQ = 145.6, rowH = 30, shown = REAL.packs.slice(0, 4);
  const rowsTop = 106, footTop = rowsTop + (shown.length - 1) * rowH + 32, H = footTop + 4;
  const p = [];
  p.push(`<text x="0" y="32" fill="${pal.strong}" font-size="34" font-weight="800">5,802<tspan fill="${pal.muted}" font-size="13"> / 7,100</tspan></text>`);
  p.push(`<rect x="${RIGHT - 44}" y="10" width="44" height="22" rx="11" fill="${pal.pill}"/>`);
  p.push(`<text x="${RIGHT - 22}" y="22" fill="#fff" font-size="11" text-anchor="middle">82%</text>`);
  p.push(`<rect x="0" y="50" width="${W}" height="5" rx="2.5" fill="${pal.track}"/>`);
  p.push(`<text x="0" y="80" fill="${pal.muted}" font-size="10">明细</text><text x="${XQ}" y="80" fill="${pal.muted}" font-size="10" text-anchor="end">额度</text><text x="${RIGHT}" y="80" fill="${pal.muted}" font-size="10" text-anchor="end">到期</text>`);
  p.push(`<line x1="0" y1="88" x2="${W}" y2="88" stroke="${pal.divider}" stroke-width="1"/>`);
  let y = rowsTop;
  for (const k of shown) {
    p.push(`<text x="0" y="${y}" fill="${pal.body}" font-size="11">${k.name}</text><text x="${XQ}" y="${y}" font-size="11" text-anchor="end">${k.remaining} / ${k.limit}</text><text x="${RIGHT}" y="${y}" fill="${pal.muted}" font-size="9.5" text-anchor="end">2026-10-21 18:38:23</text>`);
    p.push(`<line x1="0" y1="${y + 12}" x2="${W}" y2="${y + 12}" stroke="${pal.rowLine}" stroke-width="1"/>`);
    y += rowH;
  }
  p.push(`<circle cx="3.5" cy="${footTop - 3.5}" r="3.5" fill="#d7a33a"/><text x="12" y="${footTop}" fill="${pal.body}" font-size="11">今日未签到</text><text x="${RIGHT}" y="${footTop}" fill="${pal.muted}" font-size="10" text-anchor="end">更新 14:39:57</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">${p.join('')}</svg>`;
}

function page(svg) {
  const pal = buildCard('dark').pal;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#252526}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.workbench-hover{position:relative;font-size:13px;line-height:19px;background:#252526;border:1px solid #454545;color:#cccccc;box-sizing:border-box;display:inline-block}
.monaco-hover{box-sizing:border-box;line-height:1.5em}
.monaco-hover .hover-contents{padding:4px 8px}
.monaco-hover p,.monaco-hover h3{margin:8px 0}
.monaco-hover h3{line-height:1.1;font-size:15.21px;font-weight:700}
.monaco-hover p:last-child{margin-bottom:0}
</style></head><body><div class="workbench-hover monaco-hover"><div class="markdown-hover"><div class="hover-contents">
<h3>TraeCN 积分余额</h3>
<p>${svg.replace('<svg ', '<svg id="body" ')}</p>
</div></div></div></body></html>`;
}

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 0, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (ft === 0) v = cur;
      else if (ft === 1) v = cur + a;
      else if (ft === 2) v = cur + b;
      else if (ft === 3) v = cur + ((a + b) >> 1);
      else {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 255;
    }
    rp += stride;
  }
  return { w, h, bpp, px: out };
}

Object.assign(summary, REAL);
summary.packs = REAL.packs;
const pal = buildCard('dark').pal;
const cases = { '改前基线': oldSvg(pal), ['改后 v' + require('../package.json').version]: buildCard('dark').bodySvg };
const BG = [0x25, 0x25, 0x26];
const CHROME = chromePath();

/**
 * 当前设计的期望墨迹间距（自上而下），随明细行数与样本数据推导：
 *  14 外框顶→标题（VSCode 固定）、15 标题→大数字（用户指定）、
 *  10 大数字→进度条、10 进度条→表头、5 表头→表头分隔线（用户指定）
 *  每行两段：分隔线→行 = 10；行→分隔线 = 10，但该行文本没有逗号等下伸字符时是 11
 *  末行分隔线→页脚 = 10，页脚→浮窗下边缘 = 10
 */
const ROWS = 3;
const ROW_HAS_DESCENDER = [true, true, false]; // '1,202 / 2,000' 有逗号，'150 / 150' 没有
const EXPECTED = [14, 15, 10, 10, 5];
for (let i = 0; i < ROWS; i++) {
  EXPECTED.push(10, ROW_HAS_DESCENDER[i] ? 10 : 11);
}
EXPECTED.push(10, 10);
const CHECK = process.argv.includes('--check');
let failures = 0;

for (const [name, svg] of Object.entries(cases)) {
  const html = path.join(__dirname, '_shot.html');
  const png = path.join(__dirname, '_shot.png');
  fs.writeFileSync(html, page(svg), 'utf8');
  execFileSync(CHROME,
    ['--headless=new', '--disable-gpu', ...chromeArgs(), '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=320,420', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
    { encoding: 'utf8', timeout: 90000 });
  const { w, h, bpp, px } = decodePng(fs.readFileSync(png));
  fs.unlinkSync(html); fs.unlinkSync(png);
  const bands = [];
  let cur = null;
  for (let y = 0; y < h; y++) {
    let hit = 0;
    // 跳过 1px 边框列，否则边框会让每一行都算"有内容"
    for (let x = 3; x < 266; x++) {
      const i = y * w * bpp + x * bpp;
      if (Math.abs(px[i] - BG[0]) + Math.abs(px[i + 1] - BG[1]) + Math.abs(px[i + 2] - BG[2]) > 12) { hit++; if (hit > 1) break; }
    }
    if (hit > 1) {
      if (!cur) cur = { top: y, bottom: y };
      else cur.bottom = y;
    } else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  const gaps = [];
  let prev = null;
  bands.forEach(b => {
    if (prev) gaps.push(b.top - prev.bottom - 1);
    prev = b;
  });
  console.log('\n### ' + name + '  截图 ' + w + 'x' + h + '，检出 ' + (bands.length) + ' 个有笔画/有色的行带');
  bands.forEach((b, i) => {
    console.log((i === 0 ? '     -' : String(gaps[i - 1]).padStart(6)) + ' | y ' + b.top + ' ~ ' + b.bottom + '  高 ' + (b.bottom - b.top + 1));
  });
  if (!name.startsWith('改前')) {
    const bad = gaps.map((g, i) => (EXPECTED[i] === undefined || g === EXPECTED[i] ? null : `第${i + 1}处 期望 ${EXPECTED[i]} 实测 ${g}`)).filter(Boolean);
    if (gaps.length !== EXPECTED.length) {
      bad.push(`间距段数 期望 ${EXPECTED.length} 实测 ${gaps.length}`);
    }
    if (bad.length) {
      failures++;
      console.log('  FAIL: ' + bad.join('；'));
    } else {
      console.log(`  OK: ${EXPECTED.length} 处墨迹间距全部符合期望`);
    }
  }
}

if (CHECK) {
  process.exit(failures ? 1 : 0);
}
