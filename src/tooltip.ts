import { fmtCredits, formatDateTime, pctOf } from './format';

/* ============================ 通用工具 ============================ */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function svgDataUri(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/* ====================== 文字宽度 / 截断 ====================== */
/**
 * 11px Segoe UI 400 字重下 ASCII 32..126 的实测推进宽度（无头 Chrome canvas 实测）。
 * 不能统一按 6.1 估：大写 W 10.27、小写 i 2.66，差近 4 倍。
 */
const ASCII_W = [
  3.01, 3.13, 4.31, 6.50, 5.93, 9.00, 6.10, 2.53, 3.32, 3.32, 4.59, 7.52, 2.38, 4.40, 2.38, 4.29,
  5.93, 5.93, 5.93, 5.93, 5.93, 5.93, 5.93, 5.93, 5.93, 5.93, 2.38, 2.38, 6.10, 7.52, 6.10, 4.93,
  10.51, 7.10, 6.31, 6.81, 7.71, 5.56, 5.37, 7.55, 7.81, 2.93, 3.93, 6.38, 5.18, 9.88, 8.23, 8.29,
  6.16, 8.29, 6.58, 5.84, 5.76, 7.56, 6.83, 10.27, 6.49, 6.08, 6.27, 3.32, 4.17, 3.32, 7.52, 4.57,
  2.95, 5.60, 6.47, 5.08, 6.48, 5.75, 3.44, 6.48, 6.23, 2.66, 2.66, 5.47, 2.66, 9.47, 6.23, 6.45,
  6.47, 6.48, 3.82, 4.67, 3.73, 6.23, 5.27, 7.95, 5.05, 5.32, 4.97, 3.32, 2.63, 3.32, 7.52
];

/** 11px 下的推进宽度（ASCII 查表、CJK 11、省略号 8.06、∞ 8.99） */
function glyphPx(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 32 && c <= 126) {
    return ASCII_W[c - 32] ?? 6.1;
  }
  if (ch === '…') {
    return 8.06;
  }
  if (ch === '∞') {
    return 8.99;
  }
  if (c >= 0x1f300) {
    return 12;
  }
  if (c >= 0x2e80) {
    return 11;
  }
  return 6.1;
}

export function textPx(s: string): number {
  let px = 0;
  for (const ch of s) {
    px += glyphPx(ch);
  }
  return px;
}

/**
 * 按像素预算截断：整名放得下就原样返回；否则先扣省略号宽度再逐字累加，
 * 补 … 前去掉尾部空格（`Subscription ` → `Subscription…`）。
 */
export function truncatePx(s: string, roomPx: number): string {
  if (textPx(s) <= roomPx) {
    return s;
  }
  const room = roomPx - glyphPx('…');
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = glyphPx(ch);
    if (w + cw > room) {
      break;
    }
    out += ch;
    w += cw;
  }
  return out.replace(/\s+$/, '') + '…';
}

export interface PanelPackInput {
  name: string;
  remain: number;
  limit: number;
  unlimited: boolean;
  /** 订阅套餐包：由接口的 entitlement_base_info.product_type 判定 */
  plan?: boolean | undefined;
  expireTime?: number | undefined;
}

export interface PanelSummary {
  remain: number;
  total: number;
  unlimited: boolean;
  packs: PanelPackInput[];
}

export interface PanelData {
  remain: number;
  total: number;
  pct: number;
  unlimited: boolean;
  packs: Array<{ name: string; remain: number; limit: number; unlimited: boolean; plan: boolean; expiry: string }>;
  checkin: string;
  updatedAt: string;
  /** 账号昵称（自动读取时来自 storage.json，手动 Token 时来自 token 声明）；取不到就是空串 */
  account: string;
}

/** 明细行排序：不限量包始终置顶；开了订阅套餐置顶时套餐包更靠前。组内按到期升序，无到期排最后 */
function orderPacks(packs: PanelPackInput[], pinPlan: boolean): PanelPackInput[] {
  const rank = (p: PanelPackInput) => (pinPlan ? (p.plan ? 0 : p.unlimited ? 1 : 2) : p.unlimited ? 0 : 1);
  const expiry = (p: PanelPackInput) => p.expireTime ?? Number.POSITIVE_INFINITY;
  return [...packs].sort((a, b) => rank(a) - rank(b) || expiry(a) - expiry(b));
}

