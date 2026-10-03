/* 截图 → 墨迹带列表。设计侧每段的 y 由 buildTooltipBody 的常量算出，
   用「带与带之间的设计间距 / 像素间距」反推缩放，避免拿单段距离当标尺。
   用法: node preview/measure-host-gap.js <截图.png> [截图那个构建的 hostPad，默认 9] */
const sharp = require('sharp');

(async () => {
  const file = process.argv[2];
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const L = (x, y) => {
    const i = (y * W + x) * C;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };

  // 卡片底色 = 全图亮度众数（卡片占绝大部分），裁图位置不影响
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

  // 浮窗底边 = 最靠下的一条横贯全宽的亮线（1px 边框）。编辑器/任务栏里的文字达不到这个占比。
  const wide = y => {
    let hit = 0;
    for (let x = 0; x < W; x++) if (Math.abs(L(x, y) - bg) > 15) hit++;
    return hit / W > 0.6;
  };
  let borderY = -1;
  for (let y = H - 1; y > 0 && borderY < 0; y--) if (wide(y)) borderY = y;
  const borderBand = bands.filter(b => b.kind === 'line').find(b => b.start <= borderY && borderY <= b.end);

  // 缩放用明细分隔线的间距反推（设计 rowPitch=32）。取中位数：进度条边缘与标题分隔线会混进相邻差里。
  const lastInk = [...bands].reverse().find(b => b.kind === 'ink' && b.end < borderY);
  const dividers = bands.filter(b => b.kind === 'line' && b.end < lastInk.start);
  const pitches = dividers.slice(1).map((b, i) => (b.start + b.end) / 2 - (dividers[i].start + dividers[i].end) / 2).filter(p => p > 20);
  pitches.sort((a, b) => a - b);
  const z = pitches[Math.floor(pitches.length / 2)] / 32;

  const a = lastInk.start - (dividers.pop().end + 1);
  const b2 = (borderBand.end + 1) - (lastInk.end + 1);
  const B = b2 / z;
  const pad = Number(process.argv[3] ?? 9);
  console.log(`浮窗底边 y=${borderBand.start}..${borderBand.end}  缩放 z=${z.toFixed(3)}  A=${a}px(${(a / z).toFixed(1)}单位)  B=${b2}px(${B.toFixed(1)}单位)  B/A=${(b2 / a).toFixed(2)}`);
  console.log(`该构建 hostPad=${pad} ⇒ 宿主在行内图下方额外补 ${(B - 10.7 + pad).toFixed(1)} 单位；按契约 B=A=10 反推 hostPad = ${(pad + B - 10).toFixed(1)}`);
})();
