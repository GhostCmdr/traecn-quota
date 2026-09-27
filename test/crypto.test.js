const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { decryptTcValue } = require(path.join(__dirname, '..', 'out', 'crypto.js'));

// 预生成的密文夹具（不在此处重述加密实现，避免与 src/crypto.ts 同步犯错）。
// 明文固定为 {"token":"jwt-abc","userId":"42","host":"https://api.trae.cn"}
const AES_FIXTURE = 'dGMFEAAABwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwdBgeEi6523mTtc64LRTqgnXN2h83rXc07hS8xvj32djqItDGKY2ygmA8o69N8yGvHrhHCdVvn+jKThRM7bs64rse8WIA/NLJ7fl439pkQDFAJAz3PliAAJImSl+fKqTTmvw2AMZglI8DpuYHHoASiS78hOb9XX6D7welT1QCzYSg==';
const AES_PRIVATE_FIXTURE = 'EjkgIAIDCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQn9Gg6vWYpieJwYA9H97/x7hplITpVqz847NGIUQHA1HBr0UfIt8DoKkrtdGYJWlusJdGA5myWYY8JyYAwnEqjwq9O4s/+gO5y1LQGt4fhV2nXCGvKPXsqI+t60WZr7clUFkQG7IvlNrRa287o+u0UHB2eHCZ3Y2UnBV4cWcknz3A==';
const PLAIN = JSON.stringify({ token: 'jwt-abc', userId: '42', host: 'https://api.trae.cn' });

test('tc/AES 格式能解出明文（Trae 换加密方式时这条会先红）', () => {
  assert.strictEqual(decryptTcValue(AES_FIXTURE), PLAIN);
});

test('tc/AES_PRIVATE 用另一套盐，能解出明文', () => {
  assert.strictEqual(decryptTcValue(AES_PRIVATE_FIXTURE), PLAIN);
});

test('两套盐互不通用：用 AES_PRIVATE 的盐解 AES 的密文会失败', () => {
  const buf = Buffer.from(AES_PRIVATE_FIXTURE, 'base64');
  buf.set(Buffer.from(AES_FIXTURE, 'base64').subarray(0, 6), 0); // 换成 AES 头部 → 走另一套盐
  assert.throws(() => decryptTcValue(buf.toString('base64')), /哈希校验失败|bad decrypt|wrong final block/i);
});

test('长度不足时给出可读错误，而不是崩在 subarray 上', () => {
  assert.throws(() => decryptTcValue(Buffer.alloc(20).toString('base64')), /密文长度不足/);
});

test('未知头部提示 Trae 可能换了加密格式', () => {
  const bogus = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), Buffer.alloc(32, 1), Buffer.alloc(80, 2)]).toString('base64');
  assert.throws(() => decryptTcValue(bogus), /未知的加密类型/);
});

test('密文被篡改时哈希校验拦住，不会返回脏数据', () => {
  const buf = Buffer.from(AES_FIXTURE, 'base64');
  buf[buf.length - 20] ^= 0xff;
  assert.throws(() => decryptTcValue(buf.toString('base64')), /哈希校验失败|bad decrypt|wrong final block/i);
});

test('非 base64 输入不会抛未捕获异常以外的怪错', () => {
  assert.throws(() => decryptTcValue('这不是base64!!'), /密文长度不足|未知的加密类型/);
});
