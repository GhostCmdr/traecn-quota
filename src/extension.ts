import * as vscode from 'vscode';
import { loadAuth, loadAuthFromToken, normalizeApiHost, TraeAuth, editionLabel } from './auth';
import { CreditsSummary, fetchCheckinStatus, fetchCredits, claimCheckin } from './api';
import { shouldClaim, todayString } from './checkin';
import { buildPanelData, buildTooltipMarkdown, footerHostPad } from './tooltip';
import { fmtCredits, pctOf } from './format';

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
/** activate() 的上下文要留给 refresh() 之后的签到路径用（写 globalState 的日期守卫） */
let extContext: vscode.ExtensionContext | undefined;

let refreshTimer: NodeJS.Timeout | undefined;

/** 最近一次成功取到的数据，供主题切换 / 纯显示项变更时免网络重绘 */
let lastSummary: CreditsSummary | undefined;
/** 标题行账号徽标的名字：刷新成功时从登录态取，换账号后随下次刷新更新 */
let lastAccountName = '';
/** 同一时刻只允许一次刷新，避免连点或定时器叠加请求 */
let refreshing = false;
/** 锁被占着时又来了必须刷新的变更（换凭证等），锁释放后补一轮，绝不无声丢弃 */
let pendingRefresh = false;
/** 本轮数据的取数时刻；悬浮窗「更新」显示它，免网络重绘不能把它悄悄改成重绘时刻 */
let lastFetchedAt = 0;
/** 悬浮窗页脚显示的签到文案，只说今天签没签，不带日期 */
let checkinStateText = '';
/** checkinStateText 是哪天查的：跨天后旧值必须作废，否则会把昨天的状态说成今天的 */
let checkinStateDay = '';
/** 输出面板里的签到记录，带日期 */
let checkinNote = '';
/** globalState 里「最近一次签到成功的日期」的键名 */
const LAST_CHECKIN_DATE_KEY = 'traecnquota.lastCheckinSuccessDate';
/**
 * claim 接口的业务 code 9095：服务端应答文案是「当前设备今日已经签到，请明日再来哦～」。
 * 实测（2026-10-04，同机两个账号）确认这条限制按设备算——CN 领过之后，SOLO CN 那个
 * 账号用自己客户端的指纹来领也会被拒。所以它是良性结果，不是失败。
 */
const CLAIM_DEVICE_ALREADY_TODAY = 9095;
/** 当天兜底定时器：只在「今天还没签成」时排到当天 23:50，签成功即销毁 */
let checkinTimer: NodeJS.Timeout | undefined;
/** 同一时刻只允许一次 claim，避免启动刷新与手动命令叠加 */
let claiming = false;

/** 悬浮窗明细行数的默认值，与 package.json 里 traecnquota.detailRows 的 default 保持一致 */
const DEFAULT_DETAIL_ROWS = 3;
/** 自动刷新间隔（分钟）的默认值与上限，与 package.json 里 default/maximum 保持一致 */
const DEFAULT_REFRESH_MINUTES = 30;
const MAX_REFRESH_MINUTES = 1440;
/** 自动签到的默认开关，与 package.json 里 traecnquota.autoCheckin 的 default 保持一致（导出供测试锚定两处同源） */
export const DEFAULT_AUTO_CHECKIN = true;
/** 改了必须重新取数的设置项；不在此列的（detailRows、autoCheckin）只需按上一次数据重绘或不影响渲染 */
const REFRESH_KEYS = ['hostOverride', 'manualToken', 'refreshInterval'];
/** 既不参与渲染也不参与取数的设置项：拨动它只改变后续刷新的决策，本身不该触发任何请求 */
const NO_EFFECT_KEYS = ['autoCheckin'];

