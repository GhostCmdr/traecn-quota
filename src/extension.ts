import * as vscode from 'vscode';
import { loadAuth, loadAuthFromToken, normalizeApiHost, TraeAuth, editionLabel } from './auth';
import { CreditPack, CreditsSummary, fetchCheckinStatus, fetchCredits } from './api';

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;

let refreshTimer: NodeJS.Timeout | undefined;

/** 最近一次成功取到的数据，供主题切换 / 纯显示项变更时免网络重绘 */
let lastSummary: CreditsSummary | undefined;
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

/** 悬浮窗明细行数的默认值，与 package.json 里 traecnquota.detailRows 的 default 保持一致 */
const DEFAULT_DETAIL_ROWS = 3;
/** 改了必须重新取数的设置项；不在此列的（detailRows）只需按上一次数据重绘 */
const REFRESH_KEYS = ['edition', 'hostOverride', 'manualToken', 'refreshInterval'];

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

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** 剩余占比。状态栏文字与悬浮窗必须同一个口径，否则数据异常时会一个封顶一个不封顶 */
function pctOf(summary: CreditsSummary): number {
  if (summary.unlimited) {
    return 100;
  }
  if (summary.limit <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((summary.remaining / summary.limit) * 100)));
}

function fmtQuota(value: number, unlimited: boolean): string {
  return unlimited ? '不限量' : fmtInt(value);
}

function fmtTime(seconds?: number): string {
  if (!seconds) {
    return '-';
  }
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function timesUp(expiredAt?: string): boolean {
  if (!expiredAt) {
    return false;
  }
  return Date.now() > new Date(expiredAt).getTime();
}

/** 转义 HTML，防止套餐名破坏 SVG/HTML 结构 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

async function resolveAuth(): Promise<TraeAuth> {
  const manual = ((await secretStore?.get(TOKEN_SECRET)) || '').trim();
  let auth: TraeAuth;
  if (manual) {
    auth = loadAuthFromToken(manual);
  } else {
    try {
      auth = loadAuth(cfg().get<string>('edition') || 'auto');
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

/** 明细行数：未配置回落到默认值，可配 2~5，手改成非数字也回落到默认而不是空表 */
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
  return Math.min(Math.max(Math.trunc(n), 2), 5);
}

/** 终端显示宽度：CJK 全角字符按 2 格计，用于 SVG 内名称截断 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      c >= 0x1f300
        ? 2
        : 1;
  }
  return w;
}

/** 按显示宽度截断长名称，超出部分以 … 结尾 */
function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) {
    return s;
  }
  let out = '';
  for (const ch of s) {
    if (displayWidth(out + ch) > width - 1) {
      break;
    }
    out += ch;
  }
  return out + '…';
}

export function svgDataUri(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/**
 * 悬浮窗 SVG 配色。SVG 内不能引用 VSCode 的 CSS 变量，
 * 因此按当前颜色主题（浅色 / 深色）手动选色，避免浅色主题下白字白底不可读。
 */
interface Palette {
  strong: string;
  body: string;
  muted: string;
  track: string;
  divider: string;
  rowLine: string;
  accent: string;
  pill: string;
  accentLow: string;
  pillLow: string;
}

export function paletteFor(kind: vscode.ColorThemeKind): Palette {
  if (kind === vscode.ColorThemeKind.Light) {
    return {
      strong: '#1f2328',
      body: '#24292f',
      muted: '#57606a',
      track: '#d0d7de',
      divider: 'rgba(31,35,40,0.28)',
      rowLine: 'rgba(31,35,40,0.16)',
      accent: '#0969da',
      pill: '#0550ae',
      accentLow: '#cf222e',
      pillLow: '#a5111b'
    };
  }
  return {
    strong: '#ffffff',
    body: '#e6e6e6',
    muted: '#9a9ea6',
    track: '#3f3f46',
    divider: 'rgba(128,128,128,0.25)',
    rowLine: 'rgba(128,128,128,0.18)',
    accent: '#2196f3',
    pill: '#1976d2',
    accentLow: '#f48771',
    pillLow: '#d9534f'
  };
}

/** 图标只有明暗两套配色，base64 结果按颜色缓存，避免每次 render 重拼 */
const iconCache = new Map<string, string>();
function cachedIcon(key: string, build: () => string): string {
  let uri = iconCache.get(key);
  if (!uri) {
    uri = build();
    iconCache.set(key, uri);
  }
  return uri;
}

/** 标题栏右侧可点击图标：刷新（双向弧 sync） */
export function refreshIconUri(color: string): string {
  return cachedIcon('r' + color, () =>
    svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.8a5.2 5.2 0 0 1 8.9-2.4M12.8 9.2a5.2 5.2 0 0 1-8.9 2.4"/><path d="M12.9 1.6v3.2H9.7"/><path d="M3.1 14.4v-3.2h3.2"/></g></svg>`
    )
  );
}

