import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decryptTcValue } from './crypto';

type Edition = 'cn' | 'solo-cn';

/** 与指纹同源的 Trae 客户端版本；缺失时请求头回落到内置兜底值 */
export interface DeviceFingerprint {
  machineId?: string | undefined;
  deviceId?: string | undefined;
  ideVersion?: string | undefined;
}

export interface TraeAuth {
  token: string;
  userId: string;
  /** API 域名，例如 https://api.trae.cn */
  host: string;
  /** 形状不认识时是 undefined，与「字段缺失」同义，显式允许 */
  expiredAt?: string | undefined;
  /** Trae 界面显示的用户名（account.username），只用于提示语里区分是哪个账号 */
  username?: string | undefined;
  /** claim 接口做设备指纹校验，带上客户端真实值才不会被拒 */
  machineId?: string | undefined;
  deviceId?: string | undefined;
  ideVersion?: string | undefined;
  edition: Edition | 'manual';
}

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const MACHINE_ID_KEY = 'telemetry.machineId';
const IDE_VERSION_KEY = 'iCubeLastVersion';
// 设备 ID 藏在键名里：iCubeAuthInfo://icube-dc:<N>，N 就是服务端认的那个数字串
const DEVICE_ID_KEY_RE = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/;
export const DEFAULT_HOST = 'https://api.trae.cn';
// 精确主机名，不用 *.trae.cn 通配：任意子域（含悬垂 CNAME 的废弃环境）都能收走请求头里的凭证。
// 本机 Trae CN / TRAE SOLO CN 登录态写入的 host 实测都是 https://api.trae.cn，收紧不会误拒。
const ALLOWED_API_HOSTS = new Set(['api.trae.cn']);

/**
 * 归一化 API 基地址。凭证会随请求头外发，所以端点不接受任意字符串：
 * 必须是 https、主机名在精确白名单内且用默认端口，否则回落到默认地址并回报被拒的原因。
 */
export function normalizeApiHost(input: string | undefined): { host: string; rejected?: string } {
  const raw = (input || '').trim().replace(/\/+$/, '');
  if (!raw) {
    return { host: DEFAULT_HOST };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { host: DEFAULT_HOST, rejected: `${raw}（不是合法 URL，缺协议也属此类）` };
  }
  if (url.protocol !== 'https:') {
    return { host: DEFAULT_HOST, rejected: `${raw}（只允许 https）` };
  }
  if (url.port !== '') {
    return { host: DEFAULT_HOST, rejected: `${raw}（只允许默认端口 443）` };
  }
  if (!ALLOWED_API_HOSTS.has(url.hostname)) {
    return { host: DEFAULT_HOST, rejected: `${raw}（主机名不是 ${[...ALLOWED_API_HOSTS].join(' / ')}，避免 token 发往第三方）` };
  }
  return { host: url.origin };
}

const EDITION_DIRS: Record<Edition, string> = {
  cn: 'Trae CN',
  'solo-cn': 'TRAE SOLO CN'
};

const EDITION_LABELS: Record<Edition, string> = {
  cn: 'Trae CN',
  'solo-cn': 'TRAE SOLO CN'
};

function roamingDir(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return path.join(os.homedir(), '.config');
}

export function editionLabel(edition: Edition): string {
  return EDITION_LABELS[edition];
}

/**
 * 从已解析的 storage.json 里提取设备指纹。指纹是设备级信息，与账号是否登录无关，
 * 三个字段哪个缺就缺着返回，绝不编造——编出来的指纹过不了 claim 的服务端校验。
 */
function extractFingerprint(storage: Record<string, unknown>): DeviceFingerprint {
  const fingerprint: DeviceFingerprint = {};
  const machineId = storage[MACHINE_ID_KEY];
  if (typeof machineId === 'string' && machineId.trim()) {
    fingerprint.machineId = machineId.trim();
  }
  const ideVersion = storage[IDE_VERSION_KEY];
  if (typeof ideVersion === 'string' && ideVersion.trim()) {
    fingerprint.ideVersion = ideVersion.trim();
  }
  for (const key of Object.keys(storage)) {
    const matched = DEVICE_ID_KEY_RE.exec(key);
    if (matched) {
      fingerprint.deviceId = matched[1];
      break;
    }
  }
  return fingerprint;
}

function parseStorageJson(storagePath: string, label: string): Record<string, unknown> {
  let storage: unknown;
  try {
    storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  } catch {
    // 不把 storagePath 拼进消息：那里面含本机用户名，用户截图求助时会一起漏出去
    throw new Error(`${label} 的登录态文件读不出来或不是合法 JSON`);
  }
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) {
    throw new Error(`${label} 的登录态文件读不出来或不是合法 JSON`);
  }
  return storage as Record<string, unknown>;
}

function readFingerprintFromDir(edition: Edition): DeviceFingerprint {
  const storagePath = path.join(roamingDir(), EDITION_DIRS[edition], 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) {
    throw new Error(`未找到 ${EDITION_LABELS[edition]} 的登录态文件`);
  }
  return extractFingerprint(parseStorageJson(storagePath, EDITION_LABELS[edition]));
}

/**
 * 读取 Trae 客户端写入的设备指纹。edition 为 auto 时按 cn -> solo-cn 找第一个含指纹的文件；
 * 一个都找不到时抛错（与 loadAuth 同风格）。loadAuth 成功的路径总是能顺带带出指纹，
 * 这个独立入口主要给手动 token 用户与测试用。
 */