/** 到期列到分钟；不限量时整体占比记 100 */
export function buildPanelData(
  summary: PanelSummary,
  checkin: string,
  updatedAt: string,
  account = '',
  pinPlan = false
): PanelData {
  // 空包默认不显示；开了订阅套餐置顶时套餐包豁免。
  // 例外：所有有效包都没有剩余时，保留空包行，避免面板只剩表头。
  const eligible = summary.packs.filter((p) => p.unlimited || p.limit !== undefined);
  const hasRemaining = eligible.some((p) => p.unlimited || p.remain > 0);
  const visible = eligible.filter(
    (p) => p.unlimited || p.remain > 0 || (pinPlan && !!p.plan) || !hasRemaining
  );
  const ordered = orderPacks(visible, pinPlan);
  return {
    remain: summary.remain,
    total: summary.total,
    pct: summary.unlimited ? 100 : pctOf(summary.remain, summary.total),
    unlimited: summary.unlimited,
    packs: ordered.map((p) => ({
      name: p.name,
      remain: p.remain,
      limit: p.limit,
      unlimited: p.unlimited,
      plan: !!p.plan,
      expiry: formatDateTime(p.expireTime)
    })),
    checkin,
    updatedAt,
    account: (account ?? '').trim()
  };
}

export interface Palette {
  strong: string;
  body: string;
  muted: string;
  track: string;
  divider: string;
  rowLine: string;
  /** 进度条三档：>60% 蓝 / 20~60% 橙 / ≤20% 红 */
  accent: string;
  accentMid: string;
  accentLow: string;
  /** 图标色：与标题文字同色 */
  icon: string;
  /** 百分比胶囊三档，与进度条同档同色系（更深，白字才压得住） */
  pill: string;
  pillMid: string;
  pillLow: string;
  /** 套餐标签底：accent 的 12% 透明度，字用 accent */
  chipBg: string;
}

/** SVG 内不能引用 VSCode 的 CSS 变量，按主题手选色；进度条与胶囊按余量分三档（>60% 蓝 / 20~60% 橙 / ≤20% 红） */
export function paletteFor(theme: 'light' | 'dark'): Palette {
  if (theme === 'light') {
    return {
      strong: '#1f2328',
      body: '#24292f',
      muted: '#57606a',
      icon: '#3d444d',
      track: '#d0d7de',
      divider: 'rgba(31,35,40,0.28)',
      rowLine: 'rgba(31,35,40,0.16)',
      accent: '#0969da',
      accentMid: '#fb8500',
      accentLow: '#cf222e',
      pill: '#0550ae',
      pillMid: '#bc4c00',
      pillLow: '#a5111b',
      chipBg: 'rgba(9,105,218,0.12)'
    };
  }
  return {
    strong: '#ffffff',
    body: '#e6e6e6',
    muted: '#9a9ea6',
    icon: '#c0c4cb',
    track: '#3f3f46',
    divider: 'rgba(128,128,128,0.25)',
    rowLine: 'rgba(128,128,128,0.18)',
    accent: '#2196f3',
    accentMid: '#ff9800',
    accentLow: '#f48771',
    pill: '#1976d2',
    pillMid: '#e65100',
    pillLow: '#d9534f',
    chipBg: 'rgba(33,150,243,0.12)'
  };
}

/* ============================ 标题栏图标 ============================ */
const iconCache = new Map<string, string>();
function cachedIcon(key: string, build: () => string): string {
  let uri = iconCache.get(key);
  if (!uri) {
    uri = build();
    iconCache.set(key, uri);
  }
  return uri;
}

/**
 * 右浮动图标只吃行框顶、不吃基线对齐；这里把 viewBox 往上扩 drop 行（图变高、墨迹下移）。
 * 真机实测 drop=0，保留这个口子是给换宿主后 1~2px 偏移兜底。
 */
