# TraeCN Quota

在状态栏实时显示 Trae CN（trae.cn）账号的积分余额与套餐明细。

## 安装

**扩展面板搜索**（VS Code 系）：搜 **TraeCN Quota**，或见[市场页](https://marketplace.visualstudio.com/items?itemName=GhostCmdr.traecn-quota)。命令行一步到位：

```
code --install-extension GhostCmdr.traecn-quota
```

**下载 .vsix 手动装**（Trae 用户走这条）：Trae 扩展面板默认连的是它自建的市场源，未必搜得到本插件。到 [Releases](https://github.com/GhostCmdr/traecn-quota/releases/latest) 下载 `traecn-quota-<版本号>.vsix`，在 Trae 扩展面板右上角 `⋯` 里选 **从 VSIX 安装**（也可以直接把文件拖进面板）。GitHub 访问不便时用市场直链，存成 `.vsix` 即可：

```
https://marketplace.visualstudio.com/_apis/public/gallery/publishers/GhostCmdr/vsextensions/traecn-quota/latest/vspackage
```

## 功能

- 状态栏显示剩余积分与占比
- 悬停弹出积分卡片
- 额度按量级压缩：1 万以上显示 `w`（万）、1 亿以上显示「亿」，1 万以内保持千分位
- 点击状态栏立即刷新
- 支持定时自动刷新

## 使用前提

插件自动读取以下任一凭证（按优先级）：

1. 设置项 `traecnquota.manualToken`（登录 [trae.cn](https://www.trae.cn) → F12 → 应用 → 本地存储 → 复制 `Cloud-IDE-Token` 的值，填一次即被收进加密保管箱）
2. 已登录的 Trae CN / TRAE SOLO CN 桌面客户端（读 `%APPDATA%\<客户端>\User\globalStorage\storage.json` 里的加密登录态）

两者都拿不到时直接报「未找到登录态」，不会再退到 `~/.trae-cn/trae-jwt-token` 那类明文文件：那是 SOLO 运行时的身份 JWT，实测打积分接口一律 401，用它兜底只会把错误伪装成「认证失败」。

仅支持 Trae CN 国内版账号。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `traecnquota.refreshInterval` | `30` | 自动刷新间隔（分钟），`0` 关闭 |
| `traecnquota.detailRows` | `3` | 积分包显示数量，按到期时间升序，超出的不显示。可调 `2` ~ `5` |
| `traecnquota.edition` | `auto` | 读取哪个国内版客户端的登录态 |
| `traecnquota.manualToken` | 空 | 手动指定 accessToken，只是输入口：填一次即被收进加密保管箱并清空 |
| `traecnquota.hostOverride` | 空 | 覆盖 API 基地址（调试用）。只接受默认端口上的 `https://api.trae.cn`，其他值（含任意子域）忽略并回落 |

> 设置界面里各项按名称字母序排列，这是 VSCode 的固定行为，插件无法指定先后。

## 命令

| 命令 | 作用 |
|---|---|
| `TraeCN Quota: 刷新积分` | 立即取一次（等同于点状态栏图标或悬浮窗右上角 ↻） |
| `TraeCN Quota: 清除保管箱里的手动 Token` | 弃用手动 token、回到用客户端登录态。只把设置项删空**不会**清除保管箱里那份 |

## 隐私

- 凭证只从本机读取，只发给 `api.trae.cn`，不上传到任何其他地址
- 凭证不写进日志。输出面板只记录时间戳、积分/签到状态和失败原因
- 失败原因里会带一小段接口返回内容（已去 Markdown 格式并截断到 80 字符），整段截图外发前请先删掉那几行
- 配了 `traecnquota.manualToken` 时，插件会立刻把这串 token 存进 VSCode 的加密保管箱（`SecretStorage`，Windows 上按当前登录用户加密）并把设置项清空——全局和工作区（`.vscode/settings.json`）两层都会清，`settings.json` 里不留明文，也不会被 Settings Sync 同步走。设置项只是个输入口，填一次就够，之后显示为空属正常
- 想弃用手动 token：执行命令 **TraeCN Quota: 清除保管箱里的手动 Token**。只把设置项删空**不会**清除保管箱里那份——同 profile 的多个窗口会互相看到设置变更，靠「设置变空」推断删除会误删别的窗口刚存的凭证

## License

[MIT](LICENSE)
