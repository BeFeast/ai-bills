"""Standalone HTTP policy service. Run with uv run python server.py --config FILE."""
from __future__ import annotations

import argparse
import copy
import hmac
import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import httpx

from engine import PATHS, StreamUsage, candidates, catalog, cost_for, prepare, usage_from_payload
from policy import preview, validate
from store import Rejected, Store


def secret(name):
    value = os.environ.get(name or "", "")
    if not value:
        raise RuntimeError("required credential environment variable is unset")
    return value


class Application:
    def __init__(self, config, store=None, transport=None):
        self.config = config
        self.store = store or Store(config["database"])
        self.http = httpx.Client(timeout=httpx.Timeout(connect=15, read=None, write=30, pool=15),
                                 follow_redirects=False, transport=transport)
        self.native_ready = False
        self.capability_lock = threading.Lock()
        self.native_providers = {}

    def native_headers(self):
        native = self.config["native"]
        return {"Authorization": "Bearer " + secret(native["api_key_env"]),
                "X-AI-Bills-Token": secret(native["managed_token_env"])}

    def capabilities(self, refresh=False):
        with self.capability_lock:
            if not self.native_ready or refresh:
                try:
                    response = self.http.get(self.config["native"]["base_url"].rstrip("/") + "/v0/management/ai-bills-capabilities", headers=self.native_headers(), timeout=10)
                    data = response.json() if response.status_code == 200 else {}
                    if not isinstance(data, dict):
                        data = {}
                    self.native_ready = data.get("version") == 1 and all(data.get(k) is True for k in ("exact_account", "single_attempt", "usage_receipts"))
                    self.native_providers = data.get("providers", {})
                except (httpx.HTTPError, ValueError, RuntimeError):
                    self.native_ready = False
            return {"native_managed_attempt": self.native_ready, "paid_budget_enforced": self.native_ready,
                    "timezone": "Asia/Jerusalem", "price_units": "integer micro-USD per million tokens"}

    def routing_runtime(self):
        runtime = copy.deepcopy(self.config)
        snapshot = None
        if path := runtime.get("quota_snapshot_path"):
            try:
                with open(path, "rb") as file:
                    raw = file.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise ValueError("quota snapshot too large")
                parsed = json.loads(raw)
                field = runtime.get("quota_projection_field")
                snapshot = parsed.get(field, {}) if field else parsed.get("account_quotas", parsed.get("accounts", {}))
                if not isinstance(snapshot, dict):
                    snapshot = {}
            except (OSError, ValueError, AttributeError):
                snapshot = {}
        for aid, binding in runtime.get("accounts", {}).items():
            if snapshot is not None:
                binding["quota"] = snapshot.get(binding.get("quota_source_key", aid)) or {}
            provider = binding.get("provider")
            if provider in self.native_providers:
                binding["native_supported"] = self.native_providers[provider]
        return runtime

    def account_health(self):
        from engine import _quota_order
        runtime = self.routing_runtime()
        values = []
        for account in self.store.policy()["accounts"]:
            aid = account["id"]
            binding = runtime.get("accounts", {}).get(aid, {})
            support = binding.get("native_supported")
            q = _quota_order(binding, self.store.clock())[0]
            quota = binding.get("quota") or {}
            values.append({"id": aid, "native_support": "supported" if support is True else "unsupported" if support is False else "unverified",
                           "quota_state": "metered" if binding.get("quota_mode") == "metered" else "exhausted" if q == 3 else "known" if q == 0 else "unknown",
                           "quota": {k: quota[k] for k in ("remaining_fraction", "reset_at", "observed_at", "max_age_seconds") if k in quota},
                           "bound": bool(binding.get("auth_id"))})
        return values

    def receipt_usage(self, attempt):
        binding = self.config.get("accounts", {}).get(attempt["account_id"], {})
        if not binding.get("auth_id"):
            return None
        try:
            response = self.http.get(self.config["native"]["base_url"].rstrip("/") + "/v0/management/ai-bills-receipts/" + attempt["id"],
                                     headers=self.native_headers(), timeout=10)
            data = response.json() if response.status_code == 200 else {}
        except (httpx.HTTPError, ValueError, RuntimeError):
            return None
        if not isinstance(data, dict):
            return None
        if data.get("attempt_id") != attempt["id"] or data.get("auth_id") != binding["auth_id"]:
            return None
        if not data.get("terminal") or not data.get("usage_complete") or data.get("failed"):
            return None
        if not attempt.get("upstream_model") or data.get("model") != attempt["upstream_model"]:
            return None
        raw = data.get("usage") or {}
        if not isinstance(raw, dict):
            return None
        # The native receipt is normalized from token_breakdown v2: uncached input,
        # both separate cache buckets, and total output including reasoning once.
        keys = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_tokens", "cache_write": "cache_write_tokens"}
        usage = {key: raw.get(native_key) for key, native_key in keys.items()}
        if any(type(value) is not int or value < 0 for value in usage.values()):
            return None
        return usage

    def finalize(self, attempt, route, usage, *, complete, successful, error=None):
        if route["billing"] == "paid":
            authoritative = self.receipt_usage(attempt)
            if authoritative is None:
                self.store.finish(attempt["id"], usage=usage, error=error or "native usage receipt pending", complete=False, successful=successful)
                return
            usage = authoritative
            complete = True
        self.store.finish(attempt["id"], cost=cost_for(usage, route), usage=usage,
                          complete=complete, successful=successful, error=error)

    def reconcile(self):
        self.store.reconcile_budget()
        for attempt in self.store.unresolved():
            usage = self.receipt_usage(attempt)
            if usage is None:
                continue
            self.store.finish(attempt["id"], cost=cost_for(usage, {"prices": attempt["prices"]}), usage=usage,
                              complete=True, successful=True)
            self.store.release_session(attempt["client_id"], attempt["session_id"], attempt["request_id"])

    def identify(self, headers):
        value = headers.get("Authorization", "")
        token = value[7:] if value.startswith("Bearer ") else headers.get("x-api-key", "")
        for cid, binding in self.config.get("clients", {}).items():
            expected = os.environ.get(binding.get("api_key_env", ""), "")
            if expected and token and hmac.compare_digest(token, expected):
                return cid
        raise Rejected("invalid client credential", 401)

    def control_auth(self, headers):
        expected = secret(self.config["control_token_env"])
        if not hmac.compare_digest(headers.get("Authorization", ""), "Bearer " + expected):
            raise Rejected("invalid control credential", 401)

    def policy_errors(self, policy):
        errors = validate(policy)
        if errors:
            return errors
        for account in policy["accounts"]:
            if account["enabled"] and not self.config.get("accounts", {}).get(account["id"], {}).get("auth_id"):
                errors.append(f"{account['id']}: enabled account has no private native binding")
        for client in policy["clients"]:
            if client["id"] not in self.config.get("clients", {}):
                errors.append(f"{client['id']}: client has no private credential binding")
        return errors


