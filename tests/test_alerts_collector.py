import importlib.machinery, importlib.util, json, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(Path(__file__).parents[1] / 'collector' / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec); loader.exec_module(module); return module


alerts = load('ai-bills-alerts')
NOW = datetime(2026, 9, 19, 0, 5, tzinfo=timezone.utc)
RULES = alerts.DEFAULT_RULES


def claude(session, weekly, fable, active='weekly_scoped', ok=True):
    if not ok:
        return {'ok': False, 'error': 'missing cookie'}
    return {'ok': True, 'fetched_at': '2026-09-19T00:00:00Z', 'data': {'limits': [
        {'kind': 'session', 'percent': session, 'resets_at': '2026-09-19T04:40:00Z', 'is_active': active == 'session'},
        {'kind': 'weekly_all', 'percent': weekly, 'resets_at': '2026-09-24T17:00:00Z', 'is_active': active == 'weekly_all'},
        {'kind': 'weekly_scoped', 'percent': fable, 'resets_at': '2026-09-21T08:00:00Z', 'scope': {'model': {'display_name': 'Fable'}}, 'is_active': active == 'weekly_scoped'}]}}


def codex(used, limit_reached=False):
    return {'ok': True, 'data': {'rate_limit': {'allowed': not limit_reached, 'limit_reached': limit_reached, 'primary_window': {'used_percent': used, 'reset_at': 1789806626}}}}


SNAPSHOT = {
    'generated': '2026-09-19T00:00:38Z',
    'source_receipts': [{'id': 'token-ledger', 'status': 'fresh'}, {'id': 'payments', 'status': 'error'}],
    'claude_usage': {'work@example.invalid': claude(49, 52, 99), 'personal@example.invalid': claude(3, 26, 49), 'deadbeefdeadbeefdeadbeef': claude(1, 1, 1), 'broken@example.invalid': claude(0, 0, 0, ok=False)},
    'codex_usage': {'personal@example.invalid': codex(86), 'work@example.invalid': codex(100, limit_reached=True)},
    'usage_ledger': {'last_24h': {'period': 'rolling_24h', 'by_upstream': [
        {'provider': 'claude', 'name': 'work@example.invalid', 'requests': 974, 'rate_limited': 0},
        {'provider': 'xai', 'name': 'work@example.invalid', 'requests': 4, 'rate_limited': 2},
        {'provider': 'openai-compatible-openrouter', 'name': 'sk-or-v1-0123456789', 'requests': 12, 'rate_limited': 0}]}},
    'subscriptions': [
        {'id': 'sub-soon', 'label': 'Kimi', 'status': 'active', 'renews_at': '2026-09-21', 'amount': 19, 'currency': 'USD'},
        {'id': 'sub-far', 'label': 'OpenCode', 'status': 'active', 'ends_at': '2026-10-04', 'amount': 10},
        {'id': 'sub-past', 'label': 'Suno', 'status': 'active', 'ends_at': '2026-09-08', 'amount': 9},
        {'id': 'sub-cancelled', 'label': 'Moises', 'status': 'cancelled', 'renews_at': '2026-09-20'}],
    'openrouter': {'credits': {'balanceUsd': 3.5}},
}


class EvaluateTests(unittest.TestCase):
    def conditions(self, snapshot=SNAPSHOT, now=NOW):
        return {c['key']: c for c in alerts.evaluate(snapshot, RULES, now)}

    def test_quota_follows_the_active_window_with_shared_thresholds(self):
        c = self.conditions()
        self.assertEqual((c['quota:claude:work@example.invalid']['state'], c['quota:claude:work@example.invalid']['value']), ('bad', 1))
        self.assertIn('Fable weekly', c['quota:claude:work@example.invalid']['title'])
        self.assertEqual(c['quota:claude:personal@example.invalid']['state'], 'ok')
        self.assertEqual((c['quota:codex:personal@example.invalid']['state'], c['quota:codex:personal@example.invalid']['severity']), ('warn', 'P4'))
        self.assertEqual((c['quota:codex:work@example.invalid']['state'], c['quota:codex:work@example.invalid']['severity']), ('bad', 'P5'))
        self.assertIn('limit reached', c['quota:codex:work@example.invalid']['title'])
        self.assertNotIn('quota:claude:deadbeefdeadbeefdeadbeef', c)

    def test_failed_sources_and_stale_snapshot_are_alerts_not_silence(self):
        c = self.conditions()
        self.assertEqual((c['source:claude:broken@example.invalid']['state'], c['source:claude:broken@example.invalid']['severity']), ('bad', 'P5'))
        self.assertEqual(c['source:payments']['state'], 'bad')
        self.assertEqual(c['source:token-ledger']['state'], 'ok')
        self.assertEqual(c['source:snapshot']['state'], 'ok')
        stale = self.conditions(now=datetime(2026, 9, 19, 0, 30, tzinfo=timezone.utc))
        self.assertEqual(stale['source:snapshot']['state'], 'bad')
        self.assertEqual(self.conditions(snapshot={})['source:snapshot']['state'], 'bad')

    def test_rate_limits_renewals_and_balance(self):
        c = self.conditions()
        self.assertEqual(c['ratelimit:xai:work@example.invalid']['state'], 'warn')
        self.assertEqual(c['ratelimit:claude:work@example.invalid']['state'], 'ok')
        self.assertIn('sk-or-v1…', c['ratelimit:openai-compatible-openrouter:sk-or-v1-0123456789']['title'])
        self.assertEqual((c['renewal:sub-soon:renews_at']['state'], c['renewal:sub-soon:renews_at']['value']), ('warn', 2))
        self.assertEqual(c['renewal:sub-far:ends_at']['state'], 'ok')
        self.assertEqual(c['renewal:sub-past:ends_at']['state'], 'ok')
        self.assertNotIn('renewal:sub-cancelled:renews_at', c)
        self.assertEqual((c['balance:openrouter']['state'], c['balance:openrouter']['value']), ('warn', 3.5))


