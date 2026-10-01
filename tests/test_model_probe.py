import importlib.machinery
import importlib.util
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import unittest
from urllib.error import HTTPError, URLError


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(Path(__file__).parents[1] / 'collector' / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


probe = load('ai-model-probe')
NOW = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
BASE = 'http://proxy.example.com'
KEY = 'synthetic-client-key'
CATALOG = {'data': [{'id': 'claude-fable-5'}, {'id': 'gpt-5'}, {'id': 'claude-opus-5'}, {'id': 'claude-fable-5'}, {'id': 'gemini-3-pro'}]}
UNKNOWN = b'{"error":{"type":"invalid_request_error","message":"unknown provider for model claude-opus-5 (model_not_found)"}}'


class FakeProxy:
    """Answers /v1/models with `catalog` and each model from its queue of (status, body); the last answer repeats."""
    def __init__(self, answers, catalog=CATALOG, catalog_status=200):
        self.answers, self.catalog, self.catalog_status, self.calls = answers, catalog, catalog_status, []

    def __call__(self, request, timeout):
        self.calls.append(request)
        if request.full_url.endswith('/v1/models'):
            assert request.headers['Authorization'] == 'Bearer ' + KEY
            return self.respond(request, self.catalog_status, json.dumps(self.catalog).encode())
        assert request.full_url == BASE + '/v1/messages' and 0 < timeout <= 30
        payload = json.loads(request.data)
        assert payload['max_tokens'] == 1 and payload['messages'] == [{'role': 'user', 'content': 'ping'}]
        assert request.headers['X-api-key'] == KEY and request.headers['Anthropic-version'] == '2023-06-01'
        queue = self.answers.get(payload['model'], [(200, b'{}')])
        status, body = queue.pop(0) if len(queue) > 1 else queue[0]
        return self.respond(request, status, body)

    @staticmethod
    def respond(request, status, body):
        if status is None:
            raise URLError('connection refused')
        if status >= 400:
            raise HTTPError(request.full_url, status, 'error', {}, io.BytesIO(body))
        return io.BytesIO(body)

    def messages(self, model=None):
        return [call for call in self.calls if call.full_url.endswith('/v1/messages') and (model is None or json.loads(call.data)['model'] == model)]


def run(proxy, previous=None, now=NOW):
    slept = []
    return probe.probe(BASE + '/', KEY, previous, open_url=proxy, sleep=slept.append, now=now), slept


class ModelProbeTests(unittest.TestCase):
    def rows(self, result):
        return {row['model']: row for row in result['models']}

    def test_catalog_keeps_only_unique_claude_models(self):
        proxy = FakeProxy({})
        result, slept = run(proxy)
        self.assertEqual([row['model'] for row in result['models']], ['claude-fable-5', 'claude-opus-5'])
        self.assertEqual((result['status'], result['checked_at'], slept), ('up', NOW.isoformat(), []))
        self.assertEqual(self.rows(result)['claude-opus-5'], {'model': 'claude-opus-5', 'outcome': 'ok', 'http_status': 200, 'retried': False, 'message': 'HTTP 200'})
        self.assertEqual(len(proxy.messages()), 2)

    def test_unknown_model_twice_is_an_alert_after_one_retry(self):
        proxy = FakeProxy({'claude-opus-5': [(400, UNKNOWN)]})
        result, slept = run(proxy)
        row = self.rows(result)['claude-opus-5']
        self.assertEqual((result['status'], row['outcome'], row['http_status'], row['retried']), ('down', 'unknown_model', 400, True))
        self.assertEqual((slept, len(proxy.messages('claude-opus-5'))), ([10], 2))
        self.assertIn('claude-opus-5: unknown_model', result['message'])
        self.assertLessEqual(len(row['message']), 200)
        self.assertNotIn(KEY, json.dumps(result))

    def test_a_blip_that_recovers_on_retry_stays_up(self):
        proxy = FakeProxy({'claude-opus-5': [(400, UNKNOWN), (200, b'{}')]})
        result, slept = run(proxy)
        row = self.rows(result)['claude-opus-5']
        self.assertEqual((result['status'], row['outcome'], row['retried'], slept), ('up', 'ok', True, [10]))

    def test_time_budget_reports_the_models_it_could_not_reach(self):
        ticks = iter([0, 0, 149, 149, 149])
        proxy = FakeProxy({})
        result = probe.probe(BASE, KEY, None, open_url=proxy, sleep=lambda _: None, now=NOW, clock=lambda: next(ticks, 149))
        rows = self.rows(result)
        self.assertEqual(rows['claude-fable-5']['outcome'], 'ok')
        self.assertEqual((rows['claude-opus-5']['outcome'], rows['claude-opus-5']['message']), ('skipped', 'probe time budget exhausted before this model'))
        self.assertEqual((result['status'], len(proxy.messages())), ('partial', 1))
        # A partial run is re-checked after ten minutes rather than repeated for the hour.
        later = NOW + timedelta(minutes=10)
        self.assertEqual(probe.probe(BASE, KEY, result, open_url=FakeProxy({}), sleep=lambda _: None, now=later)['status'], 'up')

    def test_rate_limited_model_is_not_an_alert_and_not_retried(self):
        proxy = FakeProxy({'claude-fable-5': [(429, b'{"error":{"type":"rate_limit_error","message":"weekly limit reached"}}')]})
        result, slept = run(proxy)
        row = self.rows(result)['claude-fable-5']
        self.assertEqual((result['status'], row['outcome'], row['http_status'], row['retried'], slept), ('up', 'rate_limited', 429, False, []))
        self.assertEqual(row['message'], 'weekly limit reached')

    def test_classes_of_failure(self):
        for status, body, outcome, down in ((401, b'{"error":"invalid api key ' + KEY.encode() + b'"}', 'unauthorized', True),
                                            (403, b'', 'unauthorized', True), (503, b'upstream', 'server_error', True),
                                            (None, b'', 'unreachable', True), (400, b'{"error":{"message":"max_tokens too small"}}', 'rejected', False),
                                            (404, b'{"error":{"type":"not_found_error","message":"model: claude-opus-5"}}', 'unknown_model', True)):
            with self.subTest(status=status):
                result, _ = run(FakeProxy({'claude-opus-5': [(status, body)]}))
                row = self.rows(result)['claude-opus-5']
                self.assertEqual((row['outcome'], row['http_status'], row['retried'], result['status']), (outcome, status, down, 'down' if down else 'up'))
                self.assertNotIn(KEY, json.dumps(result))

    def test_catalog_failure_is_down_with_no_results(self):
        for proxy, reason in ((FakeProxy({}, catalog_status=None), 'unreachable'), (FakeProxy({}, catalog_status=401), 'HTTP 401'),
                              (FakeProxy({}, catalog_status=502), 'HTTP 502'), (FakeProxy({}, catalog={'data': [{'id': 'gpt-5'}]}), 'no Claude models')):
            with self.subTest(reason=reason):
                result, _ = run(proxy)
                self.assertEqual((result['status'], result['models']), ('down', []))
                self.assertIn(reason, result['message'])
                self.assertEqual(proxy.messages(), [])

    def test_a_catalog_larger_than_a_reply_is_read_whole(self):
        # A live proxy lists hundreds of models (about 30 KB); the Claude ones can sit anywhere in the list.
        big = {'object': 'list', 'data': [{'id': 'vendor/model-%04d' % n, 'object': 'model', 'owned_by': 'x' * 40} for n in range(600)] + [{'id': 'claude-opus-5'}]}
        self.assertGreater(len(json.dumps(big)), 30000)
        result, _ = run(FakeProxy({}, catalog=big))
        self.assertEqual((result['status'], [row['model'] for row in result['models']]), ('up', ['claude-opus-5']))

    def test_catalog_blip_is_retried_once(self):
        proxy = FakeProxy({})
        answers = [None, 200]
        original = proxy.respond
        def respond(request, status, body):
            if request.full_url.endswith('/v1/models'):
                status = answers.pop(0) if answers else 200
            return original(request, status, body)
        proxy.respond = respond
        result, slept = run(proxy)
        self.assertEqual((result['status'], slept), ('up', [10]))

    def test_a_failing_result_is_not_repeated_for_the_hour(self):
        previous = {'checked_at': (NOW - timedelta(minutes=5)).isoformat(), 'status': 'down', 'message': 'x', 'models': []}
        self.assertIs(run(FakeProxy({}), previous=previous)[0], previous)
        result, _ = run(FakeProxy({}), previous=dict(previous, checked_at=(NOW - timedelta(minutes=10)).isoformat()))
        self.assertEqual((result['status'], result['checked_at']), ('up', NOW.isoformat()))

    def test_models_skipped_last_time_go_first(self):
        previous = {'checked_at': (NOW - timedelta(minutes=10)).isoformat(), 'status': 'partial', 'message': 'x',
                    'models': [{'model': 'claude-opus-5', 'outcome': 'skipped'}]}
        proxy = FakeProxy({})
        run(proxy, previous=previous)
        self.assertEqual([json.loads(call.data)['model'] for call in proxy.messages()], ['claude-opus-5', 'claude-fable-5'])

    def test_hourly_gate_carries_the_previous_result(self):
        previous = {'checked_at': (NOW - timedelta(minutes=50)).isoformat(), 'status': 'up', 'message': '2 Claude models callable', 'models': []}
        proxy = FakeProxy({'claude-opus-5': [(400, UNKNOWN)]})
        result, _ = run(proxy, previous)
        self.assertIs(result, previous)
        self.assertEqual(proxy.calls, [])
        # 55 minutes is an hour on a five-minute schedule; anything older (or from the future) runs again.
        for age in (timedelta(minutes=55), timedelta(hours=3), timedelta(minutes=-10)):
            with self.subTest(age=age):
                result, _ = run(FakeProxy({'claude-opus-5': [(400, UNKNOWN)]}), dict(previous, checked_at=(NOW - age).isoformat()))
                self.assertEqual((result['checked_at'], result['status']), (NOW.isoformat(), 'down'))
        self.assertEqual(run(FakeProxy({}), {'status': 'up'})[0]['checked_at'], NOW.isoformat())


if __name__ == '__main__':
    unittest.main()
