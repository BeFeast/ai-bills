import contextlib
import json
import threading
from http.server import ThreadingHTTPServer

import httpx
import pytest

from server import Application, handler_for


CAPABILITIES = {"version": 1, "exact_account": True, "single_attempt": True, "usage_receipts": True}


def receipt(request):
    return {"X-AI-Bills-Managed-Version": "1", "X-AI-Bills-Attempt-ID": request.headers["X-AI-Bills-Attempt-ID"],
            "X-AI-Bills-Auth-ID": request.headers["X-AI-Bills-Auth-ID"]}


@contextlib.contextmanager
def running(runtime, policy, provider):
    app = Application(runtime, transport=httpx.MockTransport(provider))
    app.store.apply(policy, 0)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(app))
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", timeout=5,
                      headers={"Authorization": "Bearer test-client", "X-Session-ID": "conversation"}) as client:
        try:
            yield app, client
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
            app.http.close()


def test_real_http_fallback_then_session_account_affinity(runtime, policy):
    calls = []
    def provider(request):
        if request.method == "GET":
            if "/ai-bills-receipts/" in request.url.path:
                return httpx.Response(200, json={"attempt_id": request.url.path.rsplit("/", 1)[-1], "auth_id": "auth-api", "model": "example-coder",
                                               "terminal": True, "usage_complete": True, "failed": False,
                                               "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 0, "cache_write_tokens": 0}})
            return httpx.Response(200, json=CAPABILITIES)
        calls.append((request.headers["X-AI-Bills-Auth-ID"], json.loads(request.content)))
        assert request.headers["Authorization"] == "Bearer test-native"
        if calls[-1][0] == "auth-sub":
            return httpx.Response(429, json={"error": "quota exhausted"}, headers=receipt(request))
        return httpx.Response(200, json={"model": "example-coder", "usage": {"prompt_tokens": 10, "completion_tokens": 2}, "choices": []}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        response = client.post("/v1/chat/completions", json={"model": "coding-quality", "messages": [{"role": "user", "content": "private prompt"}], "max_tokens": 5})
        assert response.status_code == 200, response.text
        assert [a for a, _ in calls] == ["auth-sub", "auth-api"]
        assert response.headers["X-AI-Bills-Fallback"] == "upstream_http_429"
        assert calls[-1][1]["model"] == "example-coder"
        assert app.store.budget()["spent_microusd"] == 16
        assert app.store.budget()["reserved_microusd"] == 0
        serialized = json.dumps(app.store.state())
        assert "private prompt" not in serialized and "auth-api" not in serialized
        assert app.store.acquire_session("example-client", "conversation", "coding-quality", "new")["account"] == "api-a"


def test_no_capability_no_inference(runtime, policy):
    calls = []
    def provider(request):
        calls.append(request.method)
        return httpx.Response(404)
    with running(runtime, policy, provider) as (app, client):
        response = client.post("/v1/responses", json={"model": "coding-quality", "input": "hello"})
        assert response.status_code == 503
        assert calls == ["GET"]
        assert app.store.state()["requests"] == []


def test_wrong_native_receipt_retains_reservation_no_fallback(runtime, policy):
    policy["models"][0]["routes"] = [policy["models"][0]["routes"][1]]
    calls = []
    def provider(request):
        if request.method == "GET":
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, json={"usage": {"prompt_tokens": 1, "completion_tokens": 1}})
    with running(runtime, policy, provider) as (app, client):
        response = client.post("/v1/chat/completions", json={"model": "coding-quality", "messages": []})
        assert response.status_code == 502 and len(calls) == 1
        assert app.store.budget()["reserved_microusd"] > 0
        assert not app.native_ready


def test_stream_bytes_unchanged_usage_settles_and_no_prompt_storage(runtime, policy):
    stream = b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    calls = []
    def provider(request):
        if request.method == "GET":
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, content=stream, headers={**receipt(request), "Content-Type": "text/event-stream"})
    with running(runtime, policy, provider) as (app, client):
        response = client.post("/v1/chat/completions", json={"model": "coding-quality", "messages": [], "stream": True})
        assert response.status_code == 200 and response.content == stream
        assert len(calls) == 1
        assert app.store.state()["requests"][0]["status"] == "settled"


def test_control_auth_conflict_preview_and_applied_version(runtime, policy):
    with running(runtime, policy, lambda _: httpx.Response(200, json=CAPABILITIES)) as (app, client):
        assert client.get("/control/state").status_code == 401
        headers = {"Authorization": "Bearer test-control"}
        response = client.post("/control/policy/validate", headers=headers, json={"policy": policy})
        assert response.json()["valid"] and response.json()["active_version"] == 1
        assert client.post("/control/policy/apply", headers=headers, json={"policy": policy, "expected_version": 0}).status_code == 409
        assert client.post("/control/policy/apply", headers=headers, json={"policy": policy, "expected_version": 1}).json()["active_version"] == 2
        assert client.get("/control/state", headers=headers).json()["policy"]["version"] == 2
        assert client.get("/v1/models").json()["data"][0]["id"] == "coding-quality"


def test_paid_transport_uncertainty_never_replayed(runtime, policy):
    policy["models"][0]["routes"] = [policy["models"][0]["routes"][1]]
    calls = []
    def provider(request):
        if request.method == "GET":
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        raise httpx.ReadError("connection lost", request=request)
    with running(runtime, policy, provider) as (app, client):
        response = client.post("/v1/responses", json={"model": "coding-quality", "input": "hello"})
        assert response.status_code == 502 and len(calls) == 1
        assert app.store.budget()["reserved_microusd"] > 0


def test_client_sdk_retry_key_cannot_dispatch_twice(runtime, policy):
    calls = []
    def provider(request):
        if request.method == "GET":
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, json={"usage": {"prompt_tokens": 1, "completion_tokens": 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        args = {"json": {"model": "coding-quality", "messages": []}, "headers": {"X-Request-ID": "stable-provider-call"}}
        assert client.post("/v1/chat/completions", **args).status_code == 200
        assert client.post("/v1/chat/completions", **args).status_code == 409
        assert len(calls) == 1
        events = client.get('/v1/routing/events?session_id=conversation&after=0').json()
        assert events['events'][0]['body']['client_request_id'] == 'stable-provider-call'
        assert client.get('/v1/routing/events?session_id=someone-else&after=0').json()['events'] == []
        assert 'auth-sub' not in json.dumps(events)


def test_delayed_native_usage_reconciles_original_tariff(runtime, policy):
    app = Application(runtime)
    app.store.apply(policy, 0)
    route = policy["models"][0]["routes"][1]
    attempt = app.store.admit(policy_version=1, request_id="r", client_id="example-client", session_id="s",
                              requested_model="coding-quality", role="coding-quality", model="example-coder", upstream_model="example-coder",
                              account_id="api-a", billing="paid", reserve=50_000, prices=route["prices"], price_version="old")
    app.store.finish(attempt["id"], complete=True, usage={"input": 0, "output": 0}, error="native pending")
    route["prices"] = {key: value * 10 for key, value in route["prices"].items()}
    app.store.apply(policy, 1)
    app.http.close()
    app.http = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(200, json={
        "attempt_id": attempt["id"], "auth_id": "auth-api", "model": "example-coder", "terminal": True,
        "usage_complete": True, "failed": False, "usage": {"input_tokens": 10, "output_tokens": 2, "cache_read_tokens": 0, "cache_write_tokens": 0}})))
    app.reconcile()
    assert app.store.budget()["spent_microusd"] == 16
    assert app.store.budget()["reserved_microusd"] == 0
    app.reconcile()
    assert app.store.budget()["spent_microusd"] == 16


def test_quota_projection_reloads_and_corruption_is_unknown(runtime, policy, tmp_path):
    import datetime as dt
    from engine import candidates
    app = Application(runtime)
    app.store.apply(policy, 0)
    path = tmp_path / "quota.json"
    runtime["quota_snapshot_path"] = str(path)
    now = app.store.clock()
    path.write_text(json.dumps({"accounts": {"subscription-a": {"observed_at": now.isoformat(), "reset_at": (now + dt.timedelta(hours=1)).isoformat(), "remaining_fraction": 0}}}))
    assert app.account_health()[0]["quota_state"] == "exhausted"
    assert candidates(policy, app.routing_runtime(), "example-client", "coding-quality", "chat")[0][0][1]["account_id"] == "api-a"
    path.write_text("incomplete atomic writer")
    assert app.account_health()[0]["quota_state"] == "unknown"
    assert candidates(policy, app.routing_runtime(), "example-client", "coding-quality", "chat")[0][0][1]["account_id"] == "subscription-a"


def test_post_stream_storage_failure_does_not_append_http_error_or_replay(runtime, policy):
    stream = b'data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    calls = []
    def provider(request):
        if request.method == "GET":
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, content=stream, headers={**receipt(request), "Content-Type": "text/event-stream"})
    with running(runtime, policy, provider) as (app, client):
        def failing_finish(*args, **kwargs):
            raise OSError("test disk failure")
        app.store.finish = failing_finish
        response = client.post("/v1/chat/completions", json={"model": "coding-quality", "messages": [], "stream": True})
        assert response.status_code == 200 and response.content == stream
        assert len(calls) == 1
        assert app.store.state()["requests"][0]["status"] == "admitted"


