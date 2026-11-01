const fs = require('fs');
const zlib = require('zlib');

/**
 * 极简 PNG 解码：只认 8bit 的 RGB(ct=2) / RGBA(ct=6)，够预览脚本量像素用。
 * 不引 sharp —— 那是原生依赖，为一个偶发的手工量测工具不值得装。
 */
function readPng(filePath) {
  const buf = fs.readFileSync(filePath);
  let pos = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (ct !== 2 && ct !== 6) throw new Error(`只支持 8bit RGB/RGBA 的 PNG，实际 colorType=${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (ft === 0) v = cur;
      else if (ft === 1) v = cur + a;
      else if (ft === 2) v = cur + b;
      else if (ft === 3) v = cur + ((a + b) >> 1);
      else {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = v & 255;
    }
    rp += stride;
  }
  return { w, h, bpp, px };
}

module.exports = { readPng };
