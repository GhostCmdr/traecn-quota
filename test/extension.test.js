const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const OUT = path.resolve(__dirname, '..', 'out');

/**
 * 产品默认 autoCheckin 为 true（package.json 的 default），桩工厂照此默认，不做任何测试侧改写。
 * 「一轮启动 = 几个请求」这类计数用例与签到无关却会被默认开启的 claim 打乱（还多一份排到次日凌晨的兜底定时器），
 * 所以它们走 makeStubCheckinOff —— 关闭态在用例名一眼可见，而不是藏在工厂里。
 */
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
  /** 模拟 globalState：签到日期守卫靠它跨重启记住「今天签过没」。options.globalState 是普通对象，得先取 entries */
  const globalStateMap = new Map(Object.entries(options.globalState || {}));
  /** 用例跑到一半再打坏 memento 读取用：模拟 globalState 存储层出问题这类 tryClaim 之外的抛出点 */
  let stateGetThrows = false;
  const storeFail = options.storeFail;
  /** 让保管箱读取抛错 / 永不返回，模拟系统钥匙串拒绝与授权框挂住 */
  const getFail = options.getFail;
  const getHang = options.getHang;
  const onUpdate = options.onUpdate;
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

  const fireConfigChange = changedKeys => {
    if (configChangeHandler) {
      // 真实语义：affectsConfiguration(section) 当且仅当变更的 key 落在该 section 下。
      // 同一次 settings.json 保存只派发一个多键事件，所以这里要能一次传一组 key。
      const keys = Array.isArray(changedKeys) ? changedKeys : [changedKeys];
      return configChangeHandler({ affectsConfiguration: section => keys.some(k => k.startsWith(section)) });
    }
  };

  /** 宿主识别（buildTooltipBody 的页脚底距）按 appName 分流；options.appName 可在单个用例里换成 Trae */
  const appName = options.appName || 'Visual Studio Code';

  const vscode = {
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    env: { appName },
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
          // 留给测试注入「清理与回声之间的那一小段时间里又落进来一份新值」
          if (onUpdate) {
            onUpdate(key);
          }
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
    getGlobalState: key => globalStateMap.get(key),
    setGlobalStateGetThrows(value) { stateGetThrows = value; },
    /** activate() 要用的 ExtensionContext 替身 */
    context: {
      subscriptions: [],
      globalState: {
        get: key => {
          if (stateGetThrows) {
            throw new Error('globalState 存储层读不出来');
          }
          return globalStateMap.get(key);
        },
        update: async (key, value) => void globalStateMap.set(key, value)
      },
      secrets: {
        get: getHang
          ? () => new Promise(() => undefined)
          : async key => {
              if (getFail) {
                throw new Error(getFail);
              }
              return secrets.get(key);
            },
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
    fireConfigurationChange(changedKeys) {
      return fireConfigChange(changedKeys);
    }
  };
}

/** 与签到无关的用桩：把开关显式拨到关，一轮启动的请求预算才回到「积分 + 签到状态」两个 */
function makeStubCheckinOff(initialConfig = {}, options = {}) {
  return makeVscodeStub({ autoCheckin: false, ...initialConfig }, options);
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

/**
 * activate() 的实例统一在这里收口：deactivate() 销毁排到次日凌晨的签到兜底定时器，
 * fetch 桩一并卸掉。自动签到默认开启后每个用例都可能留下 ref 着的 timer，
 * 靠各用例手写 ext.deactivate() 迟早漏一条并把整个测试进程吊住。
 */
function withCleanup(t, ext) {
  t.after(() => {
    ext.deactivate();
    globalThis.fetch = undefined;
  });
  return ext;
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
    const u = String(url);
    const body = u.includes('checkin_credits/claim')
      ? { code: 0, message: 'success' }
      : u.includes('checkin')
        ? { enable: true, checked_in: false }
        : usageBody;
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

test('并发刷新被 in-flight 锁合并成一次取数', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('锁释放后仍可再次刷新', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const first = urls.length;
  await activeStub.commands.get('traecnquota.refresh')();
  await settle();
  assert.strictEqual(urls.length, first + 2, '锁必须在刷新结束后释放');
  globalThis.fetch = undefined;
});

test('只改 detailRows 时免网络重绘，明细行数立刻生效', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('改凭证类设置必须重新拉取', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('401 时状态栏降级；手动刷新才弹错误提示', async t => {
  globalThis.fetch = async () => ({ status: 401, text: async () => '' });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.match(activeStub.statusItems[0].text, /TraeCN --/, '启动失败只降级状态栏，不打扰');
  assert.strictEqual(activeStub.calls.error.length, 0);
  await activeStub.commands.get('traecnquota.refresh')();
  assert.ok(activeStub.calls.error.some(m => /401/.test(m)), '手动刷新必须把错误弹出来');
  globalThis.fetch = undefined;
});

test('没有任何可用登录态时，直说未找到，不伪装成 401，也不发请求', async t => {
  // 把 APPDATA 指到一个空目录：两个国内版客户端都「不存在」，且不依赖本机真实登录态
  const isolate = isolateLoginState('none');
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('刷新失败后切主题不会用旧数据盖掉错误提示', async t => {
  let mode = 'ok';
  globalThis.fetch = async url => {
    if (String(url).includes('checkin')) {
      return { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: true }) };
    }
    return mode === 'ok'
      ? { status: 200, text: async () => JSON.stringify(usageBody) }
      : { status: 500, text: async () => 'boom' };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('跨天后的旧签到状态不会冒充今天的（页脚回落为「签到未查询」）', async t => {
  globalThis.fetch = async url => String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: true }) }
    : { status: 200, text: async () => JSON.stringify(usageBody) };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('detailRows 被手改成非法值时回落到默认 3 行，而不是空表', async t => {
  globalThis.fetch = async url => (String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: false }) }
    : { status: 200, text: async () => JSON.stringify(usageBody) });
  for (const [bad, want] of [['abc', 3], [{}, 3], [null, 3], [0, 2], [-5, 2], [99, 3], ['2', 2]]) {
    activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: bad, refreshInterval: 0 });
    withCleanup(t, freshRequire()).activate(activeStub.context);
    await settle();
    assert.strictEqual(dataRows(bodySvgOf(activeStub)), want, `detailRows=${JSON.stringify(bad)} 应得 ${want} 行`);
  }
  globalThis.fetch = undefined;
});

test('设置项只是输入口：token 收进保管箱后本项清空，请求头取保管箱里的值', async t => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'pasted-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'pasted-token', 'token 必须进加密保管箱');
  assert.ok(!activeStub.getConfig('manualToken'), 'settings.json 里不能留明文');
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(h => h === 'Cloud-IDE-JWT pasted-token'), '取数要用保管箱里那份');
  globalThis.fetch = undefined;
});

