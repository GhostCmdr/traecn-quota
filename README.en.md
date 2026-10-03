# TraeCN Quota

[English](README.en.md) | [简体中文](README.md)

Show your Trae CN credit balance and plan details live in the status bar.

![Quota card preview](resources/screenshot.png)

## Installation

Search for **TraeCN Quota** in your editor's marketplace.

You can also install manually from the `.vsix` in [Releases](https://github.com/GhostCmdr/traecn-quota/releases/latest).

## Features

- Status bar shows remaining credits and percentage; click to refresh now
- Hover card: progress bar, percentage, plan breakdown sorted by expiry, today's check-in status
- Scheduled auto-refresh
- Daily check-in runs automatically; click the status bar item to claim it manually

## Requirements

Only Trae CN (mainland China) accounts are supported. Provide credentials one of two ways:

1. A signed-in Trae CN / TRAE SOLO CN desktop client — read automatically
2. Setting `traecnquota.manualToken` (takes priority over the client login state): sign in at [trae.cn](https://www.trae.cn) → F12 → Local Storage → copy the value of `Cloud-IDE-Token`

If neither is available, the status bar shows "no login session found".

## Settings

| Setting | Default | Description |
|---|---|---|
| `traecnquota.refreshInterval` | `30` | Auto-refresh interval in minutes, `0` disables |
| `traecnquota.detailRows` | `3` | Number of credit packs shown, range `2`–`5` |
| `traecnquota.autoCheckin` | `true` | Claim the daily check-in automatically, once a day |
| `traecnquota.edition` | `auto` | Which mainland client's login session to read |
| `traecnquota.manualToken` | empty | Manual access token; entered once, then moved to the secret store and cleared |
| `traecnquota.hostOverride` | empty | Debug only; accepts only `https://api.trae.cn` on the default port |

## Commands

| Command | Effect |
|---|---|
| `TraeCN Quota: 刷新积分` | Fetch once immediately |
| `TraeCN Quota: 立即签到` | Manually claim today's check-in |
| `TraeCN Quota: 清除保管箱里的手动 Token` | Discard the manual token, fall back to the client session |

## Privacy

- Credentials are read only from your machine and sent only to `api.trae.cn`; nothing is logged
- The manual token is stored in the editor's own encrypted secret store (on Windows, encrypted per current user); no plaintext remains in `settings.json`, and it is not synced by Settings Sync
- Failure messages include a short (truncated) snippet of the API response — remove those lines before sharing a screenshot

## License

[MIT](LICENSE)
