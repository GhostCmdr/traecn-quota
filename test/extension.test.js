const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const OUT = path.resolve(__dirname, '..', 'out');

function makeVscodeStub(initialConfig = {}, options = {}) {
  const config = {};
  /** 模拟的各作用区设置值；initialConfig 视作全局层，生效值按 workspaceFolder > workspace > global 取 */
  const scopes = {
    global: { ...initialConfig, ...(options.scopes?.global || {}) },
    workspace: { ...(options.scopes?.workspace || {}) },
    workspaceFolder: { ...(options.scopes?.workspaceFolder || {}) }
  };
  const calls = { info: [], error: [] };
  const statusItems = [];
  const logs = [];
  const commands = new Map();
  /** 模拟 VSCode 的加密保管箱：插件侧只能通过 get/store 访问 */
  const secrets = new Map();
  const storeFail = options.storeFail;
  let configChangeHandler = null;
  let themeChangeHandler = null;

  const TARGET_NAMES = { 1: 'global', 2: 'workspace', 3: 'workspaceFolder' };
  const recompute = key => {
    config[key] = undefined;
    for (const name of ['workspaceFolder', 'workspace', 'global']) {
      if (scopes[name][key] !== undefined) {
        config[key] = scopes[name][key];
        return;
      }
    }
  };
  // 作用区里的初值要先算成生效值，否则 get 读不到
  for (const name of ['global', 'workspace', 'workspaceFolder']) {
    for (const key of Object.keys(scopes[name])) {
      recompute(key);
    }
  }

  const fireConfigChange = changedKey => {
    if (configChangeHandler) {
      // 真实语义：affectsConfiguration(section) 当且仅当变更的 key 落在该 section 下
      return configChangeHandler({ affectsConfiguration: section => changedKey.startsWith(section) });
    }
  };

  const vscode = {
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    MarkdownString: class MarkdownString {
      constructor(v) { this.value = v || ''; }
      appendMarkdown(v) { this.value += v; }
    },
    window: {
      activeColorTheme: { kind: 2 },
      onDidChangeActiveColorTheme: fn => { themeChangeHandler = fn; return { dispose() {} }; },
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: '', show() {}, dispose() {} };
        statusItems.push(item);
        return item;
      },
      createOutputChannel: () => ({ appendLine: m => logs.push(String(m)), dispose() {} }),
      showInformationMessage: m => { calls.info.push(m); },
      showErrorMessage: m => { calls.error.push(m); }
    },
    workspace: {
      getConfiguration: () => ({
        get: key => config[key],
        inspect: key => ({
          key,
          globalValue: scopes.global[key],
          workspaceValue: scopes.workspace[key],
          workspaceFolderValue: scopes.workspaceFolder[key]
        }),
        update: async (key, value, target) => {
          const name = TARGET_NAMES[target] || 'global';
          if (value === undefined) {
            delete scopes[name][key];
          } else {
            scopes[name][key] = value;
          }
          recompute(key);
          // 真实环境里 configuration 事件是异步派发的（可能晚于 update 的 resolve），
          // 同步派发会让"自己清空设置项的回声"这类竞态在测试里永远不发生
          setImmediate(() => fireConfigChange(`traecnquota.${key}`));
        }
      }),
      onDidChangeConfiguration: fn => { configChangeHandler = fn; return { dispose() {} }; }
    },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } }
  };

  return {
    vscode, calls, commands, statusItems, secrets, logs,
    /** activate() 要用的 ExtensionContext 替身 */
    context: {
      subscriptions: [],
      secrets: {
        get: async key => secrets.get(key),
        store: async (key, value) => {
          if (storeFail) {
            throw new Error('secret storage unavailable');
          }
          secrets.set(key, value);
        },
        delete: async key => void secrets.delete(key)
      }
    },
    getConfig(key) { return config[key]; },
    getScope(name, key) { return scopes[name][key]; },
    seedSecret(key, value) { secrets.set(key, value); },
    setConfig(key, value) { scopes.global[key] = value; recompute(key); },
    setTheme(kind) {
      vscode.window.activeColorTheme.kind = kind;
      return themeChangeHandler({ kind });
    },
    fireConfigurationChange(changedKey) {
      return fireConfigChange(changedKey);
    }
  };
}

const Module = require('module');
const origLoad = Module._load;
let activeStub = null;
Module._load = function (request, ...rest) {
  if (request === 'vscode') {
    return activeStub.vscode;
  }
  return origLoad.call(this, request, ...rest);
};