export function dropIconUri(uri: string, dropPx: number, size: number): { uri: string; height: number } {
  const pad = dropPx === 0 ? 0 : (dropPx * 16) / size;
  if (!pad) {
    return { uri, height: size };
  }
  const payload = uri.split(',')[1] ?? '';
  const svg = Buffer.from(payload, 'base64').toString('utf8');
  const shifted = svg.replace(
    'width="16" height="16" viewBox="0 0 16 16"',
    `width="16" height="${16 + pad}" viewBox="0 -${pad} 16 ${16 + pad}"`
  );
  return { uri: 'data:image/svg+xml;base64,' + Buffer.from(shifted).toString('base64'), height: size + pad };
}
/** 真机实测下移量 0（与 codebuddy 相同的标定方式） */
const ICON_DROP_PX = 0;
const ICON_SIZE = 16;

/** 刷新（双向弧 sync） */
export function refreshIconUri(color: string): string {
  return cachedIcon(
    'refresh:' + color,
    () =>
      svgDataUri(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.37 6.84a5.02 5.02 0 0 1 8.59-2.32M12.63 9.16a5.02 5.02 0 0 1-8.59 2.32"/><path d="M12.73 1.82v3.09H9.64"/><path d="M3.24 14.18v-3.09h3.09"/></g></svg>`
      )
  );
}

/** 齿轮（外齿 + 镂空圆环） */
export function gearIconUri(color: string): string {
  return cachedIcon(
    'gear:' + color,
    () =>
      svgDataUri(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${color}">${[0, 45, 90, 135, 180, 225, 270, 315]
          .map((a) => `<rect x="7" y="1" width="2" height="2.6" rx="0.7" transform="rotate(${a} 8 8)"/>`)
          .join('')}</g><circle cx="8" cy="8" r="3.4" fill="none" stroke="${color}" stroke-width="2.6"/></svg>`
      )
  );
}

/** 用量明细（四根等长横线，对齐 traecn） */
export function usageIconUri(color: string): string {
  return cachedIcon(
    'usage:' + color,
    () =>
      svgDataUri(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"><path d="M3 3.35h10"/><path d="M3 6.45h10"/><path d="M3 9.55h10"/><path d="M3 12.65h10"/></g></svg>`
      )
  );
}

/**
 * 用量明细的跳转目标。Trae 系顶栏那个「点击查看积分用量明细」按钮走
 * workbench.action.icubeOpenUsageDetails（命令 id 从本机 Trae 的 workbench 包里核出），
 * 其他宿主没这条命令，点了会报错，所以回落到网页端用量页。
 */
export function usageTargetHref(appName: string | undefined): string {
  return /trae/i.test(appName ?? '')
    ? 'command:workbench.action.icubeOpenUsageDetails'
    : 'https://www.trae.cn/dashboard#usage';
}

/* ====================== 宿主页脚底距补偿 ====================== */
/**
 * 行内图下方宿主额外补的空间两家不同：VS Code / CodeBuddy 系补 ~7.9 单位（契约取 9），
 * Trae 系 CSS 覆盖后补 ~3.4（契约取 4）。未识别宿主回落 VS Code。
 */
export function footerHostPad(appName: string | undefined): number {
  return /trae/i.test(appName ?? '') ? 4 : 9;
}

/* ====================== 纵向墨迹栅格 ====================== */
const W = 251.7;
/** 额度列：`/` 固定在画布中线，与表头「额度」同一参考点 */
const SLASH_X = W / 2;
const SLASH_W = 4.29;
/**
 * 值与 `/` 的间距左右不对称：remain 是 600 字重（墨迹右缘基本贴锚点），
 * limit 是 400 字重（墨迹左缘缩进锚点约 1px），两边各取 3 会让墨迹看着左窄右宽。
 * 左 3.7 / 右 3.4 补偿后，数字串两侧的墨迹间距都≈2.7px。
 */