export function loadDeviceFingerprint(edition: string): DeviceFingerprint {
  if (edition && edition !== 'auto') {
    if (!(edition in EDITION_DIRS)) {
      // 与 loadAuth 同源的错误文案；settings.json 手可改，原值不回显（会进按 Markdown 渲染的界面）
      throw new Error('traecnquota.edition 的值不是可识别的客户端，只能是 auto / cn / solo-cn');
    }
    return readFingerprintFromDir(edition as Edition);
  }

  const errors: string[] = [];
  for (const candidate of Object.keys(EDITION_DIRS) as Edition[]) {
    try {
      const fingerprint = readFingerprintFromDir(candidate);
      if (fingerprint.machineId !== undefined || fingerprint.deviceId !== undefined || fingerprint.ideVersion !== undefined) {
        return fingerprint;
      }
      errors.push(`${EDITION_LABELS[candidate]}: 登录态文件里没有设备指纹字段`);
    } catch (err) {
      errors.push(`${EDITION_LABELS[candidate]}: ${(err as Error).message}`);
    }
  }
  throw new Error(`未能从任何 Trae 客户端读取设备指纹。${errors.join('；')}`);
}

function readFromDir(edition: Edition): TraeAuth {
  const storagePath = path.join(roamingDir(), EDITION_DIRS[edition], 'User', 'globalStorage', 'storage.json');
  if (!fs.existsSync(storagePath)) {
    throw new Error(`未找到 ${EDITION_LABELS[edition]} 的登录态文件`);
  }

  const storage = parseStorageJson(storagePath, EDITION_LABELS[edition]);
  const raw = storage[AUTH_KEY];
  if (raw === undefined || raw === null || raw === '') {
    throw new Error(`${EDITION_LABELS[edition]} 未登录，请先在该客户端中登录`);
  }
  if (typeof raw !== 'string') {
    throw new Error(`${EDITION_LABELS[edition]} 的登录态结构不认识，Trae 可能换了存储格式`);
  }

  // 国际版直接存明文 JSON，国内版是 tc 加密串
  const plain = raw.trim().startsWith('{') ? raw : decryptTcValue(raw);
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(plain);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    data = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${EDITION_LABELS[edition]} 的登录态结构不认识，Trae 可能换了存储格式`);
  }

  // 结构不认识的字段一律当作没有，绝不把脏值带进请求头
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (!token) {
    throw new Error(`${EDITION_LABELS[edition]} 的登录态里没有可用的 accessToken`);
  }
  const userId = typeof data.userId === 'string' || typeof data.userId === 'number' ? String(data.userId) : '';
  const expiredAt = toInstant(data.expiredAt);
  const account = data.account && typeof data.account === 'object' ? (data.account as Record<string, unknown>) : {};

  return {
    token,
    userId,
    username: toUsername(account.username),
    host: normalizeApiHost(typeof data.host === 'string' ? data.host : undefined).host,
    expiredAt,
    // 指纹与登录态同文件，读到的就是这份登录态所属客户端写入的设备标识
    ...extractFingerprint(storage),
    edition
  };
}

/**
 * 用户名只用来在签到提示里区分账号，形状不对、含零宽/双向控制符或长得不像名字的，一律当没有。
 * 它来自客户端缓存的服务端数据，不能当成可信文本直接拼进 toast。
 */
function toUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const s = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064]/g, '').trim();
  return s && s.length <= 64 ? s : undefined;
}

/** 真机里 expiredAt 是 ISO 字符串；顺手接受数字时间戳，形状不对就当没有，绝不把原始串外发 */
function toInstant(value: unknown): string | undefined {
  let ms = NaN;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * 读取本地登录态。edition 为 auto 时按 cn -> solo-cn 依次尝试。
 */
export function loadAuth(edition: string): TraeAuth {
  if (edition && edition !== 'auto') {
    if (!(edition in EDITION_DIRS)) {
      // settings.json 是用户手可改的，enum 约束不住。不回显原值：那串会进 tooltip 和 toast，
      // 两处都按 Markdown 渲染，含 [] () 的恶意值能拼出可点外链
      throw new Error('traecnquota.edition 的值不是可识别的客户端，只能是 auto / cn / solo-cn');
    }
    return readFromDir(edition as Edition);
  }

  const errors: string[] = [];
  for (const candidate of Object.keys(EDITION_DIRS) as Edition[]) {
    try {
      return readFromDir(candidate);
    } catch (err) {
      errors.push(`${EDITION_LABELS[candidate]}: ${(err as Error).message}`);
    }
  }
  throw new Error(`未能从任何 Trae 客户端读取登录态。${errors.join('；')}`);
}

export function loadAuthFromToken(token: string): TraeAuth {
  return {
    token,
    userId: '',
    host: DEFAULT_HOST,
    edition: 'manual',
    ...tryReadFingerprint()
  };
}

/**
 * 手动 token 用户机器上可能仍装着 Trae 客户端，指纹是设备级信息与登录方式无关，
 * 所以手动路径也读一次；读不到就全 undefined，请求头回落到生成值。
 * 刻意吞掉一切错误：指纹缺失只影响 claim 成功率，不该让「手动填 token」这条路失败。
 */
function tryReadFingerprint(): DeviceFingerprint {
  try {
    return loadDeviceFingerprint('auto');
  } catch {
    return {};
  }
}

/**
 * 刻意不去读 ~/.trae-cn/trae-jwt-token 这类明文 JWT 作为兜底。
 * 实测（2026-09-26）：那是 SOLO 运行时的身份 JWT（payload 只有 id/tenant_id/type/user_id），
 * 按 req_source=1、req_source=2、Bearer、只带 X-Cloudide-Token 四种方式打积分接口，
 * 服务端一律返回 HTTP 401 / code=1001「无法认证」。拿它兜底只会把「没找到登录态」
 * 伪装成「认证失败」，误导排查方向。
 */