class EdgeTests(unittest.TestCase):
    def test_notify_once_on_raise_escalation_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            first = alerts.apply_edges(alerts.evaluate(SNAPSHOT, RULES, NOW), directory, NOW)
            self.assertEqual({e['key']: e['kind'] for e in first if e['key'].startswith('quota:')},
                             {'quota:claude:work@example.invalid': 'raised', 'quota:codex:personal@example.invalid': 'raised', 'quota:codex:work@example.invalid': 'raised'})
            second = alerts.apply_edges(alerts.evaluate(SNAPSHOT, RULES, NOW), directory, NOW)
            self.assertEqual(second, [])
            escalated = json.loads(json.dumps(SNAPSHOT)); escalated['codex_usage']['personal@example.invalid'] = codex(95)
            third = alerts.apply_edges(alerts.evaluate(escalated, RULES, NOW), directory, NOW)
            self.assertEqual([(e['key'], e['kind']) for e in third], [('quota:codex:personal@example.invalid', 'escalated')])
            recovered = json.loads(json.dumps(SNAPSHOT)); recovered['codex_usage']['personal@example.invalid'] = codex(10)
            conditions = alerts.evaluate(recovered, RULES, NOW)
            fourth = alerts.apply_edges(conditions, directory, NOW)
            self.assertEqual([(e['key'], e['kind'], e['state']) for e in fourth], [('quota:codex:personal@example.invalid', 'recovered', 'ok')])
            report = alerts.write_outputs(directory, conditions, fourth, NOW)
            self.assertEqual(report['events'][-1]['kind'], 'recovered')
            self.assertTrue((Path(directory) / 'alerts.json').exists())
            self.assertEqual(len((Path(directory) / 'alerts-2026-09.jsonl').read_text().splitlines()), 1)
            self.assertTrue(all('since' in c for c in report['conditions']))

    def test_main_dry_run_never_touches_state_or_notifies(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(alerts, 'notify') as notify, patch.object(alerts, 'utc_now', return_value=NOW):
            snapshot = Path(directory) / 'snapshot.json'; snapshot.write_text(json.dumps(SNAPSHOT))
            with patch.dict('os.environ', {'AI_BILLS_SNAPSHOT': str(snapshot), 'AI_BILLS_ALERTS_STATE': directory, 'AI_BILLS_ALERTS_CONFIG': str(Path(directory) / 'missing.yml')}), patch('sys.argv', ['ai-bills-alerts', '--dry-run']):
                self.assertEqual(alerts.main(), 0)
            self.assertEqual(list(Path(directory).glob('*.state')), []); notify.assert_not_called()
            with patch.dict('os.environ', {'AI_BILLS_SNAPSHOT': str(snapshot), 'AI_BILLS_ALERTS_STATE': directory, 'AI_BILLS_ALERTS_CONFIG': str(Path(directory) / 'missing.yml')}), patch('sys.argv', ['ai-bills-alerts', '--summary']):
                self.assertEqual(alerts.main(), 0)
            titles = [call.args[2] for call in notify.call_args_list]
            self.assertIn('Zecori daily', titles)
            self.assertTrue(any('limit reached' in t for t in titles))
            self.assertEqual(notify.call_args_list[0].args[0], [])  # no topics configured -> nothing delivered, state still recorded

    def test_config_merges_defaults_and_keeps_only_http_topics(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = Path(directory) / 'alerts.yml'
            cfg.write_text('snapshot: /tmp/s.json\nntfy:\n  topics: ["https://ntfy.example/ai-billing", "not-a-url"]\nrules:\n  quota: {warn_percent_left: 30}\n')
            loaded = alerts.load_config(str(cfg))
            self.assertEqual(loaded['topics'], ['https://ntfy.example/ai-billing'])
            self.assertEqual(loaded['rules']['quota'], {'warn_percent_left': 30, 'bad_percent_left': 10})
            self.assertEqual(loaded['rules']['renewal']['days'], 3)


if __name__ == '__main__':
    unittest.main()
