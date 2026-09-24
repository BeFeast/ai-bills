# Zecori for CodexBar

A [CodexBar](https://github.com/steipete/CodexBar) provider plugin that shows your Zecori
limits in the macOS menu bar (and in the CodexBar CLI on macOS and Linux). It reads
`GET /api/widget` with a read-only device token, the same answer the Omarchy widget draws.

What it shows, in CodexBar's generic provider card:

- **Primary window**: the account whose account-wide headline window has the least left
  (the same choice as the Omarchy bar percentage), labelled `account · window`.
- **Extra windows**: every window of every account, account-wide first. A model-scoped
  window carried over from an earlier observation (Claude's per-model weekly) says how old it is.
- **Cost**: today's api-equivalent total; **Today by client**: one row per client label.
- **Attention**: a stale snapshot or accounts whose quota source is failing or pending.

## Install

1. Install CodexBar 0.65+ (macOS 14+).
2. Copy `zecori.js` to `~/.config/codexbar/providers/`, or use **Settings → Plugins → Install…**.
3. Approve the plugin (origin `https://zecori.befeast.com`, bearer auth, secret `DEVICE_TOKEN`).
4. Paste a device token for this machine into **Device token** and enable the plugin.

Device tokens are issued by a tenant admin with `POST /api/device-tokens` (see `DEPLOYMENT.md`);
they can read `/api/widget` and nothing else.

CLI check (the secret can come from the environment instead of the config file):

```sh
CODEXBAR_PLUGIN_ZECORI_DEVICE_TOKEN=zd_… codexbar plugins fetch zecori --json --pretty
```

The first `fetch` asks for approval in an interactive terminal.
