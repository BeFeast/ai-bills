# Zecori for the Omarchy bar

One bar icon and one panel for the limits your Zecori instance already knows:
every account's remaining allowance and reset time, and today's usage per
client label (the machines and tools behind your proxy keys). The bar shows the
Zecori mark with the tightest remaining percentage; the panel lists the rest.

The widget is a display only. It polls `GET /api/widget` of your instance with
a **device token** — a read-only credential that can do nothing else: it cannot
ingest snapshots, change subscriptions or open account browsers. The same
functions that draw "Limits now" on the Overview produce the numbers here, so
the two always agree.

## Install

Requirements: Omarchy 4 (`omarchy-shell`), `curl`, `jq`.

1. Issue a device token as a signed-in admin of your tenant:

   ```sh
   curl -X POST "$ZECORI/api/device-tokens" -H 'content-type: application/json' \
     -H "cookie: <your session>" -d '{"label":"laptop"}'
   ```

   The answer carries the token once; the instance keeps only its digest.
   Revoke with `DELETE /api/device-tokens/<id>`, list with `GET /api/device-tokens`.

2. Put the token on the machine, readable by you alone:

   ```sh
   install -d -m 0700 ~/.config/zecori
   printf '%s\n' 'zd_…' > ~/.config/zecori/token && chmod 0600 ~/.config/zecori/token
   ```

3. Install the plugin from this directory and place it in the bar:

   ```sh
   ./install.sh --section right --after omarchy.agents
   ```

   `install.sh` copies the files to `~/.config/omarchy/plugins/befeast.zecori/`,
   rescans plugins and enables the widget. Any `omarchy plugin enable` placement
   flag (`--section`, `--before`, `--after`, `--index`) is passed through.

If all your agents go through the pool and the stock `omarchy.agents` tabs only
report "Waiting for auth", hide them; the agents widget leaves the bar on its own
when no provider is enabled:

```sh
omarchy bar set omarchy.agents providers '{"claude":{"enabled":false},"codex":{"enabled":false}}' --json
```

## Settings

Set with `omarchy bar set befeast.zecori <key> <value> [--json]`:

| Key | Default | What it does |
|---|---|---|
| `baseUrl` | `https://zecori.befeast.com` | The instance that holds your tenant |
| `tokenPath` | `~/.config/zecori/token` | File with the device token (must be mode `0600`) |
| `refreshIntervalSec` | `300` | How often the widget polls (`--json` for numbers) |

## Panel

- **Hero** — the mark, snapshot time of the collector, when the widget last read.
  A banner appears when the instance is unreachable, the token is refused, or
  the snapshot is older than fifteen minutes.
- **Limits now** — one block per account: the limiting window with a meter that
  drains as the allowance is used, its reset countdown, and the other windows in
  one line. Below 25 % left the value is bold, below 10 % (or exhausted) it turns
  urgent, and so does the bar icon.
- **Today by client** — one row per client label of today's ledger with the
  api-equivalent cost, tokens and requests; the bar behind each row is scaled to
  the heaviest client.

## Interactions

- Bar: left = panel, middle = refresh now.
- Panel: `r` or Enter refresh, `j`/`k` scroll, Tab moves to the neighbouring
  bar panel, Esc closes.
- IPC: `omarchy-shell befeast.zecori <open|close|toggle|refresh>`.

## Files

- `Panel.qml` — the bar button and the panel.
- `zecori-fetch` — reads the token file, calls `/api/widget`, prints one JSON
  document; every failure is `{"error": …, "status": …}` so the panel can show it.
  The token is handed to curl through its config on stdin, never as an argument.
- `assets/zecori-mark.png` — the round Zecori mark from the brand kit.
