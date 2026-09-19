import importlib.machinery
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def module(name):
    return importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(ROOT / 'collector' / name)).load_module()

class CollectorTests(unittest.TestCase):
    def test_scheduled_browser_refresh_starts_once_and_waits_with_a_deadline(self):
        refresh = module('ai-browser-refresh')
        now = [0]
        calls = []
        def request(url, timeout):
            calls.append(url)
            return {'refreshing': len(calls) == 1, 'accounts': [{'ok': True}, {'ok': False}]}
        result = refresh.refresh('https://example.test/api/usage', request=request,
                                 clock=lambda: now[0], sleep=lambda value: now.__setitem__(0, now[0] + value))
        self.assertEqual(calls, ['https://example.test/api/usage?refresh=1', 'https://example.test/api/usage'])
        self.assertEqual(result, {'accounts': 2, 'sources_ok': 1, 'sources_failed': 1})
        with self.assertRaises(TimeoutError):
            refresh.refresh('https://example.test/api/usage', request=lambda *_: {'refreshing': True, 'accounts': []},
                            clock=lambda: now[0], sleep=lambda value: now.__setitem__(0, now[0] + value), deadline_seconds=3)

    def test_message_selection_precedes_routing_enrichment(self):
        from unittest.mock import patch
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            row = dict(via='direct', client='fixture', session='session', native_message_id='message',
                       ts='2026-09-10T10:00:00Z', model='claude-fixture', out_total=5)
            (Path(directory) / 'ledger-fixture.jsonl').write_text(json.dumps(row))
            with patch.object(report, 'attribute_routing', side_effect=lambda rows: [dict(value, routing_attribution='joined') for value in rows]):
                result = list(report.rows_for(None))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]['routing_attribution'], 'joined')

    def test_native_extractor_retains_message_identity_and_failure(self):
        from unittest.mock import patch
        extract = module('ai-usage-extract')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.jsonl'
            record = {'type': 'assistant', 'uuid': 'event-one', 'sessionId': 'session-one',
                      'timestamp': '2026-09-10T10:00:00Z', 'isApiErrorMessage': True, 'apiErrorStatus': 429,
                      'message': {'id': 'message-one', 'model': 'claude-fixture',
                                  'usage': {'input_tokens': 1, 'output_tokens': 2}}}
            path.write_text(json.dumps(record))
            with patch.object(extract, 'recent', return_value=[str(path)]):
                rows = list(extract.claude_rows('2026-09-10', 0))
            self.assertEqual(rows[0]['message_id'], 'message-one')
            self.assertEqual(rows[0]['id'], 'event-one')
            self.assertTrue(rows[0]['failed'])
            self.assertEqual(rows[0]['status'], 429)

    def test_native_message_identity_deduplicates_blocks_not_equal_requests(self):
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            common = dict(via='direct', client='fixture', session='session', model='claude-fixture',
                          in_uncached=10, cache_read=20, cache_write=30, out_total=5)
            records = [dict(common, native_message_id='message-one', ts='2026-09-10T10:00:00Z'),
                       dict(common, native_message_id='message-one', ts='2026-09-10T10:00:01Z', out_total=6),
                       dict(common, native_message_id='message-two', ts='2026-09-10T10:00:02Z')]
            path = Path(directory) / 'ledger-fixture.jsonl'
            raw = '\n'.join(map(json.dumps, records)); path.write_text(raw)
            result = list(report.rows_for(None))
            self.assertEqual(len(result), 2)
            self.assertEqual(result[0]['out_total'], 6)
            self.assertEqual(result[1]['out_total'], 5)
            self.assertEqual(path.read_text(), raw)

    def test_unjoinable_native_observations_do_not_inflate_proxy_subtotal(self):
        from unittest.mock import patch
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            common = dict(ts='2026-09-10T10:00:00Z', model='claude-fixture', in_uncached=10,
                          cache_read=20, cache_write=30, out_total=5, billing_mode='included')
            records = [dict(common, via='proxy', account='example', attempt_id='attempt-one', upstream_request_id='request-one'),
                       dict(common, via='proxy', account='example', attempt_id='attempt-two', upstream_request_id='request-two'),
                       dict(common, via='direct', session='example', out_total=7),
                       dict(common, via='direct', upstream_request_id='request-one')]
            (Path(directory) / 'ledger-fixture.jsonl').write_text('\n'.join(map(json.dumps, records)))
            original = report.local_day
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-10' if ts is None else original(ts)):
                result = report.rollup({}, {'claude-fixture': {'in': 1, 'out': 2}})['month']
            self.assertIsNone(result['tokens_total'])
            self.assertIsNone(result['requests'])
            self.assertIsNone(result['api_equivalent_usd'])
            self.assertEqual(result['reconciliation'], {'status': 'partial', 'confirmed_tokens': 130,
                'confirmed_requests': 2, 'unreconciled_native_observations': 1,
                'unreconciled_native_token_observations': 67})
            self.assertEqual(result['by_account'][0]['name'], 'example')
            self.assertEqual(result['by_account'][0]['requests'], 2)

    def test_atomic_receiver_rejects_truncated_data(self):
        receiver = module('ai-snapshot-receive')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot.json'
            path.write_text('{"generated":"old"}')
            with self.assertRaises(ValueError): receiver.receive(path, io.StringIO('{'))
            self.assertEqual(path.read_text(), '{"generated":"old"}')
            receiver.receive(path, io.StringIO('{"generated":"new","accounts":[]}'))
            self.assertEqual(json.loads(path.read_text())['generated'], 'new')

    def test_tap_preserves_full_request_id_and_drops_secrets(self):
        tap = module('ai-usage-tap')
        row = tap.project({'api_key': 'secret-value', 'response_headers': {'request-id': 'full-request'}, 'attempt_id': 'attempt-1', 'managed_request_id': 'gateway-request', 'request_id': 'provider-request', 'role': 'coding-fast'}, {})
        self.assertEqual(row['upstream_request_id'], 'full-request')
        self.assertEqual(row['attempt_id'], 'attempt-1')
        self.assertEqual(row['managed_request_id'], 'gateway-request')
        self.assertEqual(row['request_id'], 'provider-request')
        self.assertNotIn('secret-value', json.dumps(row))

    def test_report_reconciles_native_proxy_and_never_inferrs_account_cost_from_model(self):
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            common = dict(ts='2026-09-07T10:00:00Z', model='model', upstream_request_id='request', in_uncached=100)
            (Path(directory) / 'ledger-2026-09.jsonl').write_text('\n'.join(json.dumps(r) for r in [dict(common, via='direct'), dict(common, via='proxy', account='account')]))
            self.assertEqual(len(list(report.rows_for('2026-09-07'))), 1)
            self.assertIsNone(report.cost(common, {}, {'model': {'in': 1, 'out': 2, 'billing': 'subscription'}})[1])
            self.assertEqual(report.cost(dict(common, billing_mode='included'), {}, {'model': {'in': 1, 'out': 2}})[1], 0)

    def test_missing_ledger_cannot_publish_fresh_zero_spending(self):
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = str(Path(directory) / 'absent')
            with self.assertRaises(FileNotFoundError): report.rollup({}, {})

    def test_context_prices_include_all_prompt_buckets_and_reprice_entire_request(self):
        report = module('ai-usage-report')
        prices = {'tiered': {'in': 4, 'out': 20, 'cache_read_multiplier': .1,
                            'cache_write_multiplier': 1.25,
                            'long_context': {'input_tokens_above': 272000, 'in': 8, 'out': 30}}}
        row = dict(model='tiered', in_uncached=100000, cache_read=171999, cache_write=1,
                   out_total=1000000, billing_mode='included')
        at_boundary = report.cost(row, {}, prices)
        self.assertAlmostEqual(at_boundary[0], .4 + .0687996 + .000005 + 20)
        self.assertEqual(at_boundary[1:], (0, True))
        above = report.cost(dict(row, cache_read=172000), {}, prices)
        self.assertAlmostEqual(above[0], .8 + .1376 + .00001 + 30)
        # Output does not count toward prompt length; cached tokens do.
        self.assertGreater(above[0], at_boundary[0])
        prices['tiered']['long_context'].update(cache_read_multiplier=.2, cache_write_multiplier=2)
        overridden = report.cost(dict(row, cache_read=172000), {}, prices)
        self.assertAlmostEqual(overridden[0], .8 + .2752 + .000016 + 30)

    def test_context_prices_do_not_guess_missing_or_invalid_input_evidence(self):
        report = module('ai-usage-report')
        prices = {'tiered': {'in': 4, 'out': 20,
                            'long_context': {'input_tokens_above': 272000, 'in': 8, 'out': 30}}}
        row = dict(model='tiered', in_uncached=100, cache_read=0, cache_write=0)
        for field in ('in_uncached', 'cache_read', 'cache_write'):
            for invalid in (None, -1, True, '100', 1.5):
                self.assertFalse(report.cost(dict(row, **{field: invalid}), {}, prices)[2])
        del row['cache_write']
        self.assertFalse(report.cost(row, {}, prices)[2])

    def test_json_report_keeps_unknown_api_equivalent_unknown(self):
        from contextlib import redirect_stdout
        from unittest.mock import patch
        report = module('ai-usage-report')
        report.rows_for = lambda _: iter([{'model': 'unpriced', 'client': 'test', 'in_uncached': 100}])
        report.load_pricing = lambda: ({}, {})
        output = io.StringIO()
        with patch('sys.argv', ['ai-usage-report', '--json']), redirect_stdout(output): report.main()
        self.assertIsNone(json.loads(output.getvalue())['groups']['test']['api_equivalent_usd'])


