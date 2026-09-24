// Zecori provider plugin for CodexBar (https://github.com/steipete/CodexBar).
//
// Reads GET /api/widget of the hosted Zecori instance with a read-only device
// token and shows it the way the Omarchy widget does: the tightest account-wide
// window as the headline, every account's windows (model-scoped ones such as
// "Fable weekly" last, with their observation age when carried over), today's
// api-equivalent spend and usage by client label.
//
// Install: copy this file to ~/.config/codexbar/providers/ (or Settings → Plugins
// → Install…), approve the origin, paste the device token into "Device token".
defineProvider({
  id: "zecori",
  name: "Zecori",
  icon: { monogram: "Z", tint: "#BC873C" },
  topLevel: true,
  endpoints: ["https://zecori.befeast.com"],
  auth: { type: "bearer", secret: "DEVICE_TOKEN" },
  capabilities: ["http-status"],
  settings: [
    { key: "DEVICE_TOKEN", title: "Device token", subtitle: "A zd_… token issued for this Mac by a tenant admin.", type: "secure" },
  ],
  async fetchUsage(ctx) {
    if (!ctx.settings.getSecret("DEVICE_TOKEN")) throw ctx.fail.missingCredential("Paste the device token for this Mac.");
    const response = await ctx.http.getJSON("https://zecori.befeast.com/api/widget", { timeoutSeconds: 30, retryPolicy: "transientIdempotent" });
    if (response.status === 401) throw ctx.fail.authenticationExpired("The device token was not accepted; issue a new one");
    if (response.status === 403) throw ctx.fail.permissionDenied("This token may not read the widget; issue a device token, not an ingest token");
    if (response.status === 429) throw ctx.fail.rateLimited("Zecori is rate limiting this device", { retryAfterSeconds: 10 });
    if (response.status >= 500) throw ctx.fail.providerUnavailable("Zecori answered HTTP " + response.status);
    if (response.status !== 200) throw ctx.fail.apiFailure("Zecori answered HTTP " + response.status);
    const data = response.json;
    if (!data || typeof data !== "object" || !Array.isArray(data.accounts)) throw ctx.fail.parseFailure("Unexpected answer from /api/widget");

    const now = ctx.date.nowMillis();
    const finite = (v) => typeof v === "number" && isFinite(v);
    const headlineOf = (a) => (a && (a.headline || a.limiting)) || null;
    const duration = (ms) => {
      if (!(ms > 0)) return "now";
      const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
      if (d > 0) return d + "d " + (h % 24) + "h";
      if (h > 0) return h + "h " + (m % 60) + "m";
      return Math.max(1, m) + "m";
    };
    const tokens = (n) => {
      n = Number(n) || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return Math.round(n / 1e3) + "k";
      return String(n);
    };
    const money = (v) => (!finite(v) ? "—" : v > 0 && v < 0.01 ? "<$0.01" : "$" + v.toFixed(2));
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "w";

    // The bar leads with the account whose account-wide headline has the least left.
    let worst = null;
    for (const a of data.accounts) {
      const h = headlineOf(a);
      if (!h || !finite(h.remainingPercent)) continue;
      if (!worst || h.remainingPercent < headlineOf(worst).remainingPercent) worst = a;
    }

    const snapshot = { dataConfidence: "exact", identity: { organization: "Zecori", loginMethod: "Device token" } };
    if (worst) {
      const h = headlineOf(worst);
      snapshot.primary = { usedPercent: Math.max(0, Math.min(100, 100 - h.remainingPercent)), resetsAt: h.resetsAt || null,
        resetDescription: worst.label + " · " + h.label };
    }

    // Every account's windows: account-wide first (server order), model-scoped last.
    const extra = [];
    const seen = {};
    for (const a of data.accounts) {
      const windows = Array.isArray(a.windows) ? a.windows : [];
      for (const w of windows) {
        let id = slug(a.key + "-" + w.label);
        while (seen[id]) id += "-x";
        seen[id] = true;
        let title = a.label + " · " + w.label;
        if (w.observedAt) {
          const at = Date.parse(w.observedAt);
          if (isFinite(at)) title += " (as of " + duration(now - at) + " ago)";
        }
        const known = finite(w.remainingPercent);
        extra.push({ id, title: title.slice(0, 120), usageKnown: known,
          usedPercent: known ? Math.max(0, Math.min(100, 100 - w.remainingPercent)) : 0, resetsAt: w.resetsAt || null });
      }
    }
    if (extra.length) snapshot.extraWindows = extra.slice(0, 32);

    const details = [];
    const trouble = [];
    if (data.snapshot && data.snapshot.stale) {
      trouble.push({ label: "Snapshot", value: data.snapshot.reason === "no-snapshot" ? "none yet" : "stale",
        secondaryValue: finite(data.snapshot.ageSeconds) ? duration(data.snapshot.ageSeconds * 1000) + " old" : null });
    }
    for (const a of data.accounts) {
      if (a.state === "fresh") continue;
      trouble.push({ label: String(a.label).slice(0, 120), value: a.state === "pending" ? "waiting" : String(a.state),
        secondaryValue: a.message ? String(a.message).slice(0, 120) : null });
    }
    if (trouble.length) details.push({ title: "Attention", rows: trouble.slice(0, 24) });

    const clients = data.today && Array.isArray(data.today.byClient) ? data.today.byClient : [];
    if (clients.length) {
      const peak = Math.max(1, ...clients.map((c) => Number(c.tokens) || 0));
      let total = 0;
      const rows = clients.slice(0, 24).map((c) => {
        const usd = finite(c.pricedApiEquivalentUsd) ? c.pricedApiEquivalentUsd : c.apiEquivalentUsd;
        if (finite(usd)) total += usd;
        return { label: String(c.name).slice(0, 120), value: money(usd), secondaryValue: tokens(c.tokens) + " tok · " + (Number(c.requests) || 0) + " req",
          progress: Math.min(1, (Number(c.tokens) || 0) / peak) };
      });
      details.push({ title: "Today by client", rows });
      snapshot.cost = { used: Math.round(total * 100) / 100, currency: "USD", period: "Today, api-equivalent" };
    }
    if (details.length) snapshot.details = details;
    if (!snapshot.primary && !snapshot.extraWindows && !snapshot.cost && !snapshot.details) return { empty: true, identity: snapshot.identity };
    return snapshot;
  },
});
