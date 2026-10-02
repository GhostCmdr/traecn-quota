const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { normalizeApiHost, DEFAULT_HOST, loadDeviceFingerprint, loadAuth, loadAuthFromToken } = require(
  path.join(__dirname, '..', 'out', 'auth.js')
);

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

/**
 * 把 roaming 目录隔离到临时目录（与 extension.test.js 的 isolateLoginState 同一套手法，
 * 这里只需要最小版）。必须同时改 APPDATA 和 os.homedir：auth.ts 在 win32 读 APPDATA，
 * 其他平台走 os.homedir()，只改一个的话别的平台会读到真机的 storage.json。
 */
function isolateLoginState(tag) {
  const root = path.join(os.tmpdir(), 'traecn-quota-auth-' + tag + '-' + Date.now());
  const prevAppdata = process.env.APPDATA;
  const prevHomedir = os.homedir;
  os.homedir = () => root;
  process.env.APPDATA = root;
  const roaming =
    process.platform === 'win32' ? root : process.platform === 'darwin' ? path.join(root, 'Library', 'Application Support') : path.join(root, '.config');
  return {
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

// 登录态里的 token 造一份合法形状即可，auth 相关行为在别处已覆盖，这里只关心指纹
const loginBody = JSON.stringify({ token: 't', userId: '1', host: 'https://api.trae.cn' });

test('storage.json 含指纹三键时 loadDeviceFingerprint 原样读出', () => {
  const isolate = isolateLoginState('fp-full');
  fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': loginBody,
    'telemetry.machineId': 'fp-machine-uuid-1234',
    'iCubeAuthInfo://icube-dc:2025040112345678': '1',
    'iCubeLastVersion': '2.3.87416'
  }), 'utf8');
  const fp = loadDeviceFingerprint('cn');
  assert.strictEqual(fp.machineId, 'fp-machine-uuid-1234');
  assert.strictEqual(fp.deviceId, '2025040112345678');
  assert.strictEqual(fp.ideVersion, '2.3.87416');
  // loadAuth 也要把同一份指纹带进 TraeAuth，请求头才拿得到
  const auth = loadAuth('cn');
  assert.strictEqual(auth.machineId, 'fp-machine-uuid-1234');
  assert.strictEqual(auth.deviceId, '2025040112345678');
  assert.strictEqual(auth.ideVersion, '2.3.87416');
  isolate.restore();
});

test('指纹键缺失时对应字段是 undefined，绝不编造', () => {
  const isolate = isolateLoginState('fp-partial');
  fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': loginBody,
    'telemetry.machineId': 'only-machine-id'
  }), 'utf8');
  const fp = loadDeviceFingerprint('cn');
  assert.strictEqual(fp.machineId, 'only-machine-id');
  assert.strictEqual(fp.deviceId, undefined);
  assert.strictEqual(fp.ideVersion, undefined);
  isolate.restore();
});

test('auto 模式下第一个客户端没指纹、第二个有时能从第二个读到', () => {
  const isolate = isolateLoginState('fp-auto');
  fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
    'iCubeAuthInfo://icube.cloudide': loginBody
  }), 'utf8');
  fs.writeFileSync(isolate.storageJson('TRAE SOLO CN'), JSON.stringify({
    'telemetry.machineId': 'solo-machine',
    'iCubeAuthInfo://icube-dc:998877': '1',
    'iCubeLastVersion': '2.3.87416'
  }), 'utf8');
  const fp = loadDeviceFingerprint('auto');
  assert.strictEqual(fp.machineId, 'solo-machine');
  assert.strictEqual(fp.deviceId, '998877');
  assert.strictEqual(fp.ideVersion, '2.3.87416');
  isolate.restore();
});

test('手动 token 路径也能读到本机客户端的指纹（指纹是设备级，与登录方式无关）', () => {
  const isolate = isolateLoginState('fp-manual');
  fs.writeFileSync(isolate.storageJson('Trae CN'), JSON.stringify({
    'telemetry.machineId': 'manual-path-machine',
    'iCubeAuthInfo://icube-dc:445566': '1',
    'iCubeLastVersion': '2.3.87416'
  }), 'utf8');
  const auth = loadAuthFromToken('pasted-token');
  assert.strictEqual(auth.machineId, 'manual-path-machine');
  assert.strictEqual(auth.deviceId, '445566');
  assert.strictEqual(auth.ideVersion, '2.3.87416');
  isolate.restore();
});