def handler_for(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def send_response(self, *args, **kwargs):
            self._response_started = True
            return super().send_response(*args, **kwargs)

        def log_message(self, *_):
            # Request bodies, provider errors, and URLs can contain private data.
            pass

        def json_response(self, status, body, headers=None):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, str(value))
            self.end_headers()
            self.wfile.write(data)

        def read_json(self):
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise Rejected("Content-Length required", 411)
            if size < 1 or size > app.config.get("max_request_bytes", 16_000_000):
                raise Rejected("request body is missing or too large", 413)
            try:
                value = json.loads(self.rfile.read(size))
            except (ValueError, UnicodeError):
                raise Rejected("invalid JSON")
            if not isinstance(value, dict):
                raise Rejected("JSON object required")
            return value

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            self._response_started = False
            try:
                path = urlsplit(self.path).path
                if path.startswith("/control/"):
                    app.control_auth(self.headers)
                    self.control(path)
                    return
                client = app.identify(self.headers)
                if path == "/v1/routing/events" and self.command == "GET":
                    query = parse_qs(urlsplit(self.path).query)
                    try:
                        after = int(query.get("after", ["0"])[0])
                    except ValueError:
                        raise Rejected("invalid event cursor")
                    self.json_response(200, app.store.client_events(client, query.get("session_id", [""])[0], after))
                    return
                if path == "/v1/models" and self.command == "GET":
                    self.json_response(200, catalog(app.store.policy(), client))
                    return
                if path not in PATHS or self.command != "POST":
                    raise Rejected("endpoint not supported", 404)
                self.inference(path, client, self.read_json())
            except Rejected as error:
                if self._response_started:
                    self.close_connection = True
                else:
                    self.json_response(error.status, {"error": {"message": error.message, "type": "routing_error"}})
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
            except Exception:
                if self._response_started:
                    self.close_connection = True
                else:
                    self.json_response(500, {"error": {"message": "routing service failed; admitted reservations are retained", "type": "internal_error"}})

        def control(self, path):
            if path == "/control/state" and self.command == "GET":
                state = app.store.state()
                state["capabilities"] = app.capabilities()
                state["account_health"] = app.account_health()
                self.json_response(200, state)
                return
            if path == "/control/events" and self.command == "GET":
                query = parse_qs(urlsplit(self.path).query)
                try:
                    after = int(query.get("after", ["0"])[0])
                    limit = int(query.get("limit", ["100"])[0])
                except ValueError:
                    raise Rejected("invalid event cursor")
                self.json_response(200, app.store.events(after, limit))
                return
            if self.command != "POST":
                raise Rejected("endpoint not supported", 404)
            body = self.read_json()
            if path == "/control/policy/validate":
                errors = app.policy_errors(body.get("policy"))
                current = app.store.policy()
                self.json_response(200, {"valid": not errors, "errors": errors, "active_version": current["version"],
                                         "diff": preview(current, body["policy"]) if not errors else None})
            elif path == "/control/policy/apply":
                errors = app.policy_errors(body.get("policy"))
                if errors:
                    raise Rejected("; ".join(errors))
                policy = app.store.apply(body.get("policy"), body.get("expected_version"))
                self.json_response(200, {"policy": policy, "active_version": policy["version"]})
            elif path.startswith("/control/suggestions/"):
                self.json_response(200, app.store.decide_suggestion(path.rsplit("/", 1)[-1], body.get("action"), body.get("expected_version")))
            else:
                raise Rejected("endpoint not supported", 404)

        def inference(self, path, client, body):
            if not app.capabilities()["native_managed_attempt"]:
                raise Rejected("native exact-account single-attempt support is unavailable", 503)
            selected = body.get("model")
            if not isinstance(selected, str) or not selected:
                raise Rejected("model or role required")
            session = self.headers.get("X-Session-ID") or self.headers.get("Session_id") or self.headers.get("X-OpenCode-Session-ID") or body.get("conversation_id")
            if not session:
                metadata = body.get("metadata") or {}
                if isinstance(metadata, dict):
                    session = metadata.get("session_id")
                    user = metadata.get("user_id")
                    if not session and isinstance(user, str):
                        try:
                            parsed = json.loads(user)
                            session = parsed.get("session_id") if isinstance(parsed, dict) else None
                        except ValueError:
                            pass
            if not isinstance(session, str) or not session or len(session) > 256:
                raise Rejected("stable X-Session-ID is required for session affinity")
            request_id = uuid.uuid4().hex
            client_request_id = self.headers.get("X-Request-ID")
            if client_request_id and (len(client_request_id) > 256 or any(ord(c) < 33 for c in client_request_id)):
                raise Rejected("invalid client request ID")
            previous = app.store.acquire_session(client, session, selected, request_id, client_request_id)
            try:
                self.dispatch(path, client, session, selected, request_id, previous, body)
            finally:
                app.store.release_session(client, session, request_id)

        def dispatch(self, path, client, session, selected, request_id, previous, body):
            policy = app.store.policy()
            routes, role = candidates(policy, app.routing_runtime(), client, selected, PATHS[path], previous, body=body)
            last_error, fallback = None, None
            for model, route, binding in routes:
                attempt = None
                try:
                    payload, reserve = prepare(body, PATHS[path], model, route, binding)
                    attempt = app.store.admit(policy_version=policy["version"], request_id=request_id, client_id=client,
                        session_id=session, requested_model=selected, role=role, model=model["id"],
                        account_id=route["account_id"], billing=route["billing"], reserve=reserve,
                        fallback_reason=fallback or ("bound_model_unavailable" if previous and previous.get("model") and previous["model"] != model["id"] else None),
                        prices=route.get("prices"), price_version=route.get("price_version"),
                        client_request_id=self.headers.get("X-Request-ID"), client_turn_id=(self.headers.get("X-Client-Turn-ID") or "")[:256] or None,
                        upstream_model=route.get("upstream_canonical_model", route["upstream_model"]))
                    headers = app.native_headers()
                    headers.update({"Content-Type": "application/json", "X-Session-ID": session,
                                    "X-AI-Bills-Managed": "1", "X-AI-Bills-Attempt-ID": attempt["id"],
                                    "X-AI-Bills-Request-ID": request_id,
                                    "X-AI-Bills-Upstream-Model": route.get("upstream_canonical_model", route["upstream_model"]),
                                    "X-AI-Bills-Auth-ID": binding["auth_id"]})
                    if route["billing"] == "paid":
                        output_key = {"chat": "max_completion_tokens", "responses": "max_output_tokens", "messages": "max_tokens"}[PATHS[path]]
                        headers["X-AI-Bills-Max-Output"] = str(payload[output_key])
                        headers["X-AI-Bills-Service-Tier"] = "default"
                    # Only protocol headers are allowed through. Client credentials and
                    # arbitrary routing headers cannot reach the upstream provider.
                    for key in ("anthropic-version", "anthropic-beta", "openai-beta"):
                        if value := self.headers.get(key):
                            headers[key] = value
                    url = app.config["native"]["base_url"].rstrip("/") + path
                    with app.http.stream("POST", url, json=payload, headers=headers) as response:
                        if response.headers.get("X-AI-Bills-Managed-Version") != "1" or response.headers.get("X-AI-Bills-Attempt-ID") != attempt["id"] or response.headers.get("X-AI-Bills-Auth-ID") != binding["auth_id"]:
                            app.native_ready = False
                            app.store.finish(attempt["id"], error="native receipt mismatch")
                            raise Rejected("native managed receipt mismatch; reservation retained", 502)
                        if response.status_code >= 400:
                            # An HTTP error does not prove a paid attempt incurred no cost.
                            app.store.finish(attempt["id"], error="upstream HTTP " + str(response.status_code), complete=route["billing"] == "included")
                            if response.status_code in (401, 403, 404, 408, 409, 429, 500, 502, 503, 504):
                                fallback = "upstream_http_" + str(response.status_code)
                                last_error = Rejected("approved routes unavailable", 503)
                                continue
                            raise Rejected("upstream rejected the request", response.status_code)
                        evidence = {"X-AI-Bills-Request-ID": request_id, "X-AI-Bills-Attempt-ID": attempt["id"],
                                    "X-AI-Bills-Model": model["id"], "X-AI-Bills-Account": route["account_id"],
                                    "X-AI-Bills-Policy-Version": policy["version"]}
                        if fallback or (previous and previous.get("model") and previous["model"] != model["id"]):
                            evidence["X-AI-Bills-Fallback"] = fallback or "bound_model_unavailable"
                        if body.get("stream"):
                            self.forward_stream(response, evidence, attempt, route, PATHS[path])
                            return
                        data = response.read()
                        try:
                            parsed = json.loads(data)
                            usage = usage_from_payload(parsed, PATHS[path])
                        except (ValueError, UnicodeError):
                            usage = None
                        app.finalize(attempt, route, usage, complete=True, successful=True)
                        self.send_response(response.status_code)
                        self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                        self.send_header("Content-Length", str(len(data)))
                        for key, value in evidence.items():
                            self.send_header(key, str(value))
                        self.end_headers()
                        self.wfile.write(data)
                        return
                except httpx.HTTPError:
                    if attempt:
                        app.store.finish(attempt["id"], error="upstream transport interrupted")
                    # Unknown delivery is not replayed: provider might have accepted it.
                    raise Rejected("upstream delivery uncertain; no automatic replay", 502)
                except Rejected as error:
                    if error.status in (402, 503) and attempt is None and route["billing"] == "paid":
                        fallback = "paid_admission_denied"
                        last_error = error
                        continue
                    raise
            raise last_error or Rejected("approved routes exhausted", 503)

        def forward_stream(self, response, evidence, attempt, route, protocol):
            observer = StreamUsage(protocol)
            self.send_response(response.status_code)
            self.send_header("Content-Type", response.headers.get("Content-Type", "text/event-stream"))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            for key, value in evidence.items():
                self.send_header(key, str(value))
            self.end_headers()
            self.close_connection = True
            try:
                for chunk in response.iter_bytes():
                    observer.feed(chunk)
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except (httpx.HTTPError, BrokenPipeError, ConnectionResetError):
                app.store.finish(attempt["id"], error="stream interrupted", usage=observer.usage)
                return
            complete = observer.complete and not observer.failed
            app.finalize(attempt, route, observer.usage, complete=complete, successful=complete,
                         error=None if complete else "stream ended without successful terminal event")
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="private runtime JSON file")
    args = parser.parse_args()
    with open(args.config) as file:
        config = json.load(file)
    app = Application(config)
    from discovery import Discovery
    stop = threading.Event()
    def maintenance():
        discovery = Discovery(app)
        while not stop.is_set():
            discovery.tick()
            app.reconcile()
            stop.wait(60)
    maintenance_thread = threading.Thread(target=maintenance, daemon=True)
    maintenance_thread.start()
    server = ThreadingHTTPServer((config.get("listen", "127.0.0.1"), config.get("port", 8318)), handler_for(app))
    try:
        server.serve_forever()
    finally:
        stop.set()
        maintenance_thread.join(timeout=25)
        server.server_close()
        app.http.close()


if __name__ == "__main__":
    main()