const SLASH_GAP_L = 3.7;
const SLASH_GAP_R = 3.4;
/** remain 右锚、limit 左锚 */
const REMAIN_RIGHT = SLASH_X - SLASH_W / 2 - SLASH_GAP_L;
const LIMIT_LEFT = SLASH_X + SLASH_W / 2 + SLASH_GAP_R;
/** 名称↔remain、limit↔到期 的统一间距（两侧等距） */
const SIDE_GAP_PX = 13;
/** 剩余额度串是 600 字重，与 400 字重的宽度表有 ±差异，预算时垫 0.4 留余量 */
const BOLD_PAD_PX = 0.4;
/** 套餐行名称后的「套餐内」标签（34×14 圆角片，8.5px 字居中）；进名称预算，防止压到额度列 */
const PLAN_CHIP_TEXT = '套餐内';
const PLAN_CHIP_FS = 8.5;
const PLAN_CHIP_W = 34;
const PLAN_CHIP_H = 14;
const PLAN_CHIP_GAP = 4;
/** 相邻元素「墨迹」之间留 GAP 行空白；像素行闭区间，故 STEP = GAP + 1 */
const GAP = 10;
const STEP = GAP + 1;
/** 表头二字墨迹底 → 表头分隔线，比其他间距收紧一半 */
const HEAD_LINE_GAP = 5 + 1;
const BAR_ROWS = 5;
const LINE_ROWS = 1;
const NUM_ASC = 22; // 30px 数字：基线上 22 行有墨迹
const NUM_DESC = 3; // 700 字重下逗号多占 1 行
const TXT_ASC = 9; // 10~11px 中英混排：基线上 9 行，下 1 行
const TXT_DESC = 1;
/** 标题墨迹底到 SVG 顶有 ~10.7px 固定余量，再垫 4 行 → 标题到数字实测 13 */
const NUM_TOP_PAD = 4;

export interface TooltipLayout {
  numBase: number;
  barTop: number;
  headBase: number;
  headLineTop: number;
  rowBase: number;
  rowPitch: number;
  footBase: number;
  H: number;
}

export function tooltipLayout(detailRows: number, appName: string | undefined): TooltipLayout {
  const rows = Math.max(0, detailRows);
  const numBase = NUM_TOP_PAD + NUM_ASC;
  const numBot = numBase + NUM_DESC;
  const barTop = numBot + STEP;
  const headBase = barTop + BAR_ROWS + STEP + TXT_ASC;
  const headLineTop = headBase + TXT_DESC + HEAD_LINE_GAP;
  const rowBase = headLineTop + LINE_ROWS + STEP + TXT_ASC;
  const rowPitch = TXT_DESC + STEP + STEP + TXT_ASC;
  const lastRowBot = rowBase + Math.max(rows - 1, 0) * rowPitch + TXT_DESC;
  const footBase = lastRowBot + STEP * 2 + TXT_ASC;
  const H = footBase + TXT_DESC + STEP - footerHostPad(appName);
  return { numBase, barTop, headBase, headLineTop, rowBase, rowPitch, footBase, H };
}

/* ============================ 账号徽标 ============================ */
/**
 * 账号徽标渲染在**标题行**（Markdown 层）：Markdown 里改不了文字字号与颜色，
 * 所以整块（小人图标 + 名字）做成一张 18px 高的透明 SVG 小图，**行内**跟在标题文字后面。
 * 行内图超宽会顶到图标那一段并被迫换行，所以宽度必须算准、宁窄勿宽。
 */
const ACCOUNT_FONT_PX = 10;
/**
 * 标题行横向预算：内容宽 W 减掉固定部分，剩下的才是徽标（小人 10.89 + 名字）能占的盒宽。
 * 徽标超预算会把「用量明细」挤到第二行，所以预算里必须给「徽标↔图标」留出
 * BADGE_ICON_MIN_GAP_PX 的盒间距兜底，宁可截断名字也不侵占图标。
 *
 * TraeCN 积分面板：本机无头 Chrome 15.21px/700 实测推进宽 116.778，保守加 6 取 123；
 * 标题后的普通空格实测 4.196，取 4.2。改标题文案要同步改这两个数。
 */