test('收走 token 时自己清空设置项的回声，既不再刷一轮，也不能把刚存的 token 删掉', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(urls.length, 2, '一次启动只有积分 + 签到两个请求');
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'fake-token',
    '清空设置项是本插件自己干的回声，不能被当成「用户要删除」');
  globalThis.fetch = undefined;
});

test('删空设置项不会动保管箱，只有命令能清除手动 Token', async t => {
  // 隔离到空 APPDATA：清除后回落到"客户端登录态"这条路必须可判定，不能依赖本机是否装了 Trae
  const isolate = isolateLoginState('clear');
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('刷新被锁挡住时必须补一轮，不能无声丢掉换凭证的那次变更', async t => {
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
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  activeStub.seedSecret('manualToken', 'first-token');
  const ext = withCleanup(t, freshRequire());
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

test('refreshInterval 被手改成非数字时，不会退化成名 1ms 的循环打接口', async t => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 'abc' });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(urls.length <= 2, `轮询间隔退化了：150ms 内观测到 ${urls.length} 次请求`);
  ext.deactivate(); // 规范化成了 30 分钟，不收掉这条定时器，测试进程会一直等下去
  globalThis.fetch = undefined;
});

test('免网络重绘沿用取数时刻，不把「更新」时间悄悄改成重绘时刻', async t => {
  countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('保管箱里已有 token 时，设置项留空照样能取数', async t => {
  const authHeader = [];
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    authHeader.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'stored-once', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('保管箱里已有 token 时又填了新的：以新填的为准并覆盖保管箱', async t => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    const body = String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'brand-new', detailRows: 3, refreshInterval: 0 });
  activeStub.seedSecret('manualToken', 'old-token');
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'brand-new', '设置项是输入口，填了就覆盖旧值');
  assert.ok(seen.length >= 2 && seen.every(h => h === 'Cloud-IDE-JWT brand-new'), '这一轮取数就该用新 token');
  globalThis.fetch = undefined;
});

test('token 填在工作区设置里也会被收走，两个作用区的明文都清掉', async t => {
  countingFetch();
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 }, {
    scopes: { workspace: { manualToken: 'ws-token' }, global: { manualToken: 'global-token' } }
  });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  // 生效值是工作区那份，收走的也必须是它
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'ws-token');
  assert.strictEqual(activeStub.getScope('workspace', 'manualToken'), undefined, '.vscode/settings.json 里不能留明文');
  assert.strictEqual(activeStub.getScope('global', 'manualToken'), undefined, '被覆盖的全局值也要清掉');
  globalThis.fetch = undefined;
});

