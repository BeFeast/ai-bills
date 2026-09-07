"""Pure route decisions and conservative paid-request bounds."""
from __future__ import annotations

import copy
import datetime as dt
import json

from store import Rejected, utcnow

PATHS = {"/v1/chat/completions": "chat", "/v1/responses": "responses", "/v1/messages": "messages"}


def catalog(policy, client_id):
    client = next((c for c in policy["clients"] if c["id"] == client_id), None)
    if client is None:
        raise Rejected("client is not enrolled", 403)
    approved = {m["id"] for m in policy["models"] if m["status"] == "approved"}
    roles = {r["id"] for r in policy["roles"] if any(m in approved and m in client["models"] for m in r["candidates"])}
    ids = [r for r in client["roles"] if r in roles] + [m for m in client["models"] if m in approved]
    models = {m["id"]: m for m in policy["models"]}
    role_map = {r["id"]: r for r in policy["roles"]}
    entries = []
    for mid in ids:
        members = [models[m] for m in role_map[mid]["candidates"] if m in approved and m in client["models"]] if mid in role_map else [models[mid]]
        entries.append({"id": mid, "object": "model", "owned_by": "ai-bills", "created": 0,
                        "tool_call": all(m.get("tool_call") is True for m in members),
                        "context_length": min(m["input_limit_tokens"] for m in members),
                        "max_output_tokens": min(m["output_limit_tokens"] for m in members)})
    return {"object": "list", "data": entries}


def _quota_order(binding, now):
    quota = binding.get("quota") or {}
    try:
        observed = dt.datetime.fromisoformat(quota["observed_at"])
        reset = dt.datetime.fromisoformat(quota["reset_at"])
        fresh = 0 <= (now - observed).total_seconds() <= quota.get("max_age_seconds", 300)
        remaining = float(quota["remaining_fraction"])
        if not fresh or not 0 <= remaining <= 1:
            return (1, 0, 0)
        if remaining == 0 and reset > now:
            return (3, 0, 0)
        if reset <= now:
            return (1, 0, 0)  # A passed reset is not proof of renewed capacity.
        # More usable quota per time until expiry is consumed first.
        pressure = remaining / max(1, (reset - now).total_seconds())
        return (0, -pressure, -remaining)
    except (KeyError, ValueError, TypeError):
        return (1, 0, 0)


def candidates(policy, runtime, client_id, selected, protocol, previous=None, now=None, body=None):
    now = now or utcnow()
    client = next((c for c in policy["clients"] if c["id"] == client_id), None)
    if client is None:
        raise Rejected("client is not enrolled", 403)
    roles = {r["id"]: r for r in policy["roles"]}
    is_role = selected in roles
    if selected not in client["roles" if is_role else "models"]:
        raise Rejected("selection is outside client subset", 403)
    mids = list(roles[selected]["candidates"]) if is_role else [selected]
    if previous and previous.get("model") in mids:
        mids.remove(previous["model"])
        mids.insert(0, previous["model"])
    models = {m["id"]: m for m in policy["models"]}
    enabled = {a["id"] for a in policy["accounts"] if a["enabled"]}
    routes = []
    for position, mid in enumerate(mids):
        model = models[mid]
        if mid not in client["models"] or protocol not in model["capabilities"]:
            continue
        if model["status"] == "denied":
            continue
        if model["status"] == "hidden" and (not previous or previous.get("model") != mid):
            continue
        for route in model["routes"]:
            aid = route["account_id"]
            binding = runtime.get("accounts", {}).get(aid)
            if aid not in enabled or not binding or not binding.get("auth_id") or binding.get("native_supported") is False:
                continue
            quota = _quota_order(binding, now)
            if quota[0] == 3:
                continue
            if route["billing"] == "paid" and binding.get("quota_mode") != "metered" and quota[0] == 1:
                continue
            affinity = 0 if previous and previous.get("model") == mid and previous.get("account") == aid else 1
            paid = route["billing"] == "paid"
            # Preserve the bound model even if another candidate has a free route.
            # Once its routes fail, remaining candidates still prefer included quota.
            sticky = 0 if previous and previous.get("model") == mid else 1
            price_order = 0
            if selected == "general-cheap" and paid:
                try:
                    price_order = prepare(body or {}, protocol, model, route, binding)[1]
                except Rejected:
                    price_order = float("inf")
            routes.append((sticky, paid, price_order, position, affinity, quota, model, route, binding))
    routes.sort(key=lambda r: r[:6])
    if not routes:
        raise Rejected("no approved compatible account route", 503)
    return [(m, r, b) for _, _, _, _, _, _, m, r, b in routes], selected if is_role else None


def _has_external_content(body):
    """Unknown attachment/service costs cannot consume a strict paid budget."""
    if isinstance(body, dict):
        if body.get("type") in {"image_url", "input_image", "input_audio", "audio", "image", "document", "file", "input_file", "computer", "web_search", "web_search_preview", "file_search", "code_interpreter"}:
            return True
        if "source" in body and isinstance(body["source"], dict):
            return True
        return any(_has_external_content(v) for v in body.values())
    if isinstance(body, list):
        return any(_has_external_content(v) for v in body)
    return False


