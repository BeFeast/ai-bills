import hashlib
import importlib.machinery
import importlib.util
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(Path(__file__).parents[1] / 'collector' / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class ClaudeQuotaTests(unittest.TestCase):
    def test_inactive_session_preserves_weekly_exhaustion(self):
        module = load('ai-quota-projection')
        now = datetime(2026, 1, 10, 12, tzinfo=timezone.utc)
        reset = (now + timedelta(days=1)).isoformat()
        account = {'ok': True, 'fetched_at': now.isoformat(), 'data': {
            'five_hour': {'utilization': 0, 'resets_at': None},
            'seven_day': {'utilization': 100, 'resets_at': reset}}}
        payload = {'claude_usage': {'a' * 24: account}}
        result = module.project(payload, now)['a' * 24]
        self.assertEqual(result['remaining_fraction'], 0)
        self.assertEqual(result['reset_at'], reset)
        self.assertIsNone(module.project(payload, now + timedelta(minutes=11))['a' * 24]['remaining_fraction'])

        # Only the inactive session shape is ignorable. Malformed active usage
        # cannot become an assertion of available capacity.
        for used, invalid_reset in [(1, None), (False, None), (0, 'invalid')]:
            with self.subTest(used=used, reset=invalid_reset):
                account['data']['five_hour'] = {'utilization': used, 'resets_at': invalid_reset}
                self.assertIsNone(module.project(payload, now)['a' * 24]['remaining_fraction'])
        account['data'] = {'five_hour': {'utilization': 0, 'resets_at': None}}
        self.assertIsNone(module.project(payload, now)['a' * 24]['remaining_fraction'])

    def test_canonical_oauth_identity_without_email_ambiguity_or_refresh(self):
        module = load('ai-claude-quotas')
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ('claude-a.json', 'claude-b.json')]
            originals = []
            for path in paths:
                raw = json.dumps({'type': 'claude', 'email': 'shared@example.invalid', 'access_token': 'synthetic-access', 'refresh_token': 'never-use'})
                path.write_text(raw)
                originals.append(raw)
            calls = []
            def request(req, timeout):
                calls.append(req)
                self.assertEqual(req.full_url, 'https://api.anthropic.com/api/oauth/usage')
                self.assertEqual(req.headers['Authorization'], 'Bearer synthetic-access')
                return io.BytesIO(b'{"five_hour":{"utilization":10,"resets_at":"2026-01-10T13:00:00Z"}}')
            result = module.collect(directory, request)
            self.assertNotIn('shared@example.invalid', result)
            self.assertEqual(len(result), 2)
            for path, original in zip(paths, originals):
                identity = hashlib.sha256(('oauth:' + path.name).encode()).hexdigest()[:24]
                self.assertTrue(result[identity]['ok'])
                self.assertEqual(path.read_text(), original)
            self.assertNotIn('synthetic-access', json.dumps(result))
            self.assertNotIn('never-use', json.dumps(result))
            self.assertEqual(len(calls), 2)

    def test_projection_uses_latest_binding_identity_and_most_constrained_reset(self):
        module = load('ai-quota-projection')
        now = datetime(2026, 1, 10, 12, tzinfo=timezone.utc)
        early, late = now + timedelta(hours=1), now + timedelta(days=1)
        payload = {'claude_usage': {'a' * 24: {'ok': True, 'fetched_at': now.isoformat(), 'data': {
            'five_hour': {'utilization': 100, 'resets_at': early.isoformat()},
            'seven_day': {'utilization': 100, 'resets_at': late.isoformat()}}}},
            'codex_usage': {'b' * 24: {'ok': True, 'fetched_at': now.isoformat(), 'data': {'rate_limit': {
                'primary_window': {'used_percent': 20, 'reset_at': early.timestamp()}}}}}}
        result = module.project(payload, now)
        self.assertEqual(result['a' * 24]['remaining_fraction'], 0)
        self.assertEqual(result['a' * 24]['reset_at'], late.isoformat())
        self.assertEqual(result['b' * 24]['remaining_fraction'], .8)
        self.assertIsNone(module.project(payload, now + timedelta(hours=2))['a' * 24]['remaining_fraction'])
        payload['claude_usage']['a' * 24]['fetched_at'] = (now + timedelta(hours=2)).isoformat()
        self.assertIsNone(module.project(payload, now + timedelta(hours=2))['a' * 24]['remaining_fraction'])