class MonthOverviewTests(unittest.TestCase):
    def test_month_rollup_keeps_earlier_days_local_boundary_and_partial_prices(self):
        from unittest.mock import patch
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            records = [
                dict(ts='2026-08-31T20:59:00Z', model='priced', client='previous-month', in_uncached=900),
                dict(ts='2026-08-31T21:01:00Z', model='priced', client='month-start', in_uncached=100, billing_mode='included'),
                dict(ts='2026-09-05T10:00:00Z', model='priced', client='earlier-day', in_uncached=200, billing_mode='included'),
                dict(ts='2026-09-07T10:00:00Z', model='unknown', client='today', in_uncached=400),
            ]
            (Path(directory) / 'ledger-fixture.jsonl').write_text('\n'.join(json.dumps(row) for row in records))
            original = report.local_day
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-07' if ts is None else original(ts)):
                result = report.rollup({}, {'priced': {'in': 1, 'out': 2}}, days=1)
            self.assertEqual(result['today']['tokens_total'], 400)
            self.assertEqual(result['month']['tokens_total'], 700)
            self.assertEqual(result['month']['requests'], 3)
            self.assertIsNone(result['month']['api_equivalent_usd'])
            self.assertEqual(result['month']['priced_api_equivalent_usd'], .0003)
            self.assertEqual({row['name'] for row in result['month']['by_client']}, {'month-start', 'earlier-day', 'today'})
            self.assertEqual(result['month']['unpriced'], {'unknown': 400})
            self.assertEqual(len((Path(directory) / 'ledger-fixture.jsonl').read_text().splitlines()), 4)

    def test_project_rules_attribute_rows_in_order_and_leave_the_rest_unassigned(self):
        from unittest.mock import patch
        report = module('ai-usage-report')
        rules = report.load_projects.__wrapped__ if hasattr(report.load_projects, '__wrapped__') else None
        with tempfile.TemporaryDirectory() as directory:
            rules_path = Path(directory) / 'projects.json'
            rules_path.write_text(json.dumps({"rules": [
                {"project": "app", "client": "t3"},
                {"project": "app", "client_prefix": "zed-"},
                {"project": "ops", "host": "sindri"},
                {"project": "me", "account": "A@example.invalid", "provider": "claude"},
                {"project": "", "client": "ignored"}, {"nonsense": 1}, "not a rule",
            ]}))
            loaded = report.load_projects(str(rules_path))
            self.assertEqual([r['project'] for r in loaded], ['app', 'app', 'ops', 'me'])
            self.assertEqual(report.load_projects(str(Path(directory) / 'missing.json')), [])
            self.assertEqual(report.project_of({'client': 't3', 'via': 'proxy'}, loaded), 'app')
            self.assertEqual(report.project_of({'client': 'zed-sindri', 'via': 'proxy'}, loaded), 'app')
            self.assertEqual(report.project_of({'client': 'sindri:Codex Desktop', 'via': 'direct'}, loaded), 'ops')
            # A proxy client that merely looks like host:app never matches a host rule.
            self.assertEqual(report.project_of({'client': 'sindri:thing', 'via': 'proxy'}, loaded), 'unassigned')
            self.assertEqual(report.project_of({'client': 'x', 'via': 'proxy', 'account': 'a@example.invalid', 'provider': 'claude'}, loaded), 'me')
            self.assertEqual(report.project_of({'client': 'x', 'via': 'proxy', 'account': 'a@example.invalid', 'provider': 'codex'}, loaded), 'unassigned')
            report.LEDGER_DIR = directory
            records = [
                dict(ts='2026-09-07T01:00:00Z', via='proxy', provider='claude', account='a@example.invalid', client='t3', model='m', in_uncached=100),
                # A Codex native row is placed by the existing reconciliation rule; a Claude native row without its identity would stay unreconciled.
                dict(ts='2026-09-07T02:00:00Z', via='direct', provider=None, account=None, client='sindri:Codex Desktop', model='m', native_kind='codex', in_uncached=10),
                dict(ts='2026-09-07T03:00:00Z', via='proxy', provider='codex', account='b@example.invalid', client='other', model='m', in_uncached=1),
            ]
            (Path(directory) / 'ledger-fixture.jsonl').write_text('\n'.join(json.dumps(row) for row in records))
            original = report.local_day
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-07' if ts is None else original(ts)):
                result = report.rollup({}, {'m': {'in': 1, 'out': 2}}, days=1, projects=loaded)
            by_project = {row['name']: row for row in result['month']['by_project']}
            self.assertEqual({k: v['requests'] for k, v in by_project.items()}, {'app': 1, 'ops': 1, 'unassigned': 1})
            self.assertEqual(by_project['app']['tokens'], 100)
            self.assertEqual(result['month']['attribution'], {'rules': 4, 'assigned_requests': 2, 'unassigned_requests': 1})
            # Without rules nothing is guessed: every row is unassigned and the summary says so.
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-07' if ts is None else original(ts)):
                bare = report.rollup({}, {'m': {'in': 1, 'out': 2}}, days=1, projects=[])
            self.assertEqual([row['name'] for row in bare['month']['by_project']], ['unassigned'])
            self.assertEqual(bare['month']['attribution'], {'rules': 0, 'assigned_requests': 0, 'unassigned_requests': 3})

    def test_rolling_24h_window_counts_rate_limits_and_last_request_per_upstream(self):
        from datetime import datetime, timezone
        from unittest.mock import patch
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            # Report day 2026-09-07 in Asia/Jerusalem starts 2026-09-06T21:00Z; "now" is 05:00Z.
            records = [
                dict(ts='2026-09-06T04:59:00Z', via='proxy', provider='claude', account='a@example.invalid', client='c', model='m', in_uncached=1000),
                dict(ts='2026-09-06T12:00:00.123456789Z', via='proxy', provider='claude', account='a@example.invalid', client='c', model='m', in_uncached=100),
                dict(ts='2026-09-06T20:00:00Z', via='proxy', provider='claude', account='a@example.invalid', client='c', model='m', failed=True, status=429),
                dict(ts='2026-09-06T23:00:00Z', via='proxy', provider='codex', account='a@example.invalid', client='c', model='m', failed=True, status='429'),
                dict(ts='2026-09-07T01:00:00Z', via='proxy', provider='codex', account='a@example.invalid', client='c', model='m', failed=True, status=499),
                dict(ts='2026-09-07T02:00:00Z', via='proxy', provider='openai-compatible-example', account='sk-key', client='c', model='m', in_uncached=10),
            ]
            (Path(directory) / 'ledger-fixture.jsonl').write_text('\n'.join(json.dumps(row) for row in records))
            original = report.local_day
            now = datetime(2026, 9, 7, 5, 0, tzinfo=timezone.utc)
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-07' if ts is None else original(ts)), \
                    patch.object(report, 'utc_now', return_value=now):
                result = report.rollup({}, {'m': {'in': 1, 'out': 2}}, days=1)
            rolling = result['last_24h']
            self.assertEqual(rolling['period'], 'rolling_24h')
            self.assertEqual(rolling['window_hours'], 24)
            self.assertEqual(rolling['period_start'], '2026-09-06T05:00:00+00:00')
            # The 04:59Z row is outside the rolling window even though the calendar month holds it.
            self.assertEqual(rolling['requests'], 5)
            self.assertEqual(rolling['failed'], 3)
            self.assertEqual(rolling['rate_limited'], 2)
            self.assertEqual(result['month']['requests'], 6)
            self.assertEqual(result['today']['requests'], 3)
            by_upstream = {(row['provider'], row['name']): row for row in rolling['by_upstream']}
            self.assertEqual(set(by_upstream), {('claude', 'a@example.invalid'), ('codex', 'a@example.invalid'), ('openai-compatible-example', 'sk-key')})
            self.assertEqual(by_upstream[('claude', 'a@example.invalid')]['rate_limited'], 1)
            self.assertEqual(by_upstream[('claude', 'a@example.invalid')]['last_request_at'], '2026-09-06T20:00:00+00:00')
            self.assertEqual(by_upstream[('codex', 'a@example.invalid')]['failed'], 2)
            self.assertEqual(by_upstream[('codex', 'a@example.invalid')]['rate_limited'], 1)
            self.assertEqual(by_upstream[('codex', 'a@example.invalid')]['last_request_at'], '2026-09-07T01:00:00+00:00')
            # by_account keeps merging one identity across providers.
            account = {row['name']: row for row in rolling['by_account']}['a@example.invalid']
            self.assertEqual((account['requests'], account['rate_limited'], account['last_request_at']), (4, 2, '2026-09-07T01:00:00+00:00'))
            self.assertEqual(result['month']['by_account'][0]['last_request_at'], '2026-09-07T02:00:00+00:00' if result['month']['by_account'][0]['name'] == 'sk-key' else '2026-09-07T01:00:00+00:00')

    def test_native_rows_reconcile_by_fingerprint_or_signed_in_identity(self):
        from datetime import datetime, timezone
        from unittest.mock import patch
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.LEDGER_DIR = directory
            tokens = dict(model='claude-fixture-20260101', in_uncached=10, cache_read=20, cache_write=30, out_total=5)
            records = [
                dict(tokens, ts='2026-09-07T04:00:00Z', via='proxy', provider='claude', account='work@example.invalid', upstream_request_id='proxy-one'),
                # Same model and token tuple four minutes later in a Claude Code log without a request id: the proxy already observed it.
                dict(tokens, model='claude-fixture', ts='2026-09-07T04:04:00Z', via='direct', native_kind='claude', native_message_id='m1', session='s1', account='work@example.invalid', provider='claude'),
                # Different tuple, signed-in identity known: attributed native usage.
                dict(tokens, model='claude-fixture', out_total=9, ts='2026-09-07T04:05:00Z', via='direct', native_kind='claude', native_message_id='m2', session='s1', account='work@example.invalid', provider='claude'),
                # Different tuple, no identity: still unreconciled.
                dict(tokens, model='claude-fixture', out_total=11, ts='2026-09-07T04:06:00Z', via='direct', native_kind='claude', native_message_id='m3', session='s2'),
                # Same tuple as the proxy row but hours later: not the same observation.
                dict(tokens, model='claude-fixture', ts='2026-09-07T01:00:00Z', via='direct', native_kind='claude', native_message_id='m4', session='s3', account='work@example.invalid', provider='claude'),
                # Codex native session with identity.
                dict(tokens, model='gpt-fixture', ts='2026-09-07T04:07:00Z', via='direct', native_kind='codex', session='c1', account='personal@example.invalid', provider='codex'),
                # A second native turn with the proxy row's tuple: the one proxy observation is already consumed, so this is real usage.
                dict(tokens, model='claude-fixture', ts='2026-09-07T04:08:00Z', via='direct', native_kind='claude', native_message_id='m5', session='s1', account='work@example.invalid', provider='claude'),
            ]
            (Path(directory) / 'ledger-fixture.jsonl').write_text('\n'.join(json.dumps(row) for row in records))
            original = report.local_day
            with patch.object(report, 'local_day', side_effect=lambda ts=None: '2026-09-07' if ts is None else original(ts)), \
                    patch.object(report, 'utc_now', return_value=datetime(2026, 9, 7, 5, 0, tzinfo=timezone.utc)):
                rows = list(report.rows_for(None))
                result = report.rollup({}, {'claude-fixture': {'in': 1, 'out': 2}, 'gpt-fixture': {'in': 1, 'out': 2}})['last_24h']
            self.assertEqual([row.get('native_message_id') for row in rows if row.get('via') == 'direct'], ['m2', 'm3', 'm4', None, 'm5'])
            self.assertEqual(result['reconciliation']['unreconciled_native_observations'], 1)
            self.assertEqual(result['reconciliation']['confirmed_requests'], 5)
            by_upstream = {(row['provider'], row['name']): row['requests'] for row in result['by_upstream']}
            self.assertEqual(by_upstream, {('claude', 'work@example.invalid'): 4, ('codex', 'personal@example.invalid'): 1})

    def test_extractor_stamps_signed_in_identity_and_scans_every_codex_home(self):
        import base64
        from unittest.mock import patch
        extract = module('ai-usage-extract')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.claude.json').write_text(json.dumps({'oauthAccount': {'emailAddress': ' Work@Example.invalid '}}))
            with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': directory}):
                self.assertEqual(extract.claude_identity(), 'work@example.invalid')
            with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(root / 'missing')}):
                self.assertIsNone(extract.claude_identity())
            claims = base64.urlsafe_b64encode(json.dumps({'email': 'personal@example.invalid'}).encode()).decode().rstrip('=')
            home = root / 'codex-personal'; (home / 'sessions' / '2026').mkdir(parents=True)
            (home / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'id_token': f'header.{claims}.signature'}}))
            self.assertEqual(extract.codex_identity(str(home)), 'personal@example.invalid')
            (root / 'apikey-home').mkdir(); (root / 'apikey-home' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'sk-secret'}))
            self.assertIsNone(extract.codex_identity(str(root / 'apikey-home')))
            with patch.dict(os.environ, {'CODEX_HOME': str(root / 'default')}):
                self.assertEqual(extract.codex_homes([str(home), str(home)]), [str(root / 'default'), str(home)])
            events = [{'type': 'session_meta', 'timestamp': '2026-09-10T10:00:00Z', 'payload': {'id': 'session-one', 'model_provider': 'openai', 'originator': 'codex-tui'}},
                      {'type': 'turn_context', 'payload': {'model': 'gpt-fixture'}},
                      {'type': 'event_msg', 'timestamp': '2026-09-10T10:01:00Z', 'payload': {'type': 'token_count', 'info': {'last_token_usage': {'input_tokens': 5, 'output_tokens': 1}}}}]
            (home / 'sessions' / '2026' / 'rollout.jsonl').write_text('\n'.join(json.dumps(event) for event in events))
            rows = list(extract.codex_rows('2026-09-10', 0, str(home), extract.codex_identity(str(home))))
            self.assertEqual([(row['id'], row['model'], row['account_email']) for row in rows], [('session-one:1', 'gpt-fixture', 'personal@example.invalid')])
            self.assertEqual(list(extract.codex_rows('2026-09-10', 0, str(root / 'apikey-home'), None)), [])
            claude_log = root / 'claude.jsonl'
            claude_log.write_text(json.dumps({'type': 'assistant', 'uuid': 'u1', 'sessionId': 's', 'timestamp': '2026-09-10T10:00:00Z', 'message': {'id': 'm', 'model': 'claude-fixture', 'usage': {'input_tokens': 1}}}))
            with patch.object(extract, 'recent', return_value=[str(claude_log)]):
                self.assertEqual(list(extract.claude_rows('2026-09-10', 0, 'work@example.invalid'))[0]['account_email'], 'work@example.invalid')

    def test_direct_collector_projects_identity_and_configured_codex_homes(self):
        collect = module('ai-usage-collect-direct')
        self.assertEqual(collect.host_spec('box'), ('box', 'python3 - --since {since}'))
        host, shell = collect.host_spec({'host': 'win', 'shell': 'wsl python3 - --since {since}', 'codex_homes': ['/home/me/.codex-work', "/odd path/.codex"]})
        self.assertEqual((host, shell), ('win', "wsl python3 - --since {since} --codex-home /home/me/.codex-work --codex-home '/odd path/.codex'"))
        row = collect.ledger_row('box', {'kind': 'claude', 'id': 'u1', 'tool': 'claude', 'model': 'claude-fixture', 'ts': '2026-09-10T10:00:00Z', 'in_uncached': 1, 'account_email': 'Work@Example.invalid'})
        self.assertEqual((row['account'], row['provider'], row['client'], row['schema']), ('work@example.invalid', 'claude', 'box:claude', 3))
        pointed = collect.ledger_row('box', {'kind': 'claude', 'id': 'u2', 'tool': 'claude', 'model': 'kimi-k3', 'ts': '2026-09-10T10:00:00Z', 'account_email': 'work@example.invalid'})
        self.assertEqual((pointed['account'], pointed['provider']), ('work@example.invalid', None))
        anonymous = collect.ledger_row('box', {'kind': 'codex', 'id': 's:1', 'tool': 'codex', 'model': 'gpt-fixture', 'ts': '2026-09-10T10:00:00Z'})
        self.assertEqual((anonymous['account'], anonymous['provider'], anonymous['status']), (None, None, 200))
        self.assertEqual(collect.ledger_row('box', {'kind': 'codex', 'id': 's:2', 'tool': 'codex', 'model': 'gpt-fixture', 'ts': '', 'account_email': 'p@example.invalid'})['provider'], 'codex')

    def test_timestamp_parsing_tolerates_nanoseconds_and_naive_values(self):
        report = module('ai-usage-report')
        self.assertEqual(report.parse_ts('2026-09-18T20:18:03.376880978Z').isoformat(), '2026-09-18T20:18:03.376880+00:00')
        self.assertEqual(report.parse_ts('2026-09-18T20:18:03').isoformat(), '2026-09-18T20:18:03+00:00')
        self.assertIsNone(report.parse_ts('not a time'))
        self.assertIsNone(report.parse_ts(None))
        self.assertTrue(report.is_rate_limited({'status': 429}))
        self.assertTrue(report.is_rate_limited({'status': '429'}))
        self.assertFalse(report.is_rate_limited({'status': None, 'failed': True}))
        self.assertFalse(report.is_rate_limited({'status': True}))

    def test_subscription_source_preserves_individual_plans_and_only_allowed_metadata(self):
        inventory = module('ai-subscription-inventory')
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'provider.md').write_text('''---
provider: Fixture AI
billing: subscription
subscriptions:
  - id: work
    plan: Pro
    amount: 120
    currency: EUR
    period: year
    renews_at: 2026-12-03
    account_keys: [work]
    api_key: do-not-publish
---
''')
            result = inventory.collect(directory)
            self.assertEqual(result[0]['subscriptions'][0]['amount'], 120)
            self.assertEqual(str(result[0]['subscriptions'][0]['renews_at']), '2026-12-03')
            self.assertEqual(result[0]['subscriptions'][0]['account_keys'], ['work'])
            self.assertNotIn('do-not-publish', json.dumps(result, default=str))

