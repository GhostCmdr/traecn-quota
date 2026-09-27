import * as crypto from 'crypto';
import * as os from 'os';
import { DEFAULT_HOST, TraeAuth } from './auth';

const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '3.3.67';
const IDE_VERSION_CODE = '20260401';
const REQUEST_TIMEOUT_MS = 8000;

/** req_source: 1 = IDE（TraeCode），2 = Lite（TraeWork） */
const REQ_SOURCE = 1;

const PATH_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status';
const PATH_ENT_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';

// 每台机器保持恒定的设备标识，避免每次请求都换新身份导致被服务端判定为异常流量/限流。
const DEVICE_ID = crypto
  .createHash('sha256')
  .update(`${os.hostname()}${process.platform}${process.arch}trae-cn-usage`)
  .digest('hex')
  .substring(0, 32);
const MACHINE_ID = crypto.createHash('sha256').update(DEVICE_ID).digest('hex');

interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string, init?: unknown) => Promise<HttpResponse>;

const globalFetch = (globalThis as unknown as { fetch?: FetchLike }).fetch;
if (!globalFetch) {
  throw new Error('当前运行环境不支持 fetch，无法访问 Trae 接口');
}
const httpFetch: FetchLike = globalFetch;

interface CheckinStatus {
  code?: number;
  message?: string;
  /** 签到活动是否开启 */
  enable?: boolean;
  /** 今天是否已签到 */
  checked_in?: boolean;
}

export interface CreditPack {
  name: string;
  /** 缺字段与值本身是 undefined 都可能出现（服务端不给），显式允许 undefined 以免类型说谎 */
  limit?: number | undefined;
  used: number;
  remaining?: number | undefined;
  unlimited: boolean;
  expireTime?: number | undefined;
}

export interface CreditsSummary {
  limit: number;
  used: number;
  remaining: number;
  unlimited: boolean;
  packs: CreditPack[];
}

function buildHeaders(auth: TraeAuth): Record<string, string> {
  return {
    Authorization: `Cloud-IDE-JWT ${auth.token}`,
    'X-Cloudide-Token': auth.token,
    'x-uid': auth.userId || '',
    'x-app-id': APP_ID,
    'x-device-id': DEVICE_ID,
    'x-machine-id': MACHINE_ID,
    'x-request-id': crypto.randomUUID(),
    'x-ide-version': IDE_VERSION,
    'x-ide-version-code': IDE_VERSION_CODE,
    'x-device-type': process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
    'x-os-version': `${process.platform} ${process.arch}`,
    'Content-Type': 'application/json'
  };
}

/** 成对出现就能拼出 Markdown 链接/图片，单独出现也能改排版 */
const UI_UNSAFE_CHARS = '[]()*~#!|<>`\\';
const URL_RE = /https?:\/\/\S+/gi;
/** 零宽与双向控制符能让链接显示与现实不一致，且不属于 \s */
const CONTROL_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064]', 'g');
const WHITESPACE_RE = /\s+/g;

/**
 * 远程文本进任何面向用户的载体前的统一净化。裸 URL 会被 VSCode 认成可点链接，
 * `[文字](链接)` 与 `![图](链接)` 分别是钓鱼外链和悬停代发请求，所以整段抹掉，
 * 最后截断。抹完只剩可读的文字线索，不含任何可构造的链接语法。
 */
function safeSnippet(text: string, max = 80): string {
  let out = text.replace(URL_RE, '[链接已隐去]').replace(CONTROL_RE, '');
  for (const ch of UI_UNSAFE_CHARS) {
    out = out.split(ch).join('');
  }
  return out.replace(WHITESPACE_RE, ' ').trim().slice(0, max);
}

export interface ApiError extends Error {
  /** 只在输出面板里出现的接口正文线索 */
  remoteDetail?: string;
  /** HTTP 状态码，用于区分「真 401」与「业务 code 里带 401」 */
  httpStatus?: number;
}

/**
 * 面向用户的错误消息只带接口名与状态码，不带正文——正文会进状态栏 tooltip 和错误 toast，
 * 那两处都是按 Markdown 渲染的。正文另挂 remoteDetail，只由输出面板写。
 */
function apiError(message: string, remoteBody?: string, httpStatus?: number): ApiError {
  const err = new Error(message) as ApiError;
  if (remoteBody) {
    err.remoteDetail = safeSnippet(remoteBody);
  }
  if (typeof httpStatus === 'number') {
    err.httpStatus = httpStatus;
  }
  return err;
}

/** fetch 失败时真正的死因（DNS、TLS、代理、断网）在 err.cause 里，外层只有 "fetch failed" */
function fetchFailReason(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause ? String(e.cause.code || e.cause.message || '') : '';
  const msg = String(e?.message || '未知错误');
  return safeSnippet(cause ? msg + ' · ' + cause : msg);
}

/** 请求或读正文被打断时的统一说法；超时和断流的原始消息都是引擎英文术语 */
function requestFailure(apiPath: string, err: unknown): Error {
  const name = (err as Error)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new Error(`请求 ${apiPath} 超时（${REQUEST_TIMEOUT_MS / 1000}s），请检查网络或代理`);
  }
  return new Error(`请求 ${apiPath} 失败：${fetchFailReason(err)}`);
}