class QuotaFallbackTests(unittest.TestCase):
    """A rejected direct check keeps a number on the card instead of forgetting it."""
    NOW = datetime(2026, 9, 21, 8, 35, tzinfo=timezone.utc)

    def auth_dir(self, directory, kind='claude'):
        extra = {'account_id': 'acct'} if kind == 'codex' else {}
        (Path(directory) / f'{kind}-a.json').write_text(json.dumps({'type': kind, 'email': 'a@example.invalid', 'access_token': 'synthetic', **extra}))

    @staticmethod
    def rejecting(codes, body=b'{"five_hour":{"utilization":10,"resets_at":"2026-09-21T13:00:00Z"}}'):
        from urllib.error import HTTPError
        calls = []
        def request(req, timeout):
            calls.append(req)
            code = codes[min(len(calls), len(codes)) - 1]
            if code == 200:
                return io.BytesIO(body)
            raise HTTPError(req.full_url, code, 'rejected', {}, io.BytesIO(b''))
        return request, calls

    def collect(self, module, request, **kwargs):
        slept = []
        with tempfile.TemporaryDirectory() as directory:
            self.auth_dir(directory, 'codex' if module.__name__.endswith('codex_quotas') else 'claude')
            return module.collect(directory, request, sleep=slept.append, now=self.NOW, **kwargs)['a@example.invalid'], slept

    def test_rate_limited_request_is_retried_with_jitter_then_succeeds(self):
        module = load('ai-claude-quotas')
        request, calls = self.rejecting([429, 429, 200])
        entry, slept = self.collect(module, request)
        self.assertEqual((entry['ok'], entry['status'], entry['source'], len(calls)), (True, 200, 'direct', 3))
        self.assertEqual(len(slept), 2)
        self.assertTrue(3 <= slept[0] <= 6 and 8 <= slept[1] <= 14)
        self.assertNotIn('direct', entry)

    def test_unauthorized_is_neither_retried_nor_hidden_behind_a_fallback(self):
        module = load('ai-claude-quotas')
        identity = hashlib.sha256(b'oauth:claude-a.json').hexdigest()[:24]
        previous = {identity: {'ok': True, 'fetched_at': '2026-09-21T08:30:04+00:00', 'data': {'five_hour': {'utilization': 12, 'resets_at': None}}}}
        proxy = {'a@example.invalid': {'observed_at': '2026-09-21T08:34:00Z', 'signals': {'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5', 'Anthropic-Ratelimit-Unified-5h-Reset': '1789997400'}}}
        for code in (401, 403, 404):
            with self.subTest(code=code):
                request, calls = self.rejecting([code])
                entry, slept = self.collect(module, request, previous=previous, proxy_quota=proxy)
                self.assertEqual((entry['ok'], entry['status'], len(calls), slept), (False, code, 1, []))
                self.assertNotIn('data', entry); self.assertNotIn('source', entry)
        # A network failure has no status and is transient: the fallback applies.
        def failing(req, timeout):
            raise OSError('connection reset')
        entry, slept = self.collect(module, failing, previous=previous, proxy_quota=proxy)
        self.assertEqual((entry['ok'], entry['source'], entry['direct']['status'], len(slept)), (True, 'proxy_headers', None, 2))

    def test_proxy_quota_file_matches_the_management_api_shape(self):
        """The wrapper extracts {type, email, quota} from /v0/management/auth-files; both providers must parse a real row."""
        module = load('ai-claude-quotas')
        rows = [{'type': 'claude', 'provider': 'claude', 'email': 'a@example.invalid', 'quota': {'observed_at': '2026-09-21T08:49:46.15436605Z', 'signals': {
                    'Anthropic-Ratelimit-Unified-5h-Reset': '1789997400', 'Anthropic-Ratelimit-Unified-5h-Status': 'allowed', 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.01',
                    'Anthropic-Ratelimit-Unified-7d-Reset': '1790582400', 'Anthropic-Ratelimit-Unified-7d-Status': 'allowed', 'Anthropic-Ratelimit-Unified-7d-Utilization': '0.0',
                    'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '0.0', 'Anthropic-Ratelimit-Unified-Representative-Claim': 'five_hour'}}},
                {'type': 'codex', 'provider': 'codex', 'email': 'a@example.invalid', 'quota': {'observed_at': '2026-09-21T08:51:58.347083579Z', 'signals': {
                    'X-Codex-Active-Limit': 'premium', 'X-Codex-Plan-Type': 'pro', 'X-Codex-Primary-Reset-After-Seconds': '433217', 'X-Codex-Primary-Reset-At': '1790413926',
                    'X-Codex-Primary-Used-Percent': '5', 'X-Codex-Primary-Window-Minutes': '10080', 'X-Codex-Secondary-Used-Percent': '0', 'X-Codex-Secondary-Window-Minutes': '0'}}},
                {'type': 'antigravity', 'provider': 'antigravity', 'email': 'a@example.invalid', 'quota': {'observed_at': '2026-09-21T08:00:00Z', 'signals': {}}}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'quota.json'; path.write_text(json.dumps(rows))
            claude = module.load_proxy_quota(str(path), 'claude')
            self.assertEqual(module.proxy_quota_payload(claude['a@example.invalid']['signals']), {
                'five_hour': {'utilization': 1.0, 'resets_at': '2026-09-21T13:30:00+00:00'}, 'seven_day': {'utilization': 0.0, 'resets_at': '2026-09-28T08:00:00+00:00'}})
            codex_module = load('ai-codex-quotas')
            codex = codex_module.load_proxy_quota(str(path), 'codex')
            self.assertEqual(codex_module.proxy_quota_payload(codex['a@example.invalid']['signals'])['rate_limit']['primary_window']['used_percent'], 5.0)
            self.assertIsNone(module.proxy_quota_payload(module.load_proxy_quota(str(path), 'antigravity')['a@example.invalid']['signals']))

    def test_exhausted_retries_fall_back_to_the_proxy_header_quota(self):
        module = load('ai-claude-quotas')
        request, calls = self.rejecting([429])
        proxy = {'a@example.invalid': {'observed_at': '2026-09-21T08:31:00Z', 'signals': {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.01', 'Anthropic-Ratelimit-Unified-5h-Reset': '1789997400',
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.43', 'Anthropic-Ratelimit-Unified-7d-Reset': '1790582400'}}}
        entry, slept = self.collect(module, request, proxy_quota=proxy)
        self.assertEqual(len(calls), 3)
        self.assertTrue(entry['ok'])
        self.assertIsNone(entry['status'])
        self.assertEqual(entry['source'], 'proxy_headers')
        self.assertEqual(entry['fetched_at'], '2026-09-21T08:31:00+00:00')
        self.assertEqual(entry['data']['five_hour'], {'utilization': 1.0, 'resets_at': datetime.fromtimestamp(1789997400, timezone.utc).isoformat()})
        self.assertEqual(entry['data']['seven_day']['utilization'], 43.0)
        self.assertEqual(entry['direct'], {'status': 429, 'error': 'Proxy quota request rejected (HTTP 429)', 'attempted_at': self.NOW.isoformat()})
        self.assertNotIn('error', entry)

    def test_without_proxy_quota_the_last_successful_observation_is_retained_for_six_hours(self):
        module = load('ai-claude-quotas')
        request, _ = self.rejecting([429])
        identity = hashlib.sha256(b'oauth:claude-a.json').hexdigest()[:24]
        recent = {identity: {'ok': True, 'fetched_at': '2026-09-21T08:30:04+00:00', 'data': {'five_hour': {'utilization': 12, 'resets_at': None}}}}
        entry, _ = self.collect(module, request, previous=recent)
        self.assertEqual((entry['ok'], entry['source'], entry['fetched_at'], entry['data']['five_hour']['utilization'], entry['direct']['status']), (True, 'retained', '2026-09-21T08:30:04+00:00', 12, 429))
        old = {identity: dict(recent[identity], fetched_at='2026-09-21T02:30:00+00:00')}
        entry, _ = self.collect(module, request, previous=old)
        self.assertEqual((entry['ok'], entry['status'], entry['error']), (False, 429, 'Proxy quota request rejected (HTTP 429)'))
        self.assertNotIn('data', entry)
        # A previous failure carries nothing forward.
        entry, _ = self.collect(module, request, previous={identity: {'ok': False, 'fetched_at': '2026-09-21T08:30:04+00:00', 'status': 429}})
        self.assertFalse(entry['ok'])

    def test_the_newer_of_proxy_and_retained_observations_wins(self):
        module = load('ai-claude-quotas')
        request, _ = self.rejecting([429])
        identity = hashlib.sha256(b'oauth:claude-a.json').hexdigest()[:24]
        previous = {identity: {'ok': True, 'fetched_at': '2026-09-21T08:30:04+00:00', 'data': {'five_hour': {'utilization': 12, 'resets_at': None}}}}
        proxy = {'a@example.invalid': {'observed_at': '2026-09-21T07:00:00Z', 'signals': {'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5', 'Anthropic-Ratelimit-Unified-5h-Reset': '1789997400'}}}
        entry, _ = self.collect(module, request, previous=previous, proxy_quota=proxy)
        self.assertEqual((entry['source'], entry['data']['five_hour']['utilization']), ('retained', 12))
        # Proxy signals from the future or without a parseable window are not observations.
        proxy['a@example.invalid']['observed_at'] = '2026-09-21T09:00:00Z'
        entry, _ = self.collect(module, request, previous=previous, proxy_quota=proxy)
        self.assertEqual(entry['source'], 'retained')
        proxy['a@example.invalid'] = {'observed_at': '2026-09-21T08:34:00Z', 'signals': {'Anthropic-Ratelimit-Unified-5h-Utilization': 'n/a'}}
        entry, _ = self.collect(module, request, previous=previous, proxy_quota=proxy)
        self.assertEqual(entry['source'], 'retained')

    def test_header_fallback_keeps_the_per_model_weekly_allowance_with_its_own_observation_time(self):
        module = load('ai-claude-quotas')
        request, _ = self.rejecting([429])
        identity = hashlib.sha256(b'oauth:claude-a.json').hexdigest()[:24]
        fable = {'kind': 'weekly_scoped', 'percent': 85, 'resets_at': '2026-09-26T12:00:00+00:00', 'is_active': True, 'scope': {'model': {'display_name': 'Fable'}}}
        session = {'kind': 'session', 'percent': 10, 'resets_at': '2026-09-21T13:00:00+00:00', 'is_active': False}
        previous = {identity: {'ok': True, 'source': 'direct', 'fetched_at': '2026-09-21T08:30:04+00:00',
                               'data': {'five_hour': {'utilization': 10, 'resets_at': None}, 'limits': [session, fable]}}}
        proxy = {'a@example.invalid': {'observed_at': '2026-09-21T08:34:00Z', 'signals': {
            'Anthropic-Ratelimit-Unified-5h-Utilization': '0.2', 'Anthropic-Ratelimit-Unified-5h-Reset': '1789997400',
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.43', 'Anthropic-Ratelimit-Unified-7d-Reset': '1790582400'}}}
        entry, _ = self.collect(module, request, previous=previous, proxy_quota=proxy)
        # The fresh account-wide windows come from the headers; only the per-model allowance is carried, stamped with when it was seen.
        self.assertEqual((entry['source'], entry['fetched_at'], entry['data']['five_hour']['utilization']), ('proxy_headers', '2026-09-21T08:34:00+00:00', 20.0))
        self.assertEqual(entry['data']['limits'], [dict(fable, observed_at='2026-09-21T08:30:04+00:00')])
        # A second fallback in a row keeps the original observation time instead of re-stamping it as new.
        entry2, _ = self.collect(module, request, previous={identity: entry}, proxy_quota=proxy)
        self.assertEqual(entry2['data']['limits'][0]['observed_at'], '2026-09-21T08:30:04+00:00')
        # Past its reset the allowance no longer exists; past the retention it is no longer evidence.
        reset = {identity: dict(previous[identity], data={'limits': [dict(fable, resets_at='2026-09-21T08:00:00+00:00')]})}
        self.assertNotIn('limits', self.collect(module, request, previous=reset, proxy_quota=proxy)[0]['data'])
        stale = {identity: dict(entry, data=dict(entry['data'], limits=[dict(fable, observed_at='2026-09-21T02:00:00+00:00')]))}
        self.assertNotIn('limits', self.collect(module, request, previous=stale, proxy_quota=proxy)[0]['data'])
        # A retained entry keeps the direct observation's time, so a header fallback after it stamps that time too.
        retained = {identity: {'ok': True, 'source': 'retained', 'fetched_at': '2026-09-21T08:20:00+00:00', 'data': {'limits': [fable]}}}
        self.assertEqual(self.collect(module, request, previous=retained, proxy_quota=proxy)[0]['data']['limits'][0]['observed_at'], '2026-09-21T08:20:00+00:00')
        # Without a usable previous observation nothing is invented.
        self.assertNotIn('limits', self.collect(module, request, previous={identity: {'ok': False, 'fetched_at': '2026-09-21T08:30:04+00:00'}}, proxy_quota=proxy)[0]['data'])

    def test_a_retained_observation_is_passed_through_unchanged(self):
        module = load('ai-claude-quotas')
        request, _ = self.rejecting([429])
        identity = hashlib.sha256(b'oauth:claude-a.json').hexdigest()[:24]
        data = {'five_hour': {'utilization': 12, 'resets_at': None}, 'limits': [{'kind': 'weekly_scoped', 'percent': 50, 'resets_at': '2026-09-26T12:00:00+00:00'}]}
        entry, _ = self.collect(module, request, previous={identity: {'ok': True, 'fetched_at': '2026-09-21T08:30:04+00:00', 'data': data}})
        self.assertEqual((entry['source'], entry['data']), ('retained', data))

    def test_codex_falls_back_to_proxy_headers_in_the_usage_endpoint_shape(self):
        module = load('ai-codex-quotas')
        request, calls = self.rejecting([503])
        proxy = {'a@example.invalid': {'observed_at': '2026-09-21T08:31:00Z', 'signals': {
            'X-Codex-Plan-Type': 'pro', 'X-Codex-Primary-Used-Percent': '13', 'X-Codex-Primary-Reset-At': '1790437611', 'X-Codex-Primary-Reset-After-Seconds': '456910',
            'X-Codex-Primary-Window-Minutes': '10080', 'X-Codex-Secondary-Used-Percent': '0', 'X-Codex-Secondary-Window-Minutes': '0', 'X-Codex-Secondary-Reset-After-Seconds': '0'}}}
        entry, _ = self.collect(module, request, proxy_quota=proxy)
        self.assertEqual(len(calls), 3)
        self.assertEqual((entry['ok'], entry['source'], entry['direct']['status'], entry['data']['plan_type']), (True, 'proxy_headers', 503, 'pro'))
        self.assertEqual(entry['data']['rate_limit']['primary_window'], {'used_percent': 13.0, 'limit_window_seconds': 604800, 'reset_at': 1790437611, 'reset_after_seconds': 456910})
        self.assertNotIn('secondary_window', entry['data']['rate_limit'])
        self.assertTrue(entry['data']['rate_limit']['allowed'])
        self.assertIsNone(module.proxy_quota_payload({'X-Codex-Secondary-Used-Percent': '0'}))

    def test_proxy_quota_file_keeps_only_unambiguous_emails_of_the_provider(self):
        module = load('ai-claude-quotas')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'quota.json'
            path.write_text(json.dumps([
                {'type': 'claude', 'email': 'a@example.invalid', 'quota': {'observed_at': 'x', 'signals': {}}},
                {'type': 'claude', 'email': 'shared@example.invalid', 'quota': {}}, {'type': 'claude', 'email': 'shared@example.invalid', 'quota': {}},
                {'type': 'codex', 'email': 'c@example.invalid', 'quota': {}}, {'type': 'claude', 'email': None, 'quota': {}}]))
            self.assertEqual(list(module.load_proxy_quota(str(path), 'claude')), ['a@example.invalid'])
            self.assertEqual(module.load_proxy_quota(str(path), 'codex'), {'c@example.invalid': {}})
            self.assertEqual(module.load_proxy_quota(str(path / 'missing'), 'claude'), {})
            self.assertEqual(module.load_previous(str(path), 'claude_usage'), {})


if __name__ == '__main__':
    unittest.main()
