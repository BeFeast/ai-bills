# Isolated OpenCode provider for T3 Code

The managed OpenCode instance uses its own wrapper/config and environment. Existing
OpenCode settings and T3 provider instances remain intact. T3's provider-level
model discovery imports every model of each connected OpenCode provider, so the
managed config restricts both `enabled_providers` and that provider's `whitelist`.
The gateway separately enforces the same client subset at request admission.

Generate the config from an authenticated managed client's `/v1/models` response:

```sh
node integrations/opencode/build-config.mjs \
  /private/client-catalog.json https://routing.example.invalid/v1 \
  /installed/integrations/opencode/ai-bills-plugin.mjs \
  /private/opencode-managed.json
```

Model metadata may include `tool_call`, `attachment`, `reasoning`, `modalities` and
`limit: {context, output}`. Capabilities default to false when unverified; context
and output default conservatively to 32768/4096. Supply verified tool capability
metadata for coding roles before acceptance. There are no fixed account/model
inventories in this integration and no provider credential in generated JSON.

Set a new T3 OpenCode provider instance's binary path to the installed
`opencode-managed` wrapper and supply these instance environment values:

- `AI_BILLS_OPENCODE_CONFIG`: generated private config path.
- `AI_BILLS_OPENCODE_BIN`: existing real OpenCode executable.
- `AI_BILLS_CLIENT_KEY`: the managed client's gateway key, supplied privately.
- `AI_BILLS_ROUTING_CLIENT_URL`: the same gateway API base ending in `/v1`, for
  T3's scoped routing receipts. `AI_BILLS_ROUTING_PROVIDER_ID` defaults to `ai-bills`.

The wrapper sets `OPENCODE_CONFIG` only for that child process. An existing external
OpenCode server must use this same isolated configuration, or T3 must spawn a new
server for the managed instance. Merely adding custom models in T3 is insufficient:
those are additive and do not replace the discovered global inventory.

The plugin adds headers only to its configured provider: stable `X-Session-ID`,
`X-Client-Turn-ID` from the user message, and a distinct `X-Request-ID` per model
call. Tool loops can make several calls for one user message. SDK retries of one
call reuse its headers. The gateway must reject/deduplicate repeated logical calls
and keep account/model pinning and per-attempt budget liability itself.

## Fallback visibility

Source inspection confirms T3 sends stable OpenCode session/message IDs and the
installed OpenCode plugin API supports `chat.headers`. Fixture tests establish
header scoping and config subset behavior. These do not establish live end-to-end
transport until a managed T3 request is observed at the gateway.

OpenCode's plugin API has no response-header hook, and T3 ignores TUI toast events.
The matching T3 adapter extension reads `/v1/routing/events` using the managed
client key and emits `runtime.warning` in the thread work log. Receipt reads are
scoped to the authenticated client and OpenCode session; notices additionally
match the exact user message. An unavailable receipt source produces a warning.
Install that T3 extension before acceptance; older T3 builds cannot display these
notices. No assistant text, tool output or session-title changes are injected.