const TITLE_TEXT_PX = 123;
const TITLE_BADGE_SPACE_PX = 4.2;
const ICONS_WIDTH_PX = 48; // 三枚 16px 右浮动图标（hspace=0）
/** 徽标盒右缘到图标盒左缘的最低间距 */
const BADGE_ICON_MIN_GAP_PX = 2;
const ACCOUNT_BUDGET_PX = W - TITLE_TEXT_PX - TITLE_BADGE_SPACE_PX - ICONS_WIDTH_PX - BADGE_ICON_MIN_GAP_PX; // = 74.5

/** 10px + 600 字重下 ASCII 32..126 的实测推进宽度 */
const ASCII_W600 = [
  2.75, 3.04, 4.38, 5.91, 5.55, 8.4, 7.15, 2.58, 3.32, 3.32,
  4.34, 6.94, 2.41, 4.02, 2.41, 4.14, 5.55, 4.02, 5.55, 5.55,
  5.76, 5.55, 5.58, 5.36, 5.55, 5.58, 2.41, 2.41, 6.94, 6.94,
  6.94, 4.44, 9.55, 6.71, 6.04, 6.21, 7.17, 5.18, 5.02, 6.97,
  7.35, 2.92, 3.96, 6.11, 4.89, 9.24, 7.67, 7.56, 5.84, 7.56,
  6.23, 5.44, 5.52, 7.03, 6.42, 9.66, 6.19, 5.77, 5.87, 3.32,
  4.05, 3.32, 6.94, 4.15, 2.89, 5.22, 6.03, 4.7, 6.03, 5.31,
  3.45, 6.03, 5.82, 2.61, 2.61, 5.25, 2.61, 8.86, 5.83, 5.97,
  6.03, 6.03, 3.7, 4.31, 3.61, 5.83, 5.07, 7.56, 5.01, 5.08,
  4.64, 3.32, 2.78, 3.32, 6.94
];

/** 徽标名字（10px/600）的推进宽度：ASCII 查表、CJK 10、省略号 8.13 */
function accountCharPx(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 32 && c <= 126) {
    return ASCII_W600[c - 32] ?? 6.3;
  }
  if (ch === '…') {
    return 8.13;
  }
  if (c >= 0x1f300) {
    return 11;
  }
  if (c >= 0x2e80) {
    return 10;
  }
  return 6.3;
}

function accountTextPx(s: string): number {
  let px = 0;
  for (const ch of s) {
    px += accountCharPx(ch);
  }
  return px;
}

/** 只按宽度截：整名放得下就原样；放不下先扣省略号再逐字累加 */
export function clipAccountName(name: string): string {
  const chars = Array.from(name);
  const room = ACCOUNT_BUDGET_PX - ACCOUNT_ICON_W;
  const full = chars.join('');
  if (accountTextPx(full) <= room) {
    return full;
  }
  const out: string[] = [];
  let w = accountCharPx('…');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const cw = accountCharPx(ch);
    if (w + cw > room) {
      break;
    }
    out.push(ch);
    w += cw;
  }
  return out.join('').replace(/\s+$/, '') + '…';
}

/** 图高 18：名字基线 14，上下各留 4 行给中文下伸与抗锯齿 */
const ACCOUNT_H = 18;
/** 小人墨迹高（图内高度）；名字基线 = 小人墨迹底 */
const AV_INK_H = 10;
const AV_TOP = (ACCOUNT_H - AV_INK_H) / 2;
const ACCOUNT_BASE = AV_TOP + AV_INK_H;
/** 图内左侧留白：刚好容纳小人描边的半个宽度 */
const ACCOUNT_PAD_LEFT = 0.8;
/** 小人与名字之间 ≈ G 与 h 的字间空隙 */
const ACCOUNT_GAP_PX = 1.0;
/**
 * 小人图标：16 单位原始人形（圆头外径 10、描边 2 + 半径 6.5 的半圆肩弧，弧顶压住头圆底边），
 * 按墨迹高 AV_INK_H 整体缩放（实测 16.5 单位墨迹压到 10px），弧端圆头帽让墨迹在基线下方多出半个描边（0.67px）。
 */