function freshRequire() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(OUT)) {
      delete require.cache[key];
    }
  }
  return require(path.join(OUT, 'extension.js'));
}

const packOf = (name, limit, used, day) => ({
  display_desc: name,
  entitlement_base_info: { quota: { credits_limit: limit } },
  usage: { credits_amount: used },
  expire_time: 1792579103 + day * 86400
});
const usageBody = {
  is_credits_billing: true,
  user_entitlement_pack_list: [packOf('包A', 1000, 200, 1), packOf('包B', 500, 100, 2), packOf('包C', 300, 0, 3)]
};

function countingFetch() {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return urls;
}

const tick = () => new Promise(r => setImmediate(r));
/** 后台的 refresh() 是 fire-and-forget，只能空转若干轮等它落定 */
async function settle(tries = 60) {
  for (let i = 0; i < tries; i++) {
    await tick();
  }
}

/** 取 tooltip 里最后一张内联 SVG —— 前面几张是标题行的图标，只有最后一张是数据体 */
function bodySvgOf(stub) {
  const md = String(stub.statusItems[0].tooltip.value || '');
  const hits = md.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/g);
  assert.ok(hits && hits.length >= 2, 'tooltip 应当含图标与数据体两张 SVG');
  return Buffer.from(hits[hits.length - 1].split(',')[1], 'base64').toString('utf8');
}
const dataRows = svg => (svg.match(/font-size="9\.5"/g) || []).length;

/**
 * 把登录态来源隔离到临时目录。必须同时改 APPDATA 和 os.homedir：
 * auth.ts 在 win32 读 APPDATA，darwin/linux 走 os.homedir()，只改 APPDATA 的话
 * 在 mac/linux 上跑测试会去读真机的 storage.json，把真实 token 交进桩里。
 */
function isolateLoginState(tag) {
  const root = path.join(os.tmpdir(), 'traecn-quota-' + tag + '-' + Date.now());
  const prevAppdata = process.env.APPDATA;
  const prevHomedir = os.homedir;
  os.homedir = () => root;
  process.env.APPDATA = root;
  // 与 auth.ts roamingDir() 对应的三平台布局
  const roaming =
    process.platform === 'win32' ? root : process.platform === 'darwin' ? path.join(root, 'Library', 'Application Support') : path.join(root, '.config');
  return {
    /** 造一个客户端登录态目录，返回其 storage.json 该写在哪 */
    storageJson(clientDir) {
      const p = path.join(roaming, clientDir, 'User', 'globalStorage', 'storage.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    },
    restore() {
      os.homedir = prevHomedir;
      process.env.APPDATA = prevAppdata;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('并发刷新被 in-flight 锁合并成一次取数', async () => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;

  const run = activeStub.commands.get('traecnquota.refresh');
  await Promise.all([run(), run(), run()]);
  await settle();
  // 一次刷新 = 积分 + 签到两个并行请求；被锁挡掉的两次一个请求都不该发
  assert.strictEqual(urls.length, before + 2, '并发刷新应当被合并成一次');
  assert.strictEqual(activeStub.calls.info.filter(m => /正在刷新中/.test(m)).length, 2);
  globalThis.fetch = undefined;
});

test('锁释放后仍可再次刷新', async () => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const first = urls.length;
  await activeStub.commands.get('traecnquota.refresh')();
  await settle();
  assert.strictEqual(urls.length, first + 2, '锁必须在刷新结束后释放');
  globalThis.fetch = undefined;
});

test('只改 detailRows 时免网络重绘，明细行数立刻生效', async () => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  const rowsBefore = dataRows(bodySvgOf(activeStub));

  activeStub.setConfig('detailRows', 2);
  await activeStub.fireConfigurationChange('traecnquota.detailRows');
  await settle();

  assert.strictEqual(urls.length, before, '改纯显示项不该发网络请求');
  assert.strictEqual(rowsBefore, 3);
  assert.strictEqual(dataRows(bodySvgOf(activeStub)), 2, 'tooltip 应当立刻按新行数重绘');
  globalThis.fetch = undefined;
});

test('改凭证类设置必须重新拉取', async () => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  activeStub.setConfig('manualToken', 'another-token');
  await activeStub.fireConfigurationChange('traecnquota.manualToken');
  await settle();
  assert.strictEqual(urls.length, before + 2, '凭证变了必须重新取数');
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'another-token', '新粘贴的 token 同样要被收进保管箱');
  assert.ok(!activeStub.getConfig('manualToken'), '收走后立即清空');
  globalThis.fetch = undefined;
});