async function postJson<T extends { code?: number; message?: string }>(auth: TraeAuth, apiPath: string, body: unknown): Promise<T> {
  // 发送边界的最后一道断言：凭证只允许发往官方地址，防止以后新增凭证来源时漏掉归一化
  if (auth.host !== DEFAULT_HOST) {
    throw new Error('请求目标不是 Trae 官方接口，已拒绝发送凭证');
  }
  const url = `${auth.host}${apiPath}`;
  let res: HttpResponse;
  try {
    res = await httpFetch(url, {
      method: 'POST',
      headers: buildHeaders(auth),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    throw requestFailure(apiPath, err);
  }

  // 响应头到了不等于正文到了：超时定时器可能在读正文时才触发，代理也可能中途断流。
  // 先记下来不急着抛——状态码已经到手，它比「流断了」更能告诉用户下一步做什么。
  let text: string | undefined;
  let readErr: unknown;
  try {
    text = await res.text();
  } catch (err) {
    readErr = err;
  }
  if (res.status === 401) {
    throw apiError(
      '认证失败（HTTP 401）：token 可能已过期或不属于国内版。国际版（trae.ai）暂无积分接口，请使用国内版账号。',
      undefined,
      401
    );
  }
  if (res.status !== 200) {
    throw apiError(`请求 ${apiPath} 返回 HTTP ${res.status}`, text, res.status);
  }
  if (readErr !== undefined || text === undefined) {
    throw requestFailure(apiPath, readErr);
  }
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    // 走到这里多半是被代理或登录页拦了，正文只留在输出面板里当线索
    throw apiError(`请求 ${apiPath} 返回的不是 JSON 内容（可能被代理、网关或登录页拦截）`, text, res.status);
  }
  // 服务端会用 HTTP 200 包裹业务错误，不检查 code 就会把错误信封当成空数据。
  // message 是远程文本，只进 remoteDetail，不进用户可见消息。
  if (typeof data.code === 'number' && data.code !== 0) {
    throw apiError(`接口 ${apiPath} 返回业务错误 code=${data.code}`, data.message, res.status);
  }
  return data;
}

export function fetchCheckinStatus(auth: TraeAuth): Promise<CheckinStatus> {
  return postJson<CheckinStatus>(auth, PATH_CHECKIN_STATUS, { req_source: REQ_SOURCE });
}

interface EntUsageResponse {
  code?: number;
  message?: string;
  user_entitlement_pack_list?: Array<{
    display_desc?: string;
    expire_time?: number;
    entitlement_base_info?: { quota?: { credits_limit?: number } };
    usage?: { credits_amount?: number };
  }>;
}

/**
 * 积分余额。聚合口径与 TraeCode 客户端一致：
 * 逐个积分包累加限额与已用量，credits_limit 为 -1 表示不限量。
 */
export async function fetchCredits(auth: TraeAuth): Promise<CreditsSummary> {
  const raw = await postJson<EntUsageResponse>(auth, PATH_ENT_USAGE, {
    require_usage: true,
    req_source: REQ_SOURCE
  });

  const packs: CreditPack[] = [];
  let limit = 0;
  let used = 0;
  let remaining = 0;
  let hasQuota = false;
  let hasUnlimitedPack = false;

  for (const pack of raw.user_entitlement_pack_list ?? []) {
    // 声明是 number 不代表运行时是：JSON.parse 会给出 Infinity(1e999)、字符串、对象，
    // 漏掉任一项都会让整条链路变成 NaN
    const rawLimit = pack.entitlement_base_info?.quota?.credits_limit;
    const packLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined;
    const rawUsed = pack.usage?.credits_amount;
    const packUsed = typeof rawUsed === 'number' && Number.isFinite(rawUsed) ? rawUsed : 0;
    const rawName = (pack as { display_desc?: unknown }).display_desc;

    let packRemaining: number | undefined;
    if (packLimit === -1) {
      hasQuota = true;
      hasUnlimitedPack = true;
    } else if (packLimit !== undefined && packLimit > 0) {
      hasQuota = true;
      limit += packLimit;
      used += packUsed;
      packRemaining = Math.max(packLimit - packUsed, 0);
      remaining += packRemaining;
    }

    packs.push({
      name: typeof rawName === 'string' && rawName.trim() ? rawName : '积分包',
      limit: packLimit,
      used: packUsed,
      remaining: packRemaining,
      unlimited: packLimit === -1,
      expireTime: typeof pack.expire_time === 'number' && Number.isFinite(pack.expire_time) ? pack.expire_time : undefined
    });
  }

  if (!hasQuota) {
    throw new Error('账号没有任何积分包，可能未切换到积分计费模式');
  }

  // 整体「不限量」仅当账号没有任何有限额积分包时成立；
  // 若同时存在有限额包，仍按有限额部分计算占比，避免误报 100% / 隐藏真实额度。
  const unlimited = limit === 0 && hasUnlimitedPack;

  return {
    limit,
    used,
    remaining,
    unlimited,
    // 明细只列还有余额的包：用尽的包即使已用量 > 0 也不展示（额度累加在上面已经算过，不受这里影响）
    packs: packs.filter(p => p.unlimited || (p.remaining ?? 0) > 0)
  };
}