test('保管箱写不进去时不崩，回落到客户端登录态并报未找到', async t => {
  const isolate = isolateLoginState('storefail');
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'x', detailRows: 3, refreshInterval: 0 }, { storeFail: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(urls.length, 0, '拿不到凭证就不该发请求');
  assert.match(String(activeStub.statusItems[0].tooltip), /保管箱|未能从任何/, '要么说写入失败，要么说没登录态，不能静默');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('edition 被手改成无法识别的值时，直接指出是这个设置写错了', async t => {
  const isolate = isolateLoginState('badedition');
  countingFetch();
  activeStub = makeStubCheckinOff({ edition: 'trae', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /edition 的值不是可识别的客户端/, tip);
  assert.doesNotMatch(tip, /undefined/, '不该拼出「未找到 undefined 的登录态文件」这种话');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('edition 里被塞进 Markdown 链接时，原值不回显、tooltip 里拼不出可点构造', async t => {
  const isolate = isolateLoginState('inject');
  countingFetch();
  // settings.json 是用户/别的进程手可改的，这里的值会流经 Error → tooltip → toast
  activeStub = makeStubCheckinOff({
    edition: '[点我重新激活](https://evil.example/x) ![x](http://10.0.0.1/a.png)',
    detailRows: 3,
    refreshInterval: 0
  });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /不是可识别的客户端/, '仍要说清楚是哪项设置错了');
  assert.doesNotMatch(tip, /evil\.example|10\.0\.0\.1|点我|重新激活/, '原值不得回显到按 Markdown 渲染的 tooltip');
  assert.doesNotMatch(tip, /[[\]()!]/, 'tooltip 里不该留下成对的 Markdown 元字符');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('登录态过期导致的 401 要说清是过期，而不是笼统的认证失败', async t => {
  const isolate = isolateLoginState('expired');
  const dir = isolate.storageJson('Trae CN');
  // storage.json 里存明文 JSON 也是合法格式（国际版就是这么存的），省得再造一份 tc 密文
  const login = { token: 'expired-jwt', userId: '42', host: 'https://api.trae.cn', expiredAt: '2020-01-01T00:00:00.000Z' };
  fs.writeFileSync(dir, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify(login) }), 'utf8');
  globalThis.fetch = async () => ({ status: 401, text: async () => '' });
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const tip = String(activeStub.statusItems[0].tooltip);
  assert.match(tip, /登录态已于 .*2020.* 过期/, tip);
  assert.match(tip, /Trae CN 客户端里重新登录/, tip);
  assert.doesNotMatch(tip, /2020-01-01T00:00:00\.000Z/, '原始串不该原样外发，要本地格式化');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('接口正文只进输出面板，不进 tooltip 和 toast', async t => {
  globalThis.fetch = async url => String(url).includes('checkin')
    ? { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: false }) }
    : { status: 500, text: async () => '[重新激活账号](https://evil.example/x)' };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
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

test('登录态结构不认识时报清楚，且不把脏值带进请求', async t => {
  const isolate = isolateLoginState('badshape');
  const dir = isolate.storageJson('Trae CN');
  fs.writeFileSync(dir, JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: 12345, userId: { nested: 1 } })
  }), 'utf8');
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.match(String(activeStub.statusItems[0].tooltip), /没有可用的 accessToken/, '要指出是 accessToken 这一项坏了');
  assert.strictEqual(urls.length, 0, '结构不认识就不该发请求，更不能把 12345 当 token 用');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('保管箱读取报错时回落到客户端登录态，而不是整轮失败', async t => {
  const isolate = isolateLoginState('getfail');
  fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: 'client-token', userId: '42', host: 'https://api.trae.cn' })
  }), 'utf8');
  const heads = [];
  globalThis.fetch = async (url, init) => {
    heads.push(init.headers.Authorization);
    return { status: 200, text: async () => JSON.stringify(String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 }, { getFail: 'keychain unavailable' });
  activeStub.seedSecret('manualToken', 'vault-token');
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(heads.length, 2, '钥匙串读不出来也得把数取回来');
  assert.ok(heads.every(h => h === 'Cloud-IDE-JWT client-token'), '读不出保管箱就改用客户端登录态');
  assert.match(activeStub.statusItems[0].text, /1,500 \(83%\)/, '状态栏要出数，不能停在失败态');
  assert.ok(activeStub.logs.some(l => /保管箱读取失败/.test(l)), '降级要在输出面板留痕');
  isolate.restore();
  globalThis.fetch = undefined;
});

test('保管箱读取挂住时按超时放行，刷新锁不能把状态栏永久钉在「刷新中」', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const isolate = isolateLoginState('gethang');
    fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
      'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: 'client-token', userId: '42', host: 'https://api.trae.cn' })
    }), 'utf8');
    const heads = [];
    globalThis.fetch = async (url, init) => {
      heads.push(init.headers.Authorization);
      return { status: 200, text: async () => JSON.stringify(String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
    };
    activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 }, { getHang: true });
    activeStub.seedSecret('manualToken', 'vault-token');
    const ext = withCleanup(t, freshRequire());
    ext.activate(activeStub.context);
    await settle();
    assert.strictEqual(heads.length, 0, '挂住期间发不出请求');
    assert.match(activeStub.statusItems[0].text, /TraeCN --/, '还没取到数就保持初始占位');
    mock.timers.tick(5000);
    await settle();
    assert.strictEqual(heads.length, 2, '超过 5s 必须放行去取数');
    assert.ok(heads.every(h => h === 'Cloud-IDE-JWT client-token'));
    assert.match(activeStub.statusItems[0].text, /1,500 \(83%\)/, '超时放行后照样出数');
    const before = heads.length;
    // 命令内部还要再读一次保管箱（同样挂住），所以不能 await 它返回，只能再放行一次超时
    void activeStub.commands.get('traecnquota.refresh')();
    mock.timers.tick(5000);
    await settle();
    assert.strictEqual(heads.length, before + 2, '挂住的那轮不能永久占着刷新锁');
    isolate.restore();
  } finally {
    mock.timers.reset();
    globalThis.fetch = undefined;
  }
});

test('不限量积分包：状态栏与悬浮窗显示 ∞ 和「不限量」，不是 0 / 0', async t => {
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => JSON.stringify(String(url).includes('checkin')
      ? { enable: true, checked_in: true }
      : { user_entitlement_pack_list: [packOf('赠送包', -1, 5, 1)] })
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.statusItems[0].text, '$(trae-sparkle) ∞');
  const svg = bodySvgOf(activeStub);
  assert.ok(svg.includes('∞') && svg.includes('不限量'), svg.slice(0, 200));
  assert.doesNotMatch(svg, /0 \/ 0/);
  globalThis.fetch = undefined;
});

test('不限量与有限额包并存：整体仍按有限额算占比，只有那一行是 ∞', async t => {
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => JSON.stringify(String(url).includes('checkin')
      ? { enable: true, checked_in: false }
      : { user_entitlement_pack_list: [packOf('赠送包', -1, 5, 1), packOf('月度包', 1000, 200, 2)] })
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.statusItems[0].text, '$(trae-sparkle) 800 (80%)');
  const svg = bodySvgOf(activeStub);
  assert.ok(svg.includes('∞') && svg.includes('不限量'), '明细里那行要标成不限量');
  globalThis.fetch = undefined;
});

/** 根 <svg> 标签的 height —— 正则必须锚定 svg 开标签，内部 rect/line 也有自己的 height 属性 */
const rootSvgHeight = svg => {
  const m = /<svg [^>]*\bheight="(\d+)"/.exec(svg);
  assert.ok(m, '根 <svg> 标签没找到 height：' + svg.slice(0, 200));
  return Number(m[1]);
};

