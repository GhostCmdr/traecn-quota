const { test } = require('node:test');
const assert = require('node:assert');

// api.js 在模块加载时就捕获了 globalThis.fetch，所以必须先装桩再 require
function stubFetch(impl) {
  globalThis.fetch = impl;
  delete require.cache[require.resolve('../out/api.js')];
  return require('../out/api.js');
}

// 发送边界会断言目标必须是官方地址，所以桩里的 host 用真值
const auth = { token: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'manual' };
const ok = body => ({ status: 200, text: async () => JSON.stringify(body) });
const pack = (creditsLimit, creditsAmount, desc) => ({
  display_desc: desc,
  entitlement_base_info: { quota: { credits_limit: creditsLimit } },
  usage: { credits_amount: creditsAmount }
});

test('只累加有限额包，remaining = limit - used', async () => {
  const api = stubFetch(async () => ok({ is_credits_billing: true, user_entitlement_pack_list: [pack(3000, 1200, 'A'), pack(2000, 0, 'B')] }));
  const s = await api.fetchCredits(auth);
  assert.strictEqual(s.limit, 5000);
  assert.strictEqual(s.used, 1200);
  assert.strictEqual(s.remaining, 3800);
  assert.strictEqual(s.unlimited, false);
});

test('全是 -1 时整体不限量，limit 记 0', async () => {
  const api = stubFetch(async () => ok({ user_entitlement_pack_list: [pack(-1, 500, '不限量包')] }));
  const s = await api.fetchCredits(auth);
  assert.strictEqual(s.unlimited, true);
  assert.strictEqual(s.limit, 0);
  assert.strictEqual(s.remaining, 0);
  assert.strictEqual(s.packs.length, 1);
  assert.strictEqual(s.packs[0].unlimited, true);
});

test('不限量与有限额混合时，不限量不得把整体判成不限量', async () => {
  const api = stubFetch(async () => ok({ user_entitlement_pack_list: [pack(-1, 10, '赠送'), pack(1000, 400, '月度')] }));
  const s = await api.fetchCredits(auth);
  assert.strictEqual(s.unlimited, false, '有有限额包时不能报不限量');
  assert.strictEqual(s.limit, 1000);
  assert.strictEqual(s.remaining, 600);
  assert.strictEqual(s.used, 400, '已用量只能累加有限额包，否则会把不计额度的包算进来');
});

test('超额使用时 remaining 钳到 0，且用尽的包不进明细', async () => {
  const api = stubFetch(async () => ok({ user_entitlement_pack_list: [pack(100, 250, '超用')] }));
  const s = await api.fetchCredits(auth);
  assert.strictEqual(s.remaining, 0);
  assert.strictEqual(s.used, 250, '累加口径不受明细过滤影响');
  assert.strictEqual(s.packs.length, 0, '明细与状态栏同一口径：用尽的包不展示');
});

test('一个积分包都没有时明确报错，而不是显示 0/0', async () => {
  const api = stubFetch(async () => ok({ user_entitlement_pack_list: [] }));
  await assert.rejects(() => api.fetchCredits(auth), /没有任何积分包/);
});

test('HTTP 200 但业务 code 非 0 要抛错，且 message 只进 remoteDetail', async () => {
  const api = stubFetch(async () => ok({ code: 403, message: '无权限，见 https://evil.example/docs', user_entitlement_pack_list: [] }));
  await assert.rejects(() => api.fetchCredits(auth), err => {
    assert.match(err.message, /code=403/);
    assert.doesNotMatch(err.message, /无权限|evil|http/i, '服务端 message 不该拼进用户可见消息');
    assert.match(err.remoteDetail, /无权限/);
    return true;
  });
});

test('401 提示指向 token 过期或版本不符，并带上 HTTP 状态码', async () => {
  const api = stubFetch(async () => ({ status: 401, text: async () => '' }));
  await assert.rejects(() => api.fetchCredits(auth), err => {
    assert.match(err.message, /401/);
    assert.strictEqual(err.httpStatus, 401, '调用方靠状态码区分真 401，不能靠正文里出现 401');
    return true;
  });
});