test('401 时状态栏降级；手动刷新才弹错误提示', async () => {
  globalThis.fetch = async () => ({ status: 401, text: async () => '' });
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.match(activeStub.statusItems[0].text, /TraeCN --/, '启动失败只降级状态栏，不打扰');
  assert.strictEqual(activeStub.calls.error.length, 0);
  await activeStub.commands.get('traecnquota.refresh')();
  assert.ok(activeStub.calls.error.some(m => /401/.test(m)), '手动刷新必须把错误弹出来');
  globalThis.fetch = undefined;
});

test('没有任何可用登录态时，直说未找到，不伪装成 401，也不发请求', async () => {
  // 把 APPDATA 指到一个空目录：两个国内版客户端都「不存在」，且不依赖本机真实登录态
  const isolate = isolateLoginState('none');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.strictEqual(urls.length, 0, '取不到凭证就不该有一个请求');
  assert.match(tip, /未能从任何 Trae 客户端读取登录态/, tip);
  assert.match(tip, /manualToken/, '错误提示要给出下一步该怎么办');
  assert.doesNotMatch(tip, /401|认证失败/, '不能再拿必定失败的兜底 token 把问题伪装成认证失败');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('刷新失败后切主题不会用旧数据盖掉错误提示', async () => {
  let mode = 'ok';
  globalThis.fetch = async url => {
    if (String(url).includes('checkin')) {
      return { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: true }) };
    }
    return mode === 'ok'
      ? { status: 200, text: async () => JSON.stringify(usageBody) }
      : { status: 500, text: async () => 'boom' };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(dataRows(bodySvgOf(activeStub)), 3, '先确认成功渲染过');

  mode = 'fail';
  await activeStub.commands.get('traecnquota.refresh')();
  await settle();
  assert.strictEqual(typeof activeStub.statusItems[0].tooltip, 'string', '失败后 tooltip 是纯文本错误提示');

  activeStub.setTheme(1);
  await settle();
  assert.strictEqual(typeof activeStub.statusItems[0].tooltip, 'string',
    '切主题不得把已过期的旧卡片复活并盖掉错误提示');
  globalThis.fetch = undefined;
});

test('跨天后的旧签到状态不会冒充今天的（页脚回落为「签到未查询」）', async () => {
  globalThis.fetch = async url => String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: true }) }
    : { status: 200, text: async () => JSON.stringify(usageBody) };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.match(bodySvgOf(activeStub), /今日已签到/, '先确认今天查到的是已签到');

  const orig = Date.prototype.toLocaleDateString;
  try {
    // 只把 'sv' 这个日期键翻到别的天，模拟过了午夜之后的一次重绘
    Date.prototype.toLocaleDateString = function (loc) {
      return loc === 'sv' ? '1999-01-01' : orig.call(this, loc);
    };
    activeStub.setTheme(1);
    await settle();
    const svg = bodySvgOf(activeStub);
    assert.match(svg, /签到未查询/, '隔了天的旧状态不能显示成今天的');
    assert.doesNotMatch(svg, /今日已签到/);
  } finally {
    Date.prototype.toLocaleDateString = orig;
  }
  globalThis.fetch = undefined;
});

test('detailRows 被手改成非法值时回落到默认 3 行，而不是空表', async () => {
  globalThis.fetch = async url => (String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: false }) }
    : { status: 200, text: async () => JSON.stringify(usageBody) });
  for (const [bad, want] of [['abc', 3], [{}, 3], [null, 3], [0, 2], [-5, 2], [99, 3], ['2', 2]]) {
    activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: bad, refreshInterval: 0 });
    freshRequire().activate(activeStub.context);
    await settle();
    assert.strictEqual(dataRows(bodySvgOf(activeStub)), want, `detailRows=${JSON.stringify(bad)} 应得 ${want} 行`);
  }
  globalThis.fetch = undefined;
});

test('设置项只是输入口：token 收进保管箱后本项清空，请求头取保管箱里的值', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ manualToken: 'pasted-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'pasted-token', 'token 必须进加密保管箱');
  assert.ok(!activeStub.getConfig('manualToken'), 'settings.json 里不能留明文');
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(h => h === 'Cloud-IDE-JWT pasted-token'), '取数要用保管箱里那份');
  globalThis.fetch = undefined;
});

