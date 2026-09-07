import concurrent.futures
import datetime as dt
import json

import pytest

from store import Rejected, Store


def admit(store, request, amount):
    return store.admit(policy_version=1, request_id=request, client_id="client", session_id=request,
                       requested_model="model", role=None, model="model", account_id="api", billing="paid", reserve=amount)


def test_concurrent_admission_never_oversubscribes_and_reopen_keeps_reservations(tmp_path, policy):
    path = str(tmp_path / "state.sqlite")
    store = Store(path)
    store.apply(policy, 0)
    def reserve(i):
        try:
            return admit(store, str(i), 600_000)
        except Rejected as error:
            assert error.status == 402
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        admitted = [a for a in pool.map(reserve, range(8)) if a]
    assert len(admitted) == 3
    restored = Store(path)
    assert restored.budget()["reserved_microusd"] == 1_800_000
    restored.finish(admitted[0]["id"], cost=100_000, complete=True)
    assert restored.budget()["spent_microusd"] == 100_000
    assert restored.budget()["reserved_microusd"] == 1_200_000
    # Settlement is idempotent, not additive.
    restored.finish(admitted[0]["id"], cost=100_000, complete=True)
    assert restored.budget()["spent_microusd"] == 100_000


def test_settlement_uses_original_jerusalem_day_across_midnight_and_crash(tmp_path, policy):
    now = [dt.datetime(2026, 8, 4, 20, 59, tzinfo=dt.timezone.utc)]
    store = Store(str(tmp_path / "state.sqlite"), clock=lambda: now[0])
    store.apply(policy, 0)
    old = admit(store, "old", 1_800_000)
    assert old["admitted_date"] == "2026-08-04"
    now[0] += dt.timedelta(minutes=2)
    new = admit(store, "new", 1_800_000)
    assert new["admitted_date"] == "2026-08-05"
    store.finish(old["id"], cost=500_000, complete=True)
    assert store.budget()["spent_microusd"] == 0
    assert store.budget()["reserved_microusd"] == 1_800_000
    assert store.budget(date="2026-08-04")["spent_microusd"] == 500_000


def test_missing_usage_and_error_keep_money_reserved(tmp_path, policy):
    store = Store(str(tmp_path / "state.sqlite"))
    store.apply(policy, 0)
    attempt = admit(store, "r", 1_900_000)
    store.finish(attempt["id"], complete=True, error="missing usage")
    assert store.budget()["reserved_microusd"] == 1_900_000
    with pytest.raises(Rejected):
        admit(store, "r2", 100_001)
    store.finish(attempt["id"], cost=30_000, complete=True)
    assert store.budget()["reserved_microusd"] == 0


def test_policy_conflict_and_suggestion_accept_only_drafts(tmp_path, policy):
    store = Store(str(tmp_path / "state.sqlite"))
    store.apply(policy, 0)
    with pytest.raises(Rejected, match="conflict"):
        store.apply(policy, 0)
    model = dict(policy["models"][0], id="new-model")
    sid = store.add_suggestion(model, "new catalog candidate")
    result = store.decide_suggestion(sid, "accept", 1)
    assert result["policy"]["version"] == 1
    assert "new-model" not in [m["id"] for m in store.policy()["models"]]
    assert "new-model" in [m["id"] for m in result["proposed_policy"]["models"]]
    with store.connection() as db:
        assert db.execute("SELECT count(*) FROM outbox").fetchone()[0] == 3


def test_session_concurrency_guard_and_sticky_manual_binding(tmp_path, policy):
    store = Store(str(tmp_path / "state.sqlite"))
    store.apply(policy, 0)
    assert store.acquire_session("client", "session", "model", "r") is None
    with pytest.raises(Rejected, match="active"):
        store.acquire_session("client", "session", "model", "r2")
    attempt = store.admit(policy_version=1, request_id="r", client_id="client", session_id="session",
                          requested_model="model", role=None, model="actual", account_id="api", billing="included", reserve=0)
    store.finish(attempt["id"], complete=True, successful=True)
    store.release_session("client", "session", "r")
    previous = store.acquire_session("client", "session", "model", "r2")
    assert previous["model"] == "actual"


def test_budget_outage_preserves_included_journal_and_never_recreates_allowance(tmp_path, policy):
    from pathlib import Path
    path = str(tmp_path / 'state.sqlite')
    store = Store(path)
    store.apply(policy, 0)
    paid = admit(store, 'paid-before-outage', 1_900_000)
    budget_path = Path(store.budget_authority.path)
    parked = budget_path.with_suffix('.held')
    budget_path.rename(parked)
    restarted = Store(path)
    assert not budget_path.exists()
    assert restarted.budget()['available'] is False
    assert restarted.budget()['spent_microusd'] is None
    with pytest.raises(Rejected, match='budget unavailable'):
        admit(restarted, 'paid-during-outage', 1)
    assert restarted.acquire_session('client', 's', 'example-coder', 'included') is None
    free = restarted.admit(policy_version=1, request_id='included', client_id='client', session_id='s',
        requested_model='example-coder', role=None, model='example-coder', account_id='subscription-a', billing='included', reserve=0)
    restarted.finish(free['id'], complete=True, successful=True)
    restarted.release_session('client', 's', 'included')
    assert restarted.acquire_session('client', 's', 'example-coder', 'next')['model'] == 'example-coder'
    assert restarted.state()['policy']['version'] == 1
    # A receipt can finalize while the authority is offline; recovery preserves
    # the original reserve until the durable receipt is reconciled.
    restarted.finish(paid['id'], cost=100_000, complete=True)
    parked.rename(budget_path)
    assert restarted.budget()['reserved_microusd'] == 1_900_000
    restarted.reconcile_budget()
    assert restarted.budget()['reserved_microusd'] == 0
    assert restarted.budget()['spent_microusd'] == 100_000


def test_legacy_migration_imports_all_days_without_losing_existing_liability(tmp_path, policy):
    from pathlib import Path
    path = str(tmp_path / 'state.sqlite')
    store = Store(path)
    store.apply(policy, 0)
    settled = admit(store, 'settled', 400_000)
    store.finish(settled['id'], cost=150_000, complete=True)
    admit(store, 'unresolved', 1_200_000)
    # Simulate an old operational database before the independent authority existed.
    with store.connection(write=True) as db:
        db.execute("DELETE FROM metadata WHERE key='budget_initialized'")
    Path(store.budget_authority.path).unlink()
    migrated = Store(path)
    assert migrated.budget()['spent_microusd'] == 150_000
    assert migrated.budget()['reserved_microusd'] == 1_200_000
    assert Store(path).budget() == migrated.budget()


def test_failed_attempt_journal_insert_keeps_already_committed_paid_reservation(tmp_path, policy):
    import sqlite3
    store = Store(str(tmp_path / 'state.sqlite'))
    store.apply(policy, 0)
    with store.connection(write=True) as db:
        db.execute("CREATE TRIGGER fail_insert BEFORE INSERT ON attempts BEGIN SELECT RAISE(FAIL, 'synthetic write failure'); END")
    with pytest.raises(sqlite3.IntegrityError):
        admit(store, 'never-dispatched', 2_000_000)
    assert store.budget()['reserved_microusd'] == 2_000_000
    assert store.state()['requests'] == []
    with pytest.raises(Rejected, match='exhausted'):
        admit(store, 'retry', 1)
