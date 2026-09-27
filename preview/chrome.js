const fs = require('fs');
const { execFileSync } = require('child_process');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 定位可用的 Chrome/Chromium，用于无头截图与墨迹测量；找不到就抛错而不是静默失败 */
function chromePath() {
  const hit = CANDIDATES.find(exists);
  if (hit) {
    return hit;
  }
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['chrome'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(exists);
    if (first) {
      return first;
    }
  } catch { /* where/which 找不到就继续报错 */ }
  throw new Error('未找到 Chrome/Chromium，无法做无头测量。设置环境变量 CHROME_PATH 指向 chrome 可执行文件后重试。');
}

module.exports = { chromePath };
