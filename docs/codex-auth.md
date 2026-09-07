# Codex connection ownership

Accounts configured with `quota_snapshot_key` use CLIProxyAPI-owned credentials.
The usage response exposes `authOwner: "cliproxy"` and an optional navigation URL,
without private credential paths or quota source identifiers. Both healthy and
unavailable Codex cards direct reconnection to native CLIProxyAPI management.
Local device authorization rejects these accounts with HTTP 409 before spawning
any login process. Local Codex accounts retain the existing device flow.

Configure the native management navigation destination in private TOML:

```toml
[server]
codex_proxy_management_url = "https://proxy.example.invalid/management.html"
```

Use an HTTP(S) URL without embedded credentials or query parameters. A missing
URL leaves an explicit native-owner explanation; it never enables local login.
In native management, choose Codex OAuth and sign in to the same provider account.
The native service owns token refresh and storage throughout. Opening a provider's
billing page does not reconnect proxy credentials.
