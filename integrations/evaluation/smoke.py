#!/usr/bin/env python3
"""Run a small, repeatable coding/tool/instruction check through managed admission.

Credentials come from environment. The output is an operator-selected private receipt.
This is compatibility evidence, not a general quality benchmark.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

PROMPT = '''Fix this Python function while preserving input order:
def stable_unique(values):
    return list(set(values))
It accepts lists of integers, including zero and negative integers. Return each value
once in order of first appearance. Use the submit_fix tool with runnable Python source
for stable_unique, a short explanation of the bug in cause, and marker ROUTING_OK.
Do not import modules or use filesystem/network access. After the tool reports success,
reply with exactly DONE.'''
TOOL = {'type': 'function', 'function': {'name': 'submit_fix', 'description': 'Submit a code repair for validation', 'parameters': {'type': 'object', 'properties': {'code': {'type': 'string'}, 'cause': {'type': 'string'}, 'marker': {'type': 'string'}}, 'required': ['code', 'cause', 'marker'], 'additionalProperties': False}}}
HARNESS = '''import ast,json,resource,sys
resource.setrlimit(resource.RLIMIT_CPU,(1,1))
resource.setrlimit(resource.RLIMIT_AS,(128*1024*1024,128*1024*1024))
code=json.load(sys.stdin)
tree=ast.parse(code)
for n in ast.walk(tree):
 if isinstance(n,(ast.Import,ast.ImportFrom,ast.Global,ast.Nonlocal,ast.ClassDef)): raise ValueError('unsupported code construct')
 if isinstance(n,ast.Attribute) and n.attr.startswith('_'): raise ValueError('private attribute')
 if isinstance(n,ast.Name) and n.id.startswith('__'): raise ValueError('private name')
namespace={'__builtins__':{'list':list,'set':set,'dict':dict,'len':len,'range':range,'enumerate':enumerate}}
exec(compile(tree,'<repair>','exec'),namespace)
f=namespace['stable_unique']
for data,expected in [([],[]),([0,0],[0]),([3,1,3,0,-2,1],[3,1,0,-2]),([-3,-1,-3,2,0,2],[-3,-1,2,0])]:
 original=data.copy()
 assert f(data)==expected and data==original
print('passed')
'''


def call(base, key, model, messages, session, tools=None):
    body = {'model': model, 'messages': messages, 'max_tokens': 2048, 'stream': False}
    if tools:
        body.update(tools=tools, tool_choice='required')
    req = urllib.request.Request(base.rstrip('/') + '/chat/completions', data=json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
        'X-Session-ID': session, 'X-Request-ID': str(uuid.uuid4()), 'X-Client-Turn-ID': session})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response), time.monotonic()-start, response.status
    except urllib.error.HTTPError as error:
        # Provider bodies can include private endpoint/account metadata.
        return None, time.monotonic()-start, error.code


def evaluate(base, key, model):
    receipt = {'model': model, 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'passed': False}
    session = 'evaluation:' + str(uuid.uuid4())
    messages = [{'role': 'user', 'content': PROMPT}]
    try:
        data, elapsed, status = call(base, key, model, messages, session, [TOOL])
        receipt.update(http_status=status, first_call_seconds=round(elapsed, 3))
        if data is None:
            return receipt
        message = data['choices'][0]['message']
        calls = message.get('tool_calls') or []
        if len(calls) != 1 or calls[0]['function']['name'] != 'submit_fix':
            receipt['failure'] = 'expected tool call missing'
            return receipt
        args = json.loads(calls[0]['function']['arguments'])
        if args.get('marker') != 'ROUTING_OK' or not args.get('cause') or not isinstance(args.get('code'), str):
            receipt['failure'] = 'instruction or explanation missing'
            return receipt
        checked = subprocess.run([sys.executable, '-I', '-c', HARNESS], input=json.dumps(args['code']), text=True, capture_output=True, timeout=3)
        receipt['coding_tests_passed'] = checked.returncode == 0
        if checked.returncode:
            receipt['failure'] = 'code repair failed isolated tests'
            return receipt
        messages += [message, {'role': 'tool', 'tool_call_id': calls[0]['id'], 'content': 'All tests passed. Reply exactly DONE.'}]
        data, elapsed, status = call(base, key, model, messages, session)
        receipt.update(second_call_seconds=round(elapsed, 3), second_http_status=status)
        receipt['passed'] = bool(data and data['choices'][0]['message'].get('content', '').strip() == 'DONE')
        if not receipt['passed']:
            receipt['failure'] = 'tool continuation or exact instruction failed'
    except Exception as error:
        receipt['failure'] = type(error).__name__
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--key-env', default='EVAL_ROUTING_KEY')
    parser.add_argument('--model', action='append', required=True)
    parser.add_argument('--receipt', required=True)
    args = parser.parse_args()
    key = os.environ[args.key_env]
    path = Path(args.receipt)
    for model in args.model:
        result = evaluate(args.base_url, key, model)
        with path.open('a') as file:
            file.write(json.dumps(result) + '\n')
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