/**
 * 双宿主真机逐像素实测（2026-10-03，preview/measure-host-gap.js）：
 * 行内图下方宿主额外给 VS Code ≈8 单位、Trae ≈3 单位（截图边缘 ±1px 折 ±0.9）。
 * 页脚墨迹底到 SVG 底自带 10.7 单位，要让它等于设计契约 A=10，扣减 = 0.7 + 宿主贡献。
 * detailRows=3 时 footBase=189，H = 189+1+11-hostPad。
 */
test('VS Code 宿主：SVG 高度按实测宿主贡献 8 定，扣 9', async t => {
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => JSON.stringify(String(url).includes('checkin')
      ? { enable: true, checked_in: false }
      : usageBody)
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(rootSvgHeight(bodySvgOf(activeStub)), 192, 'VS Code 路径高度 = 201-9');
  globalThis.fetch = undefined;
});

test('Trae 宿主（appName 含 trae）：SVG 比 VS Code 路径高 5（扣 4 对扣 9）', async t => {
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => JSON.stringify(String(url).includes('checkin')
      ? { enable: true, checked_in: false }
      : usageBody)
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 }, { appName: 'Trae CN' });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(rootSvgHeight(bodySvgOf(activeStub)), 197, 'Trae 路径少减的 5 要留在 SVG 里');
  assert.strictEqual(rootSvgHeight(bodySvgOf(activeStub)) - 192, 5, '与 VS Code 路径的差值必须是 5');
  globalThis.fetch = undefined;
});

test('hostOverride 只有官方地址会真的生效；写别的地址时一个字节都不发往它', async t => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return { status: 200, text: async () => JSON.stringify(usageBody) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, hostOverride: 'https://api.trae.cn' });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.ok(urls.length >= 2, '配置链路要真的发出请求');
  assert.ok(urls.every(u => u.startsWith('https://api.trae.cn/trae/')), urls.join(','));

  urls.length = 0;
  activeStub.setConfig('hostOverride', 'https://evil.example');
  await activeStub.fireConfigurationChange('traecnquota.hostOverride');
  await settle();
  assert.ok(urls.length >= 2, '被拒绝也要回落到默认地址照常取数');
  assert.ok(urls.every(u => u.startsWith('https://api.trae.cn/trae/')), '凭证绝不能发往白名单外的主机');
  assert.ok(activeStub.logs.some(l => /已忽略 hostOverride/.test(l)), '忽略要留痕，不能静默改掉用户填的值');
  globalThis.fetch = undefined;
});

test('清理设置项的窗口期内又落进一份新 token：新值必须被收走，不能当回声吞掉', async t => {
  const heads = [];
  globalThis.fetch = async (url, init) => {
    heads.push(init.headers.Authorization);
    return { status: 200, text: async () => JSON.stringify(String(url).includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  let harness;
  let injected = false;
  harness = activeStub = makeStubCheckinOff({ manualToken: 'first-token', detailRows: 3, refreshInterval: 0 }, {
    // 「已存进保管箱、正在清空设置项」那几毫秒里用户又粘了一次
    onUpdate: key => {
      if (key === 'manualToken' && !injected) {
        injected = true;
        harness.setConfig('manualToken', 'second-token');
      }
    }
  });
  const ext = withCleanup(t, freshRequire());
  ext.activate(harness.context);
  await settle();
  assert.strictEqual(harness.secrets.get('manualToken'), 'second-token', '窗口期内的新值不能被吞掉');
  assert.ok(!harness.getConfig('manualToken'), 'settings.json 里不能留下明文');
  assert.ok(heads.some(h => h === 'Cloud-IDE-JWT second-token'), '取数要用最新那份');
  globalThis.fetch = undefined;
});

test('refreshInterval 写成空值或布尔不是「关闭」：只有显式 0 才停定时器', async t => {
  countingFetch();
  for (const bad of ['', true, 'abc']) {
    activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: bad });
    const ext = withCleanup(t, freshRequire());
    ext.activate(activeStub.context);
    await settle();
    assert.ok(!activeStub.logs.some(l => /已关闭积分自动刷新/.test(l)), JSON.stringify(bad) + ' 不该被当成关闭');
    ext.deactivate();
  }
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.ok(activeStub.logs.some(l => /已关闭积分自动刷新/.test(l)), '显式 0 才是关闭');
  ext.deactivate();
  globalThis.fetch = undefined;
});

test('服务端把 display_desc 写成数字时按默认名渲染，不能把 TypeError 摆到界面上', async t => {
  const body = '{"user_entitlement_pack_list":[{"display_desc":12345,"entitlement_base_info":{"quota":{"credits_limit":1000}},"usage":{"credits_amount":200}}]}';
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => String(url).includes('checkin') ? JSON.stringify({ enable: true, checked_in: false }) : body
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.match(activeStub.statusItems[0].text, /\$\(trae-sparkle\) 800 \(80%\)/, activeStub.statusItems[0].text);
  const tip = String(activeStub.statusItems[0].tooltip.value || activeStub.statusItems[0].tooltip);
  assert.doesNotMatch(tip, /TypeError|is not a function|not iterable/, tip.slice(0, 200));
  assert.ok(bodySvgOf(activeStub).includes('积分包'), '脏名称要回落成可读的默认名');
  globalThis.fetch = undefined;
});

test('签到请求比积分慢时锁不能提前放手，否则旧签到会盖掉新一轮', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  let mode = 'fail';
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    if (String(url).includes('checkin')) {
      await gate;
      return { status: 200, text: async () => JSON.stringify({ enable: true, checked_in: true }) };
    }
    return mode === 'fail'
      ? { status: 500, text: async () => 'boom' }
      : { status: 200, text: async () => JSON.stringify(usageBody) };
  };
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.match(activeStub.statusItems[0].text, /刷新中/, '积分先失败但签到还挂着，这一轮就没结束');
  mode = 'ok';
  await activeStub.commands.get('traecnquota.refresh')();
  assert.ok(activeStub.calls.info.some(m => /正在刷新中/.test(m)), '锁必须覆盖到最后一个请求落定');
  assert.strictEqual(urls.filter(u => !String(u).includes('checkin')).length, 1, '挂着的签到期间不能又起一轮取数');
  release();
  await settle();
  assert.match(activeStub.statusItems[0].text, /TraeCN --/, '两个请求都落定后按积分失败降级');
  globalThis.fetch = undefined;
});

