import importlib.machinery
import io
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
def module(name):
    return importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(ROOT / 'collector' / name)).load_module()

class CollectorTests(unittest.TestCase):
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

if __name__ == '__main__': unittest.main()