def prepare(body, protocol, model, route, binding):
    result = copy.deepcopy(body)
    result["model"] = route["upstream_model"]
    paid = route["billing"] == "paid"
    if paid:
        if route.get("prices") is None or not route.get("price_version") or not route.get("price_evidence"):
            raise Rejected("paid route has unknown prices", 402)
        if any(result.get(k) for k in ("previous_response_id", "conversation", "background", "audio", "prediction")) or _has_external_content(result):
            raise Rejected("paid request includes unbounded context or unpriced features", 402)
        if result.get("service_tier", "default") not in (None, "auto", "default"):
            raise Rejected("paid service tier is not priced", 402)
        # 'auto' can opt into provider-managed paid tiers; force the priced baseline.
        if "service_tier" in result:
            result["service_tier"] = "default"
        for tool in result.get("tools", []):
            if tool.get("type", "function") not in ("function", "custom"):
                raise Rejected("hosted tool price is unknown", 402)
    key = {"chat": "max_completion_tokens", "responses": "max_output_tokens", "messages": "max_tokens"}[protocol]
    requested = result.get(key, result.get("max_tokens", model["output_limit_tokens"]))
    if type(requested) is not int or requested < 1:
        raise Rejected("positive integer output token bound required")
    output = min(requested, model["output_limit_tokens"])
    result[key] = output
    if protocol == "chat":
        result.pop("max_tokens", None)
        if result.get("stream"):
            result["stream_options"] = {**result.get("stream_options", {}), "include_usage": True}
    n = result.get("n", 1)
    if type(n) is not int or n != 1 or result.get("best_of", 1) != 1:
        raise Rejected("only one output is supported")
    # This must be the verified upstream maximum context, not an arbitrary
    # smaller application limit. Provider rejection enforces this outer bound.
    input_bound = model["input_limit_tokens"]
    if paid:
        canonical = route.get("upstream_canonical_model", route["upstream_model"])
        proof = binding.get("verified_input_limits", {}).get(canonical, {})
        if type(proof.get("tokens")) is not int or proof["tokens"] <= 0 or not proof.get("evidence"):
            raise Rejected("paid route lacks verified upstream context bound", 402)
        input_bound = max(input_bound, proof["tokens"])
    # A client-body byte bound is insufficient: native translators and payload
    # rules can add content. Tight bounds require a final upstream-body verifier.
    reserve = 0
    if paid:
        price = route["prices"]
        rate = max(price["input"], price["cache_read"], price["cache_write"])
        reserve = (input_bound * rate + output * price["output"] + 999_999) // 1_000_000
    return result, reserve


def usage_from_payload(body, protocol):
    if not isinstance(body, dict):
        return None
    source = body.get("response", body)
    usage = source.get("usage") if isinstance(source, dict) else None
    if not isinstance(usage, dict):
        return None
    if protocol == "messages":
        if "input_tokens" not in usage or "output_tokens" not in usage:
            return None
        values = {"input": usage["input_tokens"], "output": usage["output_tokens"],
                  "cache_read": usage.get("cache_read_input_tokens", 0), "cache_write": usage.get("cache_creation_input_tokens", 0)}
    else:
        ik, ok = ("prompt_tokens", "completion_tokens") if protocol == "chat" else ("input_tokens", "output_tokens")
        if ik not in usage or ok not in usage:
            return None
        cached = (usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}).get("cached_tokens", 0)
        values = {"input": usage[ik] - cached, "output": usage[ok], "cache_read": cached, "cache_write": 0}
    if any(type(v) is not int or v < 0 for v in values.values()):
        return None
    return values


def cost_for(usage, pricing):
    if usage is None or pricing.get("prices") is None:
        return None
    return (sum(usage[key] * pricing["prices"][key] for key in usage) + 999_999) // 1_000_000


class StreamUsage:
    """Parse SSE incrementally while forwarding the original bytes unchanged."""
    def __init__(self, protocol):
        self.protocol, self.buffer, self.usage = protocol, b"", None
        self.complete, self.failed = False, False
        self.anthropic = {}

    def feed(self, chunk):
        self.buffer += chunk
        if len(self.buffer) > 4_000_000:
            self.failed = True
            self.buffer = b""
            return
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if not line.startswith(b"data:"):
                continue
            value = line[5:].strip()
            if value == b"[DONE]":
                self.complete = True
                continue
            try:
                event = json.loads(value)
            except (ValueError, UnicodeError):
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if event.get("error") or kind in ("error", "response.failed", "response.incomplete"):
                self.failed = True
            if kind in ("response.completed", "message_stop"):
                self.complete = True
            if self.protocol == "messages":
                if kind == "message_start":
                    self.anthropic.update(event.get("message", {}).get("usage", {}))
                if kind == "message_delta":
                    self.anthropic.update(event.get("usage", {}))
                self.usage = usage_from_payload({"usage": self.anthropic}, self.protocol)
            else:
                self.usage = usage_from_payload(event, self.protocol) or self.usage
