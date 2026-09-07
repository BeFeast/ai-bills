"""Policy validation and secret-free control contract. Runtime bindings stay separate."""
from __future__ import annotations

import copy

PROTOCOLS = {"chat", "responses", "messages"}
ROLES = {"coding-quality", "coding-fast", "deep-reasoning", "general-cheap"}


def validate(policy: dict) -> list[str]:
    errors = []
    if not isinstance(policy, dict):
        return ["policy must be an object"]
    if policy.get("timezone") != "Asia/Jerusalem":
        errors.append("timezone must be Asia/Jerusalem")
    if policy.get("day_limit_microusd") != 2_000_000:
        errors.append("authorized day_limit_microusd is 2000000")
    groups = {}
    for key in ("models", "roles", "clients", "accounts"):
        values = policy.get(key)
        if not isinstance(values, list) or any(not isinstance(v, dict) for v in values):
            errors.append(f"{key} must be an array of objects")
            groups[key] = {}
            continue
        ids = [v.get("id") for v in values]
        if any(not isinstance(i, str) or not i or len(i) > 160 or any(ord(c) < 33 or ord(c) == 127 for c in i) for i in ids):
            errors.append(f"{key} needs nonempty string IDs")
        if len(set(str(i) for i in ids)) != len(ids):
            errors.append(f"duplicate {key} ID")
        groups[key] = {v["id"]: v for v in values if isinstance(v.get("id"), str)}
    for mid, model in groups["models"].items():
        if model.get("status") not in ("approved", "hidden", "denied"):
            errors.append(f"{mid}: invalid status")
        if not isinstance(model.get("capabilities"), list) or not set(model.get("capabilities", [])).issubset(PROTOCOLS):
            errors.append(f"{mid}: invalid capabilities")
        for key in ("input_limit_tokens", "output_limit_tokens"):
            if model.get("status") == "hidden" and model.get(key) is None:
                continue
            if type(model.get(key)) is not int or model[key] <= 0:
                errors.append(f"{mid}: positive {key} required")
        if "tool_call" in model and type(model["tool_call"]) is not bool:
            errors.append(f"{mid}: tool_call must be a verified boolean")
        prices = model.get("prices")
        if prices is not None and (not isinstance(prices, dict) or any(type(prices.get(k)) is not int or prices[k] < 0 for k in ("input", "output", "cache_read", "cache_write"))):
            errors.append(f"{mid}: prices need nonnegative integer microusd per million tokens")
        routes = model.get("routes")
        if not isinstance(routes, list) or (not routes and model.get("status") != "hidden"):
            errors.append(f"{mid}: routes required")
            continue
        for route in routes:
            if not isinstance(route, dict):
                errors.append(f"{mid}: route must be an object")
                continue
            if route.get("account_id") not in groups["accounts"]:
                errors.append(f"{mid}: unknown account")
            if route.get("billing") not in ("included", "paid") or not isinstance(route.get("upstream_model"), str) or not route.get("upstream_model"):
                errors.append(f"{mid}: invalid route")
            if "upstream_canonical_model" in route and (not isinstance(route["upstream_canonical_model"], str) or not route["upstream_canonical_model"]):
                errors.append(f"{mid}: canonical upstream model must be a nonempty string")
            if "allowed_clients" in route:
                scope = route["allowed_clients"]
                if not isinstance(scope, list) or any(not isinstance(cid, str) or cid not in groups["clients"] for cid in scope):
                    errors.append(f"{mid}: allowed_clients must reference policy client IDs")
            rp = route.get("prices")
            if rp is not None and (not isinstance(rp, dict) or any(type(rp.get(k)) is not int or rp[k] < 0 for k in ("input", "output", "cache_read", "cache_write"))):
                errors.append(f"{mid}: route prices must be complete nonnegative integers")
            if rp is not None and (not route.get("price_version") or not route.get("price_evidence")):
                errors.append(f"{mid}: route prices require price_version and price_evidence")
    for rid, role in groups["roles"].items():
        candidates = role.get("candidates")
        if rid not in ROLES:
            errors.append(f"unsupported role {rid}")
        if not isinstance(candidates, list) or not candidates or any(m not in groups["models"] for m in candidates):
            errors.append(f"{rid}: candidates must reference models")
    for cid, client in groups["clients"].items():
        for key in ("models", "roles"):
            values = client.get(key)
            if not isinstance(values, list) or any(v not in groups[key] for v in values):
                errors.append(f"{cid}: {key} must reference catalog IDs")
    for aid, account in groups["accounts"].items():
        if type(account.get("enabled")) is not bool:
            errors.append(f"{aid}: enabled boolean required")
    # Configuration pointers and credentials belong to the private runtime file.
    def forbidden(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.lower() in {"api_key", "token", "password", "secret", "auth_id", "native_auth_id", "base_url"}:
                    errors.append(f"runtime-only field {key}")
                forbidden(item)
        elif isinstance(value, list):
            for item in value:
                forbidden(item)
    forbidden(policy)
    return errors


def preview(old: dict, new: dict) -> dict:
    changes = {}
    for key in ("models", "roles", "clients", "accounts"):
        before = {v["id"]: v for v in old.get(key, [])}
        after = {v["id"]: v for v in new.get(key, [])}
        changes[key] = {"added": sorted(after.keys() - before.keys()), "removed": sorted(before.keys() - after.keys()), "changed": sorted(k for k in before.keys() & after.keys() if before[k] != after[k])}
    return changes


def empty_policy() -> dict:
    return {"version": 0, "timezone": "Asia/Jerusalem", "day_limit_microusd": 2_000_000,
            "models": [], "accounts": [], "clients": [], "roles": []}


def propose(policy: dict, suggestion: dict) -> dict:
    result = copy.deepcopy(policy)
    model = suggestion["model"]
    result["models"] = [m for m in result["models"] if m["id"] != model["id"]] + [model]
    return result
