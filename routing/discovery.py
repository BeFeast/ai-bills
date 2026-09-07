"""Scheduled metadata-only discovery. New models remain hidden review proposals."""
from __future__ import annotations

import copy
import datetime as dt
import json
import os

import httpx


class Discovery:
    def __init__(self, app):
        self.app = app

    def read(self, source):
        if source["kind"] == "opencode-cache":
            with open(source["path"], "rb") as file:
                raw = file.read(16_000_001)
            if len(raw) > 16_000_000:
                raise ValueError("catalog too large")
            data = json.loads(raw)
            provider = data.get(source["provider_id"], {})
            return [{"id": key, "label": item.get("name", key), "input_limit_tokens": item.get("limit", {}).get("context"),
                     "output_limit_tokens": item.get("limit", {}).get("output")}
                    for key, item in provider.get("models", {}).items() if isinstance(item, dict)]
        if source["kind"] != "openai-models":
            raise ValueError("unsupported catalog source")
        headers = {}
        if source.get("api_key_env"):
            token = os.environ.get(source["api_key_env"])
            if not token:
                raise ValueError("catalog credential unset")
            headers["Authorization"] = "Bearer " + token
        with self.app.http.stream("GET", source["url"], headers=headers, timeout=20) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > 16_000_000:
                    raise ValueError("catalog too large")
        payload = json.loads(data)
        return [{"id": item["id"], "label": item.get("name", item["id"]),
                 "input_limit_tokens": item.get("context_length"), "output_limit_tokens": item.get("max_output_tokens")}
                for item in payload.get("data", []) if isinstance(item, dict) and isinstance(item.get("id"), str)]

    def tick(self, force=False):
        store = self.app.store
        now = store.clock()
        for source in self.app.config.get("catalog_sources", []):
            sid = source["id"]
            previous = store.discovery_state(sid)
            if previous and not force:
                interval = 3600 if previous["error"] else max(3600, source.get("interval_seconds", 7 * 86400))
                if (now - dt.datetime.fromisoformat(previous["checked_at"])).total_seconds() < interval:
                    continue
            try:
                models = self.read(source)
                if len(models) > 5000:
                    raise ValueError("catalog too large")
                policy = store.policy()
                known = {m["id"]: m for m in policy["models"]}
                account = source.get("account_id")
                for item in models:
                    upstream = item["id"]
                    if not upstream or len(upstream) > 160:
                        continue
                    mid = source.get("model_prefix", sid + "/") + upstream
                    exists = mid in known or any(any(r["upstream_model"] == upstream and (not account or r["account_id"] == account) for r in m["routes"]) for m in known.values())
                    if exists or store.has_suggestion(sid, mid, "new_model"):
                        continue
                    candidate = {"id": mid, "label": item["label"], "status": "hidden", "capabilities": [],
                                 "input_limit_tokens": item.get("input_limit_tokens"), "output_limit_tokens": item.get("output_limit_tokens"),
                                 "prices": None, "routes": []}
                    store.add_suggestion(candidate, "New catalog entry. Protocol, account access, price, and task suitability need review before approval.", sid, "new_model")
                current = {m["id"] for m in models}
                if previous and previous["catalog"]:
                    prior = {m["id"] for m in json.loads(previous["catalog"])}
                    removed = prior - current
                    for model in known.values():
                        affected = any(r["upstream_model"] in removed and (not account or r["account_id"] == account) for r in model["routes"])
                        if affected and not store.has_suggestion(sid, model["id"], "missing_from_catalog"):
                            proposed = copy.deepcopy(model)
                            proposed["status"] = "hidden"
                            store.add_suggestion(proposed, "Model disappeared from this catalog. This alone does not prove it is unavailable; review before hiding or replacing.", sid, "missing_from_catalog")
                store.record_discovery(sid, models=models)
            except (OSError, ValueError, KeyError, TypeError, httpx.HTTPError):
                # Do not persist exception URLs or response bodies containing credentials.
                store.record_discovery(sid, error="metadata catalog refresh failed")
