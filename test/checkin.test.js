const { test } = require('node:test');
const assert = require('node:assert');

// api.js 在模块加载时捕获 globalThis.fetch，必须先装桩再 require
function stubFetch(impl) {
  globalThis.fetch = impl;
  delete require.cache[require.resolve('../out/api.js')];
  return require('../out/api.js');
}

const auth = { token: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'manual' };
const ok = body => ({ status: 200, text: async () => JSON.stringify(body) });

test('claimCheckin 打的是官方 claim 路径且带 req_source', async () => {
  const seen = [];
  const api = stubFetch(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return ok({ code: 0, message: 'success' });
  });
  const r = await api.claimCheckin(auth);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].url, 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim');
  assert.strictEqual(seen[0].body.req_source, 1);
  assert.strictEqual(r.code, 0);
  globalThis.fetch = undefined;
});

test('claimCheckin 遇到业务错误码时抛出，不当成成功', async () => {
  const api = stubFetch(async () => ok({ code: 1001, message: '无法认证' }));
  await assert.rejects(() => api.claimCheckin(auth), /code=1001/);
  globalThis.fetch = undefined;
});
