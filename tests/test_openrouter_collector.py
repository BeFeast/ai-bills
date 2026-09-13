import importlib.machinery, io, json, unittest
from pathlib import Path
from urllib.error import HTTPError
collector = importlib.machinery.SourceFileLoader('openrouter_collector', str(Path(__file__).parents[1] / 'collector/ai-openrouter-balance')).load_module()
class OpenRouterCollector(unittest.TestCase):
    def test_separate_scopes_and_secret_allowlist(self):
        calls=[]
        def request(req,timeout):
            calls.append(req.full_url)
            data={'total_credits':10,'total_usage':.00054272,'secret':'never-output'} if req.full_url.endswith('/credits') else {'usage':0,'limit':None,'label':'private-label','hash':'private-hash'}
            return io.BytesIO(json.dumps({'data':data}).encode())
        value=collector.collect('private-token',request)
        self.assertEqual(len(calls),2);self.assertAlmostEqual(value['credits']['balanceUsd'],9.99945728)
        self.assertEqual(value['key']['usageUsd'],0);self.assertIsNone(value['key']['limitUsd'])
        self.assertNotIn('private',json.dumps(value));self.assertNotIn('never-output',json.dumps(value))
    def test_credits_permission_failure_does_not_hide_key_observation(self):
        def request(req,timeout):
            if req.full_url.endswith('/credits'):raise HTTPError(req.full_url,403,'Forbidden',{},io.BytesIO(b'private error'))
            return io.BytesIO(b'{"data":{"usage":2,"limit":5,"limit_remaining":3}}')
        value=collector.collect('token',request)
        self.assertFalse(value['credits']['ok']);self.assertTrue(value['key']['ok']);self.assertEqual(value['key']['remainingUsd'],3)
    def test_missing_or_invalid_numbers_are_not_zero_balance(self):
        value=collector.collect('token',lambda req,timeout:io.BytesIO(b'{"data":{"total_credits":true,"total_usage":0,"usage":0,"limit":null}}'))
        self.assertFalse(value['credits']['ok']);self.assertNotIn('balanceUsd',value['credits'])
        self.assertFalse(collector.collect('',lambda *a: self.fail('Missing credential must not fetch'))['key']['ok'])
if __name__ == '__main__':unittest.main()
