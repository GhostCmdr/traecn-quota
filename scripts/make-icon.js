// 生成扩展图标 resources/icon.png（128x128，深蓝渐变圆角底 + 白色信用卡）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 128;
const H = 128;
const px = Buffer.alloc(W * H * 4);

function set(x, y, r, g, b) {
  const i = (y * W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 255;
}

function inRounded(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad));
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

// 背景：圆角方形 + 垂直渐变
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (inRounded(x, y, 0, 0, W - 1, H - 1, 26)) {
      const t = y / (H - 1);
      set(x, y,
        Math.round(0x22 + (0x0e - 0x22) * t),
        Math.round(0x4a + (0x22 - 0x4a) * t),
        Math.round(0x6e + (0x3a - 0x6e) * t));
    }
  }
}

// 卡片主体
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (inRounded(x, y, 20, 40, 107, 88, 9)) {
      set(x, y, 0xf3, 0xf6, 0xf9);
    }
  }
}

// 磁条
for (let y = 52; y <= 61; y++) {
  for (let x = 21; x <= 106; x++) {
    set(x, y, 0x2c, 0x50, 0x70);
  }
}

// 芯片
for (let y = 69; y <= 80; y++) {
  for (let x = 31; x <= 47; x++) {
    set(x, y, 0xe6, 0xb9, 0x4a);
  }
}
// 芯片纹路
for (let y = 69; y <= 80; y++) {
  for (let x = 31; x <= 47; x++) {
    if (y === 74 || x === 39) set(x, y, 0xc8, 0x9a, 0x35);
  }
}

// 卡号点
for (let x = 57; x <= 97; x += 8) {
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      set(x + dx, 71 + dy, 0xb9, 0xc6, 0xd3);
    }
  }
}

// PNG 编码
function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // RGBA

const stride = 1 + W * 4;
const raw = Buffer.alloc(H * stride);
for (let y = 0; y < H; y++) {
  raw[y * stride] = 0;
  px.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('icon.png written:', png.length, 'bytes');
