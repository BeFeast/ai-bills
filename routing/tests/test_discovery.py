import json

import httpx

from discovery import Discovery
from server import Application


def test_weekly_discovery_stages_unknown_model_and_does_not_duplicate(runtime, policy):
    calls = []
    def provider(request):
        calls.append(request)
        return httpx.Response(200, json={"data": [{"id": "new-upstream", "name": "New model"}]})
    runtime["catalog_sources"] = [{"id": "test-source", "kind": "openai-models", "url": "http://metadata.test/v1/models", "account_id": "api-a"}]
    app = Application(runtime, transport=httpx.MockTransport(provider))
    app.store.apply(policy, 0)
    discovery = Discovery(app)
    discovery.tick()
    discovery.tick()
    assert len(calls) == 1
    state = app.store.state()
    assert len(state["suggestions"]) == 1
    suggestion = state["suggestions"][0]
    assert suggestion["model"]["status"] == "hidden" and suggestion["model"]["prices"] is None
    assert state["policy"]["version"] == 1
    result = app.store.decide_suggestion(suggestion["id"], "accept", 1)
    assert not app.policy_errors(result["proposed_policy"])
    assert app.store.policy()["version"] == 1
    discovery.tick(force=True)
    assert len(app.store.state()["suggestions"]) == 1
    assert app.store.events()["next_cursor"] > 0
    assert app.store.events(app.store.events()["next_cursor"])["events"] == []


def test_local_opencode_cache_no_price_unit_assumption(runtime, tmp_path):
    path = tmp_path / "catalog.json"
    path.write_text(json.dumps({"test-provider": {"models": {"model": {"name": "Model", "cost": {"input": 0.1}, "limit": {"context": 1000, "output": 100}}}}}))
    runtime["catalog_sources"] = [{"id": "local", "kind": "opencode-cache", "path": str(path), "provider_id": "test-provider"}]
    app = Application(runtime)
    Discovery(app).tick()
    model = app.store.state()["suggestions"][0]["model"]
    assert model["input_limit_tokens"] == 1000
    assert model["prices"] is None
