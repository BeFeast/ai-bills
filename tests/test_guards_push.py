import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit


def load(name):
    loader = importlib.machinery.SourceFileLoader(name.replace('-', '_'), str(Path(__file__).parents[1] / 'collector' / name))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


guards = load('ai-bills-guards')
GUARDS_URL = 'https://app.example.com/api/guards'
ENV = {'AI_BILLS_GUARDS_URL': GUARDS_URL, 'AI_BILLS_GUARDS_TOKEN': 'synthetic-guards-token',
       'AI_BILLS_KUMA_PUSH_STALE': 'https://kuma.example.com/api/push/stale-token',
       'AI_BILLS_KUMA_PUSH_CONSISTENCY': 'https://kuma.example.com/api/push/consistency-token?status=up&msg=OK&ping=',
       'AI_BILLS_KUMA_PUSH_PROBE': 'https://kuma.example.com/api/push/probe-token',
       'AI_BILLS_KUMA_PUSH_MAPPING': 'https://kuma.example.com/api/push/mapping-token',
       'AI_BILLS_KUMA_PUSH_CREDITS': 'https://kuma.example.com/api/push/credits-token'}
BODY = {'generatedAt': '2026-09-30T12:00:00Z', 'guards': {
    'stale': {'status': 'up', 'message': 'snapshot 3 min old'},
    'consistency': {'status': 'down', 'message': 'claude_usage and proxy_auths disagree for 1 account'},
    'probe': {'status': 'up', 'message': '2 Claude models callable'},
    'mapping': {'status': 'down', 'message': 'claude-personal: quota_snapshot_key is not in the snapshot'},
    'credits': {'status': 'down', 'message': 'codex-personal pays from credits (-8.8k credits/h) while codex-work has 98 % left'}}}


class FakeHttp:
    def __init__(self, guards=BODY, push_error=None):
        self.guards, self.push_error, self.calls = guards, push_error, []

    def __call__(self, request, timeout):
        self.calls.append(request)
        if request.full_url == GUARDS_URL:
            if isinstance(self.guards, Exception):
                raise self.guards
            return io.BytesIO(json.dumps(self.guards).encode())
        if self.push_error:
            raise self.push_error
        return io.BytesIO(b'{"ok":true}')

    def pushes(self):
        result = {}
        for call in self.calls[1:]:
            parts = urlsplit(call.full_url)
            result[parts.path.rsplit('/', 1)[1]] = {k: v for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        return result


class GuardsPushTests(unittest.TestCase):
    def run_guards(self, http, env=ENV):
        logs = []
        return guards.run(dict(env), open_url=http, log=logs.append), logs

    def test_guard_status_maps_to_each_push_monitor(self):
        http = FakeHttp()
        pushed, logs = self.run_guards(http)
        self.assertEqual(pushed, {'stale': 'up', 'consistency': 'down', 'probe': 'up', 'mapping': 'down', 'credits': 'down'})
        self.assertEqual(http.calls[0].headers['Authorization'], 'Bearer synthetic-guards-token')
        pushes = http.pushes()
        self.assertEqual(pushes['stale-token'], {'status': ['up'], 'msg': ['snapshot 3 min old']})
        # A copied Kuma URL already has status/msg/ping: they are replaced, not duplicated.
        self.assertEqual(pushes['consistency-token'], {'status': ['down'], 'msg': ['claude_usage and proxy_auths disagree for 1 account']})
        self.assertEqual(pushes['credits-token'], {'status': ['down'], 'msg': ['codex-personal pays from credits (-8.8k credits/h) while codex-work has 98 % left']})
        self.assertEqual(logs, [])

    def test_unreadable_guards_endpoint_pushes_down_everywhere(self):
        for failure, reason in ((HTTPError(GUARDS_URL, 503, 'unavailable', {}, io.BytesIO(b'')), 'HTTP 503'),
                                (URLError('timed out'), 'URLError'), ({'unexpected': True}, 'unexpected response shape')):
            with self.subTest(reason=reason):
                http = FakeHttp(guards=failure)
                pushed, _ = self.run_guards(http)
                self.assertEqual(pushed, {'stale': 'down', 'consistency': 'down', 'probe': 'down', 'mapping': 'down', 'credits': 'down'})
                for push in http.pushes().values():
                    self.assertEqual(push, {'status': ['down'], 'msg': ['guards endpoint unavailable: ' + reason]})
        http = FakeHttp()
        pushed, _ = self.run_guards(http, dict(ENV, AI_BILLS_GUARDS_URL=''))
        self.assertEqual(pushed, {'stale': 'down', 'consistency': 'down', 'probe': 'down', 'mapping': 'down', 'credits': 'down'})
        self.assertEqual(len(http.calls), 5)

    def test_missing_guard_is_down_and_missing_push_url_is_skipped(self):
        body = {'guards': {'stale': {'status': 'up', 'message': 'ok'}, 'probe': {'status': 'unknown'}}}
        env = dict(ENV, AI_BILLS_KUMA_PUSH_STALE='')
        http = FakeHttp(guards=body)
        pushed, _ = self.run_guards(http, env)
        self.assertEqual(pushed, {'consistency': 'down', 'probe': 'down', 'mapping': 'down', 'credits': 'down'})
        self.assertEqual(http.pushes()['consistency-token']['msg'], ['guard missing'])
        self.assertEqual(http.pushes()['probe-token']['msg'], ['guard status invalid'])
        self.assertNotIn('stale-token', http.pushes())

    def test_message_is_trimmed_and_encoded(self):
        message = 'a & b = c?\n' + 'x' * 400
        http = FakeHttp(guards={'guards': {name: {'status': 'down', 'message': message} for name in ('stale', 'consistency', 'probe', 'mapping', 'credits')}})
        self.run_guards(http)
        msg = http.pushes()['stale-token']['msg'][0]
        self.assertEqual(len(msg), 200)
        self.assertTrue(msg.startswith('a & b = c? xxx'))
        self.assertNotIn(' ', urlsplit(http.calls[1].full_url).query)

    def test_push_failure_is_logged_without_secrets_and_does_not_raise(self):
        http = FakeHttp(push_error=URLError('refused'))
        pushed, logs = self.run_guards(http)
        self.assertEqual(set(pushed.values()), {'push_failed'})
        self.assertEqual(len(logs), 5)
        for line in logs:
            self.assertNotIn('token', line)
            self.assertNotIn('kuma.example.com', line)

    def test_env_file_is_read_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'guards.env'
            path.write_text('# comment\nexport AI_BILLS_GUARDS_URL="https://app.example.com/api/guards"\nAI_BILLS_GUARDS_TOKEN=$(echo pwned)\nAI_BILLS_KUMA_PUSH_PROBE=from-file\n')
            environ = {'AI_BILLS_KUMA_PUSH_PROBE': 'from-env'}
            guards.load_env_file(str(path), environ)
            self.assertEqual(environ, {'AI_BILLS_GUARDS_URL': GUARDS_URL, 'AI_BILLS_GUARDS_TOKEN': '$(echo pwned)', 'AI_BILLS_KUMA_PUSH_PROBE': 'from-env'})


if __name__ == '__main__':
    unittest.main()
