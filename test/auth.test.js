const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { normalizeApiHost, DEFAULT_HOST } = require(path.join(__dirname, '..', 'out', 'auth.js'));

test('留空回落到默认国内版地址', () => {
  for (const v of [undefined, '', '   ']) {
    assert.strictEqual(normalizeApiHost(v).host, DEFAULT_HOST);
    assert.strictEqual(normalizeApiHost(v).rejected, undefined);
  }
});

test('合法的 api.trae.cn 端点被接受并去掉尾部斜杠', () => {
  assert.strictEqual(normalizeApiHost('https://api.trae.cn').host, 'https://api.trae.cn');
  assert.strictEqual(normalizeApiHost('https://api.trae.cn/').host, 'https://api.trae.cn');
  assert.strictEqual(normalizeApiHost('https://api.trae.cn:443').host, 'https://api.trae.cn');
});

test('缺协议的裸主机名被拒（旧版本会直接拼进 URL 报 ParseError）', () => {
  const r = normalizeApiHost('api.trae.cn');
  assert.strictEqual(r.host, DEFAULT_HOST);
  assert.match(r.rejected, /不是合法 URL/);
});

test('http 明文被拒，token 不能走非加密通道', () => {
  const r = normalizeApiHost('http://api.trae.cn');
  assert.strictEqual(r.host, DEFAULT_HOST);
  assert.match(r.rejected, /只允许 https/);
});

test('第三方域名被拒，避免凭证外发', () => {
  for (const bad of ['https://evil.com', 'https://trae.cn.evil.com', 'https://api.trae.cn.evil.cn/x']) {
    const r = normalizeApiHost(bad);
    assert.strictEqual(r.host, DEFAULT_HOST, bad + ' 不该被放行');
    assert.match(r.rejected, /主机名不是 api\.trae\.cn/);
  }
});

test('trae.cn 子域与根域同样被拒，通配白名单挡不住悬垂 CNAME', () => {
  for (const bad of ['https://attacker.trae.cn', 'https://trae.cn', 'https://sub.trae.cn', 'https://dev.trae.cn:8443']) {
    const r = normalizeApiHost(bad);
    assert.strictEqual(r.host, DEFAULT_HOST, bad + ' 不该被放行');
  }
});

test('非默认端口被拒，凭证只能发往 443', () => {
  for (const bad of ['https://api.trae.cn:444', 'https://api.trae.cn:80', 'https://api.trae.cn:0']) {
    const r = normalizeApiHost(bad);
    assert.strictEqual(r.host, DEFAULT_HOST, bad + ' 不该被放行');
    assert.match(r.rejected, /默认端口/);
  }
});

test('用户信息段伪装不出绕过：按主机名判定而非字符串匹配', () => {
  assert.strictEqual(normalizeApiHost('https://api.trae.cn@evil.com').host, DEFAULT_HOST);
  assert.strictEqual(normalizeApiHost('https://evil.com@api.trae.cn').host, 'https://api.trae.cn');
});

test('只取 origin，路径与查询串不会带进基地址', () => {
  const r = normalizeApiHost('https://api.trae.cn/evil-path?token=x');
  assert.strictEqual(r.host, 'https://api.trae.cn');
});
