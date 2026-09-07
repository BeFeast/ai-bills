import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError

loader = importlib.machinery.SourceFileLoader('codex_quota', str(Path(__file__).parents[1] / 'collector' / 'ai-codex-quotas'))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)

class CodexQuotaTests(unittest.TestCase):
    def test_read_only_credential_use_and_unambiguous_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'codex-fixture.json'
            raw = json.dumps({'type': 'codex', 'access_token': 'synthetic-secret', 'refresh_token': 'never-use', 'account_id': 'synthetic-account', 'email': 'fixture@example.invalid'})
            path.write_text(raw)
            calls = []
            def request(req, timeout):
                calls.append(req)
                self.assertEqual(req.full_url, 'https://chatgpt.com/backend-api/wham/usage')
                self.assertEqual(req.headers['Authorization'], 'Bearer synthetic-secret')
                self.assertEqual(req.headers['Chatgpt-account-id'], 'synthetic-account')
                return io.BytesIO(json.dumps({'rate_limit': {'primary_window': {'used_percent': 25}}}).encode())
            data = module.collect(directory, request)
            self.assertTrue(data['fixture@example.invalid']['ok'])
            self.assertEqual(len(calls), 1)
            self.assertEqual(path.read_text(), raw)
            self.assertNotIn('synthetic-secret', json.dumps(data))
            self.assertNotIn('never-use', json.dumps(data))

    def test_auth_failure_is_recorded_without_refresh_and_duplicate_emails_not_merged(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ('codex-a.json', 'codex-b.json'):
                (Path(directory) / name).write_text(json.dumps({'type': 'codex', 'access_token': 'fixture', 'account_id': name, 'email': 'same@example.invalid'}))
            calls = []
            def request(req, timeout):
                calls.append(req.full_url)
                raise HTTPError(req.full_url, 401, 'private provider error', {}, None)
            data = module.collect(directory, request)
            self.assertNotIn('same@example.invalid', data)
            self.assertEqual(len(data), 2)
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(row['status'] == 401 and not row['ok'] for row in data.values()))
            self.assertNotIn('private provider error', json.dumps(data))

    def test_missing_inventory_and_non_object_credentials_do_not_report_success(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                module.collect(str(Path(directory) / 'missing'))
            (Path(directory) / 'malformed.json').write_text('[]')
            self.assertEqual(module.collect(directory), {})

if __name__ == '__main__':
    unittest.main()
