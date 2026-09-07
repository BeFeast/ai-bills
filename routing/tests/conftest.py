import copy
import json
from pathlib import Path

import pytest


@pytest.fixture
def policy():
    return json.loads((Path(__file__).parents[1] / "fixtures/policy.json").read_text())


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("TEST_CONTROL", "test-control")
    monkeypatch.setenv("TEST_CLIENT", "test-client")
    monkeypatch.setenv("TEST_NATIVE", "test-native")
    monkeypatch.setenv("TEST_MANAGED", "test-managed")
    return {"database": str(tmp_path / "routing.sqlite"), "control_token_env": "TEST_CONTROL",
            "native": {"base_url": "http://native.test", "api_key_env": "TEST_NATIVE", "managed_token_env": "TEST_MANAGED"},
            "clients": {"example-client": {"api_key_env": "TEST_CLIENT"}},
            "accounts": {"subscription-a": {"auth_id": "auth-sub"}, "api-a": {"auth_id": "auth-api", "quota_mode": "metered", "verified_input_limits": {"example-coder": {"tokens": 32000, "evidence": "fictional provider context fixture"}}}}}