test('额度显示按量级压缩：1 万以内千分位，1 万~1 亿用 w，1 亿以上用亿', () => {
  // api.js 在加载时就断言全局 fetch 存在，纯格式化测试也要先装桩
  countingFetch();
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  const table = [
    [0, '0'], [5802, '5,802'], [9999, '9,999'], [10000, '1w'], [15300, '1.5w'],
    [999999, '100w'], [1234567, '123.5w'], [98765432, '9,877w'], [123456789, '1.2亿']
  ];
  for (const [v, want] of table) {
    assert.strictEqual(ext.fmtCredits(v), want, String(v));
  }
});

test('名称列格数按额度串实测宽度让位；1 万以内的数据与定稿布局一像素不差', () => {
  countingFetch();
  activeStub = makeStubCheckinOff({ detailRows: 3, refreshInterval: 0 });
  const ext = freshRequire();
  assert.strictEqual(ext.nameCells('2,000 / 2,000'), 10, '定稿数据下 5 个汉字的名称必须原样放得下');
  assert.strictEqual(ext.nameCells('1,202 / 2,000'), 10);
  assert.strictEqual(ext.nameCells('100w / 100w'), 11);
  assert.strictEqual(ext.nameCells('1.5w / 2w'), 11, '窄额度串回到 11 格上限');
  assert.strictEqual(ext.nameCells('9,999 / 10,000'), 9, '额度串变宽就得让出名称列');
  assert.ok(ext.nameCells('9,877w / 9,877w') < 11);
  // 推进宽度估算必须贴住 Chrome 像素扫描的实测墨迹宽，否则整套列间距推导都不成立
  const measured = [['2,000 / 2,000', 63], ['9,999 / 10,000', 69], ['1.5w / 2w', 47], ['100w / 100w', 62], ['9,999w / 9,999w', 79]];
  for (const [s, px] of measured) {
    assert.ok(Math.abs(ext.textPx(s) - px) <= 1.5, s + ' 估算 ' + ext.textPx(s).toFixed(1) + '，实测 ' + px);
  }
  globalThis.fetch = undefined;
});

test('大额度实测：明细行按 w 压缩后渲染，名称与额度两列不重叠', async t => {
  globalThis.fetch = async url => ({
    status: 200,
    text: async () => JSON.stringify(String(url).includes('checkin')
      ? { enable: true, checked_in: false }
      : { user_entitlement_pack_list: [packOf('限时活动赠送积分包', 1234567, 234567, 1)] })
  });
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.statusItems[0].text, '$(trae-sparkle) 100w (81%)');
  const svg = bodySvgOf(activeStub);
  const quota = /font-size="11" text-anchor="end"><tspan[^>]*>([^<]*)<\/tspan><tspan[^>]*> \/ ([^<]*)<\/tspan>/.exec(svg);
  assert.ok(quota, '明细行额度单元格没找到：' + svg.slice(0, 300));
  assert.strictEqual(quota[1] + ' / ' + quota[2], '100w / 123.5w');
  const name = /<text x="0" y="\d+" fill="[^"]*" font-size="11">([^<]*)<\/text>/.exec(svg);
  assert.ok(name && name[1].includes('…'), '9 字名称超过 11 格上限，必须仍被截断：' + (name && name[1]));
  const gap = 145.6 - ext.textPx(quota[1] + ' / ' + quota[2]) - ext.textPx(name[1]);
  assert.ok(gap >= 19, '两列字面间距实测 ' + gap.toFixed(1) + 'px，不该低于 20px');
  globalThis.fetch = undefined;
});

const claimsOf = urls => urls.filter(u => u.includes('checkin_credits/claim'));

test('开启自动签到时，刷新会领一次签到并记下今天日期', async t => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '应当恰好发一次 claim');
  assert.match(activeStub.getGlobalState('traecnquota.lastCheckinSuccessDate'), /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(activeStub.calls.info.some(m => /签到成功/.test(m)), true, '成功要弹通知');
  // 签成后兜底定时器已被 clearCheckinTimer 销毁，withCleanup 的 deactivate 只收刷新定时器
});

test('当天已签成功时，再刷新只刷积分不再发 claim', async t => {
  const today = new Date().toLocaleDateString('sv');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true }, { globalState: { 'traecnquota.lastCheckinSuccessDate': today } });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(claimsOf(urls).length, 0, '今天签过就不该再发 claim');
  // 日期守卫拦下的是「要不要领」，不是「要不要查今天签没签」：status 仍每轮查、积分照常取。
  // 所以这一轮的预算是精确的 2（usage + status），守卫若被改成连状态查询一起跳过就会红。
  assert.strictEqual(urls.length, 2, `当天已签成的一轮启动应当只有积分+签到状态两个请求，实发 ${urls.length}：${urls.join(', ')}`);
  assert.deepStrictEqual([...activeStub.calls.info, ...activeStub.calls.error], [], '自动路径被守卫挡掉时必须完全静默');
});

