import importlib.machinery, importlib.util, json, tempfile, unittest
from datetime import datetime, timedelta, timezone
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
        {'id': 'sub-cancelled', 'label': 'Moises', 'status': 'cancelled', 'renews_at': '2026-09-20'},
        {'id': 'sub-both', 'label': 'Trial', 'status': 'active', 'renews_at': '2026-12-01', 'ends_at': '2026-09-20'}],
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

    def test_scoped_window_with_null_model_does_not_abort_the_run(self):
        snapshot = json.loads(json.dumps(SNAPSHOT))
        snapshot['claude_usage']['work@example.invalid']['data']['limits'][2]['scope'] = {'model': None, 'surface': None}
        c = self.conditions(snapshot)
        self.assertIn('Scoped weekly', c['quota:claude:work@example.invalid']['title'])
        self.assertEqual(alerts.window_label({'kind': 'weekly_scoped', 'scope': 'Fable'}), 'Fable weekly')

    def test_failed_sources_and_stale_snapshot_are_alerts_not_silence(self):
        c = self.conditions()
        self.assertEqual((c['source:claude:broken@example.invalid']['state'], c['source:claude:broken@example.invalid']['severity']), ('bad', 'P5'))
        self.assertEqual(c['source:payments']['state'], 'bad')
        self.assertEqual(c['source:token-ledger']['state'], 'ok')
        self.assertEqual(c['source:snapshot']['state'], 'ok')
        stale = self.conditions(now=datetime(2026, 9, 19, 0, 30, tzinfo=timezone.utc))
        self.assertEqual(stale['source:snapshot']['state'], 'bad')
        self.assertEqual(self.conditions(snapshot={})['source:snapshot']['state'], 'bad')

    def test_fallback_observations_degrade_the_source_but_keep_the_quota_condition(self):
        degraded = dict(SNAPSHOT, claude_usage=dict(SNAPSHOT['claude_usage']))
        degraded['claude_usage']['work@example.invalid'] = dict(claude(49, 52, 99), source='proxy_headers', status=None,
                                                                 direct={'status': 429, 'error': 'Proxy quota request rejected (HTTP 429)', 'attempted_at': '2026-09-19T00:05:00Z'})
        c = self.conditions(snapshot=degraded)
        source = c['source:claude:work@example.invalid']
        self.assertEqual((source['state'], source['severity']), ('warn', 'P5'))
        self.assertIn('HTTP 429', source['message']); self.assertIn("proxy observed", source['message'])
        self.assertEqual(c['quota:claude:work@example.invalid']['state'], self.conditions()['quota:claude:work@example.invalid']['state'])
        degraded['claude_usage']['work@example.invalid']['source'] = 'retained'
        self.assertIn('last successful observation', self.conditions(snapshot=degraded)['source:claude:work@example.invalid']['message'])

    def test_rate_limits_renewals_and_balance(self):
        c = self.conditions()
        self.assertEqual(c['ratelimit:xai:work@example.invalid']['state'], 'warn')
        self.assertEqual(c['ratelimit:claude:work@example.invalid']['state'], 'ok')
        keyed = [k for k in c if k.startswith('ratelimit:openai-compatible-openrouter:')]
        self.assertEqual(len(keyed), 1); self.assertNotIn('0123456789', keyed[0]); self.assertTrue(keyed[0].endswith(alerts.upstream_label('sk-or-v1-0123456789')))
        self.assertNotIn('0123456789', json.dumps(list(c.values())))
        self.assertEqual((c['renewal:sub-soon:renews_at']['state'], c['renewal:sub-soon:renews_at']['value']), ('warn', 2))
        self.assertEqual(c['renewal:sub-far:ends_at']['state'], 'ok')
        self.assertEqual(c['renewal:sub-past:ends_at']['state'], 'ok')
        self.assertNotIn('renewal:sub-cancelled:renews_at', c)
        self.assertEqual((c['renewal:sub-both:renews_at']['state'], c['renewal:sub-both:ends_at']['state']), ('ok', 'warn'))
        self.assertEqual((c['balance:openrouter']['state'], c['balance:openrouter']['value']), ('warn', 3.5))


