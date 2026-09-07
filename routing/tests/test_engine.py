import copy
import datetime as dt

import pytest

from engine import StreamUsage, candidates, catalog, cost_for, prepare, usage_from_payload
from store import Rejected

PAID_BINDING = {"verified_input_limits": {"example-coder": {"tokens": 32000, "evidence": "fictional upstream context fixture"}}}


def test_role_manual_client_subset_and_hidden_session_semantics(policy, runtime):
    model = policy["models"][0]
    policy["models"].append(dict(model, id="second"))
    policy["roles"][0]["candidates"].append("second")
    # The role cannot expose models outside the client's concrete subset.
    routes, role = candidates(policy, runtime, "example-client", "coding-quality", "chat")
    assert {m["id"] for m, _, _ in routes} == {"example-coder"}
    assert role == "coding-quality"
    policy["clients"][0]["models"].append("second")
    routes, role = candidates(policy, runtime, "example-client", "example-coder", "chat")
    assert role is None and {m["id"] for m, _, _ in routes} == {"example-coder"}
    model["status"] = "hidden"
    assert "example-coder" not in [m["id"] for m in catalog(policy, "example-client")["data"]]
    with pytest.raises(Rejected):
        candidates(policy, runtime, "example-client", "example-coder", "chat")
    assert candidates(policy, runtime, "example-client", "example-coder", "chat", {"model": "example-coder"})[0]
    model["status"] = "denied"
    with pytest.raises(Rejected):
        candidates(policy, runtime, "example-client", "example-coder", "chat", {"model": "example-coder"})


def test_quota_unknown_permits_included_and_fresh_zero_skips(policy, runtime):
    now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    routes, _ = candidates(policy, runtime, "example-client", "coding-quality", "chat", now=now)
    assert routes[0][1]["billing"] == "included"
    runtime["accounts"]["subscription-a"]["quota"] = {"observed_at": now.isoformat(), "reset_at": (now + dt.timedelta(hours=1)).isoformat(), "remaining_fraction": 0}
    routes, _ = candidates(policy, runtime, "example-client", "coding-quality", "chat", now=now)
    assert [r[1]["billing"] for r in routes] == ["paid"]
    runtime["accounts"]["subscription-a"]["quota"]["observed_at"] = (now - dt.timedelta(hours=1)).isoformat()
    assert candidates(policy, runtime, "example-client", "coding-quality", "chat", now=now)[0][0][1]["billing"] == "included"


def test_paid_prices_bound_and_function_schema_allowed(policy, runtime):
    model = policy["models"][0]
    route = model["routes"][1]
    body = {"model": "coding-quality", "messages": [{"role": "user", "content": "hello"}], "max_tokens": 10,
            "tools": [{"type": "function", "function": {"name": "read_file", "parameters": {"type": "object"}}}]}
    payload, reserve = prepare(body, "chat", model, route, PAID_BINDING)
    assert reserve == 40_030
    assert payload["max_completion_tokens"] == 10 and "max_tokens" not in payload
    assert body["max_tokens"] == 10
    with pytest.raises(Rejected, match="unknown prices"):
        prepare(body, "chat", model, dict(route, prices=None), PAID_BINDING)
    with pytest.raises(Rejected, match="unpriced"):
        prepare(dict(body, tools=[{"type": "web_search"}]), "chat", model, route, PAID_BINDING)
    with pytest.raises(Rejected, match="unbounded"):
        prepare(dict(body, previous_response_id="prior"), "responses", model, route, PAID_BINDING)


def test_cache_and_reasoning_usage_not_double_counted(policy):
    usage = usage_from_payload({"usage": {"prompt_tokens": 100, "completion_tokens": 25,
                              "prompt_tokens_details": {"cached_tokens": 80},
                              "completion_tokens_details": {"reasoning_tokens": 20}}}, "chat")
    assert usage == {"input": 20, "cache_read": 80, "cache_write": 0, "output": 25}
    assert cost_for(usage, policy["models"][0]) == 103


def test_route_prices_are_authority_not_model_baseline(policy):
    model = policy["models"][0]
    route = copy.deepcopy(model["routes"][1])
    body = {"messages": [], "max_completion_tokens": 10}
    _, reserve = prepare(body, "chat", model, route, PAID_BINDING)
    model["prices"] = {k: 0 for k in model["prices"]}
    _, unchanged = prepare(body, "chat", model, route, PAID_BINDING)
    assert unchanged == reserve
    route["prices"] = {k: v * 2 for k, v in route["prices"].items()}
    assert prepare(body, "chat", model, route, PAID_BINDING)[1] == reserve * 2