test('收走 token 时自己清空设置项的回声，既不再刷一轮，也不能把刚存的 token 删掉', async () => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(urls.length, 2, '一次启动只有积分 + 签到两个请求');
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'fake-token',
    '清空设置项是本插件自己干的回声，不能被当成「用户要删除」');
  globalThis.fetch = undefined;
});

test('删空设置项不会动保管箱，只有命令能清除手动 Token', async () => {
  // 隔离到空 APPDATA：清除后回落到"客户端登录态"这条路必须可判定，不能依赖本机是否装了 Trae
  const isolate = isolateLoginState('clear');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'fake-token', '先确认已收进保管箱');

  // 用户删空设置项，或同 profile 的另一个窗口收到这次变更派发的回声——都不足以判定"用户要删凭证"
  activeStub.setConfig('manualToken', '');
  await activeStub.fireConfigurationChange('traecnquota.manualToken');
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'fake-token', '删空设置项绝不能顺手抹掉凭证');

  await activeStub.commands.get('traecnquota.clearManualToken')();
  await settle();
  assert.strictEqual(activeStub.secrets.has('manualToken'), false, '显式命令才该清除');
  assert.match(String(activeStub.statusItems[0].tooltip), /未能从任何 Trae 客户端/, '清除后回落到客户端登录态');
  assert.ok(urls.length >= 2);
  isolate.restore();
  globalThis.fetch = undefined;
});

test('刷新被锁挡住时必须补一轮，不能无声丢掉换凭证的那次变更', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (urls.length === 1) {
      await gate; // 第一笔请求卡住，模拟网络慢：此时锁一直被占
    }
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ detailRows: 3, refreshInterval: 0 });
  activeStub.seedSecret('manualToken', 'first-token');
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();

  activeStub.setConfig('edition', 'cn');
  await activeStub.fireConfigurationChange('traecnquota.edition');
  await settle();
  const during = urls.length;
  release();
  await settle();
  assert.ok(urls.length > during, '被锁挡掉的那轮刷新要在锁释放后补上');
  globalThis.fetch = undefined;
});

test('refreshInterval 被手改成非数字时，不会退化成名 1ms 的循环打接口', async () => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 'abc' });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(urls.length <= 2, `轮询间隔退化了：150ms 内观测到 ${urls.length} 次请求`);
  ext.deactivate(); // 规范化成了 30 分钟，不收掉这条定时器，测试进程会一直等下去
  globalThis.fetch = undefined;
});

test('免网络重绘沿用取数时刻，不把「更新」时间悄悄改成重绘时刻', async () => {
  countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const stampOf = svg => (svg.match(/更新 ([^<]+)/) || [])[1];
  const first = stampOf(bodySvgOf(activeStub));
  assert.ok(first, '页脚应有更新时间');
  await new Promise(resolve => setTimeout(resolve, 1100)); // 让墙上时钟至少走一秒
  activeStub.setTheme(1);
  await settle();
  assert.strictEqual(stampOf(bodySvgOf(activeStub)), first, '重绘不能伪造新鲜度');
  globalThis.fetch = undefined;
});

test('保管箱里已有 token 时，设置项留空照样能取数', async () => {
  const authHeader = [];
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    authHeader.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ manualToken: 'stored-once', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.ok(!activeStub.getConfig('manualToken'), '首轮就该收走');
  const before = urls.length;
  await activeStub.commands.get('traecnquota.refresh')();
  await settle();
  assert.strictEqual(urls.length, before + 2, '设置项为空不该导致读不到凭证');
  assert.strictEqual(authHeader[authHeader.length - 1], 'Cloud-IDE-JWT stored-once');
  globalThis.fetch = undefined;
});

test('保管箱里已有 token 时又填了新的：以新填的为准并覆盖保管箱', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ manualToken: 'brand-new', detailRows: 3, refreshInterval: 0 });
  activeStub.seedSecret('manualToken', 'old-token');
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'brand-new', '设置项是输入口，填了就覆盖旧值');
  assert.ok(seen.length >= 2 && seen.every(h => h === 'Cloud-IDE-JWT brand-new'), '这一轮取数就该用新 token');
  globalThis.fetch = undefined;
});