test('关掉自动签到后不发 claim，但手动命令仍能签', async t => {
  const urls = countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.getConfig('autoCheckin'), false, '这一轮确实是用户拨到关');
  assert.strictEqual(claimsOf(urls).length, 0);
  assert.strictEqual(urls.length, 2, '关闭态的一轮启动就是积分+签到状态两个请求');
  await activeStub.commands.get('traecnquota.checkin')();
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '手动签到命令要能绕过日期守卫之外的关闭态');
});

/**
 * 产品契约（优先于计划原文）：只要当天已签成功，任何路径都不得再发 claim——
 * 手动点击退化为「刷新 + 提示已签」。特意用 autoCheckin:false 起手，
 * 证明守卫分支不受开关约束（若守卫被挪回 maybeAutoClaim，开关关着就轮不到它拦，这条会红）。
 */
test('当天已签成功后再点手动命令：不发 claim，积分照常刷新，提示已签到', async t => {
  const today = new Date().toLocaleDateString('sv');
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: false }, { globalState: { 'traecnquota.lastCheckinSuccessDate': today } });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  await activeStub.commands.get('traecnquota.checkin')();
  await settle();
  assert.strictEqual(claimsOf(urls).length, 0, '签成后手动点击不得再发 claim');
  assert.ok(urls.length > before, '守卫分支要让用户拿到最新余额，积分刷新照常发生');
  assert.ok(activeStub.calls.info.some(m => /已签到/.test(m)), '要提示今日已签过、无需重签');
  assert.strictEqual(activeStub.calls.info.some(m => /签到成功/.test(m)), false, '不能再弹「签到成功」');
});

test('footerHostPad：Trae 系宿主扣 4（实测容器只补 3 单位），其余扣 9（实测补 8 单位）', () => {
  countingFetch(); // freshRequire 会连带加载 api.js，它要求 fetch 已就位
  const { footerHostPad } = freshRequire();
  assert.strictEqual(footerHostPad('Trae CN'), 4);
  assert.strictEqual(footerHostPad('TRAE SOLO CN'), 4);
  assert.strictEqual(footerHostPad('TraeCode CN'), 4);
  assert.strictEqual(footerHostPad('Visual Studio Code'), 9);
  assert.strictEqual(footerHostPad('Cursor'), 9);
  assert.strictEqual(footerHostPad(undefined), 9);
  globalThis.fetch = undefined;
});

/**
 * 产品默认是「开」（package.json 的 default: true）。这条不传 autoCheckin，
 * 走的就是真实用户装好插件那一刻的路径：默认开启 + 默认开启时的请求预算。
 * 关掉开关的用例只能证明「关着不发」，证明不了「默认会发」——那是整个功能的全部价值。
 */
test('不写 autoCheckin 设置时按产品默认开启：一次启动恰好领一次，且总预算为三个请求', async t => {
  const urls = countingFetch();
  // 刻意不写 autoCheckin，也不经 makeStubCheckinOff：这就是用户装好插件后 settings.json 里没这一项的真路径
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.getConfig('autoCheckin'), undefined, '确认这一轮确实没给任何 autoCheckin 值');
  assert.strictEqual(claimsOf(urls).length, 1, '默认态必须真的领一次签到');
  assert.strictEqual(urls.length, 3, `默认开启的一轮启动应为积分+签到状态+领取三个请求，实发 ${urls.length}：${urls.join(', ')}`);
  assert.match(activeStub.getGlobalState('traecnquota.lastCheckinSuccessDate'), /^\d{4}-\d{2}-\d{2}$/, '领成功要写下日期守卫');
});

/**
 * 「默认开」有两个真相来源：package.json 的 default 与 src/extension.ts 的 DEFAULT_AUTO_CHECKIN。
 * 任一处漂成 false，上面的端到端用例就会失去锚点；这里把两处钉在一起。
 */
test('package.json 的 autoCheckin 默认值与 extension.ts 的 DEFAULT_AUTO_CHECKIN 同源且为 true', () => {
  countingFetch(); // out/api.js 加载期断言 globalThis.fetch 存在
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  const schema = pkg.contributes.configuration.properties['traecnquota.autoCheckin'];
  assert.strictEqual(schema.default, true, '面向用户的默认必须是开启，否则「每天自动领一次」落空');
  assert.strictEqual(schema.type, 'boolean');
  const ext = freshRequire();
  assert.strictEqual(ext.DEFAULT_AUTO_CHECKIN, true, '代码侧兜底常量必须与 package.json 同值');
  assert.strictEqual(ext.DEFAULT_AUTO_CHECKIN, schema.default, '两处默认值不得漂移');
  globalThis.fetch = undefined;
});