const ICON_SCALE = AV_INK_H / 16.5;
const ICON_W = 15 * ICON_SCALE;
const ACCOUNT_ICON_W = ACCOUNT_PAD_LEFT + ICON_W + ACCOUNT_GAP_PX;

export function accountBadge(account: string, color: string): { uri: string; width: number; label: string } {
  const name = clipAccountName(account);
  const w = ACCOUNT_ICON_W + accountTextPx(name);
  const B = ACCOUNT_BASE;
  // 缩放与平移都算进坐标，输出里没有 transform
  const k = ICON_SCALE;
  const tx = ACCOUNT_PAD_LEFT - 0.5 * k;
  const ty = AV_TOP;
  const cx = 8 * k + tx;
  const cy = 5 * k + ty;
  const r = 4 * k;
  const sw = 2 * k;
  const sx = 1.5 * k + tx;
  const sy = 15.5 * k + ty;
  const ar = 6.5 * k;
  const adx = 13 * k;
  const icon =
    `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}"/>` +
    `<path d="M${sx.toFixed(2)} ${sy.toFixed(2)}a${ar.toFixed(2)} ${ar.toFixed(2)} 0 0 1 ${adx.toFixed(2)} 0" fill="none" stroke="${color}" stroke-width="${sw.toFixed(2)}" stroke-linecap="round"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${ACCOUNT_H}" viewBox="0 0 ${w.toFixed(1)} ${ACCOUNT_H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">` +
    icon +
    `<text x="${(ACCOUNT_PAD_LEFT + ICON_W + ACCOUNT_GAP_PX).toFixed(2)}" y="${B}" fill="${color}" font-size="${ACCOUNT_FONT_PX}" font-weight="600">${escHtml(name)}</text></svg>`;
  return { uri: svgDataUri(svg), width: w, label: name };
}

