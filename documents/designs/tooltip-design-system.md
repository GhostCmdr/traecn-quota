# 悬浮窗设计系统（定稿，版本号钉在 0.1.0）

## 约束前提
- 状态栏 tooltip 只渲染 Markdown：无 CSS、无 HTML 样式，唯一能上真彩的手段是内联 `data:image/svg+xml;base64,` 图片
- SVG 图片内部不能挂点击事件，所以可点击图标必须放在 Markdown 层

## 结构（两层）
1. `### TraeCN 积分余额` 标题行：右侧 `align="right"` 的两个 `<a href="command:...">` + `<img>`（刷新 / 齿轮=打开设置），14px，`hspace="6"`
2. 透明背景 SVG 数据体，宽 251.7，高 192

## 纵向栅格：墨迹间距 GAP=10
**按墨迹（笔画真正出现的像素行）算，不是字体盒。** 像素行是闭区间，所以「10 行空白」= 下一元素墨迹顶行 = 上一元素墨迹底行 + 11（代码里的 `STEP`）。

墨迹延伸（截图逐行扫描实测，`preview/measure-pixels.js`）：

| 元素 | 基线上 | 基线下 |
|---|---|---|
| 30px 大数字（700 字重） | 22 | 3 |
| 10~11px 中英混排 | 9 | 1 |
| 进度条 | 高 5 行 | — |
| 分隔线 | 高 1 行 | — |

链式定位由 `buildTooltipBody` 里 NUM_ASC/NUM_DESC/TXT_ASC/TXT_DESC/BAR_ROWS/LINE_ROWS/STEP 推导，勿写死坐标。
基线（GAP=10 代）：数字 26 / 表头 65 / 首行 93 / 行距 32（93、125、157）/ 页脚 189。3 行明细时 SVG 高 192。

两处到不了 10，是外部约束：
- `浮窗外框顶 → TraeCN 积分余额` = 14（VSCode 的 1px 边框 + 4px padding + h3 的 8px margin）
- `TraeCN 积分余额 → 5,802` = 15（用户点名要 15，由 `NUM_TOP_PAD = 4` 垫出来；标题墨迹底到 SVG 顶只有 10.7px 可用，物理下限是 11）

另外「行 → 其下分隔线」在没有逗号等下伸字符时实测 11：`签到奖励 150 / 150` 的墨迹比 `老用户福利 1,202 / 2,000` 矮 1 行，属内容相关，无法用固定常量消除（`npm test` 的 EXPECTED 已把它按 11 记录）。

**SVG 整体带 `transform="translate(0,0.3)"`**：SVG 在 tooltip 里落在 38.7px 处，不补齐的话 1px 分隔线会被抗锯齿糊成两行，实测间距在 10/11 之间跳。

## 设置界面排序（改不了）
VSCode 的 Settings UI 在每个分组内强制按 key 字母序排：`sortGroups(e){...i.settings.sort((n,r)=>n.key.localeCompare(r.key))}`（workbench.desktop.main.js）。所以 `package.json` 里声明顺序无效，想让 Refresh Interval 排第一只能给 key 加 `a-`/`b-` 前缀，代价是设置 ID 变丑且老配置失效。

## 横向：两个列间距精确 20px（字面边缘）
- 额度列右锚点 `X_QUOTA = 145.6`、总宽 `W = 251.7`：到期时间戳（9.5px，实测宽 86）右锚 W，左缘 165.8，与额度列右缘 145.7 之间 **20.1px**
- 名称列左锚 0、`truncate(name, 11)` 满截断实测右缘 63，额度列最宽值「2,000 / 2,000」左缘 82.1，最小间距 **20.8px**
- 依据：额度列 11px 最宽 62.6px，到期 9.5px 恒 86px，名称截断满 11 格 ≈ 63px

## 大数字带字号上限（实测）
`5,802` 30px/700 + ` / 7,100` 13px/400，整串实测宽 116.8px（800 字重时 121.2）。胶囊左缘在 207.7，留 20 间距则整串右缘上限 187.7：

| 数字/分母 | 5,802 | 58,802 | 123,456 |
|---|---|---|---|
| 28/11 | 112.5 | 135.2 | 155.3 |
| 32/13 | 130 | 156.1 | 179.3 |
| 34/13（历史候选） | 135.4 | 162.8 | 187.0 |
| 36/14 | 144.2 | 173.3 | 199 |
| 38/14 | 149.6 | 179.9 | 206.6 |
| 40/15 | 158.3 | 190.4 | 218.7 |