test('claim 失败时弹错误通知，且不写成功日期，下次刷新还能重试', async t => {
  const urls = countingFetch();
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('checkin_credits/claim')) {
      return { status: 200, text: async () => JSON.stringify({ code: 500, message: '服务繁忙' }) };
    }
    return { status: 200, text: async () => JSON.stringify(u.includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(activeStub.getGlobalState('traecnquota.lastCheckinSuccessDate'), undefined, '失败不能记成成功');
  assert.strictEqual(activeStub.calls.error.filter(m => /签到失败/.test(m)).length >= 1, true, '失败要弹错误通知');
  // 签失败会留下排到次日凌晨的兜底定时器，由 withCleanup 的 deactivate 收掉，否则测试进程一直等下去
});

/**
 * 兜底定时器的回调必须自带 .catch：tryClaim 的 try/catch 只盖得住它自己那一段，
 * 日期守卫读 memento 这类前置抛出点在外面，Node 对 floating rejection 默认直接终止进程。
 * 观测办法是把 globalState 读取打坏，再用假定时器真的跳出次日凌晨那一格：
 * 有 catch → 只多一行日志；没 catch → 这颗 rejection 无人认领、用例判红（删掉 catch 做过变异实测）。
 */
test('定时补签抛出异常时只留一行日志，不把 unhandledRejection 抛给进程', async t => {
  const urls = [];
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('checkin_credits/claim')) {
      return { status: 500, text: async () => 'boom' };
    }
    return { status: 200, text: async () => JSON.stringify(u.includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
    const ext = withCleanup(t, freshRequire());
    ext.activate(activeStub.context);
    await settle();
    assert.strictEqual(claimsOf(urls).length, 1, '先让 claim 真的失败一次，兜底定时器才存在');
    activeStub.setGlobalStateGetThrows(true);
    mock.timers.tick(25 * 60 * 60 * 1000);
    await settle();
    assert.ok(activeStub.logs.some(l => /定时补签失败：globalState 存储层读不出来/.test(l)), '补签的异常要以日志收尾');
    assert.strictEqual(claimsOf(urls).length, 1, '守卫都没走过去，不该把 claim 补发出去');
    assert.strictEqual(activeStub.getGlobalState('traecnquota.lastCheckinSuccessDate'), undefined, '抛出的一轮不能记成签到成功');
  } finally {
    mock.timers.reset();
    globalThis.fetch = undefined;
  }
});

/**
 * 「通知里不得出现领了多少积分」得能被反证：桩里让 claim 真的回一份带数量的响应（8888），
 * 再钉住成功通知就是那句定稿文案、数量在任何对外面上都不出现。
 * 先断言这一轮确实领成功了——否则「压根没发通知」也会让这条空过（前一版正是如此）。
 */
test('签到通知里不出现领取积分数值', async t => {
  const urls = countingFetch();
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    const body = u.includes('checkin_credits/claim')
      ? { code: 0, message: 'success', credits_amount: 8888, data: { credits: 8888 } }
      : u.includes('checkin')
        ? { enable: true, checked_in: false }
        : usageBody;
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '这一轮必须真的领一次，否则下面的断言是空过的');
  assert.match(activeStub.getGlobalState('traecnquota.lastCheckinSuccessDate'), /^\d{4}-\d{2}-\d{2}$/, '写下日期守卫＝走的是成功分支');
  const toasts = [...activeStub.calls.info, ...activeStub.calls.error];
  assert.deepStrictEqual(toasts.filter(m => /签到/.test(m)), ['TraeCN 签到成功'], '成功通知就是定稿那一句，没有别的变体');
  assert.strictEqual(toasts.some(m => m.includes('8888')), false, '接口回的领取数量不许进 toast');
  assert.strictEqual(bodySvgOf(activeStub).includes('8888'), false, '领取数量也不许进悬浮窗');
});

test('接口正文只进输出面板，签到失败的 toast 与 tooltip 里都不留正文', async t => {
  const urls = countingFetch();
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('checkin_credits/claim')) {
      return { status: 500, text: async () => '[重新激活账号](https://evil.example/x)' };
    }
    return { status: 200, text: async () => JSON.stringify(u.includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.ok(activeStub.calls.error.some(m => /签到失败/.test(m)), '失败要弹错误通知');
  const toasts = activeStub.calls.error.join('\n');
  assert.doesNotMatch(toasts, /evil\.example|重新激活账号/, 'toast 里不能有接口正文');
  assert.doesNotMatch(String(activeStub.statusItems[0].tooltip), /evil\.example/, 'tooltip 同样不能');
  assert.match(String(activeStub.statusItems[0].text), /1,500/, '签到挂了不影响积分照常展示');
  // 只认净化后的形态：裸 URL 必须被换成 [链接已隐去]。「或 接口返回」那个分支几乎永真，留着等于没断言
  assert.ok(activeStub.logs.some(l => /接口返回：.*链接已隐去/.test(l)), '正文线索要以净化形态留在输出面板');
});

test('claim 正在飞的时候重复触发不会叠加第二次请求', async t => {
  const urls = countingFetch();
  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async url => {
    const u = String(url);
    urls.push(u);
    if (u.includes('checkin_credits/claim')) {
      await gate; // claim 挂住期间，refreshing 锁已释放，手动命令能立刻进来
    }
    return { status: 200, text: async () => JSON.stringify(u.includes('checkin') ? { enable: true, checked_in: false } : usageBody) };
  };
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '启动刷新已经发起一次 claim');
  await activeStub.commands.get('traecnquota.checkin')();
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '同一时刻只允许一次 claim');
  release();
  await settle();
  assert.strictEqual(claimsOf(urls).length, 1, '放锁后也不该补发');
});

/**
 * autoCheckin 既不在 REFRESH_KEYS 也不是显示项：拨动它只改变后续刷新的决策。
 * 用户每拨一次开关就打一次接口是打扰，所以这条路径整轮跳过（见 NO_EFFECT_KEYS）。
 * 注意别把它加进 REFRESH_KEYS——那正好相反，会变成「拨开关必刷」。
 */
