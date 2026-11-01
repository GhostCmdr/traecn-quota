/*
 * 真机截图 → 反推宿主在行内图下方额外补了多少（也就是 footerHostPad 的来源）。
 *
 * 用法: node preview/measure-host-gap.js <截图.png> [截图那个构建的 hostPad，默认 9]
 *
 * 设计侧每段的 y 由 tooltip.ts 的常量算出，所以用「带与带之间的设计间距 / 像素间距」反推缩放，
 * 不拿单段距离当标尺（否则内容一变标尺就漂）。rowPitch 设计值 32，取明细分隔线间距的中位数：
 * 进度条边缘与表头分隔线会混进相邻差里，中位数能滤掉。
 *
 * 与 codebuddy 的同名脚本同一套算法，只是把 sharp 换成 preview/png.js 里的纯 zlib 解码。
 */
const { readPng } = require('./png.js');

const ROW_PITCH = 32;
const INNER_TO_SVG_BOTTOM = 10.7;

const file = process.argv[2];
if (!file) {
  console.error('用法: node preview/measure-host-gap.js <截图.png> [hostPad]');
  process.exit(2);
}
const pad = Number(process.argv[3] ?? 9);
const { w: W, h: H, bpp: C, px } = readPng(file);
const L = (x, y) => {
  const i = (y * W + x) * C;
  return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
};

// 卡片底色 = 全图亮度众数（卡片占绝大部分），所以裁图位置不影响
const hist = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const k = Math.round(L(x, y) / 2) * 2;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const bg = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];

const bands = [];
let cur = null;
for (let y = 0; y < H; y++) {
  let ink = 0;
  let sum = 0;
  for (let x = 0; x < W; x++) {
    const l = L(x, y);
    sum += l;
    if (l > bg + 80) ink++;
  }
  const mean = sum / W;
  const kind = ink >= 3 ? 'ink' : mean > bg + 2.5 ? 'line' : null;
  if (kind && cur && cur.kind === kind) cur.end = y;
  else {
    if (cur) bands.push(cur);
    cur = kind ? { kind, start: y, end: y, ink } : null;
  }
}
if (cur) bands.push(cur);
console.log(`${W}x${H} 底色 ${bg.toFixed(1)}`);
for (const b of bands) {
  console.log(`${b.kind.padEnd(4)} y=${b.start}..${b.end} 高${b.end - b.start + 1} 墨点峰${b.ink}`);
}

// 浮窗底边 = 最靠下的一条横贯全宽的亮线（1px 边框）；编辑器/任务栏里的文字达不到这个占比
const wide = (y) => {
  let hit = 0;
  for (let x = 0; x < W; x++) if (Math.abs(L(x, y) - bg) > 15) hit++;
  return hit / W > 0.6;
};
let borderY = -1;
for (let y = H - 1; y > 0 && borderY < 0; y--) if (wide(y)) borderY = y;
const borderBand = bands.filter((b) => b.kind === 'line').find((b) => b.start <= borderY && borderY <= b.end);
if (!borderBand) {
  console.error('没检出浮窗下边框，截图里要带完整的浮窗（含 1px 边框）');
  process.exit(1);
}

const lastInk = [...bands].reverse().find((b) => b.kind === 'ink' && b.end < borderY);
const dividers = bands.filter((b) => b.kind === 'line' && b.end < lastInk.start);
const pitches = dividers
  .slice(1)
  .map((b, i) => (b.start + b.end) / 2 - (dividers[i].start + dividers[i].end) / 2)
  .filter((p) => p > 20);
pitches.sort((a, b) => a - b);
const z = pitches[Math.floor(pitches.length / 2)] / ROW_PITCH;

const a = lastInk.start - (dividers.pop().end + 1);
const b2 = borderBand.end + 1 - (lastInk.end + 1);
const B = b2 / z;
console.log(
  `浮窗底边 y=${borderBand.start}..${borderBand.end}  缩放 z=${z.toFixed(3)}  A=${a}px(${(a / z).toFixed(1)}单位)  B=${b2}px(${B.toFixed(1)}单位)  B/A=${(b2 / a).toFixed(2)}`
);
console.log(
  `该构建 hostPad=${pad} ⇒ 宿主在行内图下方额外补 ${(B - INNER_TO_SVG_BOTTOM + pad).toFixed(1)} 单位；按契约 B=A=10 反推 hostPad = ${(pad + B - 10).toFixed(1)}`
);