/** 标题栏右侧可点击图标：齿轮（外齿+镂空圆环） */
export function gearIconUri(color: string): string {
  return cachedIcon('g' + color, () =>
    svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${color}">${[0, 45, 90, 135, 180, 225, 270, 315]
        .map(a => `<rect x="7" y="0.9" width="2" height="2.7" rx="0.7" transform="rotate(${a} 8 8)"/>`)
        .join('')}</g><circle cx="8" cy="8" r="3.4" fill="none" stroke="${color}" stroke-width="2.6"/></svg>`
    )
  );
}

/**
 * 悬浮窗数据体 SVG（透明背景）：大数字+分母 / 百分比胶囊 / 进度条 /
 * 明细三列表（表头下 + 每行下均有分隔线）/ 签到页脚。
 */
export function buildTooltipBody(
  packs: CreditPack[],
  summary: CreditsSummary,
  pal: Palette,
  maxRows = DEFAULT_DETAIL_ROWS,
  fetchedAt = Date.now()
): string {
  const W = 251.7;
  const RIGHT = W;
  // 额度列右缘：名称列满截断字形宽 62 + 间距 20 + 额度列最宽 62.6，且到期列(86.9)左缘留出 20 间距
  const X_QUOTA = 145.6;
  const shown = packs.slice(0, maxRows);

  // 纵向：相邻元素的**墨迹**之间留 GAP 行空白。墨迹延伸 = 截图逐行扫描实测（preview/measure-pixels.js），
  // 不是字体盒。像素行是闭区间，所以 10 行空白 = 下一元素 = 上一元素墨迹底行 + 11。
  const GAP = 10;
  const STEP = GAP + 1;
  const HEAD_LINE_GAP = 5 + 1; // 表头「明细」二字墨迹底 → 表头分隔线，比其他间距收紧一半
  const BAR_ROWS = 5;
  const LINE_ROWS = 1;
  const NUM_ASC = 22; // 30px 数字：基线上 22 行有墨迹
  const NUM_DESC = 3; // 700 字重下逗号多占 1 行
  const TXT_ASC = 9; // 10~11px 中英混排：基线上 9 行，下 1 行
  const TXT_DESC = 1;

  // 标题墨迹底到 SVG 顶有 10.7px 固定余量，再往下垫 4 行 → 标题到数字实测间距 15
  const NUM_TOP_PAD = 4;
  const numBase = NUM_TOP_PAD + NUM_ASC;
  const numBot = numBase + NUM_DESC;
  const barTop = numBot + STEP;
  const headBase = barTop + BAR_ROWS + STEP + TXT_ASC;
  const headLineTop = headBase + TXT_DESC + HEAD_LINE_GAP;
  const rowBase = headLineTop + LINE_ROWS + STEP + TXT_ASC;
  const rowPitch = TXT_DESC + STEP + STEP + TXT_ASC;
  const lastRowBot = rowBase + Math.max(shown.length - 1, 0) * rowPitch + TXT_DESC;
  const footBase = lastRowBot + STEP * 2 + TXT_ASC;
  // 页脚墨迹底 → 浮窗下边缘要留 10，Markdown 层（行内图下钻 4.5 + padding 4 + 边框 1）已占 9.5
  const H = footBase + TXT_DESC + STEP - 9;

  const pct = pctOf(summary);
  const low = !summary.unlimited && pct <= 20;
  const accent = low ? pal.accentLow : pal.accent;
  const pillFill = low ? pal.pillLow : pal.pill;

  const parts: string[] = [];

  // 主数值 + 分母（数字更大更粗，分母小字贴基线）
  const big = summary.unlimited ? '∞' : fmtInt(summary.remaining);
  const sub = summary.unlimited ? ' 不限量' : ` / ${fmtInt(summary.limit)}`;
  parts.push(
    `<text x="0" y="${numBase}" fill="${pal.strong}" font-size="30" font-weight="700">${big}<tspan fill="${pal.muted}" font-size="13" font-weight="400">${escHtml(sub)}</tspan></text>`
  );
  // 百分比胶囊（右上，实心蓝底白字，与数字墨迹顶部对齐）
  const pillW = 44;
  const pillH = 22;
  const pillX = RIGHT - pillW;
  const pillY = NUM_TOP_PAD + (NUM_ASC + NUM_DESC - pillH) / 2;
  parts.push(`<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="11" fill="${pillFill}"/>`);
  parts.push(
    `<text x="${pillX + pillW / 2}" y="${pillY + pillH / 2 + 1}" fill="#ffffff" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="middle">${summary.unlimited ? '∞' : pct + '%'}</text>`
  );

  // 进度条
  parts.push(`<rect x="0" y="${barTop}" width="${W}" height="${BAR_ROWS}" rx="2.5" fill="${pal.track}"/>`);
  parts.push(
    `<rect x="0" y="${barTop}" width="${Math.max(BAR_ROWS, (W * pct) / 100).toFixed(1)}" height="${BAR_ROWS}" rx="2.5" fill="${accent}"/>`
  );

  // 表头（上方一条线，下方一条线）
  parts.push(`<text x="0" y="${headBase}" fill="${pal.muted}" font-size="10">明细</text>`);
  parts.push(`<text x="${X_QUOTA}" y="${headBase}" fill="${pal.muted}" font-size="10" text-anchor="end">额度</text>`);
  parts.push(`<text x="${RIGHT}" y="${headBase}" fill="${pal.muted}" font-size="10" text-anchor="end">到期</text>`);
  parts.push(`<line x1="0" y1="${headLineTop + LINE_ROWS / 2}" x2="${W}" y2="${headLineTop + LINE_ROWS / 2}" stroke="${pal.divider}" stroke-width="1"/>`);

  // 明细行：每行文字下方一条分隔线
  let y = rowBase;
  for (const p of shown) {
    const name = escHtml(truncate(p.name, 11));
    const remain = p.unlimited ? '∞' : fmtInt(p.remaining ?? 0);
    const limit = p.unlimited ? '不限量' : fmtInt(p.limit ?? 0);
    parts.push(`<text x="0" y="${y}" fill="${pal.body}" font-size="11">${name}</text>`);
    parts.push(
      `<text x="${X_QUOTA}" y="${y}" font-size="11" text-anchor="end"><tspan fill="${pal.strong}" font-weight="600">${remain}</tspan><tspan fill="${pal.muted}" font-weight="400"> / ${limit}</tspan></text>`
    );
    parts.push(`<text x="${RIGHT}" y="${y}" fill="${pal.muted}" font-size="9.5" text-anchor="end">${fmtTime(p.expireTime)}</text>`);
    const lineTop = y + TXT_DESC + STEP;
    parts.push(`<line x1="0" y1="${lineTop + LINE_ROWS / 2}" x2="${W}" y2="${lineTop + LINE_ROWS / 2}" stroke="${pal.rowLine}" stroke-width="1"/>`);
    y += rowPitch;
  }

  // 页脚：签到状态（只显示今天是否已签到，不带日期）+ 本次刷新时间
  // 页脚：签到状态（只显示今天签没签，不带日期）+ 本次刷新时间。
  // 只在「查的确实是今天」时才展示，跨天后回落成中性的「签到未查询」，不把昨天的状态说成今天的。
  const checkinToday = new Date().toLocaleDateString('sv');
  const checkin = checkinStateText && checkinStateDay === checkinToday ? checkinStateText : '';
  const checked = checkin.startsWith('今日已签到');
  const dotColor = checked ? '#4caf50' : checkin === '今日未签到' ? '#d7a33a' : pal.muted;
  parts.push(`<circle cx="3.5" cy="${footBase - (TXT_ASC - TXT_DESC) / 2}" r="3.5" fill="${dotColor}"/>`);
  parts.push(`<text x="12" y="${footBase}" fill="${pal.body}" font-size="11">${escHtml(checkin || '签到未查询')}</text>`);
  parts.push(
    `<text x="${RIGHT}" y="${footBase}" fill="${pal.muted}" font-size="10" text-anchor="end">更新 ${escHtml(new Date(fetchedAt).toLocaleTimeString())}</text>`
  );

  // SVG 在 tooltip 里落在 38.7px 处，整体下移 0.3 让所有元素压在整数像素行上，
  // 否则抗锯齿会把 1px 分隔线糊成两行，实测间距在 10/11 之间跳。
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif"><g transform="translate(0,0.3)">${parts.join('')}</g></svg>`;
}