/** 手动 token 在加密保管箱里的键名 */
const TOKEN_SECRET = 'manualToken';
let secretStore: vscode.SecretStorage | undefined;
/**
 * 本进程刚清空过设置项，VSCode 紧接着派发的回声事件要认出来。
 * 只覆盖本进程：同 profile 的其它窗口认不出回声，但其后果已经降级为「多刷一次」，
 * 不再有任何数据损失——所以清空保管箱必须走显式命令，不能靠「设置项变空」这个推断。
 */
let clearingTokenSetting = false;

function cfg() {
  return vscode.workspace.getConfiguration('traecnquota');
}

function log(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  output.appendLine(`[${stamp}] ${message}`);
}

/** 抛的不一定是 Error（第三方 promise 会 throw 字符串），不能直接取 .message */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() ? raw : '未知错误';
}

/** 两位补零；到期时间与页脚的更新时间共用 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function timesUp(expiredAt?: string): boolean {
  if (!expiredAt) {
    return false;
  }
  return Date.now() > new Date(expiredAt).getTime();
}


/**
 * 设置项只是输入口：一旦读到非空值就搬进 VSCode 的加密保管箱并清空本项，
 * 免得 token 以明文躺在 settings.json 里（settings 项会被 Settings Sync 同步走）。
 */
async function sweepManualToken(): Promise<boolean> {
  if (!secretStore) {
    return false;
  }
  const raw = (cfg().get<string>('manualToken') || '').trim();
  if (!raw) {
    return false;
  }
  try {
    await secretStore.store(TOKEN_SECRET, raw);
  } catch (err) {
    // 系统钥匙串不可用时不能崩在这里：留着设置项里的值让用户自己处理，回落到客户端登录态
    log(`保管箱写入失败（${messageOf(err)}），手动 Token 本次不生效，请检查系统凭据服务`);
    return false;
  }
  clearingTokenSetting = true;
  try {
    await clearManualTokenSetting();
    // 清空设置项引发的配置事件是异步派发的；等它落定再解除标记，否则回声会被当成用户改动
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    clearingTokenSetting = false;
  }
  log('手动 Token 已存入 VSCode 加密保管箱，设置项已清空，无需再填');
  return true;
}

/**
 * 值可能写在工作区或工作区文件夹里，只清全局会在 .vscode/settings.json 留一行明文。
 * 清不掉时（配置只读、多窗口同时清理）必须直说——保管箱里已经存好了，
 * 但明文副本还在，用户得自己删掉。
 */
