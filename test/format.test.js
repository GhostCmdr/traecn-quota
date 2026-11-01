const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../out/format.js');

test('fmtCredits 保留 4 位有效数字，w 档进位到亿', () => {
  const table = [
    [0, '0'],
    [5802, '5,802'],
    [10000, '1w'],
    [15300, '1.53w'],
    [10499, '1.05w'],
    [19999, '2w'],
    [1234567, '123.5w'],
    [99999999, '1亿'],
    [123456789, '1.235亿'],
    [1234567890, '12.35亿'],
    [NaN, '-'],
    [Infinity, '-']
  ];
  for (const [v, want] of table) {
    assert.strictEqual(f.fmtCredits(v), want, String(v));
  }
});

test('pctOf：四舍五入、封顶 99，remain >= total 才是 100', () => {
  assert.strictEqual(f.pctOf(1, 3), 33);
  assert.strictEqual(f.pctOf(5802, 7100), 82);
  assert.strictEqual(f.pctOf(999, 1000), 99);
  assert.strictEqual(f.pctOf(1000, 1000), 100);
  assert.strictEqual(f.pctOf(1200, 1000), 100);
  assert.strictEqual(f.pctOf(0, 1000), 0);
  assert.strictEqual(f.pctOf(1, 0), 0);
  assert.strictEqual(f.pctOf(1, NaN), 0);
});

test('formatDateTime：秒级时间戳与 ISO 字符串都到分钟，无到期显示 -', () => {
  const sec = Math.floor(new Date(2026, 11, 31, 18, 38, 23).getTime() / 1000);
  assert.strictEqual(f.formatDateTime(sec), '2026-12-31 18:38');
  assert.strictEqual(f.formatDateTime('2026-12-31T18:38:23'), '2026-12-31 18:38');
  assert.strictEqual(f.formatDateTime('2026-12-31 18:38:23'), '2026-12-31 18:38');
  assert.strictEqual(f.formatDateTime(String(sec)), '2026-12-31 18:38');
  assert.strictEqual(f.formatDateTime(undefined), '-');
  assert.strictEqual(f.formatDateTime(''), '-');
  assert.strictEqual(f.formatDateTime(0), '-');
});