test('拨动 autoCheckin 开关不触发取数，也不影响已有展示', async t => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  const textBefore = String(activeStub.statusItems[0].text);
  const rowsBefore = dataRows(bodySvgOf(activeStub));

  activeStub.setConfig('autoCheckin', false);
  await activeStub.fireConfigurationChange('traecnquota.autoCheckin');
  await settle();
  assert.strictEqual(urls.length, before, `拨动开关后一个请求都不该多发，实发 ${urls.length - before}：${urls.slice(before).join(', ')}`);
  assert.strictEqual(claimsOf(urls).length, 1, '开关变更本身不能再补发一次 claim');

  activeStub.setConfig('autoCheckin', true);
  await activeStub.fireConfigurationChange('traecnquota.autoCheckin');
  await settle();
  assert.strictEqual(urls.length, before, '拨回开启同样不该取数');
  assert.strictEqual(String(activeStub.statusItems[0].text), textBefore, '拨开关不改状态栏');
  assert.strictEqual(dataRows(bodySvgOf(activeStub)), rowsBefore, '也不触发行数重绘');
});

/**
 * VSCode 对同一次 settings.json 保存只派发一个多键事件，所以「同时改 detailRows 和 autoCheckin 再保存」
 * 是用户手边真实会发生的动作。它必须走 displayOnly 的免网络即时重绘：
 * autoCheckin 那条「什么都不用做」的短路不能把同行的 detailRows 一起吞掉（行数会陈旧一格到下次刷新）。
 */
test('同一次保存改 detailRows + autoCheckin：行数立刻重绘且不发请求', async t => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  assert.strictEqual(dataRows(bodySvgOf(activeStub)), 3, '起手 3 行，重绘前后才有可比性');

  activeStub.setConfig('detailRows', 2);
  activeStub.setConfig('autoCheckin', false);
  await activeStub.fireConfigurationChange(['traecnquota.detailRows', 'traecnquota.autoCheckin']);
  await settle();

  assert.strictEqual(dataRows(bodySvgOf(activeStub)), 2, 'detailRows 的免网络重绘不能被 checkinOnly 短路吞掉');
  assert.strictEqual(urls.length, before, `两个键都不需要取数，一个请求都不该发，实发 ${urls.length - before}：${urls.slice(before).join(', ')}`);
  assert.strictEqual(claimsOf(urls).length, 1, '开关拨到关不借这次事件补发 claim');
});

/** 多键事件的另一半：同一次保存里若还动了凭证，取数路径不能被免取数短路判掉 */
test('同一次保存改 manualToken + autoCheckin：凭证优先，照常重新取数', async t => {
  const urls = countingFetch();
  activeStub = makeVscodeStub({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0, autoCheckin: true });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const before = urls.length;
  assert.strictEqual(claimsOf(urls).length, 1, '今天已签成，后面那轮刷新只剩积分两个请求，计数才好读');

  activeStub.setConfig('manualToken', 'another-token');
  activeStub.setConfig('autoCheckin', false);
  await activeStub.fireConfigurationChange(['traecnquota.manualToken', 'traecnquota.autoCheckin']);
  await settle();

  assert.strictEqual(urls.length, before + 2, `凭证变了必须重新取数（+积分+签到状态），实发 ${urls.length - before}：${urls.slice(before).join(', ')}`);
  assert.strictEqual(activeStub.secrets.get('manualToken'), 'another-token', '新 token 仍要收进保管箱');
});


/**
 * 用量明细跳转图标：Trae 系顶栏本就有「点击查看积分用量明细」按钮，
 * 它走 workbench.action.icubeOpenUsageDetails；其他宿主没这条命令，回落到网页。
 */
test('usageTargetHref：Trae 系走内部命令，其余宿主走网页地址', () => {
  countingFetch();
  const { usageTargetHref } = freshRequire();
  assert.strictEqual(usageTargetHref('Trae CN'), 'command:workbench.action.icubeOpenUsageDetails');
  assert.strictEqual(usageTargetHref('TRAE SOLO CN'), 'command:workbench.action.icubeOpenUsageDetails');
  assert.strictEqual(usageTargetHref('Visual Studio Code'), 'https://www.trae.cn/dashboard#usage');
  assert.strictEqual(usageTargetHref(undefined), 'https://www.trae.cn/dashboard#usage');
  globalThis.fetch = undefined;
});

test('usageIconUri：用量图标是第三张独立图标，不与刷新/齿轮同图', () => {
  countingFetch();
  const { usageIconUri, refreshIconUri, gearIconUri } = freshRequire();
  const u = usageIconUri('#888888');
  assert.match(u, /^data:image\/svg\+xml;base64,/, '要是可用的 SVG data URI');
  assert.notStrictEqual(u, refreshIconUri('#888888'));
  assert.notStrictEqual(u, gearIconUri('#888888'));
  globalThis.fetch = undefined;
});

test('标题行有第三个图标，VS Code 宿主的用量链接指向网页', async t => {
  countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const md = String(activeStub.statusItems[0].tooltip.value);
  const anchors = md.match(/<a href="[^"]+"/g) || [];
  assert.strictEqual(anchors.length, 3, '标题行应有设置/刷新/用量三个可点图标');
  assert.ok(anchors.some(a => a.includes('https://www.trae.cn/dashboard#usage')), '非 Trae 宿主要点向网页');
  globalThis.fetch = undefined;
});

test('标题行用量图标在 Trae 宿主指向内部命令', async t => {
  countingFetch();
  activeStub = makeStubCheckinOff({ manualToken: 'fake-token', detailRows: 3, refreshInterval: 0 }, { appName: 'Trae CN' });
  const ext = withCleanup(t, freshRequire());
  ext.activate(activeStub.context);
  await settle();
  const md = String(activeStub.statusItems[0].tooltip.value);
  assert.ok(md.includes('command:workbench.action.icubeOpenUsageDetails'), 'Trae 宿主要点向用量管理页');
  assert.ok(!md.includes('www.trae.cn/dashboard'), 'Trae 宿主不该退回网页');
  globalThis.fetch = undefined;
});
