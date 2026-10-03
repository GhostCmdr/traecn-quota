/* 逐宿主比对决定 tooltip 底距的完整 CSS 规则。压缩文件里选择器链很长，
   必须按 `}` 切块再取 `{` 前的整段，否则会把 `.x .monaco-hover ...` 误读成 `.monaco-hover ...`。
   用法: node preview/compare-host-css.js "<workbench.desktop.main.css>" ... */
const fs = require('fs');

const NEEDLES = [
  ['容器 padding', /hover-contents[^{]*\{\s*[^}]*padding/],
  ['段末外边距清零', /monaco-hover[^{]*p:last-child[^{]*\{[^}]*\}/],
  ['容器行高', /\.monaco-hover\s*\{[^}]*line-height[^}]*\}|\.workbench-hover\s*\{[^}]*line-height[^}]*\}/],
  ['边框', /\.monaco-hover\s*\{[^}]*border[^}]*\}|\.workbench-hover\s*\{[^}]*border[^}]*\}/]
];

for (const file of process.argv.slice(2)) {
  const css = fs.readFileSync(file, 'utf8');
  const parts = file.replace(/\\/g, '/').split('/');
  const r = parts.indexOf('resources');
  const host = parts.slice(r - 2, r).join('/');
  console.log(`\n===== ${host} =====`);
  for (const [label, re] of NEEDLES) {
    const hits = css.split('}').filter(chunk => chunk.includes('{') && re.test(chunk + '}')).map(chunk => ('}' + chunk).slice(1));
    console.log(`  ${label}: ${hits.length || '（无）'}`);
    hits.slice(0, 3).forEach(h => console.log('    ' + h.replace(/\s+/g, ' ').trim().slice(-160)));
  }
}