class EdgeTests(unittest.TestCase):
    def test_notify_once_on_raise_escalation_and_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            first_conditions = alerts.evaluate(SNAPSHOT, RULES, NOW)
            first = alerts.apply_edges(first_conditions, directory, NOW)
            raised_since = {c['key']: c['since'] for c in first_conditions if c['key'] == 'quota:codex:personal@example.invalid'}
            self.assertEqual({e['key']: e['kind'] for e in first if e['key'].startswith('quota:')},
                             {'quota:claude:work@example.invalid': 'raised', 'quota:codex:personal@example.invalid': 'raised', 'quota:codex:work@example.invalid': 'raised'})
            second = alerts.apply_edges(alerts.evaluate(SNAPSHOT, RULES, NOW), directory, NOW)
            self.assertEqual(second, [])
            escalated = json.loads(json.dumps(SNAPSHOT)); escalated['codex_usage']['personal@example.invalid'] = codex(95)
            third = alerts.apply_edges(alerts.evaluate(escalated, RULES, NOW), directory, NOW)
            self.assertEqual([(e['key'], e['kind']) for e in third], [('quota:codex:personal@example.invalid', 'escalated')])
            exhausted = json.loads(json.dumps(escalated)); exhausted['codex_usage']['personal@example.invalid'] = codex(100, limit_reached=True)
            self.assertEqual([(e['key'], e['kind'], e['severity']) for e in alerts.apply_edges(alerts.evaluate(exhausted, RULES, NOW), directory, NOW)], [('quota:codex:personal@example.invalid', 'escalated', 'P5')])
            self.assertEqual(alerts.apply_edges(alerts.evaluate(exhausted, RULES, NOW), directory, NOW), [])
            eased = json.loads(json.dumps(SNAPSHOT)); eased['codex_usage']['personal@example.invalid'] = codex(80)
            later = NOW + timedelta(minutes=10); eased_conditions = alerts.evaluate(eased, RULES, later)
            self.assertEqual([(e['key'], e['kind'], e['state']) for e in alerts.apply_edges(eased_conditions, directory, later)], [('quota:codex:personal@example.invalid', 'eased', 'warn')])
            self.assertEqual(next(c['since'] for c in eased_conditions if c['key'] == 'quota:codex:personal@example.invalid'), raised_since['quota:codex:personal@example.invalid'])
            recovered = json.loads(json.dumps(SNAPSHOT)); recovered['codex_usage']['personal@example.invalid'] = codex(10)
            conditions = alerts.evaluate(recovered, RULES, NOW)
            fourth = alerts.apply_edges(conditions, directory, NOW)
            self.assertEqual([(e['key'], e['kind'], e['state']) for e in fourth], [('quota:codex:personal@example.invalid', 'recovered', 'ok')])
            report = alerts.write_outputs(directory, conditions, fourth, NOW)
            self.assertEqual(report['events'][-1]['kind'], 'recovered')
            self.assertTrue((Path(directory) / 'alerts.json').exists())
            self.assertEqual(len((Path(directory) / 'alerts-2026-09.jsonl').read_text().splitlines()), 1)
            self.assertTrue(all('since' in c for c in report['conditions']))
            self.assertIsNone(next(c['since'] for c in conditions if c['key'] == 'quota:codex:personal@example.invalid'))

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

    def test_notifications_carry_unicode_titles_through_json_publish(self):
        request = alerts.ntfy_request('https://ntfy.example.invalid/ai-billing', 'urgent', 'Claude · work@example.invalid — recovered', 'Fable weekly 10% used', 'white_check_mark')
        self.assertEqual(request.full_url, 'https://ntfy.example.invalid/')
        body = json.loads(request.data.decode('utf-8'))
        self.assertEqual((body['topic'], body['priority'], body['tags']), ('ai-billing', 5, ['white_check_mark']))
        self.assertEqual(body['title'], 'Claude · work@example.invalid — recovered')
        self.assertTrue(all(ord(ch) < 128 for ch in ''.join(f'{k}{v}' for k, v in request.header_items())))
        sent = []
        with patch.object(alerts.urllib.request, 'urlopen', side_effect=lambda req, timeout=10: sent.append(req) or type('R', (), {'read': lambda self: b''})()):
            alerts.notify(['https://ntfy.example.invalid/ai-billing', 'https://ntfy.sh/oklabs-x'], 'high', 'Ünïcode — title', 'msg')
        self.assertEqual([json.loads(r.data)['topic'] for r in sent], ['ai-billing', 'oklabs-x'])
        with self.assertRaises(ValueError):
            alerts.ntfy_request('https://ntfy.example.invalid/', 'high', 't', 'm', 'x')

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
