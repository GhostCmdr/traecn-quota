const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath } = require('./chrome.js');
const { buildCard } = require('./gen-theme-check.js');

// CSS 规则逐条抄自本机 VSCode 的 workbench.desktop.main.css，量出 tooltip 在编辑器里的真实渲染尺寸
const TPL = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#333;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.workbench-hover{position:relative;font-size:13px;line-height:19px;max-width:700px;background:#252526;border:1px solid #454545;border-radius:5px;color:#cccccc;box-sizing:border-box;display:inline-block}
.monaco-hover{overflow:hidden;box-sizing:border-box;line-height:1.5em;white-space:normal}
.monaco-hover .hover-contents:not(.html-hover-contents){padding:4px 8px}
.monaco-hover .markdown-hover>.hover-contents:not(.code-hover-contents){max-width:500px;word-wrap:break-word}
.monaco-hover p,.monaco-hover h3{margin:8px 0}
.monaco-hover h3{line-height:1.1}
.monaco-hover p:first-child{margin-top:0}
.monaco-hover p:last-child{margin-bottom:0}
</style></head><body>
<div class="workbench-hover monaco-hover"><div class="markdown-hover"><div class="hover-contents">__MD__</div></div></div>
<script>
addEventListener('load',()=>{
  const h=document.querySelector('.workbench-hover').getBoundingClientRect();
  const i=document.querySelector('p img').getBoundingClientRect();
  const d=document.createElement('div');d.id='out';
  d.textContent=JSON.stringify([+h.width.toFixed(1),+h.height.toFixed(1),+i.width,+i.height]);
  document.body.appendChild(d);
});
</script></body></html>`;

const c = buildCard('dark');
const svgH = +c.bodySvg.match(/height="([\d.]+)"/)[1];
const b64 = Buffer.from(c.bodySvg).toString('base64');
const md =
  `<h3>TraeCN 积分余额 ` +
  `<a href="command:x"><img src="${'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${c.pal.muted}">${[0, 45, 90, 135, 180, 225, 270, 315].map(a => `<rect x="7" y="0.9" width="2" height="2.7" rx="0.7" transform="rotate(${a} 8 8)"/>`).join('')}</g><circle cx="8" cy="8" r="3.4" fill="none" stroke="${c.pal.muted}" stroke-width="2.6"/></svg>`).toString('base64')}" align="right" width="14" hspace="6" alt="设置"></a>` +
  `</h3><p><img src="data:image/svg+xml;base64,${b64}" alt="积分数据"></p>`;

const f = path.join(__dirname, '_vscode-size.html');
fs.writeFileSync(f, TPL.replace('__MD__', md), 'utf8');
const dom = execFileSync(chromePath(),
  ['--headless=new', '--disable-gpu', '--window-size=900,700', '--virtual-time-budget=3000', '--dump-dom', 'file:///' + f.replace(/\\/g, '/')],
  { encoding: 'utf8', timeout: 90000 });
fs.unlinkSync(f);
const [ow, oh, iw, ih] = JSON.parse(dom.match(/<div id="out">([\s\S]*?)<\/div>/)[1].replace(/&quot;/g, '"'));
console.log(`SVG ${iw}×${ih}  →  VSCode tooltip 外框 ${ow}×${oh}（开销 +${(oh - ih).toFixed(1)} 高 / +${(ow - iw).toFixed(1)} 宽）`);
console.log('源码 SVG 声明高', svgH);