def test_unverified_byte_estimate_never_reduces_reservation(policy):
    model = policy["models"][0]
    route = model["routes"][1]
    body = {"messages": [], "max_completion_tokens": 10}
    baseline = prepare(body, "chat", model, route, PAID_BINDING)[1]
    binding = {**PAID_BINDING, "token_bound": {"kind": "utf8_bytes", "protocol": "chat", "tokens_per_byte": 1, "overhead_tokens": 100, "verified": True}}
    assert prepare(body, "chat", model, route, binding)[1] == baseline


@pytest.mark.parametrize("protocol,chunks,expected", [
    ("chat", [b'data: {"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n', b'data: [DONE]\n\n'], {"input": 3, "output": 2, "cache_read": 0, "cache_write": 0}),
    ("responses", [b'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n'], {"input": 4, "output": 2, "cache_read": 0, "cache_write": 0}),
    ("messages", [b'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":8}}}\n\n', b'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n', b'data: {"type":"message_stop"}\n\n'], {"input": 5, "output": 3, "cache_read": 8, "cache_write": 0}),
])
def test_sse_usage_at_arbitrary_byte_boundaries(protocol, chunks, expected):
    observer = StreamUsage(protocol)
    for byte in b"".join(chunks):
        observer.feed(bytes([byte]))
    assert observer.complete and not observer.failed
    assert observer.usage == expected


def test_partial_stream_is_not_terminal():
    observer = StreamUsage("responses")
    observer.feed(b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
    assert not observer.complete and observer.usage is None


def test_paid_route_requires_provider_bound_and_policy_cannot_shrink_it(policy):
    model = policy['models'][0]
    route = model['routes'][1]
    with pytest.raises(Rejected, match='verified upstream context'):
        prepare({'messages': []}, 'chat', model, route, {})
    expected = prepare({'messages': []}, 'chat', model, route, PAID_BINDING)[1]
    model['input_limit_tokens'] = 1
    assert prepare({'messages': []}, 'chat', model, route, PAID_BINDING)[1] == expected


def test_cheap_price_order_and_session_pin_override_new_session_preferences(policy, runtime):
    model = policy['models'][0]
    model['routes'] = [model['routes'][1]]
    cheap = copy.deepcopy(model)
    cheap['id'] = 'second'
    cheap['routes'][0]['prices'] = {k: v // 2 for k, v in model['routes'][0]['prices'].items()}
    policy['models'].append(cheap)
    policy['roles'][3]['candidates'].append('second')
    policy['clients'][0]['models'].append('second')
    routes, _ = candidates(policy, runtime, 'example-client', 'general-cheap', 'chat', body={'messages': []})
    assert routes[0][0]['id'] == 'second'
    routes, _ = candidates(policy, runtime, 'example-client', 'general-cheap', 'chat', previous={'model': 'example-coder'})
    assert routes[0][0]['id'] == 'example-coder'
    cheap['routes'][0]['billing'] = 'included'
    routes, _ = candidates(policy, runtime, 'example-client', 'general-cheap', 'chat', previous={'model': 'example-coder'})
    assert routes[0][0]['id'] == 'example-coder'
    assert candidates(policy, runtime, 'example-client', 'general-cheap', 'chat')[0][0][0]['id'] == 'second'


def test_catalog_tools_require_all_role_candidates_verified(policy):
    model = policy['models'][0]
    assert not catalog(policy, 'example-client')['data'][0]['tool_call']
    model['tool_call'] = True
    second = dict(model, id='second', tool_call=False, input_limit_tokens=8000)
    policy['models'].append(second)
    policy['roles'][0]['candidates'].append('second')
    policy['clients'][0]['models'].append('second')
    entries = {m['id']: m for m in catalog(policy, 'example-client')['data']}
    assert not entries['coding-quality']['tool_call']
    assert entries['coding-quality']['context_length'] == 8000
    assert entries['example-coder']['tool_call']


def test_client_scoped_route_filters_catalog_manual_and_roles(policy, runtime):
    policy['models'][0]['routes'] = [dict(policy['models'][0]['routes'][0], allowed_clients=['opencode-client'])]
    policy['clients'].append({'id': 'opencode-client', 'models': ['example-coder'], 'roles': ['coding-quality']})
    assert catalog(policy, 'example-client')['data'] == []
    for selected in ('example-coder', 'coding-quality'):
        with pytest.raises(Rejected, match='no approved'):
            candidates(policy, runtime, 'example-client', selected, 'chat')
    assert catalog(policy, 'opencode-client')['data'][0]['id'] == 'coding-quality'
    assert candidates(policy, runtime, 'opencode-client', 'coding-quality', 'chat')[0]
