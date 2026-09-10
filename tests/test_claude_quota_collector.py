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


if __name__ == '__main__':
    unittest.main()