/* ============================ SVG 主体 ============================ */
export function buildTooltipSvg(data: PanelData, pal: Palette, detailRows: number, appName: string | undefined): string {
  const shown = data.packs.slice(0, detailRows);
  const RIGHT = W;
  // 高度按实际显示行数算，而非 detailRows：积分包少于配置行数时，页脚要紧跟实际末行，否则底部留空
  const L = tooltipLayout(shown.length, appName);
  const parts: string[] = [];
  // 主数值 + 分母（数字更大更粗，分母小字贴基线）；不限量显示 不限量 / ∞
  const big = data.unlimited ? '不限量' : escHtml(fmtCredits(data.remain));
  const sub = data.unlimited ? ' / ∞' : ` / ${escHtml(fmtCredits(data.total))}`;
  parts.push(`<text x="0" y="${L.numBase}" fill="${pal.strong}" font-size="30" font-weight="700">${big}<tspan fill="${pal.muted}" font-size="13" font-weight="400">${sub}</tspan></text>`);
  // 百分比胶囊（右上，实心底白字，与数字墨迹带垂直居中）；进度条与胶囊按余量分三档
  const accent = data.pct <= 20 ? pal.accentLow : data.pct <= 60 ? pal.accentMid : pal.accent;
  const pillFill = data.pct <= 20 ? pal.pillLow : data.pct <= 60 ? pal.pillMid : pal.pill;
  const pillW = 44;
  const pillH = 22;
  const pillX = RIGHT - pillW;
  // 从数字基线反推，不写死 NUM_TOP_PAD
  const pillY = L.numBase - NUM_ASC + (NUM_ASC + NUM_DESC - pillH) / 2;
  parts.push(`<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="11" fill="${pillFill}"/>`);
  parts.push(`<text x="${pillX + pillW / 2}" y="${pillY + pillH / 2 + 1}" fill="#ffffff" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="middle">${data.pct}%</text>`);
  // 进度条（0% 时保底圆角可见；不限量时满）
  const barPct = data.unlimited ? 100 : data.pct;
  parts.push(`<rect x="0" y="${L.barTop}" width="${W}" height="${BAR_ROWS}" rx="2.5" fill="${pal.track}"/>`);
  parts.push(`<rect x="0" y="${L.barTop}" width="${Math.max(BAR_ROWS, (W * barPct) / 100).toFixed(1)}" height="${BAR_ROWS}" rx="2.5" fill="${accent}"/>`);
  // 表头（下方一条分隔线）：额度居中，与明细行的 `/` 共用一条中线
  parts.push(`<text x="0" y="${L.headBase}" fill="${pal.muted}" font-size="10">明细</text>`);
  parts.push(`<text x="${SLASH_X}" y="${L.headBase}" fill="${pal.muted}" font-size="10" text-anchor="middle">额度</text>`);
  parts.push(`<text x="${RIGHT}" y="${L.headBase}" fill="${pal.muted}" font-size="10" text-anchor="end">到期</text>`);
  parts.push(`<line x1="0" y1="${L.headLineTop + LINE_ROWS / 2}" x2="${W}" y2="${L.headLineTop + LINE_ROWS / 2}" stroke="${pal.divider}" stroke-width="1"/>`);
  // 名称列预算按本次展示行里最宽的 remain 反推，两侧间距统一 13；逐行各算会让同列截断参差
  const widestRemain = shown
    .map((p) => (p.unlimited ? '不限量' : fmtCredits(p.remain)))
    .reduce((a, b) => (textPx(b) > textPx(a) ? b : a), '');
  const nameRoom = REMAIN_RIGHT - textPx(widestRemain) - BOLD_PAD_PX - SIDE_GAP_PX;
  let y = L.rowBase;
  for (const p of shown) {
    const remainText = p.unlimited ? '不限量' : escHtml(fmtCredits(p.remain));
    const limitText = p.unlimited ? '∞' : escHtml(fmtCredits(p.limit));
    const displayName = truncatePx(p.name, p.plan ? nameRoom - PLAN_CHIP_W - PLAN_CHIP_GAP : nameRoom);
    parts.push(`<text x="0" y="${y}" fill="${pal.body}" font-size="11">${escHtml(displayName)}</text>`);
    if (p.plan) {
      const chipX = textPx(displayName) + PLAN_CHIP_GAP;
      parts.push(`<rect x="${chipX.toFixed(1)}" y="${y - 11}" width="${PLAN_CHIP_W}" height="${PLAN_CHIP_H}" rx="7" fill="${pal.chipBg}"/>`);
      parts.push(`<text x="${(chipX + PLAN_CHIP_W / 2).toFixed(1)}" y="${y - 1}" fill="${pal.accent}" font-size="${PLAN_CHIP_FS}" text-anchor="middle">${PLAN_CHIP_TEXT}</text>`);
    }
    parts.push(`<text x="${REMAIN_RIGHT.toFixed(1)}" y="${y}" fill="${pal.strong}" font-size="11" font-weight="600" text-anchor="end">${remainText}</text>`);
    parts.push(`<text x="${SLASH_X}" y="${y}" fill="${pal.muted}" font-size="11" text-anchor="middle">/</text>`);
    parts.push(`<text x="${LIMIT_LEFT.toFixed(1)}" y="${y}" fill="${pal.body}" font-size="11">${limitText}</text>`);
    parts.push(`<text x="${RIGHT}" y="${y}" fill="${pal.body}" font-size="9.5" text-anchor="end">${escHtml(p.expiry)}</text>`);
    const lineTop = y + TXT_DESC + STEP;
    parts.push(`<line x1="0" y1="${lineTop + LINE_ROWS / 2}" x2="${W}" y2="${lineTop + LINE_ROWS / 2}" stroke="${pal.rowLine}" stroke-width="1"/>`);
    y += L.rowPitch;
  }
  // 页脚：签到状态（只说今天签没签，不带日期）+ 本次刷新时间
  const checkinText = data.checkin === 'claimed' ? '今日已签到'
    : data.checkin === 'unclaimed' ? '今日未签到'
      : data.checkin === 'disabled' ? '签到活动未开启'
        : '签到未查询';
  const dotColor = data.checkin === 'claimed' ? '#4caf50' : data.checkin === 'unclaimed' ? '#d7a33a' : pal.muted;
  parts.push(`<circle cx="3.5" cy="${L.footBase - (TXT_ASC - TXT_DESC) / 2}" r="3.5" fill="${dotColor}"/>`);
  parts.push(`<text x="12" y="${L.footBase}" fill="${pal.body}" font-size="11">${escHtml(checkinText)}</text>`);
  parts.push(`<text x="${RIGHT}" y="${L.footBase}" fill="${pal.body}" font-size="10" text-anchor="end">更新 ${escHtml(data.updatedAt)}</text>`);
  // 整体下移 0.3 让元素压在整数像素行上，否则抗锯齿会把 1px 分隔线糊成两行（实测间距在 10/11 之间跳）
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${L.H}" viewBox="0 0 ${W} ${L.H}" font-family="Segoe UI, Microsoft YaHei, sans-serif"><g transform="translate(0,0.3)">${parts.join('')}</g></svg>`;
}