class TapBatchTests(unittest.TestCase):
    def test_native_queue_batch_count_and_all_records_are_persisted(self):
        from unittest.mock import patch
        from urllib.parse import parse_qs, urlsplit
        tap = module('ai-usage-tap')
        records = [dict(timestamp='2026-09-07T10:00:00Z', attempt_id=f'attempt-{i}', managed_request_id=f'request-{i}') for i in range(3)]
        observed = []
        def response(request, **kwargs):
            observed.append(parse_qs(urlsplit(request.full_url).query))
            return io.StringIO(json.dumps(records))
        tap.MGMT_URL = 'http://fixture.invalid/usage-queue?source=test'
        with patch.object(tap.urllib.request, 'urlopen', side_effect=response):
            result = tap.drain('fixture-token')
        self.assertEqual(observed, [{'source': ['test'], 'count': ['1000']}])
        with tempfile.TemporaryDirectory() as directory:
            tap.LEDGER_DIR = directory
            tap.write(result, {})
            stored = [json.loads(line) for line in (Path(directory) / 'ledger-2026-09.jsonl').read_text().splitlines()]
            self.assertEqual([row['attempt_id'] for row in stored], ['attempt-0', 'attempt-1', 'attempt-2'])
            self.assertEqual([row['managed_request_id'] for row in stored], ['request-0', 'request-1', 'request-2'])