function render(summary: CreditsSummary): void {
  const pct = pctOf(summary);
  statusBar.text = summary.unlimited
    ? '$(trae-sparkle) ∞'
    : `$(trae-sparkle) ${fmtInt(summary.remaining)} (${pct}%)`;

  const packs = summary.packs
    .filter(p => p.unlimited || (p.remaining ?? 0) > 0)
    .sort((a, b) => (a.expireTime ?? Infinity) - (b.expireTime ?? Infinity));

  const pal = paletteFor(vscode.window.activeColorTheme.kind);
  const iconColor = pal.muted;

  const md = new vscode.MarkdownString();
  // isTrusted 服务于标题行两个硬编码的 command: 链接；supportHtml 必须为 true，
  // 否则 `<a><img align="right" hspace>` 的刷新/齿轮图标不渲染，右浮动间距纯 Markdown 做不到。
  // 这两项合起来等于「markdown 层里不得出现远程字段」：远程数据只进 base64 的 <img> 内容，
  // 且进 SVG 前已在 api.ts / escHtml 里净化与转义。
  md.isTrusted = true;
  md.supportHtml = true;
  // 标题行：左标题 + 右浮动可点击图标（齿轮=打开设置，刷新=刷新积分）
  md.appendMarkdown(
    `### TraeCN 积分余额 ` +
      `<a href="command:workbench.action.openSettings?%5B%22traecnquota%22%5D"><img src="${gearIconUri(iconColor)}" align="right" width="14" hspace="6" alt="设置"></a>` +
      `<a href="command:traecnquota.refresh"><img src="${refreshIconUri(iconColor)}" align="right" width="14" hspace="18" alt="刷新"></a>\n\n`
  );
  md.appendMarkdown(
    `![积分数据](${svgDataUri(buildTooltipBody(packs, summary, pal, detailRows(), lastFetchedAt))})`
  );
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
    // 积分与签到状态两个接口并行请求，缩短刷新耗时
    const [summary] = await Promise.all([fetchCredits(auth), refreshCheckinState(auth)]);
    lastSummary = summary;
    lastFetchedAt = Date.now();
    render(summary);
    if (verbose) {
      vscode.window.showInformationMessage(
        `TraeCN 积分余额：剩余 ${fmtQuota(summary.remaining, summary.unlimited)}，已用 ${summary.used.toFixed(2)}`
      );
    }
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
      void refresh(false);
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

/** 定时器间隔必须是个正经数字：手改成 "abc"/true 会让 setInterval 退化成名 1ms 的循环，把接口打爆 */
function refreshIntervalMinutes(): number {
  const raw = cfg().get<unknown>('refreshInterval');
  const minutes = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(minutes)) {
    return 30;
  }
  return Math.min(Math.max(Math.trunc(minutes), 0), 1440);
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
    void refresh(false);
  }, minutes * 60 * 1000);
}

export function activate(context: vscode.ExtensionContext): void {
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
      // 配置事件对象不跨 await 使用，先把判定算成局部量
      const tokenChanged = event.affectsConfiguration('traecnquota.manualToken');
      const otherKeyChanged = REFRESH_KEYS.some(
        key => key !== 'manualToken' && event.affectsConfiguration(`traecnquota.${key}`)
      );
      const displayOnly = !tokenChanged && !otherKeyChanged && event.affectsConfiguration('traecnquota.detailRows');
      // 自己清空设置项荡回来的回声不需要做任何事（其它窗口认不出回声，代价只是多刷一次）
      if (tokenChanged && !otherKeyChanged && clearingTokenSetting) {
        return;
      }
      void (async () => {
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

  void (async () => {
    await sweepManualToken();
    const auth = await resolveAuth().catch(() => undefined);
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
}