/* ============================ Markdown 包装 ============================ */
export const DEFAULT_DETAIL_ROWS = 3;
export const MIN_DETAIL_ROWS = 1;
export const MAX_DETAIL_ROWS = 6;

export function clampDetailRows(n: number): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) {
    return DEFAULT_DETAIL_ROWS;
  }
  return Math.min(MAX_DETAIL_ROWS, Math.max(MIN_DETAIL_ROWS, v));
}

/**
 * hover 浮窗 Markdown：标题行（左标题 + 行内账号徽标 + 右浮动可点图标）+ 单张透明背景 SVG 数据体。
 * 图标必须放 Markdown 层才可点（图片内部元素不可点）；float:right 按 DOM 顺序从右往左排，
 * 故 DOM 顺序 齿轮→刷新→用量 的视觉顺序是 用量·刷新·齿轮。
 */
export function buildTooltipMarkdown(
  data: PanelData,
  opts: { theme?: 'light' | 'dark'; iconColor?: string; detailRows?: number; appName?: string } = {}
): string {
  const pal = paletteFor(opts.theme ?? 'dark');
  const iconColor = opts.iconColor ?? pal.icon;
  const rows = clampDetailRows(opts.detailRows ?? DEFAULT_DETAIL_ROWS);
  const g = dropIconUri(gearIconUri(iconColor), ICON_DROP_PX, ICON_SIZE);
  const r = dropIconUri(refreshIconUri(iconColor), ICON_DROP_PX, ICON_SIZE);
  const u = dropIconUri(usageIconUri(iconColor), ICON_DROP_PX, ICON_SIZE);
  const gear = `<a href="command:workbench.action.openSettings?%5B%22traecnquota%22%5D" title="设置"><img src="${g.uri}" align="right" width="${ICON_SIZE}" height="${g.height}" hspace="0" alt="设置"></a>`;
  const refresh = `<a href="command:traecnquota.refresh" title="刷新"><img src="${r.uri}" align="right" width="${ICON_SIZE}" height="${r.height}" hspace="0" alt="刷新"></a>`;
  const usage = `<a href="${usageTargetHref(opts.appName)}" title="用量明细"><img src="${u.uri}" align="right" width="${ICON_SIZE}" height="${u.height}" hspace="0" alt="用量明细"></a>`;
  // 账号徽标是行内图（不浮动）：紧跟标题文字，三枚图标仍然右浮动停在最右边
  let badge = '';
  if (data.account) {
    const b = accountBadge(data.account, pal.muted);
    // 末尾不要留空格：空格也算行内宽度，会把图标挤到第二行
    badge = `<img src="${b.uri}" align="top" width="${b.width.toFixed(1)}" height="${ACCOUNT_H}" alt="当前账号 ${escHtml(b.label)}">`;
  }
  const body = svgDataUri(buildTooltipSvg(data, pal, rows, opts.appName));
  return `### TraeCN 积分面板 ${badge}${gear}${refresh}${usage}\n\n![积分数据](${body})`;
}