async function clearManualTokenSetting(): Promise<void> {
  const scope = cfg().inspect<string>('manualToken');
  const targets: Array<[string | undefined, number]> = [
    [scope?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [scope?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [scope?.globalValue, vscode.ConfigurationTarget.Global]
  ];
  const labeled = targets.filter(([value]) => !!value && value.trim() !== '');
  for (const [value, target] of targets) {
    if (!value || value.trim() === '') {
      continue;
    }
    try {
      await cfg().update('manualToken', undefined, target);
    } catch (err) {
      log(`Token 已存进保管箱，但清空设置项失败（${messageOf(err)}），请手动删掉 settings.json 里那行明文`);
    }
  }
  // 只有生效的那一份会被收走，其余作用区里的副本会随清空一起消失，事先说清楚
  if (labeled.length > 1) {
    log(`另有 ${labeled.length - 1} 份被覆盖的手动 Token 副本已一并清除，需要它请重新填`);
  }
}

/** 清除保管箱里的手动 Token 只能显式触发：靠「设置项变空」推断会误删别的窗口刚存的凭证 */
async function clearManualToken(): Promise<void> {
  if (!secretStore) {
    return;
  }
  let stored: string | undefined;
  try {
    stored = await secretStore.get(TOKEN_SECRET);
    if (!stored) {
      vscode.window.showInformationMessage('TraeCN 积分余额：保管箱里没有手动 Token，当前用的是客户端登录态');
      return;
    }
    await secretStore.delete(TOKEN_SECRET);
  } catch (err) {
    vscode.window.showErrorMessage(`TraeCN 积分余额：清除保管箱里的 Token 失败（${messageOf(err)}）`);
    return;
  }
  log('已清除保管箱里的手动 Token');
  await refresh(false);
}

/** 保管箱读不出来的两种死法：钥匙串直接拒绝（抛），或弹授权框后永远不返回（挂）。 */
const SECRET_READ_TIMEOUT_MS = 5000;

/** 挂住比报错更糟：resolveAuth 在刷新锁之后调用，读不返回就等于状态栏永久卡在「刷新中」 */
async function storedToken(): Promise<string> {
  if (!secretStore) {
    return '';
  }
  // SecretStorage.get 给的是 Thenable，不是 Promise（没有 .catch）
  const pending = Promise.resolve(secretStore.get(TOKEN_SECRET));
  // 超时之后钥匙串仍可能 reject，先接住，免得变成无人处理的 rejection
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    const stored = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`读取超过 ${SECRET_READ_TIMEOUT_MS / 1000}s 未返回`)), SECRET_READ_TIMEOUT_MS);
      })
    ]);
    return (stored || '').trim();
  } catch (err) {
    log(`保管箱读取失败（${messageOf(err)}），本次改用客户端登录态`);
    return '';
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveAuth(): Promise<TraeAuth> {
  const manual = await storedToken();
  let auth: TraeAuth;
  if (manual) {
    auth = loadAuthFromToken(manual);
  } else {
    try {
      auth = loadAuth('auto');
    } catch (err) {
      // 取不到登录态就直说，不再拿必定 401 的明文 JWT 去兜底
      const why = (err as Error).message;
      throw new Error(
        why.startsWith('未能从任何 Trae 客户端')
          ? `${why}。请在 Trae CN / TRAE SOLO CN 客户端里登录，或在设置项 traecnquota.manualToken 填一次 accessToken`
          : why
      );
    }
  }
  const override = (cfg().get<string>('hostOverride') || '').trim();
  if (override) {
    const { host, rejected } = normalizeApiHost(override);
    if (rejected) {
      log(`已忽略 hostOverride：${rejected}`);
    }
    auth.host = host;
  }
  return auth;
}

/**
 * 旧版本暴露过 traecnquota.edition；新版固定 auto。
 * 启动时清掉 settings.json 里的残留值，避免 VS Code 报「未知配置」。
 */
async function removeLegacyEditionSetting(): Promise<void> {
  const scope = cfg().inspect<unknown>('edition');
  if (!scope) {
    return;
  }
  let removed = false;
  const targets: Array<[unknown, vscode.ConfigurationTarget]> = [
    [scope.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [scope.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [scope.globalValue, vscode.ConfigurationTarget.Global]
  ];
  for (const [value, target] of targets) {
    if (value === undefined) {
      continue;
    }
    try {
      await cfg().update('edition', undefined, target);
      removed = true;
    } catch (err) {
      log(`移除旧的 edition 设置失败（${messageOf(err)}），可手动删除 settings.json 里的 traecnquota.edition`);
    }
  }
  if (removed) {
    log('已移除旧的 edition 设置');
  }
}

/** 明细行数：未配置回落到默认值，可配 1~6，手改成非数字也回落到默认而不是空表 */
function detailRows(): number {
  // 用 unknown 接收：settings.json 是用户手可改的，类型不受 schema 约束
  const raw = cfg().get<unknown>('detailRows');
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_DETAIL_ROWS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return DEFAULT_DETAIL_ROWS;
  }
  return Math.min(Math.max(Math.trunc(n), 1), 6);
}


/**
 * 签到状态归一成面板认识的四个码：跨天后旧值作废，回落「签到未查询」。
 */
function checkinCode(): 'claimed' | 'unclaimed' | 'disabled' | 'unknown' {
  const today = new Date().toLocaleDateString('sv');
  if (!checkinStateText || checkinStateDay !== today) {
    return 'unknown';
  }
  if (checkinStateText.startsWith('今日已签到')) {
    return 'claimed';
  }
  if (checkinStateText === '今日未签到') {
    return 'unclaimed';
  }
  if (checkinStateText === '签到活动未开启') {
    return 'disabled';
  }
  return 'unknown';
}

/** Light 与 HighContrastLight 都走浅色，其余深色；SVG 配色写死，换主题必须重绘 */
function themeKind(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

function fmtQuota(value: number, unlimited: boolean): string {
  return unlimited ? '不限量' : fmtCredits(value);
}

function render(summary: CreditsSummary): void {
  const pct = summary.unlimited ? 100 : pctOf(summary.remaining, summary.limit);
  statusBar.text = summary.unlimited
    ? '$(trae-sparkle) 不限量 (100%)'
    : `$(trae-sparkle) ${fmtCredits(summary.remaining)} (${pct}%)`;

  const fetched = new Date(lastFetchedAt || Date.now());
  const updatedAt = `${pad2(fetched.getHours())}:${pad2(fetched.getMinutes())}`;
  const data = buildPanelData(
    {
      remain: summary.remaining,
      total: summary.limit,
      unlimited: summary.unlimited,
      packs: summary.packs.map(p => ({
        name: p.name,
        remain: p.remaining ?? 0,
        limit: p.limit ?? 0,
        unlimited: p.unlimited,
        plan: p.plan,
        expireTime: p.expireTime
      }))
    },
    checkinCode(),
    updatedAt,
    lastAccountName,
    cfg().get<boolean>('planPackFirst', true)
  );

  const md = new vscode.MarkdownString(
    buildTooltipMarkdown(data, {
      theme: themeKind(),
      detailRows: detailRows(),
      appName: vscode.env?.appName
    })
  );
  // 标题行三个链接全是本文件常量；supportHtml 必须开，否则 align="right" 的图标不渲染
  md.isTrusted = true;
  md.supportHtml = true;
  statusBar.tooltip = md;
}


function renderError(message: string): void {
  statusBar.text = `$(trae-sparkle) TraeCN --`;
  statusBar.tooltip = `TraeCN 积分余额读取失败\n\n${message}`;
}

async function refresh(verbose: boolean, preResolved?: TraeAuth): Promise<void> {
  if (refreshing) {
    if (verbose) {
      vscode.window.showInformationMessage('TraeCN 积分余额：正在刷新中，请稍候');
    } else {
      // 换凭证这类必须刷新的变更不能因为撞锁被无声丢掉，等当前这轮结束补一轮
      pendingRefresh = true;
    }
    return;
  }
  refreshing = true;
  let auth: TraeAuth | undefined;
  try {
    // 立即给出“正在刷新”的视觉反馈，免除“点了没反应”的困惑；成功后 render/renderError 会覆盖掉
    statusBar.text = '$(sync~spin) 刷新中…';
    statusBar.tooltip = '正在刷新积分…';
    auth = preResolved ?? (await resolveAuth());
    // 积分与签到两个接口并行请求，但必须一起等完：Promise.all 会在积分先失败时立刻放锁，
    // 留下还在飞的签到请求把下一轮的状态盖掉
    const [credits, checkin] = await Promise.allSettled([fetchCredits(auth), refreshCheckinState(auth)]);
    if (checkin.status === 'rejected') {
      log(`签到状态查询异常：${messageOf(checkin.reason)}`);
    }
    if (credits.status === 'rejected') {
      throw credits.reason;
    }
    const summary = credits.value;
    lastAccountName = (auth.username || '').trim();
    lastSummary = summary;
    lastFetchedAt = Date.now();
    render(summary);
    if (verbose) {
      vscode.window.showInformationMessage(
        `TraeCN 积分余额：剩余 ${fmtQuota(summary.remaining, summary.unlimited)}，已用 ${summary.used.toFixed(2)}`
      );
    }
    // 积分取到手顺带处理签到：放在成功分支里，登录态不可用时不该多发一次无谓请求。
    // maybeAutoClaim 自带日期守卫，当天签过就是空操作，不会与本函数递归。
    await maybeAutoClaim(auth);
  } catch (err) {
    const api = err as Partial<import('./api').ApiError>;
    let message = messageOf(err);
    // 登录态过期和 token 用错版本都会回 401，但用户要做的事完全不同。
    // 只认 HTTP 状态码：业务 code 或正文里出现「401」不该盖掉原始提示。
    if (auth && auth.edition !== 'manual' && api.httpStatus === 401 && timesUp(auth.expiredAt)) {
      // 用本地格式化结果，绝不把 storage.json 里的原始串外发到 tooltip
      message = `登录态已于 ${new Date(auth.expiredAt as string).toLocaleString()} 过期，请在 ${editionLabel(auth.edition)} 客户端里重新登录`;
    }
    lastSummary = undefined;
    lastAccountName = '';
    // 接口正文只进输出面板，绝不进 tooltip 和 toast
    log(`刷新失败：${message}${api.remoteDetail ? `｜接口返回：${api.remoteDetail}` : ''}`);
    renderError(message);
    if (verbose) {
      vscode.window.showErrorMessage(`TraeCN 积分余额刷新失败：${message}`);
    }
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      // 兜的是 catch/finally 那一段的意外抛出——floating rejection 会直接终止进程
      void refresh(false).catch(err => log(`补刷失败：${messageOf(err)}`));
    }
  }
}

/** 拉取今日签到状态：悬浮窗只显示今天签没签，日期只写进输出面板 */
async function refreshCheckinState(auth: TraeAuth): Promise<void> {
  const today = new Date().toLocaleDateString('sv');
  try {
    const st = await fetchCheckinStatus(auth);
    const state = st.checked_in ? '今日已签到' : st.enable === false ? '签到活动未开启' : '今日未签到';
    checkinStateText = state;
    checkinStateDay = today;
    if (checkinNote !== `${today} ${state}`) {
      checkinNote = `${today} ${state}`;
      log(`签到状态：${checkinNote}`);
    }
  } catch (err) {
    // 签到状态获取失败不影响积分展示
    checkinStateText = '';
    checkinStateDay = '';
    log(`${today} 签到状态查询失败：${messageOf(err)}`);
  }
}

/**
 * 日期守卫按账号分桶。同一台机器上常同时存在 Trae CN 与 TRAE SOLO CN 两个账号，
 * 共用一个日期会让先领的那个把另一个挡掉一整天（换客户端后刷新也不会补领）。
 * 桶名优先用 userId，拿不到（手动 Token）时退回 edition。
 */
function claimDateOf(accountKey: string): string | undefined {
  const stored = extContext?.globalState.get<unknown>(LAST_CHECKIN_DATE_KEY);
  if (typeof stored === 'string') {
    // 旧格式只存了一个日期串：按默认客户端那次算，避免升级当天重复领一次
    return accountKey === 'cn' ? stored : undefined;
  }
  if (stored && typeof stored === 'object') {
    const value = (stored as Record<string, unknown>)[accountKey];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

async function recordClaimDate(accountKey: string, day: string): Promise<void> {
  const stored = extContext?.globalState.get<unknown>(LAST_CHECKIN_DATE_KEY);
  const map =
    stored && typeof stored === 'object' && typeof stored !== 'string' ? { ...(stored as Record<string, string>) } : {};
  map[accountKey] = day;
  await extContext?.globalState.update(LAST_CHECKIN_DATE_KEY, map);
}

/**
 * 领一次签到。成功才写日期守卫，失败保持原样让下一次刷新自然重试；成败都弹通知（产品定稿）。
 * @param manual 手动命令传 true：被日期守卫挡掉时改为提示「今日已签到」并刷新余额；
 *               自动路径传 false 保持静默，否则每轮刷新都会弹打扰。
 */
/**
 * 提示语里区分账号用。优先 Trae 界面那个昵称，超过 5 个字符用 ... 收尾；
 * 没有昵称（手动 Token）就退回 userId 尾四位，都没有就不带括号。
 */
export function accountLabel(auth: { username?: string | undefined; userId?: string | undefined }): string {
  const name = (auth.username || '').trim();
  if (name) {
    return name.length > 5 ? `${name.slice(0, 5)}...` : name;
  }
  const id = (auth.userId || '').trim();
  return id ? id.slice(-4) : '';
}

async function tryClaim(manual: boolean, preResolved?: TraeAuth): Promise<void> {
  if (claiming) {
    // claim 锁与刷新锁是两把：refresh 的 finally 先跑，此时自动 claim 还在飞，手动命令能进来。
    // 这里合并而不是排队——重复弹窗才是打扰，而服务端本就幂等，第二次没有任何收益。
    return;
  }
  // 日期在发请求前取定：claim 响应若跨过零点才落定，服务端按发出时刻记的是前一天，守卫也必须写同一天。
  const day = todayString();
  claiming = true;
  let alreadyClaimed = false;
  let accountKey = '';
  let tag = '';
  try {
    // 先解析账号再判守卫：守卫按账号分桶，读的哪份登录态就记谁的账。
    const auth = preResolved ?? (await resolveAuth());
    accountKey = auth.userId || auth.edition;
    const who = accountLabel(auth);
    tag = who ? `（${who}）` : '';
    if (!shouldClaim(claimDateOf(accountKey), day)) {
      alreadyClaimed = true;
    } else {
      await claimCheckin(auth);
      await recordClaimDate(accountKey, day);
      clearCheckinTimer();
      log(`${day} 签到成功（${auth.edition}）`);
      vscode.window.showInformationMessage(`TraeCN 签到成功${tag}`);
      // 不在这里再调 refresh()：那会经 maybeAutoClaim 回到 tryClaim 形成回环。
      // 自动路径的积分刷新本来就在同一轮 refresh 里已经取过；手动命令则交给下一次定时刷新反映新余额。
    }
  } catch (err) {
    // 服务端的签到限制是按设备算的（「当前设备今日已经签到，请明日再来哦～」）：
    // 同机第二个账号当天必然拿不到，这是良性结果——记下当天不再重试，也别弹失败红框。
    if ((err as Partial<import('./api').ApiError>).bizCode === CLAIM_DEVICE_ALREADY_TODAY) {
      await recordClaimDate(accountKey, day);
      clearCheckinTimer();
      log(`${day} 本机今日已签到（服务端按设备限一天一次），账号 ${accountKey} 本次不再重试`);
      vscode.window.showInformationMessage(`当前设备已签到，请更换设备${tag}`);
      return;
    }
    const message = messageOf(err);
    const remoteDetail = (err as Partial<import('./api').ApiError>).remoteDetail;
    // 接口正文只进输出面板，toast 里只留用户可读的那半句
    log(`${day} 签到失败：${message}${remoteDetail ? `｜接口返回：${remoteDetail}` : ''}`);
    vscode.window.showErrorMessage(`TraeCN 签到失败：${message}`);
    scheduleCheckinRetry();
  } finally {
    claiming = false;
  }
  // 被守卫挡掉的手动命令：提示 + 刷一次余额。放在锁外，refresh 内部的自动 claim 才不会撞锁，
  // 它本身的失败也不该被上面那个 catch 说成「签到失败」。
  if (alreadyClaimed && manual) {
    vscode.window.showInformationMessage(`TraeCN 今日已签到，无需重复领取${tag}`);
    await refresh(true);
  }
}

/** 自动路径的唯一入口：只看开关；日期守卫收在 tryClaim 里，避免两处各读一次 globalState。
 *  刷新链路已经把 auth 解析过了，顺着传下来复用——手动 Token 的解析要读系统钥匙串，别一轮读两次。 */
async function maybeAutoClaim(preResolved?: TraeAuth): Promise<void> {
  if (!autoCheckinEnabled()) {
    return;
  }
  await tryClaim(false, preResolved);
}

function autoCheckinEnabled(): boolean {
  const raw = cfg().get<unknown>('autoCheckin');
  // 与 refreshInterval 同样的宽容策略：手改成非法值不静默变成关闭，按默认开启处理
  return typeof raw === 'boolean' ? raw : DEFAULT_AUTO_CHECKIN;
}

/**
 * 编辑器一直开着跨过零点时，靠这个定时器补签。
 * 只在「当天还没签成」时存在，全天最多醒一次，签成功即销毁——不做任何轮询。
 */
/**
 * 兜底补签的时刻 = 下一个本地 23:50。签到按本地日切算，当天 23:50 之前失败都还来得及再试；
 * 排到次日凌晨等于放弃当天（那天再不会被动重试），所以不那么排。
 * 恰好落在 23:50 或之后则顺延到明天同一刻，顺带避免 0 延迟的重排风暴。
 */
export function nextCheckinRetryAt(now: Date): Date {
  const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 50, 0, 0);
  if (sameDay.getTime() > now.getTime()) {
    return sameDay;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 50, 0, 0);
}

function scheduleCheckinRetry(): void {
  clearCheckinTimer();
  const now = new Date();
  const delayMs = nextCheckinRetryAt(now).getTime() - now.getTime();
  checkinTimer = setTimeout(() => {
    checkinTimer = undefined;
    // 与同文件另两处 fire-and-forget 的惯例一致：尾巴必须挂 catch——floating rejection 会终止进程
    void maybeAutoClaim().catch(err => log(`定时补签失败：${messageOf(err)}`));
  }, delayMs);
}

function clearCheckinTimer(): void {
  if (checkinTimer) {
    clearTimeout(checkinTimer);
    checkinTimer = undefined;
  }
}

/** 定时器间隔必须是个正经数字：手改成 "abc"/true 会让 setInterval 退化成名 1ms 的循环，把接口打爆 */
function refreshIntervalMinutes(): number {
  const raw = cfg().get<unknown>('refreshInterval');
  // 只有显式写 0 才是关闭。空串经 Number() 也是 0、布尔 true 是 1 分钟，
  // 这两种都是手改 settings.json 的常见误操作，不能悄悄变成「关闭」或「一分钟一刷」
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') {
    return DEFAULT_REFRESH_MINUTES;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) {
    return DEFAULT_REFRESH_MINUTES;
  }
  return Math.min(Math.max(Math.trunc(minutes), 0), MAX_REFRESH_MINUTES);
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  const minutes = refreshIntervalMinutes();
  if (minutes <= 0) {
    log('已关闭积分自动刷新');
    return;
  }
  refreshTimer = setInterval(() => {
    // 回调没人等它的 promise，异常只能就地记下，否则是一颗 floating rejection
    void refresh(false).catch(err => log(`定时刷新失败：${messageOf(err)}`));
  }, minutes * 60 * 1000);
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  secretStore = context.secrets;
  output = vscode.window.createOutputChannel('TraeCN 积分余额');
  // 失败原因里会带上接口返回的片段，用户常整段截图外发，先提示一次
  output.appendLine('提示：本面板的失败详情可能含账号信息，对外求助前请先删掉这些行。');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'traecnquota.refresh';
  statusBar.text = '$(trae-sparkle) TraeCN --';
  statusBar.tooltip = 'TraeCN 积分余额：正在加载…';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('traecnquota.refresh', () => refresh(true)),
    vscode.commands.registerCommand('traecnquota.checkin', () => tryClaim(true)),
    vscode.commands.registerCommand('traecnquota.clearManualToken', () => clearManualToken()),
    vscode.window.onDidChangeActiveColorTheme(() => {
      // SVG 配色是写死的，换主题必须重绘，否则浅色主题下会白字白底
      if (lastSummary) {
        render(lastSummary);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('traecnquota')) {
        return;
      }
      // edition 已移除；启动清理它的回声不需要触发刷新
      if (event.affectsConfiguration('traecnquota.edition')) {
        return;
      }
      // 配置事件对象不跨 await 使用，先把判定算成局部量
      const tokenChanged = event.affectsConfiguration('traecnquota.manualToken');
      const otherKeyChanged = REFRESH_KEYS.some(
        key => key !== 'manualToken' && event.affectsConfiguration(`traecnquota.${key}`)
      );
      // 同一次 settings.json 保存只派发一个多键事件，所以两个判定必须互斥：
      // 还动了 detailRows / planPackFirst 时「需要重绘」优先，不能被下面这个「什么都不用做」的短路吞掉。
      const displayOnly =
        !tokenChanged &&
        !otherKeyChanged &&
        (event.affectsConfiguration('traecnquota.detailRows') ||
          event.affectsConfiguration('traecnquota.planPackFirst'));
      // 只动了 autoCheckin（既不影响渲染也不影响取数）时整轮跳过：拨一次开关就打一次接口是打扰。
      // manualToken 的变更必须优先——清理回声判断和 sweep 都依赖它，不能被判成免刷新。
      const checkinOnly = !tokenChanged && !otherKeyChanged && !displayOnly && NO_EFFECT_KEYS.some(
        key => event.affectsConfiguration(`traecnquota.${key}`)
      );
      // 自己清空设置项荡回来的回声不需要做任何事（其它窗口认不出回声，代价只是多刷一次）。
      // 必须再确认设置项已经空了：清理那几次 await 的窗口期内用户可能又填了一份新值，
      // 只认布尔标记会把新值当回声吞掉——明文留在 settings.json 里，而且要等到下一个配置事件才会被收走。
      const tokenStillSet = (cfg().get<string>('manualToken') || '').trim() !== '';
      if (tokenChanged && !otherKeyChanged && clearingTokenSetting && !tokenStillSet) {
        return;
      }
      void (async () => {
        if (checkinOnly) {
          return;
        }
        if (displayOnly) {
          // 纯排版设置：用上一次的数据重绘即可，不必再打接口
          if (lastSummary) {
            render(lastSummary);
          }
          return;
        }
        if (tokenChanged) {
          await sweepManualToken();
        }
        scheduleRefresh();
        await refresh(false);
      })().catch(err => log(`处理设置变更时出错：${messageOf(err)}`));
    })
  );

  scheduleRefresh();

  // 冷启动补偿：当天还没签成（比如编辑器整天没开过）时排一次当天 23:50 的兜底，签成功即销毁
  if (autoCheckinEnabled() && shouldClaim(context.globalState.get<string>(LAST_CHECKIN_DATE_KEY), todayString())) {
    scheduleCheckinRetry();
  }

  void (async () => {
    await removeLegacyEditionSetting();
    await sweepManualToken();
    const auth = await resolveAuth().catch(() => undefined);
    // 宿主识别诊断：页脚底距按 appName 分流，若 TraeCN 上间距仍不对，先看这行的实际值
    log(`宿主 appName="${vscode.env.appName}"，页脚底距补偿=${footerHostPad(vscode.env.appName)}px`);
    if (auth && timesUp(auth.expiredAt)) {
      log(`登录态已过期（${new Date(auth.expiredAt as string).toLocaleString()}），请重新登录 Trae 客户端`);
    } else if (auth) {
      log(`使用 ${auth.edition === 'manual' ? '手动 Token' : editionLabel(auth.edition)} 的登录态`);
    }
    await refresh(false, auth);
  })().catch(err => log(`启动刷新失败：${messageOf(err)}`));
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  clearCheckinTimer();
}