// 错误消息会进状态栏 tooltip 和 toast（都按 Markdown 渲染），正文绝不进消息，只挂在 remoteDetail 上给输出面板
test('接口正文不进错误消息；remoteDetail 里也不留可点链接的原料', async () => {
  const hostile = { status: 500, text: async () => '[点我重新激活](https://evil.example/?t=1) ![x](http://192.168.1.1/a.png)' + 'x'.repeat(500) };
  const api = stubFetch(async () => hostile);
  await assert.rejects(() => api.fetchCredits(auth), err => {
    assert.doesNotMatch(err.message, /evil\.example|192\.168|点我/, '正文混进用户可见消息了');
    assert.match(err.message, /HTTP 500/);
    assert.strictEqual(err.httpStatus, 500);
    const detail = err.remoteDetail || '';
    assert.ok(detail, '正文应当留在 remoteDetail 里');
    // 按威胁断言而不是抄字符集：没有 http 字样就构造不出链接、图片和裸 URL
    assert.doesNotMatch(detail, /http/i, '净化后仍残留 URL 原料');
    assert.doesNotMatch(detail, /[[\]()!<>`\\|_*~#]/);
    return true;
  });
});

test('凭证只允许发往官方地址，别的 host 一个字节都不发出去', async () => {
  let called = 0;
  globalThis.fetch = async () => { called++; return ok({ user_entitlement_pack_list: [] }); };
  delete require.cache[require.resolve('../out/api.js')];
  const api = require('../out/api.js');
  await assert.rejects(
    () => api.fetchCredits({ token: 'secret-token', userId: 'u', host: 'https://api.trae.cn.evil.com', edition: 'manual' }),
    /拒绝发送凭证/
  );
  assert.strictEqual(called, 0, '非白名单目标必须在发送前被拦下');
  globalThis.fetch = undefined;
});

test('非 JSON 响应说明可能是代理拦截，且不带正文', async () => {
  const api = stubFetch(async () => ({ status: 200, text: async () => '<html>login gate</html>' }));
  await assert.rejects(() => api.fetchCredits(auth), err => {
    assert.match(err.message, /不是 JSON 内容/);
    assert.doesNotMatch(err.message, /login gate/);
    assert.match(err.remoteDetail || '', /login gate/);
    return true;
  });
});

test('网络超时要转成可读错误', async () => {
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const api = stubFetch(async () => { throw err; });
  await assert.rejects(() => api.fetchCredits(auth), /超时/);
});

// 真机日志里出现过只说 "fetch failed" 的失败，死因其实在 err.cause
test('fetch 失败要把 cause 里的死因带出来', async () => {
  const api = stubFetch(async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND api.trae.cn' } });
  });
  await assert.rejects(() => api.fetchCredits(auth), /fetch failed.*ENOTFOUND/, '只剩 "fetch failed" 等于没报');
});

test('上报的客户端版本头恒定存在（服务端按版本放行）', async () => {
  let seen;
  const api = stubFetch(async (_url, init) => { seen = init.headers; return ok({ user_entitlement_pack_list: [pack(10, 1, 'A')] }); });
  await api.fetchCredits(auth);
  assert.match(seen['x-ide-version'], /^\d+\.\d+\.\d+$/);
  assert.match(seen['x-ide-version-code'], /^\d{8}$/);
});

test('设备标识恒定且格式正确（每次换身份会被服务端判异常流量）', async () => {
  const seen = [];
  const grab = () => stubFetch(async (_u, init) => { seen.push(init.headers['x-device-id']); return ok({ user_entitlement_pack_list: [pack(10, 1, 'A')] }); });
  await grab().fetchCredits(auth);
  await grab().fetchCredits(auth);
  assert.match(seen[0], /^[0-9a-f]{32}$/);
  assert.strictEqual(seen[0], seen[1]);
});