test('token 填在工作区设置里也会被收走，两个作用区的明文都清掉', async () => {
  countingFetch();
  activeStub = makeVscodeStub({ detailRows: 3, refreshInterval: 0 }, {
    scopes: { workspace: { manualToken: 'ws-token' }, global: { manualToken: 'global-token' } }
  });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  // 生效值是工作区那份，收走的也必须是它
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'ws-token');
  assert.strictEqual(activeStub.getScope('workspace', 'manualToken'), undefined, '.vscode/settings.json 里不能留明文');
  assert.strictEqual(activeStub.getScope('global', 'manualToken'), undefined, '被覆盖的全局值也要清掉');
  globalThis.fetch = undefined;
});

test('保管箱写不进去时不崩，回落到客户端登录态并报未找到', async () => {
  const isolate = isolateLoginState('storefail');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'x', detailRows: 3, refreshInterval: 0 }, { storeFail: true });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(urls.length, 0, '拿不到凭证就不该发请求');
  assert.match(String(activeStub.statusItems[0].tooltip), /保管箱|未能从任何/, '要么说写入失败，要么说没登录态，不能静默');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('edition 被手改成无法识别的值时，直接指出是这个设置写错了', async () => {
  const isolate = isolateLoginState('badedition');
  countingFetch();
  activeStub = makeVscodeStub({ edition: 'trae', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /edition 的值不是可识别的客户端/, tip);
  assert.doesNotMatch(tip, /undefined/, '不该拼出「未找到 undefined 的登录态文件」这种话');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('edition 里被塞进 Markdown 链接时，原值不回显、tooltip 里拼不出可点构造', async () => {
  const isolate = isolateLoginState('inject');
  countingFetch();
  // settings.json 是用户/别的进程手可改的，这里的值会流经 Error → tooltip → toast
  activeStub = makeVscodeStub({
    edition: '[点我重新激活](https://evil.example/x) ![x](http://10.0.0.1/a.png)',
    detailRows: 3,
    refreshInterval: 0
  });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /不是可识别的客户端/, '仍要说清楚是哪项设置错了');
  assert.doesNotMatch(tip, /evil\.example|10\.0\.0\.1|点我|重新激活/, '原值不得回显到按 Markdown 渲染的 tooltip');
  assert.doesNotMatch(tip, /[[\]()!]/, 'tooltip 里不该留下成对的 Markdown 元字符');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('登录态过期导致的 401 要说清是过期，而不是笼统的认证失败', async () => {
  const isolate = isolateLoginState('expired');
  const dir = isolate.storageJson('Trae CN');
  // storage.json 里存明文 JSON 也是合法格式（国际版就是这么存的），省得再造一份 tc 密文
  const login = { token: 'expired-jwt', userId: '42', host: 'https://api.trae.cn', expiredAt: '2020-01-01T00:00:00.000Z' };
  fs.writeFileSync(dir, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(login) }), 'utf8');
  globalThis.fetch = async () => ({ status: 401, text: async () => '' });
  activeStub = makeVscodeStub({ detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /登录态已于 .*2020.* 过期/, tip);
  assert.match(tip, /Trae CN 客户端里重新登录/, tip);
  assert.doesNotMatch(tip, /2020-01-01T00:00:00\.000Z/, '原始串不该原样外发，要本地格式化');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('接口正文只进输出面板，不进 tooltip 和 toast', async () => {
  globalThis.fetch = async url => String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: false }) }
    : { status: 500, text: async () => '[重新激活账号](https://evil.example/x)' };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.doesNotMatch(tip, /evil\.example|重新激活账号/, '正文不能出现在 tooltip 里');
  assert.match(tip, /HTTP 500/, '但状态码要留在提示里');
  await activeStub.commands.get('traecnquota.refresh')();
  assert.ok(activeStub.calls.error.every(m => !/evil\.example|重新激活账号/.test(m)), 'toast 里也不能有');
  assert.ok(activeStub.logs.some(l => /接口返回：重新激活账号/.test(l)), '输出面板要留下这条线索');
  globalThis.fetch = undefined;
});

test('登录态结构不认识时报清楚，且不把脏值带进请求', async () => {
  const isolate = isolateLoginState('badshape');
  const dir = isolate.storageJson('Trae CN');
  fs.writeFileSync(dir, JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: 12345, userId: { nested: 1 } })
  }), 'utf8');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  ext.activate(activeStub.context);
  await settle();
  assert.match(String(activeStub.statusItems[0].tooltip), /没有可用的 accessToken/, '要指出是 accessToken 这一项坏了');
  assert.strictEqual(urls.length, 0, '结构不认识就不该发请求，更不能把 12345 当 token 用');
  isolate.restore();
  globalThis.fetch = undefined;
});
