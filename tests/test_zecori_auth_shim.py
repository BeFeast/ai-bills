"""zecori-auth-shim: exposes the CLIs' own credentials as one file per account, reporting why an account is absent."""
import base64, importlib.machinery, importlib.util, json, os, stat, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), os.path.join(ROOT, 'collector', name))
    spec = importlib.util.spec_from_loader(loader.name, loader); module = importlib.util.module_from_spec(spec); loader.exec_module(module)
    return module

shim = load('zecori-auth-shim')

def id_token(email):
    payload = base64.urlsafe_b64encode(json.dumps({'email': email}).encode()).decode().rstrip('=')
    return f'h.{payload}.s'

class ClaudeAccount(unittest.TestCase):
    def test_reads_token_and_address_from_claude_code_files(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, '.claude'))
            with open(os.path.join(home, '.claude', '.credentials.json'), 'w') as fh: json.dump({'claudeAiOauth': {'accessToken': 'tok', 'expiresAt': 1}}, fh)
            with open(os.path.join(home, '.claude.json'), 'w') as fh: json.dump({'oauthAccount': {'emailAddress': ' Dev@Example.com '}}, fh)
            self.assertEqual(shim.claude_account(home), {'type': 'claude', 'email': 'dev@example.com', 'access_token': 'tok', 'expires_at': 1, 'source': 'claude-code'})

    def test_reports_why_no_account_was_produced(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertIn('not signed in', shim.claude_account(home)['skipped'])
            os.makedirs(os.path.join(home, '.claude'))
            with open(os.path.join(home, '.claude', '.credentials.json'), 'w') as fh: json.dump({'claudeAiOauth': {'accessToken': ''}}, fh)
            self.assertIn('no claude.ai OAuth token', shim.claude_account(home)['skipped'])
            with open(os.path.join(home, '.claude', '.credentials.json'), 'w') as fh: json.dump({'claudeAiOauth': {'accessToken': 'tok'}}, fh)
            self.assertIn('emailAddress', shim.claude_account(home)['skipped'])

class CodexAccount(unittest.TestCase):
    def test_reads_tokens_and_the_id_token_address(self):
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, 'auth.json'), 'w') as fh: json.dump({'tokens': {'access_token': 'tok', 'account_id': 'acc', 'id_token': id_token('Dev@Example.com')}}, fh)
            self.assertEqual(shim.codex_account(home), {'type': 'codex', 'email': 'dev@example.com', 'access_token': 'tok', 'account_id': 'acc', 'source': 'codex-cli'})

    def test_reports_api_key_sign_ins_and_missing_files(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertIn('not signed in', shim.codex_account(home)['skipped'])
            with open(os.path.join(home, 'auth.json'), 'w') as fh: json.dump({'OPENAI_API_KEY': 'sk-x'}, fh)
            self.assertIn('API-key', shim.codex_account(home)['skipped'])
            with open(os.path.join(home, 'auth.json'), 'w') as fh: json.dump({'tokens': {'access_token': 'tok', 'account_id': 'acc', 'id_token': 'not.a.jwt'}}, fh)
            self.assertIn('email', shim.codex_account(home)['skipped'])

class AuthDir(unittest.TestCase):
    def test_writes_private_files_and_drops_stale_ones(self):
        with tempfile.TemporaryDirectory() as root:
            target = os.path.join(root, 'auths')
            os.makedirs(target); open(os.path.join(target, 'stale.json'), 'w').close()
            names = shim.write_auth_dir(target, [{'type': 'codex', 'email': 'dev@example.com', 'access_token': 't', 'account_id': 'a'}])
            self.assertEqual(names, ['codex-dev@example.com.json'])
            self.assertEqual(sorted(os.listdir(target)), ['codex-dev@example.com.json'])
            self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(target, names[0])).st_mode), 0o600)
            with open(os.path.join(target, names[0])) as fh: self.assertEqual(json.load(fh)['account_id'], 'a')

if __name__ == '__main__':
    unittest.main()