def test_canonical_alias_receipt_uuid_and_client_isolation(runtime, policy, monkeypatch):
    import uuid
    monkeypatch.setenv('OTHER_CLIENT', 'other-client-key')
    runtime['clients']['other'] = {'api_key_env': 'OTHER_CLIENT'}
    model = policy['models'][0]
    model['routes'] = [model['routes'][1]]
    model['routes'][0]['upstream_model'] = 'registered-alias'
    model['routes'][0]['upstream_canonical_model'] = 'example-coder'
    calls = []
    def provider(request):
        if '/ai-bills-receipts/' in request.url.path:
            return httpx.Response(200, json={'attempt_id': request.url.path.rsplit('/', 1)[-1],
                'auth_id': 'auth-api', 'model': 'example-coder', 'terminal': True,
                'usage_complete': True, 'failed': False,
                'usage': {'input_tokens': 1, 'output_tokens': 1, 'cache_read_tokens': 0, 'cache_write_tokens': 0}})
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        assert str(uuid.UUID(request.headers['X-AI-Bills-Attempt-ID'])) == request.headers['X-AI-Bills-Attempt-ID']
        assert request.headers['X-AI-Bills-Upstream-Model'] == 'example-coder'
        assert json.loads(request.content)['model'] == 'registered-alias'
        return httpx.Response(200, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        assert client.post('/v1/chat/completions', json={'model': 'coding-quality', 'messages': []},
                           headers={'X-Client-Turn-ID': 'turn-fixture'}).status_code == 200
        events = client.get('/v1/routing/events?session_id=conversation').json()
        assert len(events['events']) == 2
        assert events['events'][-1]['body']['client_turn_id'] == 'turn-fixture'
        assert events['events'][-1]['body']['status'] == 'settled'
        assert client.get('/v1/routing/events?session_id=conversation', headers={'Authorization': 'Bearer other-client-key'}).json()['events'] == []
        assert client.get('/v1/routing/events?session_id=conversation', headers={'Authorization': 'Bearer bad'}).status_code == 401
        assert client.get('/v1/routing/events?session_id=conversation&after=' + str(events['next_cursor'])).json()['events'] == []
        assert app.store.budget()['reserved_microusd'] == 0
        assert len(calls) == 1


def test_bound_model_disappears_emits_receipt_fallback(runtime, policy):
    import copy
    second = copy.deepcopy(policy['models'][0])
    second['id'] = 'second'
    policy['models'].append(second)
    policy['roles'][0]['candidates'].append('second')
    policy['clients'][0]['models'].append('second')
    def provider(request):
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        return httpx.Response(200, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        payload = {'model': 'coding-quality', 'messages': []}
        assert client.post('/v1/chat/completions', json=payload).status_code == 200
        policy['models'][0]['status'] = 'denied'
        app.store.apply(policy, 1)
        response = client.post('/v1/chat/completions', json=payload)
        assert response.headers['X-AI-Bills-Fallback'] == 'bound_model_unavailable'
        events = client.get('/v1/routing/events?session_id=conversation').json()['events']
        assert events[-1]['body']['fallback_reason'] == 'bound_model_unavailable'
        assert events[-1]['body']['model'] == 'second'


def test_whole_snapshot_opaque_quota_binding(runtime, policy, tmp_path):
    import datetime as dt
    path = tmp_path / 'snapshot.json'
    runtime['quota_snapshot_path'] = str(path)
    runtime['accounts']['subscription-a']['quota_source_key'] = 'a' * 24
    app = Application(runtime)
    app.store.apply(policy, 0)
    now = app.store.clock()
    path.write_text(json.dumps({'account_quotas': {'a' * 24: {'observed_at': now.isoformat(),
        'reset_at': (now + dt.timedelta(hours=1)).isoformat(), 'remaining_fraction': 0}},
        'accounts': {'subscription-a': {'remaining_fraction': 1}}}))
    assert app.account_health()[0]['quota_state'] == 'exhausted'
    path.write_text('{}')
    assert app.account_health()[0]['quota_state'] == 'unknown'


def test_budget_unavailable_keeps_existing_and_new_included_sessions(runtime, policy):
    from pathlib import Path
    calls = []
    def provider(request):
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        payload = {'model': 'coding-quality', 'messages': []}
        assert client.post('/v1/chat/completions', json=payload).status_code == 200
        Path(app.store.budget_authority.path).write_text('synthetic corrupt budget authority')
        assert app.store.budget()['available'] is False
        assert client.post('/v1/chat/completions', json=payload).status_code == 200
        assert client.post('/v1/chat/completions', json=payload, headers={'X-Session-ID': 'new-included'}).status_code == 200
        assert all(r.headers['X-AI-Bills-Auth-ID'] == 'auth-sub' for r in calls)
        policy['models'][0]['routes'] = [policy['models'][0]['routes'][1]]
        app.store.apply(policy, 1)
        assert client.post('/v1/chat/completions', json=payload, headers={'X-Session-ID': 'new-paid'}).status_code == 503
        assert len(calls) == 3


def two_paid_candidates(policy):
    import copy
    policy['models'][0]['routes'] = [policy['models'][0]['routes'][1]]
    other = copy.deepcopy(policy['models'][0])
    other['id'] = 'second-paid'
    policy['models'].append(other)
    policy['roles'][0]['candidates'].append(other['id'])
    policy['clients'][0]['models'].append(other['id'])


def test_http402_falls_back_without_releasing_uncertain_paid_liability(runtime, policy):
    two_paid_candidates(policy)
    calls = []
    def provider(request):
        if '/ai-bills-receipts/' in request.url.path:
            return httpx.Response(404)
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        status = 402 if len(calls) == 1 else 200
        return httpx.Response(status, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        response = client.post('/v1/chat/completions', json={'model': 'coding-quality', 'messages': []})
        assert response.status_code == 200
        assert response.headers['X-AI-Bills-Fallback'] == 'upstream_http_402'
        assert len(calls) == 2
        attempts = app.store.state()['requests']
        assert all(row['status'] == 'unresolved' for row in attempts)
        assert app.store.budget()['reserved_microusd'] == sum(row['reserved_microusd'] for row in attempts)


def test_native_predispatch_failure_without_accept_headers_releases_only_proven_zero(runtime, policy):
    two_paid_candidates(policy)
    calls = []
    def provider(request):
        if '/ai-bills-receipts/' in request.url.path:
            identity = request.url.path.rsplit('/', 1)[-1]
            if identity != calls[0].headers['X-AI-Bills-Attempt-ID']:
                return httpx.Response(404)
            return httpx.Response(200, json={'attempt_id': identity, 'auth_id': 'auth-api',
                'terminal': True, 'failed': True, 'billable_zero': True, 'started': False, 'accepted': False})
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(500, json={'error': 'selected model unavailable'})
        return httpx.Response(200, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        response = client.post('/v1/chat/completions', json={'model': 'coding-quality', 'messages': []})
        assert response.status_code == 200
        assert response.headers['X-AI-Bills-Fallback'] == 'native_predispatch_rejected'
        assert len(calls) == 2 and app.native_ready
        attempts = app.store.state()['requests']
        zero = next(a for a in attempts if a['model'] == 'example-coder')
        pending = next(a for a in attempts if a['model'] == 'second-paid')
        assert zero['status'] == 'settled' and zero['cost_microusd'] == 0
        assert app.store.budget()['reserved_microusd'] == pending['reserved_microusd']


@pytest.mark.parametrize('override', [
    {'attempt_id': 'wrong'}, {'auth_id': 'wrong'}, {'started': True},
    {'billable_zero': False}, {'terminal': False}, {'failed': False},
    {'model': 'wrong'}, {'accepted': True},
])
def test_unproven_zero_receipt_never_releases_or_allows_header_mismatch_fallback(runtime, policy, override):
    two_paid_candidates(policy)
    calls = []
    def provider(request):
        if '/ai-bills-receipts/' in request.url.path:
            return httpx.Response(200, json={
                'attempt_id': request.url.path.rsplit('/', 1)[-1], 'auth_id': 'auth-api',
                'terminal': True, 'failed': True, 'billable_zero': True, 'started': False, 'accepted': False, **override})
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(500)
    with running(runtime, policy, provider) as (app, client):
        response = client.post('/v1/chat/completions', json={'model': 'coding-quality', 'messages': []})
        assert response.status_code == 502 and len(calls) == 1
        assert app.store.budget()['reserved_microusd'] > 0


def test_delayed_predispatch_receipt_reconciles_zero_and_unblocks_session(runtime, policy):
    app = Application(runtime)
    app.store.apply(policy, 0)
    app.store.acquire_session('example-client', 'stuck', 'coding-quality', 'request')
    attempt = app.store.admit(policy_version=1, request_id='request', client_id='example-client', session_id='stuck',
        requested_model='coding-quality', role='coding-quality', model='example-coder', upstream_model='example-coder',
        account_id='api-a', billing='paid', reserve=500_000)
    app.store.finish(attempt['id'], error='missing native response headers')
    app.http.close()
    app.http = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={
        'attempt_id': attempt['id'], 'auth_id': 'auth-api', 'terminal': True, 'failed': True,
        'billable_zero': True, 'started': False, 'accepted': False})))
    app.reconcile()
    assert app.store.budget()['reserved_microusd'] == 0
    assert app.store.budget()['spent_microusd'] == 0
    assert app.store.acquire_session('example-client', 'stuck', 'coding-quality', 'next')['model'] is None
    app.reconcile()
    assert app.store.budget()['reserved_microusd'] == 0


def test_genuine_opencode_metadata_forwarding_is_account_and_client_scoped(runtime, policy):
    runtime['accounts']['subscription-a']['opencode_headers_clients'] = ['example-client']
    policy['models'][0]['routes'][0]['allowed_clients'] = ['example-client']
    calls = []
    def provider(request):
        if request.method == 'GET':
            return httpx.Response(200, json=CAPABILITIES)
        calls.append(request)
        return httpx.Response(200, json={'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}, headers=receipt(request))
    with running(runtime, policy, provider) as (app, client):
        payload = {'model': 'coding-quality', 'messages': []}
        assert client.post('/v1/chat/completions', json=payload).status_code == 400
        assert not calls and not app.store.state()['requests']
        headers = {'X-Session-ID': 'opencode:ses_fixture', 'X-Client-Turn-ID': 'msg_fixture',
                   'x-opencode-session': 'ses_fixture', 'x-opencode-request': 'msg_fixture',
                   'x-opencode-project': 'project_fixture', 'x-not-approved': 'never-forward'}
        assert client.post('/v1/chat/completions', json=payload, headers=headers).status_code == 200
        assert calls[0].headers['x-opencode-session'] == 'ses_fixture'
        assert calls[0].headers['x-opencode-request'] == 'msg_fixture'
        assert calls[0].headers['x-opencode-project'] == 'project_fixture'
        assert 'x-not-approved' not in calls[0].headers
        # Same genuine client metadata is not leaked to unrelated upstream accounts.
        runtime['accounts']['subscription-a'].pop('opencode_headers_clients')
        assert client.post('/v1/chat/completions', json=payload, headers=headers).status_code == 200
        assert 'x-opencode-session' not in calls[-1].headers
        assert 'x-opencode-request' not in calls[-1].headers


@pytest.mark.parametrize('headers', [
    {'X-Session-ID': 'opencode:ses_real', 'X-Client-Turn-ID': 'msg_real', 'x-opencode-session': 'different', 'x-opencode-request': 'msg_real'},
    {'X-Session-ID': 'opencode:ses_real', 'X-Client-Turn-ID': 'msg_real', 'x-opencode-session': 'ses_real', 'x-opencode-request': 'different'},
])
def test_opencode_metadata_must_match_actual_gateway_session_and_turn(runtime, policy, headers):
    runtime['accounts']['subscription-a']['opencode_headers_clients'] = ['example-client']
    calls = []
    def provider(request):
        calls.append(request)
        return httpx.Response(200, json=CAPABILITIES)
    with running(runtime, policy, provider) as (app, client):
        assert client.post('/v1/chat/completions', json={'model': 'coding-quality', 'messages': []}, headers=headers).status_code == 400
        assert all(r.method == 'GET' for r in calls)
        assert not app.store.state()['requests']