class RoutingAttributionTests(unittest.TestCase):
    def database(self, path):
        import sqlite3
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE attempts(id TEXT PRIMARY KEY, request_id TEXT, client_id TEXT, session_id TEXT, role TEXT, account_id TEXT, billing TEXT, model TEXT, policy_version INTEGER, fallback_reason TEXT)')
        db.executemany('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?)', [
            ('a-t3', 'r-t3', 't3-code', 'session-t3', 'coding-fast', 'included-account', 'included', 'approved-alias', 3, None),
            ('a-api', 'r-api', 'direct-api', 'session-api', 'deep-reasoning', 'paid-account', 'paid', 'approved-alias', 3, 'quota'),
            ('a-retry-1', 'r-retry', 't3-code', 'session-retry', 'coding-fast', 'included-account', 'included', 'approved-alias', 3, None),
            ('a-retry-2', 'r-retry', 't3-code', 'session-retry', 'coding-fast', 'paid-account', 'paid', 'approved-alias', 3, 'quota'),
        ])
        db.commit()
        db.close()

    def test_exact_attempt_join_distinguishes_clients_without_rewriting_ledger(self):
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.ROUTING_DB = str(Path(directory) / 'routing.sqlite')
            report.LEDGER_DIR = directory
            self.database(report.ROUTING_DB)
            records = [dict(ts='2026-09-07T10:00:00Z', client='shared-gateway-key',
                            attempt_id=attempt, managed_request_id=request, via='proxy',
                            model='actual-upstream-model', in_uncached=100, cache_read=0, cache_write=0, out_total=10)
                       for attempt, request in [('a-t3', 'r-t3'), ('a-api', 'r-api')]]
            path = Path(directory) / 'ledger-fixture.jsonl'
            path.write_text('\n'.join(json.dumps(row) for row in records))
            before = path.read_bytes()
            result = list(report.rows_for(None))
            self.assertEqual([r['client'] for r in result], ['t3-code', 'direct-api'])
            self.assertEqual([r['billing_mode'] for r in result], ['included', 'metered'])
            self.assertEqual([r['role'] for r in result], ['coding-fast', 'deep-reasoning'])
            self.assertEqual([r['account'] for r in result], ['included-account', 'paid-account'])
            self.assertEqual([r['model'] for r in result], ['actual-upstream-model'] * 2)
            self.assertEqual(result[1]['fallback_reason'], 'quota')
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(records[0]['client'], 'shared-gateway-key')

    def test_request_only_join_rejects_retries_and_mismatched_identifiers(self):
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            report.ROUTING_DB = str(Path(directory) / 'routing.sqlite')
            self.database(report.ROUTING_DB)
            original = [dict(client='original', managed_request_id='r-t3'),
                        dict(client='original', managed_request_id='r-retry'),
                        dict(client='original', attempt_id='a-t3', managed_request_id='r-api'),
                        dict(client='original', attempt_id='missing', managed_request_id='r-t3')]
            result = report.attribute_routing(original)
            self.assertEqual(result[0]['client'], 't3-code')
            self.assertEqual([r['routing_attribution'] for r in result], ['joined', 'ambiguous', 'id-mismatch', 'unmatched'])
            self.assertEqual([r['client'] for r in result[1:]], ['original'] * 3)

    def test_unavailable_database_preserves_usage_without_creating_database(self):
        from contextlib import redirect_stderr
        report = module('ai-usage-report')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'missing.sqlite'
            report.ROUTING_DB = str(path)
            original = dict(attempt_id='a-t3', client='shared', model='upstream', in_uncached=17)
            with redirect_stderr(io.StringIO()):
                result = report.attribute_routing([original])[0]
            self.assertEqual(result, dict(original, routing_attribution='unavailable'))
            self.assertFalse(path.exists())
            self.assertNotIn('routing_attribution', original)

if __name__ == '__main__': unittest.main()