34/13 是「六位数额仍保住 20px 间距」的物理上限，当前取 30/13（六位剩 36.5px 间距）；38/14 起六位数字会压到胶囊（218.7 > 207.7 从 40 开始真重叠）。改字号必须同步改 NUM_ASC/NUM_DESC（30px/700 实测上伸 22 行、下伸 3 行；800 字重时下伸只有 2 行，改字重必须同步改 NUM_DESC），否则墨迹被 SVG 顶裁掉。

## 字重
大数字 700（800 与 900 在 Segoe UI 里同宽，再往上无更重字面）；额度列左边剩余 600、右边限额 400；分母 400；胶囊内百分比 700。30px 各字重排版宽：400→71.2、500/600→73.86、700→77.16、800/900→81.5。改字重会改逗号下伸（700 比 800 多 1 行），必须同步 NUM_DESC。

## 其它
- 百分比胶囊 44×22 rx=11 与数字墨迹带垂直居中，实心蓝底白字（两主题都是深蓝，故白字恒定）
- 明细行数由设置项 `traecnquota.detailRows`（默认 3，钳制 2~5）决定，作为 `buildTooltipBody` 第 4 个参数传入；按到期时间升序，无到期时间的（不限量）排最后。高度链式跟随行数：2/3/4/5 行 = SVG 160/192/224/256 → 外框 207.2/239.2/271.2/303.2
- 表头「明细 / 额度 / 到期」10px，后两列 `text-anchor="end"`
- 例外：表头二字墨迹底 → 表头分隔线是 5（`HEAD_LINE_GAP`）；标题 → 大数字是 15（`NUM_TOP_PAD=4` 垫出来的，标题墨迹底到 SVG 顶本身只有 10.7px 固定余量）
- 标题行两个图标：齿轮 `hspace=6`、刷新 `hspace=18`。float:right 下齿轮位置只由自身 hspace 决定，所以只放大刷新的 hspace 就能把两图标间隙 12→24 且齿轮不动（实测齿轮 left 240.0 不变）

## 运行时约束
- `refresh()` 有 in-flight 锁：连点或定时器叠加时直接跳过，不再并发打接口
- `postJson` 带 `AbortSignal.timeout(8000)`，网络挂住会明确报超时而不是永久停在「刷新中…」
- `postJson` 校验业务错误信封（HTTP 200 + `code !== 0` 也抛错），不再把错误当空数据
- 配置监听区分显示项与非显示项：只有 `detailRows` 变更时用 `lastSummary` 免网络重绘
- 页脚照常显示签到状态（只说今天签没签，**不显示日期**）与本次刷新时间；带日期的记录另写进输出面板（`checkinNote`）
- `x-ide-version` / `x-ide-version-code` 保持代码内常量，用户明确要求不为此加设置项

## 主题
- SVG 颜色写死，必须跟随 `activeColorTheme.kind`，并在 `onDidChangeActiveColorTheme` 里用 `lastSummary` 重绘，否则浅色主题白字白底
- 调色板成对定义在 `paletteFor()`：strong / body / muted / track / divider / rowLine / accent / pill / accentLow / pillLow
- 低余量（≤20%）切换 accentLow + pillLow；不限量时数字用 ∞、分母位显示「不限量」

## 文字处理
- CJK 全角按 2 格宽计算（`displayWidth`），`truncate` 超出补 `…`
- SVG 内文本必须 `escHtml`；XML 合法字符引用用 `&#160;`，`&nbsp;` 会使整张图破掉

## 校验（不要靠肉眼，也不要靠 getBBox——那是字体盒不是墨迹）
`buildTooltipBody` / `paletteFor` 已导出，预览脚本用 `Module._load` 桩掉 `vscode` 后直接 require `out/extension.js`，示意图与实测跑的都是**出厂代码**，严禁再复制第二份 builder：
- `node preview/measure-pixels.js` — 截图后逐行扫描真实墨迹带，打印相邻墨迹间距（改前/改后对照）
- `node preview/measure-gaps.js` — 三列字面边缘与两个横向间距
- `node preview/measure-vscode.js` — 按本机 VSCode 的 hover CSS 量出 tooltip 真实外框（3 行明细时 269.7 × 239.2）
- `node preview/gen-theme-check.js` — 生成浅色/深色并排示意图 `preview/theme-check.html`
- `preview/chrome.js` — Chrome/Chromium 自动探测（CHROME_PATH → 常见路径 → which），上面几个测量脚本共用
