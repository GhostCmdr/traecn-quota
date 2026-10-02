const { test } = require('node:test');
const assert = require('node:assert');

// api.js 在模块加载时捕获 globalThis.fetch，必须先装桩再 require。
// 不变式：本函数每次都会 delete require.cache 再重新 require，每个用例重新调用。
function stubFetch(impl) {
  globalThis.fetch = impl;
  delete require.cache[require.resolve('../out/api.js')];
  return require('../out/api.js');
}

const ok = body => ({ status: 200, text: async () => JSON.stringify(body) });
const usage = { user_entitlement_pack_list: [{ display_desc: 'A', entitlement_base_info: { quota: { credits_limit: 10 } }, usage: { credits_amount: 1 } }] };

/** 捕获请求头的桩：一次请求，把 headers 记下来 */
function captureHeaders(impl) {
  const seen = [];
  const api = stubFetch(async (_url, init) => {
    seen.push(init.headers);
    return impl();
  });
  return { api, seen };
}

test('auth 带真实设备指纹时，三个指纹头用真实值，version-code 由版本号去点推导', async t => {
  t.after(() => { globalThis.fetch = undefined; });
  const { api, seen } = captureHeaders(() => ok(usage));
  const auth = {
    token: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'manual',
    machineId: 'real-machine-id', deviceId: '2025040112345678', ideVersion: '2.3.87416'
  };
  await api.fetchCredits(auth);
  assert.strictEqual(seen[0]['x-machine-id'], 'real-machine-id');
  assert.strictEqual(seen[0]['x-device-id'], '2025040112345678');
  assert.strictEqual(seen[0]['x-ide-version'], '2.3.87416');
  assert.strictEqual(seen[0]['x-ide-version-code'], '2387416');
});

test('auth 不带指纹时回落到生成值/硬编码值，兜底行为保留', async t => {
  t.after(() => { globalThis.fetch = undefined; });
  const { api, seen } = captureHeaders(() => ok(usage));
  await api.fetchCredits({ token: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'manual' });
  assert.match(seen[0]['x-machine-id'], /^[0-9a-f]{64}$/, '回落的是 hostname 哈希');
  assert.match(seen[0]['x-device-id'], /^[0-9a-f]{32}$/, '回落的是哈希截 32 位');
  assert.match(seen[0]['x-ide-version'], /^\d+\.\d+\.\d+$/, '回落的是内置硬编码版本');
  assert.strictEqual(seen[0]['x-ide-version-code'], '20260401');
});

test('指纹字段部分缺失时，缺的那个回落、有的用真实值', async t => {
  t.after(() => { globalThis.fetch = undefined; });
  const { api, seen } = captureHeaders(() => ok(usage));
  const auth = { token: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'manual', deviceId: '777' };
  await api.fetchCredits(auth);
  assert.strictEqual(seen[0]['x-device-id'], '777');
  assert.match(seen[0]['x-machine-id'], /^[0-9a-f]{64}$/, 'machineId 缺失必须回落，不能发 undefined');
  assert.strictEqual(seen[0]['x-ide-version-code'], '20260401');
});